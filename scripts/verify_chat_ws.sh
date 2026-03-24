#!/usr/bin/env bash
set -euo pipefail

# Verifies chat + notification realtime plumbing: HTTP token issuance and (optional)
# Redis delivery when redis-cli is available. Does not open a live WebSocket client.
#
# Usage (local compose defaults on host ports):
#   API_BASE_URL=http://localhost:13000 CHAT_BASE_URL=http://localhost:18080 \
#   REDIS_URL=redis://127.0.0.1:16379 ./scripts/verify_chat_ws.sh

API_BASE_URL="${API_BASE_URL:-http://localhost:13000}"
CHAT_BASE_URL="${CHAT_BASE_URL:-http://localhost:18080}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:16379}"
CHAT_INTERNAL_API_KEY="${CHAT_INTERNAL_API_KEY:-}"
PASSWORD="${PASSWORD:-VerifyWsSmoke123!}"
RUN_ID="${RUN_ID:-$(date +%s)}"

U1_EMAIL="ws.u1.${RUN_ID}@example.com"
U2_EMAIL="ws.u2.${RUN_ID}@example.com"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required. Install jq and retry." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

request_json() {
  local method="$1"
  local url="$2"
  local payload="${3:-}"
  local auth_token="${4:-}"
  local code_file="$TMP_DIR/code.txt"

  local curl_args=(-sS -X "$method" "$url" -H 'content-type: application/json' -o "$TMP_DIR/body.json" -w '%{http_code}')
  if [[ -n "$auth_token" ]]; then
    curl_args+=(-H "authorization: Bearer $auth_token")
  fi
  if [[ -n "$payload" ]]; then
    curl_args+=(-d "$payload")
  fi

  local status
  status=$(curl "${curl_args[@]}")
  printf '%s' "$status" >"$code_file"
  cat "$TMP_DIR/body.json"
}

expect_status() {
  local got="$1"
  local want="$2"
  local step="$3"
  if [[ "$got" != "$want" ]]; then
    echo "FAILED: $step (expected HTTP $want, got $got)" >&2
    cat "$TMP_DIR/body.json" >&2 || true
    exit 1
  fi
}

curl_internal_json() {
  local url="$1"
  local json="$2"
  local hdr=(-H 'content-type: application/json')
  if [[ -n "$CHAT_INTERNAL_API_KEY" ]]; then
    hdr+=(-H "x-internal-key: ${CHAT_INTERNAL_API_KEY}")
  fi
  curl -sS -o "$TMP_DIR/int_body.json" -w '%{http_code}' -X POST "$url" "${hdr[@]}" -d "$json"
}

echo "[0/8] Health checks"
code=$(curl -sS -o "$TMP_DIR/h.json" -w '%{http_code}' "$API_BASE_URL/health")
expect_status "$code" "200" "api health"
code=$(curl -sS -o "$TMP_DIR/c.json" -w '%{http_code}' "$CHAT_BASE_URL/health")
expect_status "$code" "200" "chat health"

echo "[1/8] Register two users"
R1=$(request_json "POST" "$API_BASE_URL/api/v1/auth/register" \
  "{\"email\":\"$U1_EMAIL\",\"password\":\"$PASSWORD\",\"displayName\":\"U1 $RUN_ID\",\"username\":\"u1_$RUN_ID\"}")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "register u1"
USER1_ID=$(echo "$R1" | jq -r '.user.id')

R2=$(request_json "POST" "$API_BASE_URL/api/v1/auth/register" \
  "{\"email\":\"$U2_EMAIL\",\"password\":\"$PASSWORD\",\"displayName\":\"U2 $RUN_ID\",\"username\":\"u2_$RUN_ID\"}")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "register u2"
USER2_ID=$(echo "$R2" | jq -r '.user.id')

echo "[2/8] Login"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/auth/login" "{\"email\":\"$U1_EMAIL\",\"password\":\"$PASSWORD\"}")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "login u1"
TOKEN1=$(echo "$BODY" | jq -r '.token')

echo "[3/8] Create DM room (user1 invites user2)"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/chat/rooms" "{\"participantUserId\":\"$USER2_ID\"}" "$TOKEN1")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "create dm room"
ROOM_ID=$(echo "$BODY" | jq -r '.room.id')

echo "[4/8] Chat ws-token"
BODY=$(request_json "GET" "$API_BASE_URL/api/v1/chat/ws-token?roomId=$ROOM_ID" "" "$TOKEN1")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "chat ws-token"
echo "$BODY" | jq -e '.token and .wsUrl and .longPollUrl' >/dev/null

echo "[5/8] Notification ws-token"
BODY=$(request_json "GET" "$API_BASE_URL/api/v1/notifications/ws-token" "" "$TOKEN1")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "notify ws-token"
echo "$BODY" | jq -e '.token and .wsUrl and .longPollUrl' >/dev/null

if ! command -v redis-cli >/dev/null 2>&1; then
  echo "[6-7/8] Skipping Redis pub/sub checks (redis-cli not installed)."
  echo "[8/8] Done (HTTP-only verification)."
  echo "Realtime verification passed (tokens OK). Install redis-cli to validate Redis fan-out."
  exit 0
fi

echo "[6/8] Redis: room channel fan-out (internal chat publish)"
(
  redis-cli -u "$REDIS_URL" SUBSCRIBE "room:${ROOM_ID}" >"$TMP_DIR/room_sub.log" 2>&1
) &
SUB_PID=$!
sleep 0.6
code=$(curl_internal_json "$CHAT_BASE_URL/internal/chat/publish" \
  "{\"roomId\":\"${ROOM_ID}\",\"eventType\":\"verify.smoke.chat\",\"payload\":{\"runId\":${RUN_ID}}}")
expect_status "$code" "202" "internal chat publish"
sleep 1.2
kill "$SUB_PID" 2>/dev/null || true
wait "$SUB_PID" 2>/dev/null || true
grep -q "verify.smoke.chat" "$TMP_DIR/room_sub.log" || {
  echo "FAILED: did not observe verify.smoke.chat on room:${ROOM_ID}" >&2
  head -50 "$TMP_DIR/room_sub.log" >&2 || true
  exit 1
}

echo "[7/8] Redis: user_notify channel fan-out (internal notify publish)"
(
  redis-cli -u "$REDIS_URL" SUBSCRIBE "user_notify:${USER1_ID}" >"$TMP_DIR/notify_sub.log" 2>&1
) &
SUBN_PID=$!
sleep 0.6
code=$(curl_internal_json "$CHAT_BASE_URL/internal/notify/publish" \
  "{\"userId\":\"${USER1_ID}\",\"eventType\":\"verify.smoke.notify\",\"payload\":{\"runId\":${RUN_ID}}}")
expect_status "$code" "202" "internal notify publish"
sleep 1.2
kill "$SUBN_PID" 2>/dev/null || true
wait "$SUBN_PID" 2>/dev/null || true
grep -q "verify.smoke.notify" "$TMP_DIR/notify_sub.log" || {
  echo "FAILED: did not observe verify.smoke.notify on user_notify:${USER1_ID}" >&2
  head -50 "$TMP_DIR/notify_sub.log" >&2 || true
  exit 1
}

echo "[8/8] Chat + notification realtime stack verification passed."
