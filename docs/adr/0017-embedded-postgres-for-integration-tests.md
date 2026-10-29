# 0017 - Embedded PostgreSQL 16 for integration tests

Status: accepted | Date: 2026-10-29

## Context

Doc 00 names Testcontainers for integration tests. Testcontainers needs a Docker daemon, which is
not always available on the development machine.

## Decision

Integration tests start a real PostgreSQL 16 through the `embedded-postgres` npm package (global
setup in `apps/server/test/global-setup.ts`), create a control DB and two shard DBs, and run the
real migrations. Redis-dependent code is tested against `ioredis-mock` where it appears; the
compose stack remains the production-like check.

## Alternatives

Testcontainers (kept as an option: tests only read the DB URLs injected by the global setup, so
swapping the setup file is enough).

## Consequences

Tests exercise real Postgres behaviour (row locks, partitions, bytea) with no Docker. Redis Lua and
pub/sub semantics are emulated in tests, so the chaos and load phases still need the real stack.
