/** Small transaction helper over pg pools. */
import type pg from 'pg';

export async function withTx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Postgres unique-violation check (SQLSTATE 23505), optionally for one constraint. */
export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const err = e as { code?: string; constraint?: string };
  return err.code === '23505' && (constraint === undefined || err.constraint === constraint);
}
