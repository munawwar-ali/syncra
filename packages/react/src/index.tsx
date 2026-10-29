/**
 * React bindings (Doc 04 §4). Every hook reads through useSyncExternalStore with a cached snapshot,
 * so components re-render only when the value they use actually changed.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type * as Y from 'yjs';
import type {
  CollectionEntry,
  DocSyncState,
  PresenceState,
  SyncStatus,
  SyncraClient,
  SyncraDoc,
} from '@syncra/client';

const ClientContext = createContext<SyncraClient | null>(null);

export function SyncraProvider(props: { client: SyncraClient; children?: ReactNode }) {
  return <ClientContext.Provider value={props.client}>{props.children}</ClientContext.Provider>;
}

export function useSyncraClient(): SyncraClient {
  const c = useContext(ClientContext);
  if (!c) throw new Error('useSyncraClient must be used inside <SyncraProvider>');
  return c;
}

/** Live sync status: connection, pending ops, last synced time, errors. */
export function useSyncStatus(): SyncStatus {
  const client = useSyncraClient();
  return useSyncExternalStore(
    (cb) => client.subscribe(cb),
    () => client.status,
    () => client.status,
  );
}

export function useOnlineStatus(): boolean {
  return useSyncStatus().online;
}

/** Opens a document for the lifetime of the component. `doc` is null on the first render only. */
export function useDoc(
  collection: string,
  id: string,
): { doc: SyncraDoc | null; state: DocSyncState } {
  const client = useSyncraClient();
  const [doc, setDoc] = useState<SyncraDoc | null>(null);
  useEffect(() => {
    const d = client.doc(collection, id);
    setDoc(d);
    return () => {
      setDoc(null);
      d.close();
    };
  }, [client, collection, id]);
  const state = useSyncExternalStore(
    (cb) => (doc ? doc.onState(cb) : () => undefined),
    () => doc?.state ?? 'loading',
    () => 'loading',
  );
  return { doc, state };
}

/**
 * Subscribes to a value derived from a Yjs type. `read` runs only when the document changes and the
 * previous snapshot is reused when the result is shallow-equal, which keeps renders minimal.
 */
function useYValue<T>(
  doc: SyncraDoc | null,
  attach: (doc: SyncraDoc, onChange: () => void) => () => void,
  read: (doc: SyncraDoc) => T,
  empty: T,
): T {
  const latest = useRef({ attach, read });
  latest.current = { attach, read };
  const cache = useRef<{ doc: SyncraDoc | null; value: T }>({ doc: null, value: empty });
  if (cache.current.doc !== doc) cache.current = { doc, value: doc ? read(doc) : empty };
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!doc) return () => undefined;
      return latest.current.attach(doc, () => {
        const next = latest.current.read(doc);
        if (!shallowEqual(cache.current.value, next)) {
          cache.current = { doc, value: next };
          cb();
        }
      });
    },
    [doc],
  );
  return useSyncExternalStore(
    subscribe,
    () => cache.current.value,
    () => empty,
  );
}

export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) =>
    Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

const EMPTY_OBJ = Object.freeze({}) as Record<string, unknown>;

/** The root Y.Map as plain JSON, optionally narrowed by `selector` to limit re-renders. */
export function useYMap<T = Record<string, unknown>>(
  doc: SyncraDoc | null,
  name = 'data',
  selector?: (json: Record<string, unknown>) => T,
): T {
  return useYValue<T>(
    doc,
    (d, cb) => {
      const m: Y.Map<unknown> = d.map(name);
      m.observeDeep(cb);
      return () => {
        m.unobserveDeep(cb);
      };
    },
    (d) => {
      const json = d.map(name).toJSON() as Record<string, unknown>;
      return selector ? selector(json) : (json as T);
    },
    (selector ? selector(EMPTY_OBJ) : EMPTY_OBJ) as T,
  );
}

/** The root Y.Text as a string. */
export function useYText(doc: SyncraDoc | null, name = 'text'): string {
  return useYValue<string>(
    doc,
    (d, cb) => {
      const t = d.text(name);
      t.observe(cb);
      return () => {
        t.unobserve(cb);
      };
    },
    (d) => d.text(name).toJSON(),
    '',
  );
}

export interface PresenceUser {
  /** Yjs awareness client id; stable for the life of a connection. */
  id: number;
  state: PresenceState;
}

const PRESENCE_NOTIFY_MS = 100; // at most 10 notifications per second

/** Other participants. Unchanged users keep the same object between renders. */
export function usePresence(doc: SyncraDoc | null): PresenceUser[] {
  const [users, setUsers] = useState<PresenceUser[]>([]);
  useEffect(() => {
    if (!doc) {
      setUsers([]);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const compute = (): void => {
      timer = undefined;
      setUsers((prev) => {
        const next: PresenceUser[] = [];
        for (const [id, state] of doc.presence.others()) {
          const old = prev.find((u) => u.id === id);
          next.push(
            old && JSON.stringify(old.state) === JSON.stringify(state) ? old : { id, state },
          );
        }
        const same = next.length === prev.length && next.every((u, i) => u === prev[i]);
        return same ? prev : next;
      });
    };
    const off = doc.presence.onChange(() => {
      timer ??= setTimeout(compute, PRESENCE_NOTIFY_MS);
    });
    compute();
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [doc]);
  return users;
}

export function usePresenceSetter(doc: SyncraDoc | null): {
  setPresence: (partial: PresenceState) => void;
} {
  const setPresence = useCallback((partial: PresenceState) => doc?.presence.set(partial), [doc]);
  return { setPresence };
}

/** Entries of a collection from the local index; reactive and available offline. */
export function useCollection(name: string): CollectionEntry[] {
  const client = useSyncraClient();
  const col = client.collection(name);
  const cache = useRef<{ name: string; list: CollectionEntry[] } | null>(null);
  if (cache.current?.name !== name) cache.current = { name, list: col.list() };
  const subscribe = useCallback(
    (cb: () => void) =>
      col.subscribe(() => {
        const next = col.list();
        if (JSON.stringify(next) !== JSON.stringify(cache.current?.list)) {
          cache.current = { name, list: next };
          cb();
        }
      }),
    [col, name],
  );
  return useSyncExternalStore(
    subscribe,
    () => (cache.current as { list: CollectionEntry[] }).list,
    () => [],
  );
}
