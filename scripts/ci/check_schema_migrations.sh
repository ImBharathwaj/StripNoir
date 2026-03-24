#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCHEMA_FILE="$ROOT_DIR/infra/sql/stripnoir_schema.sql"
MIGRATIONS_DIR="$ROOT_DIR/infra/migrations"

if [[ ! -f "$SCHEMA_FILE" ]]; then
  echo "Schema file missing: $SCHEMA_FILE" >&2
  exit 1
fi

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo "Migrations directory missing: $MIGRATIONS_DIR" >&2
  exit 1
fi

mapfile -t migrations < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' | sort)
if [[ ${#migrations[@]} -eq 0 ]]; then
  echo "No migration files found in $MIGRATIONS_DIR" >&2
  exit 1
fi

prev_basename=""
for file in "${migrations[@]}"; do
  basename_file="$(basename "$file")"
  if [[ -n "$prev_basename" && "$basename_file" < "$prev_basename" ]]; then
    echo "Migrations are not lexicographically ordered: $basename_file after $prev_basename" >&2
    exit 1
  fi
  prev_basename="$basename_file"

  grep -q '^BEGIN;' "$file" || {
    echo "Migration missing BEGIN; at top: $basename_file" >&2
    exit 1
  }
  grep -q '^COMMIT;' "$file" || {
    echo "Migration missing COMMIT;: $basename_file" >&2
    exit 1
  }
done

echo "Schema and migration checks passed."
