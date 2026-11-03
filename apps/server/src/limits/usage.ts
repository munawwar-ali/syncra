/** Usage metering counters in Redis, flushed into usage_hourly by the worker (OPS-04). */
import type { Redis } from 'ioredis';

export type UsageMetric = 'ops' | 'bytes_written' | 'docs_created';

export const hourKey = (d: Date): string =>
  `${String(d.getUTCFullYear())}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}`;

export const counterKey = (tenantId: string, d: Date): string =>
  `sx:usage:${tenantId}:${hourKey(d)}`;

export class UsageCounters {
  /** Locally counted connections, used when Redis is unavailable. */
  private readonly localConns = new Map<string, number>();

  constructor(
    private readonly redis: Redis,
    private readonly now: () => Date = () => new Date(),
    private readonly onError: (e: unknown) => void = () => undefined,
  ) {}

  /** Metering must never fail a write, so Redis errors are reported and swallowed. */
  async record(tenantId: string, deltas: Partial<Record<UsageMetric, number>>): Promise<void> {
    try {
      const key = counterKey(tenantId, this.now());
      const p = this.redis.multi();
      for (const [m, v] of Object.entries(deltas)) if (v) p.hincrby(key, m, v);
      p.expire(key, 3 * 3600);
      await p.exec();
    } catch (e) {
      this.onError(e);
    }
  }

  /** Sum of `metric` across this month's counters that the worker has not flushed yet. */
  async unflushed(tenantId: string, metric: UsageMetric): Promise<number> {
    try {
      const month = hourKey(this.now()).slice(0, 6);
      let cursor = '0';
      let sum = 0;
      do {
        const [next, keys] = await this.redis.scan(
          cursor,
          'MATCH',
          `sx:usage:${tenantId}:${month}*`,
          'COUNT',
          200,
        );
        cursor = next;
        for (const k of keys) sum += Number((await this.redis.hget(k, metric)) ?? 0);
      } while (cursor !== '0');
      return sum;
    } catch (e) {
      this.onError(e);
      return 0;
    }
  }

  /** Reserves a connection slot; returns the tenant's connection count including this one. */
  async connectionOpened(tenantId: string): Promise<number> {
    this.localConns.set(tenantId, (this.localConns.get(tenantId) ?? 0) + 1);
    try {
      return await this.redis.incr(`sx:conn:${tenantId}`);
    } catch (e) {
      this.onError(e);
      return this.localConns.get(tenantId) ?? 1;
    }
  }

  async connectionClosed(tenantId: string): Promise<void> {
    this.localConns.set(tenantId, Math.max(0, (this.localConns.get(tenantId) ?? 1) - 1));
    try {
      const n = await this.redis.decr(`sx:conn:${tenantId}`);
      if (n < 0) await this.redis.set(`sx:conn:${tenantId}`, 0); // never let drift go negative
    } catch (e) {
      this.onError(e);
    }
  }
}
