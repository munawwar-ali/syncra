/** Demo-only endpoints (DEMO_MODE=true): mint client tokens for the demo apps without a tenant backend. */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SyncraError } from '@syncra/shared';
import type { AccessRule } from '../auth/access.js';
import { mintClientToken } from '../control/signing.js';
import { DEMO_TENANT_ID } from '../control/seed.js';
import type { Services } from '../services.js';

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

export function registerDemoRoutes(app: FastifyInstance, s: Services): void {
  app.post('/demo/token', async (req) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) throw new SyncraError('VALIDATION_FAILED', 'Invalid request');
    const { name, color, role } = parsed.data;
    return mintClientToken(s.tenantKeys, DEMO_TENANT_ID, {
      // Stable per name so the browser's local database persists across sessions.
      userId: `demo-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      ttlSeconds: 3600,
      access: RULES[role],
      meta: { name, color },
    });
  });
}
