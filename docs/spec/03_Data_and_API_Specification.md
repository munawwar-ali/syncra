# Syncra - Data and API Specification
Document 03 of 06 | Exact schemas, keys, endpoints, protocol | Version 1.0 | 26 Oct 2026

## 1. Conventions

- Base URL: `{PUBLIC_URL}/v1`. JSON requests and responses use camelCase. Binary values in JSON use base64url.
- Auth types: **D** = dashboard access JWT (`Authorization: Bearer`), **S** = secret API key (`Authorization: Bearer sk_...`), **C** = client token (WebSocket and sync fallback), **P** = public (no auth).
- Pagination: cursor-based. Request `?limit=50&cursor=...`; response `{ "items": [...], "nextCursor": "..." | null }`. Default limit 50, max 200.
- Idempotency: write endpoints accept `Idempotency-Key` header (stored 24 h in Redis) except where the endpoint is naturally idempotent.
- All timestamps ISO-8601 UTC.

## 2. PostgreSQL schema

### 2.1 Control-plane database (`syncra_control`)

```sql
create extension if not exists citext;

create table tenants (
  id                 uuid primary key,
  slug               text not null unique,
  name               text not null,
  plan               text not null default 'free'
                     check (plan in ('free','pro','business','selfhost')),
  status             text not null default 'active'
                     check (status in ('active','suspended','deleted')),
  signing_secret_enc bytea not null,          -- AES-256-GCM(iv||ct||tag)
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table users (
  id            uuid primary key,
  email         citext not null unique,
  password_hash text not null,
  name          text not null,
  created_at    timestamptz not null default now()
);

create table memberships (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id   uuid not null references users(id) on delete cascade,
  role      text not null check (role in ('owner','admin','developer','viewer')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create table invitations (
  id          uuid primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  email       citext not null,
  role        text not null check (role in ('admin','developer','viewer')),
  token_hash  bytea not null unique,
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  created_by  uuid not null references users(id)
);

create table api_keys (
  id           uuid primary key,
  tenant_id    uuid not null references tenants(id) on delete cascade,
  kind         text not null check (kind in ('secret','publishable')),
  name         text not null,
  prefix       text not null,                 -- first 8 chars for display
  key_hash     bytea not null unique,         -- sha256
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_by   uuid references users(id),
  created_at   timestamptz not null default now()
);
create index api_keys_tenant_idx on api_keys (tenant_id) where revoked_at is null;

create table refresh_tokens (
  id          uuid primary key,
  family_id   uuid not null,
  user_id     uuid not null references users(id) on delete cascade,
  token_hash  bytea not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index refresh_family_idx on refresh_tokens (family_id);

create table usage_hourly (
  tenant_id uuid not null references tenants(id) on delete cascade,
  hour      timestamptz not null,             -- truncated to hour UTC
  metric    text not null check (metric in
            ('ops','bytes_written','connections_peak','docs_created','docs_active')),
  value     bigint not null,
  primary key (tenant_id, hour, metric)
);

create table usage_gauges (                    -- current totals, updated by worker
  tenant_id uuid primary key references tenants(id) on delete cascade,
  documents bigint not null default 0,
  storage_bytes bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table invoices (
  id             uuid primary key,
  tenant_id      uuid not null references tenants(id) on delete cascade,
  period_start   date not null,
  period_end     date not null,
  status         text not null check (status in ('draft','open','paid','void')),
  line_items     jsonb not null,
  subtotal_cents integer not null,
  total_cents    integer not null,
  created_at     timestamptz not null default now(),
  unique (tenant_id, period_start)
);

create table webhook_endpoints (
  id          uuid primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  url         text not null,
  secret_enc  bytea not null,
  events      text[] not null,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now()
);

create table webhook_deliveries (
  id              uuid primary key,
  endpoint_id     uuid not null references webhook_endpoints(id) on delete cascade,
  tenant_id       uuid not null,
  event_id        uuid not null,
  event_type      text not null,
  payload         jsonb not null,
  status          text not null check (status in ('pending','success','retrying','dead')),
  attempt         integer not null default 0,
  response_code   integer,
  error           text,
  next_attempt_at timestamptz,
  created_at      timestamptz not null default now()
);
create index webhook_deliveries_ep_idx on webhook_deliveries (endpoint_id, created_at desc);

create table audit_log (
  id         bigserial primary key,
  tenant_id  uuid not null,
  actor_type text not null check (actor_type in ('user','api_key','system')),
  actor_id   text not null,
  action     text not null,                   -- e.g. 'api_key.created'
  target     text,
  meta       jsonb not null default '{}',
  prev_hash  bytea,
  hash       bytea not null,                  -- sha256(prev_hash || canonical_json(row fields))
  created_at timestamptz not null default now()
);
create index audit_tenant_idx on audit_log (tenant_id, id);
```

### 2.2 Data shard database (`syncra_shard_N`)

```sql
create table documents (
  uid           uuid primary key,
  tenant_id     uuid not null,
  collection    text not null,
  doc_id        text not null,
  head_seq      bigint not null default 0,
  snapshot_seq  bigint not null default 0,
  size_bytes    bigint not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (tenant_id, collection, doc_id)
);
create index documents_list_idx on documents (tenant_id, collection, doc_id)
  where deleted_at is null;
create index documents_purge_idx on documents (deleted_at) where deleted_at is not null;

create table operations (
  doc_uid    uuid not null,
  seq        bigint not null,
  tenant_id  uuid not null,
  client_id  text not null,
  op_refs    text[] not null,                 -- original client op ids merged in this row
  update     bytea not null,
  size       integer not null,
  created_at timestamptz not null default now(),
  primary key (doc_uid, seq)
) partition by hash (doc_uid);
-- create 16 partitions: operations_p0 .. operations_p15
-- create table operations_p0 partition of operations for values with (modulus 16, remainder 0);

create index operations_refs_idx on operations using gin (op_refs);
-- (global gin per partition; used for dedup lookups: where op_refs @> array[$1])

create table op_dedup (                        -- fast idempotency check
  doc_uid   uuid not null,
  client_id text not null,
  op_id     text not null,
  seq       bigint not null,
  created_at timestamptz not null default now(),
  primary key (doc_uid, client_id, op_id)
) partition by hash (doc_uid);
-- 16 partitions as above. Rows older than 7 days purged by worker.

create table snapshots (
  doc_uid    uuid not null,
  up_to_seq  bigint not null,
  tenant_id  uuid not null,
  kind       text not null check (kind in ('compaction','checkpoint')),
  state      bytea not null,
  size       integer not null,
  created_at timestamptz not null default now(),
  primary key (doc_uid, up_to_seq)
);
create index snapshots_kind_idx on snapshots (doc_uid, kind, created_at desc);

create table document_views (
  doc_uid    uuid primary key,
  tenant_id  uuid not null,
  seq        bigint not null,
  json       jsonb not null,
  updated_at timestamptz not null default now()
);

create table changes (
  change_id  bigserial primary key,
  tenant_id  uuid not null,
  collection text not null,
  doc_id     text not null,
  kind       text not null check (kind in ('create','update','delete')),
  seq        bigint,
  created_at timestamptz not null default now()
);
create index changes_feed_idx on changes (tenant_id, collection, change_id);
```

Implementation notes:
- `op_dedup` is the idempotency authority: on write, insert each client op id with `on conflict do nothing`; if any already exists, reuse its stored `seq` for the ACK and skip persisting that update.
- Every migration is a numbered `.sql` file under `apps/server/src/db/migrations/{control,shard}/`.
- Shard migrations run on every shard at startup of the `migrate` one-shot compose service, not in the server process.

## 3. Redis key schema

| Key or channel | Type | TTL | Purpose |
|---|---|---|---|
| `sx:doc:{tid}:{docKey}:ch` | pub/sub channel | n/a | Update fan-out. Binary payload: varUint seq, varString originNode, varString originClient, varUint8Array update |
| `sx:aw:{tid}:{docKey}` | hash clientId to JSON | 60 s (refreshed) | Presence snapshot |
| `sx:aw:{tid}:{docKey}:ch` | pub/sub channel | n/a | Awareness fan-out |
| `sx:rl:{scope}:{id}` | hash (tokens, ts) | 120 s | Token buckets |
| `sx:usage:{tid}:{yyyymmddhh}` | hash metric to int | 3 h | Usage counters flushed hourly by worker |
| `sx:quota:{tid}` | hash (plan, limits JSON, blocked flags) | 60 s | Cached quota state, refreshed by worker and on plan change |
| `sx:cache:snap:{docUid}` | string (zlib bytes) | 300 s | Hot snapshot cache with `seq` header |
| `sx:lock:compact:{docUid}` | string | 120 s | Compaction mutex |
| `sx:node:{nodeId}` | hash (heartbeat, conns, hotDocs, startedAt) | 15 s | Node liveness for monitor |
| `sx:nodes` | zset nodeId by heartbeat ts | none | Node registry |
| `sx:conn:{tid}` | counter | none (reconciled) | Concurrent connections per tenant; reconcile from `sx:node:*` every 30 s |
| `sx:apikey:{sha256hex}` | JSON (tenant, kind, status) | 60 s | API key lookup cache |
| `sx:tenantkey:{tid}` | bytes (decrypted signing secret, in process memory preferred) | 60 s | Avoid DB per token validation (use in-process LRU instead; Redis only if needed) |
| `sx:idem:{key}` | JSON | 24 h | REST idempotency |
| `sx:mat:{docUid}` | string | 5 s | Debounce marker for materialization |

## 4. REST API

### 4.1 Auth and account (dashboard)

| Method and path | Auth | Request | Response |
|---|---|---|---|
| POST `/auth/signup` | P | `{email, password, name, tenantName}` | `201 {accessToken, user, tenant, keys:{secret, publishable}}` plus refresh cookie. Secret key shown only here |
| POST `/auth/login` | P | `{email, password}` | `{accessToken, user, memberships[]}` plus refresh cookie |
| POST `/auth/refresh` | cookie | none | `{accessToken}` and rotated cookie |
| POST `/auth/logout` | cookie | none | `204` |
| GET `/me` | D | none | `{user, memberships[], activeTenant}` |
| POST `/auth/accept-invite` | P | `{token, password?, name?}` | `{accessToken}` |

Active tenant selection: dashboard sends header `X-Tenant-Id`; server verifies membership.

### 4.2 Tenant, members, keys

| Method and path | Auth | Description |
|---|---|---|
| GET `/tenant` | D | Tenant info, plan, quotas, usage gauges |
| PATCH `/tenant` | D (owner/admin) | `{name}`; plan change `{plan}` owner only |
| DELETE `/tenant` | D (owner) | Soft delete; schedules purge |
| GET `/tenant/members` | D | Members and invitations |
| POST `/tenant/invitations` | D (owner/admin) | `{email, role}` returns invite URL (logged by console mailer) |
| PATCH `/tenant/members/{userId}` | D (owner/admin) | `{role}` |
| DELETE `/tenant/members/{userId}` | D (owner/admin) | Remove |
| GET `/keys` | D | List with prefix, kind, last used, revoked |
| POST `/keys` | D | `{kind, name}` returns full key once |
| DELETE `/keys/{id}` | D | Revoke |
| POST `/tokens` | S | Mint client token (below) |
| GET `/audit` | D (owner/admin) | Paginated audit rows; `?verify=true` returns `{valid, brokenAtId}` |

**POST /tokens**

Request:
```json
{
  "userId": "user_123",
  "ttlSeconds": 3600,
  "access": [
    { "collection": "inspections", "docs": "*", "mode": "rw" },
    { "collection": "templates", "docs": ["tpl_1", "tpl_2"], "mode": "r" }
  ],
  "meta": { "name": "Dana", "color": "#7c3aed" }
}
```
Response: `{ "token": "eyJ...", "expiresAt": "2026-10-26T12:00:00Z" }`

Client token JWT claims: `{ iss: "syncra", tid, sub (userId), access, meta, iat, exp, jti }`, header `{ alg: "HS256", kid: tid }`. `ttlSeconds` max 86,400, default 3,600. `meta` max 2 KB, exposed to awareness defaults.

### 4.3 Collections and documents (S, D)

| Method and path | Auth | Description |
|---|---|---|
| GET `/collections` | S, D | List collections with doc counts and sizes |
| GET `/collections/{c}/docs` | S, D | List docs. Query: `limit, cursor, prefix, updatedSince` |
| POST `/collections/{c}/docs` | S, D | Create `{id?, initial?}`. `initial` is a JSON object written into root Y.Map `data`. Returns `201 {id, seq}` |
| GET `/collections/{c}/docs/{id}` | S, D | Returns `{id, collection, seq, sizeBytes, createdAt, updatedAt, json}`; `?fresh=true` loads live state |
| GET `/collections/{c}/docs/{id}/state` | S, D | Binary Yjs update (`application/octet-stream`) |
| DELETE `/collections/{c}/docs/{id}` | S, D | Soft delete |
| GET `/collections/{c}/docs/{id}/history` | S, D | Checkpoints `[{seq, createdAt, sizeBytes}]` |
| GET `/collections/{c}/docs/{id}/history/{seq}` | S, D | JSON at checkpoint (or nearest at or before seq) |
| POST `/collections/{c}/docs/{id}/restore` | S, D (developer+) | `{seq}` non-destructive restore |
| GET `/collections/{c}/docs/{id}/ops` | D | Raw op metadata list `?after&limit` (no payload bytes) |
| GET `/collections/{c}/docs/{id}/export` | S, D | `?format=json|yjs` |

Root type conventions: record documents use root `Y.Map` named `data`; text documents use `Y.XmlFragment` named `content` (Tiptap) or `Y.Text` named `text`; list documents use `Y.Array` named `list`. The materializer converts every root type present via `toJSON()` into `{data: ..., content: ..., text: ..., list: ...}`.

### 4.4 HTTP sync fallback (C)

| Method and path | Request | Response |
|---|---|---|
| POST `/sync/{c}/{id}/pull` | `{stateVector: base64url}` | `{update: base64url, seq, stateVector: base64url}` |
| POST `/sync/{c}/{id}/push` | `{clientId, opId, update: base64url}` | `{seq}` |

Same checks as WebSocket (access, size, rate limit, quota). `push` is idempotent on `(clientId, opId)`.

### 4.5 Change feed

| Method and path | Auth | Description |
|---|---|---|
| GET `/changes` | S, D | `?collection&cursor&limit` returns `{items:[{kind, collection, docId, seq, at}], nextCursor}` |
| GET `/changes/stream` | S | Server-Sent Events; `Last-Event-ID` resumes from cursor; heartbeat comment every 15 s |

### 4.6 Usage and billing

| Method and path | Auth | Description |
|---|---|---|
| GET `/usage` | D | `?from&to&metric&granularity=hour|day` time series |
| GET `/usage/current` | D, S | `{plan, period, quotas:{docs:{used,limit}, storageBytes:{...}, ops:{...}, connections:{...}}}` |
| GET `/invoices` | D (owner/admin) | List |
| GET `/invoices/{id}` | D (owner/admin) | JSON invoice |
| GET `/invoices/{id}/pdf` | D (owner/admin) | PDF (S priority) |

### 4.7 Webhooks

| Method and path | Auth | Description |
|---|---|---|
| GET `/webhooks` | D | List endpoints |
| POST `/webhooks` | D | `{url, events[]}` returns signing secret once (`whsec_...`) |
| PATCH `/webhooks/{id}` | D | `{url?, events?, enabled?}` |
| DELETE `/webhooks/{id}` | D | Remove |
| POST `/webhooks/{id}/test` | D | Sends `webhook.test` event |
| GET `/webhooks/{id}/deliveries` | D | Delivery log |
| POST `/webhooks/deliveries/{id}/retry` | D | Re-enqueue |

### 4.8 Monitoring

| Method and path | Auth | Description |
|---|---|---|
| GET `/monitor/stream` | D | SSE with 1 s ticks: ops per second, connections, ack p95, hot docs, per-node stats for the tenant (system-wide stats only in selfhost mode or for operators) |
| GET `/monitor/nodes` | D (operator flag) | Node list from Redis |
| GET `/healthz` | P | Liveness |
| GET `/readyz` | P | Readiness (checks Redis, control DB, each shard) |
| GET `/metrics` | Basic auth with `METRICS_TOKEN` or internal network only | Prometheus text |

## 5. WebSocket protocol

### 5.1 Handshake

`GET /v1/connect?token={jwt}&clientId={uuid}&v=1` with `Upgrade: websocket`. `clientId` is a UUID persisted per browser profile and device (stored in IndexedDB meta). Server validates and either completes the upgrade or rejects with HTTP 401/403/429 before upgrade. Query token must be redacted in logs.

### 5.2 Framing

All frames are binary. Encoding uses lib0 `encoding`/`decoding` (varUint, varString, varUint8Array). Frame layout:

`[varUint messageType][varString docKey][...fields]` where `docKey` is `collection/docId`, or empty string for connection-level messages.

### 5.3 Message types

| Type | Name | Direction | Fields after docKey | Notes |
|---|---|---|---|---|
| 0 | SUBSCRIBE | C to S | varUint flags (bit0 = request read-only) | Starts document session |
| 1 | SUBSCRIBED | S to C | varUint headSeq, varUint access (0 read, 1 read-write) | Reply to subscribe |
| 2 | SYNC_STEP1 | both | varUint8Array stateVector | Sender asks for missing updates |
| 3 | SYNC_STEP2 | both | varUint8Array update, varUint seq (server to client only; client sends 0) | Reply with missing updates |
| 4 | UPDATE | C to S | varString opId, varUint8Array update | Live edit; server persists then ACKs |
| 5 | UPDATE_BROADCAST | S to C | varUint seq, varString originClientId, varUint8Array update | Update from another client |
| 6 | ACK | S to C | varString opId, varUint seq | Durable acknowledgment |
| 7 | AWARENESS | both | varUint8Array awarenessUpdate | y-protocols awareness encoding |
| 8 | UNSUBSCRIBE | C to S | none | Leave document |
| 9 | ERROR | S to C | varString code, varString message, varUint retryAfterMs | docKey may be empty (connection-level) |
| 10 | PING | both | varUint timestampMs | Every 25 s from client |
| 11 | PONG | both | varUint timestampMs (echo) | Reply |
| 12 | RESYNC_HINT | S to C | varUint headSeq | Server asks client to run SYNC_STEP1 again (after gap recovery or restore) |

### 5.4 Sequence: first sync

```
Client                               Server
  | SUBSCRIBE(docKey)                  |
  |----------------------------------->|
  |            SUBSCRIBED(headSeq,rw)  |
  |<-----------------------------------|
  | SYNC_STEP1(sv_client)              |
  |----------------------------------->|
  |  SYNC_STEP2(missing, seq)          |
  |<-----------------------------------|
  |  SYNC_STEP1(sv_server)             |
  |<-----------------------------------|
  | SYNC_STEP2(client_extra, 0)        |
  |----------------------------------->|   server persists, ACKs via ACK(syncOpId)
  | ... live ...                       |
  | UPDATE(opId, u)                    |
  |----------------------------------->|   persist -> ACK -> broadcast
  |                         ACK(opId)  |
  |<-----------------------------------|
```

For the client's `SYNC_STEP2`, the SDK generates an `opId` of the form `sync:{clientId}:{counter}` and the server ACKs it with `ACK` so the outbox can be cleared.

### 5.5 Close codes

| Code | Meaning | Client action |
|---|---|---|
| 1000 | Normal | None |
| 1001 | Server going away (rolling restart) | Reconnect with 0 to 2 s jitter |
| 1013 | Try again later (backpressure) | Reconnect with backoff |
| 4001 | Unauthenticated or invalid token | Call `getToken()`, retry once, else `auth-expired` |
| 4003 | Forbidden | Surface error, do not retry |
| 4008 | Rate limited | Backoff using `retryAfterMs` if provided |
| 4009 | Payload too large | Surface error for that update |
| 4010 | Token expired | Refresh token then reconnect |
| 4402 | Quota exceeded (connections) | Enter `quota-blocked`, retry with long backoff |
| 4500 | Internal error | Backoff |

Per-document quota errors (ops, storage, docs) use an ERROR frame (not a close) with code `QUOTA_EXCEEDED`; the client moves that document or connection into `quota-blocked` and keeps its outbox.

### 5.6 Heartbeats and timeouts

- Client sends PING every 25 s. Server replies PONG. Server closes a connection with no traffic for 60 s. Nginx `proxy_read_timeout 75s`.
- Client declares the connection dead if no PONG within 10 s and reconnects.
- Server also sends WebSocket protocol-level pings every 30 s to detect half-open TCP connections.

## 6. Error model

REST error body:
```json
{ "error": { "code": "QUOTA_EXCEEDED", "message": "Monthly ops quota reached",
             "details": { "metric": "ops", "limit": 1000000 }, "requestId": "req_01H..." } }
```

| Code | HTTP | Retryable | Meaning |
|---|---|---|---|
| UNAUTHENTICATED | 401 | yes after refresh | Missing, invalid or expired credentials |
| FORBIDDEN | 403 | no | Authenticated but not permitted |
| NOT_FOUND | 404 | no | Resource missing or soft deleted |
| CONFLICT | 409 | no | Duplicate resource (slug, email, doc id with different collection) |
| VALIDATION_FAILED | 422 | no | Bad input or malformed update |
| PAYLOAD_TOO_LARGE | 413 | no | Body or update exceeds limit |
| RATE_LIMITED | 429 | yes | Honor `Retry-After` and `retryAfterMs` |
| QUOTA_EXCEEDED | 402 | yes after quota change | Plan limit reached |
| UNAVAILABLE | 503 | yes | Dependency down (shard, Redis) |
| INTERNAL | 500 | yes | Unexpected error |

## 7. Webhook events

Delivery: HTTP POST, `Content-Type: application/json`, 10 s timeout, success on any 2xx.

Headers:
- `Syncra-Event: document.updated`
- `Syncra-Delivery: <uuid>`
- `Syncra-Signature: t=1766752800,v1=<hex(hmac_sha256(secret, t + "." + rawBody))>`

Envelope:
```json
{ "id": "evt_...", "type": "document.updated", "createdAt": "2026-10-26T10:00:00Z",
  "tenantId": "...", "data": { "collection": "inspections", "docId": "site-42", "seq": 1288 } }
```

| Event | Data fields |
|---|---|
| `document.created` | collection, docId |
| `document.updated` | collection, docId, seq (debounced to at most 1 per second per document) |
| `document.deleted` | collection, docId |
| `quota.warning` | metric, used, limit, percent (80) |
| `quota.exceeded` | metric, used, limit |
| `webhook.test` | message |

Retry schedule: 8 attempts at 10 s, 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 12 h; then status `dead`. SSRF guard: resolve DNS and block loopback, link-local and private ranges unless `WEBHOOK_ALLOW_PRIVATE=true`.

## 8. Background jobs (BullMQ)

| Queue and job | Trigger | Concurrency | Retry | Description |
|---|---|---|---|---|
| `doc:snapshot` | Op threshold event, idle timer | 8 | 5, exponential | Section 4.7 of Doc 02 |
| `doc:compact` | After snapshot | 4 | 3 | Delete superseded ops, verify |
| `doc:checkpoint` | Repeatable per active doc, every 5 min | 8 | 3 | History checkpoint |
| `doc:materialize` | Debounced after writes | 16 | 5 | JSON view and change feed |
| `doc:purge` | Repeatable hourly | 2 | 3 | Hard delete soft-deleted docs older than 7 days; clear `op_dedup` older than 7 days |
| `usage:flush` | Repeatable hourly (and on demand) | 1 | 5 | Move Redis counters to `usage_hourly` |
| `usage:gauges` | Repeatable every 60 s | 1 | 3 | Refresh `usage_gauges` and quota cache |
| `billing:invoice` | Repeatable on day 1 of month, 00:10 UTC | 1 | 3 | Generate invoices |
| `webhook:deliver` | On event | 16 | custom schedule | Section 7 |
| `audit:verify` | Repeatable daily | 1 | 1 | Verify hash chain, alert on break |

Dead-letter handling: failed jobs after final retry go to a `failed` set and are visible via the dashboard monitor and metrics (`syncra_queue_depth{queue="failed"}`).

## 9. Environment variables

| Variable | Default | Used by | Description |
|---|---|---|---|
| NODE_ENV | development | all | development, test, production |
| PORT | 8080 | server | HTTP and WS port |
| NODE_ID | hostname | server, worker | Unique node id |
| PUBLIC_URL | http://localhost:8080 | server | External base URL |
| CORS_ORIGINS | http://localhost:5173 | server | Comma list |
| CONTROL_DATABASE_URL | required | server, worker | Control-plane Postgres |
| SHARD_DATABASE_URLS | required | server, worker | Comma list of shard Postgres URLs |
| REDIS_URL | required | server, worker | Redis URL |
| JWT_ACCESS_SECRET | required | server | Dashboard access token secret (32+ bytes) |
| ENCRYPTION_KEY | required | server, worker | 32 bytes base64 for AES-256-GCM |
| METRICS_TOKEN | empty | server, worker | If set, `/metrics` requires Basic auth password |
| LOG_LEVEL | info | all | pino level |
| OTEL_EXPORTER_OTLP_ENDPOINT | empty | server, worker | Enables tracing |
| BILLING_ENABLED | false | server, worker | Enforce plans and quotas |
| DEFAULT_PLAN | selfhost | server | Plan for new tenants (`free` when BILLING_ENABLED=true) |
| BATCH_WINDOW_MS | 20 | server | Write batcher window |
| BATCH_MAX_BYTES | 262144 | server | Flush threshold |
| SNAPSHOT_EVERY_OPS | 500 | worker | Snapshot trigger |
| SNAPSHOT_EVERY_BYTES | 1048576 | worker | Snapshot trigger |
| SNAPSHOT_IDLE_MS | 60000 | worker | Idle snapshot trigger |
| CHECKPOINT_INTERVAL_MS | 300000 | worker | History checkpoints |
| HOT_DOC_CACHE_MAX | 500 | server | LRU capacity |
| HOT_DOC_IDLE_MS | 60000 | server | Evict idle docs |
| MAX_UPDATE_BYTES | 1048576 | server | Max single update |
| MAX_MESSAGE_BYTES | 2097152 | server | Max WS frame |
| MAX_DOC_BYTES | per plan | server | Override |
| WS_OUTBOUND_HIGH_WATER | 1048576 | server | Backpressure threshold |
| WS_SLOW_CLOSE_MS | 15000 | server | Close slow consumer after |
| RL_CONN_RATE | 100 | server | Messages per second per connection |
| RL_CONN_BURST | 200 | server | Burst |
| RL_IP_RATE | 20 | server | REST per IP |
| RL_AUTH_PER_MIN | 5 | server | Login and signup attempts per minute per IP |
| WEBHOOK_ALLOW_PRIVATE | false | worker | Allow private IP targets |
| SEED_DEMO_TENANT | true in dev | migrate | Create demo tenant and print keys |

## 10. Limits summary

| Item | Default |
|---|---|
| Document id | 1 to 128 chars, `^[A-Za-z0-9_.:-]+$` |
| Collection name | 1 to 64 chars, `^[a-z][a-z0-9_-]*$`; names starting with `__` reserved for SDK index docs |
| Single update | 1 MB |
| WS message | 2 MB |
| REST body | 1 MB |
| Subscriptions per connection | 200 |
| Awareness state size | 8 KB |
| Awareness updates per client | 20 per second |
| Client token TTL | max 24 h |
| Token `meta` | 2 KB |
| Concurrent connections per client id | 1 per leader tab (extra connections with same clientId replace the old one) |
