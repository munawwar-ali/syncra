/** Hash-chained audit log of administrative actions (AUT-08): hash = sha256(prev_hash || canonical row). */
import pg from 'pg';
import { sha256 } from '../auth/crypto.js';

export interface AuditEntry {
  tenantId: string;
  actorType: 'user' | 'api_key' | 'system';
  actorId: string;
  action: string;
  target?: string;
  meta?: Record<string, unknown>;
}

/** Stable JSON: keys sorted at every level so the same data always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return v === undefined ? 'null' : JSON.stringify(v);
}

export function rowHash(prev: Buffer | null, e: AuditEntry, createdAtIso: string): Buffer {
  const body = canonicalJson({
    tenantId: e.tenantId,
    actorType: e.actorType,
    actorId: e.actorId,
    action: e.action,
    target: e.target ?? null,
    meta: e.meta ?? {},
    createdAt: createdAtIso,
  });
  return sha256(Buffer.concat([prev ?? Buffer.alloc(0), Buffer.from(body)]));
}

/** Appends an entry; an advisory lock per tenant keeps the chain linear under concurrency. */
export async function appendAudit(db: pg.Pool | pg.PoolClient, e: AuditEntry): Promise<void> {
  // A Pool gets its own transaction; a PoolClient is already inside the caller's transaction.
  const own = db instanceof pg.Pool;
  const c = db instanceof pg.Pool ? await db.connect() : db;
  try {
    if (own) await c.query('begin');
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [`audit:${e.tenantId}`]);
    const prev = await c.query<{ hash: Buffer }>(
      'select hash from audit_log where tenant_id = $1 order by id desc limit 1',
      [e.tenantId],
    );
    const prevHash = prev.rows[0]?.hash ?? null;
    // Millisecond precision so the value hashed here equals the one read back from timestamptz.
    const createdAt = new Date();
    await c.query(
      `insert into audit_log (tenant_id, actor_type, actor_id, action, target, meta, prev_hash, hash, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        e.tenantId,
        e.actorType,
        e.actorId,
        e.action,
        e.target ?? null,
        JSON.stringify(e.meta ?? {}),
        prevHash,
        rowHash(prevHash, e, createdAt.toISOString()),
        createdAt,
      ],
    );
    if (own) await c.query('commit');
  } catch (err) {
    if (own) await c.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    if (own) c.release();
  }
}

export interface AuditRow {
  id: number;
  actorType: string;
  actorId: string;
  action: string;
  target: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

export async function listAudit(
  pool: pg.Pool,
  tenantId: string,
  limit: number,
  beforeId?: number,
): Promise<{ items: AuditRow[]; nextCursor: string | null }> {
  const { rows } = await pool.query<{
    id: string;
    actor_type: string;
    actor_id: string;
    action: string;
    target: string | null;
    meta: Record<string, unknown>;
    created_at: Date;
  }>(
    `select id, actor_type, actor_id, action, target, meta, created_at from audit_log
     where tenant_id = $1 and ($2::bigint is null or id < $2) order by id desc limit $3`,
    [tenantId, beforeId ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => ({
      id: Number(r.id),
      actorType: r.actor_type,
      actorId: r.actor_id,
      action: r.action,
      target: r.target,
      meta: r.meta,
      createdAt: r.created_at.toISOString(),
    })),
    nextCursor: rows.length > limit ? String(page.at(-1)?.id) : null,
  };
}

/** Recomputes the chain; returns the id of the first broken row, if any. */
export async function verifyAudit(
  pool: pg.Pool,
  tenantId: string,
): Promise<{ valid: boolean; brokenAtId: number | null }> {
  const { rows } = await pool.query<{
    id: string;
    actor_type: AuditEntry['actorType'];
    actor_id: string;
    action: string;
    target: string | null;
    meta: Record<string, unknown>;
    prev_hash: Buffer | null;
    hash: Buffer;
    created_at: Date;
  }>('select * from audit_log where tenant_id = $1 order by id', [tenantId]);
  let prev: Buffer | null = null;
  for (const r of rows) {
    const expected = rowHash(
      prev,
      {
        tenantId,
        actorType: r.actor_type,
        actorId: r.actor_id,
        action: r.action,
        target: r.target ?? undefined,
        meta: r.meta,
      },
      r.created_at.toISOString(),
    );
    const linked =
      (r.prev_hash === null && prev === null) ||
      (r.prev_hash?.equals(prev ?? Buffer.alloc(0)) ?? false);
    if (!linked || !expected.equals(r.hash)) return { valid: false, brokenAtId: Number(r.id) };
    prev = r.hash;
  }
  return { valid: true, brokenAtId: null };
}
