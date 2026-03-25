#!/usr/bin/env bash
set -euo pipefail

# Product completeness (repo-level): backend end-to-end API smoke coverage.
#
# This does NOT ship a web/mobile UI, but provides a runnable integration test that
# exercises the major end-user and creator flows described in the feature report:
# auth, creator apply, discovery feed, subscriptions, content access (subscribers + PPV unlock),
# direct chat (including block enforcement), and video-call lifecycle.
#
# Usage:
#   API_BASE_URL=http://localhost:13000 ./scripts/verify_product_e2e_smoke.sh

API_BASE_URL="${API_BASE_URL:-http://localhost:13000}"
PASSWORD="${PASSWORD:-ProductE2eSmoke123!}"
RUN_ID="${RUN_ID:-$(date +%s)}"

CREATOR_STAGE_NAME="${CREATOR_STAGE_NAME:-ProductSmokeCreator $RUN_ID}"
CREATOR_EMAIL="${CREATOR_EMAIL:-product.creator.${RUN_ID}@example.com}"
CREATOR_USERNAME="${CREATOR_USERNAME:-product_creator_${RUN_ID}}"

VIEWER1_EMAIL="${VIEWER1_EMAIL:-product.viewer1.${RUN_ID}@example.com}"
VIEWER1_USERNAME="${VIEWER1_USERNAME:-product_viewer1_${RUN_ID}}"

VIEWER2_EMAIL="${VIEWER2_EMAIL:-product.viewer2.${RUN_ID}@example.com}"
VIEWER2_USERNAME="${VIEWER2_USERNAME:-product_viewer2_${RUN_ID}}"

DEPOSIT_CREDITS="${DEPOSIT_CREDITS:-50}"
PPV_PRICE_CREDITS="${PPV_PRICE_CREDITS:-5}"

CHAT_MESSAGE_BODY="hello from smoke test ${RUN_ID}"

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

echo "[0/16] Health/deps"
code=$(curl -sS -o "$TMP_DIR/h.json" -w '%{http_code}' "$API_BASE_URL/health/deps")
expect_status "$code" "200" "deps health"

echo "[1/16] Register creator"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/auth/register" \
  "{\"email\":\"$CREATOR_EMAIL\",\"password\":\"$PASSWORD\",\"displayName\":\"Product Creator $RUN_ID\",\"username\":\"$CREATOR_USERNAME\"}")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "register creator"
CREATOR_USER_ID=$(echo "$BODY" | jq -r '.user.id')

echo "[2/16] Login creator"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/auth/login" \
  "{\"email\":\"$CREATOR_EMAIL\",\"password\":\"$PASSWORD\"}")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "login creator"
CREATOR_TOKEN=$(echo "$BODY" | jq -r '.token')

echo "[3/16] Apply creator + enable live/video"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/creators/apply" \
  "{\"stageName\":\"$CREATOR_STAGE_NAME\",\"about\":\"smoke test creator\"}" "$CREATOR_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "creator apply"
CREATOR_PROFILE_ID=$(echo "$BODY" | jq -r '.creator.id')

BODY=$(request_json "PUT" "$API_BASE_URL/api/v1/creators/me" '{"liveEnabled":true,"videoCallEnabled":true}' "$CREATOR_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "enable creator live + video"

echo "[4/16] Register viewer1"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/auth/register" \
  "{\"email\":\"$VIEWER1_EMAIL\",\"password\":\"$PASSWORD\",\"displayName\":\"Viewer1 $RUN_ID\",\"username\":\"$VIEWER1_USERNAME\"}")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "register viewer1"

echo "[5/16] Login viewer1"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/auth/login" \
  "{\"email\":\"$VIEWER1_EMAIL\",\"password\":\"$PASSWORD\"}")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "login viewer1"
VIEWER1_TOKEN=$(echo "$BODY" | jq -r '.token')
VIEWER1_USER_ID=$(echo "$BODY" | jq -r '.user.id')

echo "[6/16] Register viewer2"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/auth/register" \
  "{\"email\":\"$VIEWER2_EMAIL\",\"password\":\"$PASSWORD\",\"displayName\":\"Viewer2 $RUN_ID\",\"username\":\"$VIEWER2_USERNAME\"}")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "register viewer2"

echo "[7/16] Login viewer2"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/auth/login" \
  "{\"email\":\"$VIEWER2_EMAIL\",\"password\":\"$PASSWORD\"}")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "login viewer2"
VIEWER2_TOKEN=$(echo "$BODY" | jq -r '.token')

echo "[8/16] Deposit credits"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/payments/deposit" "{\"amountCredits\":$DEPOSIT_CREDITS}" "$VIEWER1_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "deposit viewer1"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/payments/deposit" "{\"amountCredits\":$DEPOSIT_CREDITS}" "$VIEWER2_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "deposit viewer2"

echo "[9/16] Subscription: viewer1 subscribes to creator"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/payments/subscribe" \
  "{\"creatorId\":\"$CREATOR_PROFILE_ID\",\"amountCredits\":1}" "$VIEWER1_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "subscribe viewer1 to creator"

echo "[10/16] Content: subscribers-only + PPV unlock"

echo "  [10.1] Create subscribers-only content"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/content" \
  "{\"title\":\"subscribers only\",\"caption\":\"smoke\",\"visibility\":\"subscribers\",\"status\":\"published\"}" "$CREATOR_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "create subscribers-only content"
SUB_CONTENT_ID=$(echo "$BODY" | jq -r '.content.id')

echo "  [10.2] viewer2 cannot read subscribers-only"
request_json "GET" "$API_BASE_URL/api/v1/content/$SUB_CONTENT_ID" "" "$VIEWER2_TOKEN" >/dev/null
expect_status "$(cat "$TMP_DIR/code.txt")" "403" "viewer2 should not access subscribers content"

echo "  [10.3] viewer1 can read subscribers-only"
BODY=$(request_json "GET" "$API_BASE_URL/api/v1/content/$SUB_CONTENT_ID" "" "$VIEWER1_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "viewer1 should access subscribers content"

echo "  [10.4] Create PPV (exclusive_ppv + requiresPayment)"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/content" \
  "{\"title\":\"ppv\",\"caption\":\"smoke\",\"visibility\":\"exclusive_ppv\",\"status\":\"published\",\"requiresPayment\":true,\"unlockPriceCredits\":$PPV_PRICE_CREDITS}" "$CREATOR_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "create ppv content"
PPV_CONTENT_ID=$(echo "$BODY" | jq -r '.content.id')

echo "  [10.5] viewer2 cannot read PPV before unlock"
request_json "GET" "$API_BASE_URL/api/v1/content/$PPV_CONTENT_ID" "" "$VIEWER2_TOKEN" >/dev/null
expect_status "$(cat "$TMP_DIR/code.txt")" "403" "viewer2 should not access ppv before unlock"

echo "  [10.6] viewer2 unlocks PPV and can read"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/content/$PPV_CONTENT_ID/unlock" "{}" "$VIEWER2_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "unlock ppv"
BODY=$(request_json "GET" "$API_BASE_URL/api/v1/content/$PPV_CONTENT_ID" "" "$VIEWER2_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "viewer2 should access ppv after unlock"

echo "[11/16] Discovery feed: list creators"
BODY=$(request_json "GET" "$API_BASE_URL/api/v1/feed/creators?limit=5" "" "$VIEWER1_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "feed creators"
echo "$BODY" | jq -e '.creators | type=="array"' >/dev/null

echo "[12/16] Chat: create DM + send + report"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/chat/rooms" \
  "{\"participantUserId\":\"$CREATOR_USER_ID\"}" "$VIEWER1_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "create dm room"
ROOM_ID=$(echo "$BODY" | jq -r '.roomId')

BODY=$(request_json "POST" "$API_BASE_URL/api/v1/chat/rooms/$ROOM_ID/messages" \
  "{\"body\":\"$CHAT_MESSAGE_BODY\"}" "$VIEWER1_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "send chat message"
MESSAGE_ID=$(echo "$BODY" | jq -r '.message.id')

BODY=$(request_json "GET" "$API_BASE_URL/api/v1/chat/rooms/$ROOM_ID/messages?limit=5" "" "$VIEWER1_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "read chat messages"

BODY=$(request_json "POST" "$API_BASE_URL/api/v1/chat/rooms/$ROOM_ID/messages/$MESSAGE_ID/report" \
  "{\"reasonCode\":\"spam\",\"reasonText\":\"smoke test\"}" "$VIEWER1_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "report message"

echo "[13/16] Chat safety: block prevents further direct messaging"
request_json "POST" "$API_BASE_URL/api/v1/users/$CREATOR_USER_ID/block" \
  "{}" "$VIEWER1_TOKEN" >/dev/null
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "block creator"

request_json "POST" "$API_BASE_URL/api/v1/chat/rooms" \
  "{\"participantUserId\":\"$CREATOR_USER_ID\"}" "$VIEWER1_TOKEN" >/dev/null
expect_status "$(cat "$TMP_DIR/code.txt")" "403" "cannot create dm when blocked"

request_json "POST" "$API_BASE_URL/api/v1/chat/rooms/$ROOM_ID/messages" \
  "{\"body\":\"should fail\"}" "$VIEWER1_TOKEN" >/dev/null
expect_status "$(cat "$TMP_DIR/code.txt")" "403" "cannot send message when blocked"

echo "[14/16] Video call: request -> accept -> join -> extend -> end"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/calls/create" \
  "{\"creatorId\":\"$CREATOR_PROFILE_ID\",\"expiresInSeconds\":600}" "$VIEWER1_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "create call request"
REQUEST_ID=$(echo "$BODY" | jq -r '.request.id')

BODY=$(request_json "POST" "$API_BASE_URL/api/v1/calls/$REQUEST_ID/accept" \
  "{\"creditsPerBlock\":1,\"blockDurationSeconds\":60}" "$CREATOR_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "201" "accept call"
CALL_ID=$(echo "$BODY" | jq -r '.call.id')

BODY=$(request_json "POST" "$API_BASE_URL/api/v1/calls/$CALL_ID/join" "{}" "$VIEWER1_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "viewer join call"

BODY=$(request_json "POST" "$API_BASE_URL/api/v1/calls/$CALL_ID/join" "{}" "$CREATOR_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "creator join call"

BODY=$(request_json "POST" "$API_BASE_URL/api/v1/calls/$CALL_ID/extend" "{}" "$VIEWER1_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "extend call"

BODY=$(request_json "POST" "$API_BASE_URL/api/v1/calls/$CALL_ID/end" "{}" "$CREATOR_TOKEN")
expect_status "$(cat "$TMP_DIR/code.txt")" "200" "end call"

echo "[15/16] Done"
echo "Product e2e smoke passed."

