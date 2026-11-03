/** Crypto helpers: AES-256-GCM secrets at rest, SHA-256 hashing, constant-time compare, key formats. */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Encrypts to `iv(12) || ciphertext || tag(16)`. */
export function encrypt(plain: Uint8Array | string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain;
  const ct = Buffer.concat([c.update(data), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}

/** Throws if the data was tampered with or the key is wrong. */
export function decrypt(blob: Uint8Array, key: Buffer): Buffer {
  const b = Buffer.from(blob);
  if (b.length < 28) throw new Error('ciphertext too short');
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]);
}

export const sha256 = (s: string | Uint8Array): Buffer => createHash('sha256').update(s).digest();

/** Constant-time equality for equal-purpose secrets of any length. */
export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const ha = sha256(a);
  const hb = sha256(b);
  return timingSafeEqual(ha, hb);
}

/** Random base62 string of 32 random bytes' worth of entropy (43 chars ≈ 256 bits). */
export function randomBase62(bytes = 32): string {
  const buf = randomBytes(bytes);
  let out = '';
  for (const b of buf) out += BASE62.charAt(b % 62);
  // modulo bias is ~0.8% per char, immaterial for 43+ chars of a 256-bit secret
  return out;
}

export type KeyPrefix = 'sk_live_' | 'pk_live_' | 'whsec_';

export interface GeneratedKey {
  /** Full key, shown to the user once. */
  key: string;
  /** Key type prefix plus 4 random chars, for display (all keys share the first 8). */
  prefix: string;
  hash: Buffer;
}

export function generateKey(prefix: KeyPrefix): GeneratedKey {
  const key = `${prefix}${randomBase62(32)}`;
  return { key, prefix: key.slice(0, prefix.length + 4), hash: sha256(key) };
}

export const randomToken = (): string => randomBytes(32).toString('base64url');

/** 32-byte per-tenant signing secret. */
export const generateSigningSecret = (): Buffer => randomBytes(32);

export const parseEncryptionKey = (b64: string): Buffer => Buffer.from(b64, 'base64');
