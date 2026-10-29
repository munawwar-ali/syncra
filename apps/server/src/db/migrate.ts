/** Runs control and shard migrations (Doc 05 P0-T06). Used by the CLI and by test setup. */
import { runner } from 'node-pg-migrate';
import { fileURLToPath } from 'node:url';

const dir = (name: string): string =>
  fileURLToPath(new URL(`./migrations/${name}`, import.meta.url));

async function up(databaseUrl: string, migrationsDir: string): Promise<number> {
  const done = await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  return done.length;
}

/** Applies pending migrations; returns how many were applied per database label. */
export async function migrateAll(
  controlUrl: string,
  shardUrls: string[],
): Promise<Record<string, number>> {
  const result: Record<string, number> = { control: await up(controlUrl, dir('control')) };
  for (const [i, url] of shardUrls.entries()) {
    result[`shard-${String(i)}`] = await up(url, dir('shard'));
  }
  return result;
}
