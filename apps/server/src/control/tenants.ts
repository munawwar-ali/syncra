/** Tenant info, plan changes, members and invitations (AUT-03, AUT-09). */
import * as argon2 from 'argon2';
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { SyncraError } from '@syncra/shared';
import { randomToken, sha256 } from '../auth/crypto.js';
import { isUniqueViolation, withTx } from '../db/tx.js';
import { appendAudit } from './audit.js';
import { requireCan, type Role } from './roles.js';

export type Plan = 'free' | 'pro' | 'business' | 'selfhost';
type Actor = { userId: string; role: Role };

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export class Tenants {
  constructor(
    private readonly db: pg.Pool,
    private readonly hooks: {
      onPlanChange?: (tenantId: string) => void;
      mail: (to: string, url: string) => void;
    },
    private readonly publicUrl: string,
  ) {}

  async rename(tenantId: string, actor: Actor, name: string): Promise<void> {
    requireCan(actor.role, 'members.manage');
    await this.db.query('update tenants set name = $2, updated_at = now() where id = $1', [
      tenantId,
      name,
    ]);
    await appendAudit(this.db, {
      tenantId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'tenant.renamed',
    });
  }

  async changePlan(tenantId: string, actor: Actor, plan: Plan): Promise<void> {
    requireCan(actor.role, 'billing.manage');
    const { rows } = await this.db.query<{ plan: string }>(
      'select plan from tenants where id = $1',
      [tenantId],
    );
    await this.db.query('update tenants set plan = $2, updated_at = now() where id = $1', [
      tenantId,
      plan,
    ]);
    await appendAudit(this.db, {
      tenantId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'plan.changed',
      meta: { from: rows[0]?.plan ?? null, to: plan },
    });
    this.hooks.onPlanChange?.(tenantId);
  }

  /** Soft delete: the tenant stops authenticating immediately; data is purged later by the worker. */
  async softDelete(tenantId: string, actor: Actor): Promise<void> {
    requireCan(actor.role, 'tenant.delete');
    await this.db.query(`update tenants set status = 'deleted', updated_at = now() where id = $1`, [
      tenantId,
    ]);
    await appendAudit(this.db, {
      tenantId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'tenant.deleted',
    });
    this.hooks.onPlanChange?.(tenantId);
  }

  async members(tenantId: string) {
    const [m, i] = await Promise.all([
      this.db.query<{
        user_id: string;
        email: string;
        name: string;
        role: string;
        created_at: Date;
      }>(
        `select m.user_id, u.email, u.name, m.role, m.created_at from memberships m
         join users u on u.id = m.user_id where m.tenant_id = $1 order by m.created_at`,
        [tenantId],
      ),
      this.db.query<{ id: string; email: string; role: string; expires_at: Date }>(
        `select id, email, role, expires_at from invitations
         where tenant_id = $1 and accepted_at is null and expires_at > now() order by expires_at`,
        [tenantId],
      ),
    ]);
    return {
      members: m.rows.map((r) => ({
        userId: r.user_id,
        email: r.email,
        name: r.name,
        role: r.role as Role,
        joinedAt: r.created_at.toISOString(),
      })),
      invitations: i.rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role as Role,
        expiresAt: r.expires_at.toISOString(),
      })),
    };
  }

  async invite(tenantId: string, actor: Actor, email: string, role: Exclude<Role, 'owner'>) {
    requireCan(actor.role, 'members.manage');
    const raw = randomToken();
    const id = uuidv7();
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
    await this.db.query(
      `insert into invitations (id, tenant_id, email, role, token_hash, expires_at, created_by)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, tenantId, email, role, sha256(raw), expiresAt, actor.userId],
    );
    await appendAudit(this.db, {
      tenantId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'member.invited',
      target: id,
      meta: { role },
    });
    const url = `${this.publicUrl}/accept-invite?token=${raw}`;
    this.hooks.mail(email, url);
    return { id, url, expiresAt: expiresAt.toISOString() };
  }

  /** Accepts an invite token. An unknown email creates an account (password and name required). */
  async acceptInvite(
    token: string,
    extra: { password?: string; name?: string },
  ): Promise<{ userId: string; tenantId: string }> {
    const { rows } = await this.db.query<{
      id: string;
      tenant_id: string;
      email: string;
      role: string;
    }>(
      `select id, tenant_id, email, role from invitations
       where token_hash = $1 and accepted_at is null and expires_at > now()`,
      [sha256(token)],
    );
    const inv = rows[0];
    if (!inv) throw new SyncraError('NOT_FOUND', 'Invitation not found or expired');
    return withTx(this.db, async (c) => {
      const claimed = await c.query(
        'update invitations set accepted_at = now() where id = $1 and accepted_at is null',
        [inv.id],
      );
      if (claimed.rowCount === 0)
        throw new SyncraError('NOT_FOUND', 'Invitation not found or expired');
      const existing = await c.query<{ id: string }>('select id from users where email = $1', [
        inv.email,
      ]);
      let userId = existing.rows[0]?.id;
      if (!userId) {
        if (!extra.password || !extra.name) {
          throw new SyncraError(
            'VALIDATION_FAILED',
            'password and name are required for a new account',
          );
        }
        userId = uuidv7();
        await c.query('insert into users (id, email, password_hash, name) values ($1,$2,$3,$4)', [
          userId,
          inv.email,
          await argon2.hash(extra.password, {
            type: argon2.argon2id,
            memoryCost: 65536,
            timeCost: 3,
            parallelism: 1,
          }),
          extra.name,
        ]);
      }
      try {
        await c.query('insert into memberships (tenant_id, user_id, role) values ($1,$2,$3)', [
          inv.tenant_id,
          userId,
          inv.role,
        ]);
      } catch (e) {
        if (isUniqueViolation(e))
          throw new SyncraError('CONFLICT', 'Already a member of this tenant');
        throw e;
      }
      await appendAudit(c, {
        tenantId: inv.tenant_id,
        actorType: 'user',
        actorId: userId,
        action: 'member.joined',
        target: userId,
      });
      return { userId, tenantId: inv.tenant_id };
    });
  }

  async changeRole(
    tenantId: string,
    actor: Actor,
    userId: string,
    role: Exclude<Role, 'owner'>,
  ): Promise<void> {
    requireCan(actor.role, 'members.manage');
    const target = await this.roleOf(tenantId, userId);
    if (target === 'owner') throw new SyncraError('FORBIDDEN', 'The owner role cannot be changed');
    if (target === 'admin' && actor.role !== 'owner')
      throw new SyncraError('FORBIDDEN', 'Only the owner can change an admin');
    await this.db.query('update memberships set role = $3 where tenant_id = $1 and user_id = $2', [
      tenantId,
      userId,
      role,
    ]);
    await appendAudit(this.db, {
      tenantId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'member.role_changed',
      target: userId,
      meta: { role },
    });
  }

  async removeMember(tenantId: string, actor: Actor, userId: string): Promise<void> {
    requireCan(actor.role, 'members.manage');
    const target = await this.roleOf(tenantId, userId);
    if (target === 'owner') throw new SyncraError('FORBIDDEN', 'The owner cannot be removed');
    if (target === 'admin' && actor.role !== 'owner')
      throw new SyncraError('FORBIDDEN', 'Only the owner can remove an admin');
    await this.db.query('delete from memberships where tenant_id = $1 and user_id = $2', [
      tenantId,
      userId,
    ]);
    await appendAudit(this.db, {
      tenantId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'member.removed',
      target: userId,
    });
  }

  private async roleOf(tenantId: string, userId: string): Promise<Role> {
    const { rows } = await this.db.query<{ role: Role }>(
      'select role from memberships where tenant_id = $1 and user_id = $2',
      [tenantId, userId],
    );
    if (!rows[0]) throw new SyncraError('NOT_FOUND', 'Member not found');
    return rows[0].role;
  }

  /** Membership lookup used to authorize dashboard requests. */
  async roleFor(tenantId: string, userId: string): Promise<Role | null> {
    const { rows } = await this.db.query<{ role: Role }>(
      `select m.role from memberships m join tenants t on t.id = m.tenant_id
       where m.tenant_id = $1 and m.user_id = $2 and t.status = 'active'`,
      [tenantId, userId],
    );
    return rows[0]?.role ?? null;
  }
}
