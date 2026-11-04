#!/usr/bin/env bash
# Adds 500 ms latency and 10% packet loss between clients and nginx using Toxiproxy, for 60 s.
# Needs the chaos profile: docker compose --profile chaos up -d. Point test clients at :8666.
# Expect: no data loss; the SDK moves through syncing/backoff/live and recovers when the toxics are removed.
. "$(dirname "$0")/lib.sh"

api="${TOXIPROXY_API:-http://localhost:8474}"
duration="${DURATION_S:-60}"

log "creating proxy syncra on :8666 -> nginx:80"
curl -fsS -X POST "$api/proxies" -H 'content-type: application/json' \
  -d '{"name":"syncra","listen":"0.0.0.0:8666","upstream":"nginx:80","enabled":true}' >/dev/null || log "proxy already exists"

log "adding latency 500 ms and 10% loss"
curl -fsS -X POST "$api/proxies/syncra/toxics" -H 'content-type: application/json' \
  -d '{"name":"lag","type":"latency","stream":"downstream","attributes":{"latency":500,"jitter":100}}' >/dev/null
curl -fsS -X POST "$api/proxies/syncra/toxics" -H 'content-type: application/json' \
  -d '{"name":"loss","type":"limit_data","stream":"upstream","toxicity":0.1,"attributes":{"bytes":2048}}' >/dev/null

sleep "$duration"
log "removing toxics"
curl -fsS -X DELETE "$api/proxies/syncra/toxics/lag" >/dev/null
curl -fsS -X DELETE "$api/proxies/syncra/toxics/loss" >/dev/null
log "done; clients should return to live"
