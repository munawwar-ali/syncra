/** CLI for `pnpm db:migrate` and the compose `migrate` service: migrate every database, then seed the demo tenant. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';
import { seedDemoTenant } from '../control/seed.js';
import { migrateAll } from './migrate.js';

const control = process.env.CONTROL_DATABASE_URL;
const shards = (process.env.SHARD_DATABASE_URLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (!control || shards.length === 0) {
  throw new Error('CONTROL_DATABASE_URL and SHARD_DATABASE_URLS are required');
}

for (const [label, n] of Object.entries(await migrateAll(control, shards))) {
  console.log(`[migrate] ${label}: ${String(n)} applied`);
}

if (process.env.SEED_DEMO_TENANT === 'true') {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY is required to seed the demo tenant');
  const pool = new pg.Pool({ connectionString: control, max: 1 });
  const seeded = await seedDemoTenant(pool, Buffer.from(key, 'base64'));
  await pool.end();
  if (seeded.created) {
    const base = process.env.PUBLIC_URL ?? 'http://localhost:8080';
    const lines = [
      '==================== Syncra demo credentials ====================',
      `Dashboard:         ${base}/`,
      `Login:             ${seeded.email}`,
      `Password:          ${seeded.password ?? ''}`,
      `Publishable key:   ${seeded.keys?.publishable ?? ''}`,
      `Secret key:        ${seeded.keys?.secret ?? ''}`,
      `Demo notes app:    ${base}/notes/`,
      `Demo inspections:  ${base}/inspection/`,
      'These are shown once. Rotate them before exposing this instance.',
      '=================================================================',
    ];
    console.log(lines.join('\n'));
    const file = process.env.CREDENTIALS_FILE;
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      // 0644 because the container writes as root and the developer must be able to read it; the same
      // text is in the container log, and these are development credentials.
      writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o644 });
    }
  } else {
    console.log('[migrate] demo tenant already exists; credentials were shown on first start');
  }
}
