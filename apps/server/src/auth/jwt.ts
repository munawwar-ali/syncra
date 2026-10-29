/** Client-token verification (Doc 03 §4.2). Phase 1 uses one shared dev secret; Phase 3 swaps in per-tenant keys. */
import { jwtVerify } from 'jose';
import { z } from 'zod';
import { SyncraError } from '@syncra/shared';
import { accessRuleSchema, type AccessRule } from './access.js';

export interface ClientClaims {
  tenantId: string;
  userId: string;
  access: AccessRule[];
}
export type TokenVerifier = (token: string) => Promise<ClientClaims>;

const claimsSchema = z.object({
  tid: z.string().min(1),
  sub: z.string().min(1),
  access: z.array(accessRuleSchema),
});

/** HS256 verifier with 30 s clock leeway. Any failure becomes UNAUTHENTICATED. */
export function createSharedSecretVerifier(secret: string): TokenVerifier {
  const key = new TextEncoder().encode(secret);
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['HS256'],
        clockTolerance: 30,
      });
      const c = claimsSchema.parse(payload);
      return { tenantId: c.tid, userId: c.sub, access: c.access };
    } catch {
      throw new SyncraError('UNAUTHENTICATED', 'Invalid or expired token');
    }
  };
}
