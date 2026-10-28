# Syncra - Product Requirements
Document 01 of 06 | What to build | Version 1.0 | 26 Oct 2026

## 1. Vision and problem

### 1.1 Problem

Users expect apps to keep working on trains, in basements, on construction sites and on flaky mobile networks. Building that properly means solving the same hard problems every time:

- Local storage that survives reloads and crashes.
- A queue of writes made offline that is never lost and is safe to retry.
- Conflict resolution when two devices edit the same data while disconnected.
- Reconnect logic with backoff, resumable and incremental (not "download everything again").
- Live updates across devices and tabs.
- Multi-tenant access control, quotas and operational visibility once it is a product.

Most teams either skip offline support or ship a fragile version that loses data. Existing options are hosted and locked in (Firebase, Realm Sync), tied to a specific database (PouchDB with CouchDB), or low-level libraries with no backend platform (Yjs, Automerge).

### 1.2 Solution

Syncra is a self-hostable backend and a client SDK. The developer defines collections, installs the SDK, and the app works offline, merges conflict-free and updates live across devices. The operator runs one `docker compose up` and gets multi-node sync gateways, sharded storage, a dashboard, quotas, webhooks and metrics.

### 1.3 Honest positioning

Yjs provides the merge algorithm. Syncra's contribution is the platform around it: durable op log, snapshots and compaction, horizontal scaling, tenant isolation, quotas, SDK ergonomics, offline-first client engineering, observability and self-hosting. The product is not "a new CRDT"; it is "the missing backend and client runtime for CRDT apps".

### 1.4 Product principles

1. Never lose user data. A local write is durable before it is acknowledged to the UI.
2. The UI never waits on the network. Reads and writes hit local storage first.
3. Self-host first. Everything works with no external SaaS dependency.
4. Boring operations. One compose file, health checks, metrics, clear errors.
5. Honest guarantees. Document exactly what is and is not guaranteed.

## 2. Users and personas

| Persona | Description | Needs | Success looks like |
|---|---|---|---|
| Dev Dana (primary) | Full-stack developer at a 3-person startup building a field-inspection PWA | Offline support in days, not months; no vendor lock-in; low cost | Integrates SDK in an afternoon; app survives airplane mode demo |
| Ops Omar | Platform engineer at a small company that must self-host | Simple deploy, metrics, backups, predictable scaling | Runs 3 nodes with compose; sees dashboards; upgrades safely |
| Founder Fiona | Indie hacker building a collaborative notes or planning tool | Real-time collaboration without running her own Yjs server fleet | Gets presence, history and quotas out of the box |
| Reviewer Riya (secondary) | Recruiter or senior engineer evaluating the repo | Understand the problem and depth in 5 minutes | Watches the demo, reads the architecture doc, runs it locally |

## 3. Scope

### 3.1 In scope (v1.0)

- Document sync over WebSocket with HTTP fallback, backed by Yjs.
- Client SDK (`@syncra/client`) and React bindings (`@syncra/react`).
- Persistent op log, snapshots, background compaction, document history and restore.
- Multi-node horizontal scaling with Redis fan-out; sharded PostgreSQL data plane.
- Multi-tenancy: tenants, users, roles, API keys, client tokens, per-document access.
- Rate limiting, backpressure, quotas, usage metering, simulated billing and invoices.
- Webhooks and a change feed.
- Presence/awareness.
- Admin dashboard.
- Observability: metrics, logs, optional traces, Grafana dashboard.
- Three demo apps and a live monitor.
- One-command local and single-host deployment.

### 3.2 Out of scope (v1.0)

Full-text search, SQL-style queries over document content, native mobile SDKs, end-to-end encryption, blob/file attachments (planned v1.1), real payment processing by default, Kubernetes manifests, custom CRDT types beyond Yjs types.

## 4. Feature catalogue

Priority: M = Must (v1.0 blocker), S = Should (include unless time-boxed out), C = Could (v1.1 candidate).
Each feature has an ID. Every ID needs at least one automated test.

### 4.1 Sync core (SYN)

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| SYN-01 | M | Clients connect via WebSocket to `/v1/connect` and subscribe to one or more documents over a single multiplexed connection | One socket carries 20 open documents; each receives only its own updates |
| SYN-02 | M | On subscribe, client and server exchange state vectors (Yjs sync step 1 and 2) so only missing updates travel | Reconnect after 100 offline edits transfers only those edits; payload size is proportional to the diff, verified in test |
| SYN-03 | M | Live updates: each accepted update is persisted, acknowledged to the sender with a seq, and broadcast to other subscribers | Two clients see each other's edits within 150 ms p95 on localhost |
| SYN-04 | M | Server persists every update to the append-only op log before sending the ACK | Kill the server after ACK; restart; document contains the update |
| SYN-05 | M | Updates are idempotent: a re-sent update (same client and op id) is stored once and acknowledged again | Sending the same update 5 times yields one op row and 5 identical ACKs |
| SYN-06 | M | Write batching: updates for one document arriving within the batch window are merged into one op row | 100 updates in 20 ms produce at most 5 op rows (config dependent) and identical final state |
| SYN-07 | M | Document load path: latest snapshot plus ops after snapshot seq, merged into a Y.Doc | Loading a doc with 10,000 ops and a snapshot at seq 9,500 reads only 500 ops |
| SYN-08 | M | Server never trusts client for seq; seq is assigned in the shard transaction | Concurrent writers to one doc produce a gap-free strictly increasing seq |
| SYN-09 | M | HTTP fallback endpoints for pull and push when WebSocket is unavailable | With WS blocked, SDK still syncs using polling every 5 s (configurable) |
| SYN-10 | S | Graceful node shutdown: send close code 1001, flush batches, clients reconnect to another node | Rolling restart of 3 nodes causes no lost updates; clients reconnect within 3 s |
| SYN-11 | M | Max update size, max message size and max document size enforced with clear error codes | Oversized update is rejected with PAYLOAD_TOO_LARGE and does not disconnect healthy docs |
| SYN-12 | M | Read-only access: connections with read-only access receive updates but their updates are rejected | Read-only client edit does not change server state; receives FORBIDDEN on that doc |

### 4.2 Offline-first client (CLI)

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| CLI-01 | M | All reads and writes go to a local Y.Doc persisted in IndexedDB; UI never awaits network | App opens and edits with network disabled from first load after initial sync |
| CLI-02 | M | Every local change is appended to a persisted outbox before any network send | Close the tab immediately after typing offline; reopen; edits present and later delivered |
| CLI-03 | M | Sync state machine with states: `idle`, `offline`, `connecting`, `authenticating`, `syncing`, `live`, `backoff`, `auth-expired`, `quota-blocked`, `error` | State transitions follow Doc 04 table; each transition emits an event; unit-tested |
| CLI-04 | M | Reconnect with exponential backoff and full jitter (base 500 ms, cap 30 s, reset after 30 s stable) | Test with fake timers verifies distribution and cap |
| CLI-05 | M | Detect offline via `navigator.onLine`, `online/offline` events, and failed pings; switch states accordingly | Toggling Playwright offline moves status to `offline` within 2 s |
| CLI-06 | M | Multi-tab: one leader tab holds the WebSocket; follower tabs communicate via BroadcastChannel; leader failover when leader closes | Open 3 tabs: server shows 1 connection; close leader; another tab takes over in under 3 s with no lost edits |
| CLI-07 | M | Local compaction of the IndexedDB update log into a snapshot after 100 updates or 500 KB | Storage size stays bounded under 10,000 local edits |
| CLI-08 | M | Token refresh: SDK calls `getToken()` before expiry (at 80% lifetime) and on 401; pauses sync in `auth-expired` if it fails | Expired token test: sync resumes automatically after getToken succeeds |
| CLI-09 | M | Status API: `pendingOps`, `lastSyncedAt`, per-document sync state, connection state | `useSyncStatus()` shows pending count dropping to 0 after reconnect |
| CLI-10 | S | Optional Zod schema per collection for typed access and client-side validation | Invalid shape rejected locally with a typed error; valid writes pass |
| CLI-11 | S | Storage quota handling: detect `QuotaExceededError`, surface `storage-full` error, keep memory copy | Simulated quota error does not crash; user sees error status |
| CLI-12 | S | `client.destroy()` and `client.clearLocalData()` for logout flows | After clear, IndexedDB database for that user is deleted |
| CLI-13 | M | Collection index documents so collections can be listed offline | `collection.list()` works offline with items created offline |

### 4.3 Authentication, tenancy and access (AUT)

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| AUT-01 | M | Dashboard signup creates a user, a tenant, an owner membership, and one secret key and one publishable key | Signup returns tokens; keys visible once in the dashboard |
| AUT-02 | M | Login with email and password (argon2id); access JWT (15 min) plus rotating refresh token (30 days) in httpOnly cookie | Refresh rotates token; reuse of an old refresh token revokes the family |
| AUT-03 | M | Roles per tenant: owner, admin, developer, viewer with the permission matrix in section 4.3.1 | Tests cover each role against each protected endpoint category |
| AUT-04 | M | API keys: secret (`sk_`) and publishable (`pk_`); only hash stored; prefix shown; revocable | Revoked key is rejected within 60 s (cache TTL) |
| AUT-05 | M | Client tokens: tenant backend calls `POST /v1/tokens` with a secret key to mint short-lived JWTs with user id and access rules | Token with `exp` in the past is rejected; tampering is rejected |
| AUT-06 | M | Access rules in token claims: list of `{collection, docs ("*" or ids), mode ("r" or "rw")}` | Token limited to collection A cannot subscribe to collection B |
| AUT-07 | M | Tenant isolation: no API, WebSocket message or background job can read or write another tenant's data | Isolation test suite attempts cross-tenant access through every endpoint and WS path; all denied |
| AUT-08 | S | Hash-chained audit log of administrative actions (key created, member added, plan changed) | Verifying the chain detects a modified row |
| AUT-09 | S | Team invitations by email token (email sending is a console/log adapter by default) | Invite link accepted creates membership |
| AUT-10 | C | OIDC login for dashboard | Documented; not implemented in v1.0 |

#### 4.3.1 Role permission matrix

| Capability | owner | admin | developer | viewer |
|---|---|---|---|---|
| View documents, usage, logs | yes | yes | yes | yes |
| Create and delete documents via dashboard | yes | yes | yes | no |
| Manage API keys | yes | yes | yes (publishable only) | no |
| Manage webhooks | yes | yes | yes | no |
| Manage members | yes | yes | no | no |
| Change plan and billing | yes | no | no | no |
| Delete tenant | yes | no | no | no |

### 4.4 Data, history and operations on documents (DAT)

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| DAT-01 | M | Snapshots created when ops since last snapshot reach 500 or 1 MB, or after 60 s idle with pending ops | Snapshot row appears; document load time stops growing with op count |
| DAT-02 | M | Background compaction worker merges ops into a snapshot and deletes superseded ops after retention allows | After compaction, op row count falls; final document content is byte-identical when re-encoded |
| DAT-03 | M | Materialized JSON view of each document kept by the worker for REST reads and dashboard | `GET /v1/collections/c/docs/id` returns JSON within 5 s of last write |
| DAT-04 | M | Document history: periodic checkpoints (every 5 min of activity) retained per plan | History endpoint lists checkpoints; each can be rendered as JSON |
| DAT-05 | S | Restore: create new updates that set content back to a checkpoint (non-destructive) | After restore, current content equals checkpoint content; history keeps both |
| DAT-06 | S | Time-travel view in dashboard: slider across checkpoints and ops showing document content | Scrubbing updates the rendered JSON; no server mutation |
| DAT-07 | M | Soft delete document, hard purge after 7 days by worker | Deleted doc not listed; sync attempts return NOT_FOUND; purge removes ops, snapshots, views |
| DAT-08 | M | Change feed: ordered list of document create, update (debounced 1 s) and delete events, readable by cursor and via SSE | Consumer resumes from cursor with no gaps and no duplicates |
| DAT-09 | S | Export document as JSON and as binary Yjs update | Downloads match server state |
| DAT-10 | M | Tombstone and metadata growth bounded by compaction with Yjs garbage collection enabled | Benchmark in `docs/benchmarks.md` shows size before and after for a heavy-edit document |

### 4.5 Collaboration (COL)

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| COL-01 | M | Presence via Yjs awareness: name, color, cursor, custom JSON state, ephemeral | Second client sees first client's cursor in under 200 ms; disappears 30 s after abrupt disconnect |
| COL-02 | M | Presence state is stored in Redis with TTL and broadcast across nodes | Clients on different nodes see each other |
| COL-03 | S | `usePresence` hook returning others list with stable identity and throttled updates (max 20 per second per client) | Render count test shows throttling works |
| COL-04 | S | Document-level participant count visible in dashboard monitor | Count matches active connections within 5 s |

### 4.6 Platform operations (OPS)

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| OPS-01 | M | Token-bucket rate limiting per connection, per tenant, per IP (REST) with Redis Lua scripts | Excess traffic receives RATE_LIMITED with `retryAfterMs`; well-behaved clients unaffected |
| OPS-02 | M | Backpressure: outbound buffer high-water mark; slow consumers are paused then disconnected with 1013 | Slow client test does not grow server memory unbounded |
| OPS-03 | M | Quotas per plan: documents, storage bytes, ops per month, concurrent connections, max doc size | Each quota blocks the specific action with QUOTA_EXCEEDED while existing data stays readable |
| OPS-04 | M | Usage metering: counters in Redis flushed hourly into `usage_hourly` | Usage API totals match generated traffic within 1% |
| OPS-05 | M | Quota-blocked clients keep their outbox and enter `quota-blocked` state; resume after quota is raised | Raise quota; queued ops flow without user action |
| OPS-06 | M | Webhooks: `document.created`, `document.deleted`, `document.updated` (debounced), `quota.warning` (80%), `quota.exceeded`; HMAC signed; retried with backoff; delivery log | Receiver validates signature; failed endpoint shows retries then dead state |
| OPS-07 | M | Health endpoints `/healthz` (liveness) and `/readyz` (Postgres, Redis, shards) | `readyz` fails when a dependency is down |
| OPS-08 | M | Prometheus metrics endpoint and provisioned Grafana dashboard | Dashboard loads with live data after `docker compose up` |
| OPS-09 | S | Structured logs with request ID correlation across REST and WS | One request ID appears in server and worker logs for a flow |
| OPS-10 | S | Admin CLI script to create tenants, mint tokens, run compaction | Documented in `docs/self-hosting.md` |
| OPS-11 | M | Graceful degradation when Redis is down: single-node sync continues, cross-node fan-out and presence degraded, limiter falls back to in-memory | Chaos test: stop Redis; local-node clients still sync; recovery restores fan-out |

### 4.7 Billing (BIL)

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| BIL-01 | M | Plans: free, pro, business, selfhost with quotas in section 5 | Plan change updates enforced quotas within 60 s |
| BIL-02 | M | Monthly usage rollup produces an invoice (JSON line items: base fee, overage ops, overage storage) | Invoice totals computed deterministically from usage rows; unit-tested |
| BIL-03 | S | Invoice HTML view in dashboard and PDF download | PDF opens and matches totals |
| BIL-04 | C | Stripe adapter behind `BILLING_PROVIDER=stripe` | Documented interface only |
| BIL-05 | M | `BILLING_ENABLED=false` disables quotas and invoices (self-host default is `selfhost` plan) | Self-host instance never blocks on quotas |

### 4.8 Admin dashboard (DSH)

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| DSH-01 | M | Auth screens: signup, login, logout, accept invite | Works with cookies and refresh |
| DSH-02 | M | Overview: live ops per second, connections, active documents, p95 ack latency, quota gauges | Updates every second via SSE |
| DSH-03 | M | Collections and documents browser with JSON viewer, size, seq, updated time | Pagination and search by id prefix |
| DSH-04 | S | Document inspector: raw ops list, history checkpoints, time-travel slider, restore button | Matches DAT-04 to DAT-06 |
| DSH-05 | M | API keys page: create, copy-once, revoke | Secret shown only once |
| DSH-06 | M | Usage and billing page: charts by metric, current quota bars, invoices | Matches API data |
| DSH-07 | M | Webhooks page: endpoints CRUD, send test event, delivery log with retry | Visible delivery states |
| DSH-08 | S | Members and roles page | Role changes enforced |
| DSH-09 | S | Audit log page with chain verification button | Shows verified or tampered |
| DSH-10 | M | Live monitor: nodes list (heartbeat, connections, hot docs), connection map, sync lag | Node shutdown shows within 15 s |

### 4.9 Developer experience (DX)

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| DX-01 | M | `@syncra/client` and `@syncra/react` published-ready with typed API, ESM and CJS builds, sourcemaps | `pnpm pack` output installs and runs in a clean sample project |
| DX-02 | M | Quickstart: working offline app in under 15 minutes following README | Timed walkthrough recorded in docs |
| DX-03 | M | `docker compose up` starts the full stack with seeded demo tenant and printed keys | Fresh clone works on Linux and macOS |
| DX-04 | M | Auto-generated OpenAPI spec and WebSocket protocol doc | Files present and linted in CI |
| DX-05 | S | Docs site (Markdown rendered by VitePress) | Built in CI and deployed to GitHub Pages |
| DX-06 | S | Playground page in dashboard: type JSON, see sync between two simulated clients with network toggle | Toggle offline and online; merge visible |

### 4.10 Demo apps (DEM)

| ID | Pri | Requirement | Acceptance criteria |
|---|---|---|---|
| DEM-01 | M | Collaborative notes app (rich text, presence cursors, sync badge, offline banner) | Passes the scripted demo scenario in Doc 04 section 10 |
| DEM-02 | M | Field inspection PWA (sites, checklists, notes, GPS stamp, installable, works fully offline) | Lighthouse PWA installable; offline test passes in Playwright |
| DEM-03 | M | Live monitor dashboard page doubles as a demo of ops per second and node health | Visible during load test |
| DEM-04 | S | Chaos panel in notes app: buttons "simulate offline", "add 2 s latency", "kill my socket" | Each button changes state machine status visibly |

## 5. Plans and quotas

| Plan | Notional price | Documents | Storage | Ops per month | Concurrent connections | History retention | Max doc size | Webhooks | Ops per second (tenant) |
|---|---|---|---|---|---|---|---|---|---|
| free | $0 | 1,000 | 100 MB | 1,000,000 | 100 | 7 days | 5 MB | 1 | 50 |
| pro | $29 per month | 100,000 | 10 GB | 50,000,000 | 5,000 | 30 days | 25 MB | 10 | 1,000 |
| business | $149 per month | 1,000,000 | 100 GB | 500,000,000 | 50,000 | 90 days | 50 MB | 50 | 10,000 |
| selfhost | n/a | unlimited | unlimited | unlimited | unlimited | configurable (default 30 days) | 50 MB | unlimited | configurable |

Overage (notional, simulated): $0.40 per additional 1,000,000 ops; $0.25 per additional GB-month storage. Overage is billed on pro and business only; free is hard-capped. "Op" means one accepted client update frame counted before batching.

## 6. Non-functional requirements

| Area | Requirement |
|---|---|
| Latency (targets, to be validated by load tests) | p95 ACK latency under 100 ms; p95 cross-client propagation under 150 ms on a single host with 3 nodes at 2,000 ops per second |
| Capacity (targets) | 5,000 concurrent WebSocket connections across 3 nodes on a developer-class machine with documented specs |
| Durability | No acknowledged update lost on process crash. Postgres synchronous commit on shard writes |
| Availability | Loss of one sync node does not interrupt service for clients; they reconnect to another node |
| Consistency | Strong eventual consistency for document content; read-your-writes on the writing client; documented in Doc 02 |
| Security | OWASP ASVS L1 baseline; dependency audit in CI; secrets never logged |
| Browser support | Latest 2 versions of Chrome, Edge, Firefox, Safari (14+ for IndexedDB and Web Locks fallback) |
| Accessibility | Dashboard meets WCAG 2.1 AA basics: keyboard navigation, contrast, labels |
| Observability | Every component exposes metrics; every request has a request ID |
| Portability | Runs on Linux and macOS with Docker; no cloud-vendor-specific services required |
| Documentation | Every public API documented; architecture and ADRs published |

## 7. Key user flows

### 7.1 Developer onboarding

1. Developer runs `docker compose up`; opens the dashboard at `http://localhost:8080`.
2. Signs up; sees a demo tenant with a publishable key and secret key.
3. Installs `@syncra/client` and `@syncra/react` in their app.
4. Adds a tiny backend endpoint that calls `POST /v1/tokens` with the secret key and returns a token for the logged-in user.
5. Wraps the app in `SyncraProvider`, uses `useDoc('notes', id)`.
6. Switches the browser offline, edits, goes online, sees the merge and the dashboard counters move.

### 7.2 Field worker scenario (demo narrative)

A site inspector opens the PWA on a phone with signal, syncs assigned sites, drives to a basement with no signal, completes a checklist and notes over 40 minutes, a colleague edits the same inspection from the office, the inspector surfaces, and both edits merge with no data loss and no manual conflict dialog.

### 7.3 Quota reached

1. Tenant on the free plan reaches 100% of monthly ops.
2. Server returns QUOTA_EXCEEDED for writes; webhook `quota.exceeded` fires.
3. Clients enter `quota-blocked` but keep working locally; the app shows a banner via `useSyncStatus`.
4. Admin upgrades plan in the dashboard; within 60 s clients leave `quota-blocked` and the outbox drains.

### 7.4 Operator rolling restart

1. Operator restarts nodes one at a time.
2. Each node sends close 1001; clients reconnect with jitter to a healthy node and run delta sync.
3. Dashboard monitor shows nodes leaving and rejoining; no client reports lost data.

## 8. Differentiation summary

| Alternative | Gap Syncra fills |
|---|---|
| Firebase Firestore | Syncra is self-hostable and open; CRDT merge instead of last-write-wins |
| Supabase Realtime | Realtime only; no offline-first client runtime or conflict resolution |
| PouchDB with CouchDB | Revision-tree conflicts need app-level resolution; Syncra merges automatically |
| Yjs servers (y-websocket, Hocuspocus, y-sweet) | Great sync servers; little multi-tenancy, quotas, billing, dashboard or SDK runtime |
| Liveblocks and similar | Hosted, closed; Syncra is open and self-hosted |
| PowerSync, Electric, Replicache, Zero | Different model (sync SQL data); Syncra targets document and CRDT collaboration |

Be factual in all public comparisons (see Doc 06). Never disparage; state tradeoffs.

## 9. Success metrics

| Metric | Target at 90 days after launch |
|---|---|
| Time to first synced offline edit (new developer) | Under 15 minutes |
| GitHub stars | 100 or more (stretch 300) |
| Demo video views | 1,000 or more |
| Teams who ran a trial and gave written feedback | 5 or more |
| Open issues from external users | 10 or more (signal of use) |
| Load-test claims in README | 100% backed by committed scripts and result files |

## 10. Roadmap

| Version | Theme | Highlights |
|---|---|---|
| v1.0 | Core platform | Everything marked M and S in this document |
| v1.1 | Attachments and DX | Blob storage (S3 or MinIO), photo attachments in inspection app, VitePress docs polish, Stripe adapter |
| v1.2 | Search and queries | Server-side search index over materialized views, collection queries with filters |
| v2.0 | Reach and trust | Native SDKs (Swift, Kotlin), optional end-to-end encryption, partial replication by query, shard rebalancing tool |
