import { createClient, type SyncraClient } from '@syncra/client';

export type Role = 'inspector' | 'supervisor';
export interface Session {
  name: string;
  role: Role;
}

// Must match apps/server/src/demo/routes.ts so every tab of a first session shares one local database.
const DEMO_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const userId = (s: Session): string => `demo-${s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

export const TEMPLATE_IDS = ['safety', 'electrical', 'environment'] as const;

export function makeClient(s: Session): SyncraClient {
  return createClient({
    url: location.origin,
    publishableKey: 'pk_demo',
    identity: { tenantId: DEMO_TENANT_ID, userId: userId(s) },
    getToken: async () => {
      const res = await fetch('/demo/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: s.name, role: s.role }),
      });
      if (!res.ok) throw new Error('token request failed');
      return ((await res.json()) as { token: string }).token;
    },
  });
}
