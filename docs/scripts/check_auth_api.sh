#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://localhost:13000}"
EMAIL="${EMAIL:-demo.$(date +%s)@example.com}"
PASSWORD="${PASSWORD:-StrongPass123}"
DISPLAY_NAME="${DISPLAY_NAME:-Demo User}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for this script. Install jq and retry." >&2
  exit 1
fi

echo "[1/6] Register user: $EMAIL"
REGISTER_RESP=$(curl -sS -X POST "$API_BASE_URL/api/v1/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"displayName\":\"$DISPLAY_NAME\"}")

echo "$REGISTER_RESP" | jq .

echo "[2/6] Login"
LOGIN_RESP=$(curl -sS -X POST "$API_BASE_URL/api/v1/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")

echo "$LOGIN_RESP" | jq .
ACCESS_TOKEN=$(echo "$LOGIN_RESP" | jq -r '.token')
REFRESH_TOKEN=$(echo "$LOGIN_RESP" | jq -r '.refreshToken')

if [[ -z "$ACCESS_TOKEN" || "$ACCESS_TOKEN" == "null" ]]; then
  echo "Login did not return access token" >&2
  exit 1
fi

if [[ -z "$REFRESH_TOKEN" || "$REFRESH_TOKEN" == "null" ]]; then
  echo "Login did not return refresh token" >&2
  exit 1
fi

echo "[3/6] Get current user (/auth/me)"
ME_RESP=$(curl -sS "$API_BASE_URL/api/v1/auth/me" \
  -H "authorization: Bearer $ACCESS_TOKEN")
echo "$ME_RESP" | jq .

echo "[4/6] Refresh token"
REFRESH_RESP=$(curl -sS -X POST "$API_BASE_URL/api/v1/auth/refresh" \
  -H 'content-type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}")

echo "$REFRESH_RESP" | jq .
NEW_ACCESS_TOKEN=$(echo "$REFRESH_RESP" | jq -r '.token')
NEW_REFRESH_TOKEN=$(echo "$REFRESH_RESP" | jq -r '.refreshToken')

if [[ -z "$NEW_ACCESS_TOKEN" || "$NEW_ACCESS_TOKEN" == "null" ]]; then
  echo "Refresh did not return new access token" >&2
  exit 1
fi

if [[ -z "$NEW_REFRESH_TOKEN" || "$NEW_REFRESH_TOKEN" == "null" ]]; then
  echo "Refresh did not return new refresh token" >&2
  exit 1
fi

echo "[5/6] Get current user with refreshed access token"
ME_REFRESHED_RESP=$(curl -sS "$API_BASE_URL/api/v1/auth/me" \
  -H "authorization: Bearer $NEW_ACCESS_TOKEN")
echo "$ME_REFRESHED_RESP" | jq .

echo "[6/6] Logout with refreshed token"
LOGOUT_RESP=$(curl -sS -X POST "$API_BASE_URL/api/v1/auth/logout" \
  -H 'content-type: application/json' \
  -d "{\"refreshToken\":\"$NEW_REFRESH_TOKEN\"}")
echo "$LOGOUT_RESP" | jq .

echo "Auth flow check completed successfully."
