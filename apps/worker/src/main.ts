/**
 * Worker entry point: runs the scheduled jobs (usage flush, gauge refresh, webhook delivery) and
 * serves /healthz and /metrics on WORKER_PORT. See ADR 0020 for why this is a timer loop with Redis
 * locks and not BullMQ yet.
 */
import http from 'node:http';
import { Redis } from 'ioredis';
import pg from 'pg';
import { pino } from 'pino';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';
import {
  WebhookDispatcher,
  effectivePlan,
  flushUsage,
  generateInvoices,
  loadConfig,
  maintainShard,
  previousMonth,
  purgeDeleted,
  refreshGauges,
} from '@syncra/server/jobs';

const cfg = loadConfig();
const log = pino({ level: cfg.LOG_LEVEL, base: { nodeId: cfg.NODE_ID, role: 'worker' } });
const control = new pg.Pool({ connectionString: cfg.CONTROL_DATABASE_URL, max: 5 });
const shards = cfg.SHARD_DATABASE_URLS.map((u) => new pg.Pool({ connectionString: u, max: 5 }));
const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 2 });
redis.on('error', () => undefined);

const registry = new Registry();
collectDefaultMetrics({ register: registry });
const rowsDeleted = new Counter({
  name: 'syncra_compaction_rows_deleted_total',
  help: 'Op rows deleted by compaction',
  registers: [registry],
});
const bytesReclaimed = new Counter({
  name: 'syncra_compaction_bytes_reclaimed_total',
  help: 'Bytes reclaimed by compaction',
  registers: [registry],
});
const verifyFailures = new Counter({
  name: 'syncra_compaction_verify_failures_total',
  help: 'Compactions aborted by the safety check',
  registers: [registry],
});
const runs = new Counter({
  name: 'syncra_job_runs_total',
  help: 'Job runs',
  labelNames: ['job', 'status'] as const,
  registers: [registry],
});

const dispatcher = new WebhookDispatcher(control, {
  encryptionKey: Buffer.from(cfg.ENCRYPTION_KEY, 'base64'),
  allowPrivate: cfg.WEBHOOK_ALLOW_PRIVATE,
});

/** History window for a tenant's plan (7/30/90 days); selfhost when billing is off. Cached for a minute. */
const retentionCache = new Map<string, { days: number; expires: number }>();
async function retentionDays(tenantId: string): Promise<number> {
  const hit = retentionCache.get(tenantId);
  if (hit && hit.expires > Date.now()) return hit.days;
  const { rows } = await control.query<{ plan: 'free' | 'pro' | 'business' | 'selfhost' }>(
    'select plan from tenants where id = $1',
    [tenantId],
  );
  const days = effectivePlan(rows[0]?.plan ?? 'free', cfg.BILLING_ENABLED).historyDays;
  retentionCache.set(tenantId, { days, expires: Date.now() + 60_000 });
  return days;
}

/** Runs `fn` every `everyMs`, but only on the worker that wins the Redis lock, so replicas never double-run. */
function schedule(name: string, everyMs: number, fn: () => Promise<unknown>): NodeJS.Timeout {
  const tick = async (): Promise<void> => {
    try {
      const got = await redis.set(
        `sx:lock:job:${name}`,
        cfg.NODE_ID,
        'PX',
        Math.max(1000, everyMs - 500),
        'NX',
      );
      if (got !== 'OK') return;
      await fn();
      runs.labels(name, 'ok').inc();
    } catch (err) {
      runs.labels(name, 'error').inc();
      log.error({ err, job: name }, 'job failed');
    }
  };
  void tick();
  return setInterval(() => void tick(), everyMs);
}

// Backlog gauges for the alert rules (Doc 02 §14.2). Webhook deliveries are the only job queue stored
// as rows, so their backlog is the `syncra_queue_depth{queue="webhooks"}` value.
new Gauge({
  name: 'syncra_queue_depth',
  help: 'Jobs waiting to run',
  labelNames: ['queue'] as const,
  registers: [registry],
  async collect() {
    const { rows } = await control.query<{ n: string }>(
      "select count(*)::text n from webhook_deliveries where status in ('pending','retrying')",
    );
    this.set({ queue: 'webhooks' }, Number(rows[0]?.n ?? 0));
  },
});
new Gauge({
  name: 'syncra_ops_since_snapshot_max',
  help: 'Largest number of ops after the latest snapshot of any document',
  labelNames: ['shard'] as const,
  registers: [registry],
  async collect() {
    for (const [i, shard] of shards.entries()) {
      const { rows } = await shard.query<{ n: string | null }>(
        'select max(head_seq - snapshot_seq)::text n from documents where deleted_at is null',
      );
      this.set({ shard: String(i) }, Number(rows[0]?.n ?? 0));
    }
  },
});

const timers = [
  schedule('webhook:deliver', 2_000, () => dispatcher.runDue()),
  schedule('usage:flush', 10 * 60_000, () => flushUsage(redis, control)),
  schedule('usage:gauges', 60_000, () => refreshGauges(shards, control)),
  schedule('doc:maintain', 15_000, async () => {
    for (const shard of shards) {
      const s = await maintainShard(shard, redis, {
        everyOps: cfg.SNAPSHOT_EVERY_OPS,
        everyBytes: cfg.SNAPSHOT_EVERY_BYTES,
        idleMs: cfg.SNAPSHOT_IDLE_MS,
        checkpointMs: cfg.CHECKPOINT_INTERVAL_MS,
        retentionDays,
      });
      rowsDeleted.inc(s.rowsDeleted);
      bytesReclaimed.inc(s.bytesReclaimed);
      verifyFailures.inc(s.verifyFailures);
    }
  }),
  // Checked hourly; on day 1 after 00:10 UTC it bills the month that just ended. Re-running is harmless (unique per tenant and month).
  schedule('billing:invoice', 3_600_000, async () => {
    const now = new Date();
    if (
      !cfg.BILLING_ENABLED ||
      now.getUTCDate() !== 1 ||
      now.getUTCHours() * 60 + now.getUTCMinutes() < 10
    )
      return;
    await generateInvoices(control, previousMonth(now));
  }),
  schedule('doc:purge', 3_600_000, () => {
    const week = new Date(Date.now() - 7 * 86_400_000);
    return purgeDeleted(shards, week, week);
  }),
];

const health = http.createServer((req, res) => {
  if (req.url === '/metrics') {
    void registry.metrics().then((m) => {
      res.setHeader('content-type', registry.contentType);
      res.end(m);
    });
  } else if (req.url === '/healthz') {
    res.end('{"status":"ok"}');
  } else {
    res.statusCode = 404;
    res.end();
  }
});
health.listen(Number(process.env.WORKER_PORT ?? 9100), '0.0.0.0');
log.info('worker started');

const shutdown = async (): Promise<void> => {
  timers.forEach(clearInterval);
  health.close();
  await flushUsage(redis, control).catch(() => undefined); // do not leave counters behind on a clean stop
  await Promise.all([control.end(), ...shards.map((s) => s.end()), redis.quit()]);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
