/**
 * Copies everything from a "pending" store (created before the user's identity was known) into
 * the identity-scoped store, so offline edits from a first-ever session are not stranded.
 */
import type { LocalStore } from './store.js';

/** Returns the number of documents copied. The source is left untouched; the caller destroys it. */
export async function copyStore(from: LocalStore, to: LocalStore): Promise<number> {
  const docs = await from.listDocs();
  const outbox = await from.outbox();
  for (const rec of docs) {
    const local = await from.load(rec.docKey);
    if (local.snapshot) await to.compact(rec.docKey, local.snapshot, 0);
    for (const u of local.updates) await to.appendRemote(rec.docKey, u);
    await to.putDoc(rec);
  }
  for (const e of outbox) await to.appendLocal(e.docKey, e.update, e.opId);
  return docs.length;
}
