/** Monthly invoice generation (BIL-02): idempotent per (tenant, month) thanks to the table's unique key. */
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import type { PlanName } from '../limits/plans.js';
import { calculateInvoice, isoDate, monthBounds } from './invoice.js';

/** Start of the month before `now` (UTC). */
export const previousMonth = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

/**
 * Creates the invoice for `periodStart`'s month for every non-selfhost, non-deleted tenant that existed
 * during it. Re-running creates nothing new. Returns the number of invoices created.
 */
export async function generateInvoices(control: pg.Pool, periodStart: Date): Promise<number> {
  const { start, end } = monthBounds(periodStart);
  const tenants = await control.query<{
    id: string;
    plan: PlanName;
    created_at: Date;
    storage: string | null;
  }>(
    `select t.id, t.plan, t.created_at, g.storage_bytes::text storage
     from tenants t left join usage_gauges g on g.tenant_id = t.id
     where t.status <> 'deleted' and t.plan <> 'selfhost' and t.created_at < $1`,
    [end],
  );
  let created = 0;
  for (const t of tenants.rows) {
    const ops = await control.query<{ v: string | null }>(
      `select sum(value)::text v from usage_hourly where tenant_id = $1 and metric = 'ops' and hour >= $2 and hour < $3`,
      [t.id, start, end],
    );
    const inv = calculateInvoice({
      plan: t.plan,
      periodStart: start,
      tenantCreatedAt: t.created_at,
      opsUsed: Number(ops.rows[0]?.v ?? 0),
      storageBytes: Number(t.storage ?? 0),
    });
    const r = await control.query(
      `insert into invoices (id, tenant_id, period_start, period_end, status, line_items, subtotal_cents, total_cents)
       values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (tenant_id, period_start) do nothing`,
      [
        uuidv7(),
        t.id,
        isoDate(start),
        inv.periodEnd,
        inv.totalCents === 0 ? 'paid' : 'open',
        JSON.stringify(inv.lineItems),
        inv.subtotalCents,
        inv.totalCents,
      ],
    );
    created += r.rowCount ?? 0;
  }
  return created;
}
