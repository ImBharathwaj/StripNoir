# Docker Development Commands (StripNoir)

Run commands from:

```bash
cd /home/bharathwaj/Code/StripNoir/infra
```

## 1. Start / Stop Stack

```bash
# Start in background
docker compose up -d

# Stop and remove containers
docker compose down

# Stop, remove containers + volumes (data reset)
docker compose down -v
```

## 2. Container Status

```bash
# See running services and state
docker compose ps
```

## 3. Logs (Node + Golang)

```bash
# All services logs (follow)
docker compose logs -f

# Node API logs
docker compose logs -f api

# Go chat logs
docker compose logs -f chat

# Last 200 lines
docker compose logs --tail=200 api
docker compose logs --tail=200 chat

# Filter likely errors
docker compose logs api | rg -i "error|exception|fatal|panic"
docker compose logs chat | rg -i "error|fatal|panic"
```

## 4. Enter Containers (Interactive Shell)

Note: current images are Alpine-based, so use `sh`.

```bash
# Node container
docker exec -it stripnoir-api sh

# Go container
docker exec -it stripnoir-chat sh

# Postgres container
docker exec -it stripnoir-postgres sh

# Redis container
docker exec -it stripnoir-redis sh
```

If you need bash inside a container:

```bash
apk add --no-cache bash
bash
```

## 5. Quick Health Checks

```bash
# Check API from host
curl -i http://localhost:13000

# Check Go chat service from host
curl -i http://localhost:18080

# Check Redis ping from inside container
docker exec -it stripnoir-redis redis-cli ping
```

## 6. Restart Specific Services

```bash
# Restart only Node API
docker compose restart api

# Restart only Go chat
docker compose restart chat
```

## 7. Inspect Crash / Exit Details

```bash
docker inspect stripnoir-api --format='{{.State.Status}} {{.State.ExitCode}} {{.State.Error}}'
docker inspect stripnoir-chat --format='{{.State.Status}} {{.State.ExitCode}} {{.State.Error}}'
```
