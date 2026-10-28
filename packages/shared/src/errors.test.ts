import { describe, expect, it } from 'vitest';
import { SyncraError } from './errors.js';
import { collectionSchema, docIdSchema, paginationSchema } from './schemas.js';

describe('SyncraError', () => {
  it('maps code to http status and retryable', () => {
    const e = new SyncraError('QUOTA_EXCEEDED', 'x', { metric: 'ops' });
    expect(e.httpStatus).toBe(402);
    expect(e.retryable).toBe(true);
    expect(e.toBody('req_1')).toEqual({
      error: {
        code: 'QUOTA_EXCEEDED',
        message: 'x',
        details: { metric: 'ops' },
        requestId: 'req_1',
      },
    });
  });
  it('hides unknown errors behind INTERNAL', () => {
    const e = SyncraError.from(new Error('db password leaked'));
    expect(e.code).toBe('INTERNAL');
    expect(e.message).not.toContain('password');
  });
});

describe('schemas', () => {
  it('validates ids', () => {
    expect(docIdSchema.safeParse('a:b-c.d_1').success).toBe(true);
    expect(docIdSchema.safeParse('a/b').success).toBe(false);
    expect(docIdSchema.safeParse('x'.repeat(129)).success).toBe(false);
    expect(collectionSchema.safeParse('inspections').success).toBe(true);
    expect(collectionSchema.safeParse('Bad').success).toBe(false);
  });
  it('applies pagination defaults and caps', () => {
    expect(paginationSchema.parse({}).limit).toBe(50);
    expect(paginationSchema.safeParse({ limit: '201' }).success).toBe(false);
  });
});
