/** Control-plane REST routes (Doc 03 §4.1, §4.2, §4.6, §4.7): accounts, tenant, members, keys, tokens, audit, usage, webhooks. */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { SyncraError, paginationSchema } from '@syncra/shared';
import { listAudit, verifyAudit } from '../control/audit.js';
import { REFRESH_TTL_MS } from '../control/accounts.js';
import { requireCan } from '../control/roles.js';
import { mintClientToken, mintRequestSchema } from '../control/signing.js';
import type { Services } from '../services.js';
import { endpointInput, endpointPatch } from '../webhooks/service.js';
import { authDashboard, authSecret, authSecretOrDashboard, bearer, parse } from './auth.js';

const REFRESH_COOKIE = 'syncra_refresh';
const email = z
  .string()
  .email()
  .max(254)
  .transform((e) => e.toLowerCase());
const password = z.string().min(10).max(200);

export function registerControlRoutes(app: FastifyInstance, s: Services): void {
  const setRefresh = (reply: FastifyReply, token: string): void => {
    void reply.setCookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: s.cfg.NODE_ENV === 'production',
      path: '/v1/auth',
      maxAge: REFRESH_TTL_MS / 1000,
    });
  };

  /** Login/signup/refresh attempts are limited per IP (default 5 per minute). */
  const authLimit = async (ip: string): Promise<void> => {
    const perMin = s.cfg.RL_AUTH_PER_MIN;
    const r = await s.limiter.take(`auth:${ip}`, { capacity: perMin, ratePerSec: perMin / 60 });
    if (!r.allowed)
      throw new SyncraError('RATE_LIMITED', 'Too many attempts', {
        scope: 'auth',
        retryAfterMs: r.retryAfterMs,
      });
  };

  // ---- accounts -------------------------------------------------------------------------
  app.post('/auth/signup', async (req, reply) => {
    await authLimit(req.ip);
    const b = parse(
      z.object({
        email,
        password,
        name: z.string().min(1).max(100),
        tenantName: z.string().min(1).max(100),
      }),
      req.body,
    );
    const r = await s.accounts.signup(b);
    setRefresh(reply, r.refreshToken);
    return reply
      .status(201)
      .send({ accessToken: r.accessToken, user: r.user, tenant: r.tenant, keys: r.keys });
  });

  app.post('/auth/login', async (req, reply) => {
    await authLimit(req.ip);
    const b = parse(z.object({ email, password: z.string().min(1).max(200) }), req.body);
    const r = await s.accounts.login(b.email, b.password);
    setRefresh(reply, r.refreshToken);
    return { accessToken: r.accessToken, user: r.user, memberships: r.memberships };
  });

  app.post('/auth/refresh', async (req, reply) => {
    await authLimit(req.ip);
    const raw = req.cookies[REFRESH_COOKIE];
    if (!raw) throw new SyncraError('UNAUTHENTICATED', 'No refresh cookie');
    const r = await s.accounts.refresh(raw);
    setRefresh(reply, r.refreshToken);
    return { accessToken: r.accessToken };
  });

  app.post('/auth/logout', async (req, reply) => {
    const raw = req.cookies[REFRESH_COOKIE];
    if (raw) await s.accounts.logout(raw);
    void reply.clearCookie(REFRESH_COOKIE, { path: '/v1/auth' });
    return reply.status(204).send();
  });

  app.post('/auth/accept-invite', async (req, reply) => {
    await authLimit(req.ip);
    const b = parse(
      z.object({
        token: z.string().min(10).max(200),
        password: password.optional(),
        name: z.string().min(1).max(100).optional(),
      }),
      req.body,
    );
    const { userId } = await s.tenants.acceptInvite(b.token, b);
    const session = await s.accounts.startSession(userId);
    setRefresh(reply, session.refreshToken);
    return { accessToken: session.accessToken };
  });

  app.get('/me', async (req) => {
    const token = bearer(req);
    const userId = await s.accounts.verifyAccess(token);
    const memberships = await s.accounts.memberships(userId);
    const header = req.headers['x-tenant-id'];
    const active = memberships.find((m) => m.tenantId === header) ?? memberships[0] ?? null;
    return { user: await s.accounts.getUser(userId), memberships, activeTenant: active };
  });

  // ---- tenant ---------------------------------------------------------------------------
  app.get('/tenant', async (req) => {
    const p = await authDashboard(s, req);
    const [tenant, usage] = await Promise.all([
      s.accounts.getTenant(p.tenantId),
      s.quotas.snapshot(p.tenantId),
    ]);
    return { tenant, role: p.role, ...usage };
  });

  app.patch('/tenant', async (req) => {
    const p = await authDashboard(s, req);
    const b = parse(
      z.object({
        name: z.string().min(1).max(100).optional(),
        plan: z.enum(['free', 'pro', 'business', 'selfhost']).optional(),
      }),
      req.body,
    );
    if (b.name) await s.tenants.rename(p.tenantId, p, b.name);
    if (b.plan) await s.tenants.changePlan(p.tenantId, p, b.plan);
    return { tenant: await s.accounts.getTenant(p.tenantId) };
  });

  app.delete('/tenant', async (req, reply) => {
    const p = await authDashboard(s, req);
    await s.tenants.softDelete(p.tenantId, p);
    return reply.status(204).send();
  });

  app.get('/tenant/members', async (req) => {
    const p = await authDashboard(s, req);
    return s.tenants.members(p.tenantId);
  });

  app.post('/tenant/invitations', async (req, reply) => {
    const p = await authDashboard(s, req);
    const b = parse(z.object({ email, role: z.enum(['admin', 'developer', 'viewer']) }), req.body);
    return reply.status(201).send(await s.tenants.invite(p.tenantId, p, b.email, b.role));
  });

  app.patch('/tenant/members/:userId', async (req) => {
    const p = await authDashboard(s, req);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), req.params);
    const b = parse(z.object({ role: z.enum(['admin', 'developer', 'viewer']) }), req.body);
    await s.tenants.changeRole(p.tenantId, p, userId, b.role);
    return { ok: true };
  });

  app.delete('/tenant/members/:userId', async (req, reply) => {
    const p = await authDashboard(s, req);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), req.params);
    await s.tenants.removeMember(p.tenantId, p, userId);
    return reply.status(204).send();
  });

  // ---- keys and client tokens -----------------------------------------------------------
  app.get('/keys', async (req) => {
    const p = await authDashboard(s, req);
    return { items: await s.apiKeys.list(p.tenantId) };
  });

  app.post('/keys', async (req, reply) => {
    const p = await authDashboard(s, req);
    const b = parse(
      z.object({ kind: z.enum(['secret', 'publishable']), name: z.string().min(1).max(100) }),
      req.body,
    );
    const r = await s.apiKeys.create(p.tenantId, p, b);
    return reply.status(201).send({ ...r.dto, key: r.key });
  });

  app.delete('/keys/:id', async (req, reply) => {
    const p = await authDashboard(s, req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    await s.apiKeys.revoke(p.tenantId, p, id);
    return reply.status(204).send();
  });

  app.post('/tokens', async (req) => {
    const p = await authSecret(s, req);
    return mintClientToken(s.tenantKeys, p.tenantId, parse(mintRequestSchema, req.body));
  });

  // ---- audit, usage ---------------------------------------------------------------------
  app.get('/audit', async (req) => {
    const p = await authDashboard(s, req);
    requireCan(p.role, 'audit.read');
    const q = parse(
      z.object({
        verify: z.enum(['true', 'false']).optional(),
        limit: paginationSchema.shape.limit,
        cursor: z.string().regex(/^\d+$/).optional(),
      }),
      req.query,
    );
    if (q.verify === 'true') return verifyAudit(s.deps.control, p.tenantId);
    return listAudit(s.deps.control, p.tenantId, q.limit, q.cursor ? Number(q.cursor) : undefined);
  });

  app.get('/usage/current', async (req) => {
    const p = await authSecretOrDashboard(s, req);
    return s.quotas.snapshot(p.tenantId);
  });

  app.get('/usage', async (req) => {
    const p = await authDashboard(s, req);
    const q = parse(
      z.object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        metric: z
          .enum(['ops', 'bytes_written', 'connections_peak', 'docs_created', 'docs_active'])
          .default('ops'),
        granularity: z.enum(['hour', 'day']).default('hour'),
      }),
      req.query,
    );
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - 24 * 3600 * 1000);
    const { rows } = await s.deps.control.query<{ at: Date; value: string }>(
      `select date_trunc($5, hour) at, sum(value)::text value from usage_hourly
       where tenant_id = $1 and metric = $2 and hour >= $3 and hour <= $4 group by 1 order by 1`,
      [p.tenantId, q.metric, from, to, q.granularity],
    );
    return {
      metric: q.metric,
      granularity: q.granularity,
      items: rows.map((r) => ({ at: r.at.toISOString(), value: Number(r.value) })),
    };
  });

  // ---- webhooks -------------------------------------------------------------------------
  app.get('/webhooks', async (req) => ({
    items: await s.webhooks.list((await authDashboard(s, req)).tenantId),
  }));

  app.post('/webhooks', async (req, reply) => {
    const p = await authDashboard(s, req);
    return reply
      .status(201)
      .send(await s.webhooks.create(p.tenantId, p, parse(endpointInput, req.body)));
  });

  const idParam = z.object({ id: z.string().uuid() });

  app.patch('/webhooks/:id', async (req) => {
    const p = await authDashboard(s, req);
    return s.webhooks.update(
      p.tenantId,
      p,
      parse(idParam, req.params).id,
      parse(endpointPatch, req.body),
    );
  });

  app.delete('/webhooks/:id', async (req, reply) => {
    const p = await authDashboard(s, req);
    await s.webhooks.remove(p.tenantId, p, parse(idParam, req.params).id);
    return reply.status(204).send();
  });

  app.post('/webhooks/:id/test', async (req, reply) => {
    const p = await authDashboard(s, req);
    await s.webhooks.sendTest(p.tenantId, p, parse(idParam, req.params).id);
    return reply.status(202).send({ queued: true });
  });

  app.get('/webhooks/:id/deliveries', async (req) => {
    const p = await authDashboard(s, req);
    const limit = parse(paginationSchema.pick({ limit: true }), req.query).limit;
    return { items: await s.webhooks.deliveries(p.tenantId, parse(idParam, req.params).id, limit) };
  });

  app.post('/webhooks/deliveries/:id/retry', async (req, reply) => {
    const p = await authDashboard(s, req);
    await s.webhooks.retry(p.tenantId, p, parse(idParam, req.params).id);
    return reply.status(202).send({ queued: true });
  });
}
