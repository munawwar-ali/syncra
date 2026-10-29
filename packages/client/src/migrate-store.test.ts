import { describe, expect, it } from 'vitest';
import { MemoryStore } from './memory-store.js';
import { copyStore } from './migrate-store.js';

const u = (...n: number[]) => new Uint8Array(n);

describe('copyStore', () => {
  it('moves snapshots, update logs, registry and outbox into the identity store', async () => {
    const pending = new MemoryStore();
    await pending.putDoc({
      docKey: 'n/a',
      collection: 'n',
      docId: 'a',
      serverSeq: 0,
      createdAt: 1,
      updatedAt: 1,
      deleted: false,
    });
    await pending.appendLocal('n/a', u(1), 'op1');
    await pending.appendRemote('n/a', u(2));
    const target = new MemoryStore();
    expect(await copyStore(pending, target)).toBe(1);
    const loaded = await target.load('n/a');
    expect(loaded.updates.length).toBeGreaterThanOrEqual(2);
    expect((await target.outbox()).map((e) => e.opId)).toEqual(['op1']);
    expect((await target.listDocs()).map((d) => d.docKey)).toEqual(['n/a']);
  });
});
