/**
 * Change feed (DAT-08): per-shard `changes` rows merged into one ordered stream. The opaque cursor holds
 * the last change_id consumed on every shard, so a consumer that resumes with it sees each change once.
 */
import type pg from 'pg';
import { z } from 'zod';
import { SyncraError } from '@syncra/shared';

export type Cursor = Record<string, number>;

const cursorSchema = z.record(z.string().regex(/^\d+$/), z.number().int().nonnegative());

export const encodeCursor = (c: Cursor): string =>
  Buffer.from(JSON.stringify(c)).toString('base64url');

export function decodeCursor(raw: string | undefined): Cursor {
  if (!raw) return {};
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    throw new SyncraError('VALIDATION_FAILED', 'Invalid cursor');
  }
}

export interface ChangeItem {
  kind: 'create' | 'update' | 'delete';
  collection: string;
  docId: string;
  seq: number | null;
  at: string;
}

interface Row {
  change_id: string;
  collection: string;
  doc_id: string;
  kind: ChangeItem['kind'];
  seq: string | null;
  created_at: Date;
}

/**
 * Reads up to `limit` changes after `cursor`. Each shard's rows stay in change_id order and shards are
 * merged by created_at (then shard, then id) by repeatedly taking the oldest head, so what is consumed
 * from any shard is always a prefix of its rows and the per-shard cursor can never skip a change.
 */
export async function readChanges(
  shards: pg.Pool[],
  tenantId: string,
  opts: { collection?: string; cursor: Cursor; limit: number },
): Promise<{ items: ChangeItem[]; nextCursor: string; cursors: string[] }> {
  const lists = await Promise.all(
    shards.map((s, i) =>
      s
        .query<Row>(
          `select change_id, collection, doc_id, kind, seq, created_at from changes
           where tenant_id = $1 and ($2::text is null or collection = $2) and change_id > $3
           order by change_id limit $4`,
          [tenantId, opts.collection ?? null, opts.cursor[String(i)] ?? 0, opts.limit],
        )
        .then((r) => r.rows),
    ),
  );
  const next: Cursor = { ...opts.cursor };
  const pos = lists.map(() => 0);
  const items: ChangeItem[] = [];
  /** cursors[i] resumes immediately after items[i]; used as the SSE event id. */
  const cursors: string[] = [];
  while (items.length < opts.limit) {
    let best = -1;
    for (let i = 0; i < lists.length; i++) {
      const head = lists[i]?.[pos[i] as number];
      if (!head) continue;
      const cur = best >= 0 ? (lists[best]?.[pos[best] as number] as Row) : undefined;
      if (!cur || head.created_at < cur.created_at) best = i;
    }
    if (best < 0) break;
    const r = lists[best]?.[pos[best] as number] as Row;
    pos[best] = (pos[best] as number) + 1;
    next[String(best)] = Number(r.change_id);
    cursors.push(encodeCursor(next));
    items.push({
      kind: r.kind,
      collection: r.collection,
      docId: r.doc_id,
      seq: r.seq === null ? null : Number(r.seq),
      at: r.created_at.toISOString(),
    });
  }
  return { items, nextCursor: encodeCursor(next), cursors };
}
