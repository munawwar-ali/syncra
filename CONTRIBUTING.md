# Contributing

- Setup: `pnpm install`, then `docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.dev.yml up -d`, then `pnpm db:migrate`.
- Before a PR: `pnpm lint && pnpm typecheck && pnpm test`.
- Commits follow Conventional Commits, for example `feat(server): add token bucket limiter`.
- Architectural choices not covered by `docs/spec/` get an ADR in `docs/adr/`.
