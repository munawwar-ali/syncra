# 0019 - Multi-tab model: every tab persists, the leader owns the socket

Status: accepted | Date: 2026-10-29

## Context

Doc 04 §7 elects a leader tab (Web Locks) that owns the socket. It does not say who writes local edits
to IndexedDB or how a tab learns about edits made while it had no sibling to talk to.

## Decision

- Every tab keeps its own Y.Doc and writes its own local edits to the update log and outbox, so an
  edit is durable even if the leader dies a moment later.
- Tabs relay raw updates over BroadcastChannel; receivers apply them with origin `tab` and do not
  persist them again. The leader persists server updates and relays them to followers.
- The leader drains the shared outbox (IndexedDB) and opens documents that only followers hold.
- A tab that loads a document broadcasts its state vector; siblings answer with the missing diff
  (`sv` message), which closes the gap for tabs that start after others already broadcast.
- Followers mirror connection state from the leader; each tab counts its own pending ops.

## Alternatives

Followers forward every edit to the leader and only the leader writes (simpler, but an edit can be
lost if the follower closes before the message is delivered).

## Consequences

Edits survive any single tab closing. The cost is duplicate decoding of relayed updates in each tab.
