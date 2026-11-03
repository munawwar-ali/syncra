/** Data-plane REST routes (Doc 03 §4.3, §4.4): collections, documents and the HTTP sync fallback. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import * as Y from 'yjs';
import { z } from 'zod';
import { COLLECTION_REGEX, DOC_ID_REGEX, SyncraError, paginationSchema } from '@syncra/shared';
import { resolveAccess } from '../auth/access.js';
import { docToJson, getDocMeta, listCollections, listDocs } from '../core/doc-queries.js';
import type { Services } from '../services.js';
import { authClient, authSecretOrDashboard, parse, requireWrite } from './auth.js';

const collection = z
  .string()
  .regex(COLLECTION_REGEX)
  .refine((c) => !c.startsWith('__'), 'reserved prefix');
const docId = z.string().regex(DOC_ID_REGEX);
const docParams = z.object({ c: collection, id: docId });
const b64 = z
  .string()
  .max(2_000_000)
  .regex(/^[A-Za-z0-9_-]*$/);

export function registerDataRoutes(app: FastifyInstance, s: Services): void {
  const shards = s.deps.shards;

  app.get('/collections', async (req) => {
    const p = await authSecretOrDashboard(s, req);
    return { items: await listCollections(shards, p.tenantId) };
  });

  app.get('/collections/:c/docs', async (req) => {
    const p = await authSecretOrDashboard(s, req);
    const { c } = parse(z.object({ c: collection }), req.params);
    const q = parse(
      paginationSchema.extend({
        prefix: z.string().max(128).optional(),
        updatedSince: z.coerce.date().optional(),
      }),
      req.query,
    );
    return listDocs(shards, p.tenantId, c, {
      limit: q.limit,
      cursor: q.cursor,
      prefix: q.prefix,
      updatedSince: q.updatedSince,
    });
  });

  app.post('/collections/:c/docs', async (req, reply) => {
    const p = await authSecretOrDashboard(s, req);
    requireWrite(p);
    const { c } = parse(z.object({ c: collection }), req.params);
    const b = parse(
      z.object({ id: docId.optional(), initial: z.record(z.unknown()).optional() }),
      req.body ?? {},
    );
    const id = b.id ?? uuidv7();
    if (await getDocMeta(shards, s.ring, p.tenantId, c, id))
      throw new SyncraError('CONFLICT', 'Document already exists');
    const hot = await s.docs.open(p.tenantId, c, id, true);
    let seq = hot.headSeq;
    if (b.initial) {
      const y = new Y.Doc();
      y.transact(() => {
        for (const [k, v] of Object.entries(b.initial ?? {})) y.getMap('data').set(k, v);
      });
      seq = await s.docs.write(hot, 'rest', `create:${randomUUID()}`, Y.encodeStateAsUpdate(y));
    }
    return reply.status(201).send({ id, seq });
  });

  app.get('/collections/:c/docs/:id', async (req) => {
    const p = await authSecretOrDashboard(s, req);
    const { c, id } = parse(docParams, req.params);
    const meta = await getDocMeta(shards, s.ring, p.tenantId, c, id);
    if (!meta) throw new SyncraError('NOT_FOUND', 'Document not found');
    const hot = await s.docs.open(p.tenantId, c, id, false);
    return { ...meta, json: docToJson(hot.doc) };
  });

  app.get('/collections/:c/docs/:id/state', async (req, reply) => {
    const p = await authSecretOrDashboard(s, req);
    const { c, id } = parse(docParams, req.params);
    const hot = await s.docs.open(p.tenantId, c, id, false);
    return reply.type('application/octet-stream').send(Buffer.from(Y.encodeStateAsUpdate(hot.doc)));
  });

  app.delete('/collections/:c/docs/:id', async (req, reply) => {
    const p = await authSecretOrDashboard(s, req);
    requireWrite(p);
    const { c, id } = parse(docParams, req.params);
    if (!(await s.docs.delete(p.tenantId, c, id)))
      throw new SyncraError('NOT_FOUND', 'Document not found');
    return reply.status(204).send();
  });

  // ---- HTTP sync fallback (client tokens) -------------------------------------------------
  const accessFor = (claims: Parameters<typeof resolveAccess>[0], c: string, id: string) => {
    const mode = resolveAccess(claims, c, id);
    if (!mode) throw new SyncraError('FORBIDDEN', 'No access to this document');
    return mode;
  };

  const syncLimit = async (req: FastifyRequest, tenantId: string): Promise<void> => {
    const r = await s.limiter.take(`conn:http:${tenantId}:${req.ip}`, {
      capacity: 100,
      ratePerSec: 50,
    });
    if (!r.allowed)
      throw new SyncraError('RATE_LIMITED', 'Too many requests', {
        scope: 'connection',
        retryAfterMs: r.retryAfterMs,
      });
  };

  app.post('/sync/:c/:id/pull', async (req) => {
    const p = await authClient(s, req);
    const { c, id } = parse(docParams, req.params);
    const { stateVector } = parse(z.object({ stateVector: b64 }), req.body);
    const mode = accessFor(p.claims.access, c, id);
    await syncLimit(req, p.tenantId);
    const hot = await s.docs.open(p.tenantId, c, id, mode === 'rw');
    const r = s.docs.syncStep(hot, Buffer.from(stateVector, 'base64url'));
    return {
      update: Buffer.from(r.update).toString('base64url'),
      seq: hot.headSeq,
      stateVector: Buffer.from(r.stateVector).toString('base64url'),
    };
  });

  app.post('/sync/:c/:id/push', async (req) => {
    const p = await authClient(s, req);
    const { c, id } = parse(docParams, req.params);
    const b = parse(
      z.object({
        clientId: z.string().min(1).max(128),
        opId: z.string().min(1).max(200),
        update: b64,
      }),
      req.body,
    );
    if (accessFor(p.claims.access, c, id) !== 'rw')
      throw new SyncraError('FORBIDDEN', 'Read-only access');
    await syncLimit(req, p.tenantId);
    const hot = await s.docs.open(p.tenantId, c, id, true);
    return { seq: await s.docs.write(hot, b.clientId, b.opId, Buffer.from(b.update, 'base64url')) };
  });
}
