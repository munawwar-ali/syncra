/** Prometheus registry and HTTP latency histogram (Doc 02 §14.1). */
import { Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['route', 'method', 'status'] as const,
  registers: [registry],
});
