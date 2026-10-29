import { describe, expect, it } from 'vitest';
import { backoffDelay } from './backoff.js';

describe('backoffDelay (CLI-04)', () => {
  it('stays within [0, base * 2^attempt) and never exceeds the 30 s cap', () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const ceiling = Math.min(30_000, 500 * 2 ** attempt);
      for (let i = 0; i < 200; i++) {
        const d = backoffDelay(attempt);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThan(ceiling);
      }
    }
  });

  it('is full-jitter: delays spread across the whole range', () => {
    const ds = Array.from({ length: 2000 }, () => backoffDelay(4));
    expect(Math.min(...ds)).toBeLessThan(800);
    expect(Math.max(...ds)).toBeGreaterThan(7000);
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    expect(mean).toBeGreaterThan(3000);
    expect(mean).toBeLessThan(5000);
  });

  it('honors retryAfterMs as a floor', () => {
    expect(backoffDelay(0, () => 0, 4000)).toBe(4000);
    expect(backoffDelay(10, () => 0.99, 100)).toBeGreaterThan(100);
  });
});
