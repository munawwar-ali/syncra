/** History, restore, export, raw ops and the change feed (Doc 03 §4.3, §4.5). */
import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';
import { z } from 'zod';
import { COLLECTION_REGEX, DOC_ID_REGEX, SyncraError, paginationSchema } from '@syncra/shared';
import { decodeCursor, readChanges } from '../core/changes.js';
import { docToJson } from '../core/doc-queries.js';
import { findDocument } from '../core/doc-store.js';
import type { Services } from '../services.js';
import { authDashboard, authSecretOrDashboard, parse, requireWrite } from './auth.js';

const collection = z
  .string()
  .regex(COLLECTION_REGEX)
  .refine((c) => !c.startsWith('__'), 'reserved prefix');
const docParams = z.object({ c: collection, id: z.string().regex(DOC_ID_REGEX) });

export const STREAM_POLL_MS = 1000;
const HEARTBEAT_MS = 15_000;

export function registerHistoryRoutes(app: FastifyInstance, s: Services): void {
  const shardOf = (tenantId: string, c: string, id: string) =>
    s.deps.shards[s.ring.route(tenantId, c, id)];

  const docRef = async (tenantId: string, c: string, id: string) => {
    const shard = shardOf(tenantId, c, id);
    const ref = shard ? await findDocument(shard, tenantId, c, id) : null;
    if (!shard || !ref) throw new SyncraError('NOT_FOUND', 'Document not found');
    return { shard, uid: ref.uid };
  };

  app.get('/collections/:c/docs/:id/history', async (req) => {
    const p = await authSecretOrDashboard(s, req);
    const { c, id } = parse(docParams, req.params);
    const { shard, uid } = await docRef(p.tenantId, c, id);
    const { rows } = await shard.query<{ up_to_seq: string; created_at: Date; size: number }>(
      `select up_to_seq, created_at, size from snapshots
       where doc_uid = $1 and tenant_id = $2 and kind = 'checkpoint' order by up_to_seq desc`,
      [uid, p.tenantId],
    );
    return {
      items: rows.map((r) => ({
        seq: Number(r.up_to_seq),
        createdAt: r.created_at.toISOString(),
        sizeBytes: r.size,
      })),
    };
  });

  app.get('/collections/:c/docs/:id/history/:seq', async (req) => {
    const p = await authSecretOrDashboard(s, req);
    const { c, id } = parse(docParams, req.params);
    const { seq } = parse(z.object({ seq: z.coerce.number().int().nonnegative() }), req.params);
    const { shard, uid } = await docRef(p.tenantId, c, id);
    const { rows } = await shard.query<{ up_to_seq: string; state: Buffer }>(
      `select up_to_seq, state from snapshots
       where doc_uid = $1 and tenant_id = $2 and kind = 'checkpoint' and up_to_seq <= $3
       order by up_to_seq desc limit 1`,
      [uid, p.tenantId, seq],
    );
    const cp = rows[0];
    if (!cp) throw new SyncraError('NOT_FOUND', 'No checkpoint at or before that seq');
    const doc = new Y.Doc();
    Y.applyUpdate(doc, cp.state);
    return { seq: Number(cp.up_to_seq), json: docToJson(doc) };
  });

  app.post('/collections/:c/docs/:id/restore', async (req) => {
    const p = await authSecretOrDashboard(s, req);
    requireWrite(p);
    const { c, id } = parse(docParams, req.params);
    const { seq } = parse(z.object({ seq: z.number().int().nonnegative() }), req.body);
    return { seq: await s.docs.restore(p.tenantId, c, id, seq) };
  });

  app.get('/collections/:c/docs/:id/ops', async (req) => {
    const p = await authDashboard(s, req);
    const { c, id } = parse(docParams, req.params);
    const q = parse(
      z.object({
        after: z.coerce.number().int().nonnegative().default(0),
        limit: paginationSchema.shape.limit,
      }),
      req.query,
    );
    const { shard, uid } = await docRef(p.tenantId, c, id);
    const { rows } = await shard.query<{
      seq: string;
      client_id: string;
      size: number;
      op_refs: string[];
      created_at: Date;
    }>(
      `select seq, client_id, size, op_refs, created_at from operations
       where doc_uid = $1 and tenant_id = $2 and seq > $3 order by seq limit $4`,
      [uid, p.tenantId, q.after, q.limit],
    );
    return {
      items: rows.map((r) => ({
        seq: Number(r.seq),
        clientId: r.client_id,
        sizeBytes: r.size,
        opCount: r.op_refs.length,
        at: r.created_at.toISOString(),
      })),
    };
  });

  app.get('/collections/:c/docs/:id/export', async (req, reply) => {
    const p = await authSecretOrDashboard(s, req);
    const { c, id } = parse(docParams, req.params);
    const { format } = parse(
      z.object({ format: z.enum(['json', 'yjs']).default('json') }),
      req.query,
    );
    const hot = await s.docs.open(p.tenantId, c, id, false);
    if (format === 'yjs') {
      return reply
        .type('application/octet-stream')
        .header('content-disposition', `attachment; filename="${c}-${id}.yjs"`)
        .send(Buffer.from(Y.encodeStateAsUpdate(hot.doc)));
    }
    return reply
      .header('content-disposition', `attachment; filename="${c}-${id}.json"`)
      .send(docToJson(hot.doc));
  });

  // ---- change feed ----------------------------------------------------------------------
  const feedQuery = z.object({
    collection: collection.optional(),
    cursor: z.string().max(1000).optional(),
    limit: paginationSchema.shape.limit,
  });

  app.get('/changes', async (req) => {
    const p = await authSecretOrDashboard(s, req);
    const q = parse(feedQuery, req.query);
    return readChanges(s.deps.shards, p.tenantId, {
      collection: q.collection,
      cursor: decodeCursor(q.cursor),
      limit: q.limit,
    });
  });

  app.get('/changes/stream', async (req, reply) => {
    const p = await authSecretOrDashboard(s, req);
    const q = parse(feedQuery, req.query);
    const lastEventId = req.headers['last-event-id'];
    let cursor = decodeCursor(typeof lastEventId === 'string' ? lastEventId : q.cursor);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let closed = false;
    const isClosed = (): boolean => closed; // set from the close handler, which TS cannot see
    let lastWrite = Date.now();
    req.raw.on('close', () => {
      closed = true;
    });
    while (!isClosed() && !s.docs.isStopped) {
      try {
        const r = await readChanges(s.deps.shards, p.tenantId, {
          collection: q.collection,
          cursor,
          limit: 100,
        });
        r.items.forEach((item, i) => {
          // Each event carries the cursor that resumes right after it, so Last-Event-ID is exact.
          res.write(
            `id: ${r.cursors[i] ?? r.nextCursor}\nevent: change\ndata: ${JSON.stringify(item)}\n\n`,
          );
        });
        if (r.items.length > 0) {
          cursor = decodeCursor(r.nextCursor);
          lastWrite = Date.now();
        }
        if (Date.now() - lastWrite >= HEARTBEAT_MS) {
          res.write(': heartbeat\n\n');
          lastWrite = Date.now();
        }
      } catch (e) {
        s.logger.warn({ err: e }, 'change stream poll failed');
      }
      await new Promise((resolve) => setTimeout(resolve, STREAM_POLL_MS));
    }
    res.end();
  });
}
