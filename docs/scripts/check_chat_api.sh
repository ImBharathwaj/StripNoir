#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:13000}"
CHAT_BASE_URL="${CHAT_BASE_URL:-http://localhost:18080}"
PASSWORD="${PASSWORD:-StrongPass123}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for this script. Install jq and retry." >&2
  exit 1
fi

TS="$(date +%s)"
A_EMAIL="${A_EMAIL:-chat.a.${TS}@example.com}"
B_EMAIL="${B_EMAIL:-chat.b.${TS}@example.com}"
A_NAME="${A_NAME:-Chat User A}"
B_NAME="${B_NAME:-Chat User B}"

register_user() {
  local email="$1"
  local name="$2"
  curl -sS -X POST "$API_BASE_URL/api/v1/auth/register" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$PASSWORD\",\"displayName\":\"$name\"}" >/dev/null
}

login_user() {
  local email="$1"
  curl -sS -X POST "$API_BASE_URL/api/v1/auth/login" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$PASSWORD\"}"
}

echo "[1/8] Register users"
register_user "$A_EMAIL" "$A_NAME"
register_user "$B_EMAIL" "$B_NAME"

echo "[2/8] Login users"
A_LOGIN="$(login_user "$A_EMAIL")"
B_LOGIN="$(login_user "$B_EMAIL")"

echo "$A_LOGIN" | jq . >/dev/null
echo "$B_LOGIN" | jq . >/dev/null

A_TOKEN="$(echo "$A_LOGIN" | jq -r '.token')"
B_TOKEN="$(echo "$B_LOGIN" | jq -r '.token')"
B_USER_ID="$(echo "$B_LOGIN" | jq -r '.user.id')"

if [[ -z "$A_TOKEN" || "$A_TOKEN" == "null" || -z "$B_TOKEN" || "$B_TOKEN" == "null" ]]; then
  echo "Failed to get login tokens" >&2
  exit 1
fi

echo "[3/8] Create direct room from A -> B"
ROOM_RESP="$(curl -sS -X POST "$API_BASE_URL/api/v1/chat/rooms" \
  -H "authorization: Bearer $A_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"participantUserId\":\"$B_USER_ID\"}")"

echo "$ROOM_RESP" | jq .
ROOM_ID="$(echo "$ROOM_RESP" | jq -r '.roomId')"
if [[ -z "$ROOM_ID" || "$ROOM_ID" == "null" ]]; then
  echo "Failed to create room" >&2
  exit 1
fi

echo "[4/8] Request chat token for room (Node orchestration)"
WS_TOKEN_RESP="$(curl -sS "$API_BASE_URL/api/v1/chat/ws-token?roomId=$ROOM_ID" \
  -H "authorization: Bearer $A_TOKEN")"
echo "$WS_TOKEN_RESP" | jq .
CHAT_TOKEN="$(echo "$WS_TOKEN_RESP" | jq -r '.token')"
if [[ -z "$CHAT_TOKEN" || "$CHAT_TOKEN" == "null" ]]; then
  echo "Failed to get chat token" >&2
  exit 1
fi

echo "[5/8] Start long-poll event wait in Go"
POLL_OUT="$(mktemp)"
(
  curl -sS "$CHAT_BASE_URL/realtime/rooms/$ROOM_ID/events?token=$CHAT_TOKEN&timeoutSec=15" > "$POLL_OUT"
) &
POLL_PID=$!
sleep 1

echo "[6/8] Send message via Node persistence API"
SEND_RESP="$(curl -sS -X POST "$API_BASE_URL/api/v1/chat/rooms/$ROOM_ID/messages" \
  -H "authorization: Bearer $B_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"body":"hello from user B"}')"

echo "$SEND_RESP" | jq .

wait "$POLL_PID"

echo "[7/8] Validate long-poll event received from Go"
cat "$POLL_OUT" | jq .
EVENT_COUNT="$(cat "$POLL_OUT" | jq '.events | length')"
if [[ "$EVENT_COUNT" -lt 1 ]]; then
  echo "No realtime events received from Go long-poll" >&2
  rm -f "$POLL_OUT"
  exit 1
fi
rm -f "$POLL_OUT"

echo "[8/8] List persisted messages via Node"
LIST_RESP="$(curl -sS "$API_BASE_URL/api/v1/chat/rooms/$ROOM_ID/messages?limit=20" \
  -H "authorization: Bearer $A_TOKEN")"
echo "$LIST_RESP" | jq .

echo "Chat flow check completed successfully."
