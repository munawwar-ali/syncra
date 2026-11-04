/** Multi-node test helpers: an in-memory pub/sub hub with fault injection, and a cluster of in-process nodes. */
import RedisMock from 'ioredis-mock';
import pg from 'pg';
import type { PubSub } from '../src/core/pubsub.js';
import { Presence } from '../src/core/presence.js';
import { makePools, startServer, type Harness } from './harness.js';

/** Stand-in for Redis pub/sub that can be switched off or made to lose messages (OPS-11, Doc 02 §4.5). */
export class MemoryHub {
  down = false;
  /** Number of upcoming messages to silently lose. */
  dropNext = 0;
  delivered = 0;
  private readonly members = new Set<MemoryPubSub>();

  connect(): MemoryPubSub {
    const m = new MemoryPubSub(this);
    this.members.add(m);
    return m;
  }

  deliver(channel: string, payload: Uint8Array): void {
    if (this.down) throw new Error('hub down');
    if (this.dropNext > 0) {
      this.dropNext--;
      return;
    }
    for (const m of this.members) {
      if (m.channels.has(channel)) {
        this.delivered++;
        queueMicrotask(() => {
          m.handler?.(channel, payload);
        });
      }
    }
  }
}

class MemoryPubSub implements PubSub {
  readonly channels = new Set<string>();
  handler: ((channel: string, payload: Uint8Array) => void) | undefined;

  constructor(private readonly hub: MemoryHub) {}

  publish(channel: string, payload: Uint8Array): Promise<void> {
    try {
      this.hub.deliver(channel, payload);
      return Promise.resolve();
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error('publish failed'));
    }
  }
  subscribe(channel: string): Promise<void> {
    this.channels.add(channel);
    return Promise.resolve();
  }
  unsubscribe(channel: string): Promise<void> {
    this.channels.delete(channel);
    return Promise.resolve();
  }
  onMessage(cb: (channel: string, payload: Uint8Array) => void): void {
    this.handler = cb;
  }
  healthy(): boolean {
    return !this.hub.down;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

export interface Cluster {
  hub: MemoryHub;
  nodes: Harness[];
  pools: pg.Pool[];
  redis: InstanceType<typeof RedisMock>;
  /** Starts another node on the same databases and bus. */
  add(overrides?: { reconcileMs?: number; degradedReconcileMs?: number }): Promise<Harness>;
  close(): Promise<void>;
}

let clusterCounter = 0;

export async function startCluster(
  n: number,
  opts: { reconcileMs?: number; degradedReconcileMs?: number; gateway?: object } = {},
): Promise<Cluster> {
  const hub = new MemoryHub();
  const pools = makePools();
  const redis = new RedisMock({ host: `cluster-${String(clusterCounter++)}` });
  const nodes: Harness[] = [];
  const add = async (
    o: { reconcileMs?: number; degradedReconcileMs?: number } = {},
  ): Promise<Harness> => {
    const nodeId = `node-${String(nodes.length + 1)}`;
    const pubsub = hub.connect();
    const node = await startServer(
      {
        nodeId,
        pubsub,
        reconcileMs: o.reconcileMs ?? opts.reconcileMs ?? 60_000,
        degradedReconcileMs: o.degradedReconcileMs ?? opts.degradedReconcileMs ?? 60_000,
      },
      pools,
      0,
      { presence: new Presence(redis, pubsub, nodeId), gateway: opts.gateway },
    );
    nodes.push(node);
    return node;
  };
  for (let i = 0; i < n; i++) await add();
  return {
    hub,
    nodes,
    pools,
    redis,
    add,
    async close() {
      await Promise.all(nodes.map((x) => x.close().catch(() => undefined)));
      await Promise.all(pools.map((p) => p.end()));
    },
  };
}
