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
import {
  COLLECTION_REGEX,
  DOC_ID_REGEX,
  INDEX_COLLECTION,
  LIMITS,
  SyncraError,
} from '@syncra/shared';
import { resolveAccess } from '../auth/access.js';
import type { ClientClaims, TokenVerifier } from '../auth/jwt.js';
import type { DocService, HotDoc, Subscriber } from '../core/doc-service.js';
import { encodeAwareness, parseAwareness, type Presence } from '../core/presence.js';
import { InProcessLimiter } from '../limits/token-bucket.js';
import { Outbound, type BackpressureEvent } from './outbound.js';

/** Hooks that bring rate limits, quotas and metering into the gateway; all optional. */
export interface GatewayPolicy {
  /** Per-IP admission at upgrade time. Throw RATE_LIMITED to answer HTTP 429. */
  admit?(ip: string): Promise<void>;
  /** Reserves a connection slot. Throw QUOTA_EXCEEDED to close with 4402. */
  acquire?(tenantId: string): Promise<void>;
  release?(tenantId: string): void;
  /** Per-connection message bucket (in-process, no Redis hop). */
  message?(connId: string): { allowed: boolean; retryAfterMs: number };
  trustProxy?: boolean;
}

export interface GatewayOptions {
  policy?: GatewayPolicy;
  presence?: Presence;
  /** Backpressure: stop writing broadcasts above this many buffered bytes (Doc 03 WS_OUTBOUND_HIGH_WATER). */
  highWater?: number;
  slowCloseMs?: number;
  onBackpressure?: (e: BackpressureEvent) => void;
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
  admitted = false;
  rejected = false;
  lastRateError = 0;
  expiryTimer: NodeJS.Timeout | undefined;
  /** Awareness client ids this connection has announced per document, with their last clock. */
  readonly awareness = new Map<string, Map<number, number>>();
  readonly outbound: Outbound;

  constructor(
    readonly ws: WebSocket,
    readonly claims: ClientClaims,
    readonly clientId: string,
    opts: { highWater: number; slowCloseMs: number; onEvent?: (e: BackpressureEvent) => void },
  ) {
    this.outbound = new Outbound(ws, opts);
  }

  send(frame: Uint8Array): void {
    this.outbound.send(frame);
  }

  broadcast(docKey: string, seq: number, originClientId: string, update: Uint8Array): void {
    this.outbound.broadcast(docKey, seq, originClientId, update);
  }

  sendEphemeral(frame: Uint8Array): void {
    this.outbound.sendEphemeral(frame);
  }
}

export class Gateway {
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<Connection>();
  private readonly byClient = new Map<string, Connection>();
  private timer: NodeJS.Timeout | undefined;
  private draining = false;
  private readonly awLimiter = new InProcessLimiter();

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
      if (this.draining) {
        reject(socket, 503); // shutting down: clients retry another node
        return;
      }
      void (async () => {
        await this.o.policy?.admit?.(this.ipOf(req));
        return this.authenticate(req, url);
      })()
        .then(({ claims, clientId }) => {
          this.wss.handleUpgrade(req, socket, head, (ws) => {
            this.onConnection(ws, claims, clientId);
          });
        })
        .catch((e: unknown) => {
          const code = e instanceof SyncraError ? e.code : 'UNAUTHENTICATED';
          reject(socket, code === 'VALIDATION_FAILED' ? 400 : code === 'RATE_LIMITED' ? 429 : 401);
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

  private ipOf(req: IncomingMessage): string {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    return (this.o.policy?.trustProxy && first) || req.socket.remoteAddress || 'unknown';
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
    const conn = new Connection(ws, claims, clientId, {
      highWater: this.o.highWater ?? 1_048_576,
      slowCloseMs: this.o.slowCloseMs ?? 15_000,
      onEvent: this.o.onBackpressure,
    });
    const slot = `${claims.tenantId}\u0000${clientId}`;
    this.byClient.get(slot)?.ws.close(CLOSE_CODES.NORMAL, 'replaced');
    this.byClient.set(slot, conn);
    this.conns.add(conn);

    // Messages can arrive before the connection slot is reserved, so processing waits on this chain.
    conn.chain = (async () => {
      try {
        await this.o.policy?.acquire?.(claims.tenantId);
        conn.admitted = true;
      } catch (e) {
        conn.rejected = true;
        const err = SyncraError.from(e);
        ws.close(
          err.code === 'QUOTA_EXCEEDED' ? CLOSE_CODES.QUOTA_EXCEEDED : CLOSE_CODES.FORBIDDEN,
          err.message.slice(0, 100),
        );
      }
    })();
    const untilExpiry = Math.min(Math.max(claims.exp * 1000 - Date.now(), 0), 2 ** 31 - 1);
    conn.expiryTimer = setTimeout(() => {
      ws.close(CLOSE_CODES.TOKEN_EXPIRED, 'token expired');
    }, untilExpiry);

    ws.on('pong', () => {
      conn.lastSeen = Date.now();
    });
    ws.on('message', (data: Buffer, isBinary) => {
      conn.lastSeen = Date.now();
      if (!isBinary) {
        ws.close(1003, 'binary only');
        return;
      }
      const verdict = this.o.policy?.message?.(conn.id);
      if (verdict && !verdict.allowed) {
        if (Date.now() - conn.lastRateError > 1000) {
          conn.lastRateError = Date.now();
          this.sendError(
            conn,
            '',
            new SyncraError('RATE_LIMITED', 'Too many messages', {
              scope: 'connection',
              retryAfterMs: verdict.retryAfterMs,
            }),
          );
        }
        return; // dropped; the client backs off using retryAfterMs
      }
      const frame = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      conn.chain = conn.chain.then(() => this.handleFrame(conn, frame));
    });
    ws.on('close', () => {
      this.conns.delete(conn);
      clearTimeout(conn.expiryTimer);
      conn.outbound.dispose();
      this.announceGone(conn);
      if (conn.admitted) this.o.policy?.release?.(claims.tenantId);
      if (this.byClient.get(slot) === conn) this.byClient.delete(slot);
      for (const s of conn.subs.values()) this.o.svc.unsubscribe(s.hot, conn);
      conn.subs.clear();
    });
    ws.on('error', (e) => {
      this.o.logger.debug({ err: e, connId: conn.id }, 'ws error');
    });
  }

  private async handleFrame(conn: Connection, frame: Uint8Array): Promise<void> {
    if (conn.rejected) return;
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
        // Who is already here, on any node.
        for (const update of (await this.o.presence?.snapshot(conn.claims.tenantId, msg.docKey)) ??
          []) {
          conn.sendEphemeral(encodeMessage({ type: 'AWARENESS', docKey: msg.docKey, update }));
        }
        return;
      }
      case 'UNSUBSCRIBE': {
        const sub = conn.subs.get(msg.docKey);
        if (sub) {
          svc.unsubscribe(sub.hot, conn);
          this.announceGone(conn, msg.docKey);
        }
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
        const entries = parseAwareness(msg.update);
        if (!entries) {
          throw new SyncraError(
            msg.update.length > LIMITS.maxAwarenessBytes
              ? 'PAYLOAD_TOO_LARGE'
              : 'VALIDATION_FAILED',
            'Invalid awareness update',
          );
        }
        // 20 updates per second per client (Doc 03 §10); extras are dropped, presence is ephemeral.
        if (!this.awLimiter.takeSync(`aw:${conn.id}`, { capacity: 20, ratePerSec: 20 }).allowed)
          return;
        const known = conn.awareness.get(msg.docKey) ?? new Map<number, number>();
        conn.awareness.set(msg.docKey, known);
        for (const e of entries) {
          if (e.state === 'null') known.delete(e.clientId);
          else known.set(e.clientId, e.clock);
        }
        svc.forwardAwareness(hot, conn, msg.update);
        void this.o.presence?.record(conn.claims.tenantId, msg.docKey, entries);
        void this.o.presence?.publish(conn.claims.tenantId, msg.docKey, msg.update);
        return;
      }
      default:
        throw new SyncraError('VALIDATION_FAILED', `Unexpected message ${msg.type}`);
    }
  }

  /** Tells everyone that this connection's awareness clients left (clean close, unsubscribe or crash). */
  private announceGone(conn: Connection, onlyDocKey?: string): void {
    for (const [docKey, ids] of conn.awareness) {
      if (onlyDocKey !== undefined && docKey !== onlyDocKey) continue;
      if (ids.size === 0) continue;
      const entries = [...ids].map(([clientId, clock]) => ({
        clientId,
        clock: clock + 1,
        state: 'null',
      }));
      const update = encodeAwareness(entries);
      const sub = conn.subs.get(docKey);
      if (sub) this.o.svc.forwardAwareness(sub.hot, conn, update);
      void this.o.presence?.record(conn.claims.tenantId, docKey, entries);
      void this.o.presence?.publish(conn.claims.tenantId, docKey, update);
      conn.awareness.delete(docKey);
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
        retryAfterMs: typeof err.details?.retryAfterMs === 'number' ? err.details.retryAfterMs : 0,
      }),
    );
  }

  /** Hard kill (chaos tests, demo "kill node"): drop every socket with no close frame and no flush. */
  kill(): void {
    this.draining = true;
    clearInterval(this.timer);
    for (const c of this.conns) c.ws.terminate();
  }

  /** Graceful shutdown: close sockets with 1001, then flush buffered writes. */
  async close(): Promise<void> {
    this.draining = true;
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
  if (
    i < 0 ||
    (collection !== INDEX_COLLECTION && !COLLECTION_REGEX.test(collection)) ||
    !DOC_ID_REGEX.test(docId)
  ) {
    throw new SyncraError('VALIDATION_FAILED', 'Invalid docKey');
  }
  return [collection, docId];
}

const REASONS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  429: 'Too Many Requests',
  503: 'Service Unavailable',
};

function reject(socket: Duplex, status: number): void {
  socket.write(
    `HTTP/1.1 ${String(status)} ${REASONS[status] ?? 'Error'}\r\nConnection: close\r\n\r\n`,
  );
  socket.destroy();
}
