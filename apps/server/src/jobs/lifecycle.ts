/**
 * Document lifecycle jobs (Doc 02 §4.7-4.9): snapshots, compaction, history checkpoints, materialized
 * views and purge. All functions take their dependencies explicitly so the worker, the admin CLI and
 * the tests drive the same code.
 */
import type { Redis } from 'ioredis';
import type pg from 'pg';
import * as Y from 'yjs';
import { INDEX_COLLECTION } from '@syncra/shared';
import { docToJson } from '../core/doc-queries.js';
import { loadDoc } from '../core/doc-store.js';

export interface DocRef {
  uid: string;
  tenantId: string;
}

const LOCK_MS = 120_000;

async function withLock<T>(redis: Redis, uid: string, fn: () => Promise<T>): Promise<T | null> {
  const key = `sx:lock:compact:${uid}`;
  if ((await redis.set(key, '1', 'PX', LOCK_MS, 'NX')) !== 'OK') return null;
  try {
    return await fn();
  } finally {
    await redis.del(key);
  }
}

/** Logical stored size of a document: snapshots plus the op rows that still exist. */
async function recomputeSize(shard: pg.Pool, d: DocRef): Promise<number> {
  const { rows } = await shard.query<{ size: string }>(
    `update documents set size_bytes =
       (select coalesce(sum(size),0) from operations where doc_uid = $1)
       + (select coalesce(sum(size),0) from snapshots where doc_uid = $1)
     where uid = $1 and tenant_id = $2 returning size_bytes::text size`,
    [d.uid, d.tenantId],
  );
  return Number(rows[0]?.size ?? 0);
}

/** Inserts a snapshot row; if one already exists at this seq, keeps its state and upgrades the kind to checkpoint when asked. */
async function putSnapshot(
  shard: pg.Pool,
  d: DocRef,
  upToSeq: number,
  kind: 'compaction' | 'checkpoint',
  state: Uint8Array,
): Promise<void> {
  await shard.query(
    `insert into snapshots (doc_uid, up_to_seq, tenant_id, kind, state, size) values ($1,$2,$3,$4,$5,$6)
     on conflict (doc_uid, up_to_seq) do update set
       kind = case when snapshots.kind = 'checkpoint' or excluded.kind = 'checkpoint' then 'checkpoint' else 'compaction' end`,
    [d.uid, upToSeq, d.tenantId, kind, Buffer.from(state), state.length],
  );
}

/** Reads a consistent view (head, latest snapshot, tail ops) and returns the merged state at head. */
async function stateAtHead(
  shard: pg.Pool,
  d: DocRef,
): Promise<{ seq: number; state: Uint8Array } | null> {
  const c = await shard.connect();
  try {
    await c.query('begin isolation level repeatable read read only');
    const head = await c.query<{ head_seq: string; snapshot_seq: string }>(
      'select head_seq, snapshot_seq from documents where uid = $1 and tenant_id = $2 and deleted_at is null',
      [d.uid, d.tenantId],
    );
    const h = head.rows[0];
    if (!h) return null;
    const target = Number(h.head_seq);
    const snap = await c.query<{ up_to_seq: string; state: Buffer }>(
      `select up_to_seq, state from snapshots where doc_uid = $1 and tenant_id = $2 and up_to_seq <= $3
       order by up_to_seq desc limit 1`,
      [d.uid, d.tenantId, target],
    );
    const base = snap.rows[0];
    const ops = await c.query<{ update: Buffer }>(
      'select update from operations where doc_uid = $1 and tenant_id = $2 and seq > $3 and seq <= $4 order by seq',
      [d.uid, d.tenantId, base ? Number(base.up_to_seq) : 0, target],
    );
    await c.query('commit');
    const doc = new Y.Doc({ gc: true });
    if (base) Y.applyUpdate(doc, base.state);
    doc.transact(() => {
      for (const o of ops.rows) Y.applyUpdate(doc, o.update);
    });
    return { seq: target, state: Y.encodeStateAsUpdate(doc) };
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export interface SnapshotResult {
  upToSeq: number;
  bytes: number;
}

/** DAT-01: writes a compaction snapshot at the current head. Returns null when nothing new or locked. */
export async function snapshotDoc(
  shard: pg.Pool,
  redis: Redis,
  d: DocRef,
): Promise<SnapshotResult | null> {
  return withLock(redis, d.uid, async () => {
    const s = await stateAtHead(shard, d);
    if (!s || s.seq === 0) return null;
    const prior = await shard.query<{ snapshot_seq: string }>(
      'select snapshot_seq from documents where uid = $1',
      [d.uid],
    );
    if (Number(prior.rows[0]?.snapshot_seq ?? 0) >= s.seq) return null;
    await putSnapshot(shard, d, s.seq, 'compaction', s.state);
    await shard.query(
      'update documents set snapshot_seq = $2 where uid = $1 and snapshot_seq < $2',
      [d.uid, s.seq],
    );
    // Older compaction snapshots are superseded; checkpoints are history and stay.
    await shard.query(
      `delete from snapshots where doc_uid = $1 and kind = 'compaction' and up_to_seq < $2`,
      [d.uid, s.seq],
    );
    await recomputeSize(shard, d);
    return { upToSeq: s.seq, bytes: s.state.length };
  });
}

export interface CompactResult {
  deleted: number;
  bytesBefore: number;
  bytesAfter: number;
  /** False means the safety check failed and nothing was deleted. */
  verified: boolean;
}

/**
 * DAT-02 / DAT-10: deletes ops that the snapshot already covers and that retention allows.
 * An op is deletable when `seq <= snapshot_seq` and it is older than the history window or lies at or
 * below a retained checkpoint. Before deleting anything, the candidates are replayed on top of the
 * snapshot; if that changes the state at all the snapshot is missing data, and the job aborts.
 */
export async function compactDoc(
  shard: pg.Pool,
  redis: Redis,
  d: DocRef,
  retentionDays: number,
  now: Date = new Date(),
): Promise<CompactResult | null> {
  return withLock(redis, d.uid, async () => {
    const meta = await shard.query<{ snapshot_seq: string; size_bytes: string }>(
      'select snapshot_seq, size_bytes::text from documents where uid = $1 and tenant_id = $2',
      [d.uid, d.tenantId],
    );
    const snapshotSeq = Number(meta.rows[0]?.snapshot_seq ?? 0);
    const bytesBefore = Number(meta.rows[0]?.size_bytes ?? 0);
    if (snapshotSeq === 0)
      return { deleted: 0, bytesBefore, bytesAfter: bytesBefore, verified: true };

    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    const cp = await shard.query<{ seq: string | null }>(
      `select max(up_to_seq)::text seq from snapshots where doc_uid = $1 and kind = 'checkpoint' and up_to_seq <= $2`,
      [d.uid, snapshotSeq],
    );
    const coveredBy = Number(cp.rows[0]?.seq ?? 0);
    const candidates = await shard.query<{ update: Buffer }>(
      `select update from operations where doc_uid = $1 and tenant_id = $2 and seq <= $3
         and (created_at < $4 or seq <= $5) order by seq`,
      [d.uid, d.tenantId, snapshotSeq, cutoff, coveredBy],
    );
    if (candidates.rows.length === 0)
      return { deleted: 0, bytesBefore, bytesAfter: bytesBefore, verified: true };

    // Pre-flight: snapshot (+) candidates must equal snapshot alone.
    const snap = await shard.query<{ state: Buffer }>(
      'select state from snapshots where doc_uid = $1 and tenant_id = $2 and up_to_seq = $3',
      [d.uid, d.tenantId, snapshotSeq],
    );
    if (!snap.rows[0]) return { deleted: 0, bytesBefore, bytesAfter: bytesBefore, verified: false };
    const base = new Y.Doc({ gc: true });
    Y.applyUpdate(base, snap.rows[0].state);
    const expected = Y.encodeStateAsUpdate(base);
    const replay = new Y.Doc({ gc: true });
    Y.applyUpdate(replay, snap.rows[0].state);
    for (const c of candidates.rows) Y.applyUpdate(replay, c.update);
    if (!equalBytes(Y.encodeStateAsUpdate(replay), expected)) {
      return { deleted: 0, bytesBefore, bytesAfter: bytesBefore, verified: false };
    }

    const before = await loadDoc(shard, d.tenantId, d.uid);
    const beforeVector = Y.encodeStateVector(before.doc);
    let deleted = 0;
    for (;;) {
      const r = await shard.query(
        `delete from operations where doc_uid = $1 and tenant_id = $2 and seq in (
           select seq from operations where doc_uid = $1 and tenant_id = $2 and seq <= $3
             and (created_at < $4 or seq <= $5) order by seq limit 1000)`,
        [d.uid, d.tenantId, snapshotSeq, cutoff, coveredBy],
      );
      deleted += r.rowCount ?? 0;
      if ((r.rowCount ?? 0) < 1000) break;
    }
    const after = await loadDoc(shard, d.tenantId, d.uid);
    const verified = equalBytes(Y.encodeStateVector(after.doc), beforeVector);
    const bytesAfter = await recomputeSize(shard, d);
    return { deleted, bytesBefore, bytesAfter, verified };
  });
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** DAT-04: records a history checkpoint at head if there is new activity since the last one. */
export async function checkpointDoc(
  shard: pg.Pool,
  d: DocRef,
  retentionDays: number,
  now: Date = new Date(),
): Promise<{ seq: number } | null> {
  const last = await shard.query<{ seq: string | null }>(
    `select max(up_to_seq)::text seq from snapshots where doc_uid = $1 and kind = 'checkpoint'`,
    [d.uid],
  );
  const s = await stateAtHead(shard, d);
  if (!s || s.seq === 0 || s.seq <= Number(last.rows[0]?.seq ?? 0)) return null;
  await putSnapshot(shard, d, s.seq, 'checkpoint', s.state);
  // Expire checkpoints past the plan's window, but never the newest snapshot (loadDoc depends on it).
  await shard.query(
    `delete from snapshots where doc_uid = $1 and kind = 'checkpoint' and created_at < $2
       and up_to_seq < (select max(up_to_seq) from snapshots where doc_uid = $1)`,
    [d.uid, new Date(now.getTime() - retentionDays * 86_400_000)],
  );
  await recomputeSize(shard, d);
  return { seq: s.seq };
}

/** DAT-03 / DAT-08: refreshes document_views for documents that changed at least a second ago and records update events. */
export async function materializeDue(shard: pg.Pool, limit = 100): Promise<number> {
  const due = await shard.query<{
    uid: string;
    tenant_id: string;
    collection: string;
    doc_id: string;
    head_seq: string;
  }>(
    `select d.uid, d.tenant_id, d.collection, d.doc_id, d.head_seq from documents d
     left join document_views v on v.doc_uid = d.uid
     where d.deleted_at is null and d.collection <> $1 and (v.seq is null or v.seq < d.head_seq)
       and d.updated_at < now() - interval '1 second'
     order by d.updated_at limit $2`,
    [INDEX_COLLECTION, limit],
  );
  for (const r of due.rows) {
    const loaded = await loadDoc(shard, r.tenant_id, r.uid);
    const seq = Number(r.head_seq);
    await shard.query(
      `insert into document_views (doc_uid, tenant_id, seq, json) values ($1,$2,$3,$4)
       on conflict (doc_uid) do update set seq = excluded.seq, json = excluded.json, updated_at = now()`,
      [r.uid, r.tenant_id, seq, JSON.stringify(docToJson(loaded.doc))],
    );
    if (seq > 0) {
      await shard.query(
        `insert into changes (tenant_id, collection, doc_id, kind, seq) values ($1,$2,$3,'update',$4)`,
        [r.tenant_id, r.collection, r.doc_id, seq],
      );
    }
  }
  return due.rows.length;
}

/** DAT-07: hard-deletes documents soft-deleted before `olderThan`, and old dedup rows. */
export async function purgeDeleted(
  shards: pg.Pool[],
  olderThan: Date,
  dedupOlderThan: Date,
): Promise<{ documents: number; dedupRows: number }> {
  let documents = 0;
  let dedupRows = 0;
  for (const shard of shards) {
    const gone = await shard.query<{ uid: string }>(
      'select uid from documents where deleted_at is not null and deleted_at < $1',
      [olderThan],
    );
    for (const { uid } of gone.rows) {
      const c = await shard.connect();
      try {
        await c.query('begin');
        for (const t of ['operations', 'op_dedup', 'snapshots', 'document_views']) {
          await c.query(`delete from ${t} where doc_uid = $1`, [uid]);
        }
        await c.query('delete from documents where uid = $1', [uid]);
        await c.query('commit');
        documents++;
      } catch (e) {
        await c.query('rollback').catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
    }
    const r = await shard.query('delete from op_dedup where created_at < $1', [dedupOlderThan]);
    dedupRows += r.rowCount ?? 0;
  }
  return { documents, dedupRows };
}

export interface MaintainOptions {
  everyOps: number;
  everyBytes: number;
  idleMs: number;
  checkpointMs: number;
  /** History window in days for a tenant. */
  retentionDays: (tenantId: string) => Promise<number>;
  limit?: number;
}

export interface MaintainStats {
  snapshots: number;
  compactions: number;
  rowsDeleted: number;
  bytesReclaimed: number;
  verifyFailures: number;
  checkpoints: number;
  materialized: number;
}

/** One pass of everything a shard needs: triggers snapshots, compacts, checkpoints and refreshes views. */
export async function maintainShard(
  shard: pg.Pool,
  redis: Redis,
  o: MaintainOptions,
): Promise<MaintainStats> {
  const stats: MaintainStats = {
    snapshots: 0,
    compactions: 0,
    rowsDeleted: 0,
    bytesReclaimed: 0,
    verifyFailures: 0,
    checkpoints: 0,
    materialized: 0,
  };
  const limit = o.limit ?? 200;

  const snapDue = await shard.query<{ uid: string; tenant_id: string }>(
    `select d.uid, d.tenant_id from documents d
     where d.deleted_at is null and d.head_seq > d.snapshot_seq and (
       d.head_seq - d.snapshot_seq >= $1
       or d.updated_at < now() - make_interval(secs => $2::double precision / 1000)
       or (select coalesce(sum(size),0) from operations x where x.doc_uid = d.uid and x.seq > d.snapshot_seq) >= $3)
     limit $4`,
    [o.everyOps, o.idleMs, o.everyBytes, limit],
  );
  const cpDue = await shard.query<{ uid: string; tenant_id: string }>(
    `select d.uid, d.tenant_id from documents d
     where d.deleted_at is null and d.head_seq > 0
       and d.head_seq > coalesce((select max(up_to_seq) from snapshots s where s.doc_uid = d.uid and s.kind = 'checkpoint'), 0)
       and not exists (select 1 from snapshots s where s.doc_uid = d.uid and s.kind = 'checkpoint'
                       and s.created_at > now() - make_interval(secs => $1::double precision / 1000))
     limit $2`,
    [o.checkpointMs, limit],
  );

  for (const r of cpDue.rows) {
    const d = { uid: r.uid, tenantId: r.tenant_id };
    if (await checkpointDoc(shard, d, await o.retentionDays(d.tenantId))) stats.checkpoints++;
  }
  for (const r of snapDue.rows) {
    const d = { uid: r.uid, tenantId: r.tenant_id };
    if (!(await snapshotDoc(shard, redis, d))) continue;
    stats.snapshots++;
    const c = await compactDoc(shard, redis, d, await o.retentionDays(d.tenantId));
    if (!c) continue;
    stats.compactions++;
    stats.rowsDeleted += c.deleted;
    stats.bytesReclaimed += Math.max(0, c.bytesBefore - c.bytesAfter);
    if (!c.verified) stats.verifyFailures++;
  }
  stats.materialized = await materializeDue(shard, limit);
  return stats;
}
