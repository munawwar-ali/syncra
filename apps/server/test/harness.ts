/** Test harness: an in-process gateway over the embedded Postgres shards, plus a raw protocol client. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { SignJWT } from 'jose';
import { inject } from 'vitest';
import pino from 'pino';
import { decodeMessage, encodeMessage, type Message } from '@syncra/protocol';
import { createClientTokenVerifier } from '../src/auth/jwt.js';
import type { AccessRule } from '../src/auth/access.js';
import { DocService, type DocServiceOptions } from '../src/core/doc-service.js';
import { ShardRing } from '../src/shards/ring.js';
import { Gateway, type GatewayOptions } from '../src/ws/gateway.js';
import type { Presence } from '../src/core/presence.js';

export const SECRET = 'test-secret-test-secret-test-secret-1234';

export interface Harness {
  url: string;
  port: number;
  svc: DocService;
  gateway: Gateway;
  pools: pg.Pool[];
  ring: ShardRing;
  /** True once the node was closed or crashed. */
  stopped: boolean;
  close(): Promise<void>;
  /** Abrupt loss of the node: sockets die with no 1001, no flush, no deregistration. */
  crash(): Promise<void>;
}

export function makePools(): pg.Pool[] {
  return inject('shardUrls').map((u) => new pg.Pool({ connectionString: u, max: 10 }));
}

export async function startServer(
  overrides: Partial<DocServiceOptions> = {},
  pools: pg.Pool[] = makePools(),
  port = 0,
  extra: { presence?: Presence; gateway?: Partial<GatewayOptions> } = {},
): Promise<Harness> {
  const ring = new ShardRing(pools.length);
  const svc = new DocService({
    ring,
    shards: pools,
    cacheMax: 100,
    cacheIdleMs: 60_000,
    batchWindowMs: 20,
    batchMaxBytes: 262_144,
    maxUpdateBytes: 1_048_576,
    ...overrides,
  });
  const gateway = new Gateway({
    svc,
    verify: createClientTokenVerifier(() =>
      Promise.resolve({ secret: new TextEncoder().encode(SECRET), active: true }),
    ),
    logger: pino({ level: 'silent' }),
    maxMessageBytes: 2_097_152,
    presence: extra.presence,
    ...extra.gateway,
  });
  const server: Server = createServer();
  gateway.attach(server);
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const boundPort = (server.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${String(boundPort)}`,
    port: boundPort,
    svc,
    gateway,
    pools,
    ring,
    stopped: false,
    async crash() {
      gateway.kill();
      server.closeAllConnections();
      await new Promise((res) => server.close(res));
    },
    async close() {
      await gateway.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

export function mintToken(
  tenantId: string,
  access: AccessRule[],
  expiresIn = '1h',
): Promise<string> {
  return new SignJWT({ tid: tenantId, access })
    .setProtectedHeader({ alg: 'HS256', kid: tenantId })
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(SECRET));
}

export const rwAll = (...collections: string[]): AccessRule[] =>
  collections.map((collection) => ({ collection, docs: '*', mode: 'rw' }));

export const newTenant = (): string => randomUUID();

/** Counts op rows for a document, wherever the ring placed it. */
export async function countOps(h: Harness, tenant: string, collection: string, docId: string) {
  const pool = h.pools[h.ring.route(tenant, collection, docId)] as pg.Pool;
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text n from operations o join documents d on d.uid = o.doc_uid
     where d.tenant_id = $1 and d.collection = $2 and d.doc_id = $3`,
    [tenant, collection, docId],
  );
  return Number(rows[0]?.n);
}

/** Protocol-level client for tests that need to send hand-crafted frames. */
export class RawClient {
  readonly frames: Message[] = [];
  private readonly ws: WebSocket;
  private waiters: (() => void)[] = [];
  readonly opened: Promise<void>;
  closeCode: number | undefined;

  constructor(url: string, token: string, clientId = randomUUID()) {
    this.ws = new WebSocket(`${url}/v1/connect?clientId=${clientId}&token=${token}&v=1`);
    this.ws.binaryType = 'arraybuffer';
    this.opened = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => {
        res();
      });
      this.ws.addEventListener('error', () => {
        rej(new Error('connect failed'));
      });
    });
    this.opened.catch(() => undefined);
    this.ws.addEventListener('message', (ev: MessageEvent) => {
      this.frames.push(decodeMessage(new Uint8Array(ev.data as ArrayBuffer)));
      this.waiters.splice(0).forEach((w) => {
        w();
      });
    });
    this.ws.addEventListener('close', (ev) => {
      this.closeCode = ev.code;
    });
  }

  send(m: Message): void {
    this.ws.send(encodeMessage(m));
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  /** Waits until `n` frames matching `pred` have arrived and returns them. */
  async waitFor<T extends Message['type']>(
    type: T,
    n = 1,
    timeoutMs = 5000,
  ): Promise<Extract<Message, { type: T }>[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hits = this.frames.filter((f) => f.type === type) as Extract<Message, { type: T }>[];
      if (hits.length >= n) return hits;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${type} x${String(n)}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }

  close(): void {
    this.ws.close();
  }
}

export async function eventually(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('eventually: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
