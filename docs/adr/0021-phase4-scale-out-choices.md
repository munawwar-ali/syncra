# 0021 - Phase 4 scale-out choices

Status: accepted | Date: 2026-11-04

## Context

Phase 4 adds multi-node fan-out, data lifecycle jobs and the deployment layer. There is still no
Docker daemon or real Redis on the build machine (ADR 0017), and Doc 02/05 leave some mechanics open.

## Decision

1. **Fan-out is a hint, Postgres is the truth.** Nodes publish `(seq, originNode, originClient,
update)` on `sx:doc:{tid}:{docKey}:ch` after commit. A receiver applies a message only when
   `seq == headSeq + 1`; any other seq (or a periodic head_seq check) triggers `catchUp`, which
   replays `operations` after `headSeq` from Postgres. If those ops were compacted away, the node
   reloads the document and sends RESYNC_HINT to its clients.
2. **The bus is an interface** (`PubSub`) with a Redis implementation. Tests use an in-memory
   implementation with fault injection (down, dropped messages), which Redis cannot do on demand.
3. **Reconcile ticks at the degraded interval (5 s) and decides each tick**, running at the healthy
   interval (30 s) only while the bus is up. Choosing the interval when the timer is scheduled would
   miss an outage that starts mid-wait.
4. **A checkpoint and a compaction snapshot can share a seq** (primary key `(doc_uid, up_to_seq)`).
   The row is upgraded to `kind = 'checkpoint'`; older compaction snapshots are deleted, checkpoints
   expire with the plan's history window and the newest snapshot is never deleted.
5. **Compaction verifies before it deletes.** Candidate ops are replayed on top of the snapshot; if
   the state changes at all, the snapshot lacks data and the job aborts with nothing deleted.
6. **Restore** copies the checkpoint's content into the four root types of a working copy and writes
   the resulting delta as an op from `system:restore`. Nested shared types inside `data`/`list`
   are restored as plain JSON (documented shortcut in `restoreRoots`).
7. **Presence** lives in a Redis hash per document (TTL 60 s, refreshed every 20 s) plus bus
   fan-out; a connection announces its awareness clients as gone (clock + 1, state `null`) on close.
8. **Nginx resolves `server` through Docker DNS every 5 s** instead of using a static `least_conn`
   upstream, so `--scale server=N` works without a reload. Distribution is DNS round-robin, not
   least-connections; connection counts per node are visible in the node registry.
9. **Jobs still run on timers with Redis locks, not BullMQ** (see ADR 0020). The retry/queue
   semantics BullMQ adds are not needed by the current jobs, and it cannot be verified here.

## Consequences

Multi-node behaviour is verified with real Postgres and a faithful in-memory bus. What that does not
prove: Redis pub/sub behaviour under real network failure, ioredis resubscribe after reconnect, and
Docker DNS balancing. Those need the compose stack on a machine with Docker (chaos scripts, Phase 5).
