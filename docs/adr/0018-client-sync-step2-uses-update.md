# 0018 - Client extra state is sent as UPDATE, not SYNC_STEP2

Status: accepted | Date: 2026-10-29

## Context

Doc 03 §5.4 says the client's SYNC_STEP2 is ACKed with an opId `sync:{clientId}:{counter}`, but the
SYNC_STEP2 frame has no opId field.

## Decision

The SDK sends the "updates the server lacks" as a normal `UPDATE` with that `sync:` opId, so the
outbox, ACK and idempotency paths are identical to live edits. The server still accepts a client
`SYNC_STEP2` (y-protocols style) and persists it under a server-generated opId.

## Alternatives

Add an opId field to SYNC_STEP2 (changes the locked wire format).

## Consequences

One write path. An empty extra-state update is ACKed without consuming a seq.
