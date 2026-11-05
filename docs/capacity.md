# Capacity guidance

This page contains two kinds of numbers. Limits derived from code and configuration defaults are marked as such. Measured results are copied from [benchmarks.md](benchmarks.md) and apply only to the machine and topology described there. There are no throughput projections on this page.

## Limits from plan definitions

Source: `apps/server/src/limits/plans.ts`. They apply only when `BILLING_ENABLED=true`; otherwise every tenant is treated as `selfhost` and nothing is capped by plan.

|                               | free      | pro        | business    | selfhost  |
| ----------------------------- | --------- | ---------- | ----------- | --------- |
| Documents                     | 1,000     | 100,000    | 1,000,000   | unlimited |
| Storage                       | 100 MiB   | 10 GiB     | 100 GiB     | unlimited |
| Operations per month          | 1,000,000 | 50,000,000 | 500,000,000 | unlimited |
| Concurrent connections        | 100       | 5,000      | 50,000      | unlimited |
| Write rate per tenant (ops/s) | 50        | 1,000      | 10,000      | unlimited |
| Max document size             | 5 MiB     | 25 MiB     | 50 MiB      | 50 MiB    |
| History window                | 7 days    | 30 days    | 90 days     | 30 days   |
| Webhooks                      | 1         | 10         | 50          | unlimited |

A plan limit is a ceiling on one tenant, not a statement of what a node can serve. An "op" is one accepted client update frame, counted before batching.

## Limits from configuration defaults

Source: `apps/server/src/config.ts` and `packages/shared/src/schemas.ts`.

| Setting                                                            | Default                  |
| ------------------------------------------------------------------ | ------------------------ |
| `MAX_UPDATE_BYTES`                                                 | 1,048,576                |
| `MAX_MESSAGE_BYTES`                                                | 2,097,152                |
| Subscriptions per connection                                       | 200                      |
| In-flight writes per connection                                    | 256                      |
| `RL_CONN_RATE` / `RL_CONN_BURST` (messages per connection)         | 100 per s / 200          |
| `RL_IP_RATE` (requests and upgrades per IP)                        | 20 per s, burst 40       |
| `BATCH_WINDOW_MS` / `BATCH_MAX_BYTES`                              | 20 / 262,144             |
| `HOT_DOC_CACHE_MAX`                                                | 500 documents per node   |
| `HOT_DOC_IDLE_MS`                                                  | 60,000                   |
| `WS_OUTBOUND_HIGH_WATER` / `WS_SLOW_CLOSE_MS`                      | 1,048,576 / 15,000       |
| `SNAPSHOT_EVERY_OPS` / `SNAPSHOT_EVERY_BYTES` / `SNAPSHOT_IDLE_MS` | 500 / 1,048,576 / 60,000 |
| `CHECKPOINT_INTERVAL_MS`                                           | 300,000                  |
| `QUOTA_CACHE_MS`                                                   | 10,000                   |

Consequences that follow from these values:

- A connection can send at most 100 messages per second sustained. Fewer, larger edits (merged by the client) stay within it more easily than many tiny ones.
- At most 8 documents are flushed to Postgres at once per node, and updates to one document within 20 ms are merged into one row.
- A node keeps up to 500 hot documents in memory; documents with live subscribers are not evicted, so the cache can exceed this value. Memory therefore grows with the number of subscribed documents and their decoded size.
- Every connection that does not keep up is closed after 15 s above the high-water mark, so the buffered memory per slow connection is bounded to about the high-water mark plus one merged update per document.
- The node count for rate limiting must be set with `RL_EXPECTED_NODES`, or the Redis-failure fallback allows more than the intended total.

## Storage shape

Each committed batch is one `operations` row; each document has at most one compaction snapshot plus its checkpoints inside the history window. A snapshot is taken after 500 operations, 1 MiB of tail operations, or 60 s idle, whichever is first, so the number of operation rows per document is bounded by those triggers between worker passes (every 15 s). Checkpoints add up to one stored full state per 5 minutes of activity, for the plan's history window; this is the main contributor to storage for long-lived active documents. Storage is not measured for realistic data (see below).

## Measured results

All values below are copied from [benchmarks.md](benchmarks.md). Machine: Intel Core 5 210H, 12 logical cores, 16 GB RAM, Windows 11, Node v24.12.0. One sync node, embedded PostgreSQL 16 (control DB plus 2 shards), in-memory Redis stand-in. The load generator ran on the same machine. Results are pessimistic for the server and are not a claim about production deployments.

### 1,000 connections, steady state (3 runs)

|                                    | run 1          | run 2          | run 3          |
| ---------------------------------- | -------------- | -------------- | -------------- |
| Connections established            | 1000           | 1000           | 1000           |
| Unexpected disconnects / errors    | 0 / 0          | 0 / 0          | 0 / 0          |
| Throughput during hold (updates/s) | 195.6          | 195.7          | 197.0          |
| Ack latency p50 / p95 / p99 (ms)   | 41 / 260 / 622 | 41 / 147 / 686 | 67 / 657 / 968 |
| Propagation p95 (ms)               | 248            | 145            | 619            |
| Server CPU (percent of one core)   | 40             | 41             | 54             |
| Server peak RSS (MB)               | 395            | 352            | 356            |

Ack p95 exceeded 100 ms in all three runs, so the spec target (ack p95 under 100 ms) is not demonstrated.

### One hot document: 300 subscribers, 10 writers (1 run)

|                                               |                           |
| --------------------------------------------- | ------------------------- |
| Updates sent / acknowledged                   | 2,647 / 2,647             |
| Ack latency p50 / p95 / p99 (ms), client side | 52 / 67 / 372             |
| PostgreSQL commit p50 / p95 / p99 (ms)        | 11 / 24 / 38              |
| Propagation p50 / p95 / p99 (ms)              | 47 / 365 / 1,236          |
| Server CPU / peak RSS                         | 14 % of one core / 283 MB |

### Delta sync

|                                          | bytes on the wire                        |
| ---------------------------------------- | ---------------------------------------- |
| Full document (new device)               | 102,016                                  |
| Delta after 100 edits (returning device) | 3,884 (3.8 % of full, about 26x smaller) |

### Compaction (20,000 op rows, 3 runs)

|                                  | before                      | after                       |
| -------------------------------- | --------------------------- | --------------------------- |
| Cold load time, median of 7 (ms) | 70.7 / 69.2 / 84.1          | 25.0 / 19.9 / 28.9          |
| Stored bytes                     | 495,592 / 445,600 / 495,592 | 439,874 / 391,888 / 439,874 |

## What has not been measured

From the "Not yet measured" section of benchmarks.md:

- Steady state at 5,000 connections or on 3 nodes
- Reconnect storm and node-kill recovery time
- Redis outage behaviour with a real Redis
- Hot document with 1,000 subscribers
- IndexedDB size under 10,000 edits before and after local compaction
- Any figure from a machine other than the one above

Also not measured: any multi-shard scaling behaviour, throughput limits of a single node, and the cost of adding a shard (there is no migration tool; see [sharding.md](sharding.md)). The k6 and chaos scripts exist but have not been run. The results above do not show where a node saturates: in the steady-state runs the server used under one core, so the limit was not reached.

## Sizing method

Measure on your own hardware with your own workload, then size from the results. Do not scale the numbers above.

1. Describe the workload: connections per tenant, documents per connection, edit rate per active user, typical update size, and proportion of read-only subscribers.
2. Run the load tools against a stack that matches production (real Redis, real Postgres, the intended node and shard count): `pnpm loadtest`, or `bench.ts steady` and `bench.ts hotdoc` as in benchmarks.md. Keep the load generator on separate machines.
3. Raise connections and edit rate in steps. At each step record ack p95 and p99, propagation p95, server CPU per node, Node RSS, event-loop lag, and PostgreSQL commit time per shard (exposed by the server's Prometheus metrics).
4. Find the first resource to saturate: Node CPU on one process, Postgres commit latency, Postgres connections, Redis, or memory. Scale that resource: add nodes for CPU and connections, shards for write volume.
5. Run the reconnect storm and node-kill scripts at your connection count, since recovery time depends on how many clients return at once.
6. Test compaction on your document sizes: record cold-load time and stored bytes before and after, and the worker pass duration per shard.
7. Estimate storage by writing a representative document set, letting the worker run, and reading `size_bytes` plus snapshot sizes. Include the checkpoint history window for your plan.
8. Repeat after upgrades. Record results in benchmarks.md in the same format, with the machine and commit.

Operational signals to watch once running: connection count against the plan limit, backpressure events (slow, closed), gap recoveries (which indicate Redis loss or lag), ack latency, and the age of the oldest un-snapshotted document.

## Differences from the spec

- Doc 01 sets targets of 5,000 connections, 2,000 ops/s on 3 nodes, ack p95 under 100 ms and propagation p95 under 150 ms. These are targets, not measurements, and the current results do not meet the ack target at 1,000 connections on one node.
