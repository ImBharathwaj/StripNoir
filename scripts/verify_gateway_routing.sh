#!/usr/bin/env bash
set -euo pipefail

# Smoke-test nginx gateway (compose profile gateway). Expects /internal/* -> 403, /api -> Node, /chat/health -> chat.
#
#   cd infra && docker compose --profile gateway up -d
#   GATEWAY_BASE_URL=http://localhost:14000 ./scripts/verify_gateway_routing.sh

GATEWAY_BASE_URL="${GATEWAY_BASE_URL:-http://localhost:14000}"

http_code() {
  curl -sS -o /dev/null -w '%{http_code}' "$@" || echo "000"
}

echo "Checking gateway at $GATEWAY_BASE_URL"
h1=$(http_code "$GATEWAY_BASE_URL/health")
[[ "$h1" == "200" ]] || { echo "FAIL: GET /health expected 200 got $h1" >&2; exit 1; }

h2=$(http_code -X POST "$GATEWAY_BASE_URL/internal/chat/publish" \
  -H 'content-type: application/json' -d '{}')
[[ "$h2" == "403" ]] || { echo "FAIL: POST /internal/chat/publish expected 403 got $h2" >&2; exit 1; }

h3=$(http_code "$GATEWAY_BASE_URL/chat/health")
[[ "$h3" == "200" ]] || { echo "FAIL: GET /chat/health expected 200 got $h3" >&2; exit 1; }

echo "gateway routing OK (health, internal blocked, chat health)"
