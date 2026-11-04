/**
 * Live monitor sampler (DSH-02, DSH-10): once a second turns counters into rates and a 95th-percentile
 * ack latency over the last few seconds. Per-tenant figures never include other tenants' traffic.
 */

export interface MonitorSnapshot {
  at: number;
  opsPerSec: number;
  ackP95Ms: number;
  connections: number;
  hotDocs: number;
}

const WINDOW_MS = 5000;

export class Monitor {
  private ackSamples: { at: number; ms: number }[] = [];
  private opsTotal = 0;
  private readonly opsByTenant = new Map<string, number>();
  private last: { snap: MonitorSnapshot; tenantOps: Map<string, number> } | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly read: () => { connections: number; hotDocs: number },
    private readonly connectionsOf: (tenantId: string) => number,
    private readonly now: () => number = Date.now,
  ) {}

  countOp(tenantId: string): void {
    this.opsTotal++;
    this.opsByTenant.set(tenantId, (this.opsByTenant.get(tenantId) ?? 0) + 1);
  }

  recordAck(ms: number): void {
    this.ackSamples.push({ at: this.now(), ms });
    if (this.ackSamples.length > 20_000) this.ackSamples.splice(0, this.ackSamples.length - 20_000);
  }

  /** Percentile over the recent window; 0 when there were no acks. */
  private ackP95(): number {
    const from = this.now() - WINDOW_MS;
    this.ackSamples = this.ackSamples.filter((s) => s.at >= from);
    if (this.ackSamples.length === 0) return 0;
    const sorted = this.ackSamples.map((s) => s.ms).sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] as number;
  }

  /** Called once per second. `dtMs` is the real elapsed time since the previous tick. */
  tick(dtMs = 1000): MonitorSnapshot {
    const secs = Math.max(0.001, dtMs / 1000);
    const tenantOps = new Map([...this.opsByTenant].map(([t, n]) => [t, n / secs]));
    const stats = this.read();
    const snap: MonitorSnapshot = {
      at: this.now(),
      opsPerSec: this.opsTotal / secs,
      ackP95Ms: this.ackP95(),
      connections: stats.connections,
      hotDocs: stats.hotDocs,
    };
    this.opsTotal = 0;
    this.opsByTenant.clear();
    this.last = { snap, tenantOps };
    return snap;
  }

  start(): void {
    let prev = this.now();
    this.timer = setInterval(() => {
      const t = this.now();
      this.tick(t - prev);
      prev = t;
    }, 1000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Latest figures scoped to one tenant (`system` adds node-wide numbers for self-hosted operators). */
  view(tenantId: string, system: boolean) {
    const l = this.last;
    return {
      at: l?.snap.at ?? this.now(),
      opsPerSec: round(l?.tenantOps.get(tenantId) ?? 0),
      connections: this.connectionsOf(tenantId),
      ackP95Ms: round(l?.snap.ackP95Ms ?? 0),
      ...(system && l
        ? {
            system: {
              opsPerSec: round(l.snap.opsPerSec),
              connections: l.snap.connections,
              hotDocs: l.snap.hotDocs,
            },
          }
        : {}),
    };
  }
}

const round = (n: number): number => Math.round(n * 100) / 100;
