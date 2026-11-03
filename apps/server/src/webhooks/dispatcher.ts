/**
 * Webhook delivery (OPS-06): picks due rows with SKIP LOCKED, sends signed POSTs, and retries on the
 * documented schedule before marking a delivery dead. Durable because state lives in Postgres.
 */
import http from 'node:http';
import https from 'node:https';
import type pg from 'pg';
import { decrypt } from '../auth/crypto.js';
import { signPayload } from './sign.js';
import { resolveTarget } from './ssrf.js';

/** Delay before each retry after a failed attempt; after the last one fails the delivery is dead. */
export const RETRY_SCHEDULE_MS = [
  10_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000, 43_200_000,
];
const LEASE_MS = 60_000;
const TIMEOUT_MS = 10_000;

export interface Sender {
  (
    target: { url: URL; address: string; family: 4 | 6 },
    headers: Record<string, string>,
    body: string,
    timeoutMs: number,
  ): Promise<{ status: number }>;
}

/** Sends to the already-validated IP, so DNS cannot change between the SSRF check and the connection. */
export const httpSender: Sender = (target, headers, body, timeoutMs) =>
  new Promise((resolve, reject) => {
    const lib = target.url.protocol === 'https:' ? https : http;
    const req = lib.request(
      target.url,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        timeout: timeoutMs,
        lookup: (_h, opts, cb) => {
          // Node passes `all: true` on newer runtimes and expects an array back.
          if ((opts as { all?: boolean }).all)
            (cb as unknown as (e: null, a: unknown) => void)(null, [
              { address: target.address, family: target.family },
            ]);
          else cb(null, target.address, target.family);
        },
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });

export interface DispatcherOptions {
  encryptionKey: Buffer;
  allowPrivate: boolean;
  schedule?: number[];
  sender?: Sender;
  now?: () => Date;
  batch?: number;
}

interface DueRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  payload: unknown;
  attempt: number;
}

export class WebhookDispatcher {
  private readonly schedule: number[];
  private readonly send: Sender;
  private readonly now: () => Date;

  constructor(
    private readonly db: pg.Pool,
    private readonly o: DispatcherOptions,
  ) {
    this.schedule = o.schedule ?? RETRY_SCHEDULE_MS;
    this.send = o.sender ?? httpSender;
    this.now = o.now ?? (() => new Date());
  }

  /** Delivers everything currently due; returns how many attempts were made. */
  async runDue(): Promise<number> {
    const now = this.now();
    const { rows } = await this.db.query<DueRow>(
      `with due as (
         select id from webhook_deliveries
         where status in ('pending','retrying') and next_attempt_at <= $1
         order by next_attempt_at limit $3 for update skip locked)
       update webhook_deliveries d set next_attempt_at = $2 from due where d.id = due.id
       returning d.id, d.endpoint_id, d.event_id, d.event_type, d.payload, d.attempt`,
      [now, new Date(now.getTime() + LEASE_MS), this.o.batch ?? 50],
    );
    await Promise.all(rows.map((r) => this.attempt(r)));
    return rows.length;
  }

  private async attempt(d: DueRow): Promise<void> {
    const ep = await this.db.query<{ url: string; secret_enc: Buffer; enabled: boolean }>(
      'select url, secret_enc, enabled from webhook_endpoints where id = $1',
      [d.endpoint_id],
    );
    const endpoint = ep.rows[0];
    if (!endpoint?.enabled) {
      await this.finish(
        d,
        'dead',
        d.attempt,
        null,
        endpoint ? 'endpoint disabled' : 'endpoint deleted',
        null,
      );
      return;
    }
    const body = JSON.stringify(d.payload);
    const t = Math.floor(this.now().getTime() / 1000);
    const secret = decrypt(endpoint.secret_enc, this.o.encryptionKey).toString('utf8');
    let status: number | null = null;
    let error: string | null = null;
    try {
      const target = await resolveTarget(endpoint.url, this.o.allowPrivate);
      const res = await this.send(
        target,
        {
          'content-type': 'application/json',
          'syncra-event': d.event_type,
          'syncra-delivery': d.id,
          'syncra-signature': signPayload(secret, body, t),
        },
        body,
        TIMEOUT_MS,
      );
      status = res.status;
      if (status < 200 || status >= 300) error = `HTTP ${String(status)}`;
    } catch (e) {
      error = (e instanceof Error ? e.message : 'delivery failed').slice(0, 300);
    }
    if (error === null) {
      await this.finish(d, 'success', d.attempt + 1, status, null, null);
      return;
    }
    const attempt = d.attempt + 1;
    const delay = this.schedule[attempt - 1];
    if (delay === undefined) await this.finish(d, 'dead', attempt, status, error, null);
    else
      await this.finish(
        d,
        'retrying',
        attempt,
        status,
        error,
        new Date(this.now().getTime() + delay),
      );
  }

  private async finish(
    d: DueRow,
    status: 'success' | 'retrying' | 'dead',
    attempt: number,
    code: number | null,
    error: string | null,
    next: Date | null,
  ): Promise<void> {
    await this.db.query(
      `update webhook_deliveries set status = $2, attempt = $3, response_code = $4, error = $5, next_attempt_at = $6 where id = $1`,
      [d.id, status, attempt, code, error, next],
    );
  }
}
