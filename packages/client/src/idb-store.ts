/** IndexedDB LocalStore (Doc 04 §6), schema version 1. */
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  StorageFullError,
  type DocRecord,
  type LoadedLocal,
  type LocalStore,
  type OutboxEntry,
} from './store.js';

interface Schema extends DBSchema {
  meta: { key: string; value: unknown };
  docs: { key: string; value: DocRecord };
  snapshots: { key: string; value: { docKey: string; state: Uint8Array } };
  updates: {
    key: number;
    value: { id?: number; docKey: string; update: Uint8Array; ts: number };
    indexes: { byDoc: string };
  };
  outbox: { key: string; value: OutboxEntry; indexes: { byDoc: string } };
}

/** Upgrade handlers keyed by target version; add a new case per schema change. */
export function upgradeSchema(db: IDBPDatabase<Schema>, oldVersion: number): void {
  if (oldVersion < 1) {
    db.createObjectStore('meta');
    db.createObjectStore('docs', { keyPath: 'docKey' });
    db.createObjectStore('snapshots', { keyPath: 'docKey' });
    db.createObjectStore('updates', { keyPath: 'id', autoIncrement: true }).createIndex(
      'byDoc',
      'docKey',
    );
    db.createObjectStore('outbox', { keyPath: 'opId' }).createIndex('byDoc', 'docKey');
  }
}

async function guard<T>(op: Promise<T>): Promise<T> {
  try {
    return await op;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'QuotaExceededError') throw new StorageFullError();
    throw e;
  }
}

export class IdbStore implements LocalStore {
  private constructor(
    private readonly db: IDBPDatabase<Schema>,
    private readonly name: string,
  ) {}

  static async open(name: string): Promise<IdbStore> {
    const db = await openDB<Schema>(name, 1, {
      upgrade(d, oldVersion) {
        upgradeSchema(d, oldVersion);
      },
    });
    return new IdbStore(db, name);
  }

  getMeta<T>(key: string): Promise<T | undefined> {
    return this.db.get('meta', key) as Promise<T | undefined>;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await guard(this.db.put('meta', value, key));
  }

  async load(docKey: string): Promise<LoadedLocal> {
    const tx = this.db.transaction(['snapshots', 'updates'], 'readonly');
    const snap = await tx.objectStore('snapshots').get(docKey);
    const rows = await tx.objectStore('updates').index('byDoc').getAll(docKey);
    await tx.done;
    return {
      snapshot: snap?.state ?? null,
      updates: rows.map((r) => r.update),
      lastUpdateId: rows.at(-1)?.id ?? 0,
      updateBytes: rows.reduce((n, r) => n + r.update.length, 0),
    };
  }

  appendRemote(docKey: string, update: Uint8Array): Promise<number> {
    return guard(this.db.add('updates', { docKey, update, ts: Date.now() }));
  }

  appendLocal(docKey: string, update: Uint8Array, opId: string): Promise<number> {
    return guard(
      (async () => {
        const tx = this.db.transaction(['updates', 'outbox'], 'readwrite');
        const id = await tx.objectStore('updates').add({ docKey, update, ts: Date.now() });
        await tx
          .objectStore('outbox')
          .put({ opId, docKey, update, createdAt: Date.now(), attempts: 0, state: 'pending' });
        await tx.done;
        return id;
      })(),
    );
  }

  compact(docKey: string, state: Uint8Array, upToUpdateId: number): Promise<void> {
    return guard(
      (async () => {
        const tx = this.db.transaction(['snapshots', 'updates'], 'readwrite');
        await tx.objectStore('snapshots').put({ docKey, state });
        const idx = tx.objectStore('updates').index('byDoc');
        for (let c = await idx.openKeyCursor(docKey); c; c = await c.continue()) {
          if (c.primaryKey <= upToUpdateId) await tx.objectStore('updates').delete(c.primaryKey);
        }
        await tx.done;
      })(),
    );
  }

  async outbox(docKey?: string): Promise<OutboxEntry[]> {
    const rows = docKey
      ? await this.db.getAllFromIndex('outbox', 'byDoc', docKey)
      : await this.db.getAll('outbox');
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }

  outboxCount(): Promise<number> {
    return this.db.count('outbox');
  }

  async markSent(opIds: string[]): Promise<void> {
    const tx = this.db.transaction('outbox', 'readwrite');
    for (const id of opIds) {
      const e = await tx.store.get(id);
      if (e) await tx.store.put({ ...e, state: 'sent', attempts: e.attempts + 1 });
    }
    await tx.done;
  }

  async requeueSent(): Promise<void> {
    const tx = this.db.transaction('outbox', 'readwrite');
    for (let c = await tx.store.openCursor(); c; c = await c.continue()) {
      if (c.value.state === 'sent') await c.update({ ...c.value, state: 'pending' });
    }
    await tx.done;
  }

  async ack(opId: string): Promise<void> {
    await this.db.delete('outbox', opId);
  }

  async replaceOutbox(remove: string[], entry: OutboxEntry): Promise<void> {
    const tx = this.db.transaction('outbox', 'readwrite');
    for (const id of remove) await tx.store.delete(id);
    await tx.store.put(entry);
    await tx.done;
  }

  async putDoc(rec: DocRecord): Promise<void> {
    await guard(this.db.put('docs', rec));
  }

  listDocs(): Promise<DocRecord[]> {
    return this.db.getAll('docs');
  }

  async destroy(): Promise<void> {
    this.db.close();
    await deleteDB(this.name);
  }

  close(): void {
    this.db.close();
  }
}
