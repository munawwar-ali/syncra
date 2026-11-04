/**
 * A3-2 (AUT-07): tenant B tries every route and the WebSocket against tenant A's data, three ways:
 *  - dashboard session of B naming A in X-Tenant-Id,
 *  - dashboard session of B using A's resource ids,
 *  - secret key / client token of B reading A's document ids.
 * A route inventory check fails CI when a route has no entry here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { RawClient } from './harness.js';
import { signup, startStack, type Account, type Res, type Stack } from './stack.js';

let st: Stack;
let A: Account;
let B: Account;
const SECRET_TEXT = 'TOP-SECRET-A';
const FAKE_INVOICE = '00000000-0000-4000-8000-0000000000aa';
const ids = { keyId: '', webhookId: '', deliveryId: '', memberId: '' };

beforeAll(async () => {
  st = await startStack();
  A = await signup(st.api, 'Alpha');
  B = await signup(st.api, 'Beta');
  await st.api('POST', '/v1/collections/notes/docs', {
    token: A.secretKey,
    body: { id: 'secret1', initial: { text: SECRET_TEXT } },
  });
  const keys = await st.api('GET', '/v1/keys', { token: A.accessToken, tenant: A.tenantId });
  ids.keyId = keys.body.items[0].id;
  const hook = await st.api('POST', '/v1/webhooks', {
    token: A.accessToken,
    tenant: A.tenantId,
    body: { url: 'http://127.0.0.1:9/h', events: ['webhook.test'] },
  });
  ids.webhookId = hook.body.id;
  await st.api('POST', `/v1/webhooks/${ids.webhookId}/test`, {
    token: A.accessToken,
    tenant: A.tenantId,
  });
  ids.deliveryId = (
    await st.api('GET', `/v1/webhooks/${ids.webhookId}/deliveries`, {
      token: A.accessToken,
      tenant: A.tenantId,
    })
  ).body.items[0].id;
  ids.memberId = A.userId;
});
afterAll(async () => {
  await st.close();
});

type Who = 'spoof' | 'own' | 'secretB' | 'clientB';
interface Attack {
  who: Who;
  path: () => string;
  body?: () => unknown;
  /** Statuses that count as denied. */
  denied?: number[];
}

/** Public or self-scoped routes: nothing tenant-specific to attack. */
const NOT_TENANT_DATA = new Set([
  'POST /v1/auth/signup',
  'POST /v1/auth/login',
  'POST /v1/auth/refresh',
  'POST /v1/auth/logout',
  'POST /v1/auth/accept-invite',
  'GET /v1/me',
]);

const TENANT_ROUTES: Record<string, Attack[]> = {
  'GET /v1/tenant': [{ who: 'spoof', path: () => '/v1/tenant' }],
  'PATCH /v1/tenant': [{ who: 'spoof', path: () => '/v1/tenant', body: () => ({ name: 'pwned' }) }],
  'DELETE /v1/tenant': [{ who: 'spoof', path: () => '/v1/tenant' }],
  'GET /v1/tenant/members': [{ who: 'spoof', path: () => '/v1/tenant/members' }],
  'POST /v1/tenant/invitations': [
    {
      who: 'spoof',
      path: () => '/v1/tenant/invitations',
      body: () => ({ email: 'evil@example.com', role: 'admin' }),
    },
  ],
  'PATCH /v1/tenant/members/:userId': [
    {
      who: 'spoof',
      path: () => `/v1/tenant/members/${ids.memberId}`,
      body: () => ({ role: 'viewer' }),
    },
    {
      who: 'own',
      path: () => `/v1/tenant/members/${ids.memberId}`,
      body: () => ({ role: 'viewer' }),
      denied: [404],
    },
  ],
  'DELETE /v1/tenant/members/:userId': [
    { who: 'spoof', path: () => `/v1/tenant/members/${ids.memberId}` },
    { who: 'own', path: () => `/v1/tenant/members/${ids.memberId}`, denied: [404] },
  ],
  'GET /v1/keys': [{ who: 'spoof', path: () => '/v1/keys' }],
  'POST /v1/keys': [
    { who: 'spoof', path: () => '/v1/keys', body: () => ({ kind: 'secret', name: 'stolen' }) },
  ],
  'DELETE /v1/keys/:id': [
    { who: 'spoof', path: () => `/v1/keys/${ids.keyId}` },
    { who: 'own', path: () => `/v1/keys/${ids.keyId}`, denied: [404] },
  ],
  'POST /v1/tokens': [
    {
      who: 'clientB',
      path: () => '/v1/tokens',
      body: () => ({ userId: 'u', access: [{ collection: 'notes', docs: '*', mode: 'rw' }] }),
      denied: [401, 403],
    },
  ],
  'POST /v1/tokens/playground': [
    { who: 'spoof', path: () => '/v1/tokens/playground', body: () => ({ userId: 'x' }) },
  ],
  'GET /v1/audit': [{ who: 'spoof', path: () => '/v1/audit' }],
  'GET /v1/usage/current': [{ who: 'spoof', path: () => '/v1/usage/current' }],
  'GET /v1/usage': [{ who: 'spoof', path: () => '/v1/usage' }],
  'GET /v1/webhooks': [{ who: 'spoof', path: () => '/v1/webhooks' }],
  'POST /v1/webhooks': [
    {
      who: 'spoof',
      path: () => '/v1/webhooks',
      body: () => ({ url: 'http://127.0.0.1:9/x', events: ['document.created'] }),
    },
  ],
  'PATCH /v1/webhooks/:id': [
    { who: 'spoof', path: () => `/v1/webhooks/${ids.webhookId}`, body: () => ({ enabled: false }) },
    {
      who: 'own',
      path: () => `/v1/webhooks/${ids.webhookId}`,
      body: () => ({ enabled: false }),
      denied: [404],
    },
  ],
  'DELETE /v1/webhooks/:id': [
    { who: 'spoof', path: () => `/v1/webhooks/${ids.webhookId}` },
    { who: 'own', path: () => `/v1/webhooks/${ids.webhookId}`, denied: [404] },
  ],
  'POST /v1/webhooks/:id/test': [
    { who: 'spoof', path: () => `/v1/webhooks/${ids.webhookId}/test` },
    { who: 'own', path: () => `/v1/webhooks/${ids.webhookId}/test`, denied: [404] },
  ],
  'GET /v1/webhooks/:id/deliveries': [
    { who: 'spoof', path: () => `/v1/webhooks/${ids.webhookId}/deliveries` },
    { who: 'own', path: () => `/v1/webhooks/${ids.webhookId}/deliveries`, denied: [200] },
  ],
  'POST /v1/webhooks/deliveries/:id/retry': [
    { who: 'spoof', path: () => `/v1/webhooks/deliveries/${ids.deliveryId}/retry` },
    { who: 'own', path: () => `/v1/webhooks/deliveries/${ids.deliveryId}/retry`, denied: [404] },
  ],
  // Data routes: B's own credentials resolve to B's namespace, so A's document must simply not exist there.
  'GET /v1/collections': [{ who: 'spoof', path: () => '/v1/collections' }],
  'GET /v1/collections/:c/docs': [
    { who: 'spoof', path: () => '/v1/collections/notes/docs' },
    { who: 'secretB', path: () => '/v1/collections/notes/docs', denied: [200] },
  ],
  'POST /v1/collections/:c/docs': [
    { who: 'spoof', path: () => '/v1/collections/notes/docs', body: () => ({ id: 'planted' }) },
  ],
  'GET /v1/collections/:c/docs/:id': [
    { who: 'spoof', path: () => '/v1/collections/notes/docs/secret1' },
    { who: 'secretB', path: () => '/v1/collections/notes/docs/secret1', denied: [404] },
  ],
  'GET /v1/collections/:c/docs/:id/state': [
    { who: 'spoof', path: () => '/v1/collections/notes/docs/secret1/state' },
    { who: 'secretB', path: () => '/v1/collections/notes/docs/secret1/state', denied: [404] },
  ],
  'DELETE /v1/collections/:c/docs/:id': [
    { who: 'spoof', path: () => '/v1/collections/notes/docs/secret1' },
    { who: 'secretB', path: () => '/v1/collections/notes/docs/secret1', denied: [404] },
  ],
  'GET /v1/collections/:c/docs/:id/history': [
    { who: 'spoof', path: () => '/v1/collections/notes/docs/secret1/history' },
    { who: 'secretB', path: () => '/v1/collections/notes/docs/secret1/history', denied: [404] },
  ],
  'GET /v1/collections/:c/docs/:id/history/:seq': [
    { who: 'spoof', path: () => '/v1/collections/notes/docs/secret1/history/1' },
    { who: 'secretB', path: () => '/v1/collections/notes/docs/secret1/history/1', denied: [404] },
  ],
  'POST /v1/collections/:c/docs/:id/restore': [
    {
      who: 'spoof',
      path: () => '/v1/collections/notes/docs/secret1/restore',
      body: () => ({ seq: 1 }),
    },
    {
      who: 'secretB',
      path: () => '/v1/collections/notes/docs/secret1/restore',
      body: () => ({ seq: 1 }),
      denied: [404],
    },
  ],
  'GET /v1/collections/:c/docs/:id/ops': [
    { who: 'spoof', path: () => '/v1/collections/notes/docs/secret1/ops' },
    { who: 'own', path: () => '/v1/collections/notes/docs/secret1/ops', denied: [404] },
  ],
  'GET /v1/collections/:c/docs/:id/export': [
    { who: 'spoof', path: () => '/v1/collections/notes/docs/secret1/export' },
    { who: 'secretB', path: () => '/v1/collections/notes/docs/secret1/export', denied: [404] },
  ],
  'GET /v1/invoices': [{ who: 'spoof', path: () => '/v1/invoices' }],
  'GET /v1/invoices/:id': [
    { who: 'spoof', path: () => `/v1/invoices/${FAKE_INVOICE}` },
    { who: 'own', path: () => `/v1/invoices/${FAKE_INVOICE}`, denied: [404] },
  ],
  'GET /v1/invoices/:id/html': [
    { who: 'spoof', path: () => `/v1/invoices/${FAKE_INVOICE}/html` },
    { who: 'own', path: () => `/v1/invoices/${FAKE_INVOICE}/html`, denied: [404] },
  ],
  'GET /v1/invoices/:id/pdf': [
    { who: 'spoof', path: () => `/v1/invoices/${FAKE_INVOICE}/pdf` },
    { who: 'own', path: () => `/v1/invoices/${FAKE_INVOICE}/pdf`, denied: [404] },
  ],
  'GET /v1/monitor/nodes': [{ who: 'spoof', path: () => '/v1/monitor/nodes' }],
  'GET /v1/monitor/stream': [{ who: 'spoof', path: () => '/v1/monitor/stream' }],
  'GET /v1/changes': [
    { who: 'spoof', path: () => '/v1/changes' },
    { who: 'secretB', path: () => '/v1/changes', denied: [200] },
  ],
  // The stream shares its auth with /changes; only the rejected case can be asserted without hanging on SSE.
  'GET /v1/changes/stream': [{ who: 'spoof', path: () => '/v1/changes/stream' }],
  'POST /v1/sync/:c/:id/pull': [
    {
      who: 'clientB',
      path: () => '/v1/sync/notes/secret1/pull',
      body: () => ({
        stateVector: Buffer.from(Y.encodeStateVector(new Y.Doc())).toString('base64url'),
      }),
      denied: [200],
    },
  ],
  'POST /v1/sync/:c/:id/push': [
    {
      who: 'clientB',
      path: () => '/v1/sync/notes/secret1/push',
      body: () => ({
        clientId: 'x',
        opId: 'o',
        update: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())).toString('base64url'),
      }),
      denied: [200],
    },
  ],
};

describe('route inventory', () => {
  it('every /v1 route is covered by this suite or explicitly not tenant data', () => {
    const v1 = st.node.app.routeTable.filter((r) => r.split(' ')[1]?.startsWith('/v1/'));
    expect(v1.length).toBeGreaterThan(30);
    const known = new Set([...NOT_TENANT_DATA, ...Object.keys(TENANT_ROUTES)]);
    const missing = v1.filter((r) => !known.has(r));
    expect(missing, `routes without an isolation test: ${missing.join(', ')}`).toEqual([]);
    const stale = [...known].filter((r) => !v1.includes(r));
    expect(stale, `isolation entries for routes that no longer exist: ${stale.join(', ')}`).toEqual(
      [],
    );
  });
});

describe('REST: tenant B cannot touch tenant A', () => {
  const cases = Object.entries(TENANT_ROUTES).flatMap(([route, attacks]) =>
    attacks.map((atk) => [route, atk] as const),
  );

  it.each(cases)('%s as %#', async (route, atk) => {
    const method = route.split(' ')[0] as string;
    const creds = {
      spoof: { token: B.accessToken, tenant: A.tenantId },
      own: { token: B.accessToken, tenant: B.tenantId },
      secretB: { token: B.secretKey },
      clientB: {
        token: (
          await st.api('POST', '/v1/tokens', {
            token: B.secretKey,
            body: { userId: 'b', access: [{ collection: 'notes', docs: '*', mode: 'rw' }] },
          })
        ).body.token as string,
      },
    }[atk.who];
    const res: Res = await st.api(method, atk.path(), { ...creds, body: atk.body?.() });
    const denied = atk.denied ?? [403];
    expect(denied, `${route} as ${atk.who} answered ${String(res.status)}`).toContain(res.status);
    // Whatever the status, A's data must never appear in the response.
    expect(JSON.stringify(res.body)).not.toContain(SECRET_TEXT);
    expect(JSON.stringify(res.body)).not.toContain(A.tenantId);
  });

  it("after all attacks, A's data is untouched and nothing was planted", async () => {
    const doc = await st.api('GET', '/v1/collections/notes/docs/secret1', { token: A.secretKey });
    expect(doc.status).toBe(200);
    expect(doc.body.json.data.text).toBe(SECRET_TEXT);
    const keys = await st.api('GET', '/v1/keys', { token: A.accessToken, tenant: A.tenantId });
    expect(keys.body.items.every((k: { revokedAt: string | null }) => k.revokedAt === null)).toBe(
      true,
    );
    expect(keys.body.items).toHaveLength(2);
    const hooks = await st.api('GET', '/v1/webhooks', { token: A.accessToken, tenant: A.tenantId });
    expect(hooks.body.items).toHaveLength(1);
    expect(hooks.body.items[0].enabled).toBe(true);
    const aList = await st.api('GET', '/v1/collections/notes/docs', { token: A.secretKey });
    expect(aList.body.items.map((i: { id: string }) => i.id)).toEqual(['secret1']);
    const t = await st.api('GET', '/v1/tenant', { token: A.accessToken, tenant: A.tenantId });
    expect(t.body.tenant.name).not.toBe('pwned');
    const members = await st.api('GET', '/v1/tenant/members', {
      token: A.accessToken,
      tenant: A.tenantId,
    });
    expect(members.body.members).toHaveLength(1);
    expect(members.body.members[0].role).toBe('owner');
  });
});

describe('WebSocket: tenant B cannot reach tenant A', () => {
  it("B subscribing to A's document id gets B's own empty document and cannot write into A's", async () => {
    const tok = (
      await st.api('POST', '/v1/tokens', {
        token: B.secretKey,
        body: { userId: 'b', access: [{ collection: 'notes', docs: '*', mode: 'rw' }] },
      })
    ).body.token as string;
    const raw = new RawClient(st.ws, tok);
    await raw.opened;
    raw.send({ type: 'SUBSCRIBE', docKey: 'notes/secret1', flags: 0 });
    await raw.waitFor('SUBSCRIBED');
    raw.send({
      type: 'SYNC_STEP1',
      docKey: 'notes/secret1',
      stateVector: Y.encodeStateVector(new Y.Doc()),
    });
    const [step2] = await raw.waitFor('SYNC_STEP2');
    const seen = new Y.Doc();
    Y.applyUpdate(seen, step2?.update ?? new Uint8Array());
    expect(JSON.stringify([...seen.share].map(([k, v]) => [k, v.toJSON()]))).not.toContain(
      SECRET_TEXT,
    );
    expect(seen.getMap('data').size).toBe(0);

    const y = new Y.Doc();
    y.getMap('data').set('text', 'B WAS HERE');
    raw.send({
      type: 'UPDATE',
      docKey: 'notes/secret1',
      opId: 'evil',
      update: Y.encodeStateAsUpdate(y),
    });
    await raw.waitFor('ACK'); // accepted into B's namespace...
    const a = await st.api('GET', '/v1/collections/notes/docs/secret1', { token: A.secretKey });
    expect(a.body.json.data.text).toBe(SECRET_TEXT); // ...never A's
    raw.close();
  });

  it("a token whose tid claims A but is signed with B's secret is rejected", async () => {
    const { SignJWT } = await import('jose');
    const bKey = (await st.node.services.tenantKeys(B.tenantId))?.secret as Uint8Array;
    const forged = await new SignJWT({
      tid: A.tenantId,
      access: [{ collection: 'notes', docs: '*', mode: 'rw' }],
    })
      .setProtectedHeader({ alg: 'HS256', kid: A.tenantId })
      .setSubject('forger')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(bKey);
    await expect(new RawClient(st.ws, forged).opened).rejects.toThrow();
    const asB = await new SignJWT({
      tid: A.tenantId,
      access: [{ collection: 'notes', docs: '*', mode: 'rw' }],
    })
      .setProtectedHeader({ alg: 'HS256', kid: B.tenantId })
      .setSubject('forger')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(bKey);
    await expect(new RawClient(st.ws, asB).opened).rejects.toThrow(); // kid/tid mismatch
  });
});

describe('storage level', () => {
  it('the same document id exists once per tenant, under different uids, and A keeps its content', async () => {
    const ring = st.node.services.ring;
    const rowsFor = async (tenantId: string) => {
      const shard = st.node.deps.shards[ring.route(tenantId, 'notes', 'secret1')];
      const r = await shard?.query<{ uid: string; tenant_id: string }>(
        'select uid, tenant_id from documents where doc_id = $1 and collection = $2 and tenant_id = $3',
        ['secret1', 'notes', tenantId],
      );
      return r?.rows ?? [];
    };
    const [aRows, bRows] = [await rowsFor(A.tenantId), await rowsFor(B.tenantId)];
    expect(aRows).toHaveLength(1);
    expect(bRows.length).toBeLessThanOrEqual(1);
    if (bRows[0]) expect(bRows[0].uid).not.toBe(aRows[0]?.uid);
  });
});
