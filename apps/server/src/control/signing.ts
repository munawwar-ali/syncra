/** Per-tenant signing secrets and client tokens (AUT-05, ADR 0015). Tokens are HS256 with header kid = tenant id. */
import { SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { LIMITS, SyncraError } from '@syncra/shared';
import { accessRuleSchema, type AccessRule } from '../auth/access.js';
import { decrypt } from '../auth/crypto.js';

export interface TenantKey {
  secret: Uint8Array;
  active: boolean;
}
/** Looks up a tenant's signing secret; null when the tenant does not exist. */
export type TenantKeyProvider = (tenantId: string) => Promise<TenantKey | null>;

const CACHE_TTL_MS = 60_000;

/** Postgres-backed provider with a 60 s in-process cache. */
export function createTenantKeyProvider(
  db: pg.Pool,
  encryptionKey: Buffer,
  now: () => number = Date.now,
): TenantKeyProvider & { invalidate(tenantId: string): void } {
  const cache = new Map<string, { value: TenantKey | null; expires: number }>();
  const fn = async (tenantId: string): Promise<TenantKey | null> => {
    const hit = cache.get(tenantId);
    if (hit && hit.expires > now()) return hit.value;
    // An id that is not a UUID cannot exist; avoids a cast error from user-supplied kid values.
    const valid = z.string().uuid().safeParse(tenantId).success;
    let value: TenantKey | null = null;
    if (valid) {
      const { rows } = await db.query<{ signing_secret_enc: Buffer; status: string }>(
        'select signing_secret_enc, status from tenants where id = $1',
        [tenantId],
      );
      const r = rows[0];
      if (r)
        value = {
          secret: decrypt(r.signing_secret_enc, encryptionKey),
          active: r.status === 'active',
        };
    }
    cache.set(tenantId, { value, expires: now() + CACHE_TTL_MS });
    return value;
  };
  return Object.assign(fn, { invalidate: (id: string) => void cache.delete(id) });
}

export const mintRequestSchema = z.object({
  userId: z.string().min(1).max(200),
  ttlSeconds: z.number().int().min(1).max(LIMITS.maxTokenTtlSeconds).default(3600),
  access: z.array(accessRuleSchema).min(1),
  meta: z.record(z.unknown()).default({}),
});
export type MintRequest = z.input<typeof mintRequestSchema>;

export async function mintClientToken(
  keys: TenantKeyProvider,
  tenantId: string,
  req: MintRequest,
): Promise<{ token: string; expiresAt: string }> {
  const parsed = mintRequestSchema.safeParse(req);
  if (!parsed.success) throw new SyncraError('VALIDATION_FAILED', 'Invalid token request');
  const { userId, ttlSeconds, access, meta } = parsed.data;
  if (Buffer.byteLength(JSON.stringify(meta)) > LIMITS.maxTokenMetaBytes) {
    throw new SyncraError('VALIDATION_FAILED', 'meta exceeds 2 KB');
  }
  const key = await keys(tenantId);
  if (!key?.active) throw new SyncraError('FORBIDDEN', 'Tenant is not active');
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const token = await new SignJWT({ tid: tenantId, access, meta })
    .setProtectedHeader({ alg: 'HS256', kid: tenantId })
    .setIssuer('syncra')
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(exp)
    .setJti(randomUUID())
    .sign(key.secret);
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

export type { AccessRule };
