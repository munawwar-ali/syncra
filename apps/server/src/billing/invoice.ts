/**
 * Invoice calculation (BIL-02, Doc 01 §5). Pure and deterministic: the same inputs always give the
 * same line items, in integer cents. Billing is simulated; nothing here talks to a payment provider.
 */
import { PLANS, type PlanName } from '../limits/plans.js';

const GB = 1024 ** 3;

export interface InvoiceInput {
  plan: PlanName;
  /** First day of the billed month (UTC). */
  periodStart: Date;
  /** When the tenant was created; a tenant created mid-month pays a prorated base fee. */
  tenantCreatedAt: Date;
  opsUsed: number;
  /** Stored bytes at the end of the period. */
  storageBytes: number;
}

export interface LineItem {
  kind: 'base' | 'overage_ops' | 'overage_storage';
  description: string;
  quantity: number;
  unit: string;
  amountCents: number;
}

export interface Invoice {
  periodStart: string;
  periodEnd: string;
  plan: PlanName;
  lineItems: LineItem[];
  subtotalCents: number;
  totalCents: number;
}

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export function monthBounds(periodStart: Date): { start: Date; end: Date; days: number } {
  const start = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { start, end, days: Math.round((end.getTime() - start.getTime()) / 86_400_000) };
}

/** Integer division rounding half up, for non-negative numbers. */
const roundDiv = (num: number, den: number): number => Math.floor((num * 2 + den) / (den * 2));

/**
 * Rules:
 *  - base fee is prorated by the days the tenant existed in the month (whole days, creation day counts);
 *  - ops over the plan allowance cost 40 cents per 1,000,000, pro rata, rounded to the nearest cent;
 *  - storage over the plan allowance costs 25 cents per GB, pro rata, rounded to the nearest cent;
 *  - the free plan is hard-capped, so it never has overage; selfhost is not billed at all.
 * shortcut: storage overage uses the end-of-period size, not a time average, and the plan is the one
 * active when the invoice is generated; upgrade when plan history or hourly storage gauges are kept.
 */
export function calculateInvoice(i: InvoiceInput): Invoice {
  const { start, end, days } = monthBounds(i.periodStart);
  const plan = PLANS[i.plan];
  const items: LineItem[] = [];

  if (i.plan !== 'selfhost') {
    const created = Date.UTC(
      i.tenantCreatedAt.getUTCFullYear(),
      i.tenantCreatedAt.getUTCMonth(),
      i.tenantCreatedAt.getUTCDate(),
    );
    const activeDays =
      created >= end.getTime()
        ? 0
        : created <= start.getTime()
          ? days
          : Math.round((end.getTime() - created) / 86_400_000);
    const base = roundDiv(plan.baseCents * activeDays, days);
    items.push({
      kind: 'base',
      description:
        activeDays === days
          ? `${i.plan} plan`
          : `${i.plan} plan (${String(activeDays)} of ${String(days)} days)`,
      quantity: 1,
      unit: 'month',
      amountCents: base,
    });
  }

  if (plan.overage && plan.opsPerMonth !== null && i.opsUsed > plan.opsPerMonth) {
    const extra = i.opsUsed - plan.opsPerMonth;
    items.push({
      kind: 'overage_ops',
      description: 'Operations over plan allowance',
      quantity: extra,
      unit: 'ops',
      amountCents: roundDiv(extra * plan.overage.perMillionOpsCents, 1_000_000),
    });
  }
  if (plan.overage && plan.storageBytes !== null && i.storageBytes > plan.storageBytes) {
    const extra = i.storageBytes - plan.storageBytes;
    items.push({
      kind: 'overage_storage',
      description: 'Storage over plan allowance',
      quantity: Math.round((extra / GB) * 1000) / 1000,
      unit: 'GB',
      amountCents: roundDiv(extra * plan.overage.perGbStorageCents, GB),
    });
  }

  const subtotal = items.reduce((n, x) => n + x.amountCents, 0);
  return {
    periodStart: isoDate(start),
    periodEnd: isoDate(new Date(end.getTime() - 86_400_000)),
    plan: i.plan,
    lineItems: items,
    subtotalCents: subtotal,
    totalCents: subtotal,
  };
}

export const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

export interface InvoiceView extends Invoice {
  id: string;
  tenantName: string;
  status: string;
}

/** Self-contained HTML (no scripts, no external resources) for the dashboard view and printing. */
export function invoiceHtml(v: InvoiceView): string {
  const rows = v.lineItems
    .map(
      (l) =>
        `<tr><td>${esc(l.description)}</td><td class="n">${l.quantity.toLocaleString('en-US')} ${esc(l.unit)}</td><td class="n">${usd(l.amountCents)}</td></tr>`,
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invoice ${esc(v.periodStart)}</title>
<style>body{font:14px system-ui,sans-serif;margin:2rem;color:#0f172a}table{border-collapse:collapse;width:100%;margin-top:1rem}
th,td{padding:.5rem;border-bottom:1px solid #dde2ef;text-align:left}.n{text-align:right}tfoot td{font-weight:600}</style></head><body>
<h1>Syncra invoice</h1><p>${esc(v.tenantName)} &middot; ${esc(v.periodStart)} to ${esc(v.periodEnd)} &middot; status: ${esc(v.status)}</p>
<table><thead><tr><th>Item</th><th class="n">Quantity</th><th class="n">Amount</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td colspan="2">Total (USD, simulated)</td><td class="n">${usd(v.totalCents)}</td></tr></tfoot></table></body></html>`;
}
