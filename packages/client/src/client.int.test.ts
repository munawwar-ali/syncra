import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeNetwork, FakeServer, fakeToken } from '@syncra/testkit';
import { createClient, type ClientOptions, type SyncraClient } from './client.js';
import { IdbStore } from './idb-store.js';
import { MemoryStore } from './memory-store.js';
import { StorageFullError } from './store.js';

const clients: SyncraClient[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(clients.splice(0).map((c) => c.destroy().catch(() => undefined)));
});

function env(conditions = {}) {
  const server = new FakeServer(new FakeNetwork(conditions));
  const mk = (o: Partial<ClientOptions> = {}): SyncraClient => {
    const c = createClient({
      url: 'ws://fake',
      publishableKey: 'pk_test',
      getToken: () => Promise.resolve(fakeToken()),
      storage: 'memory',
      tabEnv: null,
      probeUrl: '',
      batchMs: 5,
      transport: server.transport,
      ...o,
    });
    clients.push(c);
    return c;
  };
  return { server, mk };
}

async function until(fn: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const live = (c: SyncraClient) =>
  until(() => c.status.connection === 'live' && c.status.pendingOps === 0);

describe('live sync (SYN-03, CLI-09)', () => {
  it('two clients converge and pending drops to 0', async () => {
    const { mk, server } = env();
    const [a, b] = [mk(), mk()];
    const da = a.doc('notes', 'n1');
    const db = b.doc('notes', 'n1');
    da.text().insert(0, 'hello ');
    await Promise.all([da.whenSynced(), db.whenSynced()]);
    db.text().insert(0, 'world ');
    await until(() => da.text().toJSON().length === 12 && db.text().toJSON().length === 12);
    expect(da.text().toJSON()).toBe(db.text().toJSON());
    await live(a);
    expect(server.json('notes/n1')).toEqual(da.toJSON());
    expect(a.status.lastSyncedAt).not.toBeNull();
  });
});

describe('offline editing (CLI-01, CLI-05, CLI-09)', () => {
  it('moves to offline, queues edits, and flushes them after reconnect', async () => {
    const { mk, server } = env();
    const a = mk();
    const b = mk();
    const da = a.doc('notes', 'n2');
    const db = b.doc('notes', 'n2');
    await Promise.all([da.whenSynced(), db.whenSynced()]);
    await live(a);

    a.simulateOffline(true);
    await until(() => a.status.connection === 'offline');
    da.text().insert(0, 'typed offline');
    await until(() => a.status.pendingOps > 0);
    expect(da.state).toBe('local-only');
    expect(db.text().toJSON()).toBe('');

    a.simulateOffline(false);
    await live(a);
    await until(() => db.text().toJSON() === 'typed offline');
    expect(server.json('notes/n2')).toEqual({ text: 'typed offline' });
  });

  it('keeps edits across a reload while offline, then delivers them (CLI-02)', async () => {
    const { mk, server } = env();
    const identity = { tenantId: 't1', userId: 'u-reload' };
    const first = mk({ storage: 'indexeddb', identity });
    server.acceptConnections = false;
    const d1 = first.doc('notes', 'persist');
    d1.text().insert(0, 'survives');
    await sleep(60); // past the 5 ms batch window: the edit is on disk
    await first.destroy();

    const second = mk({ storage: 'indexeddb', identity });
    const d2 = second.doc('notes', 'persist');
    await d2.whenLoaded();
    expect(d2.text().toJSON()).toBe('survives');
    expect(d2.state).toBe('local-only');

    server.acceptConnections = true;
    await until(
      () => (server.json('notes/persist') as { text?: string }).text === 'survives',
      8000,
    );
  });
});

describe('reconnect (CLI-04)', () => {
  it('recovers from a network partition by itself', async () => {
    const { mk, server } = env();
    const a = mk();
    const d = a.doc('notes', 'n3');
    await d.whenSynced();
    await live(a);
    server.network.partition(true);
    await until(() => ['backoff', 'connecting'].includes(a.status.connection));
    d.text().insert(0, 'during partition');
    server.network.partition(false);
    await live(a);
    expect((server.json('notes/n3') as { text: string }).text).toBe('during partition');
  }, 15_000);

  it('transfers only the diff on reconnect (SYN-02)', async () => {
    const { mk, server } = env();
    const a = mk();
    const big = a.doc('notes', 'big');
    big.text().insert(0, 'x'.repeat(30_000));
    await live(a);
    const before = server.step2Bytes;
    a.simulateOffline(true);
    await until(() => a.status.connection === 'offline');
    big.text().insert(10, 'y');
    a.simulateOffline(false);
    await live(a);
    expect(server.step2Bytes - before).toBeLessThan(200);
  });
});

describe('auth (CLI-08)', () => {
  it('asks for a new token after a 4010 close and resumes', async () => {
    const { mk, server } = env();
    let calls = 0;
    const a = mk({
      getToken: () => {
        calls++;
        return Promise.resolve(fakeToken());
      },
    });
    const d = a.doc('notes', 'n4');
    await d.whenSynced();
    await live(a);
    const before = calls;
    server.closeAll(4010);
    await until(() => calls > before);
    await live(a);
    d.text().insert(0, 'after refresh');
    await until(() => server.json('notes/n4').text === 'after refresh');
  });

  it('enters auth-expired when getToken keeps failing, then recovers', async () => {
    vi.useFakeTimers();
    const { mk, server } = env();
    let ok = true;
    const a = mk({
      getToken: () => (ok ? Promise.resolve(fakeToken()) : Promise.reject(new Error('signed out'))),
    });
    a.doc('notes', 'n5');
    await vi.advanceTimersByTimeAsync(100);
    expect(a.status.connection).toBe('live');
    ok = false;
    server.closeAll(4010); // server says the token expired; the app can no longer mint one
    await vi.advanceTimersByTimeAsync(30_000);
    expect(a.status.connection).toBe('auth-expired');
    ok = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(a.status.connection).toBe('live');
  });
});

describe('quota (OPS-05)', () => {
  it('goes quota-blocked, keeps the outbox, and drains after the quota is raised', async () => {
    vi.useFakeTimers();
    const { mk, server } = env();
    const a = mk();
    const d = a.doc('notes', 'q');
    await vi.advanceTimersByTimeAsync(100);
    server.rejectWrites = 'QUOTA_EXCEEDED';
    d.text().insert(0, 'blocked write');
    await vi.advanceTimersByTimeAsync(200);
    expect(a.status.connection).toBe('quota-blocked');
    expect(a.status.pendingOps).toBeGreaterThan(0);
    server.rejectWrites = null;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(a.status.connection).toBe('live');
    expect(a.status.pendingOps).toBe(0);
    expect((server.json('notes/q') as { text: string }).text).toBe('blocked write');
  });
});

describe('local storage (CLI-07, CLI-10..13)', () => {
  it('keeps local storage bounded under 10,000 edits via compaction', async () => {
    const { mk } = env();
    const store = new MemoryStore();
    const a = mk({ store, batchMs: 0 });
    const d = a.doc('notes', 'heavy');
    await d.whenLoaded();
    for (let i = 0; i < 10_000; i++) d.text().insert(0, 'x');
    await d.flush();
    const loaded = await store.load('notes/heavy');
    expect(loaded.snapshot).not.toBeNull();
    expect(loaded.updates.length).toBeLessThan(101);
  }, 60_000);

  it('IndexedDB log stays bounded too', async () => {
    const { mk, server } = env();
    server.acceptConnections = false;
    const identity = { tenantId: 't', userId: 'u-heavy' };
    const a = mk({ storage: 'indexeddb', identity, batchMs: 0 });
    const d = a.doc('notes', 'heavy-idb');
    await d.whenLoaded();
    for (let i = 0; i < 2_000; i++) d.text().insert(0, 'x');
    await d.flush();
    const raw = await IdbStore.open('syncra:t:u-heavy');
    expect((await raw.load('notes/heavy-idb')).updates.length).toBeLessThan(101);
    raw.close();
  }, 60_000);

  it('lists collection entries created offline (CLI-13)', async () => {
    const { mk } = env();
    const a = mk();
    a.simulateOffline(true);
    const col = a.collection<{ title: string }>('notes');
    await col.whenLoaded();
    col.create('one', { title: 'First' });
    col.create('two');
    expect(col.list().map((e) => e.id)).toEqual(['one', 'two']);
    col.remove('one');
    expect(col.list().map((e) => e.id)).toEqual(['two']);
  });

  it('rejects invalid data locally and accepts valid data (CLI-10)', () => {
    const { mk } = env();
    const schema = {
      safeParse: (v: unknown) =>
        typeof (v as { title?: unknown }).title === 'string'
          ? { success: true }
          : { success: false, error: { message: 'title must be a string' } },
    };
    const a = mk({ schemas: { notes: schema } });
    const col = a.collection<{ title: unknown }>('notes');
    expect(() => col.create('bad', { title: 42 })).toThrow('title must be a string');
    const ok = col.create('good', { title: 'fine' });
    expect(ok.toJSON()).toEqual({ data: { title: 'fine' } });
  });

  it('survives storage-full: reports the error and keeps the in-memory copy (CLI-11)', async () => {
    const { mk, server } = env();
    const full = new MemoryStore();
    full.appendLocal = () => Promise.reject(new StorageFullError());
    const a = mk({ store: full, batchMs: 0 });
    const errors: string[] = [];
    a.on('error', (e) => errors.push(e.code));
    const d = a.doc('notes', 'full');
    await d.whenLoaded();
    await until(() => a.status.connection === 'live');
    d.text().insert(0, 'still here');
    await until(() => errors.includes('storage-full'));
    expect(d.text().toJSON()).toBe('still here');
    await until(() => (server.json('notes/full') as { text?: string }).text === 'still here');
  });

  it('clearLocalData deletes the IndexedDB database (CLI-12)', async () => {
    const { mk, server } = env();
    server.acceptConnections = false;
    const identity = { tenantId: 't', userId: 'u-clear' };
    const a = mk({ storage: 'indexeddb', identity });
    const d = a.doc('notes', 'logout');
    d.text().insert(0, 'private');
    await sleep(60);
    await a.clearLocalData();
    const fresh = await IdbStore.open('syncra:t:u-clear');
    expect((await fresh.load('notes/logout')).updates).toEqual([]);
    fresh.close();
  });
});
