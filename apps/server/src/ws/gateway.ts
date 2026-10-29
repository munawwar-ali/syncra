/**
 * WebSocket gateway: upgrade + auth, per-connection ordered message handling, heartbeats and
 * graceful shutdown (Doc 02 §4.1-4.2, Doc 03 §5).
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { WebSocket, WebSocketServer } from 'ws';
import {
  CLOSE_CODES,
  ProtocolError,
  decodeMessage,
  encodeMessage,
  type Message,
} from '@syncra/protocol';
import { COLLECTION_REGEX, DOC_ID_REGEX, LIMITS, SyncraError } from '@syncra/shared';
import { resolveAccess } from '../auth/access.js';
import type { ClientClaims, TokenVerifier } from '../auth/jwt.js';
import type { DocService, HotDoc, Subscriber } from '../core/doc-service.js';

export interface GatewayOptions {
  svc: DocService;
  verify: TokenVerifier;
  logger: Logger;
  maxMessageBytes: number;
  idleTimeoutMs?: number;
  pingIntervalMs?: number;
}

const MAX_IN_FLIGHT = 256;
const CLIENT_ID_REGEX = /^[A-Za-z0-9_.:-]{1,128}$/;

interface Sub {
  hot: HotDoc;
  mode: 'r' | 'rw';
}

class Connection implements Subscriber {
  readonly id = randomUUID();
  readonly subs = new Map<string, Sub>();
  lastSeen = Date.now();
  inFlight = 0;
  chain: Promise<void> = Promise.resolve();
  step2Counter = 0;

  constructor(
    readonly ws: WebSocket,
    readonly claims: ClientClaims,
    readonly clientId: string,
  ) {}

  send(frame: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
  }
}

export class Gateway {
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<Connection>();
  private readonly byClient = new Map<string, Connection>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly o: GatewayOptions) {
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: o.maxMessageBytes,
      handleProtocols: () => 'syncra.v1',
    });
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/v1/connect') {
        socket.destroy();
        return;
      }
      void this.authenticate(req, url)
        .then(({ claims, clientId }) => {
          this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.onConnection(ws, claims, clientId);
          });
        })
        .catch((e: unknown) => {
          const status = e instanceof SyncraError && e.code === 'VALIDATION_FAILED' ? 400 : 401;
          reject(socket, status);
        });
    });
    const every = this.o.pingIntervalMs ?? 30_000;
    this.timer = setInterval(() => {
      const idle = this.o.idleTimeoutMs ?? 60_000;
      for (const c of this.conns) {
        if (Date.now() - c.lastSeen > idle) c.ws.terminate();
        else c.ws.ping();
      }
    }, every);
    this.timer.unref();
  }

  private async authenticate(
    req: IncomingMessage,
    url: URL,
  ): Promise<{ claims: ClientClaims; clientId: string }> {
    const protocols = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
    const fromProtocol = protocols.find((p) => p.startsWith('syncra.token.'))?.slice(13);
    const token = url.searchParams.get('token') ?? fromProtocol;
    const clientId = url.searchParams.get('clientId') ?? '';
    if (!CLIENT_ID_REGEX.test(clientId)) throw new SyncraError('VALIDATION_FAILED', 'Bad clientId');
    if (!token) throw new SyncraError('UNAUTHENTICATED', 'Missing token');
    return { claims: await this.o.verify(token), clientId };
  }

  private onConnection(ws: WebSocket, claims: ClientClaims, clientId: string): void {
    const conn = new Connection(ws, claims, clientId);
    const slot = `${claims.tenantId}\u0000${clientId}`;
    this.byClient.get(slot)?.ws.close(CLOSE_CODES.NORMAL, 'replaced');
    this.byClient.set(slot, conn);
    this.conns.add(conn);

    ws.on('pong', () => {
      conn.lastSeen = Date.now();
    });
    ws.on('message', (data: Buffer, isBinary) => {
      conn.lastSeen = Date.now();
      if (!isBinary) {
        ws.close(1003, 'binary only');
        return;
      }
      const frame = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      conn.chain = conn.chain.then(() => this.handleFrame(conn, frame));
    });
    ws.on('close', () => {
      this.conns.delete(conn);
      if (this.byClient.get(slot) === conn) this.byClient.delete(slot);
      for (const s of conn.subs.values()) this.o.svc.unsubscribe(s.hot, conn);
      conn.subs.clear();
    });
    ws.on('error', (e) => {
      this.o.logger.debug({ err: e, connId: conn.id }, 'ws error');
    });
  }

  private async handleFrame(conn: Connection, frame: Uint8Array): Promise<void> {
    let msg: Message;
    try {
      msg = decodeMessage(frame);
    } catch (e) {
      this.sendError(conn, '', new SyncraError('VALIDATION_FAILED', (e as ProtocolError).message));
      return;
    }
    try {
      await this.handle(conn, msg);
    } catch (e) {
      this.sendError(conn, msg.docKey, e);
    }
  }

  private async handle(conn: Connection, msg: Message): Promise<void> {
    const { svc } = this.o;
    switch (msg.type) {
      case 'PING':
        conn.send(encodeMessage({ type: 'PONG', docKey: '', timestampMs: msg.timestampMs }));
        return;
      case 'PONG':
        return;
      case 'SUBSCRIBE': {
        const [collection, docId] = parseDocKey(msg.docKey);
        const granted = resolveAccess(conn.claims.access, collection, docId);
        if (!granted) throw new SyncraError('FORBIDDEN', 'No access to this document');
        const mode = granted === 'rw' && (msg.flags & 1) === 0 ? 'rw' : 'r';
        let sub = conn.subs.get(msg.docKey);
        if (!sub) {
          if (conn.subs.size >= LIMITS.maxSubscriptionsPerConnection) {
            throw new SyncraError('VALIDATION_FAILED', 'Too many subscriptions');
          }
          const hot = await svc.open(conn.claims.tenantId, collection, docId, mode === 'rw');
          sub = { hot, mode };
          conn.subs.set(msg.docKey, sub);
          svc.subscribe(hot, conn);
        }
        conn.send(
          encodeMessage({
            type: 'SUBSCRIBED',
            docKey: msg.docKey,
            headSeq: sub.hot.headSeq,
            access: sub.mode === 'rw' ? 1 : 0,
          }),
        );
        return;
      }
      case 'UNSUBSCRIBE': {
        const sub = conn.subs.get(msg.docKey);
        if (sub) svc.unsubscribe(sub.hot, conn);
        conn.subs.delete(msg.docKey);
        return;
      }
      case 'SYNC_STEP1': {
        const { hot } = this.sub(conn, msg.docKey);
        const r = svc.syncStep(hot, msg.stateVector);
        conn.send(
          encodeMessage({
            type: 'SYNC_STEP2',
            docKey: msg.docKey,
            update: r.update,
            seq: hot.headSeq,
          }),
        );
        conn.send(
          encodeMessage({ type: 'SYNC_STEP1', docKey: msg.docKey, stateVector: r.stateVector }),
        );
        return;
      }
      case 'SYNC_STEP2':
        this.write(conn, msg.docKey, `step2:${conn.id}:${String(++conn.step2Counter)}`, msg.update);
        return;
      case 'UPDATE':
        this.write(conn, msg.docKey, msg.opId, msg.update);
        return;
      case 'AWARENESS': {
        const { hot } = this.sub(conn, msg.docKey);
        if (msg.update.length > LIMITS.maxAwarenessBytes) {
          throw new SyncraError('PAYLOAD_TOO_LARGE', 'Awareness state too large');
        }
        const frame = encodeMessage(msg);
        for (const s of hot.subs) if (s !== conn) s.send(frame);
        return;
      }
      default:
        throw new SyncraError('VALIDATION_FAILED', `Unexpected message ${msg.type}`);
    }
  }

  private sub(conn: Connection, docKey: string): Sub {
    const s = conn.subs.get(docKey);
    if (!s) throw new SyncraError('VALIDATION_FAILED', 'Not subscribed to document');
    return s;
  }

  /** Starts a write without blocking the connection's message queue; ACK/ERROR follow on commit. */
  private write(conn: Connection, docKey: string, opId: string, update: Uint8Array): void {
    const s = this.sub(conn, docKey);
    if (s.mode !== 'rw') throw new SyncraError('FORBIDDEN', 'Read-only access');
    conn.inFlight++;
    if (conn.inFlight >= MAX_IN_FLIGHT) conn.ws.pause();
    void this.o.svc
      .write(s.hot, conn.clientId, opId, update)
      .then((seq) => {
        conn.send(encodeMessage({ type: 'ACK', docKey, opId, seq }));
      })
      .catch((e: unknown) => {
        this.sendError(conn, docKey, e);
      })
      .finally(() => {
        if (conn.inFlight-- === MAX_IN_FLIGHT) conn.ws.resume();
      });
  }

  private sendError(conn: Connection, docKey: string, e: unknown): void {
    const err = SyncraError.from(e);
    if (err.code === 'INTERNAL')
      this.o.logger.error({ err: e, connId: conn.id }, 'ws handler failed');
    conn.send(
      encodeMessage({
        type: 'ERROR',
        docKey,
        code: err.code,
        message: err.message,
        retryAfterMs: 0,
      }),
    );
  }

  /** Graceful shutdown: close sockets with 1001, then flush buffered writes. */
  async close(): Promise<void> {
    clearInterval(this.timer);
    for (const c of this.conns) c.ws.close(CLOSE_CODES.GOING_AWAY, 'server going away');
    await this.o.svc.drain();
    this.wss.close();
  }
}

function parseDocKey(docKey: string): [string, string] {
  const i = docKey.indexOf('/');
  const collection = docKey.slice(0, i);
  const docId = docKey.slice(i + 1);
  if (i < 0 || !COLLECTION_REGEX.test(collection) || !DOC_ID_REGEX.test(docId)) {
    throw new SyncraError('VALIDATION_FAILED', 'Invalid docKey');
  }
  return [collection, docId];
}

function reject(socket: Duplex, status: number): void {
  socket.write(
    `HTTP/1.1 ${String(status)} ${status === 400 ? 'Bad Request' : 'Unauthorized'}\r\nConnection: close\r\n\r\n`,
  );
  socket.destroy();
}
