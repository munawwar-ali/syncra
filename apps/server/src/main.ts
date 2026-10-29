/** Sync node entry point: load config, start the node, shut down gracefully on SIGTERM/SIGINT. */
import { loadConfig } from './config.js';
import { createLogger } from './observability/logger.js';
import { startNode } from './server.js';

const cfg = loadConfig();
const logger = createLogger(cfg.LOG_LEVEL, cfg.NODE_ID);
const node = await startNode(cfg, { logger });

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'shutting down');
  await node.stop();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
