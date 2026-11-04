/**
 * Presence / awareness (COL-01, COL-02): ephemeral, never in Postgres. Each client's latest awareness
 * state lives in a Redis hash with a TTL so a node that joins late can show who is already there, and
 * is fanned out to other nodes over the pub/sub transport.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import type { Redis } from 'ioredis';
import { LIMITS } from '@syncra/shared';
import { awarenessChannel, encodeAwarenessBroadcast, type PubSub } from './pubsub.js';

export interface AwarenessEntry {
  clientId: number;
  clock: number;
  /** Raw JSON string; "null" means the client left. */
  state: string;
}

/** Parses a y-protocols awareness update, or null if it is malformed or too large. */
export function parseAwareness(update: Uint8Array): AwarenessEntry[] | null {
  if (update.length > LIMITS.maxAwarenessBytes) return null;
  try {
    const d = decoding.createDecoder(update);
    const n = decoding.readVarUint(d);
    if (n > 64) return null;
    const out: AwarenessEntry[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        clientId: decoding.readVarUint(d),
        clock: decoding.readVarUint(d),
        state: decoding.readVarString(d),
      });
    }
    return decoding.hasContent(d) ? null : out;
  } catch {
    return null;
  }
}

export function encodeAwareness(entries: AwarenessEntry[]): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, entries.length);
  for (const x of entries) {
    encoding.writeVarUint(e, x.clientId);
    encoding.writeVarUint(e, x.clock);
    encoding.writeVarString(e, x.state);
  }
  return encoding.toUint8Array(e);
}

const TTL_S = 60;

export class Presence {
  constructor(
    private readonly redis: Redis,
    private readonly pubsub: PubSub | undefined,
    private readonly nodeId: string,
  ) {}

  private key(tenantId: string, docKey: string): string {
    return `sx:aw:${tenantId}:${docKey}`;
  }

  /** Stores each client's latest state (or removes it) and refreshes the TTL. Best effort. */
  async record(tenantId: string, docKey: string, entries: AwarenessEntry[]): Promise<void> {
    try {
      const k = this.key(tenantId, docKey);
      const p = this.redis.multi();
      for (const x of entries) {
        if (x.state === 'null') p.hdel(k, String(x.clientId));
        else p.hset(k, String(x.clientId), Buffer.from(encodeAwareness([x])).toString('base64'));
      }
      p.expire(k, TTL_S);
      await p.exec();
    } catch {
      // presence is advisory; Redis being down must not affect document sync
    }
  }

  /** Awareness updates for everyone currently present on this document (any node). */
  async snapshot(tenantId: string, docKey: string): Promise<Uint8Array[]> {
    try {
      const all = await this.redis.hgetall(this.key(tenantId, docKey));
      return Object.values(all).map((b64) => new Uint8Array(Buffer.from(b64, 'base64')));
    } catch {
      return [];
    }
  }

  /** Fans an update out to the other nodes. */
  async publish(tenantId: string, docKey: string, update: Uint8Array): Promise<void> {
    try {
      await this.pubsub?.publish(
        awarenessChannel(tenantId, docKey),
        encodeAwarenessBroadcast({ originNode: this.nodeId, update }),
      );
    } catch {
      // cross-node presence degrades while the bus is down (OPS-11)
    }
  }

  /** Re-extends the TTL for documents that still have local clients. */
  async touch(keys: { tenantId: string; docKey: string }[]): Promise<void> {
    try {
      const p = this.redis.multi();
      for (const k of keys) p.expire(this.key(k.tenantId, k.docKey), TTL_S);
      await p.exec();
    } catch {
      // see record()
    }
  }
}
