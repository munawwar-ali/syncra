import { afterAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { appendOps, ensureDocument, loadDoc } from '../src/core/doc-store.js';
import { makePools, newTenant } from './harness.js';

const [pool] = makePools();
const db = pool as NonNullable<typeof pool>;
afterAll(async () => {
  await db.end();
});

function updates(n: number): Uint8Array[] {
  const doc = new Y.Doc();
  const out: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => out.push(u));
  for (let i = 0; i < n; i++) doc.getText('t').insert(i, 'x');
  return out;
}

describe('A1-4 doc-store (SYN-07, SYN-08)', () => {
  it('concurrent writers get gap-free, strictly increasing seqs', async () => {
    const tenant = newTenant();
    const { uid } = await ensureDocument(db, tenant, 'notes', 'concurrent');
    const us = updates(20);
    const results = await Promise.all(
      us.map((update, i) =>
        appendOps(db, tenant, uid, [{ clientId: `c${String(i)}`, opId: 'o', update }]),
      ),
    );
    const seqs = results.map((r) => r.newSeq).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect((await loadDoc(db, tenant, uid)).headSeq).toBe(20);
  });

  it('loads from the latest snapshot and reads only the tail ops', async () => {
    const tenant = newTenant();
    const { uid } = await ensureDocument(db, tenant, 'notes', 'snap');
    const us = updates(10_000);
    for (let from = 0; from < us.length; from += 2000) {
      const chunk = us.slice(from, from + 2000);
      await db.query(
        `insert into operations (doc_uid, seq, tenant_id, client_id, op_refs, update, size)
         select $1, t.s, $2, 'seed', array['o' || t.s], t.u, length(t.u)
         from unnest($3::bigint[], $4::bytea[]) as t(s, u)`,
        [uid, tenant, chunk.map((_, i) => from + i + 1), chunk.map((u) => Buffer.from(u))],
      );
    }
    const upTo9500 = new Y.Doc();
    us.slice(0, 9500).forEach((u) => {
      Y.applyUpdate(upTo9500, u);
    });
    const state = Buffer.from(Y.encodeStateAsUpdate(upTo9500));
    await db.query(
      `insert into snapshots (doc_uid, up_to_seq, tenant_id, kind, state, size)
       values ($1, 9500, $2, 'compaction', $3, $4)`,
      [uid, tenant, state, state.length],
    );
    await db.query('update documents set head_seq = 10000, snapshot_seq = 9500 where uid = $1', [
      uid,
    ]);

    const loaded = await loadDoc(db, tenant, uid);
    expect(loaded.opsRead).toBe(500);
    expect(loaded.doc.getText('t').length).toBe(10_000);
    expect(loaded.headSeq).toBe(10_000);
  });

  it('never loads another tenant’s document', async () => {
    const tenant = newTenant();
    const { uid } = await ensureDocument(db, tenant, 'notes', 'private');
    await appendOps(db, tenant, uid, [
      { clientId: 'c', opId: 'o', update: updates(1)[0] as Uint8Array },
    ]);
    const stolen = await loadDoc(db, newTenant(), uid);
    expect(stolen.doc.getText('t').length).toBe(0);
    expect(stolen.headSeq).toBe(0);
  });
});
