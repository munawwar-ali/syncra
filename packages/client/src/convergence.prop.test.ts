import fc from 'fast-check';
import { describe, it } from 'vitest';
import { FakeNetwork, FakeServer, fakeToken } from '@syncra/testkit';
import { createClient, type SyncraClient } from './client.js';
import type { SyncraDoc } from './doc.js';

const RUNS = Number(process.env.PROP_RUNS ?? 200);
const N = 3;

type Action =
  | { t: 'insert'; c: number; at: number; s: string }
  | { t: 'delete'; c: number; at: number; n: number }
  | { t: 'offline'; c: number }
  | { t: 'online'; c: number }
  | { t: 'drop' }
  | { t: 'wait'; ms: number };

const action: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant('insert' as const),
      c: fc.nat(N - 1),
      at: fc.nat(50),
      s: fc.stringMatching(/^[a-z]{1,3}$/),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('delete' as const),
      c: fc.nat(N - 1),
      at: fc.nat(50),
      n: fc.integer({ min: 1, max: 3 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('offline' as const), c: fc.nat(N - 1) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('online' as const), c: fc.nat(N - 1) }) },
  { weight: 1, arbitrary: fc.constant({ t: 'drop' as const }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('wait' as const), ms: fc.nat(12) }) },
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) return false;
    await sleep(5);
  }
  return true;
}

describe('A2-5 convergence under random edits, offline periods and dropped connections', () => {
  it(`converges in ${String(RUNS)} randomized runs`, async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 5, maxLength: 40 }), async (actions) => {
        const server = new FakeServer(
          new FakeNetwork({ latencyMs: 1, jitterMs: 3, duplicateRate: 0.1, reorderRate: 0.1 }),
        );
        const clients: SyncraClient[] = [];
        const docs: SyncraDoc[] = [];
        for (let i = 0; i < N; i++) {
          const c = createClient({
            url: 'ws://fake',
            publishableKey: 'pk',
            getToken: () => Promise.resolve(fakeToken()),
            storage: 'memory',
            tabEnv: null,
            probeUrl: '',
            batchMs: 2,
            transport: server.transport,
          });
          clients.push(c);
          docs.push(c.doc('notes', 'prop'));
        }
        try {
          for (const a of actions) {
            if (a.t === 'insert') {
              const text = docs[a.c]?.text();
              text?.insert(Math.min(a.at, text.length), a.s);
            } else if (a.t === 'delete') {
              const text = docs[a.c]?.text();
              if (text && text.length > 0) {
                const at = a.at % text.length;
                text.delete(at, Math.min(a.n, text.length - at));
              }
            } else if (a.t === 'offline') clients[a.c]?.simulateOffline(true);
            else if (a.t === 'online') clients[a.c]?.simulateOffline(false);
            else if (a.t === 'drop') server.network.dropAll();
            else await sleep(a.ms);
          }
          clients.forEach((c) => {
            c.simulateOffline(false);
          });
          const settled = await until(() => {
            const want = (server.json('notes/prop').text as string | undefined) ?? '';
            return (
              clients.every((c) => c.status.connection === 'live' && c.status.pendingOps === 0) &&
              docs.every((d) => d.text().toJSON() === want)
            );
          }, 15_000);
          if (!settled) {
            throw new Error(
              `did not converge: server=${JSON.stringify(server.json('notes/prop'))} clients=${JSON.stringify(
                docs.map((d, i) => [
                  d.text().toJSON(),
                  clients[i]?.status.connection,
                  clients[i]?.status.pendingOps,
                ]),
              )}`,
            );
          }
        } finally {
          await Promise.all(clients.map((c) => c.destroy().catch(() => undefined)));
          server.network.dispose();
        }
      }),
      { numRuns: RUNS, interruptAfterTimeLimit: 600_000 },
    );
  }, 650_000);
});
