/** Usage jobs (OPS-04): move Redis counters into usage_hourly, and refresh per-tenant gauges from the shards. */
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { INDEX_COLLECTION } from '@syncra/shared';

const METRIC_COLUMN: Record<string, string> = {
  ops: 'ops',
  bytes_written: 'bytes_written',
  docs_created: 'docs_created',
};

const parseHour = (s: string): Date =>
  new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10)));

async function scanAll(redis: Redis, pattern: string): Promise<string[]> {
  const out: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    out.push(...keys);
  } while (cursor !== '0');
  return out;
}

/**
 * Flushes every `sx:usage:{tenant}:{hour}` counter into usage_hourly additively and removes it.
 * A key is first RENAMEd, so increments that arrive mid-flush land in a fresh key and are never lost
 * or double counted; leftovers from a crashed run (`sx:usagetmp:*`) are picked up next time.
 */
export async function flushUsage(
  redis: Redis,
  db: pg.Pool,
): Promise<{ keys: number; rows: number }> {
  const live = await scanAll(redis, 'sx:usage:*');
  const leftovers = await scanAll(redis, 'sx:usagetmp:*');
  let rows = 0;
  const work: { tmp: string; tenantId: string; hour: Date }[] = [];
  for (const key of live) {
    const [, , tenantId, hourStr] = key.split(':');
    if (!tenantId || !hourStr) continue;
    const tmp = `sx:usagetmp:${tenantId}:${hourStr}:${String(Date.now())}`;
    try {
      await redis.rename(key, tmp);
    } catch {
      continue; // vanished between scan and rename (expired or flushed by another worker)
    }
    work.push({ tmp, tenantId, hour: parseHour(hourStr) });
  }
  for (const tmp of leftovers) {
    const [, , tenantId, hourStr] = tmp.split(':');
    if (tenantId && hourStr) work.push({ tmp, tenantId, hour: parseHour(hourStr) });
  }
  for (const w of work) {
    const values = await redis.hgetall(w.tmp);
    for (const [metric, raw] of Object.entries(values)) {
      const column = METRIC_COLUMN[metric];
      const value = Number(raw);
      if (!column || !Number.isFinite(value) || value === 0) continue;
      await db.query(
        `insert into usage_hourly (tenant_id, hour, metric, value) values ($1,$2,$3,$4)
         on conflict (tenant_id, hour, metric) do update set value = usage_hourly.value + excluded.value`,
        [w.tenantId, w.hour, column, Math.round(value)],
      );
      rows++;
    }
    await redis.del(w.tmp); // only after the rows are durable
  }
  return { keys: work.length, rows };
}

/** Recomputes documents and storage per tenant from the shards (index documents excluded) into usage_gauges. */
export async function refreshGauges(shards: pg.Pool[], control: pg.Pool): Promise<number> {
  const totals = new Map<string, { documents: number; bytes: number }>();
  for (const shard of shards) {
    const { rows } = await shard.query<{ tenant_id: string; docs: string; bytes: string }>(
      `select tenant_id, count(*) filter (where collection <> $1)::text docs, coalesce(sum(size_bytes),0)::text bytes
       from documents where deleted_at is null group by tenant_id`,
      [INDEX_COLLECTION],
    );
    for (const r of rows) {
      const t = totals.get(r.tenant_id) ?? { documents: 0, bytes: 0 };
      t.documents += Number(r.docs);
      t.bytes += Number(r.bytes);
      totals.set(r.tenant_id, t);
    }
  }
  for (const [tenantId, t] of totals) {
    await control.query(
      `insert into usage_gauges (tenant_id, documents, storage_bytes, updated_at)
       select id, $2, $3, now() from tenants where id = $1
       on conflict (tenant_id) do update set documents = excluded.documents,
         storage_bytes = excluded.storage_bytes, updated_at = now()`,
      [tenantId, t.documents, t.bytes],
    );
  }
  return totals.size;
}
