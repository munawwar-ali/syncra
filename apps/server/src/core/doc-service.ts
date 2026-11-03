/**
 * Hot-document service: routes to shards, caches live Y.Docs, validates and batches writes, and
 * broadcasts committed updates to local subscribers (Doc 02 §4.2-4.4).
 */
import type pg from 'pg';
import * as Y from 'yjs';
import { encodeMessage } from '@syncra/protocol';
import { INDEX_COLLECTION, SyncraError } from '@syncra/shared';
import type { ShardRing } from '../shards/ring.js';
import {
  appendOps,
  ensureDocument,
  findDocument,
  loadDoc,
  opKey,
  type AppendResult,
} from './doc-store.js';
import { HotCache } from './hot-cache.js';
import { WriteBatcher } from './write-batcher.js';

export interface Subscriber {
  id: string;
  clientId: string;
  send(frame: Uint8Array): void;
}

export interface HotDoc {
  uid: string;
  tenantId: string;
  collection: string;
  docId: string;
  shard: pg.Pool;
  doc: Y.Doc;
  headSeq: number;
  /** Persisted size of the document, for max-document-size and storage quotas. */
  sizeBytes: number;
  /** Set when the document is soft-deleted; further writes fail with NOT_FOUND. */
  deleted?: boolean;
  subs: Set<Subscriber>;
}

/** Optional policy and event hooks (quotas, metering, webhooks); all are best-effort except the checks. */
export interface DocHooks {
  checkCreate?(tenantId: string): Promise<void>;
  checkWrite?(tenantId: string, w: { updateBytes: number; docSizeAfter: number }): Promise<void>;
  /** One accepted client update frame (the billing unit "op"), counted before batching. */
  accepted?(tenantId: string, bytes: number): void;
  created?(tenantId: string, collection: string, docId: string): void;
  deleted?(tenantId: string, collection: string, docId: string): void;
  committed?(
    tenantId: string,
    collection: string,
    docId: string,
    info: { seq: number; bytes: number },
  ): void;
}

export interface DocServiceOptions {
  ring: ShardRing;
  shards: pg.Pool[];
  cacheMax: number;
  cacheIdleMs: number;
  batchWindowMs: number;
  batchMaxBytes: number;
  maxUpdateBytes: number;
  hooks?: DocHooks;
}

export const docKeyOf = (h: Pick<HotDoc, 'collection' | 'docId'>): string =>
  `${h.collection}/${h.docId}`;

/** Yjs encodes "no changes" as these two bytes; persisting it would only waste a seq. */
const isEmptyUpdate = (u: Uint8Array): boolean => u.length === 2 && u[0] === 0 && u[1] === 0;

export class DocService {
  private readonly cache: HotCache<HotDoc>;
  private readonly byUid = new Map<string, HotDoc>();
  private readonly loading = new Map<string, Promise<HotDoc>>();
  private readonly batcher: WriteBatcher<AppendResult>;
  private readonly sweep: NodeJS.Timeout;

  constructor(private readonly opts: DocServiceOptions) {
    this.cache = new HotCache<HotDoc>({
      max: opts.cacheMax,
      idleMs: opts.cacheIdleMs,
      onEvict: (_k, h) => {
        this.byUid.delete(h.uid);
        h.doc.destroy();
      },
    });
    this.batcher = new WriteBatcher<AppendResult>({
      windowMs: opts.batchWindowMs,
      maxBytes: opts.batchMaxBytes,
      flush: (batch) => this.commit(batch.docKey, batch.items),
    });
    this.sweep = setInterval(() => this.cache.evictIdle(), Math.max(1000, opts.cacheIdleMs / 4));
    this.sweep.unref();
  }

  get hotDocCount(): number {
    return this.cache.size;
  }

  /** Loads (or creates, when `create`) a document. Concurrent opens share one load. */
  async open(
    tenantId: string,
    collection: string,
    docId: string,
    create: boolean,
  ): Promise<HotDoc> {
    const key = `${collection}/${docId}`;
    const cached = this.cache.get(tenantId, key);
    if (cached) return cached;
    const lk = `${tenantId}\u0000${key}\u0000${String(create)}`;
    let p = this.loading.get(lk);
    if (!p) {
      p = this.load(tenantId, collection, docId, create).finally(() => this.loading.delete(lk));
      this.loading.set(lk, p);
    }
    return p;
  }

  private async load(
    tenantId: string,
    collection: string,
    docId: string,
    create: boolean,
  ): Promise<HotDoc> {
    const shard = this.opts.shards[this.opts.ring.route(tenantId, collection, docId)] as pg.Pool;
    const isIndex = collection === INDEX_COLLECTION;
    let ref = await findDocument(shard, tenantId, collection, docId);
    if (!ref && create) {
      if (!isIndex) await this.opts.hooks?.checkCreate?.(tenantId);
      ref = await ensureDocument(shard, tenantId, collection, docId);
      if (ref.created && !isIndex) this.opts.hooks?.created?.(tenantId, collection, docId);
    }
    if (!ref) throw new SyncraError('NOT_FOUND', 'Document not found');
    const loaded = await loadDoc(shard, tenantId, ref.uid);
    const existing = this.cache.get(tenantId, `${collection}/${docId}`);
    if (existing) return existing;
    const hot: HotDoc = {
      uid: ref.uid,
      tenantId,
      collection,
      docId,
      shard,
      doc: loaded.doc,
      headSeq: loaded.headSeq,
      sizeBytes: loaded.sizeBytes,
      subs: new Set(),
    };
    this.cache.set(tenantId, `${collection}/${docId}`, hot);
    this.byUid.set(hot.uid, hot);
    return hot;
  }

  /**
   * Soft-deletes a document (DAT-07). Open connections keep their hot copy but every further write
   * fails with NOT_FOUND, and new subscribers get NOT_FOUND.
   */
  async delete(tenantId: string, collection: string, docId: string): Promise<boolean> {
    const shard = this.opts.shards[this.opts.ring.route(tenantId, collection, docId)] as pg.Pool;
    const r = await shard.query(
      'update documents set deleted_at = now() where tenant_id = $1 and collection = $2 and doc_id = $3 and deleted_at is null',
      [tenantId, collection, docId],
    );
    if (r.rowCount === 0) return false;
    const hot = this.cache.get(tenantId, `${collection}/${docId}`);
    if (hot) {
      hot.deleted = true;
      this.cache.delete(tenantId, `${collection}/${docId}`);
    }
    this.opts.hooks?.deleted?.(tenantId, collection, docId);
    return true;
  }

  subscribe(hot: HotDoc, sub: Subscriber): void {
    if (hot.subs.has(sub)) return;
    hot.subs.add(sub);
    this.cache.acquire(hot.tenantId, docKeyOf(hot));
  }

  unsubscribe(hot: HotDoc, sub: Subscriber): void {
    if (!hot.subs.delete(sub)) return;
    this.cache.release(hot.tenantId, docKeyOf(hot));
  }

  /** Answers a SYNC_STEP1: what the client lacks, plus our state vector. */
  syncStep(
    hot: HotDoc,
    clientStateVector: Uint8Array,
  ): { update: Uint8Array; stateVector: Uint8Array } {
    try {
      return {
        update: Y.encodeStateAsUpdate(hot.doc, clientStateVector),
        stateVector: Y.encodeStateVector(hot.doc),
      };
    } catch {
      throw new SyncraError('VALIDATION_FAILED', 'Invalid state vector');
    }
  }

  /**
   * Validates, batches and persists one client update; resolves with its seq after the commit.
   * The synchronous prefix (checks and applying to the hot doc) runs in call order, so a
   * connection's updates are applied in the order they arrived.
   */
  async write(hot: HotDoc, clientId: string, opId: string, update: Uint8Array): Promise<number> {
    if (update.length > this.opts.maxUpdateBytes) {
      throw new SyncraError('PAYLOAD_TOO_LARGE', 'Update exceeds size limit');
    }
    if (hot.deleted) throw new SyncraError('NOT_FOUND', 'Document not found');
    if (isEmptyUpdate(update)) return hot.headSeq;
    // Decode check on a scratch copy first, so a rejected write never touches the live document.
    try {
      Y.applyUpdate(new Y.Doc(), update);
    } catch {
      throw new SyncraError('VALIDATION_FAILED', 'Malformed update');
    }
    await this.opts.hooks?.checkWrite?.(hot.tenantId, {
      updateBytes: update.length,
      docSizeAfter: hot.sizeBytes + update.length,
    });
    this.opts.hooks?.accepted?.(hot.tenantId, update.length);
    Y.applyUpdate(hot.doc, update, 'remote');
    const k = docKeyOf(hot);
    this.cache.acquire(hot.tenantId, k); // keep the doc resident until the write is durable
    try {
      const r = await this.batcher.add(hot.uid, { clientId, opId, update });
      return r.seqs.get(opKey(clientId, opId)) as number;
    } catch (e) {
      await this.resetFromDb(hot);
      throw e instanceof SyncraError ? e : new SyncraError('UNAVAILABLE', 'Storage unavailable');
    } finally {
      this.cache.release(hot.tenantId, k);
    }
  }

  /** After a failed commit, drop unpersisted state from the hot doc by reloading it. */
  private async resetFromDb(hot: HotDoc): Promise<void> {
    try {
      const fresh = await loadDoc(hot.shard, hot.tenantId, hot.uid);
      const old = hot.doc;
      hot.doc = fresh.doc;
      hot.headSeq = fresh.headSeq;
      hot.sizeBytes = fresh.sizeBytes;
      old.destroy();
    } catch {
      // Storage is still down; the next successful write or subscribe will resync.
    }
  }

  private async commit(
    uid: string,
    items: { clientId: string; opId: string; update: Uint8Array }[],
  ) {
    const hot = this.byUid.get(uid);
    if (!hot) throw new SyncraError('INTERNAL', 'Document evicted during write');
    const r = await appendOps(hot.shard, hot.tenantId, hot.uid, items);
    if (r.newSeq !== null && r.merged) {
      hot.headSeq = Math.max(hot.headSeq, r.newSeq);
      hot.sizeBytes += r.merged.length;
      if (hot.collection !== INDEX_COLLECTION) {
        this.opts.hooks?.committed?.(hot.tenantId, hot.collection, hot.docId, {
          seq: r.newSeq,
          bytes: r.merged.length,
        });
      }
      const origins = new Set(items.map((i) => i.clientId));
      const origin = origins.size === 1 ? ([...origins][0] as string) : 'multi';
      const frame = encodeMessage({
        type: 'UPDATE_BROADCAST',
        docKey: docKeyOf(hot),
        seq: r.newSeq,
        originClientId: origin,
        update: r.merged,
      });
      for (const s of hot.subs) if (origins.size > 1 || s.clientId !== origin) s.send(frame);
    }
    return r;
  }

  /** Flushes buffered writes (graceful shutdown). */
  async drain(): Promise<void> {
    await this.batcher.drain();
    clearInterval(this.sweep);
  }
}
