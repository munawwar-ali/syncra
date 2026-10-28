/** Dependency pools and the checks behind /readyz: control DB, every shard, Redis. */
import pg from 'pg';
import { Redis } from 'ioredis';
import type { Config } from './config.js';

export interface Deps {
  control: pg.Pool;
  shards: pg.Pool[];
  redis: Redis;
}

export function createDeps(cfg: Config): Deps {
  return {
    control: new pg.Pool({ connectionString: cfg.CONTROL_DATABASE_URL, max: 10 }),
    shards: cfg.SHARD_DATABASE_URLS.map((u) => new pg.Pool({ connectionString: u, max: 20 })),
    redis: new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false }),
  };
}

export async function closeDeps(d: Deps): Promise<void> {
  await Promise.all([d.control.end(), ...d.shards.map((s) => s.end()), d.redis.quit()]);
}

const withTimeout = <T>(p: Promise<T>, ms = 2000): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, rej) => {
      setTimeout(() => {
        rej(new Error('timeout'));
      }, ms);
    }),
  ]);

/** Returns the names of failing dependencies; empty means ready. */
export async function checkReady(d: Deps): Promise<string[]> {
  const checks: [string, () => Promise<unknown>][] = [
    ['control', () => d.control.query('select 1')],
    ...d.shards.map((s, i): [string, () => Promise<unknown>] => [
      `shard-${String(i)}`,
      () => s.query('select 1'),
    ]),
    ['redis', () => d.redis.ping()],
  ];
  const results = await Promise.allSettled(checks.map(([, fn]) => withTimeout(fn())));
  return checks.flatMap(([name], i) => (results[i]?.status === 'rejected' ? [name] : []));
}
