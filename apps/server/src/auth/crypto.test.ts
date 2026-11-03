import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, generateKey, randomBase62, safeEqual, sha256 } from './crypto.js';

const key = Buffer.alloc(32, 9);

describe('AES-256-GCM', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const a = encrypt('whsec_secret', key);
    const b = encrypt('whsec_secret', key);
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a, key).toString()).toBe('whsec_secret');
  });
  it('rejects tampering and wrong keys', () => {
    const blob = encrypt('x', key);
    blob[13] = (blob[13] ?? 0) ^ 1;
    expect(() => decrypt(blob, key)).toThrow();
    expect(() => decrypt(encrypt('x', key), Buffer.alloc(32, 1))).toThrow();
    expect(() => decrypt(Buffer.alloc(5), key)).toThrow();
  });
});

describe('keys', () => {
  it('generates prefixed, hashed, unique keys', () => {
    const a = generateKey('sk_live_');
    const b = generateKey('sk_live_');
    expect(a.key).toMatch(/^sk_live_[0-9A-Za-z]{32}$/);
    expect(a.prefix).toBe(a.key.slice(0, 12));
    expect(a.hash.equals(sha256(a.key))).toBe(true);
    expect(a.key).not.toBe(b.key);
    expect(generateKey('whsec_').key.startsWith('whsec_')).toBe(true);
  });
  it('base62 output stays in alphabet', () => {
    expect(randomBase62(64)).toMatch(/^[0-9A-Za-z]{64}$/);
  });
  it('safeEqual compares by value', () => {
    expect(safeEqual(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
    expect(safeEqual(Buffer.from('abc'), Buffer.from('abd'))).toBe(false);
    expect(safeEqual(Buffer.from('abc'), Buffer.from('abcd'))).toBe(false);
  });
});
