#!/usr/bin/env bash
# Shared helpers for chaos scripts. Run them from the repository root with the stack already up:
#   docker compose -f infra/compose/docker-compose.yml up -d --scale server=3
# These scripts have NOT been executed in the development environment (no Docker daemon there).
set -euo pipefail

COMPOSE=(docker compose -f infra/compose/docker-compose.yml)
BASE_URL="${SYNCRA_URL:-http://localhost:8080}"

log() { printf '[chaos %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# Waits until $BASE_URL/readyz answers 200 (or fails after $1 seconds, default 60).
wait_ready() {
  local limit="${1:-60}" i
  for ((i = 0; i < limit; i++)); do
    if curl -fsS "$BASE_URL/readyz" >/dev/null 2>&1; then log "ready after ${i}s"; return 0; fi
    sleep 1
  done
  log "NOT ready after ${limit}s"
  return 1
}

# Names of the running containers of a compose service, one per line.
containers() { "${COMPOSE[@]}" ps -q "$1"; }

# Number of operation rows for a document across both shards: lets a run compare acked vs stored.
op_rows() {
  local doc="$1" total=0 n shard
  for shard in pg-shard-0 pg-shard-1; do
    n=$("${COMPOSE[@]}" exec -T "$shard" psql -U syncra -d "syncra_${shard//-/_}" -Atc \
      "select coalesce(sum(array_length(op_refs,1)),0) from operations o join documents d on d.uid=o.doc_uid where d.doc_id='$doc'")
    total=$((total + n))
  done
  echo "$total"
}
