/** Request authentication for the four credential types (Doc 03 §1): dashboard JWT, secret key, client token. */
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { SyncraError } from '@syncra/shared';
import type { ClientClaims } from '../auth/jwt.js';
import { can, type Capability, type Role } from '../control/roles.js';
import type { Services } from '../services.js';

export type Principal =
  | { kind: 'dashboard'; userId: string; tenantId: string; role: Role }
  | { kind: 'secret'; tenantId: string; keyId: string }
  | { kind: 'client'; tenantId: string; claims: ClientClaims };

export function bearer(req: FastifyRequest): string {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  if (!m?.[1]) throw new SyncraError('UNAUTHENTICATED', 'Missing bearer credential');
  return m[1];
}

/** Zod parse that reports a 422 with field details instead of throwing a raw ZodError. */
export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new SyncraError('VALIDATION_FAILED', 'Invalid request', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data as z.infer<S>;
}

export async function authDashboard(
  s: Services,
  req: FastifyRequest,
): Promise<Extract<Principal, { kind: 'dashboard' }>> {
  const token = bearer(req);
  if (token.startsWith('sk_') || token.startsWith('pk_'))
    throw new SyncraError('FORBIDDEN', 'This endpoint needs a dashboard session');
  const userId = await s.accounts.verifyAccess(token);
  let tenantId = req.headers['x-tenant-id'];
  if (Array.isArray(tenantId)) tenantId = tenantId[0];
  if (!tenantId) {
    const ms = await s.accounts.memberships(userId);
    if (ms.length !== 1 || !ms[0])
      throw new SyncraError('VALIDATION_FAILED', 'X-Tenant-Id header required');
    tenantId = ms[0].tenantId;
  }
  // A malformed id cannot be a member of anything; answer like any other non-membership.
  const role = /^[0-9a-f-]{36}$/i.test(tenantId) ? await s.tenants.roleFor(tenantId, userId) : null;
  if (!role) throw new SyncraError('FORBIDDEN', 'Not a member of this tenant');
  return { kind: 'dashboard', userId, tenantId, role };
}

export async function authSecret(
  s: Services,
  req: FastifyRequest,
): Promise<Extract<Principal, { kind: 'secret' }>> {
  const token = bearer(req);
  if (!token.startsWith('sk_') && !token.startsWith('pk_'))
    throw new SyncraError('UNAUTHENTICATED', 'A secret API key is required');
  const key = await s.apiKeys.authenticate(token);
  if (!key) throw new SyncraError('UNAUTHENTICATED', 'Invalid API key');
  if (key.kind !== 'secret')
    throw new SyncraError('FORBIDDEN', 'Publishable keys cannot access data');
  return { kind: 'secret', tenantId: key.tenantId, keyId: key.keyId };
}

/** Secret key or dashboard session (the "S, D" endpoints). */
export async function authSecretOrDashboard(s: Services, req: FastifyRequest): Promise<Principal> {
  const token = bearer(req);
  return token.startsWith('sk_') || token.startsWith('pk_')
    ? authSecret(s, req)
    : authDashboard(s, req);
}

export async function authClient(
  s: Services,
  req: FastifyRequest,
): Promise<Extract<Principal, { kind: 'client' }>> {
  const claims = await s.verifyClientToken(bearer(req));
  return { kind: 'client', tenantId: claims.tenantId, claims };
}

/** Secret keys act with owner rights over data; dashboard users are checked against the role matrix. */
export function requireWrite(p: Principal, cap: Capability = 'docs.write'): void {
  if (p.kind === 'dashboard' && !can(p.role, cap)) {
    throw new SyncraError('FORBIDDEN', 'Your role does not allow this action');
  }
}

/** Audit actor for the principal. */
export const actorOf = (p: Principal) =>
  p.kind === 'dashboard'
    ? { actorType: 'user' as const, actorId: p.userId }
    : p.kind === 'secret'
      ? { actorType: 'api_key' as const, actorId: p.keyId }
      : { actorType: 'system' as const, actorId: p.claims.userId };

export function clientIp(req: FastifyRequest): string {
  return req.ip;
}
