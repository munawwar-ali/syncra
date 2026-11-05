# SDK guide

`@syncra/client` is framework-free. `@syncra/react` adds hooks. Both are ESM and TypeScript-first.

## Create a client

```ts
const client = createClient({
  url: 'https://sync.example.com',
  publishableKey: 'pk_live_...',
  getToken: async () => (await fetch('/api/syncra-token')).json().then((j) => j.token),
  // optional
  storage: 'indexeddb', // or 'memory' for tests
  schemas: { todos: todoSchema }, // anything with safeParse(), e.g. a Zod schema
});
```

`getToken` is called on connect and again before the token expires. Return a token minted by your backend (`POST /v1/tokens`). One client per signed-in user; call `client.clearLocalData()` on logout to remove that user's offline copy.

## Documents

```ts
const doc = client.doc('notes', 'welcome');
await doc.whenLoaded(); // local data is available (works offline)
await doc.whenSynced(); // resolves after the first sync with the server

doc.setFields({ title: 'Hello' }); // root Y.Map named "data"
doc.text().insert(0, 'hi'); // root Y.Text named "text"
doc.close(); // release when you are done
```

`doc.ydoc` is the underlying `Y.Doc`, so any Yjs binding works (Tiptap, ProseMirror, CodeMirror, Monaco). Every local change is saved to IndexedDB before it is offered to the network.

## Collections

A collection lists documents using an index document, so lists work offline too.

```ts
const notes = client.collection('notes');
const doc = notes.create(); // new id, created locally first
notes.setTitle(doc.id, 'Meeting');
notes.list(); // [{ id, title, createdAt, updatedAt }]
notes.remove(doc.id);
```

Collection and document ids must match the patterns in `@syncra/shared` (`COLLECTION_REGEX`, `DOC_ID_REGEX`). Names starting with `__` are reserved.

## Sync status

```ts
client.subscribe((s) => console.log(s.connection, s.pendingOps, s.lastSyncedAt));
```

| `connection`                              | Meaning                                                       |
| ----------------------------------------- | ------------------------------------------------------------- |
| `live`                                    | Connected and up to date                                      |
| `connecting`, `authenticating`, `syncing` | Getting connected or catching up                              |
| `offline`                                 | No network; edits are saved on the device                     |
| `backoff`                                 | Waiting before the next retry (exponential, with full jitter) |
| `quota-blocked`                           | The plan limit was reached; edits are kept and retried        |
| `auth-expired`                            | The token could not be refreshed; sign in again               |
| `error`, `idle`                           | Failure or not started                                        |

## React

| Hook                                          | Returns                                               |
| --------------------------------------------- | ----------------------------------------------------- |
| `useSyncStatus()`                             | The status object above                               |
| `useDoc(collection, id)`                      | `{ doc, state }`, closes the document on unmount      |
| `useYMap(doc, name?, selector?)`              | The root map as JSON; a selector limits re-renders    |
| `useYText(doc, name?)`                        | The root text as a string                             |
| `useCollection(name)`                         | Entries of a collection, reactive and offline-capable |
| `usePresence(doc)` / `usePresenceSetter(doc)` | Other users' cursors and your own presence            |

## Presence

```ts
doc.presence.set({ name: 'Ada', color: '#7c3aed' }); // throttled before sending
```

## Multiple tabs

Tabs of the same user share one connection through a leader (Web Locks, with a BroadcastChannel and localStorage fallback). Closing the leader tab hands over to another tab without losing edits.

## Guarantees and limits

- Delivery is at-least-once, and operations are idempotent, so duplicates are harmless.
- Concurrent edits to text and arrays merge. Concurrent writes to the same map key resolve to one value (last writer by Yjs rules); the other value is discarded.
- On restart, documents that still have unsent edits are re-opened automatically so they sync even if your UI does not show them.
- Local storage can fill up: the client reports a `StorageFullError` and keeps the in-memory copy.
- There are no queries or server-side validation of document contents, and no end-to-end encryption.
