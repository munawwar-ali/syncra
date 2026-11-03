/** Token-bucket rate limiting (OPS-01): pure math, an in-process limiter, and an atomic Redis Lua limiter. */
import type { Redis } from 'ioredis';

export interface BucketSpec {
  /** Maximum tokens (burst size). */
  capacity: number;
  /** Refill rate in tokens per second. */
  ratePerSec: number;
}
export interface BucketState {
  tokens: number;
  ts: number;
}
export interface TakeResult {
  allowed: boolean;
  /** How long until `cost` tokens are available; 0 when allowed. */
  retryAfterMs: number;
}

/** Refill, then take `cost` if available. Pure: the Lua script below implements the same steps. */
export function takeFromBucket(
  state: BucketState | null,
  spec: BucketSpec,
  cost: number,
  nowMs: number,
): { state: BucketState; result: TakeResult } {
  const prev = state ?? { tokens: spec.capacity, ts: nowMs };
  const elapsed = Math.max(0, nowMs - prev.ts) / 1000;
  const tokens = Math.min(spec.capacity, prev.tokens + elapsed * spec.ratePerSec);
  if (tokens >= cost)
    return {
      state: { tokens: tokens - cost, ts: nowMs },
      result: { allowed: true, retryAfterMs: 0 },
    };
  const retryAfterMs = Math.ceil(((cost - tokens) / spec.ratePerSec) * 1000);
  return { state: { tokens, ts: nowMs }, result: { allowed: false, retryAfterMs } };
}

export interface Limiter {
  take(key: string, spec: BucketSpec, cost?: number): Promise<TakeResult>;
}

/** Per-process buckets. Idle buckets are dropped lazily to bound memory. */
export class InProcessLimiter implements Limiter {
  private readonly buckets = new Map<string, BucketState>();
  private lastSweep = 0;

  constructor(private readonly now: () => number = Date.now) {}

  take(key: string, spec: BucketSpec, cost = 1): Promise<TakeResult> {
    return Promise.resolve(this.takeSync(key, spec, cost));
  }

  takeSync(key: string, spec: BucketSpec, cost = 1): TakeResult {
    const t = this.now();
    const { state, result } = takeFromBucket(this.buckets.get(key) ?? null, spec, cost, t);
    this.buckets.set(key, state);
    if (t - this.lastSweep > 60_000) {
      this.lastSweep = t;
      for (const [k, s] of this.buckets) if (t - s.ts > 120_000) this.buckets.delete(k);
    }
    return result;
  }
}

/** KEYS[1]=bucket; ARGV: capacity, ratePerSec, cost, nowMs. Returns {allowed, retryAfterMs}. */
export const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  ts = now
end
local elapsed = math.max(0, now - ts) / 1000
tokens = math.min(capacity, tokens + elapsed * rate)
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost - tokens) / rate * 1000)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], 120000)
return {allowed, retry}
`;

/**
 * Shared limiter across nodes. If Redis errors, falls back to a per-process bucket whose rate and
 * capacity are divided by the expected node count so the cluster total stays near the target.
 */
export class RedisLimiter implements Limiter {
  private readonly fallback: InProcessLimiter;

  constructor(
    private readonly redis: Redis,
    private readonly opts: {
      expectedNodes?: number;
      now?: () => number;
      onFallback?: () => void;
    } = {},
  ) {
    this.fallback = new InProcessLimiter(opts.now);
  }

  async take(key: string, spec: BucketSpec, cost = 1): Promise<TakeResult> {
    try {
      const now = this.opts.now?.() ?? Date.now();
      const [allowed, retry] = (await this.redis.eval(
        TOKEN_BUCKET_LUA,
        1,
        `sx:rl:${key}`,
        spec.capacity,
        spec.ratePerSec,
        cost,
        now,
      )) as [number, number];
      return { allowed: allowed === 1, retryAfterMs: retry };
    } catch {
      this.opts.onFallback?.();
      const n = Math.max(1, this.opts.expectedNodes ?? 1);
      return this.fallback.take(
        key,
        { capacity: spec.capacity / n, ratePerSec: spec.ratePerSec / n },
        cost,
      );
    }
  }
}
