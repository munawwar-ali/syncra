import { useQuery } from '@tanstack/react-query';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api';
import { isAdmin, useAuth } from '../auth';
import { useEventStream, useTitle } from '../hooks';
import { Card, ErrorBanner, Gauge, PageHeader, Skeleton, fmtBytes, fmtNum, fmtTime } from '../ui';

export interface Tick {
  at: number;
  opsPerSec: number;
  connections: number;
  ackP95Ms: number;
  system?: { opsPerSec: number; connections: number; hotDocs: number };
}

export interface Quotas {
  plan: string;
  enforced: boolean;
  quotas: {
    docs: { used: number; limit: number | null };
    storageBytes: { used: number; limit: number | null };
    ops: { used: number; limit: number | null };
    connections: { used: number; limit: number | null };
  };
}

export function Kpi({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <p className="text-muted">{label}</p>
      <p
        className="mt-1 text-2xl font-semibold"
        data-testid={`kpi-${label.toLowerCase().replace(/\W+/g, '-')}`}
      >
        {value}
        {unit && <span className="ml-1 text-sm font-normal text-muted">{unit}</span>}
      </p>
    </div>
  );
}

/** A line chart with a text alternative: screen readers get the latest value instead of the SVG. */
export function Series({
  title,
  data,
  dataKey,
  color,
  unit,
}: {
  title: string;
  data: Tick[];
  dataKey: keyof Tick;
  color: string;
  unit: string;
}) {
  const last = data.at(-1)?.[dataKey];
  return (
    <figure
      className="mb-0"
      aria-label={`${title}: latest ${typeof last === 'number' ? String(last) : 'no data'} ${unit}`}
    >
      <figcaption className="mb-2 font-medium">{title}</figcaption>
      <div className="h-44" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data.map((d, i) => ({ ...d, i }))}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis dataKey="i" hide />
            <YAxis width={40} stroke="var(--text-muted)" />
            <Tooltip
              contentStyle={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
            />
            <Line
              type="monotone"
              dataKey={dataKey as string}
              stroke={color}
              dot={false}
              isAnimationActive={false}
              strokeWidth={2}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

export function Overview() {
  useTitle('Overview');
  const auth = useAuth();
  const { points, connected } = useEventStream<Tick>('/monitor/stream');
  const q = useQuery({
    queryKey: ['usage-current', auth.active?.tenantId],
    queryFn: () => api<Quotas>('GET', '/usage/current'),
  });
  const audit = useQuery({
    queryKey: ['audit-recent', auth.active?.tenantId],
    queryFn: () =>
      api<{ items: { id: number; action: string; actorType: string; createdAt: string }[] }>(
        'GET',
        '/audit?limit=5',
      ),
    enabled: isAdmin(auth.active?.role),
  });
  const last = points.at(-1);

  return (
    <>
      <PageHeader title="Overview">
        <span className="text-muted" role="status">
          {connected ? 'Live' : 'Reconnecting...'}
        </span>
      </PageHeader>
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Operations per second" value={last ? String(last.opsPerSec) : '-'} />
        <Kpi label="Connections" value={last ? String(last.connections) : '-'} />
        <Kpi
          label="Active documents"
          value={
            last?.system
              ? fmtNum(last.system.hotDocs)
              : q.data
                ? fmtNum(q.data.quotas.docs.used)
                : '-'
          }
        />
        <Kpi label="Ack p95" value={last ? String(last.ackP95Ms) : '-'} unit="ms" />
      </div>
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <Series
            title="Operations per second"
            data={points}
            dataKey="opsPerSec"
            color="var(--primary)"
            unit="ops/s"
          />
        </Card>
        <Card>
          <Series
            title="Ack latency p95 (ms)"
            data={points}
            dataKey="ackP95Ms"
            color="var(--success)"
            unit="ms"
          />
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Quota">
          {q.isLoading ? (
            <Skeleton />
          ) : q.error ? (
            <ErrorBanner error={q.error} retry={() => void q.refetch()} />
          ) : (
            q.data && (
              <>
                <p className="mb-3 text-muted">
                  Plan: <strong data-testid="plan">{q.data.plan}</strong>
                  {!q.data.enforced && ' (limits are not enforced on this instance)'}
                </p>
                <Gauge
                  label="Documents"
                  used={q.data.quotas.docs.used}
                  limit={q.data.quotas.docs.limit}
                />
                <Gauge
                  label="Operations this month"
                  used={q.data.quotas.ops.used}
                  limit={q.data.quotas.ops.limit}
                />
                <p className="mb-1">
                  Storage: {fmtBytes(q.data.quotas.storageBytes.used)}
                  {q.data.quotas.storageBytes.limit !== null &&
                    ` of ${fmtBytes(q.data.quotas.storageBytes.limit)}`}
                </p>
              </>
            )
          )}
        </Card>
        <Card title="Recent activity">
          {!isAdmin(auth.active?.role) ? (
            <p className="text-muted">Activity is visible to owners and admins.</p>
          ) : audit.isLoading ? (
            <Skeleton />
          ) : audit.data?.items.length ? (
            <ul>
              {audit.data.items.map((a) => (
                <li
                  key={a.id}
                  className="flex justify-between border-b border-line py-1 last:border-0"
                >
                  <span>{a.action}</span>
                  <span className="text-muted">{fmtTime(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">Nothing yet.</p>
          )}
        </Card>
      </div>
    </>
  );
}
