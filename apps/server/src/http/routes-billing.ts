/** Invoices (Doc 03 §4.6): JSON, a printable HTML view and a PDF. Owners and admins only. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SyncraError, paginationSchema } from '@syncra/shared';
import { invoiceHtml, usd, type InvoiceView, type LineItem } from '../billing/invoice.js';
import { textPdf } from '../billing/pdf.js';
import { requireCan } from '../control/roles.js';
import type { Services } from '../services.js';
import { authDashboard, parse } from './auth.js';

interface Row {
  id: string;
  period_start: Date;
  period_end: Date;
  status: string;
  line_items: LineItem[];
  subtotal_cents: number;
  total_cents: number;
  created_at: Date;
  name: string;
  plan: string;
}

const day = (d: Date): string => d.toISOString().slice(0, 10);

export function registerBillingRoutes(app: FastifyInstance, s: Services): void {
  const q = `select i.*, t.name, t.plan from invoices i join tenants t on t.id = i.tenant_id where i.tenant_id = $1`;
  const toDto = (r: Row) => ({
    id: r.id,
    periodStart: day(r.period_start),
    periodEnd: day(r.period_end),
    status: r.status,
    lineItems: r.line_items,
    subtotalCents: r.subtotal_cents,
    totalCents: r.total_cents,
    createdAt: r.created_at.toISOString(),
  });
  const load = async (tenantId: string, id: string): Promise<Row> => {
    const { rows } = await s.deps.control.query<Row>(`${q} and i.id = $2`, [tenantId, id]);
    if (!rows[0]) throw new SyncraError('NOT_FOUND', 'Invoice not found');
    return rows[0];
  };
  const idParam = z.object({ id: z.string().uuid() });

  app.get('/invoices', async (req) => {
    const p = await authDashboard(s, req);
    requireCan(p.role, 'audit.read');
    const { limit } = parse(paginationSchema.pick({ limit: true }), req.query);
    const { rows } = await s.deps.control.query<Row>(`${q} order by i.period_start desc limit $2`, [
      p.tenantId,
      limit,
    ]);
    return { items: rows.map(toDto) };
  });

  app.get('/invoices/:id', async (req) => {
    const p = await authDashboard(s, req);
    requireCan(p.role, 'audit.read');
    return toDto(await load(p.tenantId, parse(idParam, req.params).id));
  });

  const view = (r: Row): InvoiceView => ({
    id: r.id,
    tenantName: r.name,
    status: r.status,
    periodStart: day(r.period_start),
    periodEnd: day(r.period_end),
    plan: r.plan as InvoiceView['plan'],
    lineItems: r.line_items,
    subtotalCents: r.subtotal_cents,
    totalCents: r.total_cents,
  });

  app.get('/invoices/:id/html', async (req, reply) => {
    const p = await authDashboard(s, req);
    requireCan(p.role, 'audit.read');
    const r = await load(p.tenantId, parse(idParam, req.params).id);
    // The page has no scripts; the CSP below makes sure even tenant-controlled text could not run any.
    return reply
      .type('text/html; charset=utf-8')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
      .send(invoiceHtml(view(r)));
  });

  app.get('/invoices/:id/pdf', async (req, reply) => {
    const p = await authDashboard(s, req);
    requireCan(p.role, 'audit.read');
    const r = await load(p.tenantId, parse(idParam, req.params).id);
    const lines = [
      `${r.name} - ${day(r.period_start)} to ${day(r.period_end)} - ${r.status}`,
      '',
      ...r.line_items.map(
        (l) =>
          `${l.description}: ${l.quantity.toLocaleString('en-US')} ${l.unit} = ${usd(l.amountCents)}`,
      ),
      '',
      `Total (USD, simulated): ${usd(r.total_cents)}`,
    ];
    return reply
      .type('application/pdf')
      .header(
        'content-disposition',
        `attachment; filename="syncra-invoice-${day(r.period_start)}.pdf"`,
      )
      .send(textPdf('Syncra invoice', lines));
  });
}
