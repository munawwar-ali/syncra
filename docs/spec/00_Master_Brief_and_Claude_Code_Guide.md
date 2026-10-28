# Syncra - Master Brief and Claude Code Guide
Document 00 of 06 | Read this first | Version 1.0 | 26 Oct 2026

## 1. Purpose of this document set

Syncra is a self-hostable sync engine for offline-first applications: a backend platform plus a client SDK that gives any app offline support, conflict-free merging and live multi-device updates. This document set specifies the entire product so that an AI coding agent (Claude Code) or a human engineer can build it without asking clarifying questions.

Where something is ambiguous, this document set has already made a decision. If you find a gap, apply the "Default rules" in section 8 and record the decision in `docs/adr/` instead of stopping to ask.

### Document index

| Doc | File | What it answers |
|---|---|---|
| 00 | Master Brief and Claude Code Guide | How to use these docs, locked decisions, conventions, CLAUDE.md |
| 01 | Product Requirements | What to build: users, features with IDs, acceptance criteria, plans, quotas |
| 02 | Technical Architecture | How the system works: components, flows, consistency, scaling, failure modes, ADRs |
| 03 | Data and API Specification | Exact schemas, Redis keys, REST endpoints, WebSocket protocol, env vars, limits |
| 04 | Frontend, SDK and Demo Apps | Client SDK design, React hooks, local storage, dashboard UI, demo apps |
| 05 | Engineering and Build Plan | Repo layout, phases and tasks, tests, CI/CD, compose, load and chaos tests |
| 06 | Go-to-Market and Resume Kit | Positioning, launch plan, README blueprint, content, resume bullets, interview prep |

## 2. Product in one paragraph

Developers building field apps (inspections, clinics, delivery, surveys), note-taking and collaborative tools do not want to hand-build offline storage, queued writes, conflict resolution, reconnect logic and live updates. Syncra provides all of it: a Node.js and TypeScript backend (WebSocket gateways, append-only operation log, snapshots and compaction, Redis fan-out, sharded PostgreSQL, multi-tenancy, quotas, webhooks, dashboard) and a TypeScript client SDK with React hooks (IndexedDB persistence, persisted outbox, sync state machine, multi-tab leader election). Conflict resolution uses Yjs CRDTs. It runs with one `docker compose up`.

## 3. How to use this with Claude Code

### 3.1 Setup

1. Create an empty repo named `syncra`.
2. Put the generated `CLAUDE.md` (included as a separate file and in Appendix A) in the repo root.
3. Put the seven documents (PDF or the Markdown versions) in `docs/spec/`. Markdown is more reliable for agents; PDFs are for humans.
4. Start Claude Code in the repo root and give it the starter prompt in section 3.3.

### 3.2 Working rules for the agent

- Build one phase at a time, in the order defined in Doc 05. Never start phase N+1 until phase N acceptance tests pass.
- Work task by task. After each task: run lint, typecheck and tests; commit with a Conventional Commit message.
- Never invent requirements. Everything needed is in Docs 01 to 05. Defaults in section 8 cover gaps.
- Never fake results. Benchmarks, load-test numbers and screenshots must come from real runs. Placeholders like `TBD-MEASURE` are allowed in docs until measured.
- Prefer boring, readable code. Strict TypeScript, no `any` without a comment, small modules, pure functions where possible.
- Every feature ID in Doc 01 must map to at least one automated test. Keep a traceability table in `docs/traceability.md` (feature ID, test file, status).
- When an architectural choice is made that is not already locked here, write a short ADR in `docs/adr/NNNN-title.md`.

### 3.3 Starter prompt (paste into Claude Code)

> Read CLAUDE.md and every file in docs/spec/. You are building Syncra exactly as specified. Start with Phase 0 from Doc 05 (Engineering and Build Plan). Do not ask me questions; where something is unspecified, apply the Default rules in Doc 00 section 8 and record an ADR. Work task by task, running lint, typecheck and tests after each task and committing with Conventional Commits. When all Phase 0 acceptance tests pass, summarize what you built, list any ADRs you added, and wait for me to say "next phase".

### 3.4 Per-phase prompt template

> Proceed to Phase N from Doc 05. Implement every task in order. Satisfy every acceptance test listed for the phase. Update docs/traceability.md. When finished, run the full test suite and report results, including anything you could not complete and why.

### 3.5 Suggested human checkpoints

| After phase | You should personally verify |
|---|---|
| 1 | Two terminal clients converge on one document through the server |
| 2 | Demo notes app: edit offline in two windows, reconnect, clean merge |
| 3 | Create a tenant, mint a token, hit a quota, receive a webhook |
| 4 | Run 3 server nodes; kill one; clients continue; compaction reduces size |
| 5 | Dashboard live metrics, Grafana panels, load test results recorded |
| 6 | Fresh machine: clone, `docker compose up`, follow README, everything works |

## 4. Locked technical decisions

These are final. Do not re-open them.

| Area | Decision |
|---|---|
| Product name | Syncra. npm scope `@syncra`. Docker images `ghcr.io/<owner>/syncra-*` |
| License | Apache-2.0 |
| Language | TypeScript 5.x, `strict: true`, ESM only, target ES2022 |
| Runtime | Node.js 22 LTS |
| Monorepo | pnpm 9 workspaces + Turborepo |
| Server framework | Fastify 5 with the `ws` library (8.x) attached to the same HTTP server |
| CRDT | Yjs 13.x with y-protocols and lib0. We do NOT implement our own CRDT |
| Validation | Zod for all external input (REST, WS decoded payload metadata, env) |
| Database access | `pg` + Kysely (typed query builder). Plain `.sql` migrations run by `node-pg-migrate` |
| Primary datastore | PostgreSQL 16: one control-plane DB and N data shards |
| Cache, pub/sub, presence, rate limits | Redis 7.2 via ioredis |
| Queues and scheduled jobs | BullMQ (Redis-backed) |
| Auth libs | `jose` for JWT, `argon2` for passwords |
| Logging | pino (JSON), request IDs on every log line |
| Metrics | prom-client, scraped by Prometheus, shown in Grafana |
| Tracing | OpenTelemetry SDK, optional via `OTEL_EXPORTER_OTLP_ENDPOINT` |
| Dashboard and demo frontends | React 18, Vite, TypeScript, Tailwind CSS 3, TanStack Query, React Router, Recharts |
| Editor in demo notes | Tiptap with Collaboration extensions (y-prosemirror) |
| PWA tooling | vite-plugin-pwa (Workbox) |
| Unit and integration tests | Vitest, Testcontainers |
| E2E tests | Playwright (uses `context.setOffline()` for offline tests) |
| Property tests | fast-check |
| Load tests | k6 with the xk6-websockets or built-in `k6/experimental/websockets` module |
| Fault injection | Toxiproxy plus `docker kill` scripts |
| Edge proxy | Nginx |
| CI/CD | GitHub Actions; images to GHCR; deploy to a single AWS EC2 host via compose (Terraform optional) |
| IDs | Internal IDs are UUIDv7. Client-chosen document IDs are strings matching `^[A-Za-z0-9_.:-]{1,128}$` |
| Time | UTC everywhere; `timestamptz` in Postgres; ISO-8601 strings in JSON |
| Money | Integer cents; currency USD; billing is simulated unless the optional Stripe adapter is enabled |

## 5. Global conventions

### 5.1 Code style

- ESLint flat config with `typescript-eslint` strict-type-checked plus `eslint-plugin-import`. Prettier: 100 columns, single quotes, trailing commas.
- File names `kebab-case.ts`. Types and classes `PascalCase`. Functions and variables `camelCase`. Constants `SCREAMING_SNAKE_CASE`. DB columns `snake_case`; JSON API fields `camelCase`.
- No default exports except React route components and config files.
- No circular imports between packages. Dependency direction: `shared` and `protocol` at the bottom; `client` depends on them; `react` depends on `client`; apps depend on packages; packages never depend on apps.
- Every public function in packages has TSDoc. Every module under `apps/server/src` has a short header comment stating its responsibility.

### 5.2 Error handling

- Define `SyncraError` in `packages/shared` with fields `code`, `message`, `httpStatus`, `details`, `retryable`. All errors thrown deliberately are `SyncraError`s. Unknown errors become `INTERNAL` and are logged with stack.
- Error codes are listed in Doc 03 section 6. REST error body: `{ "error": { "code", "message", "details", "requestId" } }`.
- Never swallow errors silently. Never log secrets, tokens, API keys, passwords, or document contents.

### 5.3 Git and branching

- `main` is always releasable. Work on `feat/*`, `fix/*`, `chore/*` branches; squash merge.
- Conventional Commits: `feat(server): add token bucket limiter`. Scopes: `server`, `worker`, `client`, `react`, `protocol`, `shared`, `dashboard`, `demo-notes`, `demo-inspection`, `infra`, `docs`, `ci`, `loadtest`.
- Semantic versioning. Tag `v1.0.0` for the first public release. Use Changesets for package versions.

### 5.4 Configuration

- All config via environment variables, parsed and validated by one Zod schema in `apps/server/src/config.ts` and `apps/worker/src/config.ts`. Fail fast on startup with a readable error.
- Provide `.env.example` listing every variable (Doc 03 section 9).

### 5.5 Security baseline

- Secrets only from env. API keys stored hashed. Webhook secrets and tenant signing secrets encrypted at rest (AES-256-GCM, key from `ENCRYPTION_KEY`).
- All SQL parameterized (Kysely). All input validated. Request body limits enforced.
- CORS allowlist from `CORS_ORIGINS`. Helmet headers. Dashboard uses short-lived access token in memory plus httpOnly rotating refresh cookie.

## 6. Global Definition of Done

A task is done only when all of the following hold:

1. Code compiles with zero TypeScript errors and zero ESLint errors.
2. Unit tests exist for new logic; integration tests exist for new endpoints or flows; all pass.
3. Public behavior matches the relevant spec section; deviations have an ADR.
4. Metrics and logs exist for new runtime behavior (Doc 02 section 14).
5. Docs updated: `docs/` markdown, OpenAPI file (`docs/openapi.yaml` generated from Zod schemas), and the traceability table.
6. No secrets, no TODOs without an issue reference, no commented-out code.

## 7. Glossary

| Term | Meaning |
|---|---|
| Tenant | An organization using Syncra; the unit of isolation, quota and billing |
| Collection | A named namespace of documents within a tenant (for example `inspections`) |
| Document | One Yjs `Y.Doc` identified by `(tenant, collection, docId)` |
| docKey | String `collection/docId` used in the wire protocol |
| Operation (op) | One persisted Yjs update, stored in the append-only op log with a per-document sequence number |
| seq | Per-document, server-assigned, strictly increasing integer for stored ops |
| Snapshot | A full encoded document state at a given seq; used to avoid replaying the whole log |
| Compaction | Merging old ops into a snapshot and deleting superseded ops after the retention rules allow |
| State vector | Yjs structure summarizing which updates a replica already has; basis of delta sync |
| Outbox | Client-side persisted queue of local updates not yet acknowledged by the server |
| Sync node | A stateless server process serving REST and WebSocket traffic |
| Shard | One PostgreSQL instance holding a partition of document data |
| Control plane | Tenants, users, keys, billing, webhooks: stored in the control-plane Postgres |
| Data plane | Documents, ops, snapshots, views: stored in the shard Postgres instances |
| Client token | Short-lived JWT minted by a tenant's backend and used by end-user devices to connect |
| Secret key | Server-side API key (`sk_...`) with admin rights over a tenant's data |
| Publishable key | Public key (`pk_...`) identifying the tenant in client code; cannot access data by itself |
| Awareness | Ephemeral presence data (cursor, name, color); never persisted |

## 8. Default rules for anything unspecified

1. Prefer the simplest implementation that satisfies the written acceptance criteria.
2. Prefer correctness and data safety over performance. Never drop a client update silently.
3. Prefer explicit over clever. If two designs are equal, choose the one easier to test.
4. Pick sensible defaults for UI copy, spacing and colors using the design tokens in Doc 04 section 8.
5. If a library choice is open, pick the most widely used maintained option and write a 5-line ADR.
6. All user-facing text is English. All numeric limits are configurable via env with the defaults in Doc 03.
7. For anything involving real money or real third parties, implement a fake or adapter and keep it off by default.
8. Never claim a performance number in docs that was not measured by the repo's own load tests.

## 9. Scope guard (what NOT to build)

- A general-purpose database, SQL queries over CRDT data, or full-text search (v2).
- A custom CRDT algorithm.
- Native mobile SDKs (v2). The web SDK works in mobile browsers and PWAs.
- End-to-end encryption of document content (v2; architecture notes in Doc 02).
- Real payment processing by default.
- Kubernetes manifests (compose and optional Terraform only).

## Appendix A. CLAUDE.md (copy into repo root)

```
# Syncra - agent instructions

Project: Syncra, a self-hostable sync engine (server + client SDK) for offline-first apps.
Specs live in docs/spec/ (Docs 00-06). They are the source of truth. Read them before coding.

Rules
- Follow the phase order in docs/spec/05. One phase at a time. Do not skip acceptance tests.
- Do not ask the user questions. Use the Default rules in Doc 00 section 8; write an ADR.
- TypeScript strict, ESM, Node 22, pnpm + Turborepo. Locked stack in Doc 00 section 4.
- Never implement a custom CRDT. Use Yjs.
- Validate all external input with Zod. Parameterize all SQL via Kysely.
- Never log secrets, tokens, or document contents.
- After every task run: pnpm lint && pnpm typecheck && pnpm test. Commit with Conventional Commits.
- Every feature ID in Doc 01 needs a test; keep docs/traceability.md current.
- Never fabricate benchmark numbers. Only record measured results in docs/benchmarks.md.

Commands (create these scripts in the root package.json)
- pnpm dev          start compose deps + server + worker + dashboard
- pnpm build        build all packages and apps
- pnpm lint | typecheck | test | test:integration | test:e2e
- pnpm loadtest     run k6 scenarios against local compose
- docker compose -f infra/compose/docker-compose.yml up
```
