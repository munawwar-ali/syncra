/** One-shot migration runner for the control DB and every shard (Doc 05 P0-T06). */
import { runner } from 'node-pg-migrate';
import { fileURLToPath } from 'node:url';

const dir = (name: string): string =>
  fileURLToPath(new URL(`./migrations/${name}`, import.meta.url));

async function up(databaseUrl: string, migrationsDir: string, label: string): Promise<void> {
  const done = await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  console.log(`[migrate] ${label}: ${String(done.length)} applied`);
}

const control = process.env.CONTROL_DATABASE_URL;
const shards = (process.env.SHARD_DATABASE_URLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (!control || shards.length === 0) {
  throw new Error('CONTROL_DATABASE_URL and SHARD_DATABASE_URLS are required');
}

await up(control, dir('control'), 'control');
for (const [i, url] of shards.entries()) await up(url, dir('shard'), `shard-${String(i)}`);
