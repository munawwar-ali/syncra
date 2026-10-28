/** Fastify app factory: request IDs, error mapping, /healthz, /readyz, /metrics. */
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { SyncraError } from '@syncra/shared';
import type { Config } from './config.js';
import { checkReady, type Deps } from './health.js';
import { httpDuration, registry } from './observability/metrics.js';

export async function buildApp(
  cfg: Config,
  deps: Deps,
  logger: FastifyBaseLogger,
): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 1_048_576,
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? `req_${randomUUID()}`,
  });
  await app.register(helmet);
  await app.register(cors, { origin: cfg.CORS_ORIGINS.split(','), credentials: true });

  app.addHook('onResponse', (req, reply, done) => {
    httpDuration
      .labels(req.routeOptions.url ?? 'unknown', req.method, String(reply.statusCode))
      .observe(reply.elapsedTime / 1000);
    done();
  });

  app.setErrorHandler((err, req, reply) => {
    const e = toSyncraError(err);
    if (e.code === 'INTERNAL') req.log.error({ err }, 'unhandled error');
    void reply.status(e.httpStatus).send(e.toBody(req.id));
  });

  app.get('/healthz', () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    const failing = await checkReady(deps);
    if (failing.length > 0) return reply.status(503).send({ status: 'unavailable', failing });
    return { status: 'ready' };
  });

  app.get('/metrics', async (req, reply) => {
    if (cfg.METRICS_TOKEN) {
      const basic = (req.headers.authorization ?? '').replace(/^Basic /, '');
      const pass = Buffer.from(basic, 'base64').toString().split(':')[1];
      if (pass !== cfg.METRICS_TOKEN) {
        throw new SyncraError('UNAUTHENTICATED', 'Metrics auth required');
      }
    }
    return reply.header('content-type', registry.contentType).send(await registry.metrics());
  });

  return app;
}

function toSyncraError(err: unknown): SyncraError {
  if (err instanceof SyncraError) return err;
  const status = (err as { statusCode?: number }).statusCode;
  if (status === 413) return new SyncraError('PAYLOAD_TOO_LARGE', 'Payload too large');
  if (status === 400 || status === 422) {
    return new SyncraError('VALIDATION_FAILED', 'Invalid request');
  }
  return SyncraError.from(err);
}
