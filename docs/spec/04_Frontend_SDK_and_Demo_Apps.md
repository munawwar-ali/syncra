# Syncra - Frontend, SDK and Demo Apps
Document 04 of 06 | Client runtime, dashboard, demos | Version 1.0 | 26 Oct 2026

## 1. Frontend system design overview

The frontend work in Syncra is mostly the client SDK, a local-first runtime that lives in the browser. The dashboard and demo apps consume it. The concepts demonstrated:

| Frontend system design concept | Where it lives |
|---|---|
| Local-first architecture (UI never awaits network) | SDK: Y.Doc plus IndexedDB |
| Persistent write-ahead outbox, durability before send | SDK outbox |
| Optimistic UI and reconciliation | Every local edit is applied immediately; ACK only updates status |
| Sync state machine with explicit states and events | SDK `ConnectionManager` |
| Exponential backoff with jitter, retry budgets | SDK reconnect logic |
| Multi-tab coordination (leader election, BroadcastChannel) | SDK `TabCoordinator` |
| Delta sync with state vectors | SDK sync handshake |
| Binary protocol encoding | `@syncra/protocol` |
| Batching and coalescing | SDK update batcher |
| Storage design, versioned schema migrations in IndexedDB | SDK `LocalStore` |
| Storage quota and eviction handling | SDK error path |
| Offline detection (events plus active probing) | SDK `NetworkMonitor` |
| Service worker, app-shell caching, installable PWA | demo-inspection |
| Rendering performance: virtualization, memoization, throttled presence | Demo apps and `usePresence` |
| Subscription-based state exposure to React (`useSyncExternalStore`) | `@syncra/react` |
| Auth token lifecycle and silent refresh | SDK `TokenManager`, dashboard auth |
| Real-time dashboard with SSE and chart windowing | Dashboard |
| Accessibility and responsive layout | Dashboard and demos |
| Bundle size budgets, tree shaking, code splitting | Build config |

## 2. Package layout

| Package | Responsibility | Depends on |
|---|---|---|
| `@syncra/protocol` | Binary message encode/decode, types, constants (shared by server and client) | lib0 |
| `@syncra/shared` | Zod schemas, error classes, constants, type definitions | zod |
| `@syncra/client` | Framework-agnostic client runtime | protocol, shared, yjs, y-protocols, lib0 |
| `@syncra/react` | React provider and hooks | client, react |
| `@syncra/testkit` | Fake server, network simulator (latency, drop, partition), test clients | client, protocol |

Build output: ESM and CJS, type declarations, sourcemaps; `sideEffects: false`. Budget: `@syncra/client` under 45 KB gzipped excluding Yjs; `@syncra/react` under 5 KB gzipped. CI fails if budgets are exceeded (size-limit).

## 3. Client SDK public API

### 3.1 Creating the client

```ts
import { createClient } from '@syncra/client';

const client = createClient({
  url: 'wss://sync.example.com',         // base URL; SDK derives /v1/connect and REST paths
  publishableKey: 'pk_live_abc123',      // identifies the tenant
  getToken: async () => {                // called before connect, at 80% lifetime, and on 4001/4010
    const res = await fetch('/api/syncra-token', { credentials: 'include' });
    return (await res.json()).token as string;
  },
  storage: 'indexeddb',                  // 'indexeddb' | 'memory'
  batchMs: 50,                           // outgoing batching window
  httpFallback: true,                    // poll over HTTPS when WS is blocked
  pollIntervalMs: 5000,
  schemas: undefined,                    // optional Zod schemas per collection
  logger: console,                       // optional
});
```

### 3.2 Client interface

```ts
interface SyncraClient {
  readonly status: SyncStatus;                           // snapshot
  subscribe(listener: (s: SyncStatus) => void): () => void;   // for React and others
  on<E extends keyof ClientEvents>(e: E, cb: ClientEvents[E]): () => void;
  doc(collection: string, id: string, opts?: DocOptions): SyncraDoc;   // opens or returns cached
  collection<T = unknown>(name: string): SyncraCollection<T>;
  connect(): void;                                       // auto on first doc(); idempotent
  disconnect(): void;                                    // pause sync, keep local data
  simulateOffline(on: boolean): void;                    // for demos and tests
  clearLocalData(): Promise<void>;                       // logout flow
  destroy(): Promise<void>;
}

interface SyncStatus {
  connection: ConnectionState;       // see section 5
  online: boolean;                   // navigator.onLine plus probe
  pendingOps: number;                // outbox size across docs
  lastSyncedAt: number | null;       // epoch ms of last full-ACK
  isLeader: boolean;                 // this tab owns the socket
  error: SyncraErrorInfo | null;
}
```

### 3.3 Documents

```ts
interface SyncraDoc {
  readonly collection: string;
  readonly id: string;
  readonly ydoc: Y.Doc;                       // the real Yjs document
  readonly awareness: Awareness;              // y-protocols awareness (Tiptap compatible)
  readonly state: DocSyncState;               // 'loading' | 'local-only' | 'syncing' | 'synced' | 'blocked'
  whenLoaded(): Promise<void>;                // resolves when local data is loaded (not network)
  whenSynced(): Promise<void>;                // resolves after first successful server sync
  map(name?: string): Y.Map<unknown>;         // default root name 'data'
  text(name?: string): Y.Text;                // default 'text'
  array(name?: string): Y.Array<unknown>;     // default 'list'
  xml(name?: string): Y.XmlFragment;          // default 'content'
  toJSON(): unknown;
  presence: {
    set(partial: Record<string, unknown>): void;   // throttled to 20 per second
    others(): ReadonlyMap<number, PresenceState>;
    onChange(cb: () => void): () => void;
  };
  onChange(cb: (e: DocChangeEvent) => void): () => void;
  close(): void;                              // release; refcounted
}
```

### 3.4 Collections (via index documents)

```ts
interface SyncraCollection<T> {
  list(): CollectionEntry[];                       // from local index; works offline
  subscribe(cb: () => void): () => void;
  create(id?: string, initial?: Partial<T>): SyncraDoc;   // id defaults to UUIDv7; local first
  remove(id: string): void;                        // marks removed in index; server soft deletes on sync
  open(id: string): SyncraDoc;
}
interface CollectionEntry { id: string; createdAt: number; updatedAt: number; title?: string; deleted?: boolean }
```

Collection index: each collection has a reserved document `__index/{collection}` (a Y.Map `entries` keyed by doc id). The SDK updates it when documents are created, removed or titled. Clients with read access to the collection read the index to list documents offline. Server-side creation via REST also updates the index (the worker writes a server-originated update).

### 3.5 Events

```ts
interface ClientEvents {
  status: (s: SyncStatus) => void;
  error: (e: SyncraErrorInfo) => void;
  'doc:synced': (doc: { collection: string; id: string }) => void;
  'queue-pressure': (info: { pendingOps: number; pendingBytes: number }) => void;
  'quota-blocked': (info: { metric: string }) => void;
  'leader-change': (info: { isLeader: boolean }) => void;
}
```

## 4. React API (`@syncra/react`)

```tsx
<SyncraProvider client={client}>...</SyncraProvider>

const status = useSyncStatus();                       // SyncStatus via useSyncExternalStore
const { doc, state } = useDoc('inspections', id);     // opens, refcounts, closes on unmount
const entries = useCollection('inspections');         // CollectionEntry[] (reactive, offline-capable)
const value = useYMap(doc, 'data', selector?);        // re-renders on changes; selector limits renders
const text = useYText(doc, 'text');
const others = usePresence(doc);                      // PresenceState[] (throttled, stable ids)
const { setPresence } = usePresenceSetter(doc);
const online = useOnlineStatus();
```

Rules:
- Hooks use `useSyncExternalStore` with stable snapshots (cache by version counter) to avoid tearing and unnecessary renders.
- `useDoc` is Suspense-optional: returns `state === 'loading'` until local data loads (usually under 30 ms); never blocks on the network.
- `usePresence` throttles notifications to 10 per second and returns referentially stable objects for unchanged users.
- Components never need to call `connect()`; the provider connects when the first document opens.

## 5. Sync state machine

Connection-level states (one per client; owned by the leader tab, mirrored to followers over BroadcastChannel):

| State | Meaning |
|---|---|
| `idle` | No documents open or `disconnect()` called |
| `offline` | Browser offline (events or failed probe). No connection attempts except online probe |
| `connecting` | Opening the WebSocket |
| `authenticating` | Socket open; waiting for first server confirmation (SUBSCRIBED or PONG) |
| `syncing` | Running delta sync handshakes for open documents |
| `live` | All open documents are synced; live updates flow |
| `backoff` | Waiting before the next reconnect attempt |
| `auth-expired` | Token refresh failed; waiting for `getToken()` to succeed (retry every 10 s) |
| `quota-blocked` | Server rejected writes or connection for quota; keep outbox; retry every 60 s |
| `error` | Fatal non-retryable error (forbidden, protocol mismatch); requires app action |

Transition table:

| From | Event | To | Side effects |
|---|---|---|---|
| idle | doc opened or connect() | connecting (or offline if not online) | Start leader election |
| any | browser `offline` event | offline | Close socket; keep outbox |
| offline | browser `online` plus probe OK | connecting | Reset backoff |
| connecting | socket open | authenticating | Start heartbeat |
| connecting | socket error or close | backoff | Increment attempt |
| authenticating | first SUBSCRIBED | syncing | Send SYNC_STEP1 for open docs |
| syncing | all docs synced | live | Drain outbox; set `lastSyncedAt` |
| live | socket close (not 4xxx) | backoff | |
| live | PING timeout | backoff | Close socket |
| live | UPDATE failure with quota error | quota-blocked | Keep outbox |
| backoff | timer fires | connecting | |
| any | close 4001 or 4010 | authenticating after token refresh, else auth-expired | Call `getToken()` |
| auth-expired | getToken succeeds | connecting | |
| quota-blocked | timer fires | connecting | Probe |
| any | close 4003 or protocol error | error | Emit error event |
| any | `disconnect()` | idle | Close socket |

Implementation: a small explicit state machine (`createMachine` helper or XState-lite written in-house, about 150 lines) with unit tests for every row. Each transition emits `status`.

Per-document state: `loading -> local-only -> syncing -> synced`; also `blocked` (quota or forbidden).

### 5.1 Backoff

`delay = random(0, min(30000, 500 * 2^attempt))` (full jitter). Reset attempt to 0 after 30 s of stable `live`. When the server sends `retryAfterMs`, use `max(delay, retryAfterMs)`.

## 6. Local storage design (IndexedDB)

Database name: `syncra:{tenantId}:{userId}` (tenantId and userId come from token claims; before the first token, reads use a pending DB and are migrated). Version 1 stores:

| Store | Key | Value | Purpose |
|---|---|---|---|
| `meta` | key string | any | `clientId` (UUID, created once), `opCounter`, `schemaVersion` |
| `docs` | `docKey` | `{docKey, collection, docId, serverSeq, createdAt, updatedAt, deleted}` | Document registry |
| `snapshots` | `docKey` | `{docKey, state: Uint8Array, upToLocalId}` | Local compacted state |
| `updates` | autoIncrement `id`, index `docKey` | `{id, docKey, update: Uint8Array, ts}` | Append-only local update log since snapshot |
| `outbox` | `opId` | `{opId, docKey, update, createdAt, attempts, state}` | Unacknowledged outgoing updates |

Behaviors:
- **Load:** read snapshot plus updates for the docKey in one readonly transaction; apply into Y.Doc using `Y.applyUpdate` with origin `'local-load'`.
- **Write:** on each local Y.Doc `update` event (origin not `'local-load'` and not `'remote'`), in one readwrite transaction append to `updates` and `outbox` (merged within the batch window). Writes are queued through a single serialized writer to guarantee ordering.
- **Remote updates** are also appended to `updates` (origin `'remote'`) so reload does not need the network.
- **Local compaction:** when `updates` for a doc exceed 100 entries or 500 KB, encode the full state, write to `snapshots`, delete older `updates`. Never delete `outbox` entries.
- **Outbox lifecycle:** state `pending -> sent -> acked`. On ACK delete the entry. On reconnect, entries in `sent` return to `pending`. After the sync handshake completes for a document, entries whose update is included in the server state vector can be cleared safely (CRDT idempotency means re-sending is also safe).
- **Migrations:** versioned `onupgradeneeded` handlers with tests that open each older version fixture.
- **Storage errors:** catch `QuotaExceededError`; emit `error` with code `storage-full`; keep working in memory; try `navigator.storage.persist()` at first run and report result in status.
- **Multi-tab:** all tabs read and write the same IndexedDB. The leader tab owns the network. Followers send local updates to the leader through BroadcastChannel `syncra:{tenantId}:{userId}`. The leader forwards server updates back to followers. Followers also observe IndexedDB changes by BroadcastChannel notifications (not polling).

## 7. Multi-tab leader election

- Primary mechanism: Web Locks API. `navigator.locks.request('syncra:leader:{tenantId}:{userId}', {mode:'exclusive'}, async () => { become leader; await new Promise(releaseWhenClosed) })`. When the leader tab closes, the lock releases and another waiting tab becomes leader.
- Fallback (browsers without Web Locks): heartbeat in `localStorage` key `syncra:leader` with `{tabId, ts}` every 2 s; a tab claims leadership if the heartbeat is older than 6 s using compare-and-set via `storage` events. This path is covered by unit tests with a fake clock.
- Leader responsibilities: own the socket; run the state machine; batch followers' updates; broadcast status.
- Follower responsibilities: apply updates from the leader; send local updates to the leader; show mirrored status.
- Leader change must trigger a fresh SYNC_STEP1 for every open document to guarantee nothing was missed during the handover.

## 8. Dashboard specification (`apps/dashboard`)

### 8.1 Tech and structure

React 18, Vite, TypeScript, Tailwind CSS 3, React Router 6, TanStack Query 5, Recharts. Auth state in a React context; access token in memory; refresh cookie. Charts consume SSE through a small `useEventStream` hook that keeps a sliding window of 120 points.

Routes:

| Route | Page | Notes |
|---|---|---|
| `/login`, `/signup`, `/accept-invite` | Auth | Form validation via Zod; inline errors; accessible labels |
| `/` | Overview | KPI cards (ops per second, connections, active docs, p95 ack), live line charts, quota gauges, recent activity |
| `/collections` | Collections | Table with counts and sizes |
| `/collections/:c` | Documents | Paginated table, id prefix search, create doc button |
| `/collections/:c/:id` | Document inspector | Tabs: JSON, Ops, History (time-travel slider), Presence, Danger zone (delete, restore) |
| `/keys` | API keys | Create, copy-once modal, revoke with confirmation |
| `/usage` | Usage and billing | Time series by metric, quota bars, invoices table with HTML view and PDF link |
| `/webhooks` | Webhooks | Endpoint list, add form, test button, delivery log drawer with retry |
| `/members` | Members | Invite, change role, remove |
| `/audit` | Audit log | Table, verify chain button with result badge |
| `/monitor` | Live monitor | Node cards (heartbeat age, connections, hot docs, version), connection-per-node bar chart, sync lag chart, queue depths |
| `/playground` | Playground | Two simulated clients in a split view, JSON editor, offline toggle per client |
| `/settings` | Settings | Tenant name, plan selector (simulated), danger zone |

### 8.2 UX rules

- Layout: left sidebar navigation (collapsible), top bar with tenant switcher and user menu, content max width 1200 px.
- Loading: skeletons, not spinners, for tables and charts. Empty states with a clear next action.
- Errors: toast for transient errors; inline banners for page-level failures with retry.
- Destructive actions require a confirm dialog with the resource name typed for tenant deletion.
- Copy-once secrets: modal with copy button and a checkbox "I saved this key" required to close.
- Keyboard: all interactive elements focusable; visible focus ring; `Escape` closes dialogs; table rows navigable.
- Responsive: usable at 360 px width; tables collapse into cards below 640 px.
- Dark mode via `prefers-color-scheme` with a manual toggle stored in localStorage.

## 9. Design tokens (use these exactly)

| Token | Light | Dark |
|---|---|---|
| `--bg` | #ffffff | #0b1020 |
| `--surface` | #f6f7fb | #131a2e |
| `--surface-2` | #eceff7 | #1b2440 |
| `--text` | #0f172a | #e6e9f5 |
| `--text-muted` | #5b6478 | #9aa4bf |
| `--border` | #dde2ef | #28324f |
| `--primary` | #4f46e5 | #818cf8 |
| `--primary-contrast` | #ffffff | #0b1020 |
| `--success` | #16a34a | #4ade80 |
| `--warning` | #d97706 | #fbbf24 |
| `--danger` | #dc2626 | #f87171 |
| `--live` (sync live) | #16a34a | #4ade80 |
| `--offline` | #6b7280 | #9ca3af |

Typography: Inter (system fallback), base 14 px, headings 600 weight, mono for IDs and JSON (JetBrains Mono or ui-monospace). Radius 8 px for cards, 6 px for inputs. Spacing scale 4 px. Brand: wordmark "Syncra" with a simple two-arrow cycle glyph in the primary color (SVG, authored in repo).

Sync status badge colors: live = green dot "Synced"; syncing = blue pulsing dot "Syncing"; offline = gray dot "Offline - changes saved on this device"; backoff = amber "Reconnecting"; quota-blocked = amber "Paused: plan limit"; error = red.

## 10. Demo apps

### 10.1 Demo 1: Collaborative Notes (`apps/demo-notes`)

Purpose: the headline demo. Shows real-time collaboration, presence, and clean offline merging.

Features:
- Login screen with a "pick a name and color" form (no passwords). The demo app has a tiny Node endpoint (`/api/syncra-token`, part of `apps/server` under `/demo` when `DEMO_MODE=true`) that mints client tokens using the demo tenant's secret key.
- Notes list from `useCollection('notes')` with create, rename, delete. Works offline.
- Editor: Tiptap with Collaboration and CollaborationCursor bound to `doc.xml('content')` and `doc.awareness`; formatting toolbar (bold, italic, headings, lists, code).
- Presence: avatar stack of collaborators; remote cursors with names.
- Sync badge in header (section 9) plus a pending ops counter and "last synced" time.
- Offline banner when `connection` is `offline`.
- Chaos panel (DEM-04): buttons "Go offline", "Add 2 s latency", "Drop socket now", "Slow consumer". Implemented with `client.simulateOffline` and the testkit network wrapper.
- "Show me what the server sees" toggle: side panel fetching `GET /v1/collections/notes/docs/:id` JSON and `ops` count for transparency.

Scripted demo scenario (used by Playwright and the demo video):
1. Open Window A and Window B as two different users on the same note. Type in A; text appears in B within a blink; cursors visible.
2. Turn Window B offline using the chaos panel. Type three sentences in B. Badge shows "Offline"; pending ops count increases.
3. While B is offline, type different sentences and delete a paragraph in A.
4. Reload Window B while still offline. Edits are still there (persisted).
5. Turn B online. Badge goes Syncing then Synced; both windows show an identical merged note; the dashboard ops counter increments.
6. Open the dashboard Document inspector; scrub the history slider to show the note before and after.

### 10.2 Demo 2: Field Inspection PWA (`apps/demo-inspection`)

Purpose: the product-fit demo. Shows the exact target use case.

Features:
- Installable PWA (manifest, icons, service worker via vite-plugin-pwa; app shell precached; works with network fully off after first load).
- Data model (collections): `sites` (site name, address, status), `inspections` (one doc per inspection: root Y.Map `data` with fields: `siteId`, `inspector`, `startedAt`, `status` [draft, submitted], `notes` (Y.Text), `checklist` (Y.Array of Y.Map with `label`, `state` [pass, fail, na], `comment`), `location` (lat, lng, accuracy, at)).
- Screens: Sites list (offline capable, search); Site detail with inspection history; New inspection from a template (checklist templates are seeded read-only docs in collection `templates`); Inspection form with checklist toggles, comment fields, notes; Submit button sets `status = submitted` (last-writer-wins on the key, by Yjs semantics; document this in UI help text).
- GPS stamp via Geolocation API stored on the inspection; works offline (device GPS).
- Sync status bar fixed at top: connection badge, pending count, "Last synced 3 minutes ago", and a clear "Saved on this device" indicator for each inspection card that has unsynced ops.
- Virtualized lists (TanStack Virtual) for the sites list seeded with 5,000 sites to demonstrate rendering performance.
- Role split: "Inspector" token has `rw` on `inspections`, `r` on `sites` and `templates`; "Supervisor" token has `rw` everywhere (demonstrates read-only enforcement, SYN-12).
- Office view: a desktop-width layout for supervisors to watch inspections update live.

Inspection demo scenario:
1. Inspector syncs while online (sites cached). Switch to offline via device-style toggle.
2. Create an inspection for Site 42; complete 12 checklist items and notes; stamp GPS.
3. Supervisor edits the same inspection comment field and notes online.
4. Inspector goes online; badge syncs; inspection shows both people's edits; no conflict dialog.
5. Inspector's submit and supervisor's note both retained.

### 10.3 Demo 3: Live Monitor

The dashboard `/monitor` page. For demos it runs alongside the k6 load test and shows ops per second, connection counts per node, ack latency, and queue depth. Include a "Kill node" button in selfhost demo mode that calls a guarded endpoint on the demo controller container (`DEMO_MODE=true` only) to stop one server container, so viewers can see clients reconnect.

## 11. Frontend testing

| Layer | Tool | Cases |
|---|---|---|
| Unit | Vitest | State machine rows, backoff distribution, outbox ordering, local compaction, leader election logic with fake locks |
| Integration | Vitest plus testkit fake server | Two SDK clients with a simulated network converge under reordering, duplication, partitions |
| Property-based | fast-check | Random op sequences across N clients with random disconnects; all converge to identical JSON |
| Component | Vitest plus Testing Library | Hooks re-render counts, `usePresence` throttling |
| E2E | Playwright | Scripted scenarios in section 10; offline via `context.setOffline(true)`; multi-tab via multiple pages in the same context |
| Accessibility | axe-core in Playwright | No critical violations on dashboard pages |
| PWA | Lighthouse CI | Installable, offline-capable checks on demo-inspection |
| Bundle | size-limit | Budgets in section 2 |
