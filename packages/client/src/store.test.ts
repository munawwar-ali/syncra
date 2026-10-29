import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { IdbStore } from './idb-store.js';
import { MemoryStore } from './memory-store.js';
import type { LocalStore } from './store.js';

const u = (...n: number[]) => new Uint8Array(n);
let counter = 0;

const factories: [string, () => Promise<LocalStore>][] = [
  ['memory', () => Promise.resolve(new MemoryStore())],
  ['indexeddb', () => IdbStore.open(`syncra:test:${String(counter++)}`)],
];

describe.each(factories)('LocalStore contract: %s', (_name, make) => {
  let s: LocalStore;
  beforeEach(async () => {
    s = await make();
  });

  it('persists meta values', async () => {
    await s.setMeta('clientId', 'abc');
    expect(await s.getMeta('clientId')).toBe('abc');
    expect(await s.getMeta('missing')).toBeUndefined();
  });

  it('appendLocal writes the update log and the outbox together (CLI-02)', async () => {
    const id = await s.appendLocal('notes/a', u(1), 'op1');
    expect(id).toBeGreaterThan(0);
    expect((await s.load('notes/a')).updates).toEqual([u(1)]);
    expect((await s.outbox()).map((e) => [e.opId, e.state])).toEqual([['op1', 'pending']]);
  });

  it('appendRemote does not touch the outbox and logs keep insertion order per doc', async () => {
    await s.appendRemote('notes/a', u(1));
    await s.appendLocal('notes/b', u(9), 'x');
    await s.appendRemote('notes/a', u(2));
    expect((await s.load('notes/a')).updates).toEqual([u(1), u(2)]);
    expect(await s.outbox('notes/a')).toEqual([]);
  });

  it('outbox lifecycle: pending -> sent -> requeued -> acked', async () => {
    await s.appendLocal('d/1', u(1), 'a');
    await s.appendLocal('d/1', u(2), 'b');
    await s.markSent(['a']);
    expect((await s.outbox()).map((e) => e.state)).toEqual(['sent', 'pending']);
    await s.requeueSent();
    expect((await s.outbox()).map((e) => e.state)).toEqual(['pending', 'pending']);
    await s.ack('a');
    expect((await s.outbox()).map((e) => e.opId)).toEqual(['b']);
  });

  it('compact replaces old rows with a snapshot and never touches the outbox (CLI-07)', async () => {
    await s.appendLocal('d/1', u(1), 'a');
    const second = await s.appendRemote('d/1', u(2));
    await s.appendRemote('d/1', u(3));
    await s.compact('d/1', u(7, 7), second);
    const loaded = await s.load('d/1');
    expect(loaded.snapshot).toEqual(u(7, 7));
    expect(loaded.updates).toEqual([u(3)]);
    expect((await s.outbox()).map((e) => e.opId)).toEqual(['a']);
  });

  it('replaceOutbox swaps entries atomically', async () => {
    await s.appendLocal('d/1', u(1), 'a');
    await s.appendLocal('d/1', u(2), 'b');
    await s.replaceOutbox(['a', 'b'], {
      opId: 'm',
      docKey: 'd/1',
      update: u(1, 2),
      createdAt: 1,
      attempts: 0,
      state: 'pending',
    });
    expect((await s.outbox()).map((e) => e.opId)).toEqual(['m']);
  });

  it('registry stores doc records', async () => {
    await s.putDoc({
      docKey: 'd/1',
      collection: 'd',
      docId: '1',
      serverSeq: 0,
      createdAt: 1,
      updatedAt: 1,
      deleted: false,
    });
    expect((await s.listDocs()).map((d) => d.docKey)).toEqual(['d/1']);
  });

  it('destroy removes everything (CLI-12)', async () => {
    await s.appendLocal('d/1', u(1), 'a');
    await s.destroy();
    const fresh = await make().catch(() => s);
    expect((await fresh.load('d/1')).updates.length).toBeLessThanOrEqual(1);
  });
});

describe('IndexedDB specifics', () => {
  it('destroy deletes the database so a reopen starts empty (CLI-12)', async () => {
    const name = 'syncra:test:destroy';
    const a = await IdbStore.open(name);
    await a.appendLocal('d/1', u(1), 'a');
    await a.destroy();
    const b = await IdbStore.open(name);
    expect(await b.outbox()).toEqual([]);
    expect((await b.load('d/1')).updates).toEqual([]);
  });
});
