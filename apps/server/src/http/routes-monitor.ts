/** Live monitor endpoints (DSH-02, DSH-10): a 1 s SSE stream and the node list for operators. */
import type { FastifyInstance } from 'fastify';
import { SyncraError } from '@syncra/shared';
import { listNodes } from '../core/registry.js';
import type { Services } from '../services.js';
import { authDashboard } from './auth.js';

export function registerMonitorRoutes(app: FastifyInstance, s: Services): void {
  /** Operators see the whole installation. That is only meaningful when this instance is self-hosted (billing off). */
  const isOperator = (role: string): boolean =>
    !s.cfg.BILLING_ENABLED && (role === 'owner' || role === 'admin');

  app.get('/monitor/nodes', async (req) => {
    const p = await authDashboard(s, req);
    if (!isOperator(p.role))
      throw new SyncraError('FORBIDDEN', 'Node details are available to self-hosted operators');
    const nodes = await listNodes(s.deps.redis).catch(() => []);
    return { items: nodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId)) };
  });

  app.get('/monitor/stream', async (req, reply) => {
    const p = await authDashboard(s, req);
    const system = isOperator(p.role);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let closed = false;
    req.raw.on('close', () => {
      closed = true;
    });
    const isClosed = (): boolean => closed; // set from the close handler, which TS cannot see
    while (!isClosed() && !s.docs.isStopped) {
      res.write(`event: tick\ndata: ${JSON.stringify(s.monitor.view(p.tenantId, system))}\n\n`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    res.end();
  });
}
