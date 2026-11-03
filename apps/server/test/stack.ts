/** Full-stack test harness: the real node (HTTP + WS + services) over embedded Postgres and a mock Redis. */
import RedisMock from 'ioredis-mock';
import pg from 'pg';
import pino from 'pino';
import { inject } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { Deps } from '../src/health.js';
import { startNode, type RunningNode } from '../src/server.js';

let counter = 0;

export interface Stack {
  node: RunningNode;
  /** http://127.0.0.1:port */
  http: string;
  /** ws://127.0.0.1:port */
  ws: string;
  api: Api;
  close(): Promise<void>;
}

export interface Req {
  token?: string;
  tenant?: string;
  body?: unknown;
  cookie?: string;
  headers?: Record<string, string>;
  /** Pass raw text instead of JSON. */
  raw?: boolean;
}
export interface Res<T = any> {
  status: number;
  body: T;
  cookie: string | undefined;
  headers: Headers;
}
export type Api = <T = any>(method: string, path: string, req?: Req) => Promise<Res<T>>;

export async function startStack(env: Record<string, string> = {}): Promise<Stack> {
  const controlUrl = inject('controlUrl');
  const shardUrls = inject('shardUrls');
  const cfg = loadConfig({
    NODE_ENV: 'test',
    PORT: '0',
    CONTROL_DATABASE_URL: controlUrl,
    SHARD_DATABASE_URLS: shardUrls.join(','),
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'test-access-secret-test-access-secret-01',
    ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
    LOG_LEVEL: 'silent',
    WEBHOOK_ALLOW_PRIVATE: 'true',
    RL_IP_RATE: '1000',
    RL_AUTH_PER_MIN: '1000',
    QUOTA_CACHE_MS: '10',
    ...env,
  });
  const deps: Deps = {
    control: new pg.Pool({ connectionString: controlUrl, max: 10 }),
    shards: shardUrls.map((u) => new pg.Pool({ connectionString: u, max: 10 })),
    // A unique host gives each stack its own keyspace; ioredis-mock shares data between instances otherwise.
    redis: new RedisMock({ host: `mock-${String(counter++)}` }),
  };
  const node = await startNode(cfg, { deps, logger: pino({ level: 'silent' }) });
  const http = `http://127.0.0.1:${String(node.port)}`;

  const api: Api = async (method, path, req = {}) => {
    const headers: Record<string, string> = { ...req.headers };
    if (req.token) headers.authorization = `Bearer ${req.token}`;
    if (req.tenant) headers['x-tenant-id'] = req.tenant;
    if (req.cookie) headers.cookie = req.cookie;
    let body: string | undefined;
    if (req.body !== undefined) {
      body = req.raw ? (req.body as string) : JSON.stringify(req.body);
      headers['content-type'] ??= req.raw ? 'text/plain' : 'application/json';
    }
    const res = await fetch(`${http}${path}`, { method, headers, body });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // binary or text body
    }
    const setCookie = res.headers.get('set-cookie');
    return {
      status: res.status,
      body: parsed as never,
      cookie: setCookie?.split(';')[0],
      headers: res.headers,
    };
  };

  return {
    node,
    http,
    ws: `ws://127.0.0.1:${String(node.port)}`,
    api,
    async close() {
      await node.stop();
    },
  };
}

export const uniqueEmail = (): string =>
  `user${String(Date.now())}${String(counter++)}@example.com`;

/** Signs up a fresh account + tenant and returns everything a test needs. */
export async function signup(api: Api, label = 'Acme') {
  const email = uniqueEmail();
  const password = 'correct-horse-battery';
  const res = await api('POST', '/v1/auth/signup', {
    body: { email, password, name: label, tenantName: `${label} ${String(counter++)}` },
  });
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`);
  return {
    email,
    password,
    accessToken: res.body.accessToken as string,
    tenantId: res.body.tenant.id as string,
    userId: res.body.user.id as string,
    secretKey: res.body.keys.secret as string,
    publishableKey: res.body.keys.publishable as string,
    refreshCookie: res.cookie as string,
  };
}

export type Account = Awaited<ReturnType<typeof signup>>;
