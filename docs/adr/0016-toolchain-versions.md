# 0016 - Toolchain versions on the dev machine

Status: accepted | Date: 2026-10-28

## Context

Doc 00 locks Node 22 LTS and pnpm 9. The development machine has Node 24 and pnpm 10.

## Decision

`engines.node` is `>=22`; CI runs Node 22. `packageManager` pins the installed pnpm 10. No
pnpm-9-specific behaviour is relied on.

## Alternatives

Install Node 22 and pnpm 9 locally via nvm/corepack. Rejected as extra setup with no benefit.

## Consequences

CI (Node 22) is the compatibility check for the locked runtime.
