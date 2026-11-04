import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, fetchBlobUrl } from '../api';
import { isAdmin, useAuth } from '../auth';
import { useTitle } from '../hooks';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Gauge,
  PageHeader,
  Skeleton,
  fmtBytes,
  fmtNum,
  useToast,
} from '../ui';
import type { Quotas } from './Overview';

const METRICS = [
  { id: 'ops', label: 'Operations' },
  { id: 'bytes_written', label: 'Bytes written' },
  { id: 'docs_created', label: 'Documents created' },
] as const;

interface Invoice {
  id: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  totalCents: number;
  lineItems: { description: string; amountCents: number }[];
}
const usd = (c: number): string => `$${(c / 100).toFixed(2)}`;

export function Usage() {
  useTitle('Usage & billing');
  const auth = useAuth();
  const toast = useToast();
  const [metric, setMetric] = useState<(typeof METRICS)[number]['id']>('ops');
  const [granularity, setGranularity] = useState<'hour' | 'day'>('hour');
  const tid = auth.active?.tenantId;
  const quotas = useQuery({
    queryKey: ['usage-current', tid],
    queryFn: () => api<Quotas>('GET', '/usage/current'),
  });
  const series = useQuery({
    queryKey: ['usage', tid, metric, granularity],
    queryFn: () => {
      const to = new Date();
      const from = new Date(to.getTime() - (granularity === 'hour' ? 24 : 24 * 30) * 3600 * 1000);
      return api<{ items: { at: string; value: number }[] }>(
        'GET',
        `/usage?metric=${metric}&granularity=${granularity}&from=${from.toISOString()}&to=${to.toISOString()}`,
      );
    },
  });
  const invoices = useQuery({
    queryKey: ['invoices', tid],
    queryFn: () => api<{ items: Invoice[] }>('GET', '/invoices'),
    enabled: isAdmin(auth.active?.role),
  });

  const open = (inv: Invoice, kind: 'html' | 'pdf'): void => {
    fetchBlobUrl(`/invoices/${inv.id}/${kind}`)
      .then((url) => {
        if (kind === 'html') window.open(url, '_blank', 'noopener');
        else {
          const a = document.createElement('a');
          a.href = url;
          a.download = `syncra-invoice-${inv.periodStart}.pdf`;
          a.click();
        }
      })
      .catch(() => toast('error', 'Could not load the invoice'));
  };

  return (
    <>
      <PageHeader title="Usage & billing" />
      <Card title="Plan and quota">
        {quotas.isLoading ? (
          <Skeleton />
        ) : quotas.error ? (
          <ErrorBanner error={quotas.error} retry={() => void quotas.refetch()} />
        ) : (
          quotas.data && (
            <>
              <p className="mb-3 text-muted">
                Plan: <strong>{quotas.data.plan}</strong>
                {!quotas.data.enforced && ' - limits are not enforced on this instance'}
              </p>
              <Gauge
                label="Documents"
                used={quotas.data.quotas.docs.used}
                limit={quotas.data.quotas.docs.limit}
              />
              <Gauge
                label="Operations this month"
                used={quotas.data.quotas.ops.used}
                limit={quotas.data.quotas.ops.limit}
              />
              <p>
                Storage: {fmtBytes(quotas.data.quotas.storageBytes.used)}
                {quotas.data.quotas.storageBytes.limit !== null &&
                  ` of ${fmtBytes(quotas.data.quotas.storageBytes.limit)}`}
              </p>
            </>
          )
        )}
      </Card>
      <Card
        title="Usage over time"
        actions={
          <div className="flex gap-2">
            <label className="sr-only" htmlFor="metric">
              Metric
            </label>
            <select
              id="metric"
              className="rounded-input border border-line bg-bg px-2 py-1"
              value={metric}
              onChange={(e) => setMetric(e.target.value as typeof metric)}
            >
              {METRICS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="gran">
              Granularity
            </label>
            <select
              id="gran"
              className="rounded-input border border-line bg-bg px-2 py-1"
              value={granularity}
              onChange={(e) => setGranularity(e.target.value as typeof granularity)}
            >
              <option value="hour">Last 24 hours</option>
              <option value="day">Last 30 days</option>
            </select>
          </div>
        }
      >
        {series.isLoading ? (
          <Skeleton />
        ) : series.error ? (
          <ErrorBanner error={series.error} retry={() => void series.refetch()} />
        ) : !series.data?.items.length ? (
          <EmptyState title="No usage recorded in this period. Usage is rolled up every few minutes." />
        ) : (
          <figure
            aria-label={`${metric} over time, ${fmtNum(series.data.items.reduce((n, p) => n + p.value, 0))} in total`}
          >
            <div className="h-56" aria-hidden="true">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={series.data.items.map((p) => ({
                    ...p,
                    label: new Date(p.at).toLocaleString(
                      [],
                      granularity === 'hour'
                        ? { hour: '2-digit', minute: '2-digit' }
                        : { month: 'short', day: 'numeric' },
                    ),
                  }))}
                >
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis dataKey="label" stroke="var(--text-muted)" />
                  <YAxis width={56} stroke="var(--text-muted)" />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke="var(--primary)"
                    fill="var(--primary)"
                    fillOpacity={0.2}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </figure>
        )}
      </Card>
      <Card title="Invoices">
        {!isAdmin(auth.active?.role) ? (
          <p className="text-muted">Invoices are visible to owners and admins.</p>
        ) : invoices.isLoading ? (
          <Skeleton />
        ) : invoices.error ? (
          <ErrorBanner error={invoices.error} retry={() => void invoices.refetch()} />
        ) : !invoices.data?.items.length ? (
          <EmptyState title="No invoices yet. They are generated on the first day of each month (billing must be enabled)." />
        ) : (
          <table className="responsive w-full text-left">
            <thead>
              <tr className="text-muted">
                <th scope="col" className="p-2">
                  Period
                </th>
                <th scope="col" className="p-2">
                  Status
                </th>
                <th scope="col" className="p-2">
                  Total
                </th>
                <th scope="col" className="p-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {invoices.data.items.map((i) => (
                <tr key={i.id} className="border-t border-line">
                  <td data-label="Period" className="p-2">
                    {i.periodStart} to {i.periodEnd}
                  </td>
                  <td data-label="Status" className="p-2">
                    {i.status}
                  </td>
                  <td data-label="Total" className="p-2">
                    {usd(i.totalCents)}
                  </td>
                  <td className="p-2 text-right">
                    <Button
                      variant="secondary"
                      className="mr-2"
                      aria-label={`View invoice ${i.periodStart}`}
                      onClick={() => open(i, 'html')}
                    >
                      View
                    </Button>
                    <Button
                      variant="secondary"
                      aria-label={`Download PDF ${i.periodStart}`}
                      onClick={() => open(i, 'pdf')}
                    >
                      PDF
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
