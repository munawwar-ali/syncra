import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { canWrite, useAuth } from '../auth';
import { useTitle } from '../hooks';
import {
  Button,
  Card,
  Confirm,
  EmptyState,
  ErrorBanner,
  Field,
  Modal,
  PageHeader,
  SecretModal,
  Skeleton,
  errorMessage,
  fmtTime,
  useToast,
} from '../ui';

const EVENTS = [
  'document.created',
  'document.updated',
  'document.deleted',
  'quota.warning',
  'quota.exceeded',
] as const;

interface Endpoint {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
}
interface Delivery {
  id: string;
  eventType: string;
  status: 'pending' | 'success' | 'retrying' | 'dead';
  attempt: number;
  responseCode: number | null;
  error: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
}

export function Webhooks() {
  useTitle('Webhooks');
  const auth = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const writable = canWrite(auth.active?.role);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['document.created', 'document.updated']);
  const [err, setErr] = useState<string>();
  const [secret, setSecret] = useState<string | null>(null);
  const [log, setLog] = useState<Endpoint | null>(null);
  const [remove, setRemove] = useState<Endpoint | null>(null);
  const q = useQuery({
    queryKey: ['webhooks', auth.active?.tenantId],
    queryFn: () => api<{ items: Endpoint[] }>('GET', '/webhooks'),
  });
  const create = useMutation({
    mutationFn: () => api<Endpoint & { secret: string }>('POST', '/webhooks', { url, events }),
    onSuccess: (r) => {
      setAdding(false);
      setUrl('');
      setSecret(r.secret);
      void qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
    onError: (e) => setErr(errorMessage(e)),
  });
  const test = useMutation({
    mutationFn: (id: string) => api('POST', `/webhooks/${id}/test`),
    onSuccess: () => toast('ok', 'Test event queued'),
    onError: (e) => toast('error', errorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: (e: Endpoint) => api('PATCH', `/webhooks/${e.id}`, { enabled: !e.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
    onError: (e) => toast('error', errorMessage(e)),
  });

  return (
    <>
      <PageHeader title="Webhooks">
        {writable && (
          <Button
            onClick={() => {
              setErr(undefined);
              setAdding(true);
            }}
          >
            Add endpoint
          </Button>
        )}
      </PageHeader>
      {q.isLoading ? (
        <Skeleton />
      ) : q.error ? (
        <ErrorBanner error={q.error} retry={() => void q.refetch()} />
      ) : !q.data?.items.length ? (
        <EmptyState title="No webhook endpoints. Add one to receive document and quota events." />
      ) : (
        <Card>
          <table className="responsive w-full text-left">
            <thead>
              <tr className="text-muted">
                <th scope="col" className="p-2">
                  URL
                </th>
                <th scope="col" className="p-2">
                  Events
                </th>
                <th scope="col" className="p-2">
                  Status
                </th>
                <th scope="col" className="p-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((e) => (
                <tr key={e.id} className="border-t border-line">
                  <td data-label="URL" className="break-all p-2 font-mono">
                    {e.url}
                  </td>
                  <td data-label="Events" className="p-2">
                    {e.events.join(', ')}
                  </td>
                  <td data-label="Status" className="p-2">
                    {e.enabled ? 'Enabled' : 'Disabled'}
                  </td>
                  <td className="p-2 text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        variant="secondary"
                        onClick={() => setLog(e)}
                        aria-label={`Deliveries for ${e.url}`}
                      >
                        Deliveries
                      </Button>
                      {writable && (
                        <>
                          <Button
                            variant="secondary"
                            onClick={() => test.mutate(e.id)}
                            aria-label={`Send test event to ${e.url}`}
                          >
                            Test
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() => toggle.mutate(e)}
                            aria-label={`${e.enabled ? 'Disable' : 'Enable'} ${e.url}`}
                          >
                            {e.enabled ? 'Disable' : 'Enable'}
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() => setRemove(e)}
                            aria-label={`Delete ${e.url}`}
                          >
                            Delete
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {adding && (
        <Modal title="Add webhook endpoint" onClose={() => setAdding(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setErr(undefined);
              create.mutate();
            }}
          >
            <Field
              label="Endpoint URL"
              type="url"
              placeholder="https://example.com/hooks/syncra"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
            <fieldset className="mb-4">
              <legend className="mb-1 font-medium">Events</legend>
              {EVENTS.map((ev) => (
                <label key={ev} className="mb-1 block">
                  <input
                    type="checkbox"
                    checked={events.includes(ev)}
                    onChange={(e) =>
                      setEvents((cur) =>
                        e.target.checked ? [...cur, ev] : cur.filter((x) => x !== ev),
                      )
                    }
                  />{' '}
                  {ev}
                </label>
              ))}
            </fieldset>
            {err && <ErrorBanner error={err} />}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={create.isPending} disabled={events.length === 0}>
                Add
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {secret && (
        <SecretModal title="Signing secret" secret={secret} onClose={() => setSecret(null)} />
      )}
      {log && <DeliveryLog endpoint={log} writable={writable} onClose={() => setLog(null)} />}
      {remove && (
        <Confirm
          title="Delete this endpoint?"
          message={`${remove.url} will stop receiving events, and its delivery log is deleted.`}
          confirmLabel="Delete"
          onConfirm={async () => {
            await api('DELETE', `/webhooks/${remove.id}`);
            toast('ok', 'Endpoint deleted');
            await qc.invalidateQueries({ queryKey: ['webhooks'] });
          }}
          onClose={() => setRemove(null)}
        />
      )}
    </>
  );
}

const STATUS_LABEL: Record<Delivery['status'], string> = {
  pending: 'Pending',
  success: 'Delivered',
  retrying: 'Retrying',
  dead: 'Failed (gave up)',
};

function DeliveryLog({
  endpoint,
  writable,
  onClose,
}: {
  endpoint: Endpoint;
  writable: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['deliveries', endpoint.id],
    queryFn: () =>
      api<{ items: Delivery[] }>('GET', `/webhooks/${endpoint.id}/deliveries?limit=50`),
    refetchInterval: 3000,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api('POST', `/webhooks/deliveries/${id}/retry`),
    onSuccess: () => {
      toast('ok', 'Retry queued');
      void qc.invalidateQueries({ queryKey: ['deliveries', endpoint.id] });
    },
    onError: (e) => toast('error', errorMessage(e)),
  });
  return (
    <Modal title="Delivery log" onClose={onClose}>
      <p className="mb-3 break-all font-mono text-muted">{endpoint.url}</p>
      {q.isLoading ? (
        <Skeleton />
      ) : q.error ? (
        <ErrorBanner error={q.error} />
      ) : !q.data?.items.length ? (
        <p className="text-muted">No deliveries yet. Send a test event.</p>
      ) : (
        <ul>
          {q.data.items.map((d) => (
            <li
              key={d.id}
              className="flex items-center justify-between gap-2 border-b border-line py-2"
            >
              <div>
                <p>
                  <strong>{STATUS_LABEL[d.status]}</strong> - {d.eventType}
                </p>
                <p className="text-muted">
                  attempt {d.attempt}
                  {d.responseCode ? `, HTTP ${String(d.responseCode)}` : ''}
                  {d.error ? `, ${d.error}` : ''}
                  {d.nextAttemptAt && d.status === 'retrying'
                    ? `, next ${fmtTime(d.nextAttemptAt)}`
                    : ''}
                </p>
                <p className="text-muted">{fmtTime(d.createdAt)}</p>
              </div>
              {writable && d.status !== 'success' && (
                <Button variant="secondary" onClick={() => retry.mutate(d.id)}>
                  Retry
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}
