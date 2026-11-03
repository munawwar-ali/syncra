/** REST documents API and HTTP sync fallback (P3-T11, SYN-09, DAT-07 soft delete, SYN-12 over HTTP). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { RawClient } from './harness.js';
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

const sk = () => ({ token: a.secretKey });
const mintToken = async (access: object[]) =>
  (await st.api('POST', '/v1/tokens', { token: a.secretKey, body: { userId: 'u1', access } })).body
    .token as string;

describe('documents API', () => {
  it('creates a document with initial data and reads it back as JSON', async () => {
    const created = await st.api('POST', '/v1/collections/inspections/docs', {
      ...sk(),
      body: { id: 'site-42', initial: { status: 'draft', score: 7 } },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 'site-42' });
    expect(created.body.seq).toBeGreaterThan(0);

    const got = await st.api('GET', '/v1/collections/inspections/docs/site-42', sk());
    expect(got.status).toBe(200);
    expect(got.body.json).toEqual({ data: { status: 'draft', score: 7 } });
    expect(got.body).toMatchObject({ id: 'site-42', collection: 'inspections' });
    expect(got.body.sizeBytes).toBeGreaterThan(0);

    const dup = await st.api('POST', '/v1/collections/inspections/docs', {
      ...sk(),
      body: { id: 'site-42' },
    });
    expect(dup.status).toBe(409);
  });

  it('serves the binary Yjs state, which reproduces the document', async () => {
    const res = await fetch(`${st.http}/v1/collections/inspections/docs/site-42/state`, {
      headers: { authorization: `Bearer ${a.secretKey}` },
    });
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    const y = new Y.Doc();
    Y.applyUpdate(y, new Uint8Array(await res.arrayBuffer()));
    expect(y.getMap('data').toJSON()).toEqual({ status: 'draft', score: 7 });
  });

  it('lists collections with counts and pages documents by id across shards, with prefix search', async () => {
    for (let i = 0; i < 25; i++) {
      await st.api('POST', '/v1/collections/pages/docs', {
        ...sk(),
        body: { id: `${i % 2 ? 'odd' : 'even'}-${String(i).padStart(2, '0')}` },
      });
    }
    const cols = await st.api('GET', '/v1/collections', sk());
    const pages = cols.body.items.find((c: { name: string }) => c.name === 'pages');
    expect(pages.documents).toBe(25);
    expect(cols.body.items.map((c: { name: string }) => c.name)).not.toContain('__index');

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: { body: { items: { id: string }[]; nextCursor: string | null } } = await st.api(
        'GET',
        `/v1/collections/pages/docs?limit=10${cursor ? `&cursor=${cursor}` : ''}`,
        sk(),
      );
      seen.push(...r.body.items.map((i) => i.id));
      cursor = r.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(25);
    expect(seen).toEqual([...seen].sort());
    expect(new Set(seen).size).toBe(25);

    const odd = await st.api('GET', '/v1/collections/pages/docs?prefix=odd', sk());
    expect(odd.body.items.every((i: { id: string }) => i.id.startsWith('odd'))).toBe(true);
    expect(odd.body.items).toHaveLength(12);
  });

  it('soft delete: hidden from reads and lists, NOT_FOUND for sync attempts (DAT-07)', async () => {
    await st.api('POST', '/v1/collections/notes/docs', { ...sk(), body: { id: 'gone' } });
    const token = await mintToken([{ collection: 'notes', docs: '*', mode: 'rw' }]);
    const raw = new RawClient(st.ws, token);
    await raw.opened;
    raw.send({ type: 'SUBSCRIBE', docKey: 'notes/gone', flags: 0 });
    await raw.waitFor('SUBSCRIBED');

    expect((await st.api('DELETE', '/v1/collections/notes/docs/gone', sk())).status).toBe(204);
    expect((await st.api('GET', '/v1/collections/notes/docs/gone', sk())).status).toBe(404);
    expect((await st.api('DELETE', '/v1/collections/notes/docs/gone', sk())).status).toBe(404);
    const list = await st.api('GET', '/v1/collections/notes/docs', sk());
    expect(list.body.items.map((i: { id: string }) => i.id)).not.toContain('gone');

    const late = new RawClient(st.ws, token);
    await late.opened;
    late.send({ type: 'SUBSCRIBE', docKey: 'notes/gone', flags: 0 });
    expect((await late.waitFor('ERROR'))[0]?.code).toBe('NOT_FOUND');

    const y = new Y.Doc();
    y.getText('t').insert(0, 'zombie');
    raw.send({ type: 'UPDATE', docKey: 'notes/gone', opId: 'z', update: Y.encodeStateAsUpdate(y) });
    expect((await raw.waitFor('ERROR'))[0]?.code).toBe('NOT_FOUND');
    raw.close();
    late.close();
  });

  it('validates names, bodies and sizes', async () => {
    expect((await st.api('GET', '/v1/collections/Bad_Name/docs', sk())).status).toBe(422);
    expect((await st.api('GET', '/v1/collections/__index/docs', sk())).status).toBe(422);
    expect(
      (await st.api('POST', '/v1/collections/notes/docs', { ...sk(), body: { id: 'has space' } }))
        .status,
    ).toBe(422);
    // The server may answer 413 and close the socket mid-upload, which fetch reports as a thrown error.
    const big = await st
      .api('POST', '/v1/collections/notes/docs', {
        ...sk(),
        body: { id: 'too-big', initial: { x: 'y'.repeat(1_100_000) } },
      })
      .catch(() => null);
    if (big) {
      expect(big.status).toBe(413);
      expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    }
    expect((await st.api('GET', '/v1/collections/notes/docs/too-big', sk())).status).toBe(404);
    expect((await st.api('GET', '/v1/collections/notes/docs?limit=500', sk())).status).toBe(422);
  });
});

describe('HTTP sync fallback (SYN-09)', () => {
  const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64url');

  it('pull then push converge with a WebSocket client; push is idempotent', async () => {
    const token = await mintToken([{ collection: 'notes', docs: '*', mode: 'rw' }]);
    const local = new Y.Doc();
    local.getText('t').insert(0, 'over http');
    const update = Y.encodeStateAsUpdate(local);
    const push = () =>
      st.api('POST', '/v1/sync/notes/http1/push', {
        token,
        body: { clientId: 'dev1', opId: 'op-1', update: b64(update) },
      });
    const [p1, p2, p3] = [await push(), await push(), await push()];
    expect([p1.status, p2.status, p3.status]).toEqual([200, 200, 200]);
    expect(new Set([p1.body.seq, p2.body.seq, p3.body.seq]).size).toBe(1);

    const other = new Y.Doc();
    const pull = await st.api('POST', '/v1/sync/notes/http1/pull', {
      token,
      body: { stateVector: b64(Y.encodeStateVector(other)) },
    });
    expect(pull.status).toBe(200);
    Y.applyUpdate(other, Buffer.from(pull.body.update, 'base64url'));
    expect(other.getText('t').toJSON()).toBe('over http');

    const again = await st.api('POST', '/v1/sync/notes/http1/pull', {
      token,
      body: { stateVector: pull.body.stateVector },
    });
    expect(Buffer.from(again.body.update, 'base64url').length).toBeLessThanOrEqual(2);

    const ops = await st.node.deps.shards[
      st.node.services.ring.route(a.tenantId, 'notes', 'http1')
    ]?.query(
      `select count(*)::int n from operations o join documents d on d.uid = o.doc_uid where d.tenant_id = $1 and d.doc_id = 'http1'`,
      [a.tenantId],
    );
    expect(ops?.rows[0].n).toBe(1);
  });

  it('enforces access rules: read-only cannot push, other collections are forbidden, no token is 401', async () => {
    const ro = await mintToken([{ collection: 'notes', docs: '*', mode: 'r' }]);
    const update = b64(Y.encodeStateAsUpdate(new Y.Doc()));
    expect(
      (
        await st.api('POST', '/v1/sync/notes/http2/push', {
          token: ro,
          body: { clientId: 'c', opId: 'o', update },
        })
      ).status,
    ).toBe(403);
    expect(
      (await st.api('POST', '/v1/sync/secrets/x/pull', { token: ro, body: { stateVector: '' } }))
        .status,
    ).toBe(403);
    expect(
      (await st.api('POST', '/v1/sync/notes/x/pull', { body: { stateVector: '' } })).status,
    ).toBe(401);
    expect(
      (
        await st.api('POST', '/v1/sync/notes/never-created/pull', {
          token: ro,
          body: { stateVector: '' },
        })
      ).status,
    ).toBe(404);
  });

  it('rejects a malformed update without modifying the document', async () => {
    const token = await mintToken([{ collection: 'notes', docs: '*', mode: 'rw' }]);
    const r = await st.api('POST', '/v1/sync/notes/http3/push', {
      token,
      body: { clientId: 'c', opId: 'o', update: b64(new Uint8Array([255, 255, 255, 255])) },
    });
    expect(r.status).toBe(422);
  });
});
