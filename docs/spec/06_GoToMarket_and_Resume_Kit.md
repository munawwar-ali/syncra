# Syncra - Go-to-Market and Resume Kit
Document 06 of 06 | Positioning, launch, content, resume, interviews | Version 1.0 | 26 Oct 2026

## 1. Honest starting point

Offline-first and CRDT sync is a real but crowded space (Yjs servers, Liveblocks, PowerSync, Electric, Replicache, Firebase). Syncra will not out-market funded companies, and it does not need to. For a portfolio and open-source project, success means: a clear problem statement, a working demo anyone can run in minutes, real engineering depth that holds up under questions, and a few real users or testers.

Rules for all public communication:
1. Never claim novelty you do not have. Say "built on Yjs" in the first paragraph of the README.
2. Never publish a number you did not measure with the repo's own scripts.
3. Never say "exactly-once". Say "at-least-once delivery with idempotent operations".
4. Compare competitors factually and respectfully; list their strengths.
5. Say clearly what Syncra is not (not a database, no queries, no E2EE yet).

## 2. Positioning

**Category:** open-source, self-hostable sync backend and SDK for offline-first apps.

**One-line pitch:** Syncra is the self-hostable sync engine that makes your web app work offline and merge conflict-free, without building the plumbing yourself.

**Positioning statement:** For developers building apps that must work on bad networks, Syncra is a self-hosted sync backend and client SDK that provides offline storage, conflict-free merging and live updates out of the box. Unlike hosted platforms, you own the data and the infrastructure. Unlike bare Yjs servers, it includes multi-tenancy, quotas, a dashboard and a client runtime with a persisted outbox.

**Tagline options (pick one and use consistently):**
1. "Offline-first sync you can self-host."
2. "Make any app work offline. Merge without conflicts."
3. "Sync that survives the tunnel."

**Core messages:**
- It keeps working with no signal: edits are saved on the device first.
- It merges without conflict dialogs: powered by CRDTs (Yjs).
- It is yours: self-hosted, open source, no lock-in.
- It scales out: stateless nodes, Redis fan-out, sharded Postgres (and shows its load-test numbers).
- It is observable: dashboard, metrics, Grafana out of the box.

### 2.1 Target segments (in priority order)

| Segment | Pain | Message | Where to find them |
|---|---|---|---|
| Indie developers and small teams building field or PWA apps | Offline is hard; Firebase lock-in and cost | "Offline-first in an afternoon, on your own server" | r/selfhosted, r/webdev, Indie Hackers, Hacker News |
| Developers building collaborative editors on Yjs | Running and scaling a Yjs server fleet, tenancy, persistence | "A production backend for your Yjs app" | Yjs community, Tiptap community, r/node |
| Small companies in regulated or sovereignty-sensitive contexts | Cannot send data to hosted platforms | "Your data stays in your infrastructure" | LinkedIn, dev.to, local developer communities |
| Students and engineers learning distributed systems | Want a real reference implementation | "A readable, well-documented sync system" | GitHub, YouTube, blogs |

### 2.2 Competitor comparison (use in docs, keep factual)

| Solution | Strengths | Tradeoffs vs Syncra's niche |
|---|---|---|
| Firebase Firestore | Mature, offline persistence, huge ecosystem | Hosted, vendor lock-in, last-write-wins style conflicts at field level |
| Supabase Realtime | Great Postgres tooling | Realtime delivery, not an offline-first merge runtime |
| PouchDB with CouchDB | Proven replication | Revision conflicts need app-level resolution; older ecosystem |
| Liveblocks and similar | Polished collaboration platform | Hosted and closed |
| Hocuspocus, y-websocket, y-sweet | Excellent Yjs servers | Less out of the box for tenancy, quotas, dashboard, client runtime |
| PowerSync, ElectricSQL, Replicache, Zero | Strong SQL-oriented sync | Different data model (sync relational data) |
| Automerge repo | Alternative CRDT with sync tooling | Different CRDT ecosystem and tooling |

State in the README: "Choose Syncra if you want Yjs-style CRDT documents, self-hosting, and a ready platform. Choose another tool if you need relational sync, queries, or a fully managed service."

## 3. Brand and naming

- Name: Syncra. Check availability of GitHub org `syncra-dev` or similar, domain options (`syncra.dev` may be taken; use a `.dev`, `.io` or `getsyncra` variant), npm scope `@syncra` (if taken, use `@syncra-dev` and update all docs consistently).
- Logo: wordmark plus two-arrow cycle glyph, primary color #4f46e5 (Doc 04 section 9).
- Voice: calm, technical, precise, a little friendly. No hype words ("revolutionary", "blazing").

## 4. README blueprint (this is the main conversion asset)

Order of sections:

1. Logo, name, one-line pitch, badges (CI, license, version, stars).
2. A 20-second demo GIF: two windows editing, one goes offline, edits merge. Directly under the title.
3. "Why Syncra?" three bullets: works offline, merges conflict-free, self-hostable.
4. "Built on Yjs" honesty line and what Syncra adds.
5. Quickstart (copy-paste): clone, `docker compose up`, open the printed URL. Then a 15-line SDK example.
6. Features list (short, scannable).
7. Architecture diagram (Mermaid or PNG) with a 5-sentence explanation and a link to `docs/architecture.md`.
8. Benchmarks table (only measured) with links to result files and the hardware used.
9. Demo apps with screenshots.
10. Comparison table (Section 2.2).
11. Guarantees and limits: delivery semantics, consistency, what is not supported.
12. Roadmap and "good first issues".
13. Contributing, license, acknowledgements (Yjs, lib0, Tiptap and others).

README style: no wall of text; maximum 3 sentences per paragraph; every claim linked to evidence.

## 5. Demo video (90 seconds) script

| Time | Visual | Voiceover or caption |
|---|---|---|
| 0:00 to 0:10 | Phone with "No signal" icon in a basement | "Apps break when the network does." |
| 0:10 to 0:20 | Split screen, two users editing one note | "Syncra makes edits live across devices." |
| 0:20 to 0:35 | Click "Go offline" in one window; keep typing; badge shows Offline and pending count | "Go offline. Keep working. Everything is saved on the device first." |
| 0:35 to 0:45 | Reload the offline window; text still there | "Even after a reload." |
| 0:45 to 0:55 | Go online; badge Syncing then Synced; both windows identical | "Reconnect, and it merges without conflicts." |
| 0:55 to 1:10 | Dashboard: live ops, nodes; kill one node; clients reconnect | "Built to scale out and survive node failures." |
| 1:10 to 1:20 | Time-travel slider in the document inspector | "Every change is in an append-only log with history." |
| 1:20 to 1:30 | Terminal: `docker compose up`; README with GitHub URL | "Self-host it in one command. Open source." |

Record at 1080p, with captions burned in (many people watch muted). Host on YouTube and embed a GIF version in the README.

## 6. Launch plan

### 6.1 Timeline

| When | Activity |
|---|---|
| T minus 4 weeks | Feature freeze for v1.0 scope; start benchmarks; draft README and docs |
| T minus 3 weeks | Recruit 5 testers (friends, colleagues, communities); run mock "field inspection" sessions; collect written quotes |
| T minus 2 weeks | Publish the first technical article (teaser: "Why offline sync is harder than it looks") on your blog or dev.to; fix issues from testers |
| T minus 1 week | Record demo video and GIF; final README; deploy live demo; prepare launch posts |
| T day (Tuesday to Thursday, 8 to 10 AM US Eastern) | Show HN post; Product Hunt launch; LinkedIn and X posts; r/selfhosted and r/node posts (follow each subreddit's self-promotion rules) |
| T plus 1 to 7 days | Respond to every comment within hours; fix reported bugs publicly; publish the second article |
| T plus 2 to 4 weeks | Submit to awesome lists; publish benchmark article; open "good first issue" tickets; post a week-in-review |
| Ongoing | One meaningful release or article every 2 weeks for 3 months |

### 6.2 Show HN post template

Title: `Show HN: Syncra - self-hostable offline-first sync engine (Yjs, Node, Postgres)`

First comment (post immediately): what it is in two sentences; why you built it (the real story); what is built on Yjs versus what is original; architecture highlights (op log plus snapshots, Redis fan-out, sharding, delta sync); honest limitations; what feedback you want (protocol design, compaction strategy, SDK API). Link to the live demo and the benchmarks file.

### 6.3 Channels

| Channel | Format | Notes |
|---|---|---|
| Hacker News | Show HN | One shot; polish first; do not ask for upvotes |
| Product Hunt | Launch page with video | Optional; developer tools do moderately well |
| Reddit | r/selfhosted, r/node, r/webdev, r/javascript, r/opensource | Read each rule set; lead with the demo and honest framing |
| dev.to, Hashnode, Medium | Long-form articles | Cross-post with canonical link to your blog or docs |
| LinkedIn | Post with GIF and story | Best channel for recruiters; tag technologies, not people |
| X and Bluesky | Short thread with GIF | Tag Yjs and Tiptap communities respectfully |
| Awesome lists | Pull requests | awesome-selfhosted (needs a stable release and docs), awesome-yjs, awesome-local-first, awesome-nodejs |
| Local-first community | Local-first Web community and Discord/Slack communities | Share when you have something useful, not before |
| YouTube | Demo plus architecture walkthrough (8 to 12 minutes) | Show failure and recovery live |

### 6.4 Content calendar (articles that also work as portfolio proof)

| # | Title | Outline |
|---|---|---|
| 1 | Why offline sync is harder than it looks | Problem list, naive approaches that fail, what you need |
| 2 | CRDT vs OT: why I chose Yjs | Tradeoffs, offline suitability, metadata growth |
| 3 | Designing an append-only op log with snapshots | Seq allocation, batching, load path, diagrams |
| 4 | Compaction: keeping CRDT storage from exploding | Tombstones, GC, verification by state vector, results |
| 5 | Scaling WebSockets horizontally with Redis pub/sub | Fan-out, gap recovery, why pub/sub alone is not enough |
| 6 | Building an offline-first client: outbox, state machine, multi-tab | IndexedDB design, leader election, backoff |
| 7 | Rate limiting with a Redis Lua token bucket | Atomicity, fallback, fairness |
| 8 | What I measured: Syncra benchmark results | Honest numbers, methodology, limitations |
| 9 | Chaos testing a sync engine | Kill node, stop Redis, results |
| 10 | Lessons from building a multi-tenant sync platform | Mistakes, tradeoffs, what I would change |

Each article ends with a link to the repo and the relevant ADR.

## 7. Community and open-source hygiene

- Files: README, LICENSE (Apache-2.0), CONTRIBUTING (setup, test, commit style), CODE_OF_CONDUCT, SECURITY (private disclosure email), issue templates (bug, feature, question), PR template with checklist.
- Labels: `good first issue`, `help wanted`, `bug`, `docs`, `protocol`, `sdk`, `perf`.
- Starter issues (create at least 10): add Svelte bindings, add Vue bindings, add a todo-list demo, improve error messages in SDK, add OpenTelemetry example dashboard, write a Hocuspocus migration guide, add Japanese README translation, write Postgres backup docs, add a CLI `syncra doctor`, write a Cloudflare tunnel deployment guide.
- Public roadmap as a GitHub Project board; respond to issues within 48 hours; release notes for each version.
- Discussions enabled; optionally a Discord server once there are at least 20 users.

## 8. Validation with real users (before and after launch)

1. Recruit 5 testers: ideally developers who have built or want to build an offline feature.
2. Give each a 20-minute task: add Syncra to a small sample app using only the README.
3. Record: time to first synced edit, where they got stuck, quotes, feature requests.
4. Fix top 3 issues, then publish a short "what testers said" section in the README (with permission) and improve the quickstart.
5. Target metric: 4 of 5 testers reach a working offline demo in under 20 minutes.

## 9. Hosted option and pricing (optional, after v1.0)

The notional pricing from Doc 01 can be real if you offer a hosted version later: Free ($0), Pro ($29 per month), Business ($149 per month), usage overage per Doc 01 section 5. Self-hosted remains free forever. Only launch hosted if you can commit to support and uptime. For a portfolio, the "Pricing" page can state "hosted version coming; self-host today".

## 10. Resume kit

### 10.1 Project entry (replace both old projects)

**Syncra - Self-Hostable Offline-First Sync Engine** | Node.js, TypeScript, PostgreSQL, Redis, WebSockets, Yjs (CRDT), React, Docker | github link | live demo link

Bullets (fill X, Y, Z only with measured values from `loadtest/results`; delete a bullet rather than guessing):

- Designed and built an open-source sync platform (server plus client SDK) that gives web apps offline support and conflict-free real-time sync using Yjs CRDTs; documented in 15 ADRs and run with a single `docker compose up`.
- Scaled stateless WebSocket gateways horizontally with Redis pub/sub fan-out and sequence-based gap recovery; sustained X concurrent connections and Y ops/sec at p95 ack latency of Z ms in k6 load tests across 3 nodes.
- Implemented an append-only operation log with snapshotting and background compaction (BullMQ workers) that cut document load time by X% and storage by Y% on a 20,000-operation document, with state-vector verification before deletion.
- Sharded document storage across PostgreSQL instances with consistent hashing and hash-partitioned op logs; verified zero acknowledged-update loss during node-kill chaos tests.
- Built an offline-first client SDK and React hooks: IndexedDB persistence, durable outbox, sync state machine, jittered exponential backoff, multi-tab leader election, and delta sync that reduced reconnect payloads by X% versus full-state transfer.
- Added multi-tenancy with JWT/API-key auth, RBAC, token-bucket rate limiting (Redis Lua), usage metering, plan quotas, signed webhooks and invoice generation.
- Built an admin dashboard with real-time metrics (SSE), document time-travel history, and Prometheus and Grafana observability.

Short version (for space-constrained resumes): 3 bullets - sync platform with CRDTs and scale numbers; storage engine (log, snapshots, compaction, sharding); offline-first SDK and multi-tenant platform.

### 10.2 Summary line update

"Backend engineer specializing in distributed, real-time systems: built an open-source offline-first sync engine (Node.js, Postgres, Redis, CRDTs) with horizontally scaled WebSocket gateways, sharded storage and chaos-tested recovery."

Keep your experience years consistent across your CV and LinkedIn (your CV says 2+ years; use the same figure everywhere unless you update it).

### 10.3 LinkedIn launch post structure

1. Hook: "I spent N weeks building the thing every offline app needs and nobody wants to build."
2. The problem in one sentence and the demo GIF.
3. Three technical highlights with one line each.
4. Honest note: built on Yjs; what you built yourself.
5. Link to repo and live demo; ask for feedback on one specific design question.

### 10.4 Portfolio site section

Hero: tagline plus demo video; "Architecture" diagram; "Decisions" (link ADRs); "Numbers" (benchmarks with caveats); "What I would do next".

## 11. Interview preparation

### 11.1 The 2-minute story

Problem (apps break offline; teams rebuild sync badly) -> my approach (CRDT-based sync platform; Yjs for merge, my engineering around it) -> hardest parts (durability and ordering with batching, fan-out correctness with Redis pub/sub, compaction without corrupting state, client outbox and multi-tab) -> results (measured numbers) -> what I learned and would change.

### 11.2 Questions and the points to hit

| Question | Key points |
|---|---|
| Why CRDT instead of OT? | No central transform server needed; offline friendly; commutative merging; cost is metadata growth, solved with GC and compaction |
| What does Yjs do vs what did you build? | Yjs: merge algorithm and encoding. Mine: persistence, ordering, delta sync serving, scale-out, tenancy, quotas, client runtime, ops tooling |
| How do you guarantee no data loss? | Client persists before send; server persists before ACK; idempotent ops; outbox cleared on ACK or after delta sync; tested by kill-node chaos |
| Why not exactly-once? | Network ambiguity makes it impossible in general; at-least-once plus idempotency gives effectively-once effects |
| How does ordering work? | Per-document seq assigned inside the shard transaction with a row lock; CRDT makes order irrelevant for convergence, seq is for recovery and history |
| What if Redis pub/sub drops a message? | Seq on every broadcast; gap detection; periodic head_seq reconciliation; Postgres is the source of truth |
| How do you scale WebSocket connections? | Stateless nodes, least_conn, Redis pub/sub, multiplexing, backpressure, ulimits; measured per-node capacity |
| What is the bottleneck for a hot document? | Fan-out CPU and per-document write lock; mitigated by batching, merged updates, awareness throttling; next step is read-only replica nodes for broadcast |
| How does compaction work safely? | Snapshot first; delete only ops covered by snapshot and outside retention; verify state vector equality; abort on mismatch |
| How do you handle a client offline for weeks? | Delta sync uses state vectors against current doc, not old seq; retention only affects history, not sync |
| How do you shard? | Consistent hash ring with virtual nodes over (tenant, collection, doc); partitioned op tables; v1 fixed ring, dual-read migration path for rebalancing |
| How do you do multi-tenancy safely? | tenant_id on every row and in every key; tenant-scoped data access API; isolation test suite; per-tenant limits |
| How does the client sync state machine work? | Explicit states and events; backoff with full jitter; auth-expired and quota-blocked states preserve outbox |
| How do multiple tabs coordinate? | Web Locks leader election, BroadcastChannel relay, fallback heartbeat; leader change triggers resync |
| What would you change at 100x scale? | Dedicated broadcast tier, read replicas, Redis cluster or streams for fan-out, shard rebalancer, log archival to object storage, per-region deployments |
| How do you test it? | Unit, integration with real Postgres and Redis, property-based convergence tests, Playwright offline tests, k6 load, chaos scripts |
| What went wrong during the build? | Prepare 2 honest stories (for example, a compaction bug caught by verification, a backpressure issue found in load tests) |
| How would you add E2E encryption? | Client-side encryption of updates; server stores ciphertext; lose server materialization and compaction; clients snapshot |
| Security concerns? | Token scopes and TTL, malicious updates, SSRF in webhooks, DoS via large docs; mitigations and tests |
| Why self-hosted rather than SaaS? | Data ownership, sovereignty, lower cost, easier trust; hosted option possible later |

### 11.3 Demo plan for interviews

Have a live URL and a local run ready. Show: (1) offline edit and merge; (2) dashboard live metrics; (3) kill a node while editing; (4) the compaction before and after numbers; (5) one ADR. Keep to 5 minutes; invite questions.

## 12. Success checklist for you

- [ ] Public repo with a strong README, GIF and video.
- [ ] Live demo URL with automatic data reset.
- [ ] Benchmarks file with real numbers and caveats.
- [ ] 5 tester quotes or short testimonials.
- [ ] 3 articles published, 1 Show HN submitted.
- [ ] Resume updated with measured numbers; old projects removed or demoted to one line each if space allows.
- [ ] A rehearsed 2-minute story and 5-minute demo.
