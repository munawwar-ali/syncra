/** Demo-only endpoints (DEMO_MODE=true): mint client tokens for the demo apps without a tenant backend. */
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SyncraError } from '@syncra/shared';
import type { AccessRule } from '../auth/access.js';
import type { Config } from '../config.js';

/** Fixed tenant id used by the demo apps; tenant tables are keyed by uuid. */
export const DEMO_TENANT_ID = '00000000-0000-4000-8000-000000000001';

const bodySchema = z.object({
  name: z.string().min(1).max(40),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#4f46e5'),
  role: z.enum(['notes', 'inspector', 'supervisor']).default('notes'),
});

const RULES: Record<'notes' | 'inspector' | 'supervisor', AccessRule[]> = {
  notes: [{ collection: 'notes', docs: '*', mode: 'rw' }],
  inspector: [
    { collection: 'inspections', docs: '*', mode: 'rw' },
    { collection: 'sites', docs: '*', mode: 'r' },
    { collection: 'templates', docs: '*', mode: 'r' },
  ],
  supervisor: [
    { collection: 'inspections', docs: '*', mode: 'rw' },
    { collection: 'sites', docs: '*', mode: 'rw' },
    { collection: 'templates', docs: '*', mode: 'rw' },
  ],
};

export function registerDemoRoutes(app: FastifyInstance, cfg: Config): void {
  const key = new TextEncoder().encode(cfg.JWT_ACCESS_SECRET);
  app.post('/demo/token', async (req) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) throw new SyncraError('VALIDATION_FAILED', 'Invalid request');
    const { name, color, role } = parsed.data;
    const ttl = 3600;
    const token = await new SignJWT({
      tid: DEMO_TENANT_ID,
      access: RULES[role],
      meta: { name, color },
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(`demo-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`) // stable per name so the local database persists
      .setIssuedAt()
      .setExpirationTime(`${String(ttl)}s`)
      .sign(key);
    return { token, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  });
}
