# Rudimentary Development Bootstrap

This is the minimum setup added to begin backend development immediately.

## What is scaffolded
- Node API starter: `services/api`
- Go chat starter: `services/chat`
- Portable Docker stack: `infra/docker-compose.yml` (non-default host ports)

## Start the stack
```bash
cd /home/bharathwaj/Code/StripNoir/infra
cp .env.example .env
docker compose up -d
```

## Service URLs (host)
- Node API: `http://localhost:13000`
- Go chat: `http://localhost:18080`
- Postgres: `localhost:15432`
- Redis: `localhost:16379`

## Quick sanity checks
```bash
# Node API health
curl -s http://localhost:13000/health

# Go chat health
curl -s http://localhost:18080/health

# Node auth stub login
curl -s -X POST http://localhost:13000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"dev@example.com"}'

# Node-generated chat ws token
curl -s "http://localhost:13000/api/v1/chat/ws-token?roomId=demo-room"

# Go ws placeholder endpoint
curl -s "http://localhost:18080/ws?token=dev-token"
```

## Starter endpoints implemented

### Node (`services/api/src/app.js`)
- `GET /health`
- `POST /api/v1/auth/register` (stub)
- `POST /api/v1/auth/login` (stub JWT)
- `GET /api/v1/chat/ws-token` (JWT + ws URL)
- `GET /api/v1/streams/live` (stub)

### Go (`services/chat/cmd/main.go`)
- `GET /health`
- `GET /ws?token=...` (placeholder response)
- `POST /internal/chat/publish` (placeholder)

## Next immediate coding tasks
1. Replace Node auth stubs with DB-backed auth and middleware.
2. Replace Go `/ws` placeholder with real WebSocket upgrade + room hub.
3. Wire Go publish path to Redis pub/sub for multi-instance fan-out.
4. Add DB migrations and repository layers in both services.

## Database migration workflow
- Migration file: `infra/migrations/0001_init.sql`
- Runner script: `infra/scripts/db_migrate.sh`
- Make target: `make db-migrate`

Use explicit DB target values to avoid shell-env overrides:

```bash
cd /home/bharathwaj/Code/StripNoir
make db-migrate USE_SUDO=1 DB_CONTAINER=stripnoir-postgres DB_USER=app DB_NAME=stripnoir
```

## Dependency health endpoints
- Node API deps health: `GET /health/deps` (checks Postgres + Redis)
- Go chat deps health: `GET /health/deps` (checks Postgres + Redis)

Quick checks:

```bash
curl -s http://localhost:13000/health/deps
curl -s http://localhost:18080/health/deps
```
