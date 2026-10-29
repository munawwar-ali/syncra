/** Collections via index documents (Doc 04 §3.4): `__index/{collection}` holds a Y.Map `entries`. */
import * as Y from 'yjs';
import type { SyncraDoc } from './doc.js';

export interface CollectionEntry {
  id: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  deleted?: boolean;
}

export interface DocOpener {
  doc(collection: string, id: string): SyncraDoc;
  schemaFor(
    collection: string,
  ): { safeParse(v: unknown): { success: boolean; error?: { message: string } } } | undefined;
}

export const INDEX_COLLECTION = '__index';

export class SyncraCollection<T = Record<string, unknown>> {
  private readonly index: SyncraDoc;

  constructor(
    readonly name: string,
    private readonly client: DocOpener,
  ) {
    this.index = client.doc(INDEX_COLLECTION, name);
  }

  private entries(): Y.Map<Y.Map<unknown>> {
    return this.index.ydoc.getMap<Y.Map<unknown>>('entries');
  }

  /** Non-deleted entries, oldest first. Works offline from the local index. */
  list(): CollectionEntry[] {
    const out: CollectionEntry[] = [];
    this.entries().forEach((m, id) => {
      const e = m.toJSON() as Omit<CollectionEntry, 'id'>;
      if (!e.deleted) out.push({ id, ...e });
    });
    return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  subscribe(cb: () => void): () => void {
    return this.index.onChange(cb);
  }

  whenLoaded(): Promise<void> {
    return this.index.whenLoaded();
  }

  /** Creates a document locally first; `initial` is validated against the collection schema. */
  create(id: string = crypto.randomUUID(), initial?: Partial<T>): SyncraDoc {
    const schema = this.client.schemaFor(this.name);
    if (schema && initial) {
      const r = schema.safeParse(initial);
      if (!r.success) throw new Error(r.error?.message ?? 'Schema validation failed');
    }
    const doc = this.client.doc(this.name, id);
    const now = Date.now();
    this.index.ydoc.transact(() => {
      const e = new Y.Map<unknown>();
      e.set('createdAt', now);
      e.set('updatedAt', now);
      this.entries().set(id, e);
    });
    if (initial) doc.setFields(initial);
    return doc;
  }

  /** Marks the document removed in the index; the server soft-deletes it when it syncs. */
  remove(id: string): void {
    this.patch(id, { deleted: true, updatedAt: Date.now() });
  }

  setTitle(id: string, title: string): void {
    this.patch(id, { title, updatedAt: Date.now() });
  }

  open(id: string): SyncraDoc {
    return this.client.doc(this.name, id);
  }

  private patch(id: string, fields: Record<string, unknown>): void {
    const e = this.entries().get(id);
    if (!e) return;
    this.index.ydoc.transact(() => {
      for (const [k, v] of Object.entries(fields)) e.set(k, v);
    });
  }
}
