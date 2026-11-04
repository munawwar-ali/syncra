#!/usr/bin/env bash
# Stops one data shard for 30 s. Expect: documents on that shard answer UNAVAILABLE (503) and clients
# keep editing locally with their outbox growing; documents on the other shard are unaffected; after the
# shard returns the outboxes drain on their own.
. "$(dirname "$0")/lib.sh"

shard="${SHARD:-pg-shard-1}"
downtime="${DOWNTIME_S:-30}"
log "stopping $shard for ${downtime}s"
"${COMPOSE[@]}" stop "$shard" >/dev/null
sleep "$downtime"
log "starting $shard"
"${COMPOSE[@]}" start "$shard" >/dev/null
wait_ready 90
