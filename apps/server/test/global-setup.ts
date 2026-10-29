/**
 * Integration-test setup: one embedded PostgreSQL 16 with a control DB and two shard DBs, migrated
 * once. Stands in for Testcontainers so the suite runs without Docker (see ADR 0017).
 */
import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GlobalSetupContext } from 'vitest/node';
import { migrateAll } from '../src/db/migrate.js';

declare module 'vitest' {
  export interface ProvidedContext {
    controlUrl: string;
    shardUrls: string[];
  }
}

const PORT = 54329;

export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const pg = new EmbeddedPostgres({
    databaseDir: mkdtempSync(join(tmpdir(), 'syncra-pg-')),
    user: 'syncra',
    password: 'syncra',
    port: PORT,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  const names = ['syncra_control', 'syncra_shard_0', 'syncra_shard_1'];
  for (const n of names) await pg.createDatabase(n);
  const url = (n: string): string => `postgres://syncra:syncra@localhost:${String(PORT)}/${n}`;
  const controlUrl = url('syncra_control');
  const shardUrls = [url('syncra_shard_0'), url('syncra_shard_1')];
  await migrateAll(controlUrl, shardUrls);
  provide('controlUrl', controlUrl);
  provide('shardUrls', shardUrls);
  return async () => {
    await pg.stop();
  };
}
