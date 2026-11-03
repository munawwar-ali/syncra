/**
 * Quota enforcement (OPS-03, BIL-01, BIL-05). Plan and usage are cached briefly per tenant and bumped
 * locally on every write, so a node reacts at once and the whole cluster converges within the TTL.
 */
import type pg from 'pg';
import { SyncraError } from '@syncra/shared';
import { effectivePlan, PLANS, type PlanLimits, type PlanName, type QuotaMetric } from './plans.js';
import type { UsageCounters } from './usage.js';

export interface QuotaEvent {
  type: 'quota.warning' | 'quota.exceeded';
  tenantId: string;
  metric: QuotaMetric;
  used: number;
  limit: number;
}

interface TenantUsage {
  plan: PlanName;
  active: boolean;
  limits: PlanLimits;
  ops: number;
  documents: number;
  storageBytes: number;
  expires: number;
}

export interface QuotaOptions {
  billingEnabled: boolean;
  /** How long loaded plan/usage is trusted. Plan changes call invalidate() for immediate effect. */
  ttlMs?: number;
  now?: () => number;
  onEvent?: (e: QuotaEvent) => void;
}

const monthStart = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

export class QuotaService {
  private readonly cache = new Map<string, TenantUsage>();
  private readonly fired = new Set<string>();
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(
    private readonly db: pg.Pool,
    private readonly counters: UsageCounters,
    private readonly o: QuotaOptions,
  ) {
    this.ttl = o.ttlMs ?? 10_000;
    this.now = o.now ?? Date.now;
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  private async load(tenantId: string): Promise<TenantUsage> {
    const hit = this.cache.get(tenantId);
    if (hit && hit.expires > this.now()) return hit;
    const month = monthStart(new Date(this.now()));
    const [t, g, h, pending] = await Promise.all([
      this.db.query<{ plan: PlanName; status: string }>(
        'select plan, status from tenants where id = $1',
        [tenantId],
      ),
      this.db.query<{ documents: string; storage_bytes: string }>(
        'select documents, storage_bytes from usage_gauges where tenant_id = $1',
        [tenantId],
      ),
      this.db.query<{ v: string | null }>(
        `select sum(value)::text v from usage_hourly where tenant_id = $1 and metric = 'ops' and hour >= $2`,
        [tenantId, month],
      ),
      this.counters.unflushed(tenantId, 'ops'),
    ]);
    const plan = t.rows[0]?.plan ?? 'free';
    const u: TenantUsage = {
      plan,
      active: t.rows[0]?.status === 'active',
      limits: effectivePlan(plan, this.o.billingEnabled),
      ops: Number(h.rows[0]?.v ?? 0) + pending,
      documents: Number(g.rows[0]?.documents ?? 0),
      storageBytes: Number(g.rows[0]?.storage_bytes ?? 0),
      expires: this.now() + this.ttl,
    };
    this.cache.set(tenantId, u);
    return u;
  }

  private watch(tenantId: string, metric: QuotaMetric, used: number, limit: number | null): void {
    if (limit === null) return;
    const month = monthStart(new Date(this.now())).toISOString().slice(0, 7);
    const emit = (type: QuotaEvent['type']): void => {
      const k = `${tenantId}|${metric}|${type}|${month}`;
      if (this.fired.has(k)) return;
      this.fired.add(k);
      this.o.onEvent?.({ type, tenantId, metric, used, limit });
    };
    if (used >= limit) emit('quota.exceeded');
    else if (used >= limit * 0.8) emit('quota.warning');
  }

  private block(tenantId: string, metric: QuotaMetric, used: number, limit: number): never {
    this.watch(tenantId, metric, used, limit);
    throw new SyncraError('QUOTA_EXCEEDED', `Plan limit reached: ${metric}`, { metric, limit });
  }

  /** Throws QUOTA_EXCEEDED when this write would break a plan limit. Existing data stays readable. */
  async checkWrite(
    tenantId: string,
    w: { updateBytes: number; docSizeAfter: number },
  ): Promise<void> {
    const u = await this.load(tenantId);
    if (w.docSizeAfter > u.limits.maxDocBytes)
      this.block(tenantId, 'doc_size', w.docSizeAfter, u.limits.maxDocBytes);
    if (u.limits.opsPerMonth !== null && u.ops >= u.limits.opsPerMonth) {
      this.block(tenantId, 'ops', u.ops, u.limits.opsPerMonth);
    }
    if (u.limits.storageBytes !== null && u.storageBytes + w.updateBytes > u.limits.storageBytes) {
      this.block(tenantId, 'storage', u.storageBytes, u.limits.storageBytes);
    }
    this.watch(tenantId, 'ops', u.ops + 1, u.limits.opsPerMonth);
    this.watch(tenantId, 'storage', u.storageBytes + w.updateBytes, u.limits.storageBytes);
  }

  async checkCreateDocument(tenantId: string): Promise<void> {
    const u = await this.load(tenantId);
    if (u.limits.documents !== null && u.documents >= u.limits.documents) {
      this.block(tenantId, 'documents', u.documents, u.limits.documents);
    }
    this.watch(tenantId, 'documents', u.documents + 1, u.limits.documents);
  }

  /** Called after a durable commit: bumps cached usage and meters the write. */
  async recordWrite(tenantId: string, bytes: number): Promise<void> {
    const u = this.cache.get(tenantId);
    if (u) {
      u.ops += 1;
      u.storageBytes += bytes;
    }
    await this.counters.record(tenantId, { ops: 1, bytes_written: bytes });
  }

  async recordDocumentCreated(tenantId: string): Promise<void> {
    const u = this.cache.get(tenantId);
    if (u) u.documents += 1;
    await this.counters.record(tenantId, { docs_created: 1 });
  }

  /** Reserves a connection slot, or throws QUOTA_EXCEEDED (the gateway closes with 4402). */
  async acquireConnection(tenantId: string): Promise<void> {
    const u = await this.load(tenantId);
    if (!u.active) throw new SyncraError('FORBIDDEN', 'Tenant is not active');
    const n = await this.counters.connectionOpened(tenantId);
    if (u.limits.connections !== null && n > u.limits.connections) {
      await this.counters.connectionClosed(tenantId);
      this.block(tenantId, 'connections', n - 1, u.limits.connections);
    }
  }

  releaseConnection(tenantId: string): Promise<void> {
    return this.counters.connectionClosed(tenantId);
  }

  async limitsFor(tenantId: string): Promise<PlanLimits> {
    return (await this.load(tenantId)).limits;
  }

  /** Data for GET /usage/current. */
  async snapshot(tenantId: string) {
    const u = await this.load(tenantId);
    const lim = (used: number, limit: number | null) => ({ used, limit });
    return {
      plan: u.plan,
      enforced: this.o.billingEnabled,
      quotas: {
        docs: lim(u.documents, u.limits.documents),
        storageBytes: lim(u.storageBytes, u.limits.storageBytes),
        ops: lim(u.ops, u.limits.opsPerMonth),
        connections: lim(0, u.limits.connections),
      },
    };
  }
}

export { PLANS };
