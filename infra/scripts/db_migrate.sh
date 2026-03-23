#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$ROOT_DIR/infra/migrations}"
DB_CONTAINER="${DB_CONTAINER:-stripnoir-postgres}"
DB_USER="${DB_USER:-app}"
DB_NAME="${DB_NAME:-stripnoir}"

if [[ "${USE_SUDO:-0}" == "1" ]]; then
  docker_cmd=(sudo docker)
else
  docker_cmd=(docker)
fi

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo "Migrations directory not found: $MIGRATIONS_DIR" >&2
  exit 1
fi

mapfile -t migrations < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' | sort)

if [[ ${#migrations[@]} -eq 0 ]]; then
  echo "No SQL migration files found in $MIGRATIONS_DIR"
  exit 0
fi

for file in "${migrations[@]}"; do
  echo "Applying migration: $(basename "$file")"
  "${docker_cmd[@]}" exec -i "$DB_CONTAINER" psql \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 \
    -f - < "$file"
done

echo "All migrations applied successfully."
