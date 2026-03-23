#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:13000}"
CHAT_BASE_URL="${CHAT_BASE_URL:-http://localhost:18080}"

echo "[1/4] API health"
curl -sS "$API_BASE_URL/health" | jq .

echo "[2/4] API dependency health"
curl -sS "$API_BASE_URL/health/deps" | jq .

echo "[3/4] Chat health"
curl -sS "$CHAT_BASE_URL/health" | jq .

echo "[4/4] Chat dependency health"
curl -sS "$CHAT_BASE_URL/health/deps" | jq .

echo "Service health checks completed."
