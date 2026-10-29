/** Consistent-hash ring mapping a document key to a shard index (Doc 02 §8). Pure function. */

/** murmur3 32-bit over UTF-8 bytes (Doc 02 §8 allows xxhash64 or murmur3). */
export function murmur3(key: string, seed = 0): number {
  const data = new TextEncoder().encode(key);
  let h = seed >>> 0;
  const blocks = data.length >> 2;
  for (let i = 0; i < blocks; i++) {
    let k =
      (data[i * 4] ?? 0) |
      ((data[i * 4 + 1] ?? 0) << 8) |
      ((data[i * 4 + 2] ?? 0) << 16) |
      ((data[i * 4 + 3] ?? 0) << 24);
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    h ^= Math.imul(k, 0x1b873593);
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  const tail = blocks * 4;
  switch (data.length & 3) {
    case 3:
      k ^= (data[tail + 2] ?? 0) << 16;
    // falls through
    case 2:
      k ^= (data[tail + 1] ?? 0) << 8;
    // falls through
    case 1:
      k ^= data[tail] ?? 0;
      k = Math.imul(k, 0xcc9e2d51);
      k = (k << 15) | (k >>> 17);
      h ^= Math.imul(k, 0x1b873593);
  }
  h ^= data.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class ShardRing {
  private readonly positions: Uint32Array;
  private readonly owners: Uint16Array;

  constructor(
    readonly shardCount: number,
    vnodes = 64,
  ) {
    if (shardCount < 1) throw new Error('shardCount must be >= 1');
    const points: [number, number][] = [];
    for (let s = 0; s < shardCount; s++) {
      for (let v = 0; v < vnodes; v++) points.push([murmur3(`shard-${String(s)}#${String(v)}`), s]);
    }
    points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    this.positions = Uint32Array.from(points, (p) => p[0]);
    this.owners = Uint16Array.from(points, (p) => p[1]);
  }

  /** Shard index owning `(tenantId, collection, docId)`. */
  route(tenantId: string, collection: string, docId: string): number {
    const h = murmur3(`${tenantId}/${collection}/${docId}`);
    let lo = 0;
    let hi = this.positions.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.positions[mid] ?? 0) < h) lo = mid + 1;
      else hi = mid;
    }
    return this.owners[lo === this.positions.length ? 0 : lo] ?? 0;
  }
}
