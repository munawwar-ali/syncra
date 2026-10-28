# Syncra - Engineering and Build Plan
Document 05 of 06 | Repo, phases, tasks, tests, DevOps | Version 1.0 | 26 Oct 2026

## 1. Repository layout

```
syncra/
  CLAUDE.md  README.md  LICENSE  CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md
  package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json
  eslint.config.js  .prettierrc  .editorconfig  .env.example  .changeset/
  .github/workflows/  ci.yml  release.yml  deploy.yml  docs.yml
  apps/
    server/                 sync node: REST + WebSocket
      src/
        main.ts  config.ts
        http/               routes (auth, tenant, keys, tokens, docs, changes, usage, webhooks, monitor)
        ws/                 gateway, connection, session, router, handlers
        core/               doc-store, hot-cache, write-batcher, fanout, presence, snapshot-reader
        shards/             ring.ts, shard-pool.ts, routing.ts
        auth/               jwt.ts, api-keys.ts, passwords.ts, access.ts, crypto.ts
        limits/             token-bucket.ts, lua/, quota.ts, usage-counters.ts
        redis/              client.ts, pubsub.ts
        observability/      metrics.ts, logger.ts, tracing.ts
        db/                 kysely.ts, types.ts, migrations/control/, migrations/shard/
        demo/               demo token endpoint, chaos controller (DEMO_MODE only)
    worker/                 BullMQ worker
      src/ main.ts config.ts jobs/ (snapshot, compact, checkpoint, materialize, purge,
           usage-flush, usage-gauges, invoice, webhook-deliver, audit-verify)
    dashboard/              React admin UI
    demo-notes/             collaborative notes demo
    demo-inspection/        field inspection PWA demo
  packages/
    protocol/  shared/  client/  react/  testkit/
  infra/
    docker/     Dockerfile.server  Dockerfile.worker  Dockerfile.web  Dockerfile.migrate
    compose/    docker-compose.yml  docker-compose.dev.yml  docker-compose.loadtest.yml
    nginx/      nginx.conf  conf.d/
    prometheus/ prometheus.yml  alerts.yml
    grafana/    provisioning/  dashboards/syncra.json
    terraform/  (optional) main.tf variables.tf outputs.tf
  loadtest/
    k6/  scenarios (ws-steady.js, ws-spike.js, reconnect-storm.js, hot-doc.js)
    chaos/  kill-node.sh  stop-redis.sh  stop-shard.sh  toxiproxy.sh
    results/  (committed result files with environment descriptions)
  docs/
    spec/ (these seven documents)  adr/  architecture.md  protocol.md  api.md (+ openapi.yaml)
    getting-started.md  sdk.md  self-hosting.md  security.md  sharding.md  capacity.md
    benchmarks.md  traceability.md  assets/ (diagrams, gifs, screenshots)
  scripts/  seed.ts  gen-keys.ts  admin-cli.ts  verify-env.ts
```

## 2. Local development

Commands (root `package.json` scripts):

| Script | Action |
|---|---|
| `pnpm dev` | Starts compose dependencies (Postgres x3, Redis), runs migrations, starts server, worker, dashboard (Vite) and demos in watch mode via Turborepo |
| `pnpm build` | Build all packages and apps |
| `pnpm lint` | ESLint across the monorepo |
| `pnpm typecheck` | `tsc --noEmit` across projects |
| `pnpm test` | Unit tests (Vitest, no containers) |
| `pnpm test:integration` | Integration tests with Testcontainers (Postgres, Redis) |
| `pnpm test:e2e` | Playwright against built apps and compose stack |
| `pnpm loadtest` | k6 scenarios against local compose |
| `pnpm compose:up` | Production-like stack: `docker compose -f infra/compose/docker-compose.yml up --build` |
| `pnpm db:migrate` | Run control and shard migrations |
| `pnpm seed` | Seed demo tenant, users, sample docs, print keys |

## 3. Phases and tasks

Rules: complete phases in order. Each task ends with tests, lint, typecheck and a commit. After the final task of a phase, run all of that phase's acceptance tests and update `docs/traceability.md`.

### Phase 0: Scaffold (about 1 to 2 days of agent work)

| Task | Description |
|---|---|
| P0-T01 | Initialize pnpm workspace, Turborepo, shared tsconfig, ESLint, Prettier, EditorConfig, Husky and lint-staged, Changesets |
| P0-T02 | Create package and app skeletons per section 1 with build scripts and minimal exports |
| P0-T03 | `packages/shared`: `SyncraError`, error codes (Doc 03 section 6), common Zod schemas (ids, pagination), constants |
| P0-T04 | `apps/server`: Fastify bootstrap, config loader with Zod, pino logger with request IDs, `/healthz`, `/readyz`, `/metrics` skeleton |
| P0-T05 | Compose file with `pg-control`, `pg-shard-0`, `pg-shard-1`, `redis`; healthchecks; `.env.example` |
| P0-T06 | Migration runner (`apps/server/src/db/migrate.ts`) for control and shard schemas using node-pg-migrate; implement DDL from Doc 03 section 2 |
| P0-T07 | GitHub Actions `ci.yml`: install, lint, typecheck, unit tests, build, with caching |
| P0-T08 | `docs/` skeleton, ADR template, traceability table, CONTRIBUTING and CODE_OF_CONDUCT |

Acceptance (Phase 0):
- A0-1: `pnpm install && pnpm build && pnpm lint && pnpm typecheck && pnpm test` pass on a clean clone.
- A0-2: `docker compose up pg-control pg-shard-0 pg-shard-1 redis` becomes healthy; `pnpm db:migrate` creates all tables including 16 partitions per partitioned table.
- A0-3: `GET /readyz` returns 200 only when Redis, control DB and both shards are reachable; returns 503 when any is stopped.

### Phase 1: Single-node sync core

| Task | Description |
|---|---|
| P1-T01 | `packages/protocol`: encode and decode for every message type in Doc 03 section 5.3 with exhaustive unit tests and fuzz tests (random bytes never crash the decoder) |
| P1-T02 | Shard ring (`ring.ts`) with 64 virtual nodes, xxhash, unit tests for distribution (within 15% skew over 100k keys) and stability when adding a shard (about 1/N keys move) |
| P1-T03 | `doc-store`: create document, load document (snapshot + tail), append op in a transaction with seq allocation, `op_dedup` idempotency |
| P1-T04 | `write-batcher`: per-document buffers, merge via `Y.mergeUpdates`, flush by window or size, fairness across docs, graceful flush on shutdown |
| P1-T05 | `hot-cache`: LRU with idle eviction, memory guard, per-tenant keys |
| P1-T06 | WebSocket gateway: upgrade handling, token verification (temporary static dev secret in this phase), connection object, heartbeat and idle timeout, message router |
| P1-T07 | Handlers: SUBSCRIBE, SYNC_STEP1/2, UPDATE, UNSUBSCRIBE, PING, awareness passthrough (local only); ACK after durable commit; broadcast to local subscribers |
| P1-T08 | Minimal Node client in `packages/client` (memory storage only): connect, subscribe, sync, send updates, receive broadcast |
| P1-T09 | Integration tests with Testcontainers: two clients converge; ACK after restart durability; duplicate update idempotency; oversized update rejection |

Acceptance (Phase 1):
- A1-1 (SYN-02, SYN-03): two clients on one server converge after concurrent edits; delta payload proportional to diff.
- A1-2 (SYN-04): hard-kill the server after an ACK; restart; document contains the update.
- A1-3 (SYN-05, SYN-06): repeated and rapid updates yield correct state and bounded op rows.
- A1-4 (SYN-07, SYN-08): load path reads snapshot plus tail only (when a snapshot is inserted manually); concurrent writers receive gap-free seqs.
- A1-5 (SYN-11): protocol fuzz test passes; oversized update returns PAYLOAD_TOO_LARGE.

### Phase 2: Offline-first client

| Task | Description |
|---|---|
| P2-T01 | `LocalStore` over IndexedDB (use the `idb` library) with the stores in Doc 04 section 6; migrations; fake-indexeddb for unit tests |
| P2-T02 | Update pipeline: Y.Doc update to updates log and outbox in one transaction; serialized writer; batching (50 ms) with merge |
| P2-T03 | State machine implementation and tests for every transition row in Doc 04 section 5 |
| P2-T04 | `NetworkMonitor` (online/offline events plus probe), backoff with full jitter, token manager (`getToken` lifecycle) |
| P2-T05 | Sync engine: subscribe, delta handshake, ACK handling, outbox drain, reconnect behavior, queue pressure coalescing |
| P2-T06 | `TabCoordinator`: Web Locks leader election, BroadcastChannel relay, localStorage fallback, leader change resync |
| P2-T07 | Collections via index documents (CLI-13); `SyncraCollection` API |
| P2-T08 | Optional Zod schema validation (CLI-10); `clearLocalData` and `destroy` (CLI-12); storage-full handling (CLI-11) |
| P2-T09 | `packages/react`: provider and hooks per Doc 04 section 4 using `useSyncExternalStore`; hook tests |
| P2-T10 | `packages/testkit`: fake network (latency, jitter, drop, duplicate, reorder, partition) and in-process server harness |
| P2-T11 | Property-based convergence tests with fast-check (N clients, random ops, random partitions) |
| P2-T12 | `apps/demo-notes` minimal version (Tiptap, presence, sync badge, offline banner) and Playwright test for the scripted scenario in Doc 04 section 10.1 steps 1 to 5 |

Acceptance (Phase 2):
- A2-1 (CLI-01, CLI-02): Playwright test: go offline, edit, close tab, reopen, edits present, go online, server has edits.
- A2-2 (CLI-03, CLI-04): state machine and backoff unit tests pass with full transition coverage.
- A2-3 (CLI-06): three tabs share one server connection; closing the leader transfers leadership in under 3 s without losing edits.
- A2-4 (CLI-07): 10,000 local edits keep IndexedDB size bounded (assert under a defined threshold).
- A2-5: property tests with at least 200 randomized runs converge every time.
- A2-6 (DEM-01 partial): scripted notes scenario steps 1 to 5 pass in Playwright.

### Phase 3: Control plane, security and limits

| Task | Description |
|---|---|
| P3-T01 | Crypto utilities: AES-256-GCM encrypt/decrypt, SHA-256 hashing, constant-time compare, key generation formats (`sk_live_`, `pk_live_`, `whsec_`) |
| P3-T02 | Auth: signup, login, refresh rotation with family revocation, logout, argon2id; Zod validation; auth rate limits |
| P3-T03 | Tenants, memberships, role permission middleware (matrix in Doc 01 section 4.3.1); invitations (console mailer) |
| P3-T04 | API keys: create, list, revoke; hashed storage; lookup cache with 60 s TTL; `last_used_at` batched updates |
| P3-T05 | Client tokens: `POST /tokens` and JWT verification in WS and HTTP fallback with per-tenant signing secrets; access rules enforcement incl. read-only mode (SYN-12) |
| P3-T06 | Tenant isolation test suite (AUT-07): attempts through every REST route and WS message type with a second tenant's credentials |
| P3-T07 | Token-bucket limiter with Redis Lua; connection, tenant, IP and auth scopes; in-process fallback; metrics |
| P3-T08 | Quotas and usage counters in Redis; quota cache; enforcement points (doc create, write, connection); `QUOTA_EXCEEDED` handling in WS and REST; client `quota-blocked` behavior (OPS-05) |
| P3-T09 | Worker app skeleton with BullMQ; `usage:flush`, `usage:gauges` jobs; usage API endpoints |
| P3-T10 | Webhooks: endpoint CRUD, signing, delivery job, retry schedule, SSRF guard, delivery log; tenant events (document and quota) |
| P3-T11 | REST documents API (Doc 03 section 4.3 except history and restore) and HTTP sync fallback; OpenAPI generation from Zod |
| P3-T12 | Hash-chained audit log (AUT-08) and verification endpoint and job |
| P3-T13 | Seed script and demo token endpoint (`DEMO_MODE`) |

Acceptance (Phase 3):
- A3-1 (AUT-01 to AUT-06): full auth and key flows covered by integration tests; refresh reuse revokes the family.
- A3-2 (AUT-07): isolation suite passes; any new route without an isolation test fails CI (route inventory test).
- A3-3 (OPS-01, OPS-02 partial): flooding a connection yields RATE_LIMITED without affecting another connection.
- A3-4 (OPS-03, OPS-05): free-plan quota reached blocks writes; client enters `quota-blocked`; after plan change, outbox drains automatically (Playwright or testkit integration).
- A3-5 (OPS-06): webhook receiver test server validates signatures; failing endpoint shows retries and `dead` state after final attempt (use accelerated schedule in tests).
- A3-6 (SYN-12): read-only token cannot modify a document.

### Phase 4: Scale-out and data lifecycle

| Task | Description |
|---|---|
| P4-T01 | Redis fan-out: publish after commit, subscribe per document channel with refcounts, binary payloads, local forward; origin suppression |
| P4-T02 | Gap detection and recovery (Doc 02 section 4.5) including periodic head_seq reconciliation and degraded mode when Redis is down (OPS-11) |
| P4-T03 | Presence across nodes (COL-01, COL-02): Redis hash with TTL, pub/sub, cleanup on disconnect |
| P4-T04 | Shard routing integrated into all data access; two-shard integration tests; `readyz` per shard |
| P4-T05 | Node registry and heartbeats in Redis; graceful shutdown (SIGTERM: stop accepting, close 1001, flush batches, deregister) (SYN-10) |
| P4-T06 | Backpressure on server (OPS-02): high-water mark, merged pending updates, slow consumer close 1013 |
| P4-T07 | Worker: `doc:snapshot` and `doc:compact` with locking, verification and metrics (DAT-01, DAT-02, DAT-10) |
| P4-T08 | Worker: `doc:materialize`, change feed rows, `/changes` and `/changes/stream` (DAT-03, DAT-08) |
| P4-T09 | Worker: `doc:checkpoint`, history endpoints, restore (DAT-04, DAT-05), export (DAT-09) |
| P4-T10 | Worker: `doc:purge` and soft delete flow (DAT-07) |
| P4-T11 | Nginx config and compose production profile with `--scale server=3`; WebSocket upgrade, `least_conn`, timeouts |
| P4-T12 | Multi-node integration tests using compose or Testcontainers networks |

Acceptance (Phase 4):
- A4-1 (SYN-03 across nodes): clients attached to different nodes see each other's edits within 150 ms p95 locally.
- A4-2: kill one of three nodes under client load; clients reconnect and converge; zero lost acknowledged updates (verify by comparing client-acked ops with server state).
- A4-3 (OPS-11): stop Redis for 20 s during edits; clients on the same node continue; after restart, cross-node convergence completes.
- A4-4 (DAT-01, DAT-02, DAT-10): a document with 20,000 ops is snapshotted and compacted; load reads under 600 ops; state vector equality verified; size reduction recorded.
- A4-5 (DAT-08): change feed consumer resumes by cursor with no duplicates or gaps.
- A4-6 (DAT-04 to DAT-05): checkpoint list and restore work; current state equals checkpoint after restore; history contains both.
- A4-7 (SYN-10): rolling restart test passes.
- A4-8: shard distribution test shows documents spread across both shards within 20% balance.

### Phase 5: Dashboard, observability and billing

| Task | Description |
|---|---|
| P5-T01 | Dashboard scaffold: Vite, routing, auth context with refresh, API client with TanStack Query, design tokens, layout, dark mode |
| P5-T02 | Pages: Overview (SSE charts), Collections, Documents, Keys, Usage, Webhooks, Members, Settings (DSH-01 to DSH-08) |
| P5-T03 | Document inspector with ops list, history slider (time-travel), restore (DSH-04) |
| P5-T04 | Live monitor page and `/monitor/stream` endpoint, node list (DSH-10), audit page with verify (DSH-09) |
| P5-T05 | Playground page (DX-06) |
| P5-T06 | Metrics instrumentation across server and worker per Doc 02 section 14; Prometheus config and alert rules; Grafana provisioned dashboard JSON with panels for connections, ops/s, ack p95, fanout lag, hot docs, queue depth, compaction savings, rate limits |
| P5-T07 | Billing: plan definitions, invoice generation job and calculator (BIL-02), invoice HTML view and PDF (BIL-03) |
| P5-T08 | OpenTelemetry tracing setup (optional), request ID propagation into worker jobs (OPS-09) |
| P5-T09 | Load tests: k6 scenarios, result capture scripts, `docs/benchmarks.md` generation with environment details |
| P5-T10 | Chaos scripts and tests: kill node, stop Redis, stop shard, network latency and loss via Toxiproxy; results documented |
| P5-T11 | Playwright dashboard e2e and axe accessibility checks |

Acceptance (Phase 5):
- A5-1 (DSH-02, DSH-10): during a k6 run, dashboard charts update every second; stopping a node removes it from the monitor within 15 s.
- A5-2 (OPS-08): Grafana loads from `docker compose up` with data and no manual setup.
- A5-3 (BIL-02): invoice calculator unit tests cover plan base fee, overage ops, overage storage, zero usage, partial months.
- A5-4: `docs/benchmarks.md` contains measured results from committed scripts for: steady state (connections, ops/s, ack p95), reconnect storm, hot document fan-out, compaction effect (before and after), node failure recovery time. Environment spec included.
- A5-5: axe reports no critical violations on all dashboard pages.

### Phase 6: Demos, docs and launch readiness

| Task | Description |
|---|---|
| P6-T01 | Finish `demo-notes`: chaos panel, "server view" panel, polish, all scenario steps (DEM-01, DEM-04) |
| P6-T02 | Build `demo-inspection` PWA fully (DEM-02) with 5,000-site virtualized list and role split |
| P6-T03 | Seed script produces demo tenant, sample notes, sites, templates; compose prints the dashboard URL and demo keys on first start (DX-03) |
| P6-T04 | Documentation: getting-started (15-minute quickstart), SDK guide, self-hosting guide, architecture overview with diagrams (Mermaid), protocol doc, security doc, sharding doc, capacity doc, FAQ, comparison page (Doc 06 rules) |
| P6-T05 | VitePress docs site and `docs.yml` deploy workflow (DX-05) |
| P6-T06 | README per Doc 06 blueprint; record GIFs and the demo video script assets (scripted by Playwright screenshots where possible) |
| P6-T07 | Release workflow: build and push Docker images to GHCR, publish packages (dry-run by default), GitHub Release notes from Changesets |
| P6-T08 | Deploy workflow and optional Terraform for the AWS reference; deployment guide |
| P6-T09 | Quickstart timing test (DX-02): scripted fresh-clone run in CI (compose up, seed, run sample app e2e) |
| P6-T10 | Final hardening: dependency audit, license check, secret scan, README claims audit against benchmark files |

Acceptance (Phase 6):
- A6-1 (DX-03): on a clean machine, `git clone`, `docker compose up`, open the printed URLs: dashboard works, demo notes works, demo inspection works.
- A6-2 (DEM-01, DEM-02): both Playwright scenario suites pass in CI.
- A6-3 (DX-01): packages build and install in a clean sample project via `pnpm pack`.
- A6-4: every claim in README with a number links to a file in `loadtest/results` or `docs/benchmarks.md`.
- A6-5: `docs/traceability.md` shows every Must feature ID covered by at least one passing test.

## 4. Testing strategy

| Level | Tools | Scope and targets |
|---|---|---|
| Unit | Vitest | Pure logic: protocol, ring, token bucket (simulated time), state machine, backoff, quota calculators, invoice calculator, crypto, access rules. Coverage target 85% for packages, 75% for apps |
| Integration | Vitest + Testcontainers | Real Postgres and Redis: doc-store, write path, fan-out, quotas, auth flows, webhooks, workers |
| Contract | OpenAPI validation | Requests and responses validated against generated spec in tests |
| Convergence | fast-check | Randomized multi-client convergence with network faults |
| E2E | Playwright | Dashboard, demo scenarios, offline and multi-tab, PWA install and offline |
| Security | Custom suite plus `pnpm audit` | Tenant isolation, token tampering, expired tokens, malformed frames, SSRF guard, rate limits |
| Load | k6 | Scenarios in section 6 |
| Chaos | Scripts, Toxiproxy | Kill node, stop Redis, stop shard, latency, packet loss |

CI gates: lint, typecheck, unit, integration (service containers), build, e2e (on main and PRs labeled `e2e`), size-limit, OpenAPI lint. Nightly workflow runs convergence tests with high iteration counts and a short load test.

## 5. CI/CD

| Workflow | Trigger | Steps |
|---|---|---|
| `ci.yml` | PR and push | install with cache, lint, typecheck, unit, integration, build, size-limit, upload coverage |
| `e2e.yml` (inside ci or separate) | PR label, main | build images, compose up, Playwright, upload traces and videos |
| `release.yml` | tag `v*` | build and push images to GHCR (server, worker, web), publish npm packages, create GitHub Release |
| `deploy.yml` | manual or release | SSH to EC2, pull images, `docker compose up -d`, run migrate service, smoke test `readyz` |
| `docs.yml` | push to main (docs) | Build VitePress, deploy to GitHub Pages |
| `nightly.yml` | cron | Long convergence tests, dependency audit, short load test, report |

Security gates: `pnpm audit --prod`, license checker, gitleaks secret scan, CodeQL.

## 6. Load and chaos test plan

### 6.1 k6 scenarios (`loadtest/k6`)

| Scenario | Description | Metrics to record |
|---|---|---|
| `ws-steady` | Ramp to N virtual clients (start at 1,000, scale toward 5,000 as hardware allows), each in a random document from a pool, 1 update per 5 s, 3 server nodes | Connections, ops/s, ack latency p50/p95/p99, propagation latency (client timestamp embedded in update payload, measured by receiver), error rate, CPU and memory per container |
| `ws-spike` | Jump from 100 to 2,000 clients in 10 s | Time to recover, rate-limit and error counts |
| `reconnect-storm` | 2,000 connected clients; stop one node; all its clients reconnect | Reconnect time distribution, lost acked updates (must be 0), server load during storm |
| `hot-doc` | One document with 200 to 1,000 subscribers, 10 writers | Fan-out latency, CPU, Redis throughput, backpressure events |
| `compaction` | Single document with 20,000 small edits then compaction | Load time before and after, storage before and after, ops row count |
| `rest-baseline` | REST token mint and doc reads | Latency percentiles |

Each run writes a JSON result file and a Markdown summary to `loadtest/results/{date}-{scenario}.md` including: machine spec, Docker limits, git SHA, configuration, raw numbers. `docs/benchmarks.md` links to them. **Only these measured numbers may be used in the README and resume bullets.**

### 6.2 Chaos scenarios (`loadtest/chaos`)

| Script | Action | Expected |
|---|---|---|
| `kill-node.sh` | `docker kill` one sync node under load | Clients reconnect within 3 s typical; zero acked-update loss |
| `stop-redis.sh` | Stop Redis for 20 s | Same-node clients continue; cross-node recovers after |
| `stop-shard.sh` | Stop one shard for 30 s | Docs on that shard return UNAVAILABLE; other shards fine; client outboxes drain after |
| `toxiproxy.sh` | Add 500 ms latency and 10% loss on client to server | No data loss; status transitions visible |
| `restart-worker.sh` | Restart worker during compaction | Jobs retried; verification passes |

## 7. Docker and Nginx specification

### 7.1 Compose services (`infra/compose/docker-compose.yml`)

| Service | Image or build | Ports | Notes |
|---|---|---|---|
| `nginx` | nginx:1.27-alpine with config and built static assets (dashboard, demos) | 8080 to 80 | Depends on server |
| `server` | build `Dockerfile.server` | none (internal 8080) | Scalable: `docker compose up --scale server=3`; healthcheck `/readyz` |
| `worker` | build `Dockerfile.worker` | none | Healthcheck via small HTTP port 9100 (`/healthz`, `/metrics`) |
| `migrate` | build `Dockerfile.migrate` | none | One-shot: runs migrations and seed; others depend on completion |
| `pg-control` | postgres:16-alpine | 5432 (dev profile only) | Volume `pgdata-control`; `synchronous_commit=on` |
| `pg-shard-0` | postgres:16-alpine | 5433 (dev only) | Volume `pgdata-shard0` |
| `pg-shard-1` | postgres:16-alpine | 5434 (dev only) | Volume `pgdata-shard1` |
| `redis` | redis:7.2-alpine | 6379 (dev only) | `appendonly yes`; maxmemory policy `noeviction` for queues |
| `prometheus` | prom/prometheus | 9090 | Scrapes server, worker |
| `grafana` | grafana/grafana | 3000 | Provisioned datasource and dashboard |
| `toxiproxy` | ghcr.io/shopify/toxiproxy | 8474 | Profile `chaos` |
| `k6` | grafana/k6 | none | Profile `loadtest` |

Server scaling detail: Nginx resolves the `server` service via Docker DNS (`resolver 127.0.0.11 valid=5s;` and `set $upstream http://server:8080`) so scaled containers are discovered. If DNS-based balancing is unreliable on a platform, document an alternative with explicit upstream entries `server-1..3` using `deploy.replicas` and fixed container names.

### 7.2 Nginx essentials

```
map $http_upgrade $connection_upgrade { default upgrade; '' close; }
upstream sync_nodes { least_conn; server server:8080 max_fails=2 fail_timeout=5s; }

server {
  listen 80;
  location /v1/connect {
    proxy_pass http://sync_nodes;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
    proxy_buffering off;
  }
  location /v1/ { proxy_pass http://sync_nodes; proxy_set_header X-Request-Id $request_id; }
  location /monitor/stream { proxy_pass http://sync_nodes; proxy_buffering off; proxy_read_timeout 1h; }
  location / { root /usr/share/nginx/html/dashboard; try_files $uri /index.html; }
  location /notes/ { alias /usr/share/nginx/html/demo-notes/; try_files $uri /notes/index.html; }
  location /inspection/ { alias /usr/share/nginx/html/demo-inspection/; try_files $uri /inspection/index.html; }
}
```

Tune: `worker_processes auto; worker_connections 20000;` and OS `ulimit -n`. Redact `token` query parameter in access logs using a `log_format` with `$uri` and a mapped sanitized args variable.

### 7.3 First-run experience

`docker compose up` runs `migrate`, which creates the demo tenant and prints a boxed block of text to the container logs containing: dashboard URL, demo email and password, publishable key, secret key, demo notes URL, inspection URL. The block is also written to `./.syncra-demo-credentials.txt` via a mounted volume path.

## 8. Benchmarks to run and how to record them

Record in `docs/benchmarks.md` using this template per run: purpose, git SHA, date, hardware (CPU model, cores, RAM), Docker resource limits, topology (nodes, shards), scenario file and parameters, results table, observations and limitations, honest caveats (for example, load generator on the same machine).

Benchmarks to include before launch: (1) steady-state connections and ops per second; (2) ack latency and propagation latency percentiles; (3) hot-document fan-out; (4) reconnect storm; (5) compaction effect on size and load time; (6) delta sync payload size versus full state for a large document after offline edits; (7) node failure recovery time; (8) IndexedDB size under 10,000 edits before and after local compaction.

## 9. Release checklist (v1.0.0)

- [ ] All Must features pass their tests; traceability table complete.
- [ ] Fresh-machine quickstart verified end to end.
- [ ] README demo GIF and video embedded; every numeric claim links to a result file.
- [ ] Docs site live; OpenAPI published.
- [ ] Security doc reviewed; secrets scan clean; default credentials rotated in production docs.
- [ ] LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY.md present.
- [ ] 10 labeled "good first issue" tickets and a public roadmap created.
- [ ] Docker images pushed; version tags set; release notes written.
- [ ] Live demo deployed (read-only demo tenant with rate limits and automatic data reset every hour).
- [ ] Launch assets prepared (Doc 06).
