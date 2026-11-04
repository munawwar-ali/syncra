#!/usr/bin/env bash
# Runs one bench scenario several times, tagging each result file, with a pause between runs so the
# machine and the embedded databases settle. Usage: loadtest/node/repeat.sh <runs> <scenario> [bench args...]
set -euo pipefail
runs="$1"; shift
cd "$(dirname "$0")/.."
for i in $(seq 1 "$runs"); do
  echo "=== run $i of $runs: $* ==="
  BENCH_TAG="run$i" npx tsx node/bench.ts "$@"
  sleep 15
done
