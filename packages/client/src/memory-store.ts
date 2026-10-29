/** In-memory LocalStore: tests, SSR and `storage: 'memory'`. */
import type { DocRecord, LoadedLocal, LocalStore, OutboxEntry } from './store.js';

interface Row {
  id: number;
  docKey: string;
  update: Uint8Array;
}

export class MemoryStore implements LocalStore {
  private meta = new Map<string, unknown>();
  private rows: Row[] = [];
  private snapshots = new Map<string, Uint8Array>();
  private box = new Map<string, OutboxEntry>();
  private docs = new Map<string, DocRecord>();
  private nextId = 1;

  getMeta<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.meta.get(key) as T | undefined);
  }

  setMeta(key: string, value: unknown): Promise<void> {
    this.meta.set(key, value);
    return Promise.resolve();
  }

  load(docKey: string): Promise<LoadedLocal> {
    const mine = this.rows.filter((r) => r.docKey === docKey);
    return Promise.resolve({
      snapshot: this.snapshots.get(docKey) ?? null,
      updates: mine.map((r) => r.update),
      lastUpdateId: mine.at(-1)?.id ?? 0,
      updateBytes: mine.reduce((n, r) => n + r.update.length, 0),
    });
  }

  appendRemote(docKey: string, update: Uint8Array): Promise<number> {
    const id = this.nextId++;
    this.rows.push({ id, docKey, update });
    return Promise.resolve(id);
  }

  async appendLocal(docKey: string, update: Uint8Array, opId: string): Promise<number> {
    const id = await this.appendRemote(docKey, update);
    this.box.set(opId, {
      opId,
      docKey,
      update,
      createdAt: Date.now(),
      attempts: 0,
      state: 'pending',
    });
    return id;
  }

  compact(docKey: string, state: Uint8Array, upToUpdateId: number): Promise<void> {
    this.snapshots.set(docKey, state);
    this.rows = this.rows.filter((r) => r.docKey !== docKey || r.id > upToUpdateId);
    return Promise.resolve();
  }

  outbox(docKey?: string): Promise<OutboxEntry[]> {
    const all = [...this.box.values()];
    return Promise.resolve(docKey ? all.filter((e) => e.docKey === docKey) : all);
  }

  outboxCount(): Promise<number> {
    return Promise.resolve(this.box.size);
  }

  markSent(opIds: string[]): Promise<void> {
    for (const id of opIds) {
      const e = this.box.get(id);
      if (e) this.box.set(id, { ...e, state: 'sent', attempts: e.attempts + 1 });
    }
    return Promise.resolve();
  }

  requeueSent(): Promise<void> {
    for (const [id, e] of this.box) this.box.set(id, { ...e, state: 'pending' });
    return Promise.resolve();
  }

  ack(opId: string): Promise<void> {
    this.box.delete(opId);
    return Promise.resolve();
  }

  replaceOutbox(remove: string[], entry: OutboxEntry): Promise<void> {
    for (const id of remove) this.box.delete(id);
    this.box.set(entry.opId, entry);
    return Promise.resolve();
  }

  putDoc(rec: DocRecord): Promise<void> {
    this.docs.set(rec.docKey, rec);
    return Promise.resolve();
  }

  listDocs(): Promise<DocRecord[]> {
    return Promise.resolve([...this.docs.values()]);
  }

  destroy(): Promise<void> {
    this.meta = new Map();
    this.rows = [];
    this.snapshots = new Map();
    this.box = new Map();
    this.docs = new Map();
    return Promise.resolve();
  }

  close(): void {
    // nothing to release
  }
}
