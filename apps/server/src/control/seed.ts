/** Idempotent demo tenant seed (P3-T13, DX-03): a fixed tenant, an owner login and API keys shown once. */
import * as argon2 from 'argon2';
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { encrypt, generateKey, generateSigningSecret } from '../auth/crypto.js';
import { appendAudit } from './audit.js';

/** Fixed id used by the demo apps (they sign in with names, not accounts). */
export const DEMO_TENANT_ID = '00000000-0000-4000-8000-000000000001';
export const DEMO_EMAIL = 'demo@syncra.dev';

export interface SeedResult {
  created: boolean;
  tenantId: string;
  email: string;
  /** Only present when the tenant was created by this call; secrets are never recoverable later. */
  password?: string;
  keys?: { secret: string; publishable: string };
}

export async function seedDemoTenant(
  db: pg.Pool,
  encryptionKey: Buffer,
  password = generateKey('whsec_').key.slice(6, 22),
): Promise<SeedResult> {
  const exists = await db.query('select 1 from tenants where id = $1', [DEMO_TENANT_ID]);
  if (exists.rows[0]) return { created: false, tenantId: DEMO_TENANT_ID, email: DEMO_EMAIL };

  const secret = generateKey('sk_live_');
  const publishable = generateKey('pk_live_');
  const userId = uuidv7();
  const client = await db.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into tenants (id, slug, name, plan, signing_secret_enc) values ($1,'demo','Demo','selfhost',$2)`,
      [DEMO_TENANT_ID, encrypt(generateSigningSecret(), encryptionKey)],
    );
    await client.query(
      'insert into users (id, email, password_hash, name) values ($1,$2,$3,$4) on conflict do nothing',
      [
        userId,
        DEMO_EMAIL,
        await argon2.hash(password, {
          type: argon2.argon2id,
          memoryCost: 65536,
          timeCost: 3,
          parallelism: 1,
        }),
        'Demo Owner',
      ],
    );
    await client.query(
      `insert into memberships (tenant_id, user_id, role) select $1, id, 'owner' from users where email = $2 on conflict do nothing`,
      [DEMO_TENANT_ID, DEMO_EMAIL],
    );
    for (const [kind, k] of [
      ['secret', secret],
      ['publishable', publishable],
    ] as const) {
      await client.query(
        `insert into api_keys (id, tenant_id, kind, name, prefix, key_hash) values ($1,$2,$3,$4,$5,$6)`,
        [uuidv7(), DEMO_TENANT_ID, kind, `Demo ${kind} key`, k.prefix, k.hash],
      );
    }
    await appendAudit(client, {
      tenantId: DEMO_TENANT_ID,
      actorType: 'system',
      actorId: 'seed',
      action: 'tenant.seeded',
    });
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
  return {
    created: true,
    tenantId: DEMO_TENANT_ID,
    email: DEMO_EMAIL,
    password,
    keys: { secret: secret.key, publishable: publishable.key },
  };
}
