# Sync protocol (WebSocket, version 1)

This page describes what the code in `packages/protocol/src/index.ts`, `apps/server/src/ws/gateway.ts`, `apps/server/src/ws/outbound.ts` and `packages/client/src/engine.ts` does. Delivery is at-least-once, and operations are idempotent, so a repeated delivery has no further effect.

## Connection

```
GET /v1/connect?clientId=<id>&v=1        (HTTP Upgrade)
Sec-WebSocket-Protocol: syncra.v1, syncra.token.<jwt>
```

| Item        | Behaviour                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Path        | Only `/v1/connect`; any other upgrade path is destroyed.                                                                      |
| Subprotocol | The server always selects `syncra.v1`.                                                                                        |
| Token       | Read from the `token` query parameter, or else from the `syncra.token.<jwt>` subprotocol entry. The SDK uses the subprotocol. |
| `clientId`  | Required, must match `^[A-Za-z0-9_.:-]{1,128}$`.                                                                              |
| `v`         | Sent by the SDK; the server does not read it.                                                                                 |
| Frames      | Binary only. A text frame closes the socket with 1003.                                                                        |

The token is an HS256 JWT signed with the tenant's own secret (see [security.md](security.md)). A failed upgrade is answered with an HTTP status before the socket opens.

| HTTP status | Cause                                                         |
| ----------- | ------------------------------------------------------------- |
| 400         | `clientId` missing or malformed.                              |
| 401         | Token missing, invalid or expired, or any other auth failure. |
| 429         | Per-IP connection bucket empty.                               |
| 503         | Node is draining; the client should try another node.         |

A second connection with the same `(tenantId, clientId)` closes the older one with 1000 `replaced`. The server closes a connection with 4010 when the token's `exp` passes; the SDK then fetches a new token and reconnects.

## Framing

Every frame is one lib0 binary message: `varUint type`, `varString docKey`, then the fields of that type in order. `varUint8Array` is a length-prefixed byte string. A frame with an unknown type, a short read or trailing bytes is a `ProtocolError`. `docKey` is `<collection>/<docId>`, or empty for connection-level messages.

| Code | Type               | Direction | Fields after `docKey`                                      |
| ---- | ------------------ | --------- | ---------------------------------------------------------- |
| 0    | `SUBSCRIBE`        | C to S    | `flags` (uint; bit 0 = read-only request)                  |
| 1    | `SUBSCRIBED`       | S to C    | `headSeq` (uint), `access` (uint; 1 = rw, 0 = r)           |
| 2    | `SYNC_STEP1`       | both      | `stateVector` (bytes)                                      |
| 3    | `SYNC_STEP2`       | both      | `update` (bytes), `seq` (uint)                             |
| 4    | `UPDATE`           | C to S    | `opId` (string), `update` (bytes)                          |
| 5    | `UPDATE_BROADCAST` | S to C    | `seq` (uint), `originClientId` (string), `update` (bytes)  |
| 6    | `ACK`              | S to C    | `opId` (string), `seq` (uint)                              |
| 7    | `AWARENESS`        | both      | `update` (bytes; Yjs awareness encoding)                   |
| 8    | `UNSUBSCRIBE`      | C to S    | none                                                       |
| 9    | `ERROR`            | S to C    | `code` (string), `message` (string), `retryAfterMs` (uint) |
| 10   | `PING`             | both      | `timestampMs` (uint)                                       |
| 11   | `PONG`             | both      | `timestampMs` (uint)                                       |
| 12   | `RESYNC_HINT`      | S to C    | `headSeq` (uint)                                           |

The server rejects any client-sent `SUBSCRIBED`, `UPDATE_BROADCAST`, `ACK`, `ERROR` or `RESYNC_HINT` with `VALIDATION_FAILED`. `SYNC_STEP2` from a client is treated as a write. The `update` bytes are Yjs v1 updates.

## Flow

1. The client opens the socket, sends `PING`, then `SUBSCRIBE` for every attached document. The server answers `PONG` immediately.
2. The server checks the token's access rules for the document. No match gives `FORBIDDEN`; `rw` is downgraded to read-only if `flags & 1`. It replies `SUBSCRIBED` with `headSeq` and the granted mode, then sends stored awareness states to the new subscriber.
3. The client sends `SYNC_STEP1` with its state vector. The server replies `SYNC_STEP2` (what the client lacks, with `seq` = current head) followed by its own `SYNC_STEP1`.
4. On the server's `SYNC_STEP1` the client computes what the server lacks and, if non-empty, sends it as an `UPDATE` with opId `sync:<clientId>:<n>`. The server stores it like any other update and answers `ACK`.
5. While live, each local edit is an `UPDATE`. After the batch is committed in Postgres the server sends `ACK(opId, seq)` to the sender and `UPDATE_BROADCAST` to other local subscribers, then publishes to other nodes.
6. The sender's own connection is skipped in the broadcast when the batch came from a single client.
7. On `RESYNC_HINT` the client repeats step 3.
8. `UNSUBSCRIBE` removes the subscription and announces the connection's awareness clients as gone.

`SYNC_STEP2` from a client is stored under a generated opId (`step2:<connId>:<n>`), which is unique per call and so is not de-duplicated.

## Ordering, idempotency and batching

- Messages on one connection are handled in order, one at a time, so a connection's updates are applied to the hot document in arrival order. Commits, and therefore ACKs, complete asynchronously.
- The ordering on the server is: persist, then ACK, then broadcast to local subscribers, then publish to other nodes.
- The pair `(clientId, opId)` is unique per document in table `op_dedup`. A repeated pair returns the original `seq` and writes no new row. A batch made only of repeats sends an ACK and no broadcast.
- Updates for one document that arrive within `BATCH_WINDOW_MS` (20) or up to `BATCH_MAX_BYTES` (262,144) are merged with `Y.mergeUpdates` into one `operations` row with one `seq`. All items in a batch receive the same `seq`. The batcher flushes at most 8 documents at a time.
- `seq` is assigned under a row lock on the document and has no gaps. It is per document, not global.
- The client keeps unsent edits in an outbox, merges queued entries for one document into a single `UPDATE`, and re-queues entries that were sent but not acknowledged when it reconnects. Because opIds are reused on resend, a repeat is harmless.
- An empty Yjs update (2 bytes `00 00`) is not stored; the server returns the current head seq.
- The server allows 256 unacknowledged writes per connection; at that point it pauses reading from the socket until some complete.

## Errors

An `ERROR` frame carries the document key when known, a code, a message and `retryAfterMs` (0 if none). It does not close the connection.

| Code                | When on the socket                                                                                                         | Client behaviour                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `VALIDATION_FAILED` | Bad frame, bad `docKey`, not subscribed, malformed update or state vector, too many subscriptions, unexpected message type | Reported to `onError`.                              |
| `FORBIDDEN`         | No access rule for the document, or write on a read-only subscription                                                      | Document marked blocked.                            |
| `NOT_FOUND`         | Document missing or soft-deleted                                                                                           | Document marked blocked.                            |
| `PAYLOAD_TOO_LARGE` | Update over `MAX_UPDATE_BYTES`, or awareness update over 8,192 bytes                                                       | Reported to `onError`.                              |
| `RATE_LIMITED`      | Connection message bucket empty (sent at most once per second)                                                             | Waits `max(retryAfterMs, 500)`, re-queues, retries. |
| `QUOTA_EXCEEDED`    | Plan limit on documents, document size or storage                                                                          | Document marked blocked; re-queues.                 |
| `UNAVAILABLE`       | Storage commit failed                                                                                                      | Waits at least 5,000 ms, re-queues, retries.        |
| `INTERNAL`          | Unexpected failure (logged server-side)                                                                                    | Reported to `onError`.                              |

When the message bucket is empty the offending frame is dropped, not queued. The client must resend it after backing off.

### Close codes

| Code | Name            | Sent by the server when                                                  |
| ---- | --------------- | ------------------------------------------------------------------------ |
| 1000 | NORMAL          | An older connection with the same `clientId` is replaced.                |
| 1001 | GOING_AWAY      | Graceful shutdown.                                                       |
| 1003 | (standard)      | A text frame arrived.                                                    |
| 1009 | (standard)      | A frame exceeded `MAX_MESSAGE_BYTES`; closed by the `ws` library.        |
| 1013 | TRY_AGAIN_LATER | A slow consumer stayed above the high-water mark for `WS_SLOW_CLOSE_MS`. |
| 4003 | FORBIDDEN       | A connection slot could not be reserved for a reason other than quota.   |
| 4010 | TOKEN_EXPIRED   | The token's `exp` passed.                                                |
| 4402 | QUOTA_EXCEEDED  | The tenant's concurrent connection limit is reached.                     |

`CLOSE_CODES` also defines 4001, 4008, 4009 and 4500. The gateway does not send them: authentication and rate failures are HTTP statuses at upgrade, and oversize frames close with 1009.

## Keep-alive

The client sends `PING` every 25 s and drops the socket if no `PONG` arrives in time. The server sends protocol-level WebSocket pings every 30 s and terminates a connection that has been silent for 60 s. Application `PING` also counts as traffic.

## Backpressure

When a socket's buffered bytes exceed `WS_OUTBOUND_HIGH_WATER` (1,048,576), `UPDATE_BROADCAST` frames are held per document and merged with `Y.mergeUpdates`. They are sent when the buffer falls to half the mark. Merged frames carry the highest `seq` and `originClientId` = `multi`. Awareness frames to a slow consumer are dropped. If the consumer is still slow after `WS_SLOW_CLOSE_MS` (15,000), the server closes with 1013 and the client delta-syncs on reconnect. Control frames (ACK, ERROR, PONG, SYNC_*) are always sent.

## Reconnect

The SDK backs off with full jitter: `random(0, min(30,000, 500 * 2^attempt))` ms, raised to `retryAfterMs` if given. The attempt counter resets after 30 s in the live state. After reconnect it re-subscribes and re-syncs every document; no state is kept on the server per client.

## Limits

| Limit                           | Value                                                              | Source                                 |
| ------------------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| Max frame (`MAX_MESSAGE_BYTES`) | 2,097,152                                                          | config, env override                   |
| Max update (`MAX_UPDATE_BYTES`) | 1,048,576                                                          | config, env override                   |
| Subscriptions per connection    | 200                                                                | `LIMITS.maxSubscriptionsPerConnection` |
| Awareness update                | 8,192 bytes; 20 per second per connection                          | gateway                                |
| Messages per connection         | burst 200, refill 100 per second (`RL_CONN_BURST`, `RL_CONN_RATE`) | config                                 |
| Upgrade attempts per IP         | burst 40, refill 20 per second (`RL_IP_RATE` x 2, `RL_IP_RATE`)    | config                                 |
| In-flight writes per connection | 256                                                                | gateway                                |
| Token lifetime                  | at most 86,400 s (+60 s tolerance)                                 | `LIMITS.maxTokenTtlSeconds`            |
| `docId`                         | `^[A-Za-z0-9_.:-]{1,128}$`                                         | shared                                 |
| Collection                      | `^[a-z][a-z0-9_-]{0,63}$`, or the reserved `__index`               | shared                                 |

## Worked example

Client `c1` (read-write) opens `notes/n1` which already has head seq 7, then types and a second client `c2` is subscribed.

```
c1 -> S  PING            docKey=""        t=1700000000000
S  -> c1 PONG            docKey=""        t=1700000000000
c1 -> S  SUBSCRIBE       notes/n1         flags=0
S  -> c1 SUBSCRIBED      notes/n1         headSeq=7 access=1
c1 -> S  SYNC_STEP1      notes/n1         stateVector=<c1 vector>
S  -> c1 SYNC_STEP2      notes/n1         update=<missing ops> seq=7
S  -> c1 SYNC_STEP1      notes/n1         stateVector=<server vector>
         (c1 has nothing the server lacks, so it sends no UPDATE)
c1 -> S  UPDATE          notes/n1         opId="c1-42" update=<delta>
         ... batch window (20 ms), commit to Postgres: seq 8 ...
S  -> c1 ACK             notes/n1         opId="c1-42" seq=8
S  -> c2 UPDATE_BROADCAST notes/n1        seq=8 originClientId="c1" update=<delta>
```

If the ACK is lost because the socket drops, `c1` reconnects and sends `UPDATE opId="c1-42"` again. The server finds `(c1, c1-42)` in `op_dedup`, writes nothing and answers `ACK opId="c1-42" seq=8`.

## Differences from the spec

- Doc 03 says the client id is a UUID; the code accepts any string matching the pattern above.
- Doc 03 lists 4001, 4008 and 4009 as close codes; the gateway never sends them (HTTP statuses at upgrade, and 1009 for oversize frames).
- The `v` query parameter is sent but not checked, so there is no version negotiation yet.
