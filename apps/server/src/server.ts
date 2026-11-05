/** Assembles one sync node (HTTP + WebSocket + services) so main.ts, tests and tooling can start it. */
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { buildApp } from './app.js';
import type { Config } from './config.js';
import { registerDemoRoutes } from './demo/routes.js';
import { seedInspectionDemo } from './demo/seed-inspection.js';
import { closeDeps, createDeps, type Deps } from './health.js';
import { createLogger } from './observability/logger.js';
import { createServices, type Services } from './services.js';
import { SyncraError } from '@syncra/shared';
import { NodeRegistry } from './core/registry.js';
import { ackLatency, backpressureEvents, registerGauges } from './observability/metrics.js';
import { Gateway } from './ws/gateway.js';

export interface RunningNode {
  app: FastifyInstance;
  gateway: Gateway;
  services: Services;
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
  const services = createServices(cfg, deps, logger);
  const app = await buildApp(cfg, deps, logger, services);
  if (cfg.DEMO_MODE) {
    registerDemoRoutes(app, services);
    void seedInspectionDemo(services).catch((err: unknown) => {
      logger.warn({ err }, 'inspection demo seed failed');
    });
  }

  const gateway = new Gateway({
    svc: services.docs,
    verify: services.verifyClientToken,
    logger,
    maxMessageBytes: cfg.MAX_MESSAGE_BYTES,
    presence: services.presence,
    highWater: cfg.WS_OUTBOUND_HIGH_WATER,
    slowCloseMs: cfg.WS_SLOW_CLOSE_MS,
    onAck: (ms) => {
      ackLatency.labels(cfg.NODE_ID).observe(ms / 1000);
      services.monitor.recordAck(ms);
    },
    onBackpressure: (e) => {
      backpressureEvents.labels(e).inc();
    },
    policy: {
      trustProxy: cfg.TRUST_PROXY,
      admit: async (ip) => {
        const r = await services.limiter.take(`ip:${ip}`, {
          capacity: cfg.RL_IP_RATE * 2,
          ratePerSec: cfg.RL_IP_RATE,
        });
        if (!r.allowed)
          throw new SyncraError('RATE_LIMITED', 'Too many connection attempts', {
            retryAfterMs: r.retryAfterMs,
          });
      },
      acquire: (tid) => services.quotas.acquireConnection(tid),
      release: (tid) => {
        services.quotas.releaseConnection(tid).catch(() => undefined);
      },
      message: (connId) =>
        services.localLimiter.takeSync(`conn:${connId}`, {
          capacity: cfg.RL_CONN_BURST,
          ratePerSec: cfg.RL_CONN_RATE,
        }),
    },
  });
  gateway.attach(app.server);
  const stats = () => ({
    connections: gateway.connectionCount,
    hotDocs: services.docs.hotDocCount,
  });
  registerGauges(stats, cfg.NODE_ID);
  services.live.stats = stats;
  services.live.connectionsOf = (tid) => gateway.connectionsFor(tid);
  const registry = new NodeRegistry(deps.redis, cfg.NODE_ID, stats);
  registry.start();
  const presenceTouch = setInterval(() => {
    void services.presence.touch(services.docs.activeDocs());
  }, 20_000);
  presenceTouch.unref();
  await app.listen({ port: cfg.PORT, host: '0.0.0.0' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : cfg.PORT;

  return {
    app,
    gateway,
    services,
    deps,
    port,
    async stop() {
      // Graceful (SYN-10): leave the registry, refuse new sockets, close with 1001, flush batched writes.
      clearInterval(presenceTouch);
      await registry.stop();
      await gateway.close();
      await app.close();
      await services.stop();
      await closeDeps(deps);
    },
  };
}
