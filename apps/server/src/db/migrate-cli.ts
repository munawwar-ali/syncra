/** CLI entry for `pnpm db:migrate` and the compose `migrate` service. */
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
