#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:13000}"
DB_URL="${DB_URL:-postgresql://app:app@localhost:16432/stripnoir}"
PASSWORD="${PASSWORD:-StrongPass123!}"
RUN_ID="${RUN_ID:-$(date +%s)}"
JOIN_CREDITS="${JOIN_CREDITS:-5}"
EXTEND_CREDITS="${EXTEND_CREDITS:-2}"
EXTEND_DURATION_SECONDS="${EXTEND_DURATION_SECONDS:-120}"
MAX_CONCURRENT_VIEWERS="${MAX_CONCURRENT_VIEWERS:-10}"
SKIP_DB_CHECK="${SKIP_DB_CHECK:-0}"
REQUIRE_LIVEKIT="${REQUIRE_LIVEKIT:-0}"

CREATOR_EMAIL="${CREATOR_EMAIL:-live.creator.${RUN_ID}@example.com}"
VIEWER_EMAIL="${VIEWER_EMAIL:-live.viewer.${RUN_ID}@example.com}"
CREATOR_DISPLAY="${CREATOR_DISPLAY:-Live Creator ${RUN_ID}}"
VIEWER_DISPLAY="${VIEWER_DISPLAY:-Live Viewer ${RUN_ID}}"
CREATOR_USERNAME="${CREATOR_USERNAME:-live_creator_${RUN_ID}}"
VIEWER_USERNAME="${VIEWER_USERNAME:-live_viewer_${RUN_ID}}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for this script. Install jq and retry." >&2
  exit 1
fi

if [[ "$SKIP_DB_CHECK" != "1" ]] && ! command -v psql >/dev/null 2>&1; then
  echo "psql is required for DB validation. Install psql or rerun with SKIP_DB_CHECK=1." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

request_json() {
  local method="$1"
  local url="$2"
  local payload="${3:-}"
  local auth_token="${4:-}"
  local body_file="$TMP_DIR/body.json"
  local code_file="$TMP_DIR/code.txt"

  local curl_args=(-sS -X "$method" "$url" -H 'content-type: application/json' -o "$body_file" -w '%{http_code}')
  if [[ -n "$auth_token" ]]; then
    curl_args+=(-H "authorization: Bearer $auth_token")
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
    if [[ -f "$TMP_DIR/body.json" ]]; then
      echo "Response body:" >&2
      cat "$TMP_DIR/body.json" >&2
      echo >&2
    fi
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

run_sql() {
  local sql="$1"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -At -F '|' -c "$sql"
}

echo "[0/13] Health checks"
HEALTH_CODE=$(curl -sS -o "$TMP_DIR/health.json" -w '%{http_code}' "$API_BASE_URL/health")
expect_status "$HEALTH_CODE" "200" "api health"
DEPS_CODE=$(curl -sS -o "$TMP_DIR/deps.json" -w '%{http_code}' "$API_BASE_URL/health/deps")
expect_status "$DEPS_CODE" "200" "dependency health"
echo "API and dependency health are OK."

echo "[1/13] Register creator"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/auth/register" \
  "{\"email\":\"$CREATOR_EMAIL\",\"password\":\"$PASSWORD\",\"displayName\":\"$CREATOR_DISPLAY\",\"username\":\"$CREATOR_USERNAME\"}")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "201" "register creator"
CREATOR_USER_ID=$(echo "$BODY" | jq -r '.user.id')

echo "[2/13] Login creator"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/auth/login" \
  "{\"email\":\"$CREATOR_EMAIL\",\"password\":\"$PASSWORD\"}")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "200" "login creator"
CREATOR_TOKEN=$(echo "$BODY" | jq -r '.token')

echo "[3/13] Apply creator profile and enable live"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/creators/apply" \
  "{\"stageName\":\"Live Creator $RUN_ID\",\"about\":\"live session validator\"}" "$CREATOR_TOKEN")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "201" "creator apply"
CREATOR_ID=$(echo "$BODY" | jq -r '.creator.id')

BODY=$(request_json "PUT" "$API_BASE_URL/api/v1/creators/me" \
  '{"liveEnabled":true}' "$CREATOR_TOKEN")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "200" "enable live for creator"
expect_jq "$BODY" '.creator.liveEnabled == true' "creator liveEnabled should be true"

echo "[4/13] Register viewer"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/auth/register" \
  "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"$PASSWORD\",\"displayName\":\"$VIEWER_DISPLAY\",\"username\":\"$VIEWER_USERNAME\"}")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "201" "register viewer"
VIEWER_USER_ID=$(echo "$BODY" | jq -r '.user.id')

echo "[5/13] Login viewer"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/auth/login" \
  "{\"email\":\"$VIEWER_EMAIL\",\"password\":\"$PASSWORD\"}")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "200" "login viewer"
VIEWER_TOKEN=$(echo "$BODY" | jq -r '.token')

echo "[6/13] Deposit viewer credits"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/payments/deposit" \
  "{\"amountCredits\":50}" "$VIEWER_TOKEN")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "201" "deposit credits"

echo "[7/13] Start live session"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/streams/start" \
  "{\"title\":\"Validator Live $RUN_ID\",\"description\":\"live session smoke validation\",\"baseJoinPriceCredits\":$JOIN_CREDITS,\"extendPriceCredits\":$EXTEND_CREDITS,\"extendDurationSeconds\":$EXTEND_DURATION_SECONDS,\"maxConcurrentViewers\":$MAX_CONCURRENT_VIEWERS}" "$CREATOR_TOKEN")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "201" "start live session"
expect_jq "$BODY" '.stream.status == "live"' "started stream should be live"
STREAM_ID=$(echo "$BODY" | jq -r '.stream.id')
ROOM_ID=$(echo "$BODY" | jq -r '.stream.roomId')
LIVEKIT_ENABLED=$(echo "$BODY" | jq -r 'if .livekit then "1" else "0" end')
if [[ "$REQUIRE_LIVEKIT" == "1" && "$LIVEKIT_ENABLED" != "1" ]]; then
  echo "FAILED: REQUIRE_LIVEKIT=1 but API did not return a livekit payload in stream start response" >&2
  echo "Start response:" >&2
  echo "$BODY" >&2
  exit 1
fi
if [[ "$LIVEKIT_ENABLED" == "1" ]]; then
  expect_jq "$BODY" '.livekit.role == "host" and .livekit.grants.canPublish == true and .livekit.grants.canSubscribe == true' "creator start response should include host LiveKit grants"
fi

echo "[8/13] Validate live list and detail"
BODY=$(request_json "GET" "$API_BASE_URL/api/v1/streams/live")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "200" "list live streams"
expect_jq "$BODY" '.streams | map(.id) | index($stream_id) != null' "live list should include started stream" --arg stream_id "$STREAM_ID"

BODY=$(request_json "GET" "$API_BASE_URL/api/v1/streams/$STREAM_ID")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "200" "get live stream detail"
expect_jq "$BODY" '.stream.id == $stream_id and .stream.status == "live"' "live detail should match started stream" --arg stream_id "$STREAM_ID"

echo "[9/13] Join live session as viewer"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/streams/$STREAM_ID/join" "" "$VIEWER_TOKEN")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "200" "join live session"
expect_jq "$BODY" '.joined == true and .chargedCredits == $join_credits and .viewerAccess.hasJoined == true and .viewerAccess.isActive == true' "viewer join payload should confirm active access and billing" --argjson join_credits "$JOIN_CREDITS"
if [[ "$LIVEKIT_ENABLED" == "1" ]]; then
  expect_jq "$BODY" '.livekit.role == "viewer" and .livekit.grants.canPublish == false and .livekit.grants.canSubscribe == true' "viewer join response should include viewer LiveKit grants"

  BODY=$(request_json "POST" "$API_BASE_URL/api/v1/streams/$STREAM_ID/token" "" "$VIEWER_TOKEN")
  STATUS=$(cat "$TMP_DIR/code.txt")
  expect_status "$STATUS" "200" "issue viewer livekit token"
  expect_jq "$BODY" '.livekit.url != null and .livekit.token != null and .livekit.roomName != null' "viewer token endpoint should include token+room"
  expect_jq "$BODY" '.livekit.role == "viewer" and .viewerAccess.isActive == true' "viewer token endpoint should return active viewer credentials"

  BODY=$(request_json "POST" "$API_BASE_URL/api/v1/streams/$STREAM_ID/token" "" "$CREATOR_TOKEN")
  STATUS=$(cat "$TMP_DIR/code.txt")
  expect_status "$STATUS" "200" "issue creator livekit token"
  expect_jq "$BODY" '.livekit.url != null and .livekit.token != null and .livekit.grants.canPublish == true' "creator token endpoint should return publishable host credentials"
fi

echo "[10/13] Validate stream detail after join"
BODY=$(request_json "GET" "$API_BASE_URL/api/v1/streams/$STREAM_ID")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "200" "get live stream detail after join"
expect_jq "$BODY" '.stream.stats.activeViewers >= 1' "stream should report at least one active viewer after join"

echo "[11/13] End live session"
BODY=$(request_json "POST" "$API_BASE_URL/api/v1/streams/$STREAM_ID/end" "" "$CREATOR_TOKEN")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "200" "end live session"
expect_jq "$BODY" '.stream.status == "ended"' "ended stream should report ended status"

echo "[12/13] Validate ended stream detail"
BODY=$(request_json "GET" "$API_BASE_URL/api/v1/streams/$STREAM_ID")
STATUS=$(cat "$TMP_DIR/code.txt")
expect_status "$STATUS" "200" "get ended stream detail"
expect_jq "$BODY" '.stream.status == "ended"' "stream detail should show ended status"

echo "[13/13] Validate database state"
if [[ "$SKIP_DB_CHECK" == "1" ]]; then
  echo "Skipping DB validation because SKIP_DB_CHECK=1."
else
  STREAM_ROW=$(run_sql "select status || '|' || coalesce(room_id::text, '') || '|' || coalesce(title, '') from live_session where id = '$STREAM_ID';")
  [[ -n "$STREAM_ROW" ]] || { echo "FAILED: live_session row not found" >&2; exit 1; }
  [[ "${STREAM_ROW%%|*}" == "ended" ]] || { echo "FAILED: live_session status should be ended" >&2; exit 1; }

  VIEWER_ROW=$(run_sql "select viewer_user_id::text || '|' || is_active::text || '|' || (left_at is not null)::text from live_session_viewer where live_session_id = '$STREAM_ID' and viewer_user_id = '$VIEWER_USER_ID';")
  [[ -n "$VIEWER_ROW" ]] || { echo "FAILED: live_session_viewer row not found" >&2; exit 1; }
  [[ "$VIEWER_ROW" == "$VIEWER_USER_ID|false|true" ]] || { echo "FAILED: viewer row should be inactive with left_at set" >&2; exit 1; }

  ROOM_ROW=$(run_sql "select room_type::text || '|' || is_active::text from chat_room where id = '$ROOM_ID';")
  [[ -n "$ROOM_ROW" ]] || { echo "FAILED: chat_room row not found" >&2; exit 1; }
  [[ "$ROOM_ROW" == "live_session|false" ]] || { echo "FAILED: chat_room should be live_session and inactive after end" >&2; exit 1; }

  LEDGER_ROW=$(run_sql "select string_agg(entry_type::text || ':' || direction::text || ':' || amount_credits::text, ',' order by direction, entry_type) from credit_ledger where reference_id = '$STREAM_ID';")
  [[ -n "$LEDGER_ROW" ]] || { echo "FAILED: live join ledger rows not found" >&2; exit 1; }
  [[ "$LEDGER_ROW" == *"live_join_credit:credit:${JOIN_CREDITS}"* ]] || { echo "FAILED: missing live_join_credit ledger entry" >&2; exit 1; }
  [[ "$LEDGER_ROW" == *"live_join_debit:debit:${JOIN_CREDITS}"* ]] || { echo "FAILED: missing live_join_debit ledger entry" >&2; exit 1; }
fi

echo "Live session validator passed."
echo "Summary:"
echo "  creatorUserId=$CREATOR_USER_ID"
echo "  creatorId=$CREATOR_ID"
echo "  viewerUserId=$VIEWER_USER_ID"
echo "  streamId=$STREAM_ID"
echo "  roomId=$ROOM_ID"
