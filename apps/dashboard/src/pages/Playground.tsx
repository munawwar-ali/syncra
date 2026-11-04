import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createClient, type SyncraClient, type SyncraDoc } from '@syncra/client';
import { api } from '../api';
import { useTitle } from '../hooks';
import { Button, Card, ErrorBanner, PageHeader, errorMessage } from '../ui';

const STATE_LABEL: Record<string, string> = {
  live: 'Synced',
  connecting: 'Connecting',
  authenticating: 'Connecting',
  syncing: 'Syncing',
  offline: 'Offline',
  backoff: 'Reconnecting',
  'quota-blocked': 'Paused: plan limit',
  'auth-expired': 'Signed out',
  error: 'Error',
  idle: 'Idle',
};

/** Two real SDK clients in one page, each with its own offline switch, editing the same shared text (DX-06). */
export function Playground() {
  useTitle('Playground');
  const [room, setRoom] = useState(() => `room-${Math.random().toString(36).slice(2, 8)}`);
  const [error, setError] = useState<unknown>(null);
  return (
    <>
      <PageHeader title="Playground">
        <Button
          variant="secondary"
          onClick={() => setRoom(`room-${Math.random().toString(36).slice(2, 8)}`)}
        >
          New shared document
        </Button>
      </PageHeader>
      <p className="mb-4 text-muted">
        Two simulated devices share the document <code data-testid="room">playground/{room}</code>.
        Take one offline, type in both, then bring it back online: the edits merge with no conflict
        dialog.
      </p>
      {error !== null && <ErrorBanner error={error} />}
      <div className="grid gap-4 lg:grid-cols-2">
        <Device key={`${room}-a`} name="Device A" room={room} onError={setError} />
        <Device key={`${room}-b`} name="Device B" room={room} onError={setError} />
      </div>
    </>
  );
}

function Device({
  name,
  room,
  onError,
}: {
  name: string;
  room: string;
  onError: (e: unknown) => void;
}) {
  const [client, setClient] = useState<SyncraClient | null>(null);
  const [doc, setDoc] = useState<SyncraDoc | null>(null);

  useEffect(() => {
    const c = createClient({
      url: location.origin,
      publishableKey: 'playground',
      storage: 'memory',
      tabEnv: null,
      getToken: async () =>
        (
          await api<{ token: string }>('POST', '/tokens/playground', {
            userId: `${name.replace(/\W/g, '').toLowerCase()}-${room}`,
          })
        ).token,
    });
    c.on('error', (e) => onError(new Error(e.message)));
    const d = c.doc('playground', room);
    setClient(c);
    setDoc(d);
    return () => {
      void c.destroy();
    };
  }, [name, room, onError]);

  return (
    <Card title={name}>
      {client && doc ? <DeviceBody client={client} doc={doc} name={name} /> : null}
    </Card>
  );
}

function DeviceBody({ client, doc, name }: { client: SyncraClient; doc: SyncraDoc; name: string }) {
  const status = useSyncExternalStore(
    (cb) => client.subscribe(cb),
    () => client.status,
  );
  const text = useSyncExternalStore(
    (cb) => doc.onChange(cb),
    () => doc.text().toJSON(),
  );
  const [offline, setOffline] = useState(false);
  const label = STATE_LABEL[status.connection] ?? status.connection;
  const dot = useMemo(
    () =>
      status.connection === 'live'
        ? 'var(--success)'
        : status.connection === 'offline'
          ? 'var(--offline)'
          : 'var(--warning)',
    [status.connection],
  );
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span
          data-testid={`${name}-status`}
          data-state={status.connection}
          className="flex items-center gap-2"
          role="status"
        >
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: dot }}
          />
          {label}, {status.pendingOps} pending
        </span>
        <Button
          variant="secondary"
          aria-pressed={offline}
          onClick={() => {
            client.simulateOffline(!offline);
            setOffline(!offline);
          }}
        >
          {offline ? 'Go online' : 'Go offline'}
        </Button>
      </div>
      <label htmlFor={`text-${name}`} className="mb-1 block font-medium">
        Shared text as seen by {name}
      </label>
      <textarea
        id={`text-${name}`}
        data-testid={`${name}-text`}
        className="h-40 w-full rounded-input border border-line bg-bg p-2 font-mono"
        value={text}
        onChange={(e) => {
          // Diff against the current text so concurrent edits from the other device are preserved.
          const next = e.target.value;
          const cur = doc.text().toJSON();
          let start = 0;
          while (start < cur.length && start < next.length && cur[start] === next[start]) start++;
          let endCur = cur.length;
          let endNext = next.length;
          while (endCur > start && endNext > start && cur[endCur - 1] === next[endNext - 1]) {
            endCur--;
            endNext--;
          }
          doc.ydoc.transact(() => {
            if (endCur > start) doc.text().delete(start, endCur - start);
            if (endNext > start) doc.text().insert(start, next.slice(start, endNext));
          });
        }}
      />
      {status.error && (
        <p role="alert" className="mt-2 text-danger">
          {errorMessage(status.error.message)}
        </p>
      )}
    </>
  );
}
