import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { NetClient } from '@syncra/client';
import {
  RawClient,
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
let h: Harness;
beforeAll(async () => {
  h = await startServer({}, pools);
});
afterAll(async () => {
  await h.close();
  await Promise.all(pools.map((p) => p.end()));
});

async function client(tenant: string, access = rwAll('notes')): Promise<NetClient> {
  const c = new NetClient({ url: h.url, token: await mintToken(tenant, access) });
  await c.whenOpen();
  return c;
}

describe('A1-1 convergence and delta sync (SYN-02, SYN-03)', () => {
  it('two clients converge after concurrent edits', async () => {
    const tenant = newTenant();
    const [a, b] = [await client(tenant), await client(tenant)];
    const da = a.doc('notes', 'n1');
    const db = b.doc('notes', 'n1');
    await Promise.all([da.whenSynced(), db.whenSynced()]);
    da.ydoc.getText('t').insert(0, 'hello ');
    db.ydoc.getText('t').insert(0, 'world ');
    await Promise.all([da.flush(), db.flush()]);
    await eventually(
      () => da.ydoc.getText('t').length === 12 && db.ydoc.getText('t').length === 12,
    );
    expect(da.ydoc.getText('t').toJSON()).toBe(db.ydoc.getText('t').toJSON());
    a.close();
    b.close();
  });

  it('reconnect transfers a delta proportional to the diff, not the document', async () => {
    const tenant = newTenant();
    const writer = await client(tenant);
    const w = writer.doc('notes', 'big');
    await w.whenSynced();
    w.ydoc.getText('t').insert(0, 'x'.repeat(20_000));
    await w.flush();

    const first = await client(tenant);
    const d1 = first.doc('notes', 'big');
    await d1.whenSynced();
    expect(d1.syncStep2Bytes).toBeGreaterThan(100); // full state: tiny wire size for one run, still > diff
    const localState = Y.encodeStateAsUpdate(d1.ydoc);
    first.close();

    w.ydoc.getText('t').insert(5, 'Z');
    await w.flush();

    const again = await client(tenant);
    const d2 = again.doc('notes', 'big');
    Y.applyUpdate(d2.ydoc, localState); // what the offline device already had
    await d2.whenSynced();
    expect(d2.ydoc.getText('t').length).toBe(20_001);
    expect(d2.syncStep2Bytes).toBeLessThan(100);
    writer.close();
    again.close();
  });
});

describe('A1-2 durability (SYN-04)', () => {
  it('an ACKed update survives a node loss', async () => {
    const tenant = newTenant();
    const victim = await startServer({}, pools);
    const c = new NetClient({ url: victim.url, token: await mintToken(tenant, rwAll('notes')) });
    await c.whenOpen();
    const d = c.doc('notes', 'durable');
    await d.whenSynced();
    d.ydoc.getText('t').insert(0, 'acked');
    await d.flush();
    await victim.close(); // no graceful hand-off beyond what already committed

    const survivor = await startServer({}, pools);
    const c2 = new NetClient({ url: survivor.url, token: await mintToken(tenant, rwAll('notes')) });
    await c2.whenOpen();
    const d2 = c2.doc('notes', 'durable');
    await d2.whenSynced();
    expect(d2.ydoc.getText('t').toJSON()).toBe('acked');
    c2.close();
    await survivor.close();
  });
});

describe('A1-3 idempotency and batching (SYN-05, SYN-06)', () => {
  it('re-sent update is stored once and ACKed with the same seq each time', async () => {
    const tenant = newTenant();
    const raw = new RawClient(h.url, await mintToken(tenant, rwAll('notes')));
    await raw.opened;
    raw.send({ type: 'SUBSCRIBE', docKey: 'notes/idem', flags: 0 });
    await raw.waitFor('SUBSCRIBED');
    const doc = new Y.Doc();
    let update: Uint8Array = new Uint8Array();
    doc.on('update', (u: Uint8Array) => (update = u));
    doc.getText('t').insert(0, 'once');
    for (let i = 0; i < 5; i++) {
      raw.send({ type: 'UPDATE', docKey: 'notes/idem', opId: 'same-op', update });
    }
    const acks = await raw.waitFor('ACK', 5);
    expect(new Set(acks.map((a) => a.seq)).size).toBe(1);
    expect(await countOps(h, tenant, 'notes', 'idem')).toBe(1);
    raw.close();
  });

  it('100 rapid updates become few op rows with identical final state', async () => {
    const tenant = newTenant();
    const a = await client(tenant);
    const d = a.doc('notes', 'rapid');
    await d.whenSynced();
    for (let i = 0; i < 100; i++) d.ydoc.getText('t').insert(0, 'k');
    await d.flush();
    expect(await countOps(h, tenant, 'notes', 'rapid')).toBeLessThanOrEqual(5);
    const b = await client(tenant);
    const d2 = b.doc('notes', 'rapid');
    await d2.whenSynced();
    expect(d2.ydoc.getText('t').length).toBe(100);
    a.close();
    b.close();
  });
});

describe('A1-5 limits and access (SYN-11, SYN-12)', () => {
  it('rejects oversized and malformed updates without dropping the connection', async () => {
    const tenant = newTenant();
    const small = await startServer({ maxUpdateBytes: 1024 }, pools);
    const raw = new RawClient(small.url, await mintToken(tenant, rwAll('notes')));
    await raw.opened;
    raw.send({ type: 'SUBSCRIBE', docKey: 'notes/big', flags: 0 });
    raw.send({ type: 'SUBSCRIBE', docKey: 'notes/other', flags: 0 });
    await raw.waitFor('SUBSCRIBED', 2);

    raw.send({ type: 'UPDATE', docKey: 'notes/big', opId: 'o1', update: new Uint8Array(2048) });
    raw.send({
      type: 'UPDATE',
      docKey: 'notes/big',
      opId: 'o2',
      update: new Uint8Array([255, 255, 255]),
    });
    const errors = await raw.waitFor('ERROR', 2);
    expect(errors.map((e) => e.code).sort()).toEqual(['PAYLOAD_TOO_LARGE', 'VALIDATION_FAILED']);

    const doc = new Y.Doc();
    let update: Uint8Array = new Uint8Array();
    doc.on('update', (u: Uint8Array) => (update = u));
    doc.getText('t').insert(0, 'fine');
    raw.send({ type: 'UPDATE', docKey: 'notes/other', opId: 'o3', update });
    await raw.waitFor('ACK');
    expect(raw.open).toBe(true);
    expect(await countOps(small, tenant, 'notes', 'big')).toBe(0);
    raw.close();
    await small.close();
  });

  it('read-only access receives FORBIDDEN and leaves server state untouched', async () => {
    const tenant = newTenant();
    const writer = await client(tenant);
    await writer.doc('notes', 'ro').whenSynced();
    const raw = new RawClient(
      h.url,
      await mintToken(tenant, [{ collection: 'notes', docs: '*', mode: 'r' }]),
    );
    await raw.opened;
    raw.send({ type: 'SUBSCRIBE', docKey: 'notes/ro', flags: 0 });
    const [sub] = await raw.waitFor('SUBSCRIBED');
    expect(sub?.access).toBe(0);
    const doc = new Y.Doc();
    let update: Uint8Array = new Uint8Array();
    doc.on('update', (u: Uint8Array) => (update = u));
    doc.getText('t').insert(0, 'nope');
    raw.send({ type: 'UPDATE', docKey: 'notes/ro', opId: 'x', update });
    const [err] = await raw.waitFor('ERROR');
    expect(err?.code).toBe('FORBIDDEN');
    expect(await countOps(h, tenant, 'notes', 'ro')).toBe(0);
    writer.close();
    raw.close();
  });

  it('rejects a tampered token and a collection outside the token rules', async () => {
    const tenant = newTenant();
    const good = await mintToken(tenant, rwAll('notes'));
    const bad = new RawClient(h.url, `${good.slice(0, -3)}abc`);
    await expect(bad.opened).rejects.toThrow();

    const raw = new RawClient(h.url, good);
    await raw.opened;
    raw.send({ type: 'SUBSCRIBE', docKey: 'secrets/x', flags: 0 });
    const [err] = await raw.waitFor('ERROR');
    expect(err?.code).toBe('FORBIDDEN');
    raw.close();
  });
});
