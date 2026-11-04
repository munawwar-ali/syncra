# delta-sync - 2026-11-04

Git: `131a902+dirty` | Intel(R) Core(TM) 5 210H, 12 logical cores, 16 GB RAM | win32 10.0.26200 | Node v24.12.0

Topology: 1 sync node (separate process) + embedded PostgreSQL 16 (control + 2 shards) + in-memory Redis stand-in; load generator on the same machine

## Configuration

```json
{
  "documentCharacters": 102290,
  "offlineEdits": 100
}
```

## Results

```json
{
  "documentStateBytes": 102016,
  "fullStateBytesOnWire": 102016,
  "deltaBytesOnWire": 3884,
  "deltaAsPercentOfFull": 3.81,
  "reductionFactor": 26.27
}
```

## Caveats

- Load generator and server run on the same machine and compete for CPU; the numbers are pessimistic for the server and say nothing about network latency.
- One sync node only. Multi-node fan-out, reconnect storms and node-failure recovery need the Docker stack and are NOT measured here.
- Redis is an in-process stand-in (ioredis-mock) and Postgres is an embedded build, so absolute throughput is not representative of managed services.
- Propagation latency is measured between two sockets of the same load-generator process, so both sides share one clock.
