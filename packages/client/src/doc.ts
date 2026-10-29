/**
 * SyncraDoc: a Y.Doc wired to local persistence (Doc 04 §3.3, §6). Local edits are batched,
 * written to the update log and outbox in one transaction, and only then offered to the network.
 */
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import type { LocalStore } from './store.js';
import { StorageFullError } from './store.js';
import type { DocSyncState, SyncraErrorInfo } from './types.js';

/** Transaction origins; anything else is treated as a local edit. */
export const ORIGIN = { load: 'local-load', remote: 'remote', tab: 'tab' } as const;

export const LOCAL_COMPACT_UPDATES = 100;
export const LOCAL_COMPACT_BYTES = 500 * 1024;
const PRESENCE_MIN_INTERVAL_MS = 50; // 20 updates per second

export type PresenceState = Record<string, unknown>;

export interface DocHost {
  store: LocalStore;
  batchMs: number;
  nextOpId(): string;
  /** Tell sibling tabs about a raw update (immediately, before it is persisted). */
  publishUpdate(docKey: string, update: Uint8Array): void;
  /** Awareness bytes to send to the server and sibling tabs. */
  publishAwareness(docKey: string, update: Uint8Array): void;
  /** Outbox grew; the engine should drain and counters should refresh. */
  onLocalPersisted(docKey: string): void;
  /** A write could not be persisted; the update is handed over for best-effort memory sending. */
  onStorageError(docKey: string, update: Uint8Array, err: SyncraErrorInfo): void;
  /** Drop one reference to this document (see SyncraClient.doc). */
  release(doc: SyncraDoc): void;
  /** Optional per-collection schema (any Zod-like object). */
  schema?: { safeParse(v: unknown): { success: boolean; error?: { message: string } } };
}

export class SchemaError extends Error {
  readonly code = 'VALIDATION_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

export class SyncraDoc {
  readonly ydoc = new Y.Doc({ gc: true });
  readonly awareness = new Awareness(this.ydoc);
  readonly docKey: string;
  private _state: DocSyncState = 'loading';
  private readonly stateListeners = new Set<() => void>();
  private chain: Promise<unknown> = Promise.resolve();
  private pending: Uint8Array[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private updatesSinceSnapshot = 0;
  private bytesSinceSnapshot = 0;
  private lastRowId = 0;
  private readonly loaded: Promise<void>;
  private resolveSynced!: () => void;
  private readonly synced = new Promise<void>((r) => (this.resolveSynced = r));
  private presencePending: PresenceState | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;
  private presenceLast = 0;
  refs = 1;

  constructor(
    readonly collection: string,
    readonly id: string,
    private readonly host: DocHost,
    ready: Promise<void>,
  ) {
    this.docKey = `${collection}/${id}`;
    this.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      this.onYUpdate(update, origin);
    });
    this.awareness.on(
      'update',
      (c: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin === ORIGIN.remote || origin === ORIGIN.tab) return;
        const clients = [...c.added, ...c.updated, ...c.removed];
        this.host.publishAwareness(this.docKey, encodeAwarenessUpdate(this.awareness, clients));
      },
    );
    this.loaded = ready.then(() => this.load());
    // Storage writes wait for the initial load so log order and row ids stay consistent.
    this.chain = this.loaded;
  }

  get state(): DocSyncState {
    return this._state;
  }

  /** @internal */
  setState(s: DocSyncState): void {
    if (s === this._state) return;
    this._state = s;
    if (s === 'synced') this.resolveSynced();
    this.stateListeners.forEach((l) => {
      l();
    });
  }

  onState(cb: () => void): () => void {
    this.stateListeners.add(cb);
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  /** Resolves when local data has been read from storage (never waits on the network). */
  whenLoaded(): Promise<void> {
    return this.loaded;
  }

  /** Resolves after the first successful server sync. */
  whenSynced(): Promise<void> {
    return this.synced;
  }

  map(name = 'data'): Y.Map<unknown> {
    return this.ydoc.getMap(name);
  }
  text(name = 'text'): Y.Text {
    return this.ydoc.getText(name);
  }
  array(name = 'list'): Y.Array<unknown> {
    return this.ydoc.getArray(name);
  }
  xml(name = 'content'): Y.XmlFragment {
    return this.ydoc.getXmlFragment(name);
  }
  toJSON(): unknown {
    return Object.fromEntries([...this.ydoc.share].map(([name, type]) => [name, type.toJSON()]));
  }

  /** Merges fields into the root `data` map, validating the result against the collection schema. */
  setFields(values: Record<string, unknown>): void {
    const data = this.map();
    if (this.host.schema) {
      const r = this.host.schema.safeParse({ ...data.toJSON(), ...values });
      if (!r.success) throw new SchemaError(r.error?.message ?? 'Schema validation failed');
    }
    this.ydoc.transact(() => {
      for (const [k, v] of Object.entries(values)) data.set(k, v);
    });
  }

  onChange(cb: () => void): () => void {
    const h = (): void => {
      cb();
    };
    this.ydoc.on('update', h);
    return () => {
      this.ydoc.off('update', h);
    };
  }

  readonly presence = {
    /** Merges into this client's awareness state, at most 20 updates per second. */
    set: (partial: PresenceState): void => {
      this.presencePending = { ...this.presencePending, ...partial };
      const wait = this.presenceLast + PRESENCE_MIN_INTERVAL_MS - Date.now();
      if (wait <= 0) this.flushPresence();
      else
        this.presenceTimer ??= setTimeout(() => {
          this.flushPresence();
        }, wait);
    },
    others: (): ReadonlyMap<number, PresenceState> => {
      const out = new Map<number, PresenceState>();
      for (const [id, st] of this.awareness.getStates()) {
        if (id !== this.ydoc.clientID) out.set(id, st);
      }
      return out;
    },
    onChange: (cb: () => void): (() => void) => {
      const h = (): void => {
        cb();
      };
      this.awareness.on('change', h);
      return () => {
        this.awareness.off('change', h);
      };
    },
  };

  private flushPresence(): void {
    clearTimeout(this.presenceTimer);
    this.presenceTimer = undefined;
    if (!this.presencePending) return;
    this.awareness.setLocalState({ ...this.awareness.getLocalState(), ...this.presencePending });
    this.presencePending = null;
    this.presenceLast = Date.now();
  }

  /** Applies a server update; it is persisted to the update log by the update handler. */
  applyRemote(update: Uint8Array): void {
    Y.applyUpdate(this.ydoc, update, ORIGIN.remote);
  }

  /** Applies an update that a sibling tab already persisted (no log write, no outbox). */
  applyFromTab(update: Uint8Array): void {
    Y.applyUpdate(this.ydoc, update, ORIGIN.tab);
  }

  applyAwareness(update: Uint8Array, origin: 'remote' | 'tab'): void {
    applyAwarenessUpdate(this.awareness, update, origin);
  }

  /** Resolves when everything written so far is persisted. */
  async flush(): Promise<void> {
    this.flushBatch();
    await this.chain;
  }

  private async load(): Promise<void> {
    const local = await this.host.store.load(this.docKey);
    if (local.snapshot) Y.applyUpdate(this.ydoc, local.snapshot, ORIGIN.load);
    this.ydoc.transact(() => {
      for (const u of local.updates) Y.applyUpdate(this.ydoc, u, ORIGIN.load);
    }, ORIGIN.load);
    this.lastRowId = local.lastUpdateId;
    this.updatesSinceSnapshot = local.updates.length;
    this.bytesSinceSnapshot = local.updateBytes;
    const now = Date.now();
    await this.host.store.putDoc({
      docKey: this.docKey,
      collection: this.collection,
      docId: this.id,
      serverSeq: 0,
      createdAt: now,
      updatedAt: now,
      deleted: false,
    });
    if (this._state === 'loading') this.setState('local-only');
  }

  private onYUpdate(update: Uint8Array, origin: unknown): void {
    if (origin === ORIGIN.load || origin === ORIGIN.tab) return;
    if (origin === ORIGIN.remote) {
      this.host.publishUpdate(this.docKey, update);
      this.enqueue(async () => {
        await this.persist(() => this.host.store.appendRemote(this.docKey, update), update.length);
      });
      return;
    }
    this.host.publishUpdate(this.docKey, update);
    this.pending.push(update);
    if (this.host.batchMs <= 0) this.flushBatch();
    else
      this.batchTimer ??= setTimeout(() => {
        this.flushBatch();
      }, this.host.batchMs);
  }

  private flushBatch(): void {
    clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
    if (this.pending.length === 0) return;
    const merged =
      this.pending.length === 1 ? (this.pending[0] as Uint8Array) : Y.mergeUpdates(this.pending);
    this.pending = [];
    const opId = this.host.nextOpId();
    this.enqueue(async () => {
      const ok = await this.persist(
        () => this.host.store.appendLocal(this.docKey, merged, opId),
        merged.length,
      );
      if (ok) this.host.onLocalPersisted(this.docKey);
    });
  }

  /** Serializes storage writes so log order always matches edit order. */
  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn, fn);
  }

  private async persist(write: () => Promise<number>, bytes: number): Promise<boolean> {
    try {
      this.lastRowId = await write();
    } catch (e) {
      const info: SyncraErrorInfo =
        e instanceof StorageFullError
          ? { code: 'storage-full', message: e.message }
          : { code: 'storage-error', message: e instanceof Error ? e.message : 'storage failed' };
      // The edit stays in the in-memory Y.Doc; the engine may still send it best-effort.
      this.host.onStorageError(this.docKey, Y.encodeStateAsUpdate(this.ydoc), info);
      return false;
    }
    this.updatesSinceSnapshot++;
    this.bytesSinceSnapshot += bytes;
    if (
      this.updatesSinceSnapshot >= LOCAL_COMPACT_UPDATES ||
      this.bytesSinceSnapshot >= LOCAL_COMPACT_BYTES
    ) {
      await this.compact();
    }
    return true;
  }

  private async compact(): Promise<void> {
    const upTo = this.lastRowId;
    try {
      await this.host.store.compact(this.docKey, Y.encodeStateAsUpdate(this.ydoc), upTo);
      this.updatesSinceSnapshot = 0;
      this.bytesSinceSnapshot = 0;
    } catch {
      // Compaction is an optimisation; try again after the next write.
    }
  }

  /** Releases this reference; the document closes when the last holder lets go. */
  close(): void {
    this.host.release(this);
  }

  /** Releases timers and the Y.Doc after pending writes finish. */
  async destroy(): Promise<void> {
    await this.flush();
    clearTimeout(this.presenceTimer);
    this.awareness.destroy();
    this.ydoc.destroy();
  }
}
