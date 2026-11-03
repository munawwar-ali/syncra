/** Webhook endpoints and event emission (OPS-06). Events become delivery rows; the dispatcher sends them. */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { SyncraError } from '@syncra/shared';
import { decrypt, encrypt, generateKey } from '../auth/crypto.js';
import { appendAudit } from '../control/audit.js';
import { requireCan, type Role } from '../control/roles.js';
import { resolveTarget } from './ssrf.js';

export const EVENT_TYPES = [
  'document.created',
  'document.updated',
  'document.deleted',
  'quota.warning',
  'quota.exceeded',
  'webhook.test',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const endpointInput = z.object({
  url: z.string().url().max(2048),
  events: z.array(z.enum(EVENT_TYPES)).min(1),
});
export const endpointPatch = z.object({
  url: z.string().url().max(2048).optional(),
  events: z.array(z.enum(EVENT_TYPES)).min(1).optional(),
  enabled: z.boolean().optional(),
});

type Actor = { userId: string; role: Role };

export interface EndpointDto {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
}

export interface WebhooksOptions {
  encryptionKey: Buffer;
  allowPrivate: boolean;
  /** Maximum endpoints for a tenant's plan; null = unlimited. */
  maxEndpoints: (tenantId: string) => Promise<number | null>;
  /** Trailing debounce for document.updated per document. */
  debounceMs?: number;
}

export class Webhooks {
  private readonly pendingUpdates = new Map<string, { timer: NodeJS.Timeout; seq: number }>();

  constructor(
    private readonly db: pg.Pool,
    private readonly o: WebhooksOptions,
  ) {}

  private toDto(r: {
    id: string;
    url: string;
    events: string[];
    enabled: boolean;
    created_at: Date;
  }): EndpointDto {
    return {
      id: r.id,
      url: r.url,
      events: r.events,
      enabled: r.enabled,
      createdAt: r.created_at.toISOString(),
    };
  }

  async create(tenantId: string, actor: Actor, input: z.infer<typeof endpointInput>) {
    requireCan(actor.role, 'webhooks.manage');
    await resolveTarget(input.url, this.o.allowPrivate);
    const max = await this.o.maxEndpoints(tenantId);
    if (max !== null) {
      const { rows } = await this.db.query<{ n: string }>(
        'select count(*)::text n from webhook_endpoints where tenant_id = $1',
        [tenantId],
      );
      if (Number(rows[0]?.n) >= max) {
        throw new SyncraError('QUOTA_EXCEEDED', 'Webhook endpoint limit reached for this plan', {
          metric: 'webhooks',
          limit: max,
        });
      }
    }
    const secret = generateKey('whsec_').key;
    const id = uuidv7();
    const { rows } = await this.db.query<{
      id: string;
      url: string;
      events: string[];
      enabled: boolean;
      created_at: Date;
    }>(
      `insert into webhook_endpoints (id, tenant_id, url, secret_enc, events) values ($1,$2,$3,$4,$5)
       returning id, url, events, enabled, created_at`,
      [id, tenantId, input.url, encrypt(secret, this.o.encryptionKey), input.events],
    );
    await appendAudit(this.db, {
      tenantId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'webhook.created',
      target: id,
    });
    return { ...this.toDto(rows[0] as NonNullable<(typeof rows)[0]>), secret };
  }

  async list(tenantId: string): Promise<EndpointDto[]> {
    const { rows } = await this.db.query<{
      id: string;
      url: string;
      events: string[];
      enabled: boolean;
      created_at: Date;
    }>(
      'select id, url, events, enabled, created_at from webhook_endpoints where tenant_id = $1 order by created_at',
      [tenantId],
    );
    return rows.map((r) => this.toDto(r));
  }

  async update(
    tenantId: string,
    actor: Actor,
    id: string,
    patch: z.infer<typeof endpointPatch>,
  ): Promise<EndpointDto> {
    requireCan(actor.role, 'webhooks.manage');
    if (patch.url) await resolveTarget(patch.url, this.o.allowPrivate);
    const { rows } = await this.db.query<{
      id: string;
      url: string;
      events: string[];
      enabled: boolean;
      created_at: Date;
    }>(
      `update webhook_endpoints set url = coalesce($3, url), events = coalesce($4, events), enabled = coalesce($5, enabled)
       where id = $1 and tenant_id = $2 returning id, url, events, enabled, created_at`,
      [id, tenantId, patch.url ?? null, patch.events ?? null, patch.enabled ?? null],
    );
    if (!rows[0]) throw new SyncraError('NOT_FOUND', 'Webhook not found');
    await appendAudit(this.db, {
      tenantId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'webhook.updated',
      target: id,
    });
    return this.toDto(rows[0]);
  }

  async remove(tenantId: string, actor: Actor, id: string): Promise<void> {
    requireCan(actor.role, 'webhooks.manage');
    const r = await this.db.query(
      'delete from webhook_endpoints where id = $1 and tenant_id = $2',
      [id, tenantId],
    );
    if (r.rowCount === 0) throw new SyncraError('NOT_FOUND', 'Webhook not found');
    await appendAudit(this.db, {
      tenantId,
      actorType: 'user',
      actorId: actor.userId,
      action: 'webhook.deleted',
      target: id,
    });
  }

  /** Queues a `webhook.test` delivery for one endpoint. */
  async sendTest(tenantId: string, actor: Actor, id: string): Promise<void> {
    requireCan(actor.role, 'webhooks.manage');
    const { rows } = await this.db.query(
      'select 1 from webhook_endpoints where id = $1 and tenant_id = $2',
      [id, tenantId],
    );
    if (!rows[0]) throw new SyncraError('NOT_FOUND', 'Webhook not found');
    await this.enqueue(tenantId, id, 'webhook.test', { message: 'Hello from Syncra' });
  }

  async deliveries(tenantId: string, endpointId: string, limit: number) {
    const { rows } = await this.db.query<{
      id: string;
      event_type: string;
      status: string;
      attempt: number;
      response_code: number | null;
      error: string | null;
      next_attempt_at: Date | null;
      created_at: Date;
    }>(
      `select d.id, d.event_type, d.status, d.attempt, d.response_code, d.error, d.next_attempt_at, d.created_at
       from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id
       where d.endpoint_id = $1 and e.tenant_id = $2 order by d.created_at desc limit $3`,
      [endpointId, tenantId, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      status: r.status,
      attempt: r.attempt,
      responseCode: r.response_code,
      error: r.error,
      nextAttemptAt: r.next_attempt_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async retry(tenantId: string, actor: Actor, deliveryId: string): Promise<void> {
    requireCan(actor.role, 'webhooks.manage');
    const r = await this.db.query(
      `update webhook_deliveries d set status = 'pending', attempt = 0, next_attempt_at = now(), error = null
       from webhook_endpoints e where d.id = $1 and e.id = d.endpoint_id and e.tenant_id = $2`,
      [deliveryId, tenantId],
    );
    if (r.rowCount === 0) throw new SyncraError('NOT_FOUND', 'Delivery not found');
  }

  async secretFor(endpointId: string): Promise<string> {
    const { rows } = await this.db.query<{ secret_enc: Buffer }>(
      'select secret_enc from webhook_endpoints where id = $1',
      [endpointId],
    );
    if (!rows[0]) throw new SyncraError('NOT_FOUND', 'Webhook not found');
    return decrypt(rows[0].secret_enc, this.o.encryptionKey).toString('utf8');
  }

  private async enqueue(
    tenantId: string,
    endpointId: string,
    type: EventType,
    data: Record<string, unknown>,
  ) {
    const eventId = randomUUID();
    const payload = {
      id: `evt_${eventId}`,
      type,
      createdAt: new Date().toISOString(),
      tenantId,
      data,
    };
    await this.db.query(
      `insert into webhook_deliveries (id, endpoint_id, tenant_id, event_id, event_type, payload, status, next_attempt_at)
       values ($1,$2,$3,$4,$5,$6,'pending',now())`,
      [uuidv7(), endpointId, tenantId, eventId, type, JSON.stringify(payload)],
    );
  }

  /** Fans an event out to every enabled endpoint subscribed to it. Failures are logged by the caller, never thrown. */
  async emit(tenantId: string, type: EventType, data: Record<string, unknown>): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(
      'select id from webhook_endpoints where tenant_id = $1 and enabled and $2 = any(events)',
      [tenantId, type],
    );
    for (const r of rows) await this.enqueue(tenantId, r.id, type, data);
  }

  /** document.updated is sent at most once per second per document, carrying the latest seq. */
  emitUpdatedDebounced(
    tenantId: string,
    collection: string,
    docId: string,
    seq: number,
    onError: (e: unknown) => void,
  ): void {
    const key = `${tenantId}|${collection}|${docId}`;
    const pending = this.pendingUpdates.get(key);
    if (pending) {
      pending.seq = seq;
      return;
    }
    const entry = {
      seq,
      timer: setTimeout(() => {
        this.pendingUpdates.delete(key);
        this.emit(tenantId, 'document.updated', { collection, docId, seq: entry.seq }).catch(
          onError,
        );
      }, this.o.debounceMs ?? 1000),
    };
    entry.timer.unref();
    this.pendingUpdates.set(key, entry);
  }

  stop(): void {
    for (const p of this.pendingUpdates.values()) clearTimeout(p.timer);
    this.pendingUpdates.clear();
  }
}
