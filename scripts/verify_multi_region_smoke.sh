#!/usr/bin/env bash
set -euo pipefail

# Phase 7: optional multi-edge health smoke after DNS or failover drills.
# All set URLs must return HTTP 200 on GET /health (API) or /chat/health (chat via gateway).
#
# Examples:
#   GATEWAY_A=http://region-a.edge:80 GATEWAY_B=http://region-b.edge:80 ./scripts/verify_multi_region_smoke.sh
#   SINGLE_GATEWAY=http://localhost:14000 ./scripts/verify_multi_region_smoke.sh

check_url() {
  local name="$1" url="$2"
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$url") || return 1
  if [[ "$code" != "200" ]]; then
    echo "FAIL $name -> $url (HTTP $code)" >&2
    return 1
  fi
  echo "OK   $name -> $url"
}

fail=0

if [[ -n "${SINGLE_GATEWAY:-}" ]]; then
  check_url "gateway(api)" "${SINGLE_GATEWAY}/health" || fail=1
  check_url "gateway(chat)" "${SINGLE_GATEWAY}/chat/health" || fail=1
fi
if [[ -n "${GATEWAY_A:-}" ]]; then
  check_url "gateway_a(api)" "${GATEWAY_A}/health" || fail=1
  check_url "gateway_a(chat)" "${GATEWAY_A}/chat/health" || fail=1
fi
if [[ -n "${GATEWAY_B:-}" ]]; then
  check_url "gateway_b(api)" "${GATEWAY_B}/health" || fail=1
  check_url "gateway_b(chat)" "${GATEWAY_B}/chat/health" || fail=1
fi

if [[ -z "${SINGLE_GATEWAY:-}" && -z "${GATEWAY_A:-}" && -z "${GATEWAY_B:-}" ]]; then
  echo "Set SINGLE_GATEWAY and/or GATEWAY_A and GATEWAY_B (see script header)." >&2
  exit 2
fi

[[ "$fail" -eq 0 ]]
