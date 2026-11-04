/** Phase 4 scale-out: A4-1, A4-2, A4-3, A4-7, A4-8 plus presence (COL-01/02) on in-process nodes sharing Postgres. */
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { NetClient, createClient, webSocketTransport, type SyncraClient } from '@syncra/client';
import { parseAwareness } from '../src/core/presence.js';
import { startCluster, type Cluster } from './cluster.js';
import { RawClient, eventually, mintToken, newTenant, rwAll, type Harness } from './harness.js';

const clusters: Cluster[] = [];
const clients: SyncraClient[] = [];
const nets: NetClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.destroy().catch(() => undefined)));
  nets.splice(0).forEach((n) => {
    n.close();
  });
  await Promise.all(clusters.splice(0).map((c) => c.close()));
});

async function cluster(n: number, opts: Parameters<typeof startCluster>[1] = {}): Promise<Cluster> {
  const c = await startCluster(n, opts);
  clusters.push(c);
  return c;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function net(node: Harness, tenant: string): Promise<NetClient> {
  const c = new NetClient({ url: node.url, token: await mintToken(tenant, rwAll('notes')) });
  nets.push(c);
  await c.whenOpen();
  return c;
}

/** Resolves when `doc` text satisfies `pred`, or rejects after `ms`. */
function textWhen(doc: Y.Doc, pred: (t: string) => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (pred(doc.getText('t').toJSON())) {
        doc.off('update', check);
        clearTimeout(timer);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      doc.off('update', check);
      reject(new Error(`timed out; text was "${doc.getText('t').toJSON()}"`));
    }, ms);
    doc.on('update', check);
    check();
  });
}

describe('A4-1 cross-node sync (SYN-03)', () => {
  it('clients on different nodes see each other, with p95 propagation under 150 ms locally', async () => {
    const c = await cluster(2);
    const tenant = newTenant();
    const [a, b] = [
      await net(c.nodes[0] as Harness, tenant),
      await net(c.nodes[1] as Harness, tenant),
    ];
    const da = a.doc('notes', 'fan');
    const db = b.doc('notes', 'fan');
    await Promise.all([da.whenSynced(), db.whenSynced()]);

    const lat: number[] = [];
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now();
      da.ydoc.getText('t').insert(i, 'x');
      await textWhen(db.ydoc, (t) => t.length === i + 1);
      lat.push(performance.now() - t0);
    }
    lat.sort((x, y) => x - y);
    const p95 = lat[Math.floor(lat.length * 0.95)] as number;
    expect(p95).toBeLessThan(150);
    // writes in the other direction too
    db.ydoc.getText('t').insert(0, 'B');
    await textWhen(da.ydoc, (t) => t.startsWith('B'));
  });

  it('converges under concurrent writers on three nodes', async () => {
    const c = await cluster(3);
    const tenant = newTenant();
    const cs = await Promise.all(c.nodes.map((n) => net(n, tenant)));
    const docs = cs.map((x) => x.doc('notes', 'concurrent'));
    await Promise.all(docs.map((d) => d.whenSynced()));
    docs.forEach((d, i) => {
      for (let k = 0; k < 20; k++) d.ydoc.getText('t').insert(0, String(i));
    });
    await Promise.all(docs.map((d) => d.flush()));
    await Promise.all(docs.map((d) => textWhen(d.ydoc, (t) => t.length === 60, 8000)));
    const texts = new Set(docs.map((d) => d.ydoc.getText('t').toJSON()));
    expect(texts.size).toBe(1);
  });
});

describe('gap detection and recovery (Doc 02 §4.5)', () => {
  it('a lost message is detected on the next one by its seq and repaired from Postgres', async () => {
    const c = await cluster(2);
    const tenant = newTenant();
    const [a, b] = [
      await net(c.nodes[0] as Harness, tenant),
      await net(c.nodes[1] as Harness, tenant),
    ];
    const da = a.doc('notes', 'gap');
    const db = b.doc('notes', 'gap');
    await Promise.all([da.whenSynced(), db.whenSynced()]);

    c.hub.dropNext = 1;
    da.ydoc.getText('t').insert(0, 'a');
    await da.flush();
    await sleep(100);
    expect(db.ydoc.getText('t').toJSON()).toBe(''); // really lost
    da.ydoc.getText('t').insert(1, 'b');
    await da.flush();
    await textWhen(db.ydoc, (t) => t === 'ab'); // seq jumped 0 -> 2: node 2 fetched seq 1 from the log
  });

  it('a lost trailing message is repaired by the periodic head_seq reconciliation', async () => {
    const c = await cluster(2);
    const tenant = newTenant();
    const [a, b] = [
      await net(c.nodes[0] as Harness, tenant),
      await net(c.nodes[1] as Harness, tenant),
    ];
    const da = a.doc('notes', 'tail');
    const db = b.doc('notes', 'tail');
    await Promise.all([da.whenSynced(), db.whenSynced()]);
    c.hub.dropNext = 1;
    da.ydoc.getText('t').insert(0, 'last');
    await da.flush();
    await sleep(100);
    expect(db.ydoc.getText('t').toJSON()).toBe('');
    const repaired = await c.nodes[1]?.svc.reconcile();
    expect(repaired).toBe(1);
    await textWhen(db.ydoc, (t) => t === 'last');
  });

  it("two nodes committing at once never lose or skip each other's ops", async () => {
    const c = await cluster(2);
    const tenant = newTenant();
    const [a, b] = [
      await net(c.nodes[0] as Harness, tenant),
      await net(c.nodes[1] as Harness, tenant),
    ];
    const [da, db] = [a.doc('notes', 'race'), b.doc('notes', 'race')];
    await Promise.all([da.whenSynced(), db.whenSynced()]);
    for (let round = 0; round < 15; round++) {
      da.ydoc.getText('t').insert(0, 'a');
      db.ydoc.getText('t').insert(0, 'b');
      await Promise.all([da.flush(), db.flush()]);
    }
    await Promise.all([da, db].map((d) => textWhen(d.ydoc, (t) => t.length === 30, 8000)));
    expect(da.ydoc.getText('t').toJSON()).toBe(db.ydoc.getText('t').toJSON());
    // and a fresh node load sees exactly the persisted truth
    const fresh = await net(c.nodes[0] as Harness, tenant);
    const df = fresh.doc('notes', 'race');
    await df.whenSynced();
    expect(df.ydoc.getText('t').length).toBe(30);
  });
});

describe('A4-3 Redis outage (OPS-11)', () => {
  it('same-node clients keep syncing; other nodes converge via the DB check; recovery restores fan-out', async () => {
    const c = await cluster(2, { degradedReconcileMs: 150 });
    const tenant = newTenant();
    const [a1, a2, b] = [
      await net(c.nodes[0] as Harness, tenant),
      await net(c.nodes[0] as Harness, tenant),
      await net(c.nodes[1] as Harness, tenant),
    ];
    const [d1, d2, db] = [a1.doc('notes', 'out'), a2.doc('notes', 'out'), b.doc('notes', 'out')];
    await Promise.all([d1.whenSynced(), d2.whenSynced(), db.whenSynced()]);

    c.hub.down = true; // Redis stopped
    d1.ydoc.getText('t').insert(0, 'during outage');
    await d1.flush(); // ACK still means durable in Postgres
    await textWhen(d2.ydoc, (t) => t === 'during outage'); // same node: unaffected
    const lost = c.hub.delivered;
    // Node 2 has no bus, but its degraded 150 ms reconcile finds the new head_seq.
    await textWhen(db.ydoc, (t) => t === 'during outage', 5000);
    expect(c.hub.delivered).toBe(lost);

    c.hub.down = false; // Redis back
    const before = c.hub.delivered;
    d1.ydoc.getText('t').insert(0, '!');
    await textWhen(db.ydoc, (t) => t.startsWith('!'));
    expect(c.hub.delivered).toBeGreaterThan(before); // delivered by fan-out again
  });
});

describe('A4-7 / A4-2: node shutdown and loss', () => {
  function sdkClients(c: Cluster, tenant: string, n: number, docId: string) {
    const live = (): Harness[] => c.nodes.filter((x) => !x.stopped);
    let rr = 0;
    const out: { client: SyncraClient; doc: ReturnType<SyncraClient['doc']> }[] = [];
    for (let i = 0; i < n; i++) {
      const client = createClient({
        url: 'ws://placeholder',
        publishableKey: 'pk',
        identity: { tenantId: tenant, userId: `u${String(i)}` },
        getToken: () => mintToken(tenant, rwAll('notes')),
        storage: 'memory',
        tabEnv: null,
        probeUrl: '',
        batchMs: 5,
        transport: (url, protocols) => {
          const nodes = live();
          const target = nodes[rr++ % nodes.length] as Harness;
          return webSocketTransport(url.replace(/^ws:\/\/[^/]+/, target.url), protocols);
        },
      });
      clients.push(client);
      out.push({ client, doc: client.doc('notes', docId) });
    }
    return out;
  }

  /** Types a unique marker per client every 40 ms until stopped; returns the markers it wrote. */
  function typist(doc: ReturnType<SyncraClient['doc']>, id: number) {
    const written: string[] = [];
    let n = 0;
    const timer = setInterval(() => {
      const m = `[c${String(id)}-${String(n++)}]`;
      doc.text().insert(doc.text().length, m);
      written.push(m);
    }, 40);
    return {
      written,
      stop: () => {
        clearInterval(timer);
      },
    };
  }

  it('A4-7: a rolling restart of three nodes loses nothing and clients reconnect within 3 s', async () => {
    const c = await cluster(3);
    const tenant = newTenant();
    const cs = sdkClients(c, tenant, 6, 'rolling');
    await eventually(() => cs.every((x) => x.client.status.connection === 'live'), 10_000);
    const typists = cs.map((x, i) => typist(x.doc, i));

    for (let round = 0; round < 3; round++) {
      await c.add(); // surge: a fresh node first, then retire an old one
      const victim = c.nodes.filter((n) => !n.stopped)[0] as Harness;
      const t0 = Date.now();
      await victim.close();
      victim.stopped = true;
      await eventually(() => cs.every((x) => x.client.status.connection === 'live'), 3000);
      expect(Date.now() - t0).toBeLessThan(3000);
      await sleep(150);
    }
    typists.forEach((t) => {
      t.stop();
    });
    await eventually(
      () =>
        cs.every((x) => x.client.status.connection === 'live' && x.client.status.pendingOps === 0),
      15_000,
    );

    const written = typists.flatMap((t) => t.written);
    expect(written.length).toBeGreaterThan(30);
    const survivor = c.nodes.find((n) => !n.stopped) as Harness;
    const check = await net(survivor, tenant);
    const dc = check.doc('notes', 'rolling');
    await dc.whenSynced();
    const text = dc.ydoc.getText('text').toJSON();
    const missing = written.filter((m) => !text.includes(m));
    expect(missing, `lost markers: ${missing.slice(0, 5).join(' ')}`).toEqual([]);
  }, 60_000);

  it('A4-2: abruptly killing a node under load loses no acknowledged update', async () => {
    const c = await cluster(2);
    const tenant = newTenant();
    const cs = sdkClients(c, tenant, 4, 'crash');
    await eventually(() => cs.every((x) => x.client.status.connection === 'live'), 10_000);
    const typists = cs.map((x, i) => typist(x.doc, i));
    await sleep(400);
    const victim = c.nodes[0] as Harness;
    await victim.crash();
    victim.stopped = true;
    await sleep(600);
    typists.forEach((t) => {
      t.stop();
    });
    await eventually(
      () =>
        cs.every((x) => x.client.status.connection === 'live' && x.client.status.pendingOps === 0),
      15_000,
    );

    const written = typists.flatMap((t) => t.written);
    const check = await net(c.nodes[1] as Harness, tenant);
    const dc = check.doc('notes', 'crash');
    await dc.whenSynced();
    const text = dc.ydoc.getText('text').toJSON();
    expect(written.filter((m) => !text.includes(m))).toEqual([]);
    // every client converged on the same content
    const texts = new Set(cs.map((x) => x.doc.text().toJSON()));
    expect(texts.size).toBe(1);
  }, 60_000);
});

describe('presence across nodes (COL-01, COL-02)', () => {
  const aware = (name: string) => {
    const a = new Awareness(new Y.Doc());
    a.setLocalState({ user: { name } });
    return { a, update: encodeAwarenessUpdate(a, [a.clientID]) };
  };
  const statesIn = (r: RawClient) =>
    r.frames.flatMap((f) => (f.type === 'AWARENESS' ? (parseAwareness(f.update) ?? []) : []));

  it('shows a client on another node quickly, gives late joiners a snapshot, and removes it on disconnect', async () => {
    const c = await cluster(2);
    const tenant = newTenant();
    const token = () => mintToken(tenant, rwAll('notes'));
    const [ra, rb] = [
      new RawClient((c.nodes[0] as Harness).url, await token()),
      new RawClient((c.nodes[1] as Harness).url, await token()),
    ];
    await Promise.all([ra.opened, rb.opened]);
    for (const r of [ra, rb]) r.send({ type: 'SUBSCRIBE', docKey: 'notes/pres', flags: 0 });
    await Promise.all([ra.waitFor('SUBSCRIBED'), rb.waitFor('SUBSCRIBED')]);

    const alice = aware('Alice');
    const t0 = performance.now();
    ra.send({ type: 'AWARENESS', docKey: 'notes/pres', update: alice.update });
    await eventually(() => statesIn(rb).some((s) => s.state.includes('Alice')), 2000);
    expect(performance.now() - t0).toBeLessThan(200);

    // a client joining node 2 afterwards is told who is already there
    const rc = new RawClient((c.nodes[1] as Harness).url, await token());
    await rc.opened;
    rc.send({ type: 'SUBSCRIBE', docKey: 'notes/pres', flags: 0 });
    await eventually(() => statesIn(rc).some((s) => s.state.includes('Alice')), 2000);

    ra.close(); // abrupt departure
    await eventually(
      () => statesIn(rb).some((s) => s.clientId === alice.a.clientID && s.state === 'null'),
      3000,
    );
    await eventually(
      () => statesIn(rc).some((s) => s.clientId === alice.a.clientID && s.state === 'null'),
      3000,
    );
    // and a later joiner no longer sees her
    const rd = new RawClient((c.nodes[1] as Harness).url, await token());
    await rd.opened;
    rd.send({ type: 'SUBSCRIBE', docKey: 'notes/pres', flags: 0 });
    await rd.waitFor('SUBSCRIBED');
    await sleep(150);
    expect(statesIn(rd).filter((s) => s.state.includes('Alice'))).toEqual([]);
    [rb, rc, rd].forEach((r) => {
      r.close();
    });
  });

  it('rejects oversized and malformed awareness without breaking the connection, and rate limits floods', async () => {
    const c = await cluster(1);
    const tenant = newTenant();
    const r = new RawClient((c.nodes[0] as Harness).url, await mintToken(tenant, rwAll('notes')));
    await r.opened;
    r.send({ type: 'SUBSCRIBE', docKey: 'notes/p2', flags: 0 });
    await r.waitFor('SUBSCRIBED');
    r.send({ type: 'AWARENESS', docKey: 'notes/p2', update: new Uint8Array([200, 1, 2]) });
    r.send({ type: 'AWARENESS', docKey: 'notes/p2', update: new Uint8Array(9000) });
    const errs = await r.waitFor('ERROR', 2);
    expect(errs.map((e) => e.code).sort()).toEqual(['PAYLOAD_TOO_LARGE', 'VALIDATION_FAILED']);
    expect(r.open).toBe(true);
    const spy = new RawClient((c.nodes[0] as Harness).url, await mintToken(tenant, rwAll('notes')));
    await spy.opened;
    spy.send({ type: 'SUBSCRIBE', docKey: 'notes/p2', flags: 0 });
    await spy.waitFor('SUBSCRIBED');
    for (let i = 0; i < 200; i++)
      r.send({ type: 'AWARENESS', docKey: 'notes/p2', update: aware(`u${String(i)}`).update });
    await sleep(500);
    expect(statesIn(spy).length).toBeLessThanOrEqual(25); // 20/s bucket, not 200
    r.close();
    spy.close();
  });
});

describe('A4-8 shard distribution and registry', () => {
  it('documents spread across both shards within 20% balance', async () => {
    const c = await cluster(1);
    const tenant = newTenant();
    const svc = (c.nodes[0] as Harness).svc;
    for (let i = 0; i < 400; i++) await svc.open(tenant, 'notes', `bal-${String(i)}`, true);
    const counts = await Promise.all(
      c.pools.map(async (p) =>
        Number(
          (
            await p.query<{ n: string }>(
              'select count(*)::text n from documents where tenant_id = $1',
              [tenant],
            )
          ).rows[0]?.n,
        ),
      ),
    );
    expect(counts.reduce((x, y) => x + y, 0)).toBe(400);
    const mean = 200;
    for (const n of counts) expect(Math.abs(n - mean) / mean).toBeLessThan(0.2);
  });
});
