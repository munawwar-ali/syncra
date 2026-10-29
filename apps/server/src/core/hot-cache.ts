/**
 * Per-node hot-document cache (Doc 02 §7.2): LRU with idle eviction and a heap-pressure guard.
 * Keys always include the tenant id so one tenant can never read another's cached document.
 */

interface Entry<V> {
  value: V;
  /** Local subscribers; entries in use are never evicted. */
  refs: number;
  lastActive: number;
}

export interface HotCacheOptions<V> {
  max: number;
  idleMs: number;
  now?: () => number;
  onEvict?: (key: string, value: V) => void;
}

export class HotCache<V> {
  // Map iteration order is insertion order, so re-inserting on access gives LRU order.
  private readonly entries = new Map<string, Entry<V>>();
  private capacity: number;
  private readonly now: () => number;

  constructor(private readonly opts: HotCacheOptions<V>) {
    this.capacity = opts.max;
    this.now = opts.now ?? Date.now;
  }

  private static key(tenantId: string, docKey: string): string {
    return `${tenantId}\u0000${docKey}`;
  }

  get size(): number {
    return this.entries.size;
  }

  get(tenantId: string, docKey: string): V | undefined {
    const k = HotCache.key(tenantId, docKey);
    const e = this.entries.get(k);
    if (!e) return undefined;
    e.lastActive = this.now();
    this.entries.delete(k);
    this.entries.set(k, e);
    return e.value;
  }

  set(tenantId: string, docKey: string, value: V): void {
    const k = HotCache.key(tenantId, docKey);
    const prev = this.entries.get(k);
    this.entries.delete(k);
    this.entries.set(k, { value, refs: prev?.refs ?? 0, lastActive: this.now() });
    this.evictOverCapacity(k);
  }

  /** Marks the document as having one more local subscriber. */
  acquire(tenantId: string, docKey: string): void {
    const e = this.entries.get(HotCache.key(tenantId, docKey));
    if (e) e.refs++;
  }

  release(tenantId: string, docKey: string): void {
    const e = this.entries.get(HotCache.key(tenantId, docKey));
    if (!e) return;
    e.refs = Math.max(0, e.refs - 1);
    e.lastActive = this.now();
  }

  /** Drops unreferenced entries idle for at least idleMs. Call on a timer. */
  evictIdle(): number {
    const cutoff = this.now() - this.opts.idleMs;
    let n = 0;
    for (const [k, e] of this.entries) {
      if (e.refs === 0 && e.lastActive <= cutoff) n += this.evict(k, e) ? 1 : 0;
    }
    return n;
  }

  /**
   * Cuts capacity by 25% when heap use exceeds 75% of the limit. Returns true if it fired.
   * Capacity never recovers on its own: shortcut: restart or call resetCapacity() to restore.
   */
  applyMemoryGuard(heapUsed: number, heapLimit: number): boolean {
    if (heapUsed / heapLimit <= 0.75) return false;
    this.capacity = Math.max(1, Math.floor(this.capacity * 0.75));
    this.evictOverCapacity();
    return true;
  }

  resetCapacity(): void {
    this.capacity = this.opts.max;
  }

  /** Evicts least-recently-used unreferenced entries; in-use entries may exceed capacity. */
  private evictOverCapacity(keep?: string): void {
    for (const [k, e] of this.entries) {
      if (this.entries.size <= this.capacity) return;
      if (e.refs === 0 && k !== keep) this.evict(k, e);
    }
  }

  private evict(k: string, e: Entry<V>): boolean {
    this.entries.delete(k);
    this.opts.onEvict?.(k, e.value);
    return true;
  }
}
