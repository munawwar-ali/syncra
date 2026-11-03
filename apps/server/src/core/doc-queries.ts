/** Read-side queries for the REST API. Documents of one tenant can live on any shard, so these fan out and merge. */
import type pg from 'pg';
import * as Y from 'yjs';
import { INDEX_COLLECTION } from '@syncra/shared';
import type { ShardRing } from '../shards/ring.js';

export interface DocMeta {
  id: string;
  collection: string;
  seq: number;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  collection: string;
  doc_id: string;
  head_seq: string;
  size_bytes: string;
  created_at: Date;
  updated_at: Date;
}

const toMeta = (r: Row): DocMeta => ({
  id: r.doc_id,
  collection: r.collection,
  seq: Number(r.head_seq),
  sizeBytes: Number(r.size_bytes),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

export async function getDocMeta(
  shards: pg.Pool[],
  ring: ShardRing,
  tenantId: string,
  collection: string,
  docId: string,
): Promise<DocMeta | null> {
  const { rows } = await (shards[ring.route(tenantId, collection, docId)] as pg.Pool).query<Row>(
    `select collection, doc_id, head_seq, size_bytes, created_at, updated_at from documents
     where tenant_id = $1 and collection = $2 and doc_id = $3 and deleted_at is null`,
    [tenantId, collection, docId],
  );
  return rows[0] ? toMeta(rows[0]) : null;
}

export async function listCollections(shards: pg.Pool[], tenantId: string) {
  const parts = await Promise.all(
    shards.map((s) =>
      s.query<{ collection: string; n: string; bytes: string }>(
        `select collection, count(*)::text n, coalesce(sum(size_bytes),0)::text bytes from documents
         where tenant_id = $1 and deleted_at is null and collection <> $2 group by collection`,
        [tenantId, INDEX_COLLECTION],
      ),
    ),
  );
  const merged = new Map<string, { name: string; documents: number; sizeBytes: number }>();
  for (const { rows } of parts) {
    for (const r of rows) {
      const m = merged.get(r.collection) ?? { name: r.collection, documents: 0, sizeBytes: 0 };
      m.documents += Number(r.n);
      m.sizeBytes += Number(r.bytes);
      merged.set(r.collection, m);
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Pages by doc id. The cursor is the last doc id returned; each shard is read past it and the results are merged. */
export async function listDocs(
  shards: pg.Pool[],
  tenantId: string,
  collection: string,
  opts: { limit: number; cursor?: string; prefix?: string; updatedSince?: Date },
): Promise<{ items: DocMeta[]; nextCursor: string | null }> {
  const parts = await Promise.all(
    shards.map((s) =>
      s.query<Row>(
        `select collection, doc_id, head_seq, size_bytes, created_at, updated_at from documents
         where tenant_id = $1 and collection = $2 and deleted_at is null
           and ($3::text is null or doc_id > $3)
           and ($4::text is null or starts_with(doc_id, $4))
           and ($5::timestamptz is null or updated_at >= $5)
         order by doc_id limit $6`,
        [
          tenantId,
          collection,
          opts.cursor ?? null,
          opts.prefix ?? null,
          opts.updatedSince ?? null,
          opts.limit + 1,
        ],
      ),
    ),
  );
  const all = parts
    .flatMap((p) => p.rows)
    .sort((a, b) => (a.doc_id < b.doc_id ? -1 : a.doc_id > b.doc_id ? 1 : 0));
  const page = all.slice(0, opts.limit);
  return {
    items: page.map(toMeta),
    nextCursor: all.length > opts.limit ? (page.at(-1)?.doc_id ?? null) : null,
  };
}

/**
 * JSON view of a document using the root-type conventions (Doc 03 §4.3): data=Map, text=Text,
 * list=Array, content=XmlFragment. Roots that the document does not contain are omitted.
 */
export function docToJson(doc: Y.Doc): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (doc.share.has('data')) out.data = doc.getMap('data').toJSON();
  if (doc.share.has('text')) out.text = doc.getText('text').toJSON();
  if (doc.share.has('list')) out.list = doc.getArray('list').toJSON();
  if (doc.share.has('content')) out.content = doc.getXmlFragment('content').toJSON();
  return out;
}
