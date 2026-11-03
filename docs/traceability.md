# Traceability

Every feature ID in `docs/spec/01_Product_Requirements.md` maps to at least one automated test.
Status: `todo` (not built), `partial`, `pass`.

| Feature ID                    | Test file                                                                     | Status                                                        |
| ----------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| OPS-07                        | apps/server/src/app.test.ts                                                   | partial (mocked deps; real-stack check in A0-3)               |
| OPS-08                        | apps/server/src/app.test.ts (`/metrics`)                                      | partial                                                       |
| SYN-06                        | apps/server/src/core/write-batcher.test.ts                                    | partial (batcher unit only; op-row count needs doc-store)     |
| SYN-11                        | packages/protocol/src/index.test.ts (fuzz)                                    | partial (decoder only; size limits need gateway)              |
| SYN-01                        | apps/server/test/sync.int.test.ts                                             | partial (multi-doc on one socket covered in A1-5 test)        |
| SYN-02                        | apps/server/test/sync.int.test.ts (delta)                                     | pass                                                          |
| SYN-03                        | apps/server/test/sync.int.test.ts (converge)                                  | partial (latency p95 measured in Phase 5)                     |
| SYN-04                        | apps/server/test/sync.int.test.ts (durability)                                | pass                                                          |
| SYN-05                        | apps/server/test/sync.int.test.ts (idempotency)                               | pass                                                          |
| SYN-07                        | apps/server/test/doc-store.int.test.ts                                        | pass                                                          |
| SYN-08                        | apps/server/test/doc-store.int.test.ts                                        | pass                                                          |
| SYN-12                        | apps/server/test/sync.int.test.ts (read-only)                                 | pass                                                          |
| CLI-01, CLI-02                | packages/client/src/client.int.test.ts (reload offline)                       | pass (browser-level check: Playwright, Phase 2 demo)          |
| CLI-03                        | packages/client/src/machine.test.ts                                           | pass                                                          |
| CLI-04                        | packages/client/src/backoff.test.ts                                           | pass                                                          |
| CLI-05                        | packages/client/src/client.int.test.ts (offline)                              | pass                                                          |
| CLI-06                        | packages/client/src/multitab.int.test.ts, tabs.test.ts                        | pass (jsdom-free fakes; real browser in Playwright)           |
| CLI-07                        | packages/client/src/client.int.test.ts (10,000 edits)                         | pass                                                          |
| CLI-08                        | packages/client/src/token.test.ts, client.int.test.ts                         | pass                                                          |
| CLI-09                        | packages/client/src/client.int.test.ts                                        | pass                                                          |
| CLI-10                        | packages/client/src/client.int.test.ts                                        | pass                                                          |
| CLI-11                        | packages/client/src/client.int.test.ts                                        | pass                                                          |
| CLI-12                        | packages/client/src/client.int.test.ts, store.test.ts                         | pass                                                          |
| CLI-13                        | packages/client/src/client.int.test.ts                                        | pass                                                          |
| OPS-05                        | packages/client/src/client.int.test.ts (quota)                                | pass (client side; server quotas in Phase 3)                  |
| DEM-01 (steps 1-5), CLI-01/02 | apps/demo-notes/e2e/notes.spec.ts                                             | pass (Edge via PW_CHANNEL=msedge)                             |
| CLI-06 (browser)              | apps/demo-notes/e2e/notes.spec.ts (multi-tab)                                 | pass                                                          |
| DEM-04                        | apps/demo-notes/src/ChaosPanel.tsx                                            | partial (UI built; no automated test yet)                     |
| COL-03                        | packages/react/src/index.test.tsx                                             | pass                                                          |
| AUT-01, AUT-02                | apps/server/test/auth.int.test.ts                                             | pass                                                          |
| AUT-03                        | apps/server/test/auth.int.test.ts (roles)                                     | pass                                                          |
| AUT-04                        | apps/server/test/auth.int.test.ts (keys)                                      | pass (cross-node expiry simulated by clearing the cache)      |
| AUT-05, AUT-06                | apps/server/test/auth.int.test.ts (client tokens)                             | pass                                                          |
| AUT-07                        | apps/server/test/isolation.int.test.ts (every route + WS + route inventory)   | pass                                                          |
| AUT-08                        | apps/server/test/auth.int.test.ts (audit)                                     | pass                                                          |
| AUT-09                        | apps/server/test/auth.int.test.ts (invitations)                               | pass (console mailer)                                         |
| OPS-01                        | apps/server/test/limits.int.test.ts, src/limits/token-bucket.test.ts          | pass (Lua verified on ioredis-mock only)                      |
| OPS-03                        | apps/server/test/limits.int.test.ts (quotas)                                  | pass                                                          |
| OPS-04                        | apps/server/test/limits.int.test.ts (metering)                                | pass                                                          |
| OPS-05                        | apps/server/test/limits.int.test.ts (SDK quota-blocked, drains after upgrade) | pass                                                          |
| OPS-06                        | apps/server/test/limits.int.test.ts (webhooks)                                | pass                                                          |
| BIL-01, BIL-05                | apps/server/test/limits.int.test.ts                                           | pass                                                          |
| SYN-09                        | apps/server/test/data.int.test.ts (HTTP fallback)                             | partial (server endpoints done; SDK polling client not built) |
| SYN-12                        | apps/server/test/limits.int.test.ts (WS + HTTP)                               | pass                                                          |
| DAT-07                        | apps/server/test/data.int.test.ts (soft delete)                               | partial (soft delete done; hard purge job in Phase 4)         |
| OPS-02                        | none                                                                          | todo (Phase 4)                                                |
