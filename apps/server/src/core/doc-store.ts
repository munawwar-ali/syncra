/**
 * Durable document storage on one shard: create, load (snapshot + tail) and append ops with
 * server-assigned gap-free seq (Doc 02 §4.3, §4.4). Every function takes tenantId explicitly.
 */
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import * as Y from 'yjs';
import { SyncraError } from '@syncra/shared';

export interface DocRef {
  uid: string;
  headSeq: number;
  created: boolean;
}

/** Finds or creates the document row. Soft-deleted documents are NOT_FOUND. */
export async function ensureDocument(
  pool: pg.Pool,
  tenantId: string,
  collection: string,
  docId: string,
): Promise<DocRef> {
  const { rows } = await pool.query<{
    uid: string;
    head_seq: string;
    deleted_at: Date | null;
    created: boolean;
  }>(
    `insert into documents (uid, tenant_id, collection, doc_id) values ($1, $2, $3, $4)
     on conflict (tenant_id, collection, doc_id) do update set doc_id = excluded.doc_id
     returning uid, head_seq, deleted_at, (xmax = 0) as created`,
    [uuidv7(), tenantId, collection, docId],
  );
  const r = rows[0];
  if (!r || r.deleted_at) throw new SyncraError('NOT_FOUND', 'Document not found');
  return { uid: r.uid, headSeq: Number(r.head_seq), created: r.created };
}

/** Looks up an existing, non-deleted document without creating it. */
export async function findDocument(
  pool: pg.Pool,
  tenantId: string,
  collection: string,
  docId: string,
): Promise<DocRef | null> {
  const { rows } = await pool.query<{ uid: string; head_seq: string }>(
    `select uid, head_seq from documents
     where tenant_id = $1 and collection = $2 and doc_id = $3 and deleted_at is null`,
    [tenantId, collection, docId],
  );
  const r = rows[0];
  return r ? { uid: r.uid, headSeq: Number(r.head_seq), created: false } : null;
}

export interface LoadedDoc {
  doc: Y.Doc;
  headSeq: number;
  /** Ops read from the log after the snapshot; shows the snapshot shortcut works. */
  opsRead: number;
}

/** Latest snapshot plus the ops after it, merged into a fresh gc-enabled Y.Doc. */
export async function loadDoc(pool: pg.Pool, tenantId: string, uid: string): Promise<LoadedDoc> {
  const doc = new Y.Doc({ gc: true });
  const snap = await pool.query<{ up_to_seq: string; state: Buffer }>(
    `select up_to_seq, state from snapshots where doc_uid = $1 and tenant_id = $2
     order by up_to_seq desc limit 1`,
    [uid, tenantId],
  );
  const snapshot = snap.rows[0];
  if (snapshot) Y.applyUpdate(doc, snapshot.state);
  const after = snapshot ? Number(snapshot.up_to_seq) : 0;
  const ops = await pool.query<{ seq: string; update: Buffer }>(
    `select seq, update from operations where doc_uid = $1 and tenant_id = $2 and seq > $3
     order by seq`,
    [uid, tenantId, after],
  );
  doc.transact(() => {
    for (const op of ops.rows) Y.applyUpdate(doc, op.update);
  });
  const head = await pool.query<{ head_seq: string }>(
    'select head_seq from documents where uid = $1 and tenant_id = $2',
    [uid, tenantId],
  );
  return {
    doc,
    headSeq: Number(head.rows[0]?.head_seq ?? 0),
    opsRead: ops.rows.length,
  };
}

export interface AppendItem {
  clientId: string;
  opId: string;
  update: Uint8Array;
}

export interface AppendResult {
  /** `${clientId}\0${opId}` -> seq, for every item including duplicates. */
  seqs: Map<string, number>;
  /** Seq of the new op row, or null when every item was a duplicate. */
  newSeq: number | null;
  /** Merge of the previously unseen updates (what to broadcast), or null. */
  merged: Uint8Array | null;
}

export const opKey = (clientId: string, opId: string): string => `${clientId}\u0000${opId}`;

/**
 * Persists a batch as one op row. The document row lock serializes writers, so seq is gap-free;
 * op_dedup makes re-sent (clientId, opId) pairs return their original seq without a new row.
 */
export async function appendOps(
  pool: pg.Pool,
  tenantId: string,
  docUid: string,
  items: AppendItem[],
): Promise<AppendResult> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const locked = await client.query(
      'select 1 from documents where uid = $1 and tenant_id = $2 for update',
      [docUid, tenantId],
    );
    if (locked.rowCount === 0) throw new SyncraError('NOT_FOUND', 'Document not found');

    const seqs = new Map<string, number>();
    const fresh = new Map<string, AppendItem>();
    for (const it of items) {
      const prior = await client.query<{ seq: string }>(
        'select seq from op_dedup where doc_uid = $1 and client_id = $2 and op_id = $3',
        [docUid, it.clientId, it.opId],
      );
      const k = opKey(it.clientId, it.opId);
      if (prior.rows[0]) seqs.set(k, Number(prior.rows[0].seq));
      else fresh.set(k, it);
    }
    if (fresh.size === 0) {
      await client.query('commit');
      return { seqs, newSeq: null, merged: null };
    }

    const list = [...fresh.values()];
    const merged =
      list.length === 1
        ? (list[0] as AppendItem).update
        : Y.mergeUpdates(list.map((i) => i.update));
    const clientIds = new Set(list.map((i) => i.clientId));
    const head = await client.query<{ head_seq: string }>(
      `update documents set head_seq = head_seq + 1, size_bytes = size_bytes + $3, updated_at = now()
       where uid = $1 and tenant_id = $2 returning head_seq`,
      [docUid, tenantId, merged.length],
    );
    const seq = Number(head.rows[0]?.head_seq);
    await client.query(
      `insert into operations (doc_uid, seq, tenant_id, client_id, op_refs, update, size)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        docUid,
        seq,
        tenantId,
        clientIds.size === 1 ? [...clientIds][0] : 'multi',
        list.map((i) => i.opId),
        Buffer.from(merged),
        merged.length,
      ],
    );
    for (const it of list) {
      await client.query(
        'insert into op_dedup (doc_uid, client_id, op_id, seq) values ($1, $2, $3, $4)',
        [docUid, it.clientId, it.opId, seq],
      );
      seqs.set(opKey(it.clientId, it.opId), seq);
    }
    await client.query('commit');
    return { seqs, newSeq: seq, merged };
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
