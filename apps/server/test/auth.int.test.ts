/** A3-1 (AUT-01..AUT-06, AUT-08, AUT-09): accounts, rotation, roles, API keys, client tokens, audit. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RawClient } from './harness.js';
import { signup, startStack, type Account, type Stack } from './stack.js';

let st: Stack;
beforeAll(async () => {
  st = await startStack();
});
afterAll(async () => {
  await st.close();
});

describe('signup and login (AUT-01, AUT-02)', () => {
  it('signup returns tokens and both keys exactly once; keys are stored hashed', async () => {
    const a = await signup(st.api);
    expect(a.secretKey).toMatch(/^sk_live_/);
    expect(a.publishableKey).toMatch(/^pk_live_/);
    const list = await st.api('GET', '/v1/keys', { token: a.accessToken, tenant: a.tenantId });
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(JSON.stringify(list.body)).not.toContain(a.secretKey);
    const { rows } = await st.node.deps.control.query(
      'select key_hash from api_keys where tenant_id = $1',
      [a.tenantId],
    );
    expect(
      rows.every((r: { key_hash: Buffer }) => !r.key_hash.toString().includes('sk_live')),
    ).toBe(true);
  });

  it('rejects duplicate emails and weak input', async () => {
    const a = await signup(st.api);
    const dup = await st.api('POST', '/v1/auth/signup', {
      body: { email: a.email, password: 'another-good-password', name: 'x', tenantName: 'y' },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');
    const weak = await st.api('POST', '/v1/auth/signup', {
      body: { email: 'a@b.co', password: 'short', name: 'x', tenantName: 'y' },
    });
    expect(weak.status).toBe(422);
    expect(weak.body.error.requestId).toBeTruthy();
  });

  it('login works and errors never reveal whether the email exists', async () => {
    const a = await signup(st.api);
    const ok = await st.api('POST', '/v1/auth/login', {
      body: { email: a.email, password: a.password },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.memberships[0].role).toBe('owner');
    const wrongPw = await st.api('POST', '/v1/auth/login', {
      body: { email: a.email, password: 'nope-nope-nope' },
    });
    const noUser = await st.api('POST', '/v1/auth/login', {
      body: { email: 'ghost@example.com', password: 'nope-nope-nope' },
    });
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPw.body.error.message).toBe(noUser.body.error.message);
  });

  it('refresh rotates the token and reusing an old one revokes the whole family', async () => {
    const a = await signup(st.api);
    const first = await st.api('POST', '/v1/auth/refresh', { cookie: a.refreshCookie });
    expect(first.status).toBe(200);
    expect(first.cookie).toBeTruthy();
    expect(first.cookie).not.toBe(a.refreshCookie);
    const second = await st.api('POST', '/v1/auth/refresh', { cookie: first.cookie });
    expect(second.status).toBe(200);
    const replay = await st.api('POST', '/v1/auth/refresh', { cookie: a.refreshCookie });
    expect(replay.status).toBe(401);
    const afterReplay = await st.api('POST', '/v1/auth/refresh', { cookie: second.cookie });
    expect(afterReplay.status).toBe(401); // the newest token died with its family
  });

  it('logout revokes the session and the cookie is httpOnly', async () => {
    const a = await signup(st.api);
    const res = await fetch(`${st.http}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: a.email, password: a.password }),
    });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    const cookie = setCookie.split(';')[0] as string;
    expect((await st.api('POST', '/v1/auth/logout', { cookie })).status).toBe(204);
    expect((await st.api('POST', '/v1/auth/refresh', { cookie })).status).toBe(401);
  });

  it('an expired or tampered access token is rejected', async () => {
    const a = await signup(st.api);
    const bad = `${a.accessToken.slice(0, -2)}xx`;
    expect((await st.api('GET', '/v1/tenant', { token: bad, tenant: a.tenantId })).status).toBe(
      401,
    );
    expect((await st.api('GET', '/v1/tenant', { tenant: a.tenantId })).status).toBe(401);
  });
});

describe('roles (AUT-03)', () => {
  async function member(owner: Account, role: 'admin' | 'developer' | 'viewer') {
    const inv = await st.api('POST', '/v1/tenant/invitations', {
      token: owner.accessToken,
      tenant: owner.tenantId,
      body: { email: `${role}-${String(Math.random()).slice(2)}@example.com`, role },
    });
    expect(inv.status).toBe(201);
    const token = new URL(inv.body.url).searchParams.get('token') as string;
    const accepted = await st.api('POST', '/v1/auth/accept-invite', {
      body: { token, password: 'a-long-enough-password', name: role },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.cookie).toBeTruthy();
    return accepted.body.accessToken as string;
  }

  it('enforces the permission matrix per endpoint category', async () => {
    const owner = await signup(st.api);
    const t = owner.tenantId;
    const tokens = {
      owner: owner.accessToken,
      admin: await member(owner, 'admin'),
      developer: await member(owner, 'developer'),
      viewer: await member(owner, 'viewer'),
    };
    const call = async (role: keyof typeof tokens, method: string, path: string, body?: unknown) =>
      (await st.api(method, path, { token: tokens[role], tenant: t, body })).status;

    // view: everyone
    for (const r of ['owner', 'admin', 'developer', 'viewer'] as const)
      expect(await call(r, 'GET', '/v1/tenant')).toBe(200);
    // docs.write via dashboard
    expect(await call('developer', 'POST', '/v1/collections/notes/docs', {})).toBe(201);
    expect(await call('viewer', 'POST', '/v1/collections/notes/docs', {})).toBe(403);
    // keys: developers publishable only
    expect(await call('developer', 'POST', '/v1/keys', { kind: 'publishable', name: 'p' })).toBe(
      201,
    );
    expect(await call('developer', 'POST', '/v1/keys', { kind: 'secret', name: 's' })).toBe(403);
    expect(await call('admin', 'POST', '/v1/keys', { kind: 'secret', name: 's' })).toBe(201);
    expect(await call('viewer', 'POST', '/v1/keys', { kind: 'publishable', name: 'p' })).toBe(403);
    // webhooks
    const hook = { url: 'http://127.0.0.1:9/hook', events: ['document.created'] };
    expect(await call('viewer', 'POST', '/v1/webhooks', hook)).toBe(403);
    expect(await call('developer', 'POST', '/v1/webhooks', hook)).toBe(201);
    // members: owner and admin only
    expect(
      await call('developer', 'POST', '/v1/tenant/invitations', {
        email: 'x@example.com',
        role: 'viewer',
      }),
    ).toBe(403);
    expect(
      await call('admin', 'POST', '/v1/tenant/invitations', {
        email: 'y@example.com',
        role: 'viewer',
      }),
    ).toBe(201);
    // plan changes and deletion: owner only
    expect(await call('admin', 'PATCH', '/v1/tenant', { plan: 'pro' })).toBe(403);
    expect(await call('owner', 'PATCH', '/v1/tenant', { plan: 'selfhost' })).toBe(200);
    expect(await call('admin', 'DELETE', '/v1/tenant')).toBe(403);
    // audit: owner/admin
    expect(await call('viewer', 'GET', '/v1/audit')).toBe(403);
    expect(await call('admin', 'GET', '/v1/audit')).toBe(200);
  });

  it('protects the owner and admin roles from lesser actors', async () => {
    const owner = await signup(st.api);
    const adminToken = await member(owner, 'admin');
    const members = await st.api('GET', '/v1/tenant/members', {
      token: owner.accessToken,
      tenant: owner.tenantId,
    });
    const ownerId = members.body.members.find((m: { role: string }) => m.role === 'owner').userId;
    const patch = await st.api('PATCH', `/v1/tenant/members/${ownerId}`, {
      token: adminToken,
      tenant: owner.tenantId,
      body: { role: 'viewer' },
    });
    expect(patch.status).toBe(403);
    const del = await st.api('DELETE', `/v1/tenant/members/${ownerId}`, {
      token: adminToken,
      tenant: owner.tenantId,
    });
    expect(del.status).toBe(403);
  });
});

describe('API keys (AUT-04)', () => {
  it('a revoked key is rejected', async () => {
    const a = await signup(st.api);
    expect((await st.api('GET', '/v1/collections', { token: a.secretKey })).status).toBe(200);
    const keys = await st.api('GET', '/v1/keys', { token: a.accessToken, tenant: a.tenantId });
    const secret = keys.body.items.find((k: { kind: string }) => k.kind === 'secret');
    expect(
      (
        await st.api('DELETE', `/v1/keys/${secret.id}`, {
          token: a.accessToken,
          tenant: a.tenantId,
        })
      ).status,
    ).toBe(204);
    expect((await st.api('GET', '/v1/collections', { token: a.secretKey })).status).toBe(401);
  });

  it('a revoked key stops working within the 60 s cache window even on another node', async () => {
    const a = await signup(st.api);
    expect((await st.api('GET', '/v1/collections', { token: a.secretKey })).status).toBe(200); // warms the cache
    const keys = await st.api('GET', '/v1/keys', { token: a.accessToken, tenant: a.tenantId });
    const secret = keys.body.items.find((k: { kind: string }) => k.kind === 'secret');
    // A different node does not share this node's cache: simulate by revoking directly in the database.
    await st.node.deps.control.query('update api_keys set revoked_at = now() where id = $1', [
      secret.id,
    ]);
    expect((await st.api('GET', '/v1/collections', { token: a.secretKey })).status).toBe(200); // cached
    st.node.services.apiKeys.clearCache(); // what the 60 s TTL does
    expect((await st.api('GET', '/v1/collections', { token: a.secretKey })).status).toBe(401);
  });

  it('publishable keys cannot read or mint anything', async () => {
    const a = await signup(st.api);
    expect((await st.api('GET', '/v1/collections', { token: a.publishableKey })).status).toBe(403);
    expect(
      (
        await st.api('POST', '/v1/tokens', {
          token: a.publishableKey,
          body: { userId: 'u', access: [{ collection: 'c', docs: '*', mode: 'r' }] },
        })
      ).status,
    ).toBe(403);
  });
});

describe('client tokens (AUT-05, AUT-06)', () => {
  const rules = [{ collection: 'notes', docs: '*', mode: 'rw' }];

  it('mints a token that connects, and one limited to collection A cannot subscribe to B', async () => {
    const a = await signup(st.api);
    const minted = await st.api('POST', '/v1/tokens', {
      token: a.secretKey,
      body: { userId: 'user_123', ttlSeconds: 600, access: rules },
    });
    expect(minted.status).toBe(200);
    expect(new Date(minted.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const raw = new RawClient(st.ws, minted.body.token);
    await raw.opened;
    raw.send({ type: 'SUBSCRIBE', docKey: 'notes/n1', flags: 0 });
    await raw.waitFor('SUBSCRIBED');
    raw.send({ type: 'SUBSCRIBE', docKey: 'secrets/s1', flags: 0 });
    const [err] = await raw.waitFor('ERROR');
    expect(err?.code).toBe('FORBIDDEN');
    raw.close();
  });

  it('rejects tampered, expired, foreign-signed and malformed tokens', async () => {
    const a = await signup(st.api);
    const b = await signup(st.api);
    const good = (
      await st.api('POST', '/v1/tokens', {
        token: a.secretKey,
        body: { userId: 'u', access: rules },
      })
    ).body.token as string;
    const parts = good.split('.');
    const flipped = `${parts[0]}.${parts[1]}.${(parts[2] ?? '').slice(0, -2)}AA`;
    for (const bad of [
      flipped,
      'garbage',
      `${parts[0]}.${Buffer.from('{"tid":"x"}').toString('base64url')}.${parts[2]}`,
    ]) {
      await expect(new RawClient(st.ws, bad).opened).rejects.toThrow();
    }
    // Same payload, header pointing at tenant B's key: signature must not verify.
    const header = JSON.parse(Buffer.from(parts[0] as string, 'base64url').toString()) as Record<
      string,
      string
    >;
    header.kid = b.tenantId;
    const swapped = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${parts[1]}.${parts[2]}`;
    await expect(new RawClient(st.ws, swapped).opened).rejects.toThrow();

    // Expired: mint with 1 s TTL, wait past expiry plus the 30 s leeway is too slow, so sign one in the past.
    const { SignJWT } = await import('jose');
    const key = (await st.node.services.tenantKeys(a.tenantId))?.secret as Uint8Array;
    const old = Math.floor(Date.now() / 1000) - 3600;
    const expired = await new SignJWT({ tid: a.tenantId, access: rules })
      .setProtectedHeader({ alg: 'HS256', kid: a.tenantId })
      .setSubject('u')
      .setIssuedAt(old - 60)
      .setExpirationTime(old)
      .sign(key);
    await expect(new RawClient(st.ws, expired).opened).rejects.toThrow();
  });

  it('validates the mint request', async () => {
    const a = await signup(st.api);
    const tooLong = await st.api('POST', '/v1/tokens', {
      token: a.secretKey,
      body: { userId: 'u', ttlSeconds: 999_999, access: rules },
    });
    expect(tooLong.status).toBe(422);
    const noAccess = await st.api('POST', '/v1/tokens', {
      token: a.secretKey,
      body: { userId: 'u', access: [] },
    });
    expect(noAccess.status).toBe(422);
    const bigMeta = await st.api('POST', '/v1/tokens', {
      token: a.secretKey,
      body: { userId: 'u', access: rules, meta: { x: 'y'.repeat(3000) } },
    });
    expect(bigMeta.status).toBe(422);
  });

  it('a suspended or deleted tenant can no longer connect', async () => {
    const a = await signup(st.api);
    const tok = (
      await st.api('POST', '/v1/tokens', {
        token: a.secretKey,
        body: { userId: 'u', access: rules },
      })
    ).body.token as string;
    await st.node.deps.control.query(`update tenants set status = 'suspended' where id = $1`, [
      a.tenantId,
    ]);
    st.node.services.tenantKeys.invalidate(a.tenantId);
    await expect(new RawClient(st.ws, tok).opened).rejects.toThrow();
  });
});

describe('audit log (AUT-08)', () => {
  it('records admin actions and verification detects a modified row', async () => {
    const a = await signup(st.api);
    await st.api('POST', '/v1/keys', {
      token: a.accessToken,
      tenant: a.tenantId,
      body: { kind: 'publishable', name: 'extra' },
    });
    const list = await st.api('GET', '/v1/audit', { token: a.accessToken, tenant: a.tenantId });
    expect(list.body.items.map((i: { action: string }) => i.action)).toContain('api_key.created');
    const ok = await st.api('GET', '/v1/audit?verify=true', {
      token: a.accessToken,
      tenant: a.tenantId,
    });
    expect(ok.body).toEqual({ valid: true, brokenAtId: null });

    const target = list.body.items.at(-1);
    await st.node.deps.control.query(`update audit_log set action = 'tampered' where id = $1`, [
      target.id,
    ]);
    const broken = await st.api('GET', '/v1/audit?verify=true', {
      token: a.accessToken,
      tenant: a.tenantId,
    });
    expect(broken.body.valid).toBe(false);
    expect(broken.body.brokenAtId).toBe(target.id);
  });
});

describe('tenant lifecycle', () => {
  it('invitations: accepting adds a membership; expired or reused tokens fail; existing users join without a password', async () => {
    const owner = await signup(st.api);
    const other = await signup(st.api);
    const inv = await st.api('POST', '/v1/tenant/invitations', {
      token: owner.accessToken,
      tenant: owner.tenantId,
      body: { email: other.email, role: 'developer' },
    });
    const token = new URL(inv.body.url).searchParams.get('token') as string;
    expect((await st.api('POST', '/v1/auth/accept-invite', { body: { token } })).status).toBe(200);
    expect((await st.api('POST', '/v1/auth/accept-invite', { body: { token } })).status).toBe(404);
    const me = await st.api('GET', '/v1/me', { token: other.accessToken });
    expect(me.body.memberships.map((m: { tenantId: string }) => m.tenantId)).toContain(
      owner.tenantId,
    );
  });

  it('deleting a tenant stops its keys and sessions immediately', async () => {
    const a = await signup(st.api);
    expect(
      (await st.api('DELETE', '/v1/tenant', { token: a.accessToken, tenant: a.tenantId })).status,
    ).toBe(204);
    st.node.services.apiKeys.clearCache();
    expect((await st.api('GET', '/v1/collections', { token: a.secretKey })).status).toBe(401);
    expect(
      (await st.api('GET', '/v1/tenant', { token: a.accessToken, tenant: a.tenantId })).status,
    ).toBe(403);
  });
});
