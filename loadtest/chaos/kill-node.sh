#!/usr/bin/env bash
# Kills one sync node with SIGKILL while a load test runs. Expect: clients reconnect to the other nodes
# (typically within 3 s), no acknowledged update is lost, /readyz stays green through nginx.
# Usage: loadtest/chaos/kill-node.sh   (run k6 reconnect-storm.js in another terminal first)
. "$(dirname "$0")/lib.sh"

victim=$(containers server | head -n1)
[ -n "$victim" ] || { log "no running server container found"; exit 1; }
log "SIGKILL $victim"
docker kill --signal=KILL "$victim" >/dev/null
sleep 5
wait_ready 30
log "cluster still serving; remaining server containers: $(containers server | wc -l)"
log "restoring capacity"
"${COMPOSE[@]}" up -d --scale server=3 --no-recreate >/dev/null
wait_ready 60
