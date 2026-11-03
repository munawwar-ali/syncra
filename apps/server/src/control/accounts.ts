/** Accounts: signup, login, rotating refresh tokens with family revocation (AUT-01, AUT-02). */
import * as argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { SyncraError } from '@syncra/shared';
import {
  encrypt,
  generateKey,
  generateSigningSecret,
  randomToken,
  sha256,
} from '../auth/crypto.js';
import { isUniqueViolation, withTx } from '../db/tx.js';
import { appendAudit } from './audit.js';

export const ACCESS_TTL_S = 15 * 60;
export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;

const ARGON = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;
// Verified against when the email is unknown so response time does not reveal which emails exist.
const DUMMY_HASH = await argon2.hash('syncra-dummy-password', ARGON);

export interface AccountsConfig {
  jwtSecret: string;
  encryptionKey: Buffer;
  defaultPlan: 'free' | 'pro' | 'business' | 'selfhost';
}

export interface UserDto {
  id: string;
  email: string;
  name: string;
}
export interface TenantDto {
  id: string;
  slug: string;
  name: string;
  plan: string;
  status: string;
}
export interface MembershipDto {
  tenantId: string;
  tenantName: string;
  slug: string;
  role: string;
}

export class Accounts {
  private readonly jwtKey: Uint8Array;

  constructor(
    private readonly db: pg.Pool,
    private readonly cfg: AccountsConfig,
  ) {
    this.jwtKey = new TextEncoder().encode(cfg.jwtSecret);
  }

  async signAccess(userId: string): Promise<string> {
    return new SignJWT({ typ: 'dash' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(`${String(ACCESS_TTL_S)}s`)
      .setJti(randomUUID())
      .sign(this.jwtKey);
  }

  /** Returns the user id of a valid dashboard access token. */
  async verifyAccess(token: string): Promise<string> {
    try {
      const { payload } = await jwtVerify(token, this.jwtKey, { algorithms: ['HS256'] });
      if (payload.typ !== 'dash' || !payload.sub) throw new Error('wrong token type');
      return payload.sub;
    } catch {
      throw new SyncraError('UNAUTHENTICATED', 'Invalid or expired access token');
    }
  }

  async signup(input: { email: string; password: string; name: string; tenantName: string }) {
    const passwordHash = await argon2.hash(input.password, ARGON);
    const userId = uuidv7();
    const tenantId = uuidv7();
    const secret = generateKey('sk_live_');
    const publishable = generateKey('pk_live_');
    try {
      const refresh = await withTx(this.db, async (c) => {
        await c.query('insert into users (id, email, password_hash, name) values ($1,$2,$3,$4)', [
          userId,
          input.email,
          passwordHash,
          input.name,
        ]);
        await this.insertTenant(c, tenantId, input.tenantName);
        await c.query(`insert into memberships (tenant_id, user_id, role) values ($1,$2,'owner')`, [
          tenantId,
          userId,
        ]);
        for (const [kind, k] of [
          ['secret', secret],
          ['publishable', publishable],
        ] as const) {
          const id = uuidv7();
          await c.query(
            `insert into api_keys (id, tenant_id, kind, name, prefix, key_hash, created_by)
             values ($1,$2,$3,$4,$5,$6,$7)`,
            [id, tenantId, kind, `Default ${kind} key`, k.prefix, k.hash, userId],
          );
          await appendAudit(c, {
            tenantId,
            actorType: 'user',
            actorId: userId,
            action: 'api_key.created',
            target: id,
            meta: { kind },
          });
        }
        return this.issueRefresh(c, userId, randomUUID());
      });
      return {
        accessToken: await this.signAccess(userId),
        refreshToken: refresh,
        user: { id: userId, email: input.email, name: input.name } satisfies UserDto,
        tenant: await this.getTenant(tenantId),
        keys: { secret: secret.key, publishable: publishable.key },
      };
    } catch (e) {
      if (isUniqueViolation(e, 'users_email_key')) {
        throw new SyncraError('CONFLICT', 'Email already registered');
      }
      throw e;
    }
  }

  private async insertTenant(c: pg.PoolClient, id: string, name: string): Promise<void> {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'tenant';
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug =
        attempt === 0
          ? base
          : `${base}-${randomToken()
              .slice(0, 4)
              .toLowerCase()
              .replace(/[^a-z0-9]/g, 'x')}`;
      // A savepoint lets a slug collision retry without aborting the signup transaction.
      await c.query('savepoint slug');
      try {
        await c.query(
          `insert into tenants (id, slug, name, plan, signing_secret_enc) values ($1,$2,$3,$4,$5)`,
          [
            id,
            slug,
            name,
            this.cfg.defaultPlan,
            encrypt(generateSigningSecret(), this.cfg.encryptionKey),
          ],
        );
        await c.query('release savepoint slug');
        return;
      } catch (e) {
        await c.query('rollback to savepoint slug');
        if (!isUniqueViolation(e, 'tenants_slug_key')) throw e;
      }
    }
    throw new SyncraError('CONFLICT', 'Could not allocate a tenant slug');
  }

  async getTenant(id: string): Promise<TenantDto> {
    const { rows } = await this.db.query<TenantDto>(
      'select id, slug, name, plan, status from tenants where id = $1',
      [id],
    );
    if (!rows[0]) throw new SyncraError('NOT_FOUND', 'Tenant not found');
    return rows[0];
  }

  async memberships(userId: string): Promise<MembershipDto[]> {
    const { rows } = await this.db.query<{
      tenant_id: string;
      name: string;
      slug: string;
      role: string;
    }>(
      `select m.tenant_id, t.name, t.slug, m.role from memberships m
       join tenants t on t.id = m.tenant_id
       where m.user_id = $1 and t.status <> 'deleted' order by m.created_at`,
      [userId],
    );
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      tenantName: r.name,
      slug: r.slug,
      role: r.role,
    }));
  }

  async getUser(id: string): Promise<UserDto> {
    const { rows } = await this.db.query<UserDto>(
      'select id, email, name from users where id = $1',
      [id],
    );
    if (!rows[0]) throw new SyncraError('NOT_FOUND', 'User not found');
    return rows[0];
  }

  async login(email: string, password: string) {
    const { rows } = await this.db.query<{
      id: string;
      password_hash: string;
      name: string;
      email: string;
    }>('select id, password_hash, name, email from users where email = $1', [email]);
    const user = rows[0];
    const ok = await argon2.verify(user?.password_hash ?? DUMMY_HASH, password).catch(() => false);
    if (!user || !ok) throw new SyncraError('UNAUTHENTICATED', 'Invalid email or password');
    const refreshToken = await withTx(this.db, (c) => this.issueRefresh(c, user.id, randomUUID()));
    return {
      accessToken: await this.signAccess(user.id),
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name } satisfies UserDto,
      memberships: await this.memberships(user.id),
    };
  }

  /** Opens a session (access + refresh token) for a user who has just authenticated another way. */
  async startSession(userId: string) {
    const refreshToken = await withTx(this.db, (c) => this.issueRefresh(c, userId, randomUUID()));
    return { accessToken: await this.signAccess(userId), refreshToken };
  }

  private async issueRefresh(c: pg.PoolClient, userId: string, familyId: string): Promise<string> {
    const raw = randomToken();
    await c.query(
      `insert into refresh_tokens (id, family_id, user_id, token_hash, expires_at)
       values ($1,$2,$3,$4,$5)`,
      [uuidv7(), familyId, userId, sha256(raw), new Date(Date.now() + REFRESH_TTL_MS)],
    );
    return raw;
  }

  /** Rotates a refresh token. Presenting an already-used token revokes its whole family. */
  async refresh(raw: string) {
    const hash = sha256(raw);
    const outcome = await withTx(this.db, async (c) => {
      const { rows } = await c.query<{
        id: string;
        family_id: string;
        user_id: string;
        expires_at: Date;
        used_at: Date | null;
        revoked_at: Date | null;
      }>('select * from refresh_tokens where token_hash = $1 for update', [hash]);
      const t = rows[0];
      if (!t) return { error: true as const };
      if (t.used_at || t.revoked_at) {
        await c.query(
          'update refresh_tokens set revoked_at = now() where family_id = $1 and revoked_at is null',
          [t.family_id],
        );
        return { error: true as const };
      }
      if (t.expires_at.getTime() < Date.now()) return { error: true as const };
      await c.query('update refresh_tokens set used_at = now() where id = $1', [t.id]);
      return {
        error: false as const,
        userId: t.user_id,
        next: await this.issueRefresh(c, t.user_id, t.family_id),
      };
    });
    if (outcome.error) throw new SyncraError('UNAUTHENTICATED', 'Invalid refresh token');
    return { accessToken: await this.signAccess(outcome.userId), refreshToken: outcome.next };
  }

  /** Revokes the family of the given refresh token; unknown tokens are ignored. */
  async logout(raw: string): Promise<void> {
    await this.db.query(
      `update refresh_tokens set revoked_at = now()
       where family_id = (select family_id from refresh_tokens where token_hash = $1) and revoked_at is null`,
      [sha256(raw)],
    );
  }
}
