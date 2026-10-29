/** Local persistence contract (Doc 04 §6). Implemented by IndexedDB and in-memory stores. */

export interface DocRecord {
  docKey: string;
  collection: string;
  docId: string;
  serverSeq: number;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
}

export interface OutboxEntry {
  opId: string;
  docKey: string;
  update: Uint8Array;
  createdAt: number;
  attempts: number;
  state: 'pending' | 'sent';
}

export interface LoadedLocal {
  snapshot: Uint8Array | null;
  updates: Uint8Array[];
  /** Id of the last update row read (0 when none); compaction deletes rows up to this id. */
  lastUpdateId: number;
  updateBytes: number;
}

/** Thrown when the browser refuses a write for lack of space (CLI-11). */
export class StorageFullError extends Error {
  readonly code = 'storage-full';
  constructor() {
    super('Local storage is full');
    this.name = 'StorageFullError';
  }
}

export interface LocalStore {
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
  load(docKey: string): Promise<LoadedLocal>;
  /** Appends to the update log AND the outbox in one transaction; returns the update row id. */
  appendLocal(docKey: string, update: Uint8Array, opId: string): Promise<number>;
  /** Appends a server-originated update to the update log only; returns the row id. */
  appendRemote(docKey: string, update: Uint8Array): Promise<number>;
  /** Replaces the log up to `upToUpdateId` with a snapshot. Never touches the outbox. */
  compact(docKey: string, state: Uint8Array, upToUpdateId: number): Promise<void>;
  outbox(docKey?: string): Promise<OutboxEntry[]>;
  outboxCount(): Promise<number>;
  markSent(opIds: string[]): Promise<void>;
  requeueSent(): Promise<void>;
  ack(opId: string): Promise<void>;
  /** Atomically swaps several outbox entries for one merged entry (queue-pressure coalescing). */
  replaceOutbox(remove: string[], entry: OutboxEntry): Promise<void>;
  putDoc(rec: DocRecord): Promise<void>;
  listDocs(): Promise<DocRecord[]>;
  /** Deletes all local data for this store (logout flow). */
  destroy(): Promise<void>;
  close(): void;
}
