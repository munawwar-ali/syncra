# compaction - 2026-11-04

Git: `131a902+dirty` | Intel(R) Core(TM) 5 210H, 12 logical cores, 16 GB RAM | win32 10.0.26200 | Node v24.12.0

Topology: 1 sync node (separate process) + embedded PostgreSQL 16 (control + 2 shards) + in-memory Redis stand-in; load generator on the same machine

## Configuration

```json
{
  "opRows": 20000,
  "editMix": "insert 2 chars each; delete 1 char every 3rd edit",
  "retentionDays": 30,
  "driver": "maintainShard (the worker job): checkpoint, snapshot, verify, delete covered ops"
}
```

## Results

```json
{
  "before": {
    "coldLoadMs": {
      "median": 69.16,
      "min": 59.27,
      "max": 99.16,
      "runs": 7
    },
    "opRowsRead": 20000,
    "opRowsStored": 20000,
    "opBytesStored": 445600,
    "snapshotBytesStored": 0,
    "totalBytesStored": 445600,
    "characters": 25003
  },
  "after": {
    "coldLoadMs": {
      "median": 19.86,
      "min": 17.34,
      "max": 30.32,
      "runs": 7
    },
    "opRowsRead": 0,
    "opRowsStored": 0,
    "opBytesStored": 0,
    "snapshotBytesStored": 391888,
    "totalBytesStored": 391888,
    "characters": 25003
  },
  "maintenancePassMs": 481.09,
  "job": {
    "snapshots": 1,
    "compactions": 1,
    "rowsDeleted": 20000,
    "bytesReclaimed": 445600,
    "verifyFailures": 0,
    "checkpoints": 1,
    "materialized": 1
  },
  "loadTimeReduction": 3.48,
  "storedBytesReductionPercent": 12.05
}
```

## Caveats

- Load generator and server run on the same machine and compete for CPU; the numbers are pessimistic for the server and say nothing about network latency.
- One sync node only. Multi-node fan-out, reconnect storms and node-failure recovery need the Docker stack and are NOT measured here.
- Redis is an in-process stand-in (ioredis-mock) and Postgres is an embedded build, so absolute throughput is not representative of managed services.
- Propagation latency is measured between two sockets of the same load-generator process, so both sides share one clock.
