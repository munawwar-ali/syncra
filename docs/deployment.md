# Deployment

This guide covers deploying the reference stack to a single Linux host. A Terraform reference for AWS is not provided yet.

## Single host

1. Install Docker with Compose v2 and open ports 80 and 443 only.
2. Copy `.env.example` to `.env` and set the secrets listed in [self-hosting](./self-hosting.md), `PUBLIC_URL` (your https address), `DEMO_MODE=false` and `SEED_DEMO_TENANT=false`.
3. Put a TLS-terminating proxy (Caddy, Traefik or a cloud load balancer) in front of the `nginx` service. It must pass WebSocket upgrades and allow connections that stay open for hours.
4. Start: `docker compose -f infra/compose/docker-compose.yml up -d --build`.
5. Create the first account on the dashboard sign-up page. The first tenant's owner holds the secret key.

## Updating

```bash
git pull
docker compose -f infra/compose/docker-compose.yml up -d --build
```

The `migrate` service runs first and applies new migrations. Back up before updating ([self-hosting](./self-hosting.md)).

## Automated deployment

`.github/workflows/deploy.yml` is a manual (`workflow_dispatch`) workflow that connects to a host over SSH and runs the update above. It needs the repository secrets `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` and the variable `DEPLOY_PATH`. It has never been run against a real host.

## Checklist before going live

- [ ] Secrets changed from the development defaults
- [ ] TLS in front, HTTP redirected
- [ ] Databases not exposed to the internet
- [ ] Backups scheduled and a restore tested
- [ ] `/metrics` protected by `METRICS_TOKEN` or not routed publicly
- [ ] Alerts from `infra/prometheus/alerts.yml` delivered somewhere you read
