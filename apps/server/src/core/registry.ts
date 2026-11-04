/** Node registry and heartbeats in Redis (DSH-10): `sx:node:{id}` hash with a 15 s TTL plus the `sx:nodes` zset. */
import type { Redis } from 'ioredis';

const TTL_MS = 15_000;
const BEAT_MS = 5_000;

export interface NodeStats {
  connections: number;
  hotDocs: number;
}

export interface NodeInfo extends NodeStats {
  nodeId: string;
  startedAt: number;
  heartbeatAgeMs: number;
}

export class NodeRegistry {
  private timer: NodeJS.Timeout | undefined;
  private readonly startedAt = Date.now();

  constructor(
    private readonly redis: Redis,
    private readonly nodeId: string,
    private readonly stats: () => NodeStats,
  ) {}

  async beat(): Promise<void> {
    try {
      const s = this.stats();
      const key = `sx:node:${this.nodeId}`;
      const now = Date.now();
      await this.redis
        .multi()
        .hset(key, {
          heartbeat: now,
          conns: s.connections,
          hotDocs: s.hotDocs,
          startedAt: this.startedAt,
        })
        .pexpire(key, TTL_MS)
        .zadd('sx:nodes', now, this.nodeId)
        .exec();
    } catch {
      // the registry is observability only
    }
  }

  start(): void {
    void this.beat();
    this.timer = setInterval(() => void this.beat(), BEAT_MS);
    this.timer.unref();
  }

  /** Removes this node at once (graceful shutdown) instead of waiting for the TTL. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    try {
      await this.redis.multi().del(`sx:node:${this.nodeId}`).zrem('sx:nodes', this.nodeId).exec();
    } catch {
      // expires by itself within 15 s
    }
  }
}

/** Live nodes: heartbeat newer than the TTL. */
export async function listNodes(redis: Redis, now = Date.now()): Promise<NodeInfo[]> {
  const ids = await redis.zrangebyscore('sx:nodes', now - TTL_MS, '+inf');
  const out: NodeInfo[] = [];
  for (const nodeId of ids) {
    const h = await redis.hgetall(`sx:node:${nodeId}`);
    if (!h.heartbeat) continue; // hash already expired
    out.push({
      nodeId,
      connections: Number(h.conns ?? 0),
      hotDocs: Number(h.hotDocs ?? 0),
      startedAt: Number(h.startedAt ?? 0),
      heartbeatAgeMs: now - Number(h.heartbeat),
    });
  }
  return out;
}
