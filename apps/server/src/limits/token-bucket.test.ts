import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { InProcessLimiter, RedisLimiter, takeFromBucket, type BucketSpec } from './token-bucket.js';

const spec: BucketSpec = { capacity: 10, ratePerSec: 5 };

describe('takeFromBucket (simulated time)', () => {
  it('allows a burst up to capacity, then denies with an accurate retryAfterMs', () => {
    let s = null as ReturnType<typeof takeFromBucket>['state'] | null;
    let allowed = 0;
    for (let i = 0; i < 12; i++) {
      const r = takeFromBucket(s, spec, 1, 1000);
      s = r.state;
      if (r.result.allowed) allowed++;
    }
    expect(allowed).toBe(10);
    const denied = takeFromBucket(s, spec, 1, 1000);
    expect(denied.result).toEqual({ allowed: false, retryAfterMs: 200 }); // 1 token at 5/s
  });
  it('refills over time but never above capacity', () => {
    const drained = takeFromBucket(null, spec, 10, 0).state;
    expect(takeFromBucket(drained, spec, 5, 1000).result.allowed).toBe(true); // 1 s -> 5 tokens
    expect(takeFromBucket(drained, spec, 11, 3_600_000).result.allowed).toBe(false); // cap at 10
  });
});

describe('InProcessLimiter', () => {
  it('a flooding key does not affect another key (A3-3 shape)', async () => {
    let t = 0;
    const l = new InProcessLimiter(() => t);
    for (let i = 0; i < 50; i++) await l.take('conn:a', spec);
    expect((await l.take('conn:a', spec)).allowed).toBe(false);
    expect((await l.take('conn:b', spec)).allowed).toBe(true);
    t += 1000;
    expect((await l.take('conn:a', spec)).allowed).toBe(true);
  });
});

describe('RedisLimiter', () => {
  it('runs the Lua script with the same semantics as the pure function', async () => {
    const redis = new RedisMock();
    let t = 5000;
    const l = new RedisLimiter(redis, { now: () => t });
    const results = [];
    for (let i = 0; i < 11; i++) results.push((await l.take('tenant:t1', spec)).allowed);
    expect(results.filter(Boolean)).toHaveLength(10);
    const denied = await l.take('tenant:t1', spec);
    expect(denied).toEqual({ allowed: false, retryAfterMs: 200 });
    t += 1000;
    expect((await l.take('tenant:t1', spec)).allowed).toBe(true);
  });
  it('falls back to a divided in-process bucket when Redis fails', async () => {
    const broken = { eval: () => Promise.reject(new Error('down')) } as unknown as Redis;
    let fell = 0;
    const l = new RedisLimiter(broken, {
      expectedNodes: 2,
      now: () => 0,
      onFallback: () => fell++,
    });
    const allowed = [];
    for (let i = 0; i < 8; i++) allowed.push((await l.take('k', spec)).allowed);
    expect(allowed.filter(Boolean)).toHaveLength(5); // capacity 10 / 2 nodes
    expect(fell).toBe(8);
  });
});
