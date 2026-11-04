/** Prometheus registry and HTTP latency histogram (Doc 02 §14.1). */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['route', 'method', 'status'] as const,
  registers: [registry],
});

export const ackLatency = new Histogram({
  name: 'syncra_ack_latency_seconds',
  help: 'Time from receiving an update to acknowledging its durable commit',
  labelNames: ['node'] as const,
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

export const gapRecoveries = new Counter({
  name: 'syncra_gap_recoveries_total',
  help: 'Missed fan-out updates repaired from Postgres',
  labelNames: ['node'] as const,
  registers: [registry],
});

export const backpressureEvents = new Counter({
  name: 'syncra_backpressure_events_total',
  help: 'Slow-consumer events',
  labelNames: ['action'] as const,
  registers: [registry],
});

export const rateLimited = new Counter({
  name: 'syncra_rate_limited_total',
  help: 'Requests or messages rejected by a rate limit',
  labelNames: ['scope'] as const,
  registers: [registry],
});

export const quotaBlocked = new Counter({
  name: 'syncra_quota_blocked_total',
  help: 'Actions blocked by a plan quota',
  labelNames: ['metric'] as const,
  registers: [registry],
});

export const opsReceived = new Counter({
  name: 'syncra_ops_received_total',
  help: 'Accepted client update frames',
  registers: [registry],
});

let source: (() => { connections: number; hotDocs: number }) | undefined;
let sourceNode = 'node';
let gaugesRegistered = false;

/**
 * Exposes per-node gauges. Idempotent: the gauges are created once per process and read the most
 * recently registered node (a process normally runs exactly one; tests start several).
 */
export function registerGauges(
  read: () => { connections: number; hotDocs: number },
  node: string,
): void {
  source = read;
  sourceNode = node;
  if (gaugesRegistered) return;
  gaugesRegistered = true;
  new Gauge({
    name: 'syncra_ws_connections',
    help: 'Open WebSocket connections',
    labelNames: ['node'] as const,
    registers: [registry],
    collect() {
      this.set({ node: sourceNode }, source?.().connections ?? 0);
    },
  });
  new Gauge({
    name: 'syncra_hot_docs',
    help: 'Documents held in the hot cache',
    labelNames: ['node'] as const,
    registers: [registry],
    collect() {
      this.set({ node: sourceNode }, source?.().hotDocs ?? 0);
    },
  });
}
