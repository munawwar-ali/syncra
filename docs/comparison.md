# Comparison

Choose Syncra if you want Yjs-style CRDT documents, self-hosting, and a ready platform. Choose another tool if you need relational sync, queries, or a fully managed service.

| Solution                                 | Strengths                                   | Trade-offs compared with Syncra's niche                                 |
| ---------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| Firebase Firestore                       | Mature, offline persistence, huge ecosystem | Hosted, vendor lock-in, field-level last-write-wins conflicts           |
| Supabase Realtime                        | Excellent Postgres tooling                  | Realtime delivery, not an offline-first merge runtime                   |
| PouchDB with CouchDB                     | Proven replication                          | Revision conflicts need application-level resolution; older ecosystem   |
| Liveblocks and similar                   | Polished collaboration platform             | Hosted and closed                                                       |
| Hocuspocus, y-websocket, y-sweet         | Excellent Yjs servers                       | Less out of the box for tenancy, quotas, dashboard and a client runtime |
| PowerSync, ElectricSQL, Replicache, Zero | Strong SQL-oriented sync                    | Different data model: they sync relational data                         |
| Automerge repo                           | Alternative CRDT with sync tooling          | Different CRDT ecosystem                                                |

This table is a summary from the project's own research. Check each product's current documentation before deciding.

## Honest limits of Syncra

- Young project: no production users, no third-party security audit.
- Measured performance covers a single node on one laptop ([benchmarks](./benchmarks.md)); multi-node behaviour is designed and tested in simulation, not benchmarked.
- No queries, no end-to-end encryption, no relational data.
