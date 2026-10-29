# Traceability

Every feature ID in `docs/spec/01_Product_Requirements.md` maps to at least one automated test.
Status: `todo` (not built), `partial`, `pass`.

| Feature ID | Test file                                       | Status                                                    |
| ---------- | ----------------------------------------------- | --------------------------------------------------------- |
| OPS-07     | apps/server/src/app.test.ts                     | partial (mocked deps; real-stack check in A0-3)           |
| OPS-08     | apps/server/src/app.test.ts (`/metrics`)        | partial                                                   |
| SYN-06     | apps/server/src/core/write-batcher.test.ts      | partial (batcher unit only; op-row count needs doc-store) |
| SYN-11     | packages/protocol/src/index.test.ts (fuzz)      | partial (decoder only; size limits need gateway)          |
| SYN-01     | apps/server/test/sync.int.test.ts               | partial (multi-doc on one socket covered in A1-5 test)    |
| SYN-02     | apps/server/test/sync.int.test.ts (delta)       | pass                                                      |
| SYN-03     | apps/server/test/sync.int.test.ts (converge)    | partial (latency p95 measured in Phase 5)                 |
| SYN-04     | apps/server/test/sync.int.test.ts (durability)  | pass                                                      |
| SYN-05     | apps/server/test/sync.int.test.ts (idempotency) | pass                                                      |
| SYN-07     | apps/server/test/doc-store.int.test.ts          | pass                                                      |
| SYN-08     | apps/server/test/doc-store.int.test.ts          | pass                                                      |
| SYN-12     | apps/server/test/sync.int.test.ts (read-only)   | pass                                                      |
