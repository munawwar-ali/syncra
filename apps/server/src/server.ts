/** Assembles one sync node (HTTP + WebSocket + doc service) so main.ts and tooling can start it. */
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { buildApp } from './app.js';
import { createSharedSecretVerifier } from './auth/jwt.js';
import type { Config } from './config.js';
import { DocService } from './core/doc-service.js';
import { registerDemoRoutes } from './demo/routes.js';
import { closeDeps, createDeps, type Deps } from './health.js';
import { createLogger } from './observability/logger.js';
import { ShardRing } from './shards/ring.js';
import { Gateway } from './ws/gateway.js';

export interface RunningNode {
  app: FastifyInstance;
  gateway: Gateway;
  svc: DocService;
  deps: Deps;
  port: number;
  /** Graceful stop: close sockets with 1001, flush buffered writes, release connections. */
  stop(): Promise<void>;
}

export async function startNode(
  cfg: Config,
  opts: { deps?: Deps; logger?: Logger } = {},
): Promise<RunningNode> {
  const logger = opts.logger ?? createLogger(cfg.LOG_LEVEL, cfg.NODE_ID);
  const deps = opts.deps ?? createDeps(cfg);
  const app = await buildApp(cfg, deps, logger);
  if (cfg.DEMO_MODE) registerDemoRoutes(app, cfg);

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
  await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : cfg.PORT;

  return {
    app,
    gateway,
    svc,
    deps,
    port,
    async stop() {
      await gateway.close();
      await app.close();
      await closeDeps(deps);
    },
  };
}
