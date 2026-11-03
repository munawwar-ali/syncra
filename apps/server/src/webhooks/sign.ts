/** Webhook signatures (Doc 03 §7): `t=<unix>,v1=<hex hmac_sha256(secret, t + "." + rawBody)>`. */
import { createHmac } from 'node:crypto';
import { safeEqual } from '../auth/crypto.js';

export const SIGNATURE_TOLERANCE_S = 300;

export function signPayload(secret: string, rawBody: string, tSeconds: number): string {
  const v1 = createHmac('sha256', secret)
    .update(`${String(tSeconds)}.${rawBody}`)
    .digest('hex');
  return `t=${String(tSeconds)},v1=${v1}`;
}

/** Receiver-side check, also used by tests and documented for integrators. */
export function verifySignature(
  header: string,
  secret: string,
  rawBody: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceS = SIGNATURE_TOLERANCE_S,
): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1 || Math.abs(nowSeconds - t) > toleranceS) return false;
  const expected = signPayload(secret, rawBody, t);
  return safeEqual(Buffer.from(expected), Buffer.from(`t=${String(t)},v1=${parts.v1}`));
}
