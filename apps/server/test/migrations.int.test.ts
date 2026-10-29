import pg from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';

const pools = [inject('controlUrl'), ...inject('shardUrls')].map(
  (u) => new pg.Pool({ connectionString: u, max: 2 }),
);
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});

const tables = async (p: pg.Pool): Promise<string[]> =>
  (
    await p.query<{ t: string }>(
      "select tablename t from pg_tables where schemaname = 'public' order by 1",
    )
  ).rows.map((r) => r.t);

describe('migrations (A0-2)', () => {
  it('creates every control-plane table', async () => {
    const t = await tables(pools[0] as pg.Pool);
    for (const name of [
      'tenants',
      'users',
      'api_keys',
      'refresh_tokens',
      'audit_log',
      'invoices',
    ]) {
      expect(t).toContain(name);
    }
  });

  it.each([1, 2])('creates shard tables with 16 partitions each (shard %i)', async (i) => {
    const p = pools[i] as pg.Pool;
    const t = await tables(p);
    for (const name of ['documents', 'snapshots', 'document_views', 'changes']) {
      expect(t).toContain(name);
    }
    for (const parent of ['operations', 'op_dedup']) {
      const { rows } = await p.query<{ n: string }>(
        `select count(*)::text n from pg_inherits where inhparent = $1::regclass`,
        [parent],
      );
      expect(rows[0]?.n).toBe('16');
    }
  });
});
