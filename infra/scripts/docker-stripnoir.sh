#!/usr/bin/env bash
#
# StripNoir — Docker / Compose command reference
# -----------------------------------------------
# Run from repo root:
#   bash infra/scripts/docker-stripnoir.sh help
#   bash infra/scripts/docker-stripnoir.sh stack-up
#
# With sudo (if Docker requires it):
#   sudo bash infra/scripts/docker-stripnoir.sh stack-ps
#
# Default: assumes compose project is run from `infra/` with `docker compose` (v2).
#
# --- Raw commands (same intentions; copy from infra/) -------------------------
#
# Start full stack (api, chat, frontend, db, redis, minio, …)
#   docker compose up -d
#
# Start with public nginx gateway on port 14000 (profile gateway)
#   docker compose --profile gateway up -d --build gateway
#
# Stop stack (keeps named volumes e.g. Postgres data)
#   docker compose down
#
# Stop and delete named volumes (DESTRUCTIVE: wipes DB)
#   docker compose down -v
#
# List services and ports
#   docker compose ps
#
# Follow all logs
#   docker compose logs -f --tail=200
#
# Rebuild one service after Dockerfile change
#   docker compose up -d --build --force-recreate frontend
#
# Open psql on host (needs psql client; uses POSTGRES_PORT from .env, default 15432)
#   PGPASSWORD=app psql -h 127.0.0.1 -p 15432 -U app -d stripnoir
#
# Open psql without host client (inside Postgres container)
#   docker compose exec postgres psql -U app -d stripnoir
#
# Redis CLI inside container
#   docker compose exec redis redis-cli
#
# Run MinIO bucket init again (CORS, public read)
#   docker compose run --rm minio-init
#
# Inspect a container
#   docker inspect stripnoir-api
#
# Disk cleanup (careful)
#   docker system prune -f
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$INFRA_DIR"

# Optional: load host port and DB credentials from infra/.env
if [[ -f .env ]]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi
POSTGRES_USER="${POSTGRES_USER:-app}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-app}"
POSTGRES_DB="${POSTGRES_DB:-stripnoir}"
POSTGRES_PORT="${POSTGRES_PORT:-15432}"
API_PORT="${API_PORT:-13000}"
CHAT_PORT="${CHAT_PORT:-18080}"
GATEWAY_PORT="${GATEWAY_PORT:-14000}"
MINIO_PORT="${MINIO_PORT:-19000}"
MINIO_CONSOLE_PORT="${MINIO_CONSOLE_PORT:-19001}"
REDIS_PORT="${REDIS_PORT:-16379}"

DC="${DC:-docker compose}"

usage() {
  cat <<'EOF'
Commands (intention in parentheses):

  stack-up          Start core stack: api, chat, frontend, postgres, pgbouncer, redis, minio, minio-init
  stack-down        Stop and remove containers for this compose project (keeps volumes)
  stack-ps          List containers and health for this project
  stack-logs        Follow logs for all services (Ctrl+C to stop following)

  rebuild-api       Rebuild/recreate API container after dependency or image changes
  rebuild-frontend  Rebuild/recreate frontend image and container
  rebuild-all       Force recreate core services (no gateway unless profile)

  logs-api          Tail API logs only
  logs-chat         Tail Go chat service logs
  logs-frontend     Tail Next.js frontend logs

  shell-api         Open shell inside API container
  shell-chat        Open shell inside chat container
  shell-postgres    Open shell inside Postgres container (not psql)

  psql              Open psql to stripnoir DB (from host, uses published POSTGRES_PORT)
  psql-exec         Run a single SQL statement: psql-exec "SELECT 1"

  redis-cli         Run redis-cli against Redis on published port (localhost)

  minio-console-url Print browser URL for MinIO console (default port 19001)

  gateway-up        Start nginx gateway + dependencies (profile gateway) — single entry on GATEWAY_PORT
  gateway-down      Stop gateway profile services

  worker-up         Start background worker (profile worker)
  worker-down       Stop worker

  prune-unused      Remove unused Docker images/containers (DESTRUCTIVE — review before running)

  help              Show this help

Environment:
  DC="docker compose"   Use sudo: DC="sudo docker compose"
  Or: sudo bash infra/scripts/docker-stripnoir.sh <command>

EOF
}

case "${1:-help}" in
  stack-up)
    # Intention: bring up the default dev stack defined in docker-compose.yml (no gateway/worker unless added).
    $DC up -d
    ;;
  stack-down)
    # Intention: stop containers for this project; named volumes (pgdata, etc.) are kept unless you add -v.
    $DC down
    ;;
  stack-ps)
    # Intention: see which StripNoir containers are running and their published ports.
    $DC ps -a
    ;;
  stack-logs)
    # Intention: stream combined logs for debugging startup order and cross-service issues.
    $DC logs -f --tail=200
    ;;

  rebuild-api)
    # Intention: recreate API container so new env or image layers apply; code is bind-mounted from services/api.
    $DC up -d --build --force-recreate api
    ;;
  rebuild-frontend)
    # Intention: rebuild frontend image and recreate container (needed after Dockerfile or lockfile changes).
    $DC up -d --build --force-recreate frontend
    ;;
  rebuild-all)
    # Intention: hard refresh of main app services without tearing down DB volumes.
    $DC up -d --build --force-recreate api chat frontend
    ;;

  logs-api)
    # Intention: isolate Node API logs only.
    $DC logs -f --tail=100 api
    ;;
  logs-chat)
    # Intention: isolate Go chat / realtime service logs.
    $DC logs -f --tail=100 chat
    ;;
  logs-frontend)
    # Intention: isolate Next.js dev server logs.
    $DC logs -f --tail=100 frontend
    ;;

  shell-api)
    # Intention: interactive shell for debugging npm/node inside the API container.
    $DC exec -it api sh
    ;;
  shell-chat)
    # Intention: interactive shell inside chat container (Go tooling).
    $DC exec -it chat sh
    ;;
  shell-postgres)
    # Intention: OS shell in Postgres container (e.g. to inspect files); use psql command for SQL.
    $DC exec -it postgres sh
    ;;

  psql)
    # Intention: open interactive psql to the stripnoir database using the host-published port (not PgBouncer).
    PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB"
    ;;
  psql-exec)
    # Intention: run one SQL statement non-interactively (scripting / CI).
    if [[ -z "${2:-}" ]]; then echo "Usage: $0 psql-exec \"SELECT 1\""; exit 1; fi
    PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$2"
    ;;

  redis-cli)
    # Intention: open Redis CLI inside the Redis container (no host redis-cli required).
    $DC exec -it redis redis-cli
    ;;

  minio-console-url)
    # Intention: show where to open MinIO web UI in the browser (console port).
    echo "http://127.0.0.1:${MINIO_CONSOLE_PORT}"
    echo "S3 API (browser uploads): http://127.0.0.1:${MINIO_PORT}"
    ;;

  gateway-up)
    # Intention: start nginx edge + all dependencies — one public port (GATEWAY_PORT) for HTTP/WS routing.
    $DC --profile gateway up -d --build gateway
    ;;
  gateway-down)
    # Intention: stop gateway container; other services may still run.
    $DC --profile gateway stop gateway 2>/dev/null || true
    ;;

  worker-up)
    # Intention: start optional Node worker (notifications queue, etc.) if you use profile worker.
    $DC --profile worker up -d worker
    ;;
  worker-down)
    # Intention: stop worker container.
    $DC --profile worker stop worker 2>/dev/null || true
    ;;

  prune-unused)
    # Intention: free disk space — removes stopped containers and unused images/networks (use with care).
    docker system prune -f
    ;;

  help|-h|--help)
    usage
    ;;

  *)
    echo "Unknown command: $1"
    usage
    exit 1
    ;;
esac
