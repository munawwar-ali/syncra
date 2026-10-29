/** Sync node entry point: load config, connect dependencies, serve, shut down gracefully. */
import { loadConfig } from './config.js';
import { closeDeps, createDeps } from './health.js';
import { buildApp } from './app.js';
import { createLogger } from './observability/logger.js';
import { createSharedSecretVerifier } from './auth/jwt.js';
import { DocService } from './core/doc-service.js';
import { ShardRing } from './shards/ring.js';
import { Gateway } from './ws/gateway.js';

const cfg = loadConfig();
const logger = createLogger(cfg.LOG_LEVEL, cfg.NODE_ID);
const deps = createDeps(cfg);
const app = await buildApp(cfg, deps, logger);

const svc = new DocService({
  ring: new ShardRing(deps.shards.length),
  shards: deps.shards,
  cacheMax: cfg.HOT_DOC_CACHE_MAX,
  cacheIdleMs: cfg.HOT_DOC_IDLE_MS,
  batchWindowMs: cfg.BATCH_WINDOW_MS,
  batchMaxBytes: cfg.BATCH_MAX_BYTES,
  maxUpdateBytes: cfg.MAX_UPDATE_BYTES,
});
const gateway = new Gateway({
  svc,
  // Phase 1 shortcut: one shared secret; per-tenant signing keys arrive with Phase 3 (P3-T05).
  verify: createSharedSecretVerifier(cfg.JWT_ACCESS_SECRET),
  logger,
  maxMessageBytes: cfg.MAX_MESSAGE_BYTES,
});
gateway.attach(app.server);

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'shutting down');
  await gateway.close();
  await app.close();
  await closeDeps(deps);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
