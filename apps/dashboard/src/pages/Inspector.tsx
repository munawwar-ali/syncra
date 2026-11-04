import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { canWrite, useAuth } from '../auth';
import { useTitle } from '../hooks';
import {
  Button,
  Card,
  Confirm,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Skeleton,
  fmtBytes,
  fmtTime,
  useToast,
} from '../ui';

type Tab = 'json' | 'ops' | 'history' | 'danger';
const TABS: { id: Tab; label: string }[] = [
  { id: 'json', label: 'JSON' },
  { id: 'ops', label: 'Ops' },
  { id: 'history', label: 'History' },
  { id: 'danger', label: 'Danger zone' },
];

interface Doc {
  id: string;
  seq: number;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  json: unknown;
}

export function Inspector() {
  const { c = '', id: rawId = '' } = useParams();
  const id = decodeURIComponent(rawId);
  useTitle(`${c}/${id}`);
  const auth = useAuth();
  const [tab, setTab] = useState<Tab>('json');
  const base = `/collections/${c}/docs/${encodeURIComponent(id)}`;
  const doc = useQuery({
    queryKey: ['doc', auth.active?.tenantId, c, id],
    queryFn: () => api<Doc>('GET', base),
    refetchInterval: 5000,
  });

  return (
    <>
      <PageHeader title={`${c} / ${id}`} />
      {doc.error && <ErrorBanner error={doc.error} retry={() => void doc.refetch()} />}
      <div
        role="tablist"
        aria-label="Document inspector"
        className="mb-4 flex gap-1 border-b border-line"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              const i = TABS.findIndex((x) => x.id === tab);
              if (e.key === 'ArrowRight') setTab((TABS[(i + 1) % TABS.length] as { id: Tab }).id);
              if (e.key === 'ArrowLeft')
                setTab((TABS[(i + TABS.length - 1) % TABS.length] as { id: Tab }).id);
            }}
            className={`rounded-t-input px-3 py-2 ${tab === t.id ? 'border-b-2 border-primary font-semibold' : 'text-muted'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'json' && <JsonTab doc={doc.data} loading={doc.isLoading} />}
        {tab === 'ops' && <OpsTab base={base} />}
        {tab === 'history' && <HistoryTab base={base} c={c} id={id} />}
        {tab === 'danger' && <DangerTab base={base} c={c} />}
      </div>
    </>
  );
}

function JsonTab({ doc, loading }: { doc: Doc | undefined; loading: boolean }) {
  if (loading) return <Skeleton />;
  if (!doc) return null;
  return (
    <Card>
      <dl className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div>
          <dt className="text-muted">Seq</dt>
          <dd>{doc.seq}</dd>
        </div>
        <div>
          <dt className="text-muted">Size</dt>
          <dd>{fmtBytes(doc.sizeBytes)}</dd>
        </div>
        <div>
          <dt className="text-muted">Created</dt>
          <dd>{fmtTime(doc.createdAt)}</dd>
        </div>
        <div>
          <dt className="text-muted">Updated</dt>
          <dd>{fmtTime(doc.updatedAt)}</dd>
        </div>
      </dl>
      <pre
        data-testid="doc-json"
        className="max-h-[50vh] overflow-auto rounded-input bg-bg p-3 font-mono"
        tabIndex={0}
        aria-label="Document JSON"
      >
        {JSON.stringify(doc.json, null, 2)}
      </pre>
    </Card>
  );
}

function OpsTab({ base }: { base: string }) {
  const auth = useAuth();
  const q = useQuery({
    queryKey: ['ops', auth.active?.tenantId, base],
    queryFn: () =>
      api<{
        items: { seq: number; clientId: string; sizeBytes: number; opCount: number; at: string }[];
      }>('GET', `${base}/ops?limit=100`),
  });
  if (q.isLoading) return <Skeleton />;
  if (q.error) return <ErrorBanner error={q.error} retry={() => void q.refetch()} />;
  if (!q.data?.items.length)
    return (
      <EmptyState title="No operations stored. They may have been compacted into a snapshot." />
    );
  return (
    <Card>
      <table className="responsive w-full text-left">
        <thead>
          <tr className="text-muted">
            <th scope="col" className="p-2">
              Seq
            </th>
            <th scope="col" className="p-2">
              Client
            </th>
            <th scope="col" className="p-2">
              Updates
            </th>
            <th scope="col" className="p-2">
              Size
            </th>
            <th scope="col" className="p-2">
              Time
            </th>
          </tr>
        </thead>
        <tbody>
          {q.data.items.map((o) => (
            <tr key={o.seq} className="border-t border-line">
              <td data-label="Seq" className="p-2">
                {o.seq}
              </td>
              <td data-label="Client" className="p-2 font-mono">
                {o.clientId}
              </td>
              <td data-label="Updates" className="p-2">
                {o.opCount}
              </td>
              <td data-label="Size" className="p-2">
                {fmtBytes(o.sizeBytes)}
              </td>
              <td data-label="Time" className="p-2">
                {fmtTime(o.at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** Time travel (DAT-06): a slider across checkpoints. Scrubbing only reads; nothing on the server changes until Restore. */
function HistoryTab({ base, c, id }: { base: string; c: string; id: string }) {
  const auth = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [idx, setIdx] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const list = useQuery({
    queryKey: ['history', auth.active?.tenantId, c, id],
    queryFn: () =>
      api<{ items: { seq: number; createdAt: string; sizeBytes: number }[] }>(
        'GET',
        `${base}/history`,
      ),
  });
  // Oldest first, so dragging right moves forward in time.
  const points = [...(list.data?.items ?? [])].reverse();
  useEffect(() => {
    setIdx(Math.max(0, points.length - 1));
  }, [points.length]);
  const point = points[idx];
  const view = useQuery({
    queryKey: ['history-at', auth.active?.tenantId, c, id, point?.seq],
    queryFn: () =>
      api<{ seq: number; json: unknown }>('GET', `${base}/history/${String(point?.seq)}`),
    enabled: point !== undefined,
  });
  const restore = useMutation({
    mutationFn: () => api('POST', `${base}/restore`, { seq: point?.seq }),
    onSuccess: () => {
      toast('ok', `Restored to checkpoint ${String(point?.seq)}`);
      void qc.invalidateQueries({ queryKey: ['doc'] });
      void qc.invalidateQueries({ queryKey: ['ops'] });
    },
  });

  if (list.isLoading) return <Skeleton />;
  if (list.error) return <ErrorBanner error={list.error} retry={() => void list.refetch()} />;
  if (points.length === 0)
    return (
      <EmptyState title="No checkpoints yet. They are created automatically a few minutes after activity." />
    );
  return (
    <Card>
      <label htmlFor="slider" className="mb-1 block font-medium">
        Checkpoint {idx + 1} of {points.length}
        {point && (
          <span className="ml-2 text-muted">
            seq {point.seq}, {fmtTime(point.createdAt)}
          </span>
        )}
      </label>
      <input
        id="slider"
        type="range"
        min={0}
        max={points.length - 1}
        value={idx}
        onChange={(e) => setIdx(Number(e.target.value))}
        className="mb-3 w-full"
        aria-valuetext={point ? `seq ${String(point.seq)}` : undefined}
      />
      {view.isLoading ? (
        <Skeleton rows={2} />
      ) : (
        <pre
          data-testid="history-json"
          tabIndex={0}
          aria-label="Document at checkpoint"
          className="mb-3 max-h-[40vh] overflow-auto rounded-input bg-bg p-3 font-mono"
        >
          {JSON.stringify(view.data?.json, null, 2)}
        </pre>
      )}
      {canWrite(auth.active?.role) && (
        <Button variant="secondary" onClick={() => setConfirm(true)}>
          Restore this version
        </Button>
      )}
      {confirm && (
        <Confirm
          title="Restore this version?"
          message="Current content is replaced by this checkpoint. Nothing is deleted: the restore is a new edit and history keeps every version."
          confirmLabel="Restore"
          onConfirm={async () => {
            await restore.mutateAsync();
          }}
          onClose={() => setConfirm(false)}
        />
      )}
    </Card>
  );
}

function DangerTab({ base, c }: { base: string; c: string }) {
  const auth = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  if (!canWrite(auth.active?.role))
    return <p className="text-muted">Your role cannot delete documents.</p>;
  return (
    <Card title="Delete document">
      <p className="mb-3 text-muted">
        The document is hidden immediately and permanently removed after 7 days.
      </p>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Delete document
      </Button>
      {open && (
        <Confirm
          title="Delete this document?"
          message="Connected clients will stop being able to sync it."
          confirmLabel="Delete"
          onConfirm={async () => {
            await api('DELETE', base);
            void qc.invalidateQueries({ queryKey: ['docs'] });
            toast('ok', 'Document deleted');
            nav(`/collections/${c}`);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </Card>
  );
}
