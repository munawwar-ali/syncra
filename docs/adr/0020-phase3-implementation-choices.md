# 0020 - Phase 3 implementation choices that deviate from the locked stack

Status: accepted | Date: 2026-11-03

## Context

Doc 00 locks Kysely for database access and BullMQ for jobs. Two facts shaped Phase 3: the build
machine has no Docker or real Redis (see ADR 0017), and the schema is small and fully
parameterized.

## Decision

1. **Plain `pg` with parameterized queries instead of Kysely.** Every query passes values as `$n`
   parameters and takes `tenantId` explicitly. Kysely adds a type layer but no extra safety here;
   revisit when the query surface outgrows hand-written SQL.
2. **Timer loops with Redis `SET NX` locks instead of BullMQ** for the Phase 3 jobs (webhook
   delivery, usage flush, gauge refresh). BullMQ's behaviour (Lua scripts, blocking commands)
   cannot be verified against `ioredis-mock`, so shipping it untested would be a guess. Webhook
   retries are durable anyway: state lives in `webhook_deliveries` and is leased with
   `FOR UPDATE SKIP LOCKED`. Phase 4's snapshot and compaction jobs need real retry/queue
   semantics; BullMQ is adopted there, tested against a real Redis.
3. **Job code lives in `apps/server/src/jobs` and is exported as `@syncra/server/jobs`**, so the
   worker reuses the dispatcher and metering code without duplicating it.
4. **Per-tenant client-token keys:** HS256 with `kid = tenant id`; the verifier requires `kid ===
tid`, so a token cannot be replayed under another tenant's key.

## Consequences

Phase 3 is verifiable end to end without external services. Replacing the scheduler with BullMQ
later changes only `apps/worker/src/main.ts`.
