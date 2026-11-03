/** Mounts the versioned API under /v1 with the per-IP rate limit (OPS-01). */
import type { FastifyInstance } from 'fastify';
import { SyncraError } from '@syncra/shared';
import type { Services } from '../services.js';
import { registerControlRoutes } from './routes-control.js';
import { registerDataRoutes } from './routes-data.js';

export async function registerV1(app: FastifyInstance, s: Services): Promise<void> {
  await app.register(
    (v1, _opts, done) => {
      v1.addHook('onRequest', async (req) => {
        const rate = s.cfg.RL_IP_RATE;
        const r = await s.limiter.take(`ip:${req.ip}`, { capacity: rate * 2, ratePerSec: rate });
        if (!r.allowed)
          throw new SyncraError('RATE_LIMITED', 'Too many requests', {
            scope: 'ip',
            retryAfterMs: r.retryAfterMs,
          });
      });
      registerControlRoutes(v1, s);
      registerDataRoutes(v1, s);
      done();
    },
    { prefix: '/v1' },
  );
}
