import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  CONTROL_DATABASE_URL: 'postgres://u:p@localhost:5432/c',
  SHARD_DATABASE_URLS: 'postgres://u:p@localhost:5433/s0, postgres://u:p@localhost:5434/s1',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('loadConfig', () => {
  it('applies defaults and splits shards', () => {
    const c = loadConfig(base);
    expect(c.PORT).toBe(8080);
    expect(c.BILLING_ENABLED).toBe(false);
    expect(c.SHARD_DATABASE_URLS).toHaveLength(2);
  });
  it('fails fast listing every bad variable', () => {
    let msg = '';
    try {
      loadConfig({ ...base, ENCRYPTION_KEY: 'short', REDIS_URL: '' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('ENCRYPTION_KEY');
    expect(msg).toContain('REDIS_URL');
  });
});
