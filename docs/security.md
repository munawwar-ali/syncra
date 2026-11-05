# Security

This page lists what the code in `apps/server` implements. Where something is absent it is stated under "Not implemented / limits".

## Threat model summary

| Threat                                         | Mitigation in code                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A tenant reads or writes another tenant's data | Per-tenant signing secrets; `tenant_id` in every query; claims checked on each subscribe |
| Stolen or forged client token                  | HS256 with per-tenant secret, short expiry, `kid` must equal `tid`                       |
| Leaked API key                                 | Only a SHA-256 hash is stored; keys are revocable                                        |
| Stolen dashboard session                       | 15 minute access token; rotating refresh token with family revocation                    |
| Credential guessing                            | argon2id, per-IP rate limit on login, signup and invite acceptance                       |
| Database theft                                 | Signing secrets and webhook secrets are AES-256-GCM encrypted                            |
| Tampered audit history                         | Hash-chained audit log with a verify function                                            |
| SSRF through webhooks                          | Address blocklist and DNS pinning                                                        |
| Abusive clients                                | Token-bucket limits per IP, connection, tenant and awareness stream; payload limits      |

The operator who holds `ENCRYPTION_KEY` and database access can read document contents. See the limits section.

## Tenant isolation

Tenants are logical, not physical: all tenants share the control database and the shard databases. Every document query includes `tenant_id` (`core/doc-store.ts`, `jobs/lifecycle.ts`). The hot-document cache is keyed by tenant and document, and Redis channels and rate-limit keys contain the tenant id.

Dashboard requests resolve the tenant from the `X-Tenant-Id` header (or the user's only membership) and check membership before any action. A malformed tenant id is answered as "not a member". Roles are `owner`, `admin`, `developer` and `viewer`, with a capability matrix in `control/roles.ts`; secret API keys act with owner rights over data.

## Client tokens

- Algorithm HS256 only; other algorithms are rejected. Each tenant has its own random 32-byte secret, stored encrypted in the control database.
- The JWT header carries `kid` = tenant id. The verifier looks up the tenant by `kid`, refuses unknown or inactive tenants, and requires the `tid` claim to equal `kid`.
- Tokens are minted by the tenant's backend through the API, with `userId`, `access` rules (collection, `*` or a document list, `r` or `rw`), `meta` (at most 2,048 bytes) and a TTL of 1 to 86,400 seconds.
- Verification allows 30 s clock tolerance and rejects tokens whose lifetime exceeds the maximum by more than 60 s. Every failure returns the same "Invalid or expired token" message.
- Connections are closed with 4010 at token expiry. The key lookup is cached for 60 s, so a suspended tenant or rotated secret takes up to a minute to apply.
- A token in a query string is stripped from logged URLs; the SDK sends it in the WebSocket subprotocol instead.

## API keys

Secret keys (`sk_live_...`) and publishable keys (`pk_live_...`) are 32 random bytes encoded in base62. The full key is shown once. The database stores a SHA-256 hash and a short display prefix. Lookups are cached for 60 s; revocation applies on the revoking node at once and elsewhere within that time. Publishable keys cannot access data endpoints, and developers may manage only publishable keys.

## Dashboard sessions

| Item                   | Behaviour                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Password hash          | argon2id, 64 MiB memory, 3 iterations, parallelism 1                                  |
| Unknown email on login | Verifies against a dummy hash, to keep timing similar                                 |
| Access token           | JWT, 15 minutes, held in memory by the dashboard                                      |
| Refresh token          | 256-bit random value; only its SHA-256 is stored; 30 days                             |
| Cookie                 | `syncra_refresh`, `HttpOnly`, `SameSite=Lax`, `Secure` in production, path `/v1/auth` |
| Rotation               | Each refresh marks the old token used and issues a new one in the same family         |
| Reuse                  | Presenting an already-used token revokes the whole family                             |

Logout revokes the family of the presented token. CORS is limited to `CORS_ORIGINS` with credentials, and `@fastify/helmet` default headers are enabled.

## Secrets at rest

Tenant signing secrets and webhook secrets are encrypted with AES-256-GCM using `ENCRYPTION_KEY` (32 bytes, base64, validated at startup). The stored format is a 12-byte random IV, the ciphertext, then the 16-byte tag. Decryption fails if the data or key is wrong. There is no key-rotation tool; changing the key makes existing ciphertext unreadable.

## Audit log

Administrative actions are appended to `audit_log`. Each row's hash is SHA-256 of the previous row's hash plus a canonical JSON of the row (sorted keys), so editing or deleting a row breaks every later hash. A per-tenant advisory lock keeps the chain linear. `verifyAudit` recomputes the chain and returns the first broken row id. The log is tamper-evident, not tamper-proof: someone with write access to the database can rewrite the whole chain.

## Rate limits

Token buckets, shared through Redis when available. If Redis errors, each node falls back to a local bucket whose rate and capacity are divided by `RL_EXPECTED_NODES`.

| Scope                                          | Capacity / refill                                          | Config                          |
| ---------------------------------------------- | ---------------------------------------------------------- | ------------------------------- |
| HTTP requests and WebSocket upgrades per IP    | 40 / 20 per second                                         | `RL_IP_RATE` (x2 burst)         |
| WebSocket messages per connection (in process) | 200 / 100 per second                                       | `RL_CONN_BURST`, `RL_CONN_RATE` |
| Login, signup, invite acceptance per IP        | 5 / 5 per minute                                           | `RL_AUTH_PER_MIN`               |
| Token refresh per IP                           | 120 / 120 per minute (or 24 x `RL_AUTH_PER_MIN` if higher) | derived                         |
| Awareness per connection                       | 20 / 20 per second                                         | fixed                           |
| Writes per tenant                              | plan `opsPerSecond` (50, 1,000, 10,000; none for selfhost) | plan                            |

`X-Forwarded-For` is trusted only when `TRUST_PROXY=true`. Setting it without a proxy in front lets clients choose their own IP and evade per-IP limits.

## Webhooks

Deliveries are signed: header `syncra-signature: t=<unix>,v1=<hex>`, where `v1` is HMAC-SHA256 of `<t>.<raw body>` with the endpoint secret (`whsec_...`). Receivers should reject signatures more than 300 s old; the comparison is constant-time. Headers `syncra-event` and `syncra-delivery` identify the event and delivery id; the same delivery id is reused on retries, so receivers should de-duplicate.

SSRF guard (`webhooks/ssrf.ts`): only `http` and `https`, no credentials in the URL, and the host is resolved and refused if any address is loopback, private (10/8, 172.16/12, 192.168/16), link-local (including 169.254.169.254), carrier-grade NAT, multicast or reserved, or the IPv6 equivalents. The connection goes to the validated IP, so DNS cannot change between check and connect. The guard runs at delivery time, not only when the endpoint is saved. `WEBHOOK_ALLOW_PRIVATE=true` disables it and is meant for local development. Requests time out after 10 s; failed deliveries retry after 10 s, 30 s, 2 min, 10 min, 30 min, 1 h, 3 h and 12 h, then are marked dead.

## Input validation

HTTP bodies and queries are parsed with Zod; failures return `VALIDATION_FAILED` with field paths. WebSocket frames are decoded by a strict lib0 decoder that rejects unknown types and trailing bytes; document keys, client ids and collection names are checked against regular expressions. A Yjs update is trial-applied to a scratch document before it touches the live one. All SQL uses parameters. Limits: 1 MiB per update and per REST body, 2 MiB per WebSocket frame, 8 KiB per awareness update, 200 subscriptions per connection.

## Logging

The logger (pino) redacts `Authorization` and `Cookie` headers and any `password` or `token` field, and replaces `token=` in logged URLs with `[redacted]`. Document contents and secrets are not logged. Unexpected errors are logged with the connection id, not the payload. API responses for internal errors return a generic message.

## Not implemented / limits

- No end-to-end encryption. The server reads document contents in clear (to merge, snapshot, materialise JSON views and run time travel). Data is not encrypted at rest by Syncra beyond the secrets above; use disk or database encryption.
- No TLS termination in the application. Run behind a TLS-terminating proxy.
- No `Origin` check on WebSocket upgrades; authentication relies on the token.
- No per-user revocation of client tokens before expiry. Keep TTLs short; deactivating the tenant or rotating its secret invalidates all of its tokens within the 60 s cache.
- No `ENCRYPTION_KEY` rotation, and no two-factor authentication or SSO for the dashboard.
- No malware or content scanning of document data.
- The audit log is tamper-evident only; it is not anchored outside the database.
- Rate limits are approximate under Redis failure (per-node fallback), and the key cache can delay revocation by up to 60 s.
- Read-only subscriptions are enforced per document by the server; a client with `r` access still receives the full document state.
- No formal security audit or penetration test has been done.

## Differences from the spec

- Doc 02 and Doc 03 list close codes 4001, 4008 and 4009 for auth, rate and size failures; the gateway answers auth and rate failures with HTTP 401 and 429 at upgrade, and oversize frames with 1009.

## Dependency audit

`pnpm audit --prod --audit-level high` runs in CI. One advisory is accepted for now: GHSA-mrhx-c7xc-m3w5 (memory use when zod validates very large constrained collections). The fix exists only in zod 4, and moving the server and dashboard from zod 3 is a planned migration. Request bodies are limited to 1 MiB and WebSocket messages to 2 MiB by default, which bounds the input size. Moderate advisories in `react-router` (dashboard), `@tiptap/core` (notes demo) and `glob` through `node-pg-migrate` (migration tooling) also need major version upgrades.
