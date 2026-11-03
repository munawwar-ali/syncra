/** API keys (AUT-04): only hashes stored; lookups cached for 60 s so a revoked key stops working within a minute. */
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { SyncraError } from '@syncra/shared';
import { generateKey, sha256 } from '../auth/crypto.js';
import { appendAudit } from './audit.js';
import { requireCan, type Role } from './roles.js';

export type KeyKind = 'secret' | 'publishable';

export interface ApiKeyDto {
  id: string;
  kind: KeyKind;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface KeyPrincipal {
  keyId: string;
  tenantId: string;
  kind: KeyKind;
}

const CACHE_TTL_MS = 60_000;

export class ApiKeys {
  private readonly cache = new Map<string, { value: KeyPrincipal | null; expires: number }>();
  private readonly touched = new Set<string>();

  constructor(
    private readonly db: pg.Pool,
    private readonly now: () => number = Date.now,
  ) {}

  async create(
    tenantId: string,
    actor: { userId: string; role: Role },
    input: { kind: KeyKind; name: string },
  ): Promise<{ key: string; dto: ApiKeyDto }> {
    requireCan(actor.role, input.kind === 'secret' ? 'keys.manage-secret' : 'keys.manage');
    const k = generateKey(input.kind === 'secret' ? 'sk_live_' : 'pk_live_');
    const id = uuidv7();
    const { rows } = await this.db.query<{ created_at: Date }>(
      `insert into api_keys (id, tenant_id, kind, name, prefix, key_hash, created_by)
       values ($1,$2,$3,$4,$5,$6,$7) returning created_at`,
      [id, tenantId, input.kind, input.name, k.prefix, k.hash, actor.userId],
    );
    await appendAudit(this.db, {
      tenantId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'api_key.created',
      target: id,
      meta: { kind: input.kind },
    });
    return {
      key: k.key,
      dto: {
        id,
        kind: input.kind,
        name: input.name,
        prefix: k.prefix,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: (rows[0]?.created_at ?? new Date()).toISOString(),
      },
    };
  }

  async list(tenantId: string): Promise<ApiKeyDto[]> {
    const { rows } = await this.db.query<{
      id: string;
      kind: KeyKind;
      name: string;
      prefix: string;
      last_used_at: Date | null;
      revoked_at: Date | null;
      created_at: Date;
    }>('select * from api_keys where tenant_id = $1 order by created_at desc', [tenantId]);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      prefix: r.prefix,
      lastUsedAt: r.last_used_at?.toISOString() ?? null,
      revokedAt: r.revoked_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async revoke(
    tenantId: string,
    actor: { userId: string; role: Role },
    keyId: string,
  ): Promise<void> {
    const { rows } = await this.db.query<{ kind: KeyKind; key_hash: Buffer }>(
      'select kind, key_hash from api_keys where id = $1 and tenant_id = $2 and revoked_at is null',
      [keyId, tenantId],
    );
    const key = rows[0];
    if (!key) throw new SyncraError('NOT_FOUND', 'Key not found');
    requireCan(actor.role, key.kind === 'secret' ? 'keys.manage-secret' : 'keys.manage');
    await this.db.query('update api_keys set revoked_at = now() where id = $1', [keyId]);
    this.cache.delete(key.key_hash.toString('hex')); // this node sees it at once; others within the TTL
    await appendAudit(this.db, {
      tenantId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'api_key.revoked',
      target: keyId,
    });
  }

  /** Resolves a presented key to its tenant, or null when unknown, revoked, or the tenant is not active. */
  async authenticate(presented: string): Promise<KeyPrincipal | null> {
    const hash = sha256(presented);
    const ck = hash.toString('hex');
    const hit = this.cache.get(ck);
    if (hit && hit.expires > this.now()) {
      if (hit.value) this.touched.add(hit.value.keyId);
      return hit.value;
    }
    const { rows } = await this.db.query<{ id: string; tenant_id: string; kind: KeyKind }>(
      `select k.id, k.tenant_id, k.kind from api_keys k join tenants t on t.id = k.tenant_id
       where k.key_hash = $1 and k.revoked_at is null and t.status = 'active'`,
      [hash],
    );
    const r = rows[0];
    const value = r ? { keyId: r.id, tenantId: r.tenant_id, kind: r.kind } : null;
    this.cache.set(ck, { value, expires: this.now() + CACHE_TTL_MS });
    if (value) this.touched.add(value.keyId);
    return value;
  }

  /** Writes last_used_at for keys used since the last call (batched to avoid a write per request). */
  async flushLastUsed(): Promise<void> {
    const ids = [...this.touched];
    this.touched.clear();
    if (ids.length > 0) {
      await this.db.query('update api_keys set last_used_at = now() where id = any($1::uuid[])', [
        ids,
      ]);
    }
  }

  clearCache(): void {
    this.cache.clear();
  }
}
