import { describe, expect, it, vi } from 'vitest';
import { TokenManager, decodeClaims } from './token.js';

const jwt = (claims: object): string =>
  `h.${btoa(JSON.stringify(claims)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')}.s`;

describe('TokenManager (CLI-08)', () => {
  it('decodes claims and tolerates garbage', () => {
    expect(decodeClaims(jwt({ tid: 't1', sub: 'u1' }))).toMatchObject({ tid: 't1', sub: 'u1' });
    expect(decodeClaims('nope')).toEqual({});
  });

  it('caches until 80% of the token lifetime, then refetches', async () => {
    let now = 1_000_000_000_000;
    const fetcher = vi.fn(() => Promise.resolve(jwt({ iat: now / 1000, exp: now / 1000 + 1000 })));
    const m = new TokenManager(fetcher, () => now);
    await m.get();
    now += 799_000;
    await m.get();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 2_000;
    await m.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('invalidate() forces a refetch and concurrent gets share one call', async () => {
    const fetcher = vi.fn(() => Promise.resolve(jwt({ exp: Date.now() / 1000 + 3600 })));
    const m = new TokenManager(fetcher);
    await Promise.all([m.get(), m.get(), m.get()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    m.invalidate();
    await m.get();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('propagates getToken failures', async () => {
    const m = new TokenManager(() => Promise.reject(new Error('no session')));
    await expect(m.get()).rejects.toThrow('no session');
  });
});
