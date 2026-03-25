#!/usr/bin/env bash
set -euo pipefail

# End-to-end API validation: video call request -> accept -> join (both sides) -> extend -> end.
#
# Usage:
#   API_BASE_URL=http://localhost:13000 ./scripts/check_video_call_flow.sh

API_BASE_URL="${API_BASE_URL:-http://localhost:13000}"
PASSWORD="${PASSWORD:-VideoCallFlow123!}"
RUN_ID="${RUN_ID:-$(date +%s)}"
CREATOR_EMAIL="${CREATOR_EMAIL:-call.creator.${RUN_ID}@example.com}"
FAN_EMAIL="${FAN_EMAIL:-call.fan.${RUN_ID}@example.com}"
CREATOR_USERNAME="${CREATOR_USERNAME:-call_creator_${RUN_ID}}"
FAN_USERNAME="${FAN_USERNAME:-call_fan_${RUN_ID}}"
CREDITS_PER_BLOCK="${CREDITS_PER_BLOCK:-2}"
BLOCK_SECONDS="${BLOCK_SECONDS:-60}"
REQUIRE_LIVEKIT="${REQUIRE_LIVEKIT:-0}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for this script. Install jq and retry." >&2
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

expect_jq() {
  local json="$1"
  local expr="$2"
  local step="$3"
  shift 3
  if ! echo "$json" | jq -e "$@" "$expr" >/dev/null; then
    echo "FAILED: $step" >&2
    echo "$json" | jq . >&2
    exit 1
  fi
}

echo "[0/10] Health"
code=$(curl -sS -o "$TMP_DIR/h.json" -w '%{http_code}' "$API_BASE_URL/health")
expect_status "$code" "200" "api health"

echo "[1/10] Register creator and fan"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/auth/register" \
  "{\"email\":\"$CREATOR_EMAIL\",\"password\":\"$PASSWORD\",\"displayName\":\"Call Creator $RUN_ID\",\"username\":\"$CREATOR_USERNAME\"}")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "register creator"

BODY=$(request_json "POST" "$API_BASE_URL/api/v1/auth/register" \
  "{\"email\":\"$FAN_EMAIL\",\"password\":\"$PASSWORD\",\"displayName\":\"Call Fan $RUN_ID\",\"username\":\"$FAN_USERNAME\"}")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "register fan"

echo "[2/10] Login"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/auth/login" "{\"email\":\"$CREATOR_EMAIL\",\"password\":\"$PASSWORD\"}")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "login creator"
CREATOR_TOKEN=$(echo "$BODY" | jq -r '.token')

BODY=$(request_json "POST" "$API_BASE_URL/api/v1/auth/login" "{\"email\":\"$FAN_EMAIL\",\"password\":\"$PASSWORD\"}")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "login fan"
FAN_TOKEN=$(echo "$BODY" | jq -r '.token')

echo "[3/10] Creator profile + enable video calls"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/creators/apply" \
  "{\"stageName\":\"Call Creator $RUN_ID\",\"about\":\"video call validator\"}" "$CREATOR_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "creator apply"
CREATOR_PROFILE_ID=$(echo "$BODY" | jq -r '.creator.id')

BODY=$(request_json "PUT" "$API_BASE_URL/api/v1/creators/me" '{"videoCallEnabled":true}' "$CREATOR_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "enable video calls"
expect_jq "$BODY" '.creator.videoCallEnabled == true' "videoCallEnabled should be true"

echo "[4/10] Fan credits"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/payments/deposit" "{\"amountCredits\":50}" "$FAN_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "deposit credits"

echo "[5/10] Create call request"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/calls/create" \
  "{\"creatorId\":\"$CREATOR_PROFILE_ID\",\"expiresInSeconds\":600}" "$FAN_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "create call request"
REQUEST_ID=$(echo "$BODY" | jq -r '.request.id')

echo "[6/10] Creator accepts"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/calls/$REQUEST_ID/accept" \
  "{\"creditsPerBlock\":$CREDITS_PER_BLOCK,\"blockDurationSeconds\":$BLOCK_SECONDS}" "$CREATOR_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "accept call"
CALL_ID=$(echo "$BODY" | jq -r '.call.id')
expect_jq "$BODY" '.call.status == "accepted" or .call.status == "active"' "call should be accepted or active after accept"

echo "[7/10] Join (fan charged, creator not)"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/calls/$CALL_ID/join" "{}" "$FAN_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "fan join"
expect_jq "$BODY" --argjson c "$CREDITS_PER_BLOCK" '.chargedCredits == $c' "fan should pay first block"

FAN_LIVEKIT_ENABLED=$(echo "$BODY" | jq -r 'if .livekit then "1" else "0" end')
if [[ "$REQUIRE_LIVEKIT" == "1" && "$FAN_LIVEKIT_ENABLED" != "1" ]]; then
  echo "FAILED: REQUIRE_LIVEKIT=1 but fan join did not return a livekit payload" >&2
  echo "Join response:" >&2
  echo "$BODY" >&2
  exit 1
fi
if [[ "$FAN_LIVEKIT_ENABLED" == "1" ]]; then
  expect_jq "$BODY" '.livekit.role == "client" and .livekit.grants.canPublish == true and .livekit.grants.canSubscribe == true' "fan join should include client LiveKit grants"
  expect_jq "$BODY" '.livekit.url != null and .livekit.token != null' "fan join should include LiveKit url+token"
fi

BODY=$(request_json "POST" "$API_BASE_URL/api/v1/calls/$CALL_ID/join" "{}" "$CREATOR_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "creator join"
expect_jq "$BODY" '.chargedCredits == 0' "creator join should not debit"

CREATOR_LIVEKIT_ENABLED=$(echo "$BODY" | jq -r 'if .livekit then "1" else "0" end')
if [[ "$REQUIRE_LIVEKIT" == "1" && "$CREATOR_LIVEKIT_ENABLED" != "1" ]]; then
  echo "FAILED: REQUIRE_LIVEKIT=1 but creator join did not return a livekit payload" >&2
  echo "Join response:" >&2
  echo "$BODY" >&2
  exit 1
fi
if [[ "$CREATOR_LIVEKIT_ENABLED" == "1" ]]; then
  expect_jq "$BODY" '.livekit.role == "creator" and .livekit.grants.canPublish == true and .livekit.grants.canSubscribe == true' "creator join should include creator LiveKit grants"
  expect_jq "$BODY" '.livekit.url != null and .livekit.token != null' "creator join should include LiveKit url+token"
fi

if [[ "$FAN_LIVEKIT_ENABLED" == "1" ]]; then
  echo "[7.1/10] Validate LiveKit token issuance for both sides"

  BODY=$(request_json "POST" "$API_BASE_URL/api/v1/calls/$CALL_ID/token" "" "$FAN_TOKEN")
  STATUS=$(cat "$TMP_DIR/code.txt")
  expect_status "$STATUS" "200" "issue fan LiveKit call token"
  expect_jq "$BODY" '.livekit.role == "client" and .livekit.url != null and .livekit.token != null and .livekit.grants.canSubscribe == true' "fan token should include room+token+subscribe grant"

  BODY=$(request_json "POST" "$API_BASE_URL/api/v1/calls/$CALL_ID/token" "" "$CREATOR_TOKEN")
  STATUS=$(cat "$TMP_DIR/code.txt")
  expect_status "$STATUS" "200" "issue creator LiveKit call token"
  expect_jq "$BODY" '.livekit.role == "creator" and .livekit.url != null and .livekit.token != null and .livekit.grants.canSubscribe == true' "creator token should include room+token+subscribe grant"
fi

echo "[8/10] Extend (fan)"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/calls/$CALL_ID/extend" "{}" "$FAN_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "extend call"
expect_jq "$BODY" --argjson c "$CREDITS_PER_BLOCK" '.transfer.amountCredits == $c' "extend should bill one block"

echo "[9/10] End call (creator)"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/calls/$CALL_ID/end" "{}" "$CREATOR_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "end call"
expect_jq "$BODY" '.call.status == "ended"' "call should be ended"

echo "[10/10] Video call flow validator passed."
echo "Summary: requestId=$REQUEST_ID callId=$CALL_ID"
