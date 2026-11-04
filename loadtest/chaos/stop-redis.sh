#!/usr/bin/env bash
# Stops Redis for 20 s during edits. Expect: clients on the same node keep syncing, other nodes converge
# through the 5 s head_seq check, the rate limiter falls back to per-process buckets, and cross-node
# fan-out resumes by itself when Redis returns (watch syncra_gap_recoveries_total in Grafana).
. "$(dirname "$0")/lib.sh"

downtime="${DOWNTIME_S:-20}"
log "stopping redis for ${downtime}s"
"${COMPOSE[@]}" stop redis >/dev/null
sleep "$downtime"
curl -s -o /dev/null -w "readyz while redis is down: HTTP %{http_code} (503 expected)\n" "$BASE_URL/readyz" || true
log "starting redis"
"${COMPOSE[@]}" start redis >/dev/null
wait_ready 60
