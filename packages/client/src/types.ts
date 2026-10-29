/** Public types of the client SDK (Doc 04 §3). */

export type ConnectionState =
  | 'idle'
  | 'offline'
  | 'connecting'
  | 'authenticating'
  | 'syncing'
  | 'live'
  | 'backoff'
  | 'auth-expired'
  | 'quota-blocked'
  | 'error';

export type DocSyncState = 'loading' | 'local-only' | 'syncing' | 'synced' | 'blocked';

export interface SyncraErrorInfo {
  code: string;
  message: string;
}

export interface SyncStatus {
  connection: ConnectionState;
  /** navigator.onLine combined with the last probe result. */
  online: boolean;
  /** Outbox size across documents. */
  pendingOps: number;
  /** Epoch ms of the last moment the outbox was fully acknowledged while live. */
  lastSyncedAt: number | null;
  /** True when this tab owns the socket. */
  isLeader: boolean;
  error: SyncraErrorInfo | null;
}

export interface ClientEvents {
  status: (s: SyncStatus) => void;
  error: (e: SyncraErrorInfo) => void;
  'doc:synced': (doc: { collection: string; id: string }) => void;
  'queue-pressure': (info: { pendingOps: number; pendingBytes: number }) => void;
  'quota-blocked': (info: { metric: string }) => void;
  'leader-change': (info: { isLeader: boolean }) => void;
}

/** Tiny typed event emitter. */
export class Emitter<E extends { [K in keyof E]: (...a: never[]) => void }> {
  private readonly handlers = new Map<keyof E, Set<(...a: never[]) => void>>();

  on<K extends keyof E>(event: K, cb: E[K]): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(cb);
    this.handlers.set(event, set);
    return () => {
      set.delete(cb);
    };
  }

  emit<K extends keyof E>(event: K, ...args: Parameters<E[K]>): void {
    for (const cb of this.handlers.get(event) ?? []) {
      (cb as (...a: Parameters<E[K]>) => void)(...args);
    }
  }
}
