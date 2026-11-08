/** Creates the SDK client for the signed-in demo user, with a transport the chaos panel can degrade. */
import { createClient, type SyncraClient, type Transport } from '@syncra/client';

/** sessionStorage flag that keeps the demo offline across a reload (like a phone in a basement). */
export const OFFLINE_KEY = 'syncra-demo-offline';

export interface DemoUser {
  name: string;
  color: string;
}

/** Live-tunable network degradation applied on top of the real WebSocket transport. */
export const chaos = { latencyMs: 0, slowConsumer: false };
const SLOW_CONSUMER_MS = 5000;

const delayed: Transport = (url, protocols) => {
  const ws = new WebSocket(url, protocols);
  ws.binaryType = 'arraybuffer';
  const sock = {
    send: (d: Uint8Array) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (chaos.latencyMs > 0)
        setTimeout(() => {
          ws.send(d);
        }, chaos.latencyMs);
      else ws.send(d);
    },
    close: (code?: number) => {
      ws.close(code === 1000 ? code : 1000);
    },
    onopen: null as (() => void) | null,
    onmessage: null as ((d: Uint8Array) => void) | null,
    onclose: null as ((code: number) => void) | null,
  };
  ws.addEventListener('open', () => sock.onopen?.());
  ws.addEventListener('message', (ev: MessageEvent) => {
    const data = new Uint8Array(ev.data as ArrayBuffer);
    const wait = chaos.latencyMs + (chaos.slowConsumer ? SLOW_CONSUMER_MS : 0);
    if (wait > 0) setTimeout(() => sock.onmessage?.(data), wait);
    else sock.onmessage?.(data);
  });
  ws.addEventListener('close', (ev) => sock.onclose?.(ev.code));
  return sock;
};

// Must match apps/server/src/demo/routes.ts: knowing the identity up front lets every tab of a
// first-ever session share one lock, one BroadcastChannel and one local database.
const DEMO_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const demoUserId = (name: string): string =>
  `demo-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

export function makeClient(user: DemoUser): SyncraClient {
  return createClient({
    url: (import.meta.env.VITE_SYNC_URL as string | undefined) ?? location.origin,
    publishableKey: 'pk_demo',
    identity: { tenantId: DEMO_TENANT_ID, userId: demoUserId(user.name) },
    getToken: async () => {
      const res = await fetch('/demo/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: user.name, color: user.color, role: 'notes' }),
      });
      if (!res.ok) throw new Error('token request failed');
      return ((await res.json()) as { token: string }).token;
    },
    transport: delayed,
  });
}
