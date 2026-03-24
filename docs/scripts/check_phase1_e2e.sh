#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:13000}"
PASSWORD="${PASSWORD:-StrongPass123!}"
RUN_ID="${RUN_ID:-$(date +%s)}"

USER1_EMAIL="${USER1_EMAIL:-phase1.user1.${RUN_ID}@example.com}"
USER2_EMAIL="${USER2_EMAIL:-phase1.user2.${RUN_ID}@example.com}"
USER1_DISPLAY="${USER1_DISPLAY:-Phase1 User One}"
USER2_DISPLAY="${USER2_DISPLAY:-Phase1 User Two}"
TIP_CREDITS="${TIP_CREDITS:-7}"

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
  local auth_header="${4:-}"
  local body_file="$TMP_DIR/body.json"
  local code_file="$TMP_DIR/code.txt"

  local curl_args=(-sS -X "$method" "$url" -H 'content-type: application/json' -o "$body_file" -w '%{http_code}')
  if [[ -n "$auth_header" ]]; then
    curl_args+=(-H "authorization: Bearer $auth_header")
  fi
  if [[ -n "$payload" ]]; then
    curl_args+=(-d "$payload")
  fi

  local status
  status=$(curl "${curl_args[@]}")
  printf '%s' "$status" >"$code_file"

  cat "$body_file"
}

expect_status() {
  local got="$1"
  local want="$2"
  local step="$3"
  if [[ "$got" != "$want" ]]; then
    echo "FAILED: $step (expected HTTP $want, got $got)" >&2
    exit 1
  fi
}

echo "[0/12] Health check"
HEALTH_CODE=$(curl -sS -o "$TMP_DIR/health.json" -w '%{http_code}' "$API_BASE_URL/health")
expect_status "$HEALTH_CODE" "200" "health check"
jq . "$TMP_DIR/health.json"

echo "[1/12] Register user #1"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/auth/register" \
  "{\"email\":\"$USER1_EMAIL\",\"password\":\"$PASSWORD\",\"displayName\":\"$USER1_DISPLAY\",\"username\":\"u1_$RUN_ID\"}")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "201" "register user #1"
USER1_ID=$(echo "$BODY" | jq -r '.user.id')
echo "$BODY" | jq .

echo "[2/12] Login user #1"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/auth/login" \
  "{\"email\":\"$USER1_EMAIL\",\"password\":\"$PASSWORD\"}")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "200" "login user #1"
USER1_TOKEN=$(echo "$BODY" | jq -r '.token')
echo "$BODY" | jq '{user, token: (if .token then "present" else "missing" end)}'

echo "[3/12] Apply user #1 as creator"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/creators/apply" \
  "{\"stageName\":\"Creator $RUN_ID\",\"about\":\"phase1 smoke\"}" "$USER1_TOKEN")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "201" "creator apply user #1"
CREATOR_ID=$(echo "$BODY" | jq -r '.creator.id')
echo "$BODY" | jq .

echo "[4/12] Register + login user #2"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/auth/register" \
  "{\"email\":\"$USER2_EMAIL\",\"password\":\"$PASSWORD\",\"displayName\":\"$USER2_DISPLAY\",\"username\":\"u2_$RUN_ID\"}")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "201" "register user #2"
USER2_ID=$(echo "$BODY" | jq -r '.user.id')

BODY=$(request_json "POST" "$API_BASE_URL/api/v1/auth/login" \
  "{\"email\":\"$USER2_EMAIL\",\"password\":\"$PASSWORD\"}")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "200" "login user #2"
USER2_TOKEN=$(echo "$BODY" | jq -r '.token')
echo "$BODY" | jq '{user, token: (if .token then "present" else "missing" end)}'

echo "[5/12] User #2 follows user #1"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/users/$USER1_ID/follow" "{}" "$USER2_TOKEN")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "201" "follow creator user #1"
echo "$BODY" | jq .

echo "[6/12] User #2 subscribes to creator"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/creators/subscription" \
  "{\"creatorId\":\"$CREATOR_ID\"}" "$USER2_TOKEN")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "201" "subscription create"
echo "$BODY" | jq .

echo "[7/12] User #1 creates media asset"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/media/upload-url" "{}" "$USER1_TOKEN")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "200" "media upload url"
OBJECT_KEY=$(echo "$BODY" | jq -r '.objectKey')

BODY=$(request_json "POST" "$API_BASE_URL/api/v1/media/complete" \
  "{\"mediaType\":\"image\",\"objectKey\":\"$OBJECT_KEY\",\"mimeType\":\"image/jpeg\"}" "$USER1_TOKEN")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "201" "media complete"
MEDIA_ID=$(echo "$BODY" | jq -r '.media.id')
echo "$BODY" | jq .

echo "[8/12] User #1 creates content"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/content" \
  "{\"title\":\"Phase1 smoke post\",\"caption\":\"hello\",\"visibility\":\"followers\",\"status\":\"published\",\"mediaAssetIds\":[\"$MEDIA_ID\"]}" "$USER1_TOKEN")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "201" "content create"
CONTENT_ID=$(echo "$BODY" | jq -r '.content.id')
echo "$BODY" | jq .

echo "[9/12] User #2 reads feed"
BODY=$(request_json "GET" "$API_BASE_URL/api/v1/feed" "" "$USER2_TOKEN")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "200" "feed get"
echo "$BODY" | jq .

echo "[10/12] User #2 deposits credits"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/payments/deposit" \
  "{\"amountCredits\":100}" "$USER2_TOKEN")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "201" "deposit credits"
echo "$BODY" | jq .

echo "[11/12] User #2 tips user #1"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/payments/tip" \
  "{\"creatorUserId\":\"$USER1_ID\",\"amountCredits\":$TIP_CREDITS}" "$USER2_TOKEN")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "201" "tip creator"
echo "$BODY" | jq .

echo "[12/12] User #1 checks notifications"
BODY=$(request_json "GET" "$API_BASE_URL/api/v1/notifications" "" "$USER1_TOKEN")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "200" "notifications list"
echo "$BODY" | jq .

echo "Phase 1 E2E smoke test passed."
echo "Summary:"
echo "  user1Id=$USER1_ID"
echo "  user2Id=$USER2_ID"
echo "  creatorId=$CREATOR_ID"
echo "  mediaId=$MEDIA_ID"
echo "  contentId=$CONTENT_ID"
