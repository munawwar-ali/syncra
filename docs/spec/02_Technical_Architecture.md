# Syncra - Technical Architecture
Document 02 of 06 | How it works | Version 1.0 | 26 Oct 2026

## 1. Architecture overview

Syncra has a stateless, horizontally scalable edge (sync nodes), a control plane (tenants, keys, billing) and a sharded data plane (documents and ops). Redis provides cross-node fan-out, presence, rate limiting and caching. BullMQ workers run background jobs.

```
 Browser / PWA                                  Tenant backend
 +------------------------------+               (mints client tokens
 | App + @syncra/react          |                with a secret key)
 | @syncra/client               |                       |
 |  Y.Doc <-> IndexedDB         |                       | POST /v1/tokens
 |  Outbox + state machine      |                       v
 |  Leader tab (Web Locks)      |
 +--------------+---------------+
                | WebSocket (binary) or HTTPS fallback
                v
 +------------------------------+
 | Nginx: TLS, WS upgrade,      |
 | least_conn, static assets    |
 +-------+--------------+-------+
         |              |
         v              v          ... N nodes
 +--------------+ +--------------+
 | Sync node 1  | | Sync node 2  |  Fastify + ws, stateless
 | auth, limits | | auth, limits |  hot-doc cache, write batcher
 +--+---+---+---+ +---+---+---+--+
    |   |   |         |   |   |
    |   |   +---------+---+---+---> Redis: pub/sub fan-out, presence,
    |   |                           rate limits, usage counters, caches
    |   +-----------------------> Control-plane Postgres
    |                             (tenants, users, keys, usage, invoices)
    +---------------------------> Data shards (Postgres 0..N-1)
                                  documents, operations (hash-partitioned),
                                  snapshots, document_views, changes
                                         ^
 +-----------------------+               |
 | Worker(s) (BullMQ)    |---------------+
 | compaction, snapshots,|
 | materializer, usage,  |
 | webhooks, invoices    |
 +-----------------------+

 Prometheus scrapes /metrics on all components; Grafana displays them.
```

### 1.1 Responsibilities

| Component | Responsibility | Stateful? |
|---|---|---|
| Nginx | TLS termination, WebSocket upgrade, load balancing, static dashboard and demo assets | No |
| Sync node (`apps/server`) | REST API, WebSocket gateway, auth, rate limiting, write batching, fan-out, hot-doc cache | No (caches only) |
| Worker (`apps/worker`) | Snapshots, compaction, JSON materialization, usage rollups, webhooks, invoices, purge, audit verification | No |
| Redis | Pub/sub, presence, rate-limit buckets, usage counters, queues, small caches, locks | Ephemeral |
| Control-plane Postgres | Tenants, users, memberships, keys, usage, invoices, webhooks, audit log | Yes |
| Data shard Postgres | Document metadata, op log, snapshots, materialized views, change feed | Yes |
| Client SDK | Local persistence, outbox, merge, state machine, multi-tab, presence API | Yes (browser) |

## 2. Technology stack

| Layer | Technology | Why |
|---|---|---|
| Language and runtime | TypeScript, Node.js 22 | Shared types between client, server and protocol; fast iteration |
| HTTP | Fastify 5 | Fast, schema-friendly, good plugin model |
| WebSocket | `ws` 8 on Fastify's HTTP server | Mature, low overhead, full control of binary framing and backpressure |
| CRDT | Yjs, y-protocols, lib0 | Proven CRDT, compact binary updates, awareness, rich editor bindings |
| Database | PostgreSQL 16 | Strong durability, partitioning, JSONB, transactions |
| DB access | `pg` + Kysely + node-pg-migrate | Typed SQL without a heavy ORM; explicit migrations |
| Cache and bus | Redis 7.2 (ioredis) | Pub/sub, Lua scripts for atomic rate limits, TTL data |
| Queues | BullMQ | Retries, backoff, delayed and repeatable jobs, DLQ pattern |
| Validation | Zod | Single source for runtime validation and TypeScript types |
| Auth | jose (JWT), argon2 (passwords) | Standards-based, audited libraries |
| Observability | pino, prom-client, OpenTelemetry, Prometheus, Grafana | Standard, free, self-hostable |
| Frontend | React 18, Vite, Tailwind, TanStack Query, Recharts, Tiptap | Fast builds, mainstream, strong ecosystem |
| Testing | Vitest, Testcontainers, Playwright, fast-check, k6, Toxiproxy | Unit to chaos coverage |
| Packaging | Docker, Docker Compose, Nginx | One-command deploy |

## 3. Data model concepts

- A **document** is one Y.Doc. Its durable representation is a snapshot plus the ops after it.
- Every accepted client update becomes (part of) an **op row** with a per-document `seq`.
- The server never needs to understand document content to store it. Content-aware work (materialized JSON, schema advisories) happens in workers.
- Exact DDL is in Doc 03 section 2.

## 4. Core flows

### 4.1 Connection and authentication

1. Client obtains a client token (JWT) from the tenant backend via `getToken()`.
2. Client opens `wss://host/v1/connect?token=...` (token also accepted in `Sec-WebSocket-Protocol` as `syncra.token.<jwt>`; query token logs must be redacted).
3. Node validates the JWT signature (tenant signing secret looked up by `kid`/`tid` claim, cached 60 s), expiry and tenant status; checks concurrent connection quota and per-IP limiter.
4. Node registers the connection (`sx:node:{nodeId}:conns`), starts heartbeat tracking, and waits for SUBSCRIBE messages.
5. Failures close the socket with the specific close codes in Doc 03 section 5.

### 4.2 Subscribe and delta sync (initial or after reconnect)

1. Client sends `SUBSCRIBE(docKey)` for each open document.
2. Node checks access from token claims (collection, doc id, mode). If allowed, it ensures the document is loaded in the hot-doc cache (section 7.2), registers the connection as a subscriber, and subscribes the node to Redis channel `sx:doc:{tid}:{docKey}` if not already.
3. Node replies `SUBSCRIBED(docKey, headSeq, access)`.
4. Client sends `SYNC_STEP1(docKey, stateVector)`. Node computes `Y.encodeStateAsUpdate(doc, stateVector)` and replies `SYNC_STEP2` containing only what the client lacks, plus its own `SYNC_STEP1` with the server state vector.
5. Client replies with `SYNC_STEP2` containing local updates the server lacks. Node treats that as a normal incoming update (persist, ack, broadcast).
6. Document is now `live` for that client.

### 4.3 Write path (the most important flow)

1. Local edit happens in the client Y.Doc. Client appends the update to the IndexedDB log and outbox (persist first), then batches for 50 ms and sends `UPDATE(docKey, opId, update)`.
2. Node receives the frame. Checks in order: rate limiter (connection, tenant), size limit, access mode, quota (ops this month, document count, storage), document exists or is creatable.
3. Update is applied to the in-memory hot Y.Doc (`Y.applyUpdate`) to validate it decodes and to keep the cache current. A malformed update is rejected with VALIDATION_FAILED and the document is not modified.
4. Update is enqueued in the **write batcher** keyed by document. The batcher flushes after `BATCH_WINDOW_MS` (default 20 ms) or when the buffer exceeds 256 KB.
5. On flush: `Y.mergeUpdates` combines the buffered updates. In one transaction on the document's shard:
   - `UPDATE documents SET head_seq = head_seq + 1, size_bytes = size_bytes + $n, updated_at = now() WHERE uid = $uid RETURNING head_seq` (this row lock serializes writers per document and yields a gap-free seq).
   - `INSERT INTO operations(doc_uid, seq, ..., client_id, client_op, update)`; for merged ops the `client_op` list is stored in an auxiliary `op_refs` array column so each original opId can be deduplicated and acked.
   - Commit (synchronous commit on).
6. After commit: node publishes `(seq, originNodeId, originClientId, update)` to the Redis channel, sends `ACK(docKey, opId, seq)` to the sender for every opId in the batch, and broadcasts `UPDATE_BROADCAST` to other local subscribers.
7. Other nodes receive the Redis message, apply the update to their hot doc if loaded, check seq continuity (section 4.5), and forward to their local subscribers.
8. Usage counters (`ops`) increment in Redis; quota thresholds trigger events.
9. Worker is notified (cheap Redis stream entry or BullMQ job debounced per document) to materialize JSON, create snapshots if thresholds are crossed, and emit change feed rows.

Ordering guarantee: persist, then ACK, then broadcast. A client never sees an ACK for data that is not durable.

### 4.4 Read and load path

1. `loadDoc(uid)` checks the node's LRU hot-doc cache. On miss it checks Redis `sx:cache:snap:{uid}` (compressed latest snapshot plus tail seq). On miss it queries the shard: latest snapshot row, then `SELECT update FROM operations WHERE doc_uid=$1 AND seq > $snapshotSeq ORDER BY seq`.
2. Updates are applied to a fresh Y.Doc (`gc: true`). The result is cached with `lastSeq`.
3. REST reads of JSON use `document_views` (materialized) rather than loading the Y.Doc, falling back to a live load when the view is stale beyond a threshold and `?fresh=true` is passed.

### 4.5 Multi-node fan-out and gap recovery

Redis pub/sub is fire-and-forget; messages can be lost during Redis restarts or slow subscribers. To keep correctness:

- Every broadcast carries the document `seq`. Each node tracks `lastSeqSeen` per hot document.
- If a message arrives with `seq > lastSeqSeen + 1`, the node detects a gap and runs **gap recovery**: query the shard for `operations` with `seq > lastSeqSeen`, apply and forward them in order, then continue.
- Every 30 seconds, for each hot document with active subscribers, the node compares `lastSeqSeen` with `documents.head_seq` (batched query) and recovers silently if behind. This also covers lost trailing messages.
- If Redis is down: nodes serve local clients only; cross-node updates are recovered by the periodic check at a 5 s interval while degraded. This is the degraded mode in OPS-11.

### 4.6 Presence and awareness

- Clients send Yjs awareness updates (name, color, cursor, custom state). Rate limited to 20 per second per client.
- The node applies the update to a per-document Awareness instance, forwards to local subscribers, and publishes to `sx:aw:{tid}:{docKey}:ch`. Other nodes forward to their local subscribers.
- Redis hash `sx:aw:{tid}:{docKey}` stores `clientId -> state JSON` with a 60 s TTL refreshed by heartbeat. On subscribe, a node sends the current presence snapshot from Redis (or merges locally).
- On socket close, the node removes the client's state and broadcasts a removal.
- Awareness is never written to Postgres.

### 4.7 Snapshots and compaction

**Why:** CRDT documents grow: every edit is an op; deletions leave tombstones in the encoded structure. Without compaction, load time and storage grow without bound.

**Snapshot trigger:** the worker (job `snapshot-doc`) runs when ops since `snapshot_seq` reach 500, or cumulative op bytes reach 1 MB, or 60 s of idle time follows at least one op.

**Snapshot algorithm:**
1. Acquire Redis lock `sx:lock:compact:{uid}` (SET NX PX 120000).
2. Read latest snapshot (if any) and ops up to `target_seq = documents.head_seq` (read inside a repeatable-read transaction).
3. Build a Y.Doc with `gc: true`, apply the snapshot and ops, then `Y.encodeStateAsUpdate`.
4. Insert snapshot row `(doc_uid, up_to_seq = target_seq, state, kind = 'compaction')`; set `documents.snapshot_seq = target_seq`.
5. Do not delete ops yet.

**Compaction (op deletion) algorithm** (job `compact-doc`, runs after a snapshot):
1. An op is deletable if `seq <= snapshot_seq` AND it is older than the plan's `history_retention` window OR it is covered by a retained history checkpoint (section 4.8).
2. Delete deletable ops in batches of 1,000 inside short transactions; never delete ops with `seq > snapshot_seq`.
3. Verify: load doc from snapshot plus remaining ops; compare `Y.encodeStateVector` equal to the pre-compaction vector. If different, abort and alert (metric `syncra_compaction_verify_failures_total`).
4. Record metrics: rows deleted, bytes before and after.

Clients that were offline longer than retention are still safe: delta sync uses state vectors against the current document (snapshot + tail), not against old seq numbers. The seq is only an ordering tool for the server and for recovery.

### 4.8 History, checkpoints and restore

- A checkpoint is a snapshot row with `kind = 'checkpoint'` created every 5 minutes of activity (job `checkpoint-doc`), retained for the plan's history window.
- History view loads a checkpoint snapshot and renders JSON (via the same materializer logic).
- **Restore to checkpoint** (non-destructive): load current doc `B` and checkpoint doc `A`; inside one Yjs transaction on `B`, replace each root type's content with `A`'s content (Y.Map: delete keys absent in A, set keys from A; Y.Text and Y.Array: delete all and insert A's content); encode resulting update; apply it through the normal write path as a server-originated op with `client_id = 'system:restore'`. History keeps both states.

### 4.9 Materialization and change feed

- Job `materialize-doc` (debounced 1 s per document) loads the doc, converts roots with `toJSON()`, stores JSONB in `document_views(doc_uid, json, seq)`.
- It inserts a `changes` row for create, delete, and at most one update per document per second.
- Change feed readers use a composite opaque cursor `{shardId: lastChangeId}`; the API merges across shards by `created_at` then `(shardId, changeId)`.

## 5. Consistency and guarantees

| Topic | Guarantee |
|---|---|
| Convergence | Strong eventual consistency: replicas that have received the same set of updates are identical, in any order (Yjs property) |
| Durability | Update ACK implies it is committed in Postgres on the document's shard (synchronous commit) |
| Delivery | At-least-once delivery to subscribers; duplicates are harmless because Yjs updates are idempotent |
| Ordering | Per document, ops are totally ordered by `seq` on the server; clients may apply updates in any order |
| Read-your-writes | Local writes are visible immediately on the writing client |
| Cross-document | No transactions across documents; no ordering guarantees across documents |
| Intention preservation | As provided by Yjs for Y.Text, Y.Array and Y.Map (for example, concurrent map writes to one key resolve to a deterministic winner) |
| Not guaranteed | Exactly-once delivery; global ordering; referential integrity between documents; schema enforcement on the server at write time |

Wording rule for all docs and the README: say "at-least-once delivery with idempotent operations", never "exactly-once".

## 6. Multi-tenancy and isolation

- Every row in shards includes `tenant_id`. Every query includes `tenant_id` and uses it in indexes.
- Redis keys and channels are prefixed with the tenant id.
- A request context object carries `tenantId` after authentication; data-access functions require it as an explicit argument (no global state). A lint rule or code-review checklist forbids data-access functions without `tenantId`.
- Client tokens embed `tid`; the server rejects any docKey access outside the token's access rules.
- Hot-doc cache keys include `tenantId`.
- Cross-tenant isolation test suite (AUT-07) is part of CI.
- Noisy-neighbor protection: per-tenant rate limits, connection caps and per-tenant batching fairness (round-robin flush scheduling).

## 7. Performance and caching

### 7.1 Techniques used

| Technique | Where |
|---|---|
| Write batching and update merging | Server batcher (20 ms) and client (50 ms) |
| Delta sync via state vectors | Every subscribe |
| Snapshots | Fast document loads |
| Compaction and Yjs GC | Bounded storage |
| Hash partitioning | `operations` split into 16 partitions per shard |
| Consistent hashing | Document-to-shard routing (section 8) |
| Hot-doc LRU cache | Node memory; avoids reloading for active documents |
| Redis snapshot cache | Cross-node warm loads, TTL 5 minutes, compressed (zlib) |
| API-key and token-key caches | 60 s TTL in Redis plus in-process LRU |
| Connection multiplexing | Many docs per WebSocket |
| Binary protocol | No JSON overhead on the hot path |
| Backpressure | Bounded buffers on server and client |

### 7.2 Hot-doc cache rules

- Max `HOT_DOC_CACHE_MAX` documents per node (default 500) with LRU eviction.
- A document is evicted when it has no local subscribers for `HOT_DOC_IDLE_MS` (60 s) or the cache is full and it is least recently used.
- Memory guard: if heap usage exceeds 75% of `--max-old-space-size`, reduce cache capacity by 25% and log a warning.

## 8. Sharding

- `SHARD_DATABASE_URLS` lists shard connection strings (compose ships 2).
- A consistent-hash ring with 64 virtual nodes per shard maps `(tenant_id, collection, doc_id)` to a shard. Hash function: xxhash64 (or murmur3) over the key string; ring positions sorted array with binary search.
- Routing is a pure function loaded at startup; adding shards means adding a URL and migrating affected documents with the (v2) rebalancer tool. For v1, the ring is fixed at deploy time; `docs/sharding.md` explains the migration approach (dual-read, copy, switch).
- Each shard has the same schema. `documents.uid` is generated at creation time and stored with the doc row on the shard; the shard id is derivable from the key, so no global lookup table is needed.
- Within a shard, `operations` is hash-partitioned by `doc_uid` into 16 partitions to keep indexes small and make maintenance cheaper.
- Control-plane data stays on a separate Postgres instance, so tenant management never contends with sync traffic.

## 9. Rate limiting and backpressure

### 9.1 Token bucket (Redis Lua, atomic)

Bucket state in a Redis hash: `tokens`, `ts`. Script input: key, capacity, refill rate per second, cost, now. Logic: refill = min(capacity, tokens + (now - ts) * rate); if refill >= cost then allow and subtract else deny and compute `retryAfterMs`. Scopes:

| Scope | Key | Default |
|---|---|---|
| Connection (messages) | `sx:rl:conn:{connId}` | 100 per second, burst 200 (in-process bucket, no Redis hop) |
| Tenant (ops) | `sx:rl:tenant:{tid}` | Plan-based (Doc 01 section 5) |
| IP (REST) | `sx:rl:ip:{ip}` | 20 per second, burst 40 |
| Auth endpoints | `sx:rl:auth:{ip}` | 5 per minute for login and signup |

On Redis failure the limiter falls back to an in-process bucket (per-node limits divided by expected node count).

### 9.2 Server backpressure

- Each connection tracks `ws.bufferedAmount`. Above `WS_OUTBOUND_HIGH_WATER` (1 MB) the node stops sending broadcast frames to that connection and marks it `slow`. It keeps coalescing pending updates per doc via `Y.mergeUpdates` in a small per-connection map. When the buffer drains, it sends the merged update.
- If still slow after 15 s, close with 1013 (try again later). The client reconnects and delta-syncs.
- Inbound: each message handler is async but processed per-connection in order; a bounded in-flight queue per connection (default 256) pauses reading (`ws.pause()`) when full.

### 9.3 Client backpressure

- Outbox cap: 10,000 ops or 50 MB. When exceeded, the SDK coalesces older updates into a single merged update per document (always safe for CRDT updates) before refusing writes. A `queue-pressure` event is emitted.

## 10. Security

| Area | Design |
|---|---|
| Passwords | argon2id (memory 64 MB, iterations 3, parallelism 1) |
| Dashboard auth | Access JWT 15 min (kept in memory), refresh token 30 days rotating, stored hashed, httpOnly, SameSite=Lax, Secure cookie; refresh reuse detection revokes the family |
| API keys | Format `sk_live_<32 random bytes base62>` and `pk_live_...`; stored as SHA-256 hash plus 8-char prefix; compared in constant time |
| Client tokens | JWT HS256 signed with per-tenant signing secret (encrypted at rest); claims `tid`, `sub`, `access[]`, `iat`, `exp` (max 24 h), `jti` |
| Secrets at rest | AES-256-GCM using `ENCRYPTION_KEY`; random 12-byte IV stored with ciphertext |
| Transport | TLS at Nginx; HSTS; WebSocket over wss only in production |
| Input limits | Max REST body 1 MB; max WS message 2 MB; max update 1 MB; document id regex |
| Headers | Helmet defaults, strict CORS allowlist |
| Webhooks | HMAC-SHA256 signatures, timestamp tolerance 5 minutes, SSRF protection (block private IP ranges by default, configurable) |
| Dependency hygiene | `pnpm audit` and Dependabot in CI |
| Logging | Never log tokens, keys, passwords or document content; redact `token` query param in access logs |
| Audit | Hash-chained admin audit log |

Threat notes to document in `docs/security.md`: token theft (short TTL, scoped access), malicious Yjs updates (size limits, decode validation, rate limits), tenant escape (isolation tests), webhook SSRF, DoS via huge documents (quotas and size limits), replay (idempotent ops).

## 11. Failure modes and handling

| Failure | Behavior | Recovery and verification |
|---|---|---|
| Sync node crash | Clients lose connection | Reconnect with jitter to another node; delta sync; no acknowledged data lost (durable before ACK). Test: kill node under load |
| Redis down | Cross-node fan-out and presence degrade; limiter uses local buckets; queues pause | Periodic head_seq check keeps clients converging within 5 s; on recovery, gap recovery runs. Test: stop Redis container |
| Shard Postgres down | Documents on that shard cannot be written or loaded; other shards unaffected | Clients keep editing locally; writes return UNAVAILABLE with retry hint; outbox drains later. Test: stop one shard |
| Control-plane DB down | Existing authenticated connections continue; new logins and new connections that need uncached key lookups fail | Cache TTLs keep tokens verifiable; readyz fails |
| Worker down | No new snapshots or materialization | Op log keeps growing; alerts fire when `ops_since_snapshot` exceeds 5,000; backlog processed on recovery |
| Network partition between client and server | Client in `offline` or `backoff`; edits go to outbox | Delta sync on reconnect. Test: Playwright offline and Toxiproxy |
| Duplicate delivery or client retry | Idempotent op ids; Yjs idempotency | Test: send same update repeatedly |
| Out-of-order delivery | Yjs handles via pending structs | Property test: random permutations converge |
| Clock skew | No logic depends on client clocks; seq is server-assigned | Token `exp` uses server time with 30 s leeway |
| Large offline edit sets | Merged into few updates; delta sync | Test: 10,000 offline edits sync under a documented time |
| Poisoned or oversized update | Rejected before persistence | Test: fuzz decoder with random bytes |
| Slow consumer | Backpressure then close 1013 | Test: client that never reads |
| Compaction bug | Verification step aborts and alerts | State vector comparison before commit |

## 12. Scalability and capacity thinking

| Dimension | Approach | Limit and next step |
|---|---|---|
| Connections | Stateless nodes behind least_conn; add replicas | Roughly 10,000 to 30,000 sockets per modest node (to be measured); tune ulimits, Nginx worker_connections |
| Fan-out | One Redis message per update per document; each node forwards locally | Very hot documents (1,000+ subscribers) become Redis and node CPU bound; document mitigation: binary frames, merged batches, awareness throttling |
| Write throughput | Per-document row lock serializes writes; batching reduces lock acquisitions | Per-document ceiling around 1,000 batched commits per second; across documents scales with shards |
| Storage | Compaction and retention | Partition pruning and archival in v2 |
| Read scale | Hot-doc cache, Redis snapshot cache, materialized views | Read replicas per shard (documented future work) |
| Rebalancing | Fixed ring in v1 | Dual-read migration tool in v2 |

Back-of-envelope example for `docs/capacity.md`: 5,000 clients, each 1 update per 5 seconds = 1,000 ops/s; with batching (20 ms) to about 400 commits per second across shards; average op 200 bytes = 80 KB/s raw write, small for Postgres; fan-out depends on subscribers per document.

## 13. Optional future: end-to-end encryption (v2 notes)

Yjs updates are opaque to the server, which makes E2EE feasible: clients encrypt each update with a per-document key before sending; the server stores ciphertext. Tradeoffs: server cannot materialize JSON, snapshot or compact (clients must snapshot), and search is impossible. Document as a design note only.

## 14. Observability

### 14.1 Metrics (prom-client names)

| Metric | Type | Labels |
|---|---|---|
| `syncra_ws_connections` | gauge | node |
| `syncra_ws_messages_total` | counter | type, direction |
| `syncra_ops_received_total` | counter | tenant_tier |
| `syncra_ops_committed_total` | counter | shard |
| `syncra_op_commit_duration_seconds` | histogram | shard |
| `syncra_ack_latency_seconds` | histogram | node |
| `syncra_fanout_lag_seconds` | histogram | node |
| `syncra_hot_docs` | gauge | node |
| `syncra_gap_recoveries_total` | counter | node |
| `syncra_rate_limited_total` | counter | scope |
| `syncra_quota_blocked_total` | counter | metric |
| `syncra_backpressure_events_total` | counter | action |
| `syncra_snapshot_duration_seconds` | histogram | shard |
| `syncra_compaction_rows_deleted_total` | counter | shard |
| `syncra_compaction_bytes_reclaimed_total` | counter | shard |
| `syncra_compaction_verify_failures_total` | counter | shard |
| `syncra_queue_depth` | gauge | queue |
| `syncra_job_duration_seconds` | histogram | job |
| `syncra_webhook_deliveries_total` | counter | status |
| `syncra_pg_pool_waiting` | gauge | shard |
| `syncra_ops_since_snapshot_max` | gauge | shard |
| `http_request_duration_seconds` | histogram | route, method, status |

Metric labels must not include tenant ids or document ids (cardinality). Per-tenant metrics go to the usage tables, not Prometheus.

### 14.2 Alerts (Prometheus rules file)

- Ack latency p95 above 250 ms for 5 minutes.
- Connections drop by more than 30% within 2 minutes.
- Any compaction verification failure.
- Queue depth above 10,000 for 10 minutes.
- `syncra_ops_since_snapshot_max` above 5,000.
- Postgres pool waiting above 20 for 2 minutes.
- Gap recoveries per minute above 100 (Redis instability).

### 14.3 Logging and tracing

- pino JSON logs with fields `ts`, `level`, `msg`, `requestId`, `nodeId`, `tenantId` (when known), `connId`, `docKey` (only at debug level).
- OpenTelemetry spans around REST handlers, write batcher flushes, shard queries and job runs. Exporter enabled only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

## 15. Deployment topology

### 15.1 Local and single-host (compose)

Services: `nginx`, `server` (scalable via `--scale server=3`), `worker`, `pg-control`, `pg-shard-0`, `pg-shard-1`, `redis`, `prometheus`, `grafana`, `toxiproxy` (profile `chaos`), `k6` (profile `loadtest`). Full spec in Doc 05 section 7.

### 15.2 AWS reference

Single EC2 instance (4 vCPU, 16 GB) running compose behind an Elastic IP with Let's Encrypt via Caddy or certbot is the reference. Optional Terraform module provisions EC2, security groups and an S3 bucket for Postgres backups. Document RDS and ElastiCache as the managed alternative; the app only needs standard Postgres and Redis URLs.

### 15.3 Backups and upgrades

- `pg_dump` nightly per database to a mounted volume or S3; document restore drill.
- Migrations are forward-only, backward compatible for one version (expand, migrate, contract).
- Rolling upgrade: scale new nodes, drain old nodes (SIGTERM triggers graceful shutdown).

## 16. Architecture Decision Records to write

Create these files in `docs/adr/` during the build. Each: context, decision, alternatives, consequences.

| ADR | Title | Decision summary |
|---|---|---|
| 0001 | CRDT (Yjs) instead of OT | No central transform authority needed; fits offline; cost is metadata growth |
| 0002 | Append-only op log plus snapshots | Event-sourced history, replay, delta serving |
| 0003 | Server-assigned per-document seq in the shard transaction | Gap-free ordering without distributed consensus |
| 0004 | Persist before ACK before broadcast | Durability guarantee for clients |
| 0005 | Redis pub/sub with seq gap recovery | Cheap fan-out; correctness via Postgres as source of truth |
| 0006 | Stateless sync nodes | Horizontal scale and easy rolling restarts |
| 0007 | Consistent-hash sharding across Postgres instances | Concrete scale-out story without a distributed DB |
| 0008 | Separate control plane and data plane databases | Isolation of concerns and failure domains |
| 0009 | Binary WebSocket protocol with multiplexed documents | Efficiency and fewer connections |
| 0010 | At-least-once plus idempotent ops (not exactly-once) | Honest, testable semantics |
| 0011 | Write batching windows | Fewer commits; slight added latency |
| 0012 | Leader tab via Web Locks with BroadcastChannel fallback | One connection per browser profile |
| 0013 | Token bucket limiting in Redis Lua | Atomic and shared across nodes |
| 0014 | Non-destructive restore | History preserved; CRDT-friendly |
| 0015 | Tenant-signed client tokens | Tenants control user identity; Syncra never stores end-user credentials |
