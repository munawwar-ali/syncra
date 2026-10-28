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

- pnpm dev start compose deps + server + worker + dashboard
- pnpm build build all packages and apps
- pnpm lint | typecheck | test | test:integration | test:e2e
- pnpm loadtest run k6 scenarios against local compose
- docker compose -f infra/compose/docker-compose.yml up
