import { describe, expect, it } from 'vitest';
import { murmur3, ShardRing } from './ring.js';

const KEYS = 100_000;
const route = (r: ShardRing, i: number) => r.route('tenant-1', 'notes', `doc-${String(i)}`);

describe('murmur3', () => {
  it('matches published test vectors', () => {
    expect(murmur3('')).toBe(0);
    expect(murmur3('', 1)).toBe(0x514e28b7);
    expect(murmur3('test')).toBe(0xba6bd213);
    expect(murmur3('Hello, world!')).toBe(0xc0363e43);
  });
});

describe('ShardRing', () => {
  it('is deterministic', () => {
    expect(route(new ShardRing(3), 7)).toBe(route(new ShardRing(3), 7));
  });

  it.each([2, 3, 4])('spreads %i shards within 15%% of the mean', (n) => {
    const ring = new ShardRing(n);
    const counts = new Array<number>(n).fill(0);
    for (let i = 0; i < KEYS; i++) counts[route(ring, i)] = (counts[route(ring, i)] ?? 0) + 1;
    const mean = KEYS / n;
    for (const c of counts) expect(Math.abs(c - mean) / mean).toBeLessThan(0.15);
  });

  it('moves about 1/N keys when a shard is added, and only onto the new shard', () => {
    const before = new ShardRing(3);
    const after = new ShardRing(4);
    let moved = 0;
    for (let i = 0; i < KEYS; i++) {
      const a = route(before, i);
      const b = route(after, i);
      if (a !== b) {
        moved++;
        expect(b).toBe(3);
      }
    }
    expect(moved / KEYS).toBeGreaterThan(0.15);
    expect(moved / KEYS).toBeLessThan(0.35);
  });
});
