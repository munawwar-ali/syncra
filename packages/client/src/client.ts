/** createClient(): wires store, tabs, network, tokens, engine, documents and collections. */
import * as Y from 'yjs';
import { IdbStore } from './idb-store.js';
import { MemoryStore } from './memory-store.js';
import { copyStore } from './migrate-store.js';
import { NetworkMonitor } from './network.js';
import { SyncEngine } from './engine.js';
import { SyncraCollection, type CollectionEntry } from './collection.js';
import { SyncraDoc, type DocHost } from './doc.js';
import { TabCoordinator, browserTabEnv, type TabEnv, type TabMessage } from './tabs.js';
import { TokenManager } from './token.js';
import { webSocketTransport, type Transport } from './transport.js';
import type { LocalStore } from './store.js';
import {
  Emitter,
  type ClientEvents,
  type ConnectionState,
  type SyncStatus,
  type SyncraErrorInfo,
} from './types.js';

export type SchemaLike = {
  safeParse(v: unknown): { success: boolean; error?: { message: string } };
};

export interface ClientOptions {
  /** Base URL, ws(s):// or http(s)://. */
  url: string;
  publishableKey: string;
  getToken: () => Promise<string>;
  storage?: 'indexeddb' | 'memory';
  batchMs?: number;
  schemas?: Record<string, SchemaLike>;
  logger?: Pick<Console, 'warn' | 'error'>;
  /** Known identity for the local database name; otherwise cached from the last token. */
  identity?: { tenantId: string; userId: string };
  /** URL probed with HEAD to confirm connectivity after a failed connect. */
  probeUrl?: string;
  /** Advanced: how long to stay quota-blocked before retrying (default 60 s). */
  quotaRetryMs?: number;
  // Advanced / testing hooks.
  transport?: Transport;
  /** Pass `null` to disable multi-tab coordination (this tab is always the leader). */
  tabEnv?: TabEnv | null;
  store?: LocalStore;
}

export interface SyncraClient {
  readonly status: SyncStatus;
  subscribe(listener: (s: SyncStatus) => void): () => void;
  on<E extends keyof ClientEvents>(e: E, cb: ClientEvents[E]): () => void;
  doc(collection: string, id: string): SyncraDoc;
  collection<T = Record<string, unknown>>(name: string): SyncraCollection<T>;
  connect(): void;
  disconnect(): void;
  simulateOffline(on: boolean): void;
  /** Drops the socket so the engine reconnects (demo "kill my socket"). */
  dropConnection(): void;
  clearLocalData(): Promise<void>;
  destroy(): Promise<void>;
  /** Resolves when local storage is open. Documents work before this; they just load later. */
  whenReady(): Promise<void>;
}

export type { CollectionEntry };

const toWs = (u: string): string => u.replace(/^http/, 'ws');
const toHttp = (u: string): string => u.replace(/^ws/, 'http');

function readIdentity(pk: string): { tenantId: string; userId: string } | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(`syncra:identity:${pk}`);
    return raw ? (JSON.parse(raw) as { tenantId: string; userId: string }) : undefined;
  } catch {
    return undefined;
  }
}

export function createClient(opts: ClientOptions): SyncraClient {
  return new ClientImpl(opts);
}

class ClientImpl implements SyncraClient {
  private readonly events = new Emitter<ClientEvents>();
  private readonly listeners = new Set<(s: SyncStatus) => void>();
  private readonly docs = new Map<string, SyncraDoc>();
  private readonly collections = new Map<string, SyncraCollection>();
  /** docKey -> tabs (other than this one) that hold it open; only meaningful on the leader. */
  private readonly remoteOpen = new Map<string, Set<string>>();
  private readonly network: NetworkMonitor;
  private readonly tokens: TokenManager;
  private store!: LocalStore;
  private engine: SyncEngine | undefined;
  private tabs: TabCoordinator | null = null;
  private clientId = '';
  private counter = 0;
  private readonly tabSuffix = Math.random().toString(36).slice(2, 8);
  private connectWanted = false;
  private destroyed = false;
  private _status: SyncStatus;
  private readonly ready: Promise<void>;

  constructor(private readonly o: ClientOptions) {
    this.network = new NetworkMonitor({ probeUrl: o.probeUrl ?? `${toHttp(o.url)}/healthz` });
    this.network.start();
    this.tokens = new TokenManager(o.getToken);
    this._status = {
      connection: 'idle',
      online: this.network.online,
      pendingOps: 0,
      lastSyncedAt: null,
      isLeader: o.tabEnv === null,
      error: null,
    };
    this.network.onChange((online) => {
      this.setStatus({ online });
    });
    this.ready = this.init();
  }

  get status(): SyncStatus {
    return this._status;
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  subscribe(l: (s: SyncStatus) => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  on<E extends keyof ClientEvents>(e: E, cb: ClientEvents[E]): () => void {
    return this.events.on(e, cb);
  }

  private setStatus(patch: Partial<SyncStatus>, fromLeader = false): void {
    const next = { ...this._status, ...patch };
    if ((Object.keys(next) as (keyof SyncStatus)[]).every((k) => next[k] === this._status[k]))
      return;
    this._status = next;
    this.events.emit('status', next);
    this.listeners.forEach((l) => {
      l(next);
    });
    if (!fromLeader && this.tabs?.isLeader) {
      this.tabs.post({ t: 'status', status: next });
    }
  }

  private fail(e: SyncraErrorInfo): void {
    this.o.logger?.warn?.(`[syncra] ${e.code}: ${e.message}`);
    this.setStatus({ error: e });
    this.events.emit('error', e);
  }

  private async init(): Promise<void> {
    this.store = this.o.store ?? (await this.openStore());
    this.clientId = (await this.store.getMeta<string>('clientId')) ?? crypto.randomUUID();
    await this.store.setMeta('clientId', this.clientId);

    this.engine = new SyncEngine({
      url: toWs(this.o.url),
      clientId: this.clientId,
      store: this.store,
      tokens: this.tokens,
      transport: this.o.transport ?? webSocketTransport,
      network: this.network,
      nextOpId: () => this.nextOpId(),
      quotaRetryMs: this.o.quotaRetryMs,
      onState: (connection: ConnectionState) => {
        if (connection === 'live') this.rememberIdentity();
        this.setStatus({ connection, error: connection === 'live' ? null : this._status.error });
      },
      onPending: (pendingOps, lastSyncedAt) => {
        this.setStatus({ pendingOps, lastSyncedAt });
        this.tabs?.post({ t: 'outbox' }); // followers recount their pending badge
      },
      onError: (e) => {
        this.fail(e);
      },
      onQuota: (metric) => {
        this.events.emit('quota-blocked', { metric });
      },
      onQueuePressure: (info) => {
        this.events.emit('queue-pressure', info);
      },
      onDocSynced: (doc) => {
        this.events.emit('doc:synced', { collection: doc.collection, id: doc.id });
      },
      onAwareness: () => undefined,
    });

    const env = this.o.tabEnv === undefined ? this.tryBrowserTabEnv() : this.o.tabEnv;
    if (env) {
      const { tenantId, userId } = this.identity() ?? {
        tenantId: this.o.publishableKey,
        userId: '',
      };
      this.tabs = new TabCoordinator(`${tenantId}:${userId}`, env, {
        onLeaderChange: (isLeader) => {
          this.onLeaderChange(isLeader);
        },
        onMessage: (m) => {
          this.onTabMessage(m);
        },
      });
      this.tabs.start();
    } else {
      this.onLeaderChange(true);
    }
    void this.pullPending();
    void this.adoptUnsent();
  }

  private get leaderEngine(): SyncEngine | undefined {
    return (this.tabs?.isLeader ?? true) ? this.engine : undefined;
  }

  private tryBrowserTabEnv(): TabEnv | null {
    try {
      return typeof BroadcastChannel === 'undefined' ? null : browserTabEnv();
    } catch {
      return null;
    }
  }

  private identity(): { tenantId: string; userId: string } | undefined {
    return this.o.identity ?? readIdentity(this.o.publishableKey);
  }

  private async openStore(): Promise<LocalStore> {
    if (this.o.storage === 'memory' || typeof indexedDB === 'undefined') return new MemoryStore();
    const id = this.identity();
    if (!id) return IdbStore.open(`syncra:pending:${this.o.publishableKey}`);
    const main = await IdbStore.open(`syncra:${id.tenantId}:${id.userId}`);
    const pending = await IdbStore.open(`syncra:pending:${this.o.publishableKey}`);
    if ((await pending.listDocs()).length > 0) {
      await copyStore(pending, main);
    }
    await pending.destroy();
    return main;
  }

  /** Remembers who this device belongs to so the next cold start opens the right database. */
  private rememberIdentity(): void {
    const { tid, sub } = this.tokens.claims();
    if (!tid || !sub) return;
    try {
      globalThis.localStorage?.setItem(
        `syncra:identity:${this.o.publishableKey}`,
        JSON.stringify({ tenantId: tid, userId: sub }),
      );
    } catch {
      // private mode: the pending database is used again next time
    }
  }

  private onLeaderChange(isLeader: boolean): void {
    this.setStatus({ isLeader }, true);
    this.events.emit('leader-change', { isLeader });
    if (isLeader) {
      for (const d of this.docs.values()) this.engine?.attach(d);
      this.tabs?.post({ t: 'announce' });
      if (this.connectWanted || this.docs.size > 0) this.engine?.connect();
    } else {
      this.engine?.disconnect();
    }
  }

  private onTabMessage(m: TabMessage): void {
    switch (m.t) {
      case 'update':
        this.docs.get(m.docKey)?.applyFromTab(m.update);
        return;
      case 'sv': {
        // A sibling just loaded this document: send whatever it is missing (catch-up for late tabs).
        const d = this.docs.get(m.docKey);
        if (!d) return;
        const update = Y.encodeStateAsUpdate(d.ydoc, m.sv);
        if (update.length > 2) this.tabs?.post({ t: 'update', docKey: m.docKey, update });
        return;
      }
      case 'aw':
        this.docs.get(m.docKey)?.applyAwareness(m.update, 'tab');
        if (this.tabs?.isLeader) this.engine?.sendAwareness(m.docKey, m.update);
        return;
      case 'open':
        if (!this.tabs?.isLeader) return;
        this.noteRemoteOpen(m.docKey, m.from);
        return;
      case 'close': {
        const set = this.remoteOpen.get(m.docKey);
        set?.delete(m.from);
        if (set?.size === 0) this.remoteOpen.delete(m.docKey);
        return;
      }
      case 'announce':
        for (const k of this.docs.keys()) this.tabs?.post({ t: 'open', docKey: k });
        return;
      case 'outbox':
        void this.pullPending();
        if (this.tabs?.isLeader) this.engine?.requestDrain();
        return;
      case 'status':
        if (!this.tabs?.isLeader) {
          this.setStatus(
            {
              connection: m.status.connection,
              lastSyncedAt: m.status.lastSyncedAt,
              error: m.status.error,
              online: m.status.online,
            },
            true,
          );
        }
    }
  }

  /** The leader opens (and syncs) documents that only a follower tab has open. */
  private noteRemoteOpen(docKey: string, from: string): void {
    const set = this.remoteOpen.get(docKey) ?? new Set<string>();
    set.add(from);
    this.remoteOpen.set(docKey, set);
    if (!this.docs.has(docKey)) {
      const i = docKey.indexOf('/');
      const d = this.doc(docKey.slice(0, i), docKey.slice(i + 1));
      d.refs = 1; // held for the follower; released when no tab wants it
    }
  }

  /**
   * After a restart, documents that still have unsent edits are opened so the engine syncs them even when
   * the UI never shows them again (e.g. a reload on a different screen).
   * shortcut: held until destroy(); fine for the handful of documents with pending edits, release them
   * as their outbox entries drain if that count ever gets large.
   */
  private async adoptUnsent(): Promise<void> {
    const keys = new Set((await this.store.outbox()).map((e) => e.docKey));
    for (const key of keys) {
      if (this.destroyed || this.docs.has(key)) continue;
      const i = key.indexOf('/');
      this.doc(key.slice(0, i), key.slice(i + 1));
    }
  }

  private async pullPending(): Promise<void> {
    const n = await this.store.outboxCount();
    this.setStatus({ pendingOps: n }, true);
  }

  nextOpId(): string {
    return `${this.clientId}:${this.tabSuffix}:${String(this.counter++)}`;
  }

  schemaFor(collection: string): SchemaLike | undefined {
    return this.o.schemas?.[collection];
  }

  private host(collection: string): DocHost {
    const getStore = (): LocalStore => this.store;
    return {
      get store() {
        return getStore();
      },
      batchMs: this.o.batchMs ?? 50,
      nextOpId: () => this.nextOpId(),
      publishUpdate: (docKey, update) => this.tabs?.post({ t: 'update', docKey, update }),
      publishAwareness: (docKey, update) => {
        this.tabs?.post({ t: 'aw', docKey, update });
        this.leaderEngine?.sendAwareness(docKey, update);
      },
      onLocalPersisted: () => {
        this.tabs?.post({ t: 'outbox' });
        void this.pullPending();
        this.leaderEngine?.requestDrain();
      },
      onStorageError: (docKey, state, err) => {
        this.fail(err);
        this.leaderEngine?.sendVolatile(docKey, state);
      },
      release: (d) => {
        void this.release(d);
      },
      schema: this.o.schemas?.[collection],
    };
  }

  doc(collection: string, id: string): SyncraDoc {
    const key = `${collection}/${id}`;
    const existing = this.docs.get(key);
    if (existing) {
      existing.refs++;
      return existing;
    }
    // The store opens asynchronously; the doc's host proxies to it once ready.
    const doc = new SyncraDoc(collection, id, this.host(collection), this.ready);
    this.docs.set(key, doc);
    void this.ready.then(() => {
      if (this.destroyed || this.docs.get(key) !== doc) return;
      this.tabs?.post({ t: 'open', docKey: key });
      void doc.whenLoaded().then(() => {
        this.tabs?.post({ t: 'sv', docKey: key, sv: Y.encodeStateVector(doc.ydoc) });
      });
      if (this.tabs?.isLeader ?? true) {
        this.engine?.attach(doc);
        this.engine?.connect();
      }
    });
    return doc;
  }

  private async release(doc: SyncraDoc): Promise<void> {
    if (--doc.refs > 0) return;
    this.docs.delete(doc.docKey);
    this.engine?.detach(doc.docKey);
    this.tabs?.post({ t: 'close', docKey: doc.docKey });
    await doc.destroy();
  }

  collection<T = Record<string, unknown>>(name: string): SyncraCollection<T> {
    let c = this.collections.get(name);
    if (!c) {
      c = new SyncraCollection(name, this);
      this.collections.set(name, c);
    }
    return c;
  }

  connect(): void {
    this.connectWanted = true;
    void this.ready.then(() => {
      if (this.tabs?.isLeader ?? true) this.engine?.connect();
    });
  }

  disconnect(): void {
    this.connectWanted = false;
    void this.ready.then(() => {
      this.engine?.disconnect();
    });
  }

  simulateOffline(on: boolean): void {
    this.network.setForcedOffline(on);
  }

  dropConnection(): void {
    void this.ready.then(() => {
      this.engine?.dropSocket();
    });
  }

  async clearLocalData(): Promise<void> {
    await this.ready;
    this.engine?.disconnect();
    for (const d of this.docs.values()) await d.destroy();
    this.docs.clear();
    this.collections.clear();
    await this.store.destroy();
    try {
      globalThis.localStorage?.removeItem(`syncra:identity:${this.o.publishableKey}`);
    } catch {
      // ignore
    }
    this.destroyed = true;
    this.tabs?.stop();
    this.network.stop();
  }

  async destroy(): Promise<void> {
    await this.ready;
    this.destroyed = true;
    this.engine?.disconnect();
    for (const d of this.docs.values()) await d.destroy();
    this.docs.clear();
    this.tabs?.stop();
    this.network.stop();
    this.store.close();
  }
}
