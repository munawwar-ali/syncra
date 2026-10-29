import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeServer, fakeToken } from '@syncra/testkit';
import { createClient, type SyncraClient } from './client.js';
import { Bus, FakeLocks } from './tabs.fakes.js';

const open: SyncraClient[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.destroy().catch(() => undefined)));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  const where = new Error('until: timed out').stack;
  while (!fn()) {
    if (Date.now() > end) throw new Error(where);
    await sleep(5);
  }
}

/** Several "tabs": separate clients that share one lock manager, one BroadcastChannel bus and one IndexedDB. */
function tabs(n: number) {
  const server = new FakeServer();
  const locks = new FakeLocks();
  const bus = new Bus();
  const identity = { tenantId: 't', userId: `u-${Math.random().toString(36).slice(2, 8)}` };
  const make = (): SyncraClient => {
    const c = createClient({
      url: 'ws://fake',
      publishableKey: 'pk',
      getToken: () => Promise.resolve(fakeToken()),
      identity,
      tabEnv: { locks, channel: (name) => bus.open(name) },
      probeUrl: '',
      batchMs: 5,
      transport: server.transport,
    });
    open.push(c);
    return c;
  };
  return { server, clients: Array.from({ length: n }, make) };
}

describe('A2-3 multi-tab (CLI-06)', () => {
  it('three tabs share one server connection; edits flow in both directions', async () => {
    const { server, clients } = tabs(3);
    const docs = clients.map((c) => c.doc('notes', 'mt'));
    await until(() => clients.filter((c) => c.status.isLeader).length === 1);
    await until(() => server.conns.size === 1);
    await sleep(100);
    expect(server.conns.size).toBe(1);

    const leaderIdx = clients.findIndex((c) => c.status.isLeader);
    const followerIdx = leaderIdx === 0 ? 1 : 0;

    docs[followerIdx]?.text().insert(0, 'from follower ');
    await until(() => (server.json('notes/mt').text as string | undefined) === 'from follower ');
    docs[leaderIdx]?.text().insert(0, 'from leader ');
    await until(() => docs.every((d) => d.text().toJSON() === 'from leader from follower '));
    expect(server.conns.size).toBe(1);
  });

  it('hands leadership to another tab within 3 s when the leader closes, without losing edits', async () => {
    const { server, clients } = tabs(3);
    const docs = clients.map((c) => c.doc('notes', 'failover'));
    await until(() => clients.filter((c) => c.status.isLeader).length === 1);
    await until(() => server.conns.size === 1);
    const leaderIdx = clients.findIndex((c) => c.status.isLeader);
    const survivors = clients.filter((_, i) => i !== leaderIdx);
    const survivorDocs = docs.filter((_, i) => i !== leaderIdx);

    docs[leaderIdx]?.text().insert(0, 'before ');
    await until(() => (server.json('notes/failover').text as string | undefined) === 'before ');

    const t0 = Date.now();
    await clients[leaderIdx]?.destroy();
    await until(() => survivors.some((c) => c.status.isLeader), 3000);
    expect(Date.now() - t0).toBeLessThan(3000);

    survivorDocs[0]?.text().insert(0, 'after ');
    await until(
      () => (server.json('notes/failover').text as string | undefined) === 'after before ',
    ).catch((e: unknown) => {
      throw new Error(
        JSON.stringify([
          server.json('notes/failover'),
          survivorDocs.map((d) => d.text().toJSON()),
          survivors.map((c) => [c.status.isLeader, c.status.connection, c.status.pendingOps]),
        ]) + String(e),
      );
    });
    await until(() => survivorDocs.every((d) => d.text().toJSON() === 'after before ')).catch(
      (e: unknown) => {
        throw new Error(
          JSON.stringify([
            survivorDocs.map((d) => d.text().toJSON()),
            survivors.map((c) => [c.status.isLeader, c.status.connection, c.status.pendingOps]),
          ]) + String(e),
        );
      },
    );
    expect(server.conns.size).toBe(1);
  });
});
