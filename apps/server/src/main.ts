/**
 * Sync node entry point: load config, start the node, shut down gracefully on SIGTERM/SIGINT.
 *
 * Single-process mode for hosts with one free service (no separate worker or migrate job):
 *   RUN_MIGRATIONS=true  migrate every database (and seed the demo tenant when DEMO_MODE=true) on start
 *   INLINE_JOBS=true     run the worker's scheduled jobs inside this process
 */
import { migrateAll } from './db/migrate.js';
import { seedDemoTenant } from './control/seed.js';
import { createDeps } from './health.js';
import { startInlineJobs } from './jobs/inline.js';
import { loadConfig } from './config.js';
import { createLogger } from './observability/logger.js';
import { startNode } from './server.js';

const cfg = loadConfig();
const logger = createLogger(cfg.LOG_LEVEL, cfg.NODE_ID);

if (process.env.RUN_MIGRATIONS === 'true') {
  const applied = await migrateAll(cfg.CONTROL_DATABASE_URL, cfg.SHARD_DATABASE_URLS);
  logger.info({ applied }, 'migrations done');
}

const deps = createDeps(cfg);
if (cfg.DEMO_MODE && process.env.RUN_MIGRATIONS === 'true') {
  const seeded = await seedDemoTenant(deps.control, Buffer.from(cfg.ENCRYPTION_KEY, 'base64'));
  // Shown once, on first start only; read it from the host's log. Demo credentials, not real secrets.
  if (seeded.created) {
    console.log(`[demo] login: ${seeded.email} / ${seeded.password ?? ''}`);
    console.log(`[demo] publishable key: ${seeded.keys?.publishable ?? ''}`);
  }
}

const node = await startNode(cfg, { logger, deps });
const stopJobs = process.env.INLINE_JOBS === 'true' ? startInlineJobs(cfg, deps) : () => undefined;

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'shutting down');
  stopJobs();
  await node.stop();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
