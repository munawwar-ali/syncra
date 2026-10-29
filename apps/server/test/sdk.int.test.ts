/** The real SDK (createClient) against the real gateway and PostgreSQL shards, over real WebSockets. */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createClient, type SyncraClient } from '@syncra/client';
import {
  countOps,
  eventually,
  makePools,
  mintToken,
  newTenant,
  rwAll,
  startServer,
  type Harness,
} from './harness.js';

const pools = makePools();
const clients: SyncraClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.destroy().catch(() => undefined)));
});
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});

function sdk(h: { url: string }, tenant: string, user = 'u1'): SyncraClient {
  const c = createClient({
    url: h.url,
    publishableKey: 'pk_test',
    getToken: () => mintToken(tenant, rwAll('notes')),
    storage: 'memory',
    tabEnv: null,
    probeUrl: '',
    batchMs: 5,
    identity: { tenantId: tenant, userId: user },
  });
  clients.push(c);
  return c;
}

const live = (c: SyncraClient) =>
  eventually(() => c.status.connection === 'live' && c.status.pendingOps === 0, 10_000);

describe('SDK <-> server end to end', () => {
  it('syncs documents and the collection index between two devices', async () => {
    const h: Harness = await startServer({}, pools);
    const tenant = newTenant();
    const [a, b] = [sdk(h, tenant, 'alice'), sdk(h, tenant, 'bob')];
    const colA = a.collection<{ title: string }>('notes');
    const colB = b.collection<{ title: string }>('notes');
    await Promise.all([colA.whenLoaded(), colB.whenLoaded()]);

    const docA = colA.create('n1', { title: 'Shopping' });
    docA.text().insert(0, 'milk');
    await eventually(() => colB.list().some((e) => e.id === 'n1'), 10_000);
    const docB = colB.open('n1');
    await eventually(() => docB.text().toJSON() === 'milk' && docB.toJSON() !== undefined, 10_000);
    expect((docB.map().toJSON() as { title?: string }).title).toBe('Shopping');
    await Promise.all([live(a), live(b)]);
    await h.close();
  });

  it('offline edits merge cleanly on reconnect, with no lost updates', async () => {
    const h = await startServer({}, pools);
    const tenant = newTenant();
    const [a, b] = [sdk(h, tenant, 'a'), sdk(h, tenant, 'b')];
    const da = a.doc('notes', 'merge');
    const db = b.doc('notes', 'merge');
    await Promise.all([da.whenSynced(), db.whenSynced()]);
    da.text().insert(0, 'base. ');
    await eventually(() => db.text().toJSON() === 'base. ');

    b.simulateOffline(true);
    await eventually(() => b.status.connection === 'offline');
    db.text().insert(db.text().length, 'B was offline. ');
    da.text().insert(da.text().length, 'A kept typing. ');
    await eventually(() => da.text().toJSON().includes('A kept typing'));

    b.simulateOffline(false);
    await Promise.all([live(a), live(b)]);
    await eventually(
      () => da.text().toJSON() === db.text().toJSON() && da.text().length > 30,
      10_000,
    );
    expect(da.text().toJSON()).toContain('B was offline.');
    expect(da.text().toJSON()).toContain('A kept typing.');
    await h.close();
  });

  it('keeps working through a server restart and delivers edits made during the outage (SYN-10 shape)', async () => {
    const first = await startServer({}, pools);
    const tenant = newTenant();
    const a = sdk(first, tenant);
    const d = a.doc('notes', 'outage');
    await d.whenSynced();
    d.text().insert(0, 'before outage. ');
    await live(a);

    await first.close();
    await eventually(() => a.status.connection !== 'live', 10_000);
    d.text().insert(d.text().length, 'during outage.');

    const second = await startServer({}, pools, first.port);
    await live(a);
    const b = sdk(second, tenant, 'other-device');
    const db = b.doc('notes', 'outage');
    await db.whenSynced();
    expect(db.text().toJSON()).toBe('before outage. during outage.');
    expect(await countOps(second, tenant, 'notes', 'outage')).toBeGreaterThanOrEqual(1);
    await second.close();
  }, 30_000);
});
