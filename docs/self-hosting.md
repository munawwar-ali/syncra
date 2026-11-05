# Self-hosting

Syncra runs as a set of containers: sync nodes, a worker, three PostgreSQL databases (one control plane and two data shards), Redis, and Nginx. The reference setup is `infra/compose/docker-compose.yml`.

::: warning Status
The compose file passes `docker compose config`, but the images have not been built or run by the project's author. Measured results in [benchmarks](./benchmarks.md) come from a single-node run without Docker.
:::

## Run it

```bash
docker compose -f infra/compose/docker-compose.yml up -d --build
docker compose -f infra/compose/docker-compose.yml up -d --scale server=3   # three sync nodes
```

| URL                                 | What                              |
| ----------------------------------- | --------------------------------- |
| `http://localhost:8080/`            | Dashboard                         |
| `http://localhost:8080/notes/`      | Demo: collaborative notes         |
| `http://localhost:8080/inspection/` | Demo: field inspection PWA        |
| `http://localhost:3000`             | Grafana (Prometheus is pre-wired) |

On first start the `migrate` service creates the schema on all databases and a demo tenant. Its log and `.syncra/.syncra-demo-credentials.txt` show the demo login and keys once.

## Settings you must change before exposing it

The compose file ships development defaults so a fresh clone starts. Copy `.env.example` to `.env` and set at least:

| Variable                     | Purpose                                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`          | Password for all three databases                                                                                                                                             |
| `JWT_ACCESS_SECRET`          | Signs dashboard sessions (32+ random bytes)                                                                                                                                  |
| `ENCRYPTION_KEY`             | Base64, 32 bytes. Encrypts tenant signing secrets and webhook secrets. **Losing it makes those secrets unrecoverable**                                                       |
| `METRICS_TOKEN`              | When set, `/metrics` requires it as the basic-auth password (Prometheus uses the same value). When empty, `/metrics` is open on the internal network; Nginx never exposes it |
| `PUBLIC_URL`, `CORS_ORIGINS` | Your public address and allowed browser origins                                                                                                                              |
| `DEMO_MODE=false`            | Disables the unauthenticated demo token endpoint and the demo data seed                                                                                                      |
| `SEED_DEMO_TENANT=false`     | Skips creating the demo tenant                                                                                                                                               |
| `TRUST_PROXY=true`           | Only when behind a reverse proxy you control, so rate limits see real client addresses                                                                                       |

Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

The full list of settings, with defaults, is in `.env.example` and `apps/server/src/config.ts`.

## Plans and billing

Self-hosted installs default to the `selfhost` plan and `BILLING_ENABLED=false`: quotas are not enforced and no invoices are produced. Invoices are simulated; there is no payment provider integration.

## Backups

All state is in PostgreSQL (the control database and the shards). Back up all three databases together with `pg_dump`, plus your `.env`. Redis holds only transient data (fan-out hints, rate limits), and the server recovers from its loss.

## Upgrades

Run `migrate` (it is part of `docker compose up`) before starting new server and worker versions. Take a backup first; there are no down-migrations.

## Operations

- Health: `GET /healthz` (process), `GET /readyz` (databases and Redis).
- Metrics: Prometheus scrapes every node and the worker, with alert rules in `infra/prometheus/alerts.yml`; the Grafana dashboard is provisioned automatically.
- Logs are JSON with a request id. Secrets, tokens and document contents are never logged.
- Scaling: add `--scale server=N`. To add a data shard, see [sharding](./sharding.md).
- Chaos and load tests: `loadtest/` (see [benchmarks](./benchmarks.md)).

## Not provided

No managed backups, no automatic TLS (terminate TLS in front of Nginx), no e-mail delivery (invitation links are shown in the dashboard), no payment processing.
