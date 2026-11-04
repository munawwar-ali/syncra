import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../api';
import { useAuth } from '../auth';
import { useEventStream, useTitle } from '../hooks';
import { Card, EmptyState, PageHeader, Skeleton, fmtNum } from '../ui';
import { Kpi, Series, type Tick } from './Overview';

interface Node {
  nodeId: string;
  connections: number;
  hotDocs: number;
  startedAt: number;
  heartbeatAgeMs: number;
}

export function Monitor() {
  useTitle('Live monitor');
  const auth = useAuth();
  const { points, connected } = useEventStream<Tick>('/monitor/stream');
  const last = points.at(-1);
  // Node details need operator rights (self-hosted, owner or admin); other tenants only see their own traffic.
  const nodes = useQuery({
    queryKey: ['nodes', auth.active?.tenantId],
    queryFn: () => api<{ items: Node[] }>('GET', '/monitor/nodes'),
    refetchInterval: 3000,
    retry: false,
  });

  return (
    <>
      <PageHeader title="Live monitor">
        <span role="status" className="text-muted">
          {connected ? 'Live, updating every second' : 'Reconnecting...'}
        </span>
      </PageHeader>
      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Kpi label="Your connections" value={last ? String(last.connections) : '-'} />
        <Kpi label="Your ops per second" value={last ? String(last.opsPerSec) : '-'} />
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
      <Card title="Nodes">
        {nodes.isLoading ? (
          <Skeleton />
        ) : nodes.error ? (
          <p className="text-muted">
            Node details are available to owners and admins of self-hosted installations.
          </p>
        ) : nodes.data && nodes.data.items.length > 0 ? (
          <>
            <ul className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Nodes">
              {nodes.data.items.map((n) => (
                <li
                  key={n.nodeId}
                  data-testid="node-card"
                  className="rounded-card border border-line bg-bg p-3"
                >
                  <p className="font-mono font-semibold">{n.nodeId}</p>
                  <p>{fmtNum(n.connections)} connections</p>
                  <p>{fmtNum(n.hotDocs)} hot documents</p>
                  <p className={n.heartbeatAgeMs > 10_000 ? 'text-warning' : 'text-muted'}>
                    heartbeat {(n.heartbeatAgeMs / 1000).toFixed(0)} s ago
                  </p>
                </li>
              ))}
            </ul>
            <figure aria-label="Connections per node">
              <figcaption className="mb-2 font-medium">Connections per node</figcaption>
              <div className="h-44" aria-hidden="true">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={nodes.data.items}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                    <XAxis dataKey="nodeId" stroke="var(--text-muted)" />
                    <YAxis width={40} allowDecimals={false} stroke="var(--text-muted)" />
                    <Tooltip
                      contentStyle={{ background: 'var(--bg)', border: '1px solid var(--border)' }}
                    />
                    <Bar dataKey="connections" fill="var(--primary)" isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </figure>
          </>
        ) : (
          <EmptyState title="No nodes have reported a heartbeat yet." />
        )}
      </Card>
    </>
  );
}
