/** A3-3 (rate limits), A3-4 (quotas + client quota-blocked), A3-5 (webhooks), A3-6 (read-only), OPS-04 (metering). */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createClient, type SyncraClient } from '@syncra/client';
import { flushUsage, refreshGauges } from '../src/jobs/usage.js';
import { WebhookDispatcher } from '../src/webhooks/dispatcher.js';
import { verifySignature } from '../src/webhooks/sign.js';
import { RawClient, eventually } from './harness.js';
import { signup, startStack, type Account, type Stack } from './stack.js';

const ENC_KEY = Buffer.alloc(32, 5);
const stacks: Stack[] = [];
const servers: http.Server[] = [];
const clients: SyncraClient[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.destroy().catch(() => undefined)));
  await Promise.all(stacks.map((s) => s.close()));
  servers.forEach((s) => {
    s.closeAllConnections();
  });
});

async function stack(env: Record<string, string> = {}): Promise<Stack> {
  const s = await startStack(env);
  stacks.push(s);
  return s;
}

interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
}
/** Local webhook receiver whose response status can be changed mid-test. */
async function receiver() {
  const got: Received[] = [];
  const state = { status: 200 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      got.push({ headers: req.headers, body });
      res.statusCode = state.status;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return {
    got,
    state,
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/hook`,
  };
}

const dispatcher = (s: Stack, schedule?: number[]) =>
  new WebhookDispatcher(s.node.deps.control, {
    encryptionKey: ENC_KEY,
    allowPrivate: true,
    schedule,
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dash = (a: Account) => ({ token: a.accessToken, tenant: a.tenantId });

describe('A3-3 rate limits (OPS-01)', () => {
  it('flooding one connection yields RATE_LIMITED without affecting another connection', async () => {
    const s = await stack({ RL_CONN_RATE: '5', RL_CONN_BURST: '20' });
    const a = await signup(s.api);
    const mint = async () =>
      (
        await s.api('POST', '/v1/tokens', {
          token: a.secretKey,
          body: { userId: 'u', access: [{ collection: 'notes', docs: '*', mode: 'rw' }] },
        })
      ).body.token as string;
    const flooder = new RawClient(s.ws, await mint());
    const polite = new RawClient(s.ws, await mint());
    await Promise.all([flooder.opened, polite.opened]);
    for (let i = 0; i < 200; i++) flooder.send({ type: 'PING', docKey: '', timestampMs: i });
    const [err] = await flooder.waitFor('ERROR');
    expect(err?.code).toBe('RATE_LIMITED');
    expect(err?.retryAfterMs).toBeGreaterThan(0);
    polite.send({ type: 'PING', docKey: '', timestampMs: 1 });
    await polite.waitFor('PONG');
    expect(polite.frames.some((f) => f.type === 'ERROR')).toBe(false);
    expect(flooder.frames.filter((f) => f.type === 'PONG').length).toBeLessThan(200);
    flooder.close();
    polite.close();
  });

  it('REST requests are limited per IP with a Retry-After header, well-behaved clients unaffected', async () => {
    const s = await stack({ RL_IP_RATE: '2' }); // burst 4
    const codes: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 12; i++) {
      const r = await s.api('GET', '/v1/collections');
      codes.push(r.status);
      if (r.status === 429) {
        retryAfter = r.headers.get('retry-after');
        expect(r.body.error.code).toBe('RATE_LIMITED');
      }
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(codes[0]).toBe(401);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect((await s.api('GET', '/healthz')).status).toBe(200); // outside /v1
  });

  it('login/signup attempts are limited per IP', async () => {
    const s = await stack({ RL_AUTH_PER_MIN: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push(
        (
          await s.api('POST', '/v1/auth/login', {
            body: { email: 'nobody@example.com', password: 'wrong-password-1' },
          })
        ).status,
      );
    }
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes.slice(3).every((c) => c === 429)).toBe(true);
  });
});

describe('A3-4 quotas (OPS-03, OPS-05, BIL-01, BIL-05)', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await stack({ BILLING_ENABLED: 'true' });
  });
  const seedOps = (a: Account, value: number) =>
    s.node.deps.control.query(
      `insert into usage_hourly (tenant_id, hour, metric, value) values ($1, date_trunc('hour', now()), 'ops', $2)
       on conflict (tenant_id, hour, metric) do update set value = $2`,
      [a.tenantId, value],
    );

  it('new tenants start on the free plan; the ops quota blocks writes but existing data stays readable', async () => {
    const a = await signup(s.api);
    expect((await s.api('GET', '/v1/tenant', dash(a))).body.tenant.plan).toBe('free');
    expect(
      (
        await s.api('POST', '/v1/collections/notes/docs', {
          token: a.secretKey,
          body: { id: 'before', initial: { v: 1 } },
        })
      ).status,
    ).toBe(201);
    await seedOps(a, 1_000_000);
    const blocked = await s.api('POST', '/v1/collections/notes/docs', {
      token: a.secretKey,
      body: { id: 'after', initial: { v: 2 } },
    });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      details: { metric: 'ops', limit: 1_000_000 },
    });
    const read = await s.api('GET', '/v1/collections/notes/docs/before', { token: a.secretKey });
    expect(read.status).toBe(200);
    expect(read.body.json.data.v).toBe(1);
    const usage = await s.api('GET', '/v1/usage/current', { token: a.secretKey });
    expect(usage.body.quotas.ops).toEqual({ used: expect.any(Number), limit: 1_000_000 });
  });

  it('the documents quota blocks creating documents only', async () => {
    const a = await signup(s.api);
    await s.node.deps.control.query(
      'insert into usage_gauges (tenant_id, documents, storage_bytes) values ($1, 1000, 0)',
      [a.tenantId],
    );
    s.node.services.quotas.invalidate(a.tenantId);
    const r = await s.api('POST', '/v1/collections/notes/docs', {
      token: a.secretKey,
      body: { id: 'one-too-many' },
    });
    expect(r.status).toBe(402);
    expect(r.body.error.details.metric).toBe('documents');
  });

  it('the storage quota blocks writes', async () => {
    const a = await signup(s.api);
    await s.node.deps.control.query(
      'insert into usage_gauges (tenant_id, documents, storage_bytes) values ($1, 1, $2)',
      [a.tenantId, 100 * 1024 * 1024],
    );
    s.node.services.quotas.invalidate(a.tenantId);
    const r = await s.api('POST', '/v1/collections/notes/docs', {
      token: a.secretKey,
      body: { id: 'x', initial: { v: 1 } },
    });
    expect(r.status).toBe(402);
    expect(r.body.error.details.metric).toBe('storage');
  });

  it('the connection quota closes new sockets with 4402', async () => {
    const a = await signup(s.api);
    await s.node.deps.redis.set(`sx:conn:${a.tenantId}`, '100');
    s.node.services.quotas.invalidate(a.tenantId);
    const tok = (
      await s.api('POST', '/v1/tokens', {
        token: a.secretKey,
        body: { userId: 'u', access: [{ collection: 'notes', docs: '*', mode: 'rw' }] },
      })
    ).body.token as string;
    const raw = new RawClient(s.ws, tok);
    await raw.opened;
    await eventually(() => raw.closeCode !== undefined);
    expect(raw.closeCode).toBe(4402);
    await s.node.deps.redis.set(`sx:conn:${a.tenantId}`, '0');
    const ok = new RawClient(s.ws, tok);
    await ok.opened;
    ok.send({ type: 'PING', docKey: '', timestampMs: 1 });
    await ok.waitFor('PONG');
    ok.close();
  });

  it('the SDK enters quota-blocked, keeps its outbox, and drains after a plan upgrade (OPS-05, BIL-01)', async () => {
    const a = await signup(s.api);
    const wh = await receiver();
    const hook = await s.api('POST', '/v1/webhooks', {
      ...dash(a),
      body: { url: wh.url, events: ['quota.exceeded'] },
    });
    expect(hook.status).toBe(201);

    const client = createClient({
      url: s.http,
      publishableKey: a.publishableKey,
      identity: { tenantId: a.tenantId, userId: 'dev1' },
      getToken: async () =>
        (
          await s.api('POST', '/v1/tokens', {
            token: a.secretKey,
            body: { userId: 'dev1', access: [{ collection: 'notes', docs: '*', mode: 'rw' }] },
          })
        ).body.token as string,
      storage: 'memory',
      tabEnv: null,
      probeUrl: '',
      batchMs: 5,
      quotaRetryMs: 150,
    });
    clients.push(client);
    const doc = client.doc('notes', 'queued');
    await doc.whenSynced();
    await eventually(() => client.status.connection === 'live');

    await seedOps(a, 1_000_000);
    s.node.services.quotas.invalidate(a.tenantId);
    doc.text().insert(0, 'written while blocked');
    await eventually(() => client.status.connection === 'quota-blocked', 10_000);
    expect(client.status.pendingOps).toBeGreaterThan(0);
    expect(doc.text().toJSON()).toBe('written while blocked'); // local editing keeps working

    // quota.exceeded reaches the tenant's webhook, signed
    for (let i = 0; i < 20 && wh.got.length === 0; i++) {
      await dispatcher(s).runDue();
      await sleep(50);
    }
    expect(wh.got.length).toBeGreaterThan(0);
    const evt = JSON.parse(wh.got[0]?.body ?? '{}') as { type: string; data: { metric: string } };
    expect(evt.type).toBe('quota.exceeded');
    expect(evt.data.metric).toBe('ops');
    expect(
      verifySignature(
        String(wh.got[0]?.headers['syncra-signature']),
        hook.body.secret as string,
        wh.got[0]?.body ?? '',
      ),
    ).toBe(true);

    // upgrading the plan lifts the block and the outbox drains with no user action
    expect((await s.api('PATCH', '/v1/tenant', { ...dash(a), body: { plan: 'pro' } })).status).toBe(
      200,
    );
    await eventually(
      () => client.status.connection === 'live' && client.status.pendingOps === 0,
      15_000,
    );
    const stored = await s.api('GET', '/v1/collections/notes/docs/queued', { token: a.secretKey });
    expect(stored.body.json.text).toBe('written while blocked');
  }, 40_000);

  it('BIL-05: with billing disabled nothing is ever blocked', async () => {
    const free = await stack({ BILLING_ENABLED: 'false' });
    const a = await signup(free.api);
    await free.node.deps.control.query(
      `insert into usage_hourly (tenant_id, hour, metric, value) values ($1, date_trunc('hour', now()), 'ops', 999999999999)`,
      [a.tenantId],
    );
    free.node.services.quotas.invalidate(a.tenantId);
    expect(
      (
        await free.api('POST', '/v1/collections/notes/docs', {
          token: a.secretKey,
          body: { id: 'ok', initial: { v: 1 } },
        })
      ).status,
    ).toBe(201);
    expect((await free.api('GET', '/v1/tenant', dash(a))).body.tenant.plan).toBe('selfhost');
  });

  it('plan limits cap webhook endpoints (free allows 1)', async () => {
    const a = await signup(s.api);
    const body = { url: 'http://127.0.0.1:9/a', events: ['document.created'] };
    expect((await s.api('POST', '/v1/webhooks', { ...dash(a), body })).status).toBe(201);
    const second = await s.api('POST', '/v1/webhooks', { ...dash(a), body });
    expect(second.status).toBe(402);
    expect(second.body.error.details.metric).toBe('webhooks');
  });
});

describe('A3-5 webhooks (OPS-06)', () => {
  let s: Stack;
  let a: Account;
  beforeAll(async () => {
    s = await stack();
    a = await signup(s.api);
  });

  it('delivers document.created / updated / deleted, signed, with the documented envelope and headers', async () => {
    const wh = await receiver();
    const hook = await s.api('POST', '/v1/webhooks', {
      ...dash(a),
      body: { url: wh.url, events: ['document.created', 'document.updated', 'document.deleted'] },
    });
    expect(hook.body.secret).toMatch(/^whsec_/);
    expect(JSON.stringify((await s.api('GET', '/v1/webhooks', dash(a))).body)).not.toContain(
      hook.body.secret,
    );

    await s.api('POST', '/v1/collections/inspections/docs', {
      token: a.secretKey,
      body: { id: 'site-42', initial: { a: 1 } },
    });
    await sleep(1500); // document.updated is debounced to 1 per second
    await s.api('DELETE', '/v1/collections/inspections/docs/site-42', { token: a.secretKey });
    await sleep(200);
    await dispatcher(s).runDue();

    const events = wh.got.map(
      (g) =>
        JSON.parse(g.body) as {
          id: string;
          type: string;
          tenantId: string;
          data: Record<string, unknown>;
        },
    );
    expect(events.map((e) => e.type).sort()).toEqual([
      'document.created',
      'document.deleted',
      'document.updated',
    ]);
    expect(events.every((e) => e.tenantId === a.tenantId && e.id.startsWith('evt_'))).toBe(true);
    expect(events.find((e) => e.type === 'document.updated')?.data).toMatchObject({
      collection: 'inspections',
      docId: 'site-42',
    });
    for (const g of wh.got) {
      expect(g.headers['content-type']).toBe('application/json');
      expect(g.headers['syncra-event']).toBeTruthy();
      expect(g.headers['syncra-delivery']).toBeTruthy();
      expect(
        verifySignature(String(g.headers['syncra-signature']), hook.body.secret as string, g.body),
      ).toBe(true);
      expect(verifySignature(String(g.headers['syncra-signature']), 'whsec_wrong', g.body)).toBe(
        false,
      );
    }
    const log = await s.api('GET', `/v1/webhooks/${hook.body.id}/deliveries`, dash(a));
    expect(log.body.items.every((d: { status: string }) => d.status === 'success')).toBe(true);
  });

  it('a failing endpoint shows retries and ends dead; a manual retry re-queues it; recovery succeeds', async () => {
    const wh = await receiver();
    wh.state.status = 500;
    const hook = await s.api('POST', '/v1/webhooks', {
      ...dash(a),
      body: { url: wh.url, events: ['webhook.test'] },
    });
    await s.api('POST', `/v1/webhooks/${hook.body.id}/test`, dash(a));
    const d = dispatcher(s, [20, 20]); // accelerated schedule: 2 retries after the first attempt
    const statusOf = async () =>
      (await s.api('GET', `/v1/webhooks/${hook.body.id}/deliveries`, dash(a))).body.items[0] as {
        id: string;
        status: string;
        attempt: number;
      };
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      await d.runDue();
      seen.add((await statusOf()).status);
      if ((await statusOf()).status === 'dead') break;
      await sleep(30);
    }
    const dead = await statusOf();
    expect(dead.status).toBe('dead');
    expect(dead.attempt).toBe(3);
    expect(seen.has('retrying')).toBe(true);
    expect(wh.got).toHaveLength(3);

    wh.state.status = 200;
    expect((await s.api('POST', `/v1/webhooks/deliveries/${dead.id}/retry`, dash(a))).status).toBe(
      202,
    );
    await d.runDue();
    expect((await statusOf()).status).toBe('success');
  });

  it('rejects private targets when WEBHOOK_ALLOW_PRIVATE=false (SSRF)', async () => {
    const strict = await stack({ WEBHOOK_ALLOW_PRIVATE: 'false' });
    const b = await signup(strict.api);
    for (const url of [
      'http://127.0.0.1:8080/x',
      'http://169.254.169.254/latest/meta-data',
      'http://localhost/x',
      'file:///etc/passwd',
    ]) {
      const r = await strict.api('POST', '/v1/webhooks', {
        ...dash(b),
        body: { url, events: ['webhook.test'] },
      });
      expect(r.status, url).toBe(422);
    }
  });

  it('endpoint CRUD: disable stops delivery; delete removes the endpoint and its log', async () => {
    const wh = await receiver();
    const hook = await s.api('POST', '/v1/webhooks', {
      ...dash(a),
      body: { url: wh.url, events: ['webhook.test'] },
    });
    const off = await s.api('PATCH', `/v1/webhooks/${hook.body.id}`, {
      ...dash(a),
      body: { enabled: false },
    });
    expect(off.body.enabled).toBe(false);
    await s.node.services.webhooks.emit(a.tenantId, 'webhook.test', { message: 'nobody listens' });
    await dispatcher(s).runDue();
    expect(
      wh.got.filter(
        (g) =>
          g.headers['syncra-event'] === 'webhook.test' &&
          JSON.parse(g.body).data.message === 'nobody listens',
      ),
    ).toHaveLength(0);
    expect((await s.api('DELETE', `/v1/webhooks/${hook.body.id}`, dash(a))).status).toBe(204);
    expect(
      (await s.api('GET', `/v1/webhooks/${hook.body.id}/deliveries`, dash(a))).body.items,
    ).toEqual([]);
  });
});

describe('A3-6 read-only tokens (SYN-12)', () => {
  it('a read-only token can read and receive updates but cannot modify a document, over WebSocket and HTTP', async () => {
    const s = await stack();
    const a = await signup(s.api);
    const mint = async (mode: 'r' | 'rw') =>
      (
        await s.api('POST', '/v1/tokens', {
          token: a.secretKey,
          body: { userId: mode, access: [{ collection: 'notes', docs: '*', mode }] },
        })
      ).body.token as string;
    await s.api('POST', '/v1/collections/notes/docs', {
      token: a.secretKey,
      body: { id: 'shared', initial: { v: 'original' } },
    });
    const [ro, rw] = [new RawClient(s.ws, await mint('r')), new RawClient(s.ws, await mint('rw'))];
    await Promise.all([ro.opened, rw.opened]);
    for (const c of [ro, rw]) c.send({ type: 'SUBSCRIBE', docKey: 'notes/shared', flags: 0 });
    expect((await ro.waitFor('SUBSCRIBED'))[0]?.access).toBe(0);
    await rw.waitFor('SUBSCRIBED');

    const y = new Y.Doc();
    y.getMap('data').set('v', 'hacked');
    ro.send({
      type: 'UPDATE',
      docKey: 'notes/shared',
      opId: 'x',
      update: Y.encodeStateAsUpdate(y),
    });
    expect((await ro.waitFor('ERROR'))[0]?.code).toBe('FORBIDDEN');

    const edit = new Y.Doc();
    edit.getMap('data').set('v2', 'from rw');
    rw.send({
      type: 'UPDATE',
      docKey: 'notes/shared',
      opId: 'y',
      update: Y.encodeStateAsUpdate(edit),
    });
    await rw.waitFor('ACK');
    await ro.waitFor('UPDATE_BROADCAST'); // read-only still receives updates

    const http = await s.api('POST', '/v1/sync/notes/shared/push', {
      token: await mint('r'),
      body: {
        clientId: 'c',
        opId: 'o',
        update: Buffer.from(Y.encodeStateAsUpdate(y)).toString('base64url'),
      },
    });
    expect(http.status).toBe(403);
    const final = await s.api('GET', '/v1/collections/notes/docs/shared', { token: a.secretKey });
    expect(final.body.json.data).toEqual({ v: 'original', v2: 'from rw' });
    ro.close();
    rw.close();
  });
});

describe('OPS-04 usage metering', () => {
  it('counters flushed by the worker job match generated traffic exactly, and gauges are refreshed', async () => {
    const s = await stack();
    const a = await signup(s.api);
    const N = 40;
    for (let i = 0; i < N; i++) {
      const r = await s.api('POST', '/v1/collections/metered/docs', {
        token: a.secretKey,
        body: { id: `d${String(i)}`, initial: { i } },
      });
      expect(r.status).toBe(201);
    }
    await sleep(100);
    const res = await flushUsage(s.node.deps.redis, s.node.deps.control);
    expect(res.keys).toBeGreaterThan(0);
    const ops = await s.api('GET', '/v1/usage?metric=ops&granularity=day', dash(a));
    expect(ops.body.items.reduce((n: number, p: { value: number }) => n + p.value, 0)).toBe(N);
    const docs = await s.api('GET', '/v1/usage?metric=docs_created&granularity=day', dash(a));
    expect(docs.body.items.reduce((n: number, p: { value: number }) => n + p.value, 0)).toBe(N);
    const bytes = await s.api('GET', '/v1/usage?metric=bytes_written&granularity=day', dash(a));
    expect(bytes.body.items[0].value).toBeGreaterThan(N);

    // flushing again adds nothing (no double counting)
    await flushUsage(s.node.deps.redis, s.node.deps.control);
    const again = await s.api('GET', '/v1/usage?metric=ops&granularity=day', dash(a));
    expect(again.body.items.reduce((n: number, p: { value: number }) => n + p.value, 0)).toBe(N);

    await refreshGauges(s.node.deps.shards, s.node.deps.control);
    s.node.services.quotas.invalidate(a.tenantId);
    const cur = await s.api('GET', '/v1/usage/current', { token: a.secretKey });
    expect(cur.body.quotas.docs.used).toBe(N);
    expect(cur.body.quotas.storageBytes.used).toBeGreaterThan(0);
  });
});
