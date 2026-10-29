# Traceability

Every feature ID in `docs/spec/01_Product_Requirements.md` maps to at least one automated test.
Status: `todo` (not built), `partial`, `pass`.

| Feature ID | Test file                                  | Status                                                    |
| ---------- | ------------------------------------------ | --------------------------------------------------------- |
| OPS-07     | apps/server/src/app.test.ts                | partial (mocked deps; real-stack check in A0-3)           |
| OPS-08     | apps/server/src/app.test.ts (`/metrics`)   | partial                                                   |
| SYN-06     | apps/server/src/core/write-batcher.test.ts | partial (batcher unit only; op-row count needs doc-store) |
| SYN-11     | packages/protocol/src/index.test.ts (fuzz) | partial (decoder only; size limits need gateway)          |
