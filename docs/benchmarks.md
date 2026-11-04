# Benchmarks

Every number on this page comes from a committed result file in [`loadtest/results/`](../loadtest/results)
produced by a script in [`loadtest/`](../loadtest). Nothing here is estimated. If a number is not on this
page, it has not been measured.

## Read this first: what these runs are and are not

All runs below were made with `loadtest/node/bench.ts`, because the development machine had no Docker and
no k6.

|                |                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Machine        | Intel Core 5 210H, 12 logical cores, 16 GB RAM, Windows 11 (build 26200), Node v24.12.0                                      |
| Code           | commit `131a902` plus uncommitted changes (the result files record `131a902+dirty`)                                          |
| Topology       | **one** sync node (separate process), embedded PostgreSQL 16 (control DB + 2 shards), in-memory Redis stand-in               |
| Load generator | same machine as the server, competing with it for CPU; the machine was also running an IDE, browsers and a second PostgreSQL |

Consequences:

- The server and the load generator share CPU, so results are **pessimistic for the server**.
- **Nothing here measures a multi-node deployment.** Reconnect storms, node-kill recovery time and
  cross-node fan-out latency at scale need the Docker stack and have **not** been measured. The k6 scenarios
  and chaos scripts exist (`loadtest/k6`, `loadtest/chaos`) but have never been run.
- The Redis stand-in and the embedded PostgreSQL build are not representative of production services, so
  absolute throughput is not a claim about real deployments.
- Latency varies a lot between runs on this machine (see the steady-state table). Report the range, not the best run.

Spec targets (Doc 01 section 6): ack p95 under 100 ms, cross-client propagation p95 under 150 ms at
2,000 ops/s on 3 nodes, 5,000 connections. **None of these targets is demonstrated by this page.** The
steady-state ack p95 below exceeds 100 ms in all three runs.

## 1. Steady state: 1,000 connections (`bench.ts steady`)

1,000 WebSocket clients, ramped at 100 per second, then a 60 s hold in which every client sends one
timestamped update every 5 s to a document shared with about one other client (500 documents). Only the
hold period is measured.

|                                      | run 1          | run 2          | run 3          |
| ------------------------------------ | -------------- | -------------- | -------------- |
| Connections established              | 1000           | 1000           | 1000           |
| Unexpected disconnects / errors      | 0 / 0          | 0 / 0          | 0 / 0          |
| Connect time p95 (ms)                | 329            | 303            | 537            |
| Throughput during hold (updates/s)   | 195.6          | 195.7          | 197.0          |
| **Ack latency** p50 / p95 / p99 (ms) | 41 / 260 / 622 | 41 / 147 / 686 | 67 / 657 / 968 |
| **Propagation** p95 (ms)             | 248            | 145            | 619            |
| Server CPU (percent of one core)     | 40             | 41             | 54             |
| Server peak RSS (MB)                 | 395            | 352            | 356            |

Files: `2026-11-04-steady-run{1,2,3}.json`.

Observations, not conclusions:

- Medians are 41-67 ms but tails are 3-10x worse, and the tail changed a lot from run to run, which points to
  contention (shared CPU, Windows disk sync for PostgreSQL commits) rather than a stable property of the code.
- An earlier, discarded attempt made while the machine was busy had a median ack latency of 3.6 s. It was not
  kept as a result; it shows how sensitive these measurements are to what else the machine is doing.
- The server used less than one core on average, so it was not CPU-bound; the 12-thread machine was mostly
  idle. Likely limits are PostgreSQL commits and the single-threaded Node process.

## 2. One hot document: 300 subscribers, 10 writers (`bench.ts hotdoc`)

300 subscribers plus 10 writers on one document; each writer sends 5 updates per second for 60 s
(2,647 updates in total). One run only.

|                                                                 |                           |
| --------------------------------------------------------------- | ------------------------- |
| Connections / unexpected disconnects / errors                   | 310 / 0 / 0               |
| Updates sent / acknowledged                                     | 2,647 / 2,647             |
| Ack latency p50 / p95 / p99 (ms), client side                   | 52 / 67 / 372             |
| Server-side ack histogram p50 / p95 / p99 (ms, bucket estimate) | 44 / 94 / 100             |
| PostgreSQL commit p50 / p95 / p99 (ms, server histogram)        | 11 / 24 / 38              |
| Broadcasts received by subscribers                              | 107,839                   |
| Propagation p50 / p95 / p99 (ms)                                | 47 / 365 / 1,236          |
| Server CPU / peak RSS                                           | 14 % of one core / 283 MB |

File: `2026-11-04-hot-doc-run1.json`.

Notes:

- Every update was acknowledged, so no client write was dropped. The result file also lists
  `broadcastsExpectedIfNoBatchingOrDrops` (817,923); the actual count is lower because the server merges
  updates that arrive within the 20 ms batch window into one broadcast. That difference is **not** evidence
  of loss, and this run did not verify subscriber convergence.
- Propagation is measured from a timestamp embedded in the update. When several updates are merged into
  one broadcast, only the first (oldest) timestamp is read, so propagation is overstated for merged frames.

## 3. Delta sync versus full state (`bench.ts delta`)

A ~102 KB text document; a reader that already holds it goes offline while the writer makes 100 more edits;
the reader returns with its old state vector. Measured through the real server.

|                                          | bytes on the wire                        |
| ---------------------------------------- | ---------------------------------------- |
| Full document (new device)               | 102,016                                  |
| Delta after 100 edits (returning device) | 3,884 (3.8 % of full, about 26x smaller) |

File: `2026-11-04-delta-sync-run1.json`. The script fails the run if the server's response does not match the
document it was sent, which is how an earlier version of this benchmark (that silently stored only a tenth
of the document because of the per-connection rate limit) was caught and discarded.

## 4. Compaction effect (`bench.ts compaction`)

One document with 20,000 op rows (inserts plus occasional deletions, so tombstones exist), loaded cold,
then snapshotted, verified and compacted by the real `maintainShard` job, then loaded cold again.
Storage path only: no sync node, no network. Three runs.

|                                      | before                      | after                       |
| ------------------------------------ | --------------------------- | --------------------------- |
| Op rows stored / read on load        | 20,000 / 20,000             | 0 / 0                       |
| **Cold load time, median of 7 (ms)** | 70.7 / 69.2 / 84.1          | 25.0 / 19.9 / 28.9          |
| Load time reduction                  |                             | 2.8x / 3.5x / 2.9x          |
| **Stored bytes** (ops + snapshot)    | 495,592 / 445,600 / 495,592 | 439,874 / 391,888 / 439,874 |
| Storage reduction                    |                             | 11.2 % / 12.1 % / 11.2 %    |
| Job duration (ms)                    |                             | 506 / 481 / 560             |

Files: `2026-11-04-compaction-run{1,2,3}.json`. The job's own safety check passed in every run and the
document text was identical before and after.

Interpretation: load time scales with the number of rows read, so compaction helps most on documents with
long histories. Storage savings here are small because the snapshot still holds the whole document and its
tombstones; the saving is the per-row overhead and the superseded intermediate updates, not the content.

## Not yet measured

- Steady state at 5,000 connections or on 3 nodes
- Reconnect storm and node-kill recovery time (`loadtest/k6/reconnect-storm.js`, `loadtest/chaos/kill-node.sh`)
- Redis outage behaviour with a real Redis (`loadtest/chaos/stop-redis.sh`)
- Hot document with 1,000 subscribers
- IndexedDB size under 10,000 edits before and after local compaction (the bound is asserted by a test, the sizes are not recorded)
- Any figure from a machine other than the one above

To produce them: `docker compose up -d --scale server=3`, then `docker compose --profile loadtest run --rm k6 run /scripts/ws-steady.js`
(with `SYNCRA_SECRET_KEY` from the migrate log), and record the output the way the files above are laid out.

## Reproducing the local runs

```
pnpm install
pnpm --filter @syncra/loadtest bench steady --clients 1000 --hold 60 --ramp 100
pnpm --filter @syncra/loadtest bench hotdoc --subscribers 300 --writers 10 --rate 5 --hold 60
pnpm --filter @syncra/loadtest bench delta
pnpm --filter @syncra/loadtest bench compaction
BENCH_TAG=run2 ... # tag repeated runs so results are not overwritten
```
