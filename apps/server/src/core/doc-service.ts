/**
 * Hot-document service: routes to shards, caches live Y.Docs, validates and batches writes, fans
 * committed updates out to local subscribers and to other nodes, and repairs missed updates from
 * Postgres (Doc 02 §4.2-4.5). Postgres is the source of truth; the pub/sub bus is only a hint.
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
import {
  awarenessChannel,
  decodeAwarenessBroadcast,
  decodeDocBroadcast,
  docChannel,
  encodeDocBroadcast,
  type PubSub,
} from './pubsub.js';
import { WriteBatcher } from './write-batcher.js';

export interface Subscriber {
  id: string;
  clientId: string;
  send(frame: Uint8Array): void;
  /** Update from another client; implementations may coalesce when the consumer is slow. */
  broadcast?(docKey: string, seq: number, originClientId: string, update: Uint8Array): void;
  /** Ephemeral frame (awareness); may be dropped when the consumer is slow. */
  sendEphemeral?(frame: Uint8Array): void;
}

export interface HotDoc {
  uid: string;
  tenantId: string;
  collection: string;
  docId: string;
  shard: pg.Pool;
  doc: Y.Doc;
  /** Highest seq applied to `doc`; every op up to here has been seen. */
  headSeq: number;
  /** Persisted size of the document, for max-document-size and storage quotas. */
  sizeBytes: number;
  /** Set when the document is soft-deleted; further writes fail with NOT_FOUND. */
  deleted?: boolean;
  subs: Set<Subscriber>;
  /** Seqs this node committed itself and already broadcast, so catch-up does not re-send them. */
  ownSeqs: Set<number>;
  catching?: boolean;
  catchAgain?: boolean;
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
  /** A gap was detected and repaired from Postgres. */
  gapRecovered?(): void;
  /** One batch committed: which shard, how long the transaction took, how many bytes. */
  batchCommitted?(info: { shard: number; ms: number; bytes: number }): void;
  /** Delay between the origin node committing an update and this node applying it. */
  fanoutLag?(ms: number): void;
}

export interface DocServiceOptions {
  ring: ShardRing;
  shards: pg.Pool[];
  cacheMax: number;
  cacheIdleMs: number;
  batchWindowMs: number;
  batchMaxBytes: number;
  maxUpdateBytes: number;
  nodeId?: string;
  pubsub?: PubSub;
  /** Reconcile interval while the bus is healthy / while it is down (Doc 02 §4.5). */
  reconcileMs?: number;
  degradedReconcileMs?: number;
  hooks?: DocHooks;
  onError?: (what: string, e: unknown) => void;
}

export const docKeyOf = (h: Pick<HotDoc, 'collection' | 'docId'>): string =>
  `${h.collection}/${h.docId}`;

/** Yjs encodes "no changes" as these two bytes; persisting it would only waste a seq. */
const isEmptyUpdate = (u: Uint8Array): boolean => u.length === 2 && u[0] === 0 && u[1] === 0;

export class DocService {
  private readonly cache: HotCache<HotDoc>;
  private readonly byUid = new Map<string, HotDoc>();
  private readonly byDocChannel = new Map<string, HotDoc>();
  private readonly loading = new Map<string, Promise<HotDoc>>();
  private readonly batcher: WriteBatcher<AppendResult>;
  private readonly sweep: NodeJS.Timeout;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  readonly nodeId: string;

  constructor(private readonly opts: DocServiceOptions) {
    this.nodeId = opts.nodeId ?? 'node';
    this.cache = new HotCache<HotDoc>({
      max: opts.cacheMax,
      idleMs: opts.cacheIdleMs,
      onEvict: (_k, h) => {
        this.byUid.delete(h.uid);
        this.dropChannels(h);
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
    opts.pubsub?.onMessage((channel, payload) => {
      this.onBus(channel, payload);
    });
    if (opts.pubsub) this.scheduleReconcile();
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get hotDocCount(): number {
    return this.cache.size;
  }

  private err(what: string, e: unknown): void {
    this.opts.onError?.(what, e);
  }

  // ---- loading -------------------------------------------------------------------------

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

  private shardFor(tenantId: string, collection: string, docId: string): pg.Pool {
    return this.opts.shards[this.opts.ring.route(tenantId, collection, docId)] as pg.Pool;
  }

  private async load(
    tenantId: string,
    collection: string,
    docId: string,
    create: boolean,
  ): Promise<HotDoc> {
    const shard = this.shardFor(tenantId, collection, docId);
    const isIndex = collection === INDEX_COLLECTION;
    let ref = await findDocument(shard, tenantId, collection, docId);
    if (!ref && create) {
      if (!isIndex) await this.opts.hooks?.checkCreate?.(tenantId);
      ref = await ensureDocument(shard, tenantId, collection, docId);
      if (ref.created && !isIndex) {
        await this.recordChange(shard, tenantId, collection, docId, 'create');
        this.opts.hooks?.created?.(tenantId, collection, docId);
      }
    }
    if (!ref) throw new SyncraError('NOT_FOUND', 'Document not found');
    const loaded = await loadDoc(shard, tenantId, ref.uid);
    const key = `${collection}/${docId}`;
    const existing = this.cache.get(tenantId, key);
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
      ownSeqs: new Set(),
    };
    this.cache.set(tenantId, key, hot);
    this.byUid.set(hot.uid, hot);
    await this.addChannels(hot);
    // Anything committed elsewhere between the load and the subscription is picked up here.
    await this.catchUp(hot);
    return hot;
  }

  private async recordChange(
    shard: pg.Pool,
    tenantId: string,
    collection: string,
    docId: string,
    kind: 'create' | 'delete',
  ): Promise<void> {
    try {
      await shard.query(
        'insert into changes (tenant_id, collection, doc_id, kind) values ($1,$2,$3,$4)',
        [tenantId, collection, docId, kind],
      );
    } catch (e) {
      this.err('change feed insert failed', e);
    }
  }

  // ---- bus -----------------------------------------------------------------------------

  private async addChannels(hot: HotDoc): Promise<void> {
    const ps = this.opts.pubsub;
    if (!ps) return;
    const key = docKeyOf(hot);
    const dc = docChannel(hot.tenantId, key);
    this.byDocChannel.set(dc, hot);
    try {
      await ps.subscribe(dc);
      await ps.subscribe(awarenessChannel(hot.tenantId, key));
    } catch (e) {
      this.err('pubsub subscribe failed', e); // reconcile keeps the document converging
    }
  }

  private dropChannels(hot: HotDoc): void {
    const ps = this.opts.pubsub;
    if (!ps) return;
    const key = docKeyOf(hot);
    this.byDocChannel.delete(docChannel(hot.tenantId, key));
    ps.unsubscribe(docChannel(hot.tenantId, key)).catch(() => undefined);
    ps.unsubscribe(awarenessChannel(hot.tenantId, key)).catch(() => undefined);
  }

  private onBus(channel: string, payload: Uint8Array): void {
    const hot = this.byDocChannel.get(channel);
    if (channel.startsWith('sx:aw:')) {
      this.onAwarenessBus(channel, payload);
      return;
    }
    if (!hot) return;
    const m = decodeDocBroadcast(payload);
    if (!m || m.originNode === this.nodeId) return;
    if (m.seq <= hot.headSeq) return; // duplicate or already recovered
    if (m.seq === hot.headSeq + 1) {
      this.applyRemote(hot, m.seq, m.originClient, m.update);
      if (m.sentAt !== undefined) this.opts.hooks?.fanoutLag?.(Math.max(0, Date.now() - m.sentAt));
      return;
    }
    this.opts.hooks?.gapRecovered?.();
    void this.catchUp(hot);
  }

  private onAwarenessBus(channel: string, payload: Uint8Array): void {
    const m = decodeAwarenessBroadcast(payload);
    if (!m || m.originNode === this.nodeId) return;
    // sx:aw:{tid}:{collection}/{docId}:ch -> the doc channel for the same document
    const hot = this.byDocChannel.get(`sx:doc:${channel.slice('sx:aw:'.length)}`);
    if (!hot) return;
    const frame = encodeMessage({ type: 'AWARENESS', docKey: docKeyOf(hot), update: m.update });
    for (const s of hot.subs) (s.sendEphemeral ?? s.send).call(s, frame);
  }

  private applyRemote(hot: HotDoc, seq: number, origin: string, update: Uint8Array): void {
    Y.applyUpdate(hot.doc, update, 'remote');
    hot.headSeq = seq;
    hot.sizeBytes += update.length;
    this.forward(hot, seq, origin, update, false);
  }

  private forward(
    hot: HotDoc,
    seq: number,
    origin: string,
    update: Uint8Array,
    skipOrigin: boolean,
  ): void {
    const key = docKeyOf(hot);
    for (const s of hot.subs) {
      if (skipOrigin && s.clientId === origin) continue;
      if (s.broadcast) s.broadcast(key, seq, origin, update);
      else
        s.send(
          encodeMessage({
            type: 'UPDATE_BROADCAST',
            docKey: key,
            seq,
            originClientId: origin,
            update,
          }),
        );
    }
  }

  /**
   * Applies every op after `headSeq` straight from Postgres. If the ops are no longer there (compacted
   * away while this node was behind), reloads the document and tells clients to resync.
   */
  async catchUp(hot: HotDoc): Promise<void> {
    if (hot.catching) {
      hot.catchAgain = true;
      return;
    }
    hot.catching = true;
    // catchAgain is set by re-entrant catchUp() calls while we await; a function keeps TS from narrowing it.
    const again = (): boolean => hot.catchAgain === true;
    try {
      do {
        hot.catchAgain = false;
        const { rows } = await hot.shard.query<{ seq: string; client_id: string; update: Buffer }>(
          `select seq, client_id, update from operations
           where doc_uid = $1 and tenant_id = $2 and seq > $3 order by seq`,
          [hot.uid, hot.tenantId, hot.headSeq],
        );
        const first = rows[0];
        if (first && Number(first.seq) !== hot.headSeq + 1) {
          await this.reload(hot);
          continue;
        }
        for (const r of rows) {
          const seq = Number(r.seq);
          Y.applyUpdate(hot.doc, r.update, 'remote');
          hot.headSeq = seq;
          if (hot.ownSeqs.delete(seq)) continue; // already counted and broadcast by commit()
          hot.sizeBytes += r.update.length;
          this.forward(hot, seq, r.client_id, r.update, false);
        }
      } while (again());
    } catch (e) {
      this.err('catch-up failed', e);
    } finally {
      hot.catching = false;
    }
  }

  /** Replaces the in-memory document with the persisted state and asks clients to resync. */
  private async reload(hot: HotDoc): Promise<void> {
    const fresh = await loadDoc(hot.shard, hot.tenantId, hot.uid);
    const old = hot.doc;
    hot.doc = fresh.doc;
    hot.headSeq = fresh.headSeq;
    hot.sizeBytes = fresh.sizeBytes;
    hot.ownSeqs.clear();
    old.destroy();
    const frame = encodeMessage({
      type: 'RESYNC_HINT',
      docKey: docKeyOf(hot),
      headSeq: hot.headSeq,
    });
    for (const s of hot.subs) s.send(frame);
  }

  /** Compares each subscribed hot document with Postgres and repairs any that fell behind or were deleted. */
  async reconcile(): Promise<number> {
    const byShard = new Map<pg.Pool, HotDoc[]>();
    for (const h of this.byUid.values()) {
      if (h.subs.size === 0 || h.deleted) continue;
      byShard.set(h.shard, [...(byShard.get(h.shard) ?? []), h]);
    }
    let repaired = 0;
    for (const [shard, docs] of byShard) {
      try {
        const { rows } = await shard.query<{
          uid: string;
          head_seq: string;
          deleted_at: Date | null;
        }>('select uid, head_seq, deleted_at from documents where uid = any($1::uuid[])', [
          docs.map((d) => d.uid),
        ]);
        for (const r of rows) {
          const hot = this.byUid.get(r.uid);
          if (!hot) continue;
          if (r.deleted_at) {
            hot.deleted = true;
            this.cache.delete(hot.tenantId, docKeyOf(hot));
          } else if (Number(r.head_seq) > hot.headSeq) {
            repaired++;
            this.opts.hooks?.gapRecovered?.();
            await this.catchUp(hot);
          }
        }
      } catch (e) {
        this.err('reconcile failed', e);
      }
    }
    return repaired;
  }

  /**
   * Ticks at the short (degraded) interval and decides on every tick, so an outage that starts mid-wait
   * is noticed within one short interval. Healthy clusters still only reconcile every reconcileMs.
   */
  private scheduleReconcile(): void {
    if (this.stopped) return;
    const degradedMs = this.opts.degradedReconcileMs ?? 5_000;
    const healthyMs = this.opts.reconcileMs ?? 30_000;
    let last = Date.now();
    const tick = (): void => {
      if (this.stopped) return;
      const due = !(this.opts.pubsub?.healthy() ?? true) || Date.now() - last >= healthyMs;
      const run = due ? this.reconcile().then(() => void (last = Date.now())) : Promise.resolve();
      void run.finally(() => {
        this.reconcileTimer = setTimeout(tick, Math.min(degradedMs, healthyMs));
        this.reconcileTimer.unref();
      });
    };
    this.reconcileTimer = setTimeout(tick, Math.min(degradedMs, healthyMs));
    this.reconcileTimer.unref();
  }

  // ---- subscriptions -------------------------------------------------------------------

  /**
   * Soft-deletes a document (DAT-07). Open connections keep their hot copy but every further write
   * fails with NOT_FOUND, and new subscribers get NOT_FOUND.
   */
  async delete(tenantId: string, collection: string, docId: string): Promise<boolean> {
    const shard = this.shardFor(tenantId, collection, docId);
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
    await this.recordChange(shard, tenantId, collection, docId, 'delete');
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

  /** Sends awareness to other local subscribers (not the sender). */
  forwardAwareness(hot: HotDoc, from: Subscriber | null, update: Uint8Array): void {
    const frame = encodeMessage({ type: 'AWARENESS', docKey: docKeyOf(hot), update });
    for (const s of hot.subs) if (s !== from) (s.sendEphemeral ?? s.send).call(s, frame);
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

  // ---- writes --------------------------------------------------------------------------

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
      await this.reload(hot);
    } catch {
      // Storage is still down; the next successful write or reconcile will resync.
    }
  }

  private async commit(
    uid: string,
    items: { clientId: string; opId: string; update: Uint8Array }[],
  ) {
    const hot = this.byUid.get(uid);
    if (!hot) throw new SyncraError('INTERNAL', 'Document evicted during write');
    const t0 = performance.now();
    const r = await appendOps(hot.shard, hot.tenantId, hot.uid, items);
    if (r.newSeq !== null && r.merged) {
      this.opts.hooks?.batchCommitted?.({
        shard: this.opts.shards.indexOf(hot.shard),
        ms: performance.now() - t0,
        bytes: r.merged.length,
      });
      const seq = r.newSeq;
      const origins = new Set(items.map((i) => i.clientId));
      const origin = origins.size === 1 ? ([...origins][0] as string) : 'multi';
      if (seq > hot.headSeq) {
        hot.sizeBytes += r.merged.length;
        // Ordering: persisted (above) -> ACK (caller) -> broadcast. Local subscribers first, then other nodes.
        this.forward(hot, seq, origin, r.merged, origins.size === 1);
        if (seq === hot.headSeq + 1) {
          hot.headSeq = seq;
        } else {
          // Another node committed in between; fetch what we have not seen, skipping our own broadcast.
          hot.ownSeqs.add(seq);
          void this.catchUp(hot);
        }
      }
      void this.publish(hot, seq, origin, r.merged);
      if (hot.collection !== INDEX_COLLECTION) {
        this.opts.hooks?.committed?.(hot.tenantId, hot.collection, hot.docId, {
          seq,
          bytes: r.merged.length,
        });
      }
    }
    return r;
  }

  private async publish(
    hot: HotDoc,
    seq: number,
    origin: string,
    update: Uint8Array,
  ): Promise<void> {
    const ps = this.opts.pubsub;
    if (!ps) return;
    try {
      await ps.publish(
        docChannel(hot.tenantId, docKeyOf(hot)),
        encodeDocBroadcast({ seq, originNode: this.nodeId, originClient: origin, update }),
      );
    } catch (e) {
      this.err('pubsub publish failed', e); // other nodes recover through reconcile (OPS-11)
    }
  }

  // ---- history -------------------------------------------------------------------------

  /**
   * Non-destructive restore (DAT-05, ADR 0014): computes the edit that turns the current content into
   * the checkpoint's content and writes it as a normal op, so history keeps both states.
   */
  async restore(tenantId: string, collection: string, docId: string, seq: number): Promise<number> {
    const hot = await this.open(tenantId, collection, docId, false);
    const { rows } = await hot.shard.query<{ state: Buffer }>(
      `select state from snapshots where doc_uid = $1 and tenant_id = $2 and kind = 'checkpoint' and up_to_seq <= $3
       order by up_to_seq desc limit 1`,
      [hot.uid, tenantId, seq],
    );
    const cp = rows[0];
    if (!cp) throw new SyncraError('NOT_FOUND', 'No checkpoint at or before that seq');
    const target = new Y.Doc();
    Y.applyUpdate(target, cp.state);
    const work = new Y.Doc();
    Y.applyUpdate(work, Y.encodeStateAsUpdate(hot.doc));
    const before = Y.encodeStateVector(work);
    work.transact(() => {
      restoreRoots(work, target);
    });
    const update = Y.encodeStateAsUpdate(work, before);
    return this.write(hot, 'system:restore', `restore:${String(Date.now())}`, update);
  }

  /** Flushes buffered writes and stops background timers (graceful shutdown). */
  async drain(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconcileTimer);
    await this.batcher.drain();
    clearInterval(this.sweep);
  }

  /** All hot documents that have local subscribers, for presence TTL refresh. */
  activeDocs(): { tenantId: string; docKey: string }[] {
    return [...this.byUid.values()]
      .filter((h) => h.subs.size > 0)
      .map((h) => ({ tenantId: h.tenantId, docKey: docKeyOf(h) }));
  }
}

const jsonOf = (v: unknown): unknown => (v instanceof Y.AbstractType ? v.toJSON() : v);

/**
 * Rewrites `work` so its root types hold `target`'s content, using the root-type conventions of
 * Doc 03 §4.3 (data, text, list, content).
 * shortcut: nested shared types inside `data`/`list` are restored as plain JSON, not live types;
 * upgrade if a collection stores nested Y.Map/Y.Text and needs them to stay collaborative after restore.
 */
export function restoreRoots(work: Y.Doc, target: Y.Doc): void {
  if (work.share.has('data') || target.share.has('data')) {
    const w = work.getMap('data');
    const t = target.getMap('data');
    for (const k of [...w.keys()]) if (!t.has(k)) w.delete(k);
    for (const [k, v] of t.entries()) w.set(k, jsonOf(v));
  }
  if (work.share.has('text') || target.share.has('text')) {
    const w = work.getText('text');
    w.delete(0, w.length);
    w.applyDelta(target.getText('text').toDelta() as never);
  }
  if (work.share.has('list') || target.share.has('list')) {
    const w = work.getArray('list');
    w.delete(0, w.length);
    w.insert(0, target.getArray('list').toArray().map(jsonOf));
  }
  if (work.share.has('content') || target.share.has('content')) {
    const w = work.getXmlFragment('content');
    w.delete(0, w.length);
    // YXmlHook is a legacy node type this project never creates; keep only elements and text.
    const nodes = target.getXmlFragment('content').toArray();
    w.insert(
      0,
      nodes
        .filter((n): n is Y.XmlElement | Y.XmlText => !(n instanceof Y.XmlHook))
        .map((n) => n.clone()),
    );
  }
}
