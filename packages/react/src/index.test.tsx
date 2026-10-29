// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { createClient, type SyncraClient } from '@syncra/client';
import { FakeServer, fakeToken } from '@syncra/testkit';
import {
  SyncraProvider,
  useCollection,
  useDoc,
  usePresence,
  useSyncStatus,
  useYMap,
  useYText,
} from './index.js';

const clients: SyncraClient[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(clients.splice(0).map((c) => c.destroy().catch(() => undefined)));
});

function setup() {
  const server = new FakeServer();
  const client = createClient({
    url: 'ws://fake',
    publishableKey: 'pk',
    getToken: () => Promise.resolve(fakeToken()),
    storage: 'memory',
    tabEnv: null,
    probeUrl: '',
    batchMs: 2,
    transport: server.transport,
  });
  clients.push(client);
  return { server, client };
}

describe('SyncraProvider hooks', () => {
  it('useDoc + useYText render local edits and the sync status settles (CLI-09)', async () => {
    const { client } = setup();
    function Editor() {
      const { doc } = useDoc('notes', 'n1');
      const text = useYText(doc);
      const s = useSyncStatus();
      return (
        <div>
          <span data-testid="text">{text}</span>
          <span data-testid="pending">{s.pendingOps}</span>
          <span data-testid="conn">{s.connection}</span>
          <button
            onClick={() => {
              doc?.text().insert(0, 'hello');
            }}
          >
            type
          </button>
        </div>
      );
    }
    render(
      <SyncraProvider client={client}>
        <Editor />
      </SyncraProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId('conn').textContent).toBe('live');
    });
    act(() => {
      screen.getByText('type').click();
    });
    expect(screen.getByTestId('text').textContent).toBe('hello');
    await waitFor(() => {
      expect(screen.getByTestId('pending').textContent).toBe('0');
    });
  });

  it('useYMap with a selector does not re-render when unrelated keys change', async () => {
    const { client } = setup();
    let renders = 0;
    let docRef: ReturnType<typeof useDoc>['doc'] = null;
    function Title() {
      const { doc } = useDoc('notes', 'sel');
      docRef = doc;
      const title = useYMap(doc, 'data', (j) => j.title as string | undefined);
      renders++;
      return <span data-testid="title">{title ?? '-'}</span>;
    }
    render(
      <SyncraProvider client={client}>
        <Title />
      </SyncraProvider>,
    );
    await waitFor(() => {
      expect(docRef).not.toBeNull();
    });
    act(() => {
      docRef?.map().set('title', 'A');
    });
    expect(screen.getByTestId('title').textContent).toBe('A');
    const before = renders;
    act(() => {
      docRef?.map().set('unrelated', 1);
      docRef?.map().set('unrelated', 2);
    });
    expect(renders).toBe(before);
  });

  it('usePresence throttles bursts and keeps unchanged users referentially stable (COL-03)', async () => {
    const { client } = setup();
    let renders = 0;
    let docRef: ReturnType<typeof useDoc>['doc'] = null;
    const seen: unknown[] = [];
    function Cursors() {
      const { doc } = useDoc('notes', 'pres');
      docRef = doc;
      const others = usePresence(doc);
      seen.push(others[0]);
      renders++;
      return <span data-testid="n">{others.length}</span>;
    }
    render(
      <SyncraProvider client={client}>
        <Cursors />
      </SyncraProvider>,
    );
    await waitFor(() => {
      expect(docRef).not.toBeNull();
    });
    const before = renders;
    const remote = new Awareness(new Y.Doc());
    const updates: Uint8Array[] = [];
    remote.on('update', () => updates.push(encodeAwarenessUpdate(remote, [remote.clientID])));
    for (let i = 0; i < 100; i++) remote.setLocalState({ name: 'Riya', x: i });
    await act(async () => {
      for (const u of updates) docRef?.applyAwareness(u, 'remote');
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(screen.getByTestId('n').textContent).toBe('1');
    expect(renders - before).toBeLessThanOrEqual(4);

    const first = seen.at(-1);
    await act(async () => {
      docRef?.applyAwareness(encodeAwarenessUpdate(remote, [remote.clientID]), 'remote');
      await new Promise((r) => setTimeout(r, 250));
    });
    expect(seen.at(-1)).toBe(first);
  });

  it('useCollection lists entries created offline and updates reactively (CLI-13)', async () => {
    const { client } = setup();
    client.simulateOffline(true);
    function List() {
      const entries = useCollection('notes');
      return (
        <ul>
          {entries.map((e) => (
            <li key={e.id}>{e.id}</li>
          ))}
        </ul>
      );
    }
    render(
      <SyncraProvider client={client}>
        <List />
      </SyncraProvider>,
    );
    await client.collection('notes').whenLoaded();
    act(() => {
      client.collection('notes').create('a');
      client.collection('notes').create('b');
    });
    await waitFor(() => {
      expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['a', 'b']);
    });
  });
});
