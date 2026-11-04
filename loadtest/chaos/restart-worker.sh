#!/usr/bin/env bash
# Restarts the worker while compaction is running. Expect: the interrupted run is repaired by the next
# pass (jobs are idempotent and compaction verifies before deleting), and
# syncra_compaction_verify_failures_total stays at 0.
. "$(dirname "$0")/lib.sh"

log "restarting worker mid-run"
"${COMPOSE[@]}" restart worker >/dev/null
sleep 20
curl -fsS "http://localhost:9090/api/v1/query?query=sum(syncra_compaction_verify_failures_total)" | head -c 400 || log "prometheus not reachable"
echo
log "check the Grafana 'Compaction savings' panel for continued progress"
