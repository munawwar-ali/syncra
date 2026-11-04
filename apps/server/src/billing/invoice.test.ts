import { describe, expect, it } from 'vitest';
import { calculateInvoice, invoiceHtml, monthBounds, usd, type InvoiceInput } from './invoice.js';
import { textPdf } from './pdf.js';

const march = new Date(Date.UTC(2026, 2, 1)); // 31 days
const old = new Date(Date.UTC(2025, 0, 1));
const input = (over: Partial<InvoiceInput> = {}): InvoiceInput => ({
  plan: 'pro',
  periodStart: march,
  tenantCreatedAt: old,
  opsUsed: 0,
  storageBytes: 0,
  ...over,
});
const total = (over: Partial<InvoiceInput>) => calculateInvoice(input(over)).totalCents;

describe('invoice calculator (BIL-02, A5-3)', () => {
  it('charges the plan base fee only for zero usage', () => {
    const inv = calculateInvoice(input());
    expect(inv.lineItems.map((l) => l.kind)).toEqual(['base']);
    expect(inv.totalCents).toBe(2900);
    expect(total({ plan: 'business' })).toBe(14900);
    expect(inv.periodStart).toBe('2026-03-01');
    expect(inv.periodEnd).toBe('2026-03-31');
  });

  it('bills operations over the allowance at 40 cents per million, pro rata, and nothing at the limit', () => {
    expect(total({ opsUsed: 50_000_000 })).toBe(2900); // exactly at the allowance
    expect(total({ opsUsed: 51_000_000 })).toBe(2900 + 40);
    expect(total({ opsUsed: 50_000_000 + 2_500_000 })).toBe(2900 + 100); // 2.5M extra -> 100 cents
    expect(total({ opsUsed: 50_000_000 + 1 })).toBe(2900); // rounds to the nearest cent: 0 cents
    expect(total({ opsUsed: 50_000_000 + 12_500 })).toBe(2900 + 1); // 0.5 cent rounds up
  });

  it('bills storage over the allowance at 25 cents per GB', () => {
    const GB = 1024 ** 3;
    expect(total({ storageBytes: 10 * GB })).toBe(2900);
    const inv = calculateInvoice(input({ storageBytes: 14 * GB }));
    const storage = inv.lineItems.find((l) => l.kind === 'overage_storage');
    expect(storage).toMatchObject({ quantity: 4, unit: 'GB', amountCents: 100 });
    expect(inv.totalCents).toBe(3000);
  });

  it('prorates the base fee for a tenant created mid-month (partial months)', () => {
    const created = (day: number) => new Date(Date.UTC(2026, 2, day, 15, 30));
    expect(total({ tenantCreatedAt: created(1) })).toBe(2900);
    // created on the 16th: days 16..31 = 16 of 31 days
    expect(total({ tenantCreatedAt: created(16) })).toBe(Math.round((2900 * 16) / 31));
    expect(
      calculateInvoice(input({ tenantCreatedAt: created(16) })).lineItems[0]?.description,
    ).toContain('16 of 31 days');
    expect(total({ tenantCreatedAt: created(31) })).toBe(Math.round(2900 / 31));
    expect(total({ tenantCreatedAt: new Date(Date.UTC(2026, 3, 2)) })).toBe(0); // created after the month
    // overage is not prorated, only the base fee
    expect(total({ tenantCreatedAt: created(16), opsUsed: 52_000_000 })).toBe(
      Math.round((2900 * 16) / 31) + 80,
    );
  });

  it('free is hard-capped (no overage) and selfhost is not billed', () => {
    expect(total({ plan: 'free', opsUsed: 9_999_999_999 })).toBe(0);
    expect(calculateInvoice(input({ plan: 'free' })).lineItems[0]?.amountCents).toBe(0);
    const self = calculateInvoice(input({ plan: 'selfhost', opsUsed: 9e12, storageBytes: 9e15 }));
    expect(self.lineItems).toEqual([]);
    expect(self.totalCents).toBe(0);
  });

  it('is deterministic and handles month lengths (February, leap year)', () => {
    expect(JSON.stringify(calculateInvoice(input()))).toBe(
      JSON.stringify(calculateInvoice(input())),
    );
    expect(monthBounds(new Date(Date.UTC(2028, 1, 10))).days).toBe(29);
    expect(monthBounds(new Date(Date.UTC(2027, 1, 10))).days).toBe(28);
    expect(monthBounds(new Date(Date.UTC(2026, 11, 31))).days).toBe(31);
    expect(usd(2905)).toBe('$29.05');
  });
});

describe('invoice HTML and PDF (BIL-03)', () => {
  const inv = {
    ...calculateInvoice(input({ opsUsed: 53_000_000 })),
    id: 'i1',
    tenantName: 'Acme <script>',
    status: 'open',
  };

  it('renders totals and escapes tenant-controlled text', () => {
    const html = invoiceHtml(inv);
    expect(html).toContain('$30.20'); // 29.00 + 3M extra * 40c/M = 1.20
    expect(html).toContain('Acme &lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('produces a structurally valid PDF whose text matches the totals', () => {
    const pdf = textPdf('Syncra invoice', ['Total: $30.20 (simulated)', 'a (b) \\ c']).toString(
      'latin1',
    );
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdf).toContain('(Total: $30.20 \\(simulated\\)) Tj');
    expect(pdf).toContain('(a \\(b\\) \\\\ c) Tj');
    // every xref offset points at "N 0 obj"
    const xrefAt = pdf.lastIndexOf('\nxref\n') + 1; // not the "xref" inside "startxref"
    const xref = pdf.slice(xrefAt);
    const offsets = [...xref.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((o, i) => {
      expect(pdf.slice(o).startsWith(`${String(i + 1)} 0 obj`)).toBe(true);
    });
    expect(Number(/startxref\n(\d+)/.exec(pdf)?.[1])).toBe(xrefAt);
  });
});
