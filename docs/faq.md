# FAQ

## Is Syncra a new CRDT?

No. It uses [Yjs](https://yjs.dev) for all merging. Syncra adds the server, persistence, tenancy, quotas, dashboard and client runtime.

## What delivery guarantees do I get?

At-least-once delivery with idempotent operations. A write is acknowledged after it is committed to PostgreSQL. A client that never receives the acknowledgement resends it, and the server does not apply it twice.

## What happens when two people edit the same thing offline?

Text and arrays merge. For a single map key (for example a status field), one value wins by Yjs rules and the other is discarded. Design fields that must never conflict as separate keys or as append-only lists.

## Can I run it without Docker?

`pnpm dev` starts a Docker-free local stack (embedded PostgreSQL, an in-memory Redis stand-in, one node). It is for development and tests, not production.

## Is it production ready?

Not yet. It has no production users or external audit, and the Docker deployment has not been exercised by the author. See [comparison](./comparison.md) for limits.

## Does it support end-to-end encryption?

No. The server can read document contents. Data is encrypted in transit when you terminate TLS in front of it, and secrets are encrypted at rest.

## Can I query documents?

No. The REST API lists and reads documents and exports them as JSON; there is no query language. Keep your own index if you need one, fed by webhooks or the change feed (see `openapi.yaml`).

## How big can a document be?

Single updates are limited to 1 MiB and WebSocket messages to 2 MiB by default (`MAX_UPDATE_BYTES`, `MAX_MESSAGE_BYTES`). Long histories are compacted by the worker. See [capacity](./capacity.md).

## Where are the numbers behind your claims?

[benchmarks](./benchmarks.md) lists only measured results, with the hardware and the result files. Anything not measured is listed as such.

## How do I report a security problem?

See `SECURITY.md` in the repository.
