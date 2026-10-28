/** Sync node entry point: load config, connect dependencies, serve, shut down gracefully. */
import { loadConfig } from './config.js';
import { closeDeps, createDeps } from './health.js';
import { buildApp } from './app.js';
import { createLogger } from './observability/logger.js';

const cfg = loadConfig();
const logger = createLogger(cfg.LOG_LEVEL, cfg.NODE_ID);
const deps = createDeps(cfg);
const app = await buildApp(cfg, deps, logger);

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'shutting down');
  await app.close();
  await closeDeps(deps);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
