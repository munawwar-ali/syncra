# ADR 0022: Phase 5 choices (dashboard, observability, billing, load tests)

Status: accepted. Decided without asking, per Doc 00 section 8.

## Decisions

1. **Invoices are computed in integer cents by a pure function.** Base fee is prorated by days the tenant existed in the month; overage is pro rata; the free plan is hard-capped and self-host is never billed. Money never touches floating point. The PDF is a minimal hand-written one-page writer (no dependency); it is structure-tested only.
2. **Jobs stay DB-polling, no BullMQ.** The worker runs scheduled jobs against Postgres (idempotent, unique constraints). Adding a queue would be a second source of truth with no benefit at this scale. Revisit if job volume needs fan-out workers.
3. **"Operator" for the node monitor** means `BILLING_ENABLED=false` (self-hosted) and an owner or admin. On a hosted multi-tenant install other tenants never see node data.
4. **Refresh has its own rate bucket** (`max(120, RL_AUTH_PER_MIN*24)`). Sharing the 5/minute login bucket logged users out on deep links. Covered by a regression test.
5. **The playground uses a dashboard-authenticated token route** (`POST /v1/tokens/playground`) limited to a `playground` collection for 1 hour, so no secret key reaches the browser.
6. **OpenAPI is generated from the same Zod schemas the routes validate with** (`http/schemas.ts`); the operation table is checked against the live route table by a test, and the output is validated by swagger-parser.
7. **Load tests are two-tier.** k6 scenarios and chaos scripts target the Docker stack (never run here). `loadtest/node/bench.ts` runs the real server process against embedded Postgres and measures what this machine can. Only the second kind appears in `docs/benchmarks.md`.
8. **OpenTelemetry tracing (P5-T08) is skipped.** It was optional; metrics, structured logs and request IDs cover the stated needs.
9. **Lint scope:** k6 scripts are excluded (they run in k6's runtime, checked with `node --check`); dashboard and loadtest relax style-only rules (`no-confusing-void-expression` etc.).

## Fixes found while verifying

- Client: a late socket message after disconnect caused unhandled rejections from `refreshPending` and `drain` on a closed store; both now tolerate it (`drain` only when no longer `wanted`).
- Tests that raced real timing were made wait-based (multinode convergence, monitor tick counts).
- `turbo.json` passes `PW_CHANNEL` through so e2e can use an installed browser; e2e runs serially.

## Known gaps

Docker stack, Grafana, k6 and chaos scripts never executed; reconnect storm and node-kill recovery unmeasured; `docs/protocol.md`, admin CLI and worker request-ID propagation not done.
