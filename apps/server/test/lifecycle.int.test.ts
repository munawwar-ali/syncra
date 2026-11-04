/** Phase 4 data lifecycle: A4-4 snapshots + compaction, A4-5 change feed, A4-6 history + restore, purge, export. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type pg from 'pg';
import { appendOps, ensureDocument, loadDoc } from '../src/core/doc-store.js';
import {
  checkpointDoc,
  compactDoc,
  materializeDue,
  purgeDeleted,
  snapshotDoc,
} from '../src/jobs/lifecycle.js';
import { newTenant } from './harness.js';
import { signup, startStack, type Account, type Stack } from './stack.js';

let st: Stack;
let a: Account;
beforeAll(async () => {
  st = await startStack();
  a = await signup(st.api);
});
afterAll(async () => {
  await st.close();
});

const redis = () => st.node.deps.redis;
const shardFor = (tenant: string, c: string, id: string): pg.Pool =>
  st.node.deps.shards[st.node.services.ring.route(tenant, c, id)] as pg.Pool;
const sk = () => ({ token: a.secretKey });

/** Applies an edit to a document through the real write path (batching, fan-out hooks, change rows). */
async function edit(
  tenant: string,
  c: string,
  id: string,
  fn: (y: Y.Doc) => void,
): Promise<number> {
  const hot = await st.node.services.docs.open(tenant, c, id, true);
  const y = new Y.Doc();
  Y.applyUpdate(y, Y.encodeStateAsUpdate(hot.doc));
  const before = Y.encodeStateVector(y);
  y.transact(() => {
    fn(y);
  });
  return st.node.services.docs.write(
    hot,
    'test',
    `e-${String(Math.random())}`,
    Y.encodeStateAsUpdate(y, before),
  );
}

describe('A4-4 snapshots and compaction (DAT-01, DAT-02, DAT-10)', () => {
  const tenant = newTenant();
  let shard: pg.Pool;
  beforeAll(() => {
    shard = shardFor(tenant, 'notes', 'heavy'); // the stack exists only once the outer beforeAll has run
  });
  let uid = '';
  let stateBefore: Uint8Array;

  it('a document with 20,000 ops is snapshotted, compacted, and loads from the snapshot plus a short tail', async () => {
    uid = (await ensureDocument(shard, tenant, 'notes', 'heavy')).uid;
    const doc = new Y.Doc();
    const updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    const t = doc.getText('t');
    for (let i = 0; i < 20_000; i++) {
      t.insert(Math.floor((i * 7) % (t.length + 1)), 'ab');
      if (i % 3 === 0 && t.length > 4) t.delete(i % (t.length - 1), 1); // tombstones for GC to reclaim
    }
    const rows = updates.length;
    expect(rows).toBeGreaterThanOrEqual(20_000);
    const used = updates.slice(0, 20_000);
    for (let from = 0; from < used.length; from += 2000) {
      const chunk = used.slice(from, from + 2000);
      await shard.query(
        `insert into operations (doc_uid, seq, tenant_id, client_id, op_refs, update, size)
         select $1, t.s, $2, 'seed', array['o' || t.s], t.u, length(t.u)
         from unnest($3::bigint[], $4::bytea[]) as t(s, u)`,
        [uid, tenant, chunk.map((_, i) => from + i + 1), chunk.map((u) => Buffer.from(u))],
      );
    }
    await shard.query(
      'update documents set head_seq = 20000, size_bytes = (select sum(size) from operations where doc_uid = $1) where uid = $1',
      [uid],
    );
    const full = await loadDoc(shard, tenant, uid);
    expect(full.opsRead).toBe(20_000);
    stateBefore = Y.encodeStateVector(full.doc);
    const sizeBefore = full.sizeBytes;

    const snap = await snapshotDoc(shard, redis(), { uid, tenantId: tenant });
    expect(snap?.upToSeq).toBe(20_000);
    expect(await snapshotDoc(shard, redis(), { uid, tenantId: tenant })).toBeNull(); // nothing new

    // A short tail arrives after the snapshot: the next 300 genuinely incremental updates of the same editor.
    for (const [i, u] of updates.slice(20_000, 20_300).entries()) {
      await appendOps(shard, tenant, uid, [{ clientId: 'tail', opId: `t${String(i)}`, update: u }]);
    }
    const expectedDoc = new Y.Doc();
    expectedDoc.transact(() => {
      updates.slice(0, 20_300).forEach((u) => {
        Y.applyUpdate(expectedDoc, u);
      });
    });

    const res = await compactDoc(shard, redis(), { uid, tenantId: tenant }, 0);
    expect(res?.verified).toBe(true);
    expect(res?.deleted).toBe(20_000);
    expect(res?.bytesAfter).toBeLessThan(sizeBefore);

    const after = await loadDoc(shard, tenant, uid);
    expect(after.opsRead).toBe(300); // under 600: snapshot + tail only
    expect(after.headSeq).toBe(20_300);
    const left = await shard.query<{ n: string }>(
      'select count(*)::text n from operations where doc_uid = $1',
      [uid],
    );
    expect(Number(left.rows[0]?.n)).toBe(300);
    // state vector and content equality with a plain replay of every update: nothing was lost
    expect(Y.encodeStateVector(after.doc)).toEqual(Y.encodeStateVector(expectedDoc));
    expect(after.doc.getText('t').toJSON()).toBe(expectedDoc.getText('t').toJSON());
    expect(stateBefore.length).toBeGreaterThan(0);
  }, 120_000);

  it('aborts without deleting anything when the snapshot does not contain the ops (verification)', async () => {
    const id = 'corrupt';
    const sh = shardFor(tenant, 'notes', id);
    const { uid: u } = await ensureDocument(sh, tenant, 'notes', id);
    const y = new Y.Doc();
    const ups: Uint8Array[] = [];
    y.on('update', (x: Uint8Array) => ups.push(x));
    for (let i = 0; i < 10; i++) y.getText('t').insert(i, 'x');
    for (const [i, up] of ups.entries()) {
      await appendOps(sh, tenant, u, [{ clientId: 'c', opId: `o${String(i)}`, update: up }]);
    }
    expect(await snapshotDoc(sh, redis(), { uid: u, tenantId: tenant })).not.toBeNull();
    // Simulate a buggy snapshot that lost the last edit.
    const partial = new Y.Doc();
    ups.slice(0, 9).forEach((x) => {
      Y.applyUpdate(partial, x);
    });
    await sh.query('update snapshots set state = $2 where doc_uid = $1', [
      u,
      Buffer.from(Y.encodeStateAsUpdate(partial)),
    ]);
    const res = await compactDoc(sh, redis(), { uid: u, tenantId: tenant }, 0);
    expect(res).toMatchObject({ deleted: 0, verified: false });
    const left = await sh.query<{ n: string }>(
      'select count(*)::text n from operations where doc_uid = $1',
      [u],
    );
    expect(Number(left.rows[0]?.n)).toBe(10);
  });

  it('keeps ops that are inside the history window and not covered by a checkpoint', async () => {
    const id = 'windowed';
    const sh = shardFor(tenant, 'notes', id);
    await edit(tenant, 'notes', id, (y) => {
      y.getText('t').insert(0, 'hello');
    });
    const { uid: u } = await ensureDocument(sh, tenant, 'notes', id);
    await snapshotDoc(sh, redis(), { uid: u, tenantId: tenant });
    const kept = await compactDoc(sh, redis(), { uid: u, tenantId: tenant }, 30);
    expect(kept?.deleted).toBe(0); // recent and no checkpoint
    await checkpointDoc(sh, { uid: u, tenantId: tenant }, 30);
    const covered = await compactDoc(sh, redis(), { uid: u, tenantId: tenant }, 30);
    expect(covered?.deleted).toBeGreaterThan(0); // now covered by a retained checkpoint
  });
});

describe('A4-6 history and restore (DAT-04, DAT-05)', () => {
  it('lists checkpoints, renders them as JSON, and restore is non-destructive', async () => {
    const id = 'hist';
    await edit(a.tenantId, 'records', id, (y) => {
      y.getMap('data').set('v', 1);
      y.getMap('data').set('keep', 'yes');
    });
    const sh = shardFor(a.tenantId, 'records', id);
    const { uid } = await ensureDocument(sh, a.tenantId, 'records', id);
    const d = { uid, tenantId: a.tenantId };
    const cp1 = await checkpointDoc(sh, d, 30);
    expect(cp1?.seq).toBe(1);
    expect(await checkpointDoc(sh, d, 30)).toBeNull(); // no new activity

    await edit(a.tenantId, 'records', id, (y) => {
      y.getMap('data').set('v', 2);
      y.getMap('data').delete('keep');
      y.getMap('data').set('added', true);
    });
    const cp2 = await checkpointDoc(sh, d, 30);
    expect(cp2?.seq).toBe(2);

    const list = await st.api('GET', `/v1/collections/records/docs/${id}/history`, sk());
    expect(list.body.items.map((i: { seq: number }) => i.seq)).toEqual([2, 1]);
    const at1 = await st.api('GET', `/v1/collections/records/docs/${id}/history/1`, sk());
    expect(at1.body.json.data).toEqual({ v: 1, keep: 'yes' });
    const nearest = await st.api('GET', `/v1/collections/records/docs/${id}/history/99`, sk());
    expect(nearest.body.seq).toBe(2); // nearest checkpoint at or before seq
    expect((await st.api('GET', `/v1/collections/records/docs/${id}/history/0`, sk())).status).toBe(
      404,
    );

    const restored = await st.api('POST', `/v1/collections/records/docs/${id}/restore`, {
      ...sk(),
      body: { seq: 1 },
    });
    expect(restored.status).toBe(200);
    expect(restored.body.seq).toBe(3);
    const now = await st.api('GET', `/v1/collections/records/docs/${id}`, sk());
    expect(now.body.json.data).toEqual({ v: 1, keep: 'yes' }); // content equals the checkpoint
    // history keeps both states
    const still2 = await st.api('GET', `/v1/collections/records/docs/${id}/history/2`, sk());
    expect(still2.body.json.data).toEqual({ v: 2, added: true });
    const ops = await st.api('GET', `/v1/collections/records/docs/${id}/ops`, {
      token: a.accessToken,
      tenant: a.tenantId,
    });
    expect(ops.body.items).toHaveLength(3);
    expect(ops.body.items[2].clientId).toBe('system:restore');
    expect(JSON.stringify(ops.body)).not.toContain('update');
  });

  it('restore needs write rights and an existing checkpoint', async () => {
    const other = await signup(st.api);
    expect(
      (
        await st.api('POST', '/v1/collections/records/docs/hist/restore', {
          token: other.secretKey,
          body: { seq: 1 },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await st.api('POST', '/v1/collections/records/docs/nope/restore', {
          ...sk(),
          body: { seq: 1 },
        })
      ).status,
    ).toBe(404);
  });
});

describe('export (DAT-09) and materialization (DAT-03)', () => {
  it('exports JSON and binary Yjs matching server state', async () => {
    await edit(a.tenantId, 'records', 'exp', (y) => {
      y.getMap('data').set('name', 'Dana');
    });
    const json = await st.api('GET', '/v1/collections/records/docs/exp/export?format=json', sk());
    expect(json.body).toEqual({ data: { name: 'Dana' } });
    const bin = await fetch(`${st.http}/v1/collections/records/docs/exp/export?format=yjs`, {
      headers: { authorization: `Bearer ${a.secretKey}` },
    });
    expect(bin.headers.get('content-type')).toBe('application/octet-stream');
    const y = new Y.Doc();
    Y.applyUpdate(y, new Uint8Array(await bin.arrayBuffer()));
    expect(y.getMap('data').toJSON()).toEqual({ name: 'Dana' });
  });

  it('the materializer fills document_views and records update events', async () => {
    const id = 'mat';
    await edit(a.tenantId, 'records', id, (y) => {
      y.getMap('data').set('n', 5);
    });
    const sh = shardFor(a.tenantId, 'records', id);
    await sh.query(
      `update documents set updated_at = now() - interval '5 seconds' where tenant_id = $1 and doc_id = $2`,
      [a.tenantId, id],
    );
    expect(await materializeDue(sh)).toBeGreaterThan(0);
    const v = await sh.query<{ seq: string; json: unknown }>(
      `select v.seq::text, v.json from document_views v join documents d on d.uid = v.doc_uid where d.tenant_id = $1 and d.doc_id = $2`,
      [a.tenantId, id],
    );
    expect(v.rows[0]?.json).toEqual({ data: { n: 5 } });
    await materializeDue(sh); // other documents may be due; this one must not be redone
    const updates = await sh.query<{ n: string }>(
      `select count(*)::text n from changes where tenant_id = $1 and doc_id = $2 and kind = 'update'`,
      [a.tenantId, id],
    );
    expect(Number(updates.rows[0]?.n)).toBe(1);
  });
});

describe('A4-5 change feed (DAT-08)', () => {
  it('consumers resume from a cursor with no gaps and no duplicates, across shards', async () => {
    const b = await signup(st.api);
    const key = { token: b.secretKey };
    for (let i = 0; i < 12; i++)
      await st.api('POST', '/v1/collections/feed/docs', {
        ...key,
        body: { id: `f${String(i).padStart(2, '0')}`, initial: { i } },
      });
    await st.api('DELETE', '/v1/collections/feed/docs/f03', key);
    for (const sh of st.node.deps.shards) {
      await sh.query(
        `update documents set updated_at = now() - interval '5 seconds' where tenant_id = $1`,
        [b.tenantId],
      );
      await materializeDue(sh);
    }

    const all: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const r = await st.api(
        'GET',
        `/v1/changes?collection=feed&limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        key,
      );
      if (r.body.items.length === 0) break;
      all.push(
        ...r.body.items.map(
          (x: { kind: string; docId: string; seq: number | null }) =>
            `${x.kind}:${x.docId}:${String(x.seq)}`,
        ),
      );
      cursor = r.body.nextCursor;
      if (guard === 1) {
        // "disconnect" and resume with only the cursor: must continue exactly where we stopped
        const again = await st.api(
          'GET',
          `/v1/changes?collection=feed&limit=5&cursor=${encodeURIComponent(cursor as string)}`,
          key,
        );
        expect(again.body.items.length).toBeGreaterThan(0);
      }
    }
    console.log('FEED', JSON.stringify(all));
    expect(new Set(all).size).toBe(all.length); // no duplicates
    const kinds = all.map((x) => x.split(':')[0]);
    expect(kinds.filter((k) => k === 'create')).toHaveLength(12);
    expect(kinds.filter((k) => k === 'delete')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'update').length).toBeGreaterThanOrEqual(11); // every doc written once (f03 may be skipped)
    const created = all.filter((x) => x.startsWith('create:')).map((x) => x.split(':')[1]);
    expect(created.sort()).toEqual(
      Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, '0')}`),
    );
    // a fresh consumer polling past the end gets nothing new
    const tail = await st.api(
      'GET',
      `/v1/changes?collection=feed&limit=5&cursor=${encodeURIComponent(cursor as string)}`,
      key,
    );
    expect(tail.body.items).toEqual([]);
    expect((await st.api('GET', '/v1/changes?cursor=not-a-cursor', key)).status).toBe(422);
  });

  it('SSE streams events with exact ids and Last-Event-ID resumes without repeating', async () => {
    const b = await signup(st.api);
    for (let i = 0; i < 4; i++)
      await st.api('POST', '/v1/collections/sse/docs', {
        token: b.secretKey,
        body: { id: `s${String(i)}` },
      });

    const readEvents = async (lastEventId: string | undefined, want: number) => {
      const ctrl = new AbortController();
      const res = await fetch(`${st.http}/v1/changes/stream?collection=sse`, {
        headers: {
          authorization: `Bearer ${b.secretKey}`,
          ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
        },
        signal: ctrl.signal,
      });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const dec = new TextDecoder();
      let buf = '';
      const events: { id: string; data: { docId: string } }[] = [];
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      while (events.length < want) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const id = /^id: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (id && data) events.push({ id, data: JSON.parse(data) as { docId: string } });
        }
      }
      ctrl.abort();
      return events;
    };

    const first = await readEvents(undefined, 4);
    expect(first.map((e) => e.data.docId).sort()).toEqual(['s0', 's1', 's2', 's3']);
    const resumed = await readEvents(first[1]?.id, 2); // after the 2nd event, the 3rd and 4th follow
    expect(resumed.map((e) => e.data.docId)).toEqual(first.slice(2).map((e) => e.data.docId));
  }, 30_000);
});

describe('purge (DAT-07)', () => {
  it('hard-deletes ops, snapshots and views of documents soft-deleted more than 7 days ago, and nothing else', async () => {
    const t = await signup(st.api);
    const key = { token: t.secretKey };
    await st.api('POST', '/v1/collections/purge/docs', {
      ...key,
      body: { id: 'old', initial: { x: 1 } },
    });
    await st.api('POST', '/v1/collections/purge/docs', {
      ...key,
      body: { id: 'fresh', initial: { x: 2 } },
    });
    await st.api('POST', '/v1/collections/purge/docs', {
      ...key,
      body: { id: 'live', initial: { x: 3 } },
    });
    const oldSh = shardFor(t.tenantId, 'purge', 'old');
    const { uid } = await ensureDocument(oldSh, t.tenantId, 'purge', 'old');
    await snapshotDoc(oldSh, redis(), { uid, tenantId: t.tenantId });
    await st.api('DELETE', '/v1/collections/purge/docs/old', key);
    await st.api('DELETE', '/v1/collections/purge/docs/fresh', key);
    await oldSh.query(
      `update documents set deleted_at = now() - interval '8 days' where uid = $1`,
      [uid],
    );

    const day = 7 * 86_400_000;
    const res = await purgeDeleted(
      st.node.deps.shards,
      new Date(Date.now() - day),
      new Date(Date.now() - day),
    );
    expect(res.documents).toBeGreaterThanOrEqual(1);
    const count = async (table: string) =>
      Number(
        (
          await oldSh.query<{ n: string }>(
            `select count(*)::text n from ${table} where doc_uid = $1`,
            [uid],
          )
        ).rows[0]?.n,
      );
    for (const table of ['operations', 'snapshots', 'document_views', 'op_dedup'])
      expect(await count(table)).toBe(0);
    expect((await oldSh.query('select 1 from documents where uid = $1', [uid])).rowCount).toBe(0);

    const freshSh = shardFor(t.tenantId, 'purge', 'fresh');
    const fresh = await freshSh.query(
      `select 1 from documents where tenant_id = $1 and doc_id = 'fresh'`,
      [t.tenantId],
    );
    expect(fresh.rowCount).toBe(1); // deleted yesterday: still recoverable
    expect((await st.api('GET', '/v1/collections/purge/docs/live', key)).body.json.data.x).toBe(3);
  });
});

describe('worker maintenance pass (DAT-01 triggers)', () => {
  it('snapshots, compacts, checkpoints and materializes only the documents that crossed a threshold', async () => {
    const { maintainShard } = await import('../src/jobs/lifecycle.js');
    const t = newTenant();
    const sh = shardFor(t, 'notes', 'busy');
    const { uid: busy } = await ensureDocument(sh, t, 'notes', 'busy');
    const y = new Y.Doc();
    const ups: Uint8Array[] = [];
    y.on('update', (u: Uint8Array) => ups.push(u));
    for (let i = 0; i < 600; i++) y.getText('t').insert(i, 'x');
    await sh.query(
      `insert into operations (doc_uid, seq, tenant_id, client_id, op_refs, update, size)
       select $1, t.s, $2, 'seed', array['o' || t.s], t.u, length(t.u)
       from unnest($3::bigint[], $4::bytea[]) as t(s, u)`,
      [busy, t, ups.map((_, i) => i + 1), ups.map((u) => Buffer.from(u))],
    );
    await sh.query(
      `update documents set head_seq = 600, updated_at = now() - interval '5 seconds' where uid = $1`,
      [busy],
    );
    // A quiet small document on the same shard must be left alone.
    const quietId = (await ensureDocument(sh, t, 'notes', 'quiet')).uid;
    await appendOps(sh, t, quietId, [{ clientId: 'c', opId: 'o', update: ups[0] as Uint8Array }]);

    const opts = {
      everyOps: 500,
      everyBytes: 1_000_000,
      idleMs: 60_000,
      checkpointMs: 0,
      retentionDays: () => Promise.resolve(30),
    };
    const stats = await maintainShard(sh, redis(), opts);
    expect(stats.snapshots).toBe(1);
    expect(stats.compactions).toBe(1);
    expect(stats.verifyFailures).toBe(0);
    expect(stats.rowsDeleted).toBe(600); // covered by the checkpoint taken in the same pass
    expect(stats.checkpoints).toBeGreaterThanOrEqual(1);
    expect((await loadDoc(sh, t, busy)).doc.getText('t').length).toBe(600);
    expect(
      (await sh.query('select snapshot_seq from documents where uid = $1', [quietId])).rows[0]
        ?.snapshot_seq,
    ).toBe('0');
    expect(stats.materialized).toBeGreaterThanOrEqual(1);
    const again = await maintainShard(sh, redis(), opts);
    expect(again.snapshots).toBe(0); // idempotent once up to date
  }, 60_000);
});
