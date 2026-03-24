#!/usr/bin/env bash
set -euo pipefail

# Phase 4 smoke: concurrent health checks against API + chat (unauthenticated paths;
# not subject to /api/v1 Redis rate limits). Fails if any worker sees non-2xx.
#
# Usage:
#   API_BASE_URL=http://localhost:13000 CHAT_BASE_URL=http://localhost:18080 \
#   CONCURRENCY=50 ITERATIONS=10 ./scripts/load/smoke_realtime_concurrency.sh

API_BASE_URL="${API_BASE_URL:-http://localhost:13000}"
CHAT_BASE_URL="${CHAT_BASE_URL:-http://localhost:18080}"
CONCURRENCY="${CONCURRENCY:-50}"
ITERATIONS="${ITERATIONS:-10}"

worker() {
  local i
  for ((i = 0; i < ITERATIONS; i++)); do
    code_api=$(curl -sS -o /dev/null -w '%{http_code}' "$API_BASE_URL/health") || return 1
    code_chat=$(curl -sS -o /dev/null -w '%{http_code}' "$CHAT_BASE_URL/health") || return 1
    if [[ "$code_api" != "200" || "$code_chat" != "200" ]]; then
      echo "worker fail: api=$code_api chat=$code_chat" >&2
      return 1
    fi
  done
  return 0
}

pids=()
for ((w = 0; w < CONCURRENCY; w++)); do
  worker &
  pids+=($!)
done
fail=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    fail=1
  fi
done
if [[ "$fail" != "0" ]]; then
  echo "smoke_realtime_concurrency FAILED" >&2
  exit 1
fi

echo "smoke_realtime_concurrency OK (${CONCURRENCY} workers x ${ITERATIONS} iters; api+chat /health)"
