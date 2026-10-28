import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import type { Deps } from './health.js';

const cfg = loadConfig({
  CONTROL_DATABASE_URL: 'postgres://u:p@localhost:5432/c',
  SHARD_DATABASE_URLS: 'postgres://u:p@localhost:5433/s0',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
});

const okPool = { query: vi.fn().mockResolvedValue({}) };
const mkDeps = (redisOk: boolean): Deps =>
  ({
    control: okPool,
    shards: [okPool],
    redis: {
      ping: redisOk
        ? vi.fn().mockResolvedValue('PONG')
        : vi.fn().mockRejectedValue(new Error('down')),
    },
  }) as unknown as Deps;

const silent = () => pino({ level: 'silent' });

describe('health endpoints', () => {
  it('/healthz is 200', async () => {
    const app = await buildApp(cfg, mkDeps(true), silent());
    expect((await app.inject('/healthz')).statusCode).toBe(200);
  });
  it('/readyz is 200 when all deps are up, 503 naming the failing one otherwise', async () => {
    const up = await buildApp(cfg, mkDeps(true), silent());
    expect((await up.inject('/readyz')).statusCode).toBe(200);
    const down = await buildApp(cfg, mkDeps(false), silent());
    const res = await down.inject('/readyz');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ failing: ['redis'] });
  });
  it('/metrics exposes prometheus text', async () => {
    const app = await buildApp(cfg, mkDeps(true), silent());
    expect((await app.inject('/metrics')).body).toContain('process_cpu');
  });
  it('/metrics requires auth when METRICS_TOKEN is set', async () => {
    const app = await buildApp({ ...cfg, METRICS_TOKEN: 's3' }, mkDeps(true), silent());
    expect((await app.inject('/metrics')).statusCode).toBe(401);
  });
});
