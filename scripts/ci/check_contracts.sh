#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

OPENAPI_FILE="$ROOT_DIR/shared-contracts/openapi.yaml"
INTERNAL_CONTRACTS_FILE="$ROOT_DIR/shared-contracts/internal-contracts.md"
VERSIONING_FILE="$ROOT_DIR/shared-contracts/CONTRACT_VERSIONING.md"

for file in "$OPENAPI_FILE" "$INTERNAL_CONTRACTS_FILE" "$VERSIONING_FILE"; do
  if [[ ! -f "$file" ]]; then
    echo "Missing required contract file: $file" >&2
    exit 1
  fi
done

grep -q '^openapi: 3\.1\.0' "$OPENAPI_FILE" || {
  echo "openapi.yaml must declare openapi 3.1.0" >&2
  exit 1
}
grep -q '^info:' "$OPENAPI_FILE" || {
  echo "openapi.yaml missing info section" >&2
  exit 1
}
grep -q '^paths:' "$OPENAPI_FILE" || {
  echo "openapi.yaml missing paths section" >&2
  exit 1
}
grep -q '^components:' "$OPENAPI_FILE" || {
  echo "openapi.yaml missing components section" >&2
  exit 1
}
grep -Eq '^  version: [0-9]+\.[0-9]+\.[0-9]+' "$OPENAPI_FILE" || {
  echo "openapi info.version must follow semver-like x.y.z format" >&2
  exit 1
}

grep -q 'Node -> Go contracts' "$INTERNAL_CONTRACTS_FILE" || {
  echo "internal-contracts.md missing Node -> Go contracts section" >&2
  exit 1
}
grep -q 'Go -> Node/internal hooks' "$INTERNAL_CONTRACTS_FILE" || {
  echo "internal-contracts.md missing Go -> Node/internal hooks section" >&2
  exit 1
}
grep -q 'Public API Versioning' "$VERSIONING_FILE" || {
  echo "CONTRACT_VERSIONING.md missing public versioning policy section" >&2
  exit 1
}

echo "Contract checks passed."
