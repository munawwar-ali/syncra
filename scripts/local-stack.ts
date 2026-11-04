/**
 * Docker-free local stack: embedded PostgreSQL 16 (control + 2 shards), an in-memory Redis stand-in,
 * migrations, and one sync node in DEMO_MODE. Used by `pnpm dev:local` and the Playwright suites.
 * Redis-backed features (fan-out, rate limits) are emulated; use compose for the real thing.
 */
import EmbeddedPostgres from 'embedded-postgres';
import RedisMock from 'ioredis-mock';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import pg from 'pg';
import { loadConfig } from '../apps/server/src/config.js';
import { seedDemoTenant } from '../apps/server/src/control/seed.js';
import { migrateAll } from '../apps/server/src/db/migrate.js';
import { flushUsage, refreshGauges } from '../apps/server/src/jobs/usage.js';
import { maintainShard } from '../apps/server/src/jobs/lifecycle.js';
import { WebhookDispatcher } from '../apps/server/src/webhooks/dispatcher.js';
import { createDeps } from '../apps/server/src/health.js';
import { startNode } from '../apps/server/src/server.js';

const PG_PORT = Number(process.env.LOCAL_PG_PORT ?? 54330);
const PORT = Number(process.env.PORT ?? 8080);
const persistent = process.env.LOCAL_PERSIST === 'true';

const dataDir = persistent
  ? join(process.cwd(), '.local-data', 'pg')
  : mkdtempSync(join(tmpdir(), 'syncra-local-pg-'));
mkdirSync(dataDir, { recursive: true });

const embedded = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'syncra',
  password: 'syncra',
  port: PG_PORT,
  persistent,
});
if (!existsSync(join(dataDir, 'PG_VERSION'))) await embedded.initialise();
await embedded.start();

const url = (db: string): string => `postgres://syncra:syncra@localhost:${String(PG_PORT)}/${db}`;
const admin = new pg.Client({ connectionString: url('postgres') });
await admin.connect();
for (const db of ['syncra_control', 'syncra_shard_0', 'syncra_shard_1']) {
  const exists = await admin.query('select 1 from pg_database where datname = $1', [db]);
  if (exists.rowCount === 0) await admin.query(`create database ${db}`);
}
await admin.end();

const cfg = loadConfig({
  ...process.env,
  NODE_ENV: 'development',
  PORT: String(PORT),
  DEMO_MODE: 'true',
  CORS_ORIGINS: process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:5174',
  CONTROL_DATABASE_URL: url('syncra_control'),
  SHARD_DATABASE_URLS: `${url('syncra_shard_0')},${url('syncra_shard_1')}`,
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET ?? 'local-dev-secret-local-dev-secret-0001',
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
});
await migrateAll(cfg.CONTROL_DATABASE_URL, cfg.SHARD_DATABASE_URLS);

const deps = createDeps(cfg);
await deps.redis.quit().catch(() => undefined);
deps.redis = new RedisMock() as unknown as Redis;
const seeded = await seedDemoTenant(deps.control, Buffer.from(cfg.ENCRYPTION_KEY, 'base64'));
if (seeded.created) {
  console.log(`[local-stack] demo login: ${seeded.email} / ${seeded.password ?? ''}`);
  console.log(`[local-stack] secret key: ${seeded.keys?.secret ?? ''}`);
  console.log(`[local-stack] publishable key: ${seeded.keys?.publishable ?? ''}`);
}
const node = await startNode(cfg, { deps });
console.log(
  `[local-stack] sync node on http://localhost:${String(node.port)} (demo mode, embedded Postgres)`,
);

// The worker app is not part of this stack, so run its jobs in-process (same code, short intervals).
const dispatcher = new WebhookDispatcher(deps.control, {
  encryptionKey: Buffer.from(cfg.ENCRYPTION_KEY, 'base64'),
  allowPrivate: cfg.WEBHOOK_ALLOW_PRIVATE,
});
const jobs = [
  setInterval(() => void dispatcher.runDue().catch(() => undefined), 1000),
  setInterval(() => {
    void flushUsage(deps.redis, deps.control).catch(() => undefined);
    void refreshGauges(deps.shards, deps.control).catch(() => undefined);
  }, 3000),
  setInterval(() => {
    for (const shard of deps.shards) {
      void maintainShard(shard, deps.redis, {
        everyOps: cfg.SNAPSHOT_EVERY_OPS,
        everyBytes: cfg.SNAPSHOT_EVERY_BYTES,
        idleMs: cfg.SNAPSHOT_IDLE_MS,
        checkpointMs: cfg.CHECKPOINT_INTERVAL_MS,
        retentionDays: () => Promise.resolve(30),
      }).catch(() => undefined);
    }
  }, 2000),
];

const shutdown = async (): Promise<void> => {
  jobs.forEach(clearInterval);
  await node.stop().catch(() => undefined);
  await embedded.stop().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
