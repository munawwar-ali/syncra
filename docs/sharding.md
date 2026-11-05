# Sharding and data lifecycle

This page describes `apps/server/src/shards/ring.ts`, `core/`, `db/migrations/shard` and `jobs/lifecycle.ts`. Postgres is the source of truth; Redis only carries hints.

## Routing

A document is identified by `(tenantId, collection, docId)`. The shard is a pure function of that triple and the shard count.

| Property    | Value                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------- |
| Hash        | murmur3, 32-bit, seed 0, over the UTF-8 bytes                                                   |
| Ring points | 64 virtual nodes per shard, hashed from `shard-<index>#<vnode>`                                 |
| Lookup key  | `<tenantId>/<collection>/<docId>`                                                               |
| Lookup      | Binary search in a sorted array for the first point at or after the hash, wrapping to the first |
| Input       | Shard count only; the order of `SHARD_DATABASE_URLS` defines shard indexes                      |

The ring is built once at startup from `SHARD_DATABASE_URLS` (comma-separated). Different documents of one tenant land on different shards. Every query on a shard carries `tenant_id` explicitly.

## Per-shard schema

| Table            | Purpose                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `documents`      | One row per document: `uid`, `head_seq`, `snapshot_seq`, `size_bytes`, `deleted_at`; unique on `(tenant_id, collection, doc_id)` |
| `operations`     | Append-only update log, key `(doc_uid, seq)`; hash-partitioned by `doc_uid` into 16 partitions                                   |
| `op_dedup`       | `(doc_uid, client_id, op_id)` to `seq`; also 16 hash partitions                                                                  |
| `snapshots`      | Full state at `up_to_seq`; kind `compaction` or `checkpoint`                                                                     |
| `document_views` | Materialised JSON of the current state                                                                                           |
| `changes`        | Change feed (create, update, delete)                                                                                             |

The 16 partitions are inside each shard. They spread one shard's tables, and are not a second routing level.

## Writes

A write takes a row lock on the `documents` row, de-duplicates by `(clientId, opId)`, increments `head_seq`, inserts one merged `operations` row and the `op_dedup` rows, and commits. Seq is therefore gap-free per document. See [protocol.md](protocol.md) for batching.

Loading a document reads the newest snapshot, then every operation after it, into a Yjs document. Hot documents stay in an LRU cache (`HOT_DOC_CACHE_MAX` 500, idle eviction after `HOT_DOC_IDLE_MS` 60,000). The cache shrinks capacity by 25% when heap use passes 75% of the limit.

## Snapshots, compaction, checkpoints

The worker runs `doc:maintain` every 15 s on every shard, under a Redis lock so replicas do not double-run. Per-document locks use key `sx:lock:compact:<uid>` for 120 s.

| Job         | Trigger (config default)                                                                                         | Effect                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Snapshot    | `SNAPSHOT_EVERY_OPS` 500 ops, or `SNAPSHOT_EVERY_BYTES` 1,048,576 of tail ops, or `SNAPSHOT_IDLE_MS` 60,000 idle | Writes a `compaction` snapshot at head from a repeatable-read view; deletes older compaction snapshots                    |
| Compaction  | Right after a snapshot                                                                                           | Deletes ops covered by the snapshot that are older than the tenant's history window, or at or below a retained checkpoint |
| Checkpoint  | Every `CHECKPOINT_INTERVAL_MS` 300,000 if there is new activity                                                  | Writes a `checkpoint` snapshot kept for the plan's history window; used by time travel and restore                        |
| Materialise | When the view lags `head_seq` and the document is a second old                                                   | Refreshes `document_views` and adds a change-feed row                                                                     |
| Purge       | Hourly                                                                                                           | Hard-deletes documents soft-deleted over 7 days ago, and `op_dedup` rows older than 7 days                                |

Before deleting any operation the job replays the candidate ops onto the snapshot and aborts if the state changes. After deleting it reloads the document and compares state vectors; a mismatch is counted as a verify failure. Restore is non-destructive: it writes the difference between a checkpoint and the current state as a new operation.

`op_dedup` rows older than the purge window are deleted, so a retry that arrives after that window would be applied again. Yjs updates are idempotent, so the content is unchanged, but it would receive a new `seq`.

## Fan-out between nodes

After a commit the node publishes `(seq, originNode, originClient, update, sentAt)` on Redis channel `sx:doc:<tenantId>:<docKey>:ch`. Awareness uses `sx:aw:...`. Each node subscribes only for documents it holds hot.

| Situation on receiving a message         | Action                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| Origin is this node, or `seq <= headSeq` | Ignore                                                                        |
| `seq == headSeq + 1`                     | Apply and forward to local subscribers                                        |
| `seq > headSeq + 1`                      | Gap: read ops after `headSeq` from Postgres and apply them                    |
| Ops needed are gone (compacted)          | Reload the document from Postgres and send `RESYNC_HINT` to local subscribers |
| Malformed bus message                    | Drop it                                                                       |

Redis delivery is not guaranteed, so a periodic reconcile compares `head_seq` in Postgres with each subscribed hot document and runs catch-up if it is behind or removes it if it was deleted. The interval is 30 s when Redis is healthy and 5 s when it is not. A node that loses Redis keeps serving; its clients see other nodes' writes within the degraded interval.

## Adding a shard

The ring is fixed at deploy time and there is no rebalancer in the code. Changing `SHARD_DATABASE_URLS` changes routing for part of the keyspace, so a document whose owner changes becomes unreachable at its old location: it would be found empty on the new shard, and a client could then create a second copy.

Constraints:

- Appending a new URL moves about 1/N of the documents to it in principle, but the code does not move their data.
- Reordering or removing URLs changes shard indexes and routes many documents elsewhere.
- Do not add a shard to a cluster that holds data without migrating the affected documents first.

A safe migration is not implemented. A workable outline is: compute which documents change owner under the new ring, copy their rows (`documents`, `operations`, `op_dedup`, `snapshots`) to the new shard with the same `uid`, stop writes to them or fence by `head_seq`, switch the node configuration, then delete the old rows. Nothing in the repository performs these steps. A new deployment can start with any shard count.

Migrations for every shard run through `apps/server/src/db/migrate-cli.ts`.

## Differences from the spec

- Doc 02 names xxhash64 or murmur3; the code uses murmur3.
- Doc 02 describes a dual-read migration approach for adding shards; the repository has only the ring stability test (about 1/N keys move, only onto the new shard) and no migration tool, so the outline above is not implemented.
