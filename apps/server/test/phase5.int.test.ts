/** Phase 5 server side: invoices (BIL-02, BIL-03), the live monitor (DSH-02, DSH-10) and Prometheus metrics (OPS-08). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Doc, encodeStateAsUpdate } from 'yjs';
import { generateInvoices } from '../src/billing/generate.js';
import { RawClient } from './harness.js';
import { signup, startStack, type Account, type Stack } from './stack.js';

let st: Stack;
beforeAll(async () => {
  st = await startStack({ BILLING_ENABLED: 'true' });
});
afterAll(async () => {
  await st.close();
});

const dash = (a: Account) => ({ token: a.accessToken, tenant: a.tenantId });
const lastMonth = () => {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1));
};

async function seedUsage(a: Account, plan: string, ops: number, month: Date) {
  const c = st.node.deps.control;
  await c.query('update tenants set plan = $2, created_at = $3 where id = $1', [
    a.tenantId,
    plan,
    new Date(Date.UTC(2020, 0, 1)),
  ]);
  await c.query(
    `insert into usage_hourly (tenant_id, hour, metric, value) values ($1,$2,'ops',$3)
     on conflict (tenant_id, hour, metric) do update set value = $3`,
    [a.tenantId, new Date(month.getTime() + 3_600_000 * 5), ops],
  );
}

describe('invoices (BIL-02, BIL-03)', () => {
  it('the monthly job bills from usage rows, once per month, and skips selfhost tenants', async () => {
    const pro = await signup(st.api);
    await seedUsage(pro, 'pro', 53_000_000, lastMonth());
    const self = await signup(st.api);
    await seedUsage(self, 'selfhost', 9_000_000_000, lastMonth());

    expect(await generateInvoices(st.node.deps.control, lastMonth())).toBeGreaterThanOrEqual(1);
    expect(await generateInvoices(st.node.deps.control, lastMonth())).toBe(0); // idempotent

    const list = await st.api('GET', '/v1/invoices', dash(pro));
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    const inv = list.body.items[0];
    expect(inv.totalCents).toBe(2900 + 120);
    expect(inv.lineItems.map((l: { kind: string }) => l.kind)).toEqual(['base', 'overage_ops']);
    expect(inv.status).toBe('open');
    expect((await st.api('GET', '/v1/invoices', dash(self))).body.items).toEqual([]);

    const one = await st.api('GET', `/v1/invoices/${inv.id}`, dash(pro));
    expect(one.body.totalCents).toBe(3020);
  });

  it('serves a script-free HTML view and a PDF that both show the total', async () => {
    const a = await signup(st.api);
    await st.node.deps.control.query('update tenants set name = $2 where id = $1', [
      a.tenantId,
      'Acme <img src=x onerror=alert(1)>',
    ]);
    await seedUsage(a, 'business', 0, lastMonth());
    await generateInvoices(st.node.deps.control, lastMonth());
    const inv = (await st.api('GET', '/v1/invoices', dash(a))).body.items[0];
    const headers = { authorization: `Bearer ${a.accessToken}`, 'x-tenant-id': a.tenantId };

    const html = await fetch(`${st.http}/v1/invoices/${inv.id}/html`, { headers });
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(html.headers.get('content-security-policy')).toContain("default-src 'none'");
    const body = await html.text();
    expect(body).toContain('$149.00');
    expect(body).not.toContain('<img');
    expect(body).toContain('&lt;img');

    const pdf = await fetch(`${st.http}/v1/invoices/${inv.id}/pdf`, { headers });
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    const bytes = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
    expect(bytes.startsWith('%PDF-1.4')).toBe(true);
    expect(bytes).toContain('$149.00');
  });

  it('is limited to owners and admins, and other tenants cannot read an invoice id', async () => {
    const a = await signup(st.api);
    const b = await signup(st.api);
    await seedUsage(a, 'pro', 0, lastMonth());
    await generateInvoices(st.node.deps.control, lastMonth());
    const inv = (await st.api('GET', '/v1/invoices', dash(a))).body.items[0];

    const invite = await st.api('POST', '/v1/tenant/invitations', {
      ...dash(a),
      body: { email: `dev-${String(Math.random()).slice(2)}@example.com`, role: 'developer' },
    });
    const token = new URL(invite.body.url).searchParams.get('token') as string;
    const dev = await st.api('POST', '/v1/auth/accept-invite', {
      body: { token, password: 'a-long-enough-password', name: 'dev' },
    });
    expect(
      (await st.api('GET', '/v1/invoices', { token: dev.body.accessToken, tenant: a.tenantId }))
        .status,
    ).toBe(403);

    for (const suffix of ['', '/html', '/pdf']) {
      const r = await st.api('GET', `/v1/invoices/${inv.id}${suffix}`, dash(b));
      expect(r.status, suffix).toBe(404);
    }
    expect(
      (await st.api('GET', `/v1/invoices/${inv.id}`, { token: b.accessToken, tenant: a.tenantId }))
        .status,
    ).toBe(403);
  });
});

describe('live monitor (DSH-02, DSH-10)', () => {
  async function readTicks(a: Account, count: number, during: () => Promise<void>) {
    const ctrl = new AbortController();
    const res = await fetch(`${st.http}/v1/monitor/stream`, {
      headers: { authorization: `Bearer ${a.accessToken}`, 'x-tenant-id': a.tenantId },
      signal: ctrl.signal,
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const work = during();
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = '';
    const ticks: { opsPerSec: number; connections: number; ackP95Ms: number; system?: unknown }[] =
      [];
    while (ticks.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const data = /^data: (.*)$/m.exec(buf.slice(0, i))?.[1];
        buf = buf.slice(i + 2);
        if (data) ticks.push(JSON.parse(data));
      }
    }
    ctrl.abort();
    await work;
    return ticks;
  }

  it("streams one tick per second with this tenant's ops rate, connections and ack latency, and nobody else's", async () => {
    const a = await signup(st.api);
    const other = await signup(st.api);
    const mint = async (who: Account) =>
      (
        await st.api('POST', '/v1/tokens', {
          token: who.secretKey,
          body: { userId: 'u', access: [{ collection: 'notes', docs: '*', mode: 'rw' }] },
        })
      ).body.token as string;
    const mine = new RawClient(st.ws, await mint(a));
    const theirs = new RawClient(st.ws, await mint(other));
    await Promise.all([mine.opened, theirs.opened]);

    const ticks = await readTicks(a, 4, async () => {
      mine.send({ type: 'SUBSCRIBE', docKey: 'notes/mon', flags: 0 });
      theirs.send({ type: 'SUBSCRIBE', docKey: 'notes/mon', flags: 0 });
      await Promise.all([mine.waitFor('SUBSCRIBED'), theirs.waitFor('SUBSCRIBED')]);
      for (let i = 0; i < 40; i++) {
        const d = new Doc();
        d.getText('t').insert(0, String(i));
        mine.send({
          type: 'UPDATE',
          docKey: 'notes/mon',
          opId: `m${String(i)}`,
          update: encodeStateAsUpdate(d),
        });
        if (i % 2 === 0)
          theirs.send({
            type: 'UPDATE',
            docKey: 'notes/mon',
            opId: `t${String(i)}`,
            update: encodeStateAsUpdate(d),
          });
        await new Promise((r) => setTimeout(r, 40));
      }
    });
    expect(ticks.length).toBe(4);
    const total = ticks.reduce((n, t) => n + t.opsPerSec, 0);
    expect(total).toBeGreaterThanOrEqual(10); // windowed rate sampled 4 times: clearly counting, but not a precise count under load

    expect(total).toBeLessThanOrEqual(45);
    expect(Math.max(...ticks.map((t) => t.connections))).toBe(1);
    expect(Math.max(...ticks.map((t) => t.ackP95Ms))).toBeGreaterThan(0);
    expect(ticks.every((t) => !('system' in t))).toBe(true); // billing is on: no system-wide figures
    mine.close();
    theirs.close();
  }, 20_000);

  it('node details are for self-hosted operators only; a stopped node leaves the registry at once', async () => {
    const a = await signup(st.api);
    expect((await st.api('GET', '/v1/monitor/nodes', dash(a))).status).toBe(403); // billing is on in this stack

    const selfhost = await startStack({ BILLING_ENABLED: 'false', NODE_ID: 'node-x' });
    const op = await signup(selfhost.api);
    await new Promise((r) => setTimeout(r, 300)); // first heartbeat
    const nodes = await selfhost.api('GET', '/v1/monitor/nodes', {
      token: op.accessToken,
      tenant: op.tenantId,
    });
    expect(nodes.status).toBe(200);
    expect(nodes.body.items.map((n: { nodeId: string }) => n.nodeId)).toContain('node-x');
    expect(nodes.body.items[0]).toMatchObject({
      connections: expect.any(Number),
      hotDocs: expect.any(Number),
    });
    const redis = selfhost.node.deps.redis;
    expect(await redis.zscore('sx:nodes', 'node-x')).not.toBeNull();
    await selfhost.node.stop();
    expect(await redis.zscore('sx:nodes', 'node-x')).toBeNull(); // DSH-10: gone immediately, not after the 15 s TTL
  });
});

describe('Prometheus metrics (OPS-08)', () => {
  it('exposes the documented metric names without tenant identifiers, and requires the token when configured', async () => {
    const a = await signup(st.api);
    await st.api('POST', '/v1/collections/notes/docs', {
      token: a.secretKey,
      body: { id: 'm1', initial: { x: 1 } },
    });
    const text = (await st.api('GET', '/metrics')).body as string;
    for (const name of [
      'syncra_ack_latency_seconds',
      'syncra_ops_received_total',
      'syncra_ws_connections',
      'syncra_hot_docs',
      'syncra_gap_recoveries_total',
      'syncra_backpressure_events_total',
      'http_request_duration_seconds',
    ]) {
      expect(text, name).toContain(name);
    }
    expect(text).not.toContain(a.tenantId); // cardinality rule, Doc 02 §14.1

    const guarded = await startStack({ METRICS_TOKEN: 'scrape-me' });
    try {
      expect((await guarded.api('GET', '/metrics')).status).toBe(401);
      const ok = await fetch(`${guarded.http}/metrics`, {
        headers: { authorization: `Basic ${Buffer.from('prom:scrape-me').toString('base64')}` },
      });
      expect(ok.status).toBe(200);
    } finally {
      await guarded.close();
    }
  });
});
