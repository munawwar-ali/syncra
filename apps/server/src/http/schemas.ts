/**
 * Request schemas shared by the routes and the OpenAPI generator, so the published contract is the same
 * object the server validates with (DX-04). Add a schema here, use it in the route, reference it in openapi.ts.
 */
import { z } from 'zod';
import { COLLECTION_REGEX, DOC_ID_REGEX, paginationSchema } from '@syncra/shared';
import { endpointInput, endpointPatch } from '../webhooks/service.js';
import { mintRequestSchema } from '../control/signing.js';

export const email = z
  .string()
  .email()
  .max(254)
  .transform((e) => e.toLowerCase());
export const password = z.string().min(10).max(200);

export const signupBody = z.object({
  email,
  password,
  name: z.string().min(1).max(100),
  tenantName: z.string().min(1).max(100),
});
export const loginBody = z.object({ email, password: z.string().min(1).max(200) });
export const acceptInviteBody = z.object({
  token: z.string().min(10).max(200),
  password: password.optional(),
  name: z.string().min(1).max(100).optional(),
});
export const tenantPatchBody = z.object({
  name: z.string().min(1).max(100).optional(),
  plan: z.enum(['free', 'pro', 'business', 'selfhost']).optional(),
});
export const inviteBody = z.object({ email, role: z.enum(['admin', 'developer', 'viewer']) });
export const memberRoleBody = z.object({ role: z.enum(['admin', 'developer', 'viewer']) });
export const createKeyBody = z.object({
  kind: z.enum(['secret', 'publishable']),
  name: z.string().min(1).max(100),
});
export const playgroundTokenBody = z.object({ userId: z.string().min(1).max(100) });

export const collectionName = z
  .string()
  .regex(COLLECTION_REGEX)
  .refine((c) => !c.startsWith('__'), 'reserved prefix');
export const docIdParam = z.string().regex(DOC_ID_REGEX);

export const createDocBody = z.object({
  id: docIdParam.optional(),
  initial: z.record(z.unknown()).optional(),
});
const base64url = z
  .string()
  .max(2_000_000)
  .regex(/^[A-Za-z0-9_-]*$/);
export const pullBody = z.object({ stateVector: base64url });
export const pushBody = z.object({
  clientId: z.string().min(1).max(128),
  opId: z.string().min(1).max(200),
  update: base64url,
});
export const restoreBody = z.object({ seq: z.number().int().nonnegative() });

export const listDocsQuery = paginationSchema.extend({
  prefix: z.string().max(128).optional(),
  updatedSince: z.coerce.date().optional(),
});
export const changesQuery = z.object({
  collection: collectionName.optional(),
  cursor: z.string().max(1000).optional(),
  limit: paginationSchema.shape.limit,
});
export const usageQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  metric: z
    .enum(['ops', 'bytes_written', 'connections_peak', 'docs_created', 'docs_active'])
    .default('ops'),
  granularity: z.enum(['hour', 'day']).default('hour'),
});

export { endpointInput, endpointPatch, mintRequestSchema, paginationSchema };
