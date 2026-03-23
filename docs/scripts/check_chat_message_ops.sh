#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:13000}"
PASSWORD="${PASSWORD:-StrongPass123}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for this script. Install jq and retry." >&2
  exit 1
fi

TS="$(date +%s)"
A_EMAIL="${A_EMAIL:-ops.a.${TS}@example.com}"
B_EMAIL="${B_EMAIL:-ops.b.${TS}@example.com}"

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

echo "[1/7] Register + login users"
register_user "$A_EMAIL" "Ops User A"
register_user "$B_EMAIL" "Ops User B"
A_LOGIN="$(login_user "$A_EMAIL")"
B_LOGIN="$(login_user "$B_EMAIL")"
A_TOKEN="$(echo "$A_LOGIN" | jq -r '.token')"
B_TOKEN="$(echo "$B_LOGIN" | jq -r '.token')"
B_USER_ID="$(echo "$B_LOGIN" | jq -r '.user.id')"

echo "[2/7] Create room"
ROOM_RESP="$(curl -sS -X POST "$API_BASE_URL/api/v1/chat/rooms" \
  -H "authorization: Bearer $A_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"participantUserId\":\"$B_USER_ID\"}")"
ROOM_ID="$(echo "$ROOM_RESP" | jq -r '.roomId')"

echo "[3/7] Send message"
MSG_RESP="$(curl -sS -X POST "$API_BASE_URL/api/v1/chat/rooms/$ROOM_ID/messages" \
  -H "authorization: Bearer $A_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"body":"original text"}')"
echo "$MSG_RESP" | jq .
MSG_ID="$(echo "$MSG_RESP" | jq -r '.message.id')"

echo "[4/7] Edit message"
EDIT_RESP="$(curl -sS -X PATCH "$API_BASE_URL/api/v1/chat/rooms/$ROOM_ID/messages/$MSG_ID" \
  -H "authorization: Bearer $A_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"body":"edited text"}')"
echo "$EDIT_RESP" | jq .

echo "[5/7] Mark room as read"
READ_RESP="$(curl -sS -X POST "$API_BASE_URL/api/v1/chat/rooms/$ROOM_ID/read" \
  -H "authorization: Bearer $B_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"lastReadMessageId\":\"$MSG_ID\"}")"
echo "$READ_RESP" | jq .

echo "[6/7] Delete message"
DEL_RESP="$(curl -sS -X DELETE "$API_BASE_URL/api/v1/chat/rooms/$ROOM_ID/messages/$MSG_ID" \
  -H "authorization: Bearer $A_TOKEN")"
echo "$DEL_RESP" | jq .

echo "[7/7] Verify final message state"
LIST_RESP="$(curl -sS "$API_BASE_URL/api/v1/chat/rooms/$ROOM_ID/messages?limit=20" \
  -H "authorization: Bearer $B_TOKEN")"
echo "$LIST_RESP" | jq .
STATUS="$(echo "$LIST_RESP" | jq -r '.messages[-1].status')"
if [[ "$STATUS" != "deleted" ]]; then
  echo "Expected last message status=deleted but got $STATUS" >&2
  exit 1
fi

echo "Chat message operations check completed successfully."
