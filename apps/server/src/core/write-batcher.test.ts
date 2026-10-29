import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WriteBatcher, type Batch } from './write-batcher.js';

/** Makes `n` real, mergeable Yjs updates from one doc. */
function updates(n: number): Uint8Array[] {
  const doc = new Y.Doc();
  const out: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => out.push(u));
  for (let i = 0; i < n; i++) doc.getText('t').insert(0, String(i));
  return out;
}
const item = (opId: string, update: Uint8Array) => ({ clientId: 'c1', opId, update });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('WriteBatcher', () => {
  it('merges updates inside the window into one flush with identical final state', async () => {
    const batches: Batch[] = [];
    const b = new WriteBatcher({
      windowMs: 20,
      maxBytes: 1e6,
      flush: (x) => {
        batches.push(x);
        return Promise.resolve();
      },
    });
    const us = updates(100);
    const done = Promise.all(us.map((u, i) => b.add('d', item(`op${String(i)}`, u))));
    await vi.advanceTimersByTimeAsync(20);
    await done;
    expect(batches).toHaveLength(1);
    expect(batches[0]?.items).toHaveLength(100);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, batches[0]?.update ?? new Uint8Array());
    const ref = new Y.Doc();
    us.forEach((u) => {
      Y.applyUpdate(ref, u);
    });
    expect(doc.getText('t').toJSON()).toBe(ref.getText('t').toJSON());
  });

  it('flushes early when the byte threshold is hit', async () => {
    const flush = vi.fn(() => Promise.resolve());
    const b = new WriteBatcher({ windowMs: 10_000, maxBytes: 1, flush });
    await Promise.all([b.add('d', item('a', updates(1)[0] as Uint8Array))]);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('never flushes one document concurrently with itself', async () => {
    let active = 0;
    let maxActive = 0;
    const b = new WriteBatcher({
      windowMs: 1,
      maxBytes: 1e6,
      flush: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 50));
        active--;
      },
    });
    const [u1, u2] = updates(2) as [Uint8Array, Uint8Array];
    const p1 = b.add('d', item('a', u1));
    await vi.advanceTimersByTimeAsync(5);
    const p2 = b.add('d', item('b', u2));
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all([p1, p2]);
    expect(maxActive).toBe(1);
  });

  it('serves ready documents FIFO under limited concurrency', async () => {
    const order: string[] = [];
    const b = new WriteBatcher({
      windowMs: 1,
      maxBytes: 1e6,
      concurrency: 1,
      flush: async (x) => {
        order.push(x.docKey);
        await new Promise((r) => setTimeout(r, 10));
      },
    });
    const u = updates(1)[0] as Uint8Array;
    const all = ['a', 'b', 'c'].map((k) => b.add(k, item(k, u)));
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(all);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('rejects every item in a failed batch and keeps working', async () => {
    let fail = true;
    const b = new WriteBatcher({
      windowMs: 1,
      maxBytes: 1e6,
      flush: () => (fail ? Promise.reject(new Error('db down')) : Promise.resolve()),
    });
    const u = updates(1)[0] as Uint8Array;
    const bad = b.add('d', item('a', u));
    const bad2 = b.add('d', item('b', u));
    const assertion = Promise.all([
      expect(bad).rejects.toThrow('db down'),
      expect(bad2).rejects.toThrow(),
    ]);
    await vi.advanceTimersByTimeAsync(5);
    await assertion;
    fail = false;
    const ok = b.add('d', item('c', u));
    await vi.advanceTimersByTimeAsync(5);
    await expect(ok).resolves.toBeUndefined();
  });

  it('drain() flushes buffered items without waiting for the window', async () => {
    const flush = vi.fn(() => Promise.resolve());
    const b = new WriteBatcher({ windowMs: 60_000, maxBytes: 1e6, flush });
    const p = b.add('d', item('a', updates(1)[0] as Uint8Array));
    await b.drain();
    await p;
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
