/** Client-token verification (AUT-05, AUT-06): HS256 signed with the tenant's own secret, found via the kid header. */
import { decodeProtectedHeader, jwtVerify } from 'jose';
import { z } from 'zod';
import { LIMITS, SyncraError } from '@syncra/shared';
import type { TenantKeyProvider } from '../control/signing.js';
import { accessRuleSchema, type AccessRule } from './access.js';

export interface ClientClaims {
  tenantId: string;
  userId: string;
  access: AccessRule[];
  meta: Record<string, unknown>;
  /** Epoch seconds; lets connections be closed with 4010 when the token expires. */
  exp: number;
}
export type TokenVerifier = (token: string) => Promise<ClientClaims>;

const claimsSchema = z.object({
  tid: z.string().min(1),
  sub: z.string().min(1),
  access: z.array(accessRuleSchema),
  meta: z.record(z.unknown()).default({}),
  exp: z.number(),
  iat: z.number(),
});

const unauthenticated = (): SyncraError =>
  new SyncraError('UNAUTHENTICATED', 'Invalid or expired token');

/**
 * Verifies signature, expiry (30 s leeway), tenant status and that the kid matches the tid claim.
 * Every failure is reported identically so callers learn nothing about why.
 */
export function createClientTokenVerifier(keys: TenantKeyProvider): TokenVerifier {
  return async (token) => {
    try {
      const kid = decodeProtectedHeader(token).kid;
      if (!kid) throw new Error('no kid');
      const key = await keys(kid);
      if (!key?.active) throw new Error('unknown or inactive tenant');
      const { payload } = await jwtVerify(token, key.secret, {
        algorithms: ['HS256'],
        clockTolerance: 30,
      });
      const c = claimsSchema.parse(payload);
      if (c.tid !== kid) throw new Error('kid/tid mismatch');
      if (c.exp - c.iat > LIMITS.maxTokenTtlSeconds + 60) throw new Error('lifetime too long');
      return { tenantId: c.tid, userId: c.sub, access: c.access, meta: c.meta, exp: c.exp };
    } catch {
      throw unauthenticated();
    }
  };
}
