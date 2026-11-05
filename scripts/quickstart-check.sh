#!/usr/bin/env bash
# DX-02 / A6-1: fresh-clone quickstart check. Brings the compose stack up, waits until it is ready, and
# verifies what the README promises: dashboard, both demo apps, a demo token that opens a WebSocket
# handshake, and the printed credentials. Prints the elapsed time so the quickstart duration is on record.
# Needs Docker. NOT run by the author yet (no Docker daemon on the development machine); CI runs it.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${BASE:-http://localhost:8080}"
COMPOSE=(docker compose -f infra/compose/docker-compose.yml)
start=$(date +%s)

rm -rf .syncra
"${COMPOSE[@]}" up -d --build

echo "waiting for $BASE/readyz"
for i in $(seq 1 180); do
  if curl -fsS "$BASE/readyz" >/dev/null 2>&1; then break; fi
  if [ "$i" = 180 ]; then echo "stack not ready after 180 s"; "${COMPOSE[@]}" logs --tail=80; exit 1; fi
  sleep 1
done

check() { # url, expected substring
  local body
  body=$(curl -fsS "$1") || { echo "FAIL: $1 unreachable"; exit 1; }
  grep -qi "$2" <<<"$body" || { echo "FAIL: $1 does not contain '$2'"; exit 1; }
  echo "ok: $1"
}
check "$BASE/" "<title>"
check "$BASE/notes/" "Syncra Notes"
check "$BASE/inspection/" "Syncra Field Inspection"

grep -q "Secret key:" .syncra/.syncra-demo-credentials.txt || { echo "FAIL: credentials not written"; exit 1; }
echo "ok: credentials printed"

token=$(curl -fsS -X POST "$BASE/demo/token" -H 'content-type: application/json' -d '{"name":"ci","role":"notes"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$token" ] || { echo "FAIL: demo token"; exit 1; }
echo "ok: demo token minted"

# A valid token must be upgraded to a WebSocket (101); a bad one must be refused.
code=$(curl -s -o /dev/null -w '%{http_code}' --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "$BASE/v1/connect?clientId=ci-check&token=$token&v=1" --max-time 5 || true)
[ "$code" = 101 ] || { echo "FAIL: websocket handshake returned $code"; exit 1; }
echo "ok: websocket handshake"

echo "quickstart verified in $(( $(date +%s) - start )) s"
