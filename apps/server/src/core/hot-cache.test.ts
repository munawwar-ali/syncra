import { describe, expect, it } from 'vitest';
import { HotCache } from './hot-cache.js';

function make(max = 2, idleMs = 1000) {
  const clock = { t: 0 };
  const evicted: string[] = [];
  const cache = new HotCache<string>({
    max,
    idleMs,
    now: () => clock.t,
    onEvict: (k) => evicted.push(k.replace('\u0000', ':')),
  });
  return { cache, clock, evicted };
}

describe('HotCache', () => {
  it('isolates tenants: same docKey under different tenants never collides', () => {
    const { cache } = make(10);
    cache.set('t1', 'notes/a', 'one');
    cache.set('t2', 'notes/a', 'two');
    expect(cache.get('t1', 'notes/a')).toBe('one');
    expect(cache.get('t2', 'notes/a')).toBe('two');
    expect(cache.get('t3', 'notes/a')).toBeUndefined();
  });

  it('evicts the least recently used entry when full', () => {
    const { cache, evicted } = make(2);
    cache.set('t', 'a', '1');
    cache.set('t', 'b', '2');
    cache.get('t', 'a'); // a is now most recent
    cache.set('t', 'c', '3');
    expect(evicted).toEqual(['t:b']);
    expect(cache.get('t', 'a')).toBe('1');
  });

  it('never evicts documents that still have subscribers', () => {
    const { cache } = make(1);
    cache.set('t', 'a', '1');
    cache.acquire('t', 'a');
    cache.set('t', 'b', '2');
    expect(cache.get('t', 'a')).toBe('1');
    expect(cache.size).toBe(2);
  });

  it('evicts idle unreferenced entries only after idleMs', () => {
    const { cache, clock } = make(10, 1000);
    cache.set('t', 'a', '1');
    cache.set('t', 'b', '2');
    cache.acquire('t', 'b');
    clock.t = 999;
    expect(cache.evictIdle()).toBe(0);
    clock.t = 1000;
    expect(cache.evictIdle()).toBe(1);
    expect(cache.get('t', 'b')).toBe('2');
    cache.release('t', 'b');
    clock.t = 2000;
    expect(cache.evictIdle()).toBe(1);
    expect(cache.size).toBe(0);
  });

  it('memory guard cuts capacity by 25% above 75% heap use', () => {
    const { cache } = make(8);
    for (let i = 0; i < 8; i++) cache.set('t', String(i), 'v');
    expect(cache.applyMemoryGuard(70, 100)).toBe(false);
    expect(cache.size).toBe(8);
    expect(cache.applyMemoryGuard(80, 100)).toBe(true);
    expect(cache.size).toBe(6);
  });
});
