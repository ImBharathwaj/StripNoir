# Test Scripts

All repeatable manual verification commands should be added here as executable scripts.

## Available scripts
- `check_services_health.sh` : API/chat health and dependency health checks.
- `check_auth_api.sh` : register/login/me/refresh/logout flow checks.
- `check_chat_api.sh` : Node chat persistence + Go realtime long-poll delivery check.
- `check_chat_message_ops.sh` : message edit/delete/read-state API checks.
- `check_phase1_e2e.sh` : end-to-end Phase 1 smoke flow (auth -> creator/follow/subscription -> media/content/feed -> deposit/tip -> notifications).

## Run
```bash
cd /home/bharathwaj/Code/StripNoir
./docs/scripts/check_services_health.sh
./docs/scripts/check_auth_api.sh
./docs/scripts/check_chat_api.sh
./docs/scripts/check_chat_message_ops.sh
./docs/scripts/check_phase1_e2e.sh
```


# From repo root
cd ~/Code/StripNoir/infra

# Load env if you use it (optional)
set -a && [ -f .env ] && . ./.env && set +a

psql "postgresql://${POSTGRES_USER:-app}:${POSTGRES_PASSWORD:-app}@127.0.0.1:${POSTGRES_PORT:-15432}/${POSTGRES_DB:-stripnoir}"

psql "postgresql://app:app@127.0.0.1:15432/stripnoir"

cd ~/Code/StripNoir/infra
sudo docker compose exec postgres psql -U app -d stripnoir

# List tables
\dt

# Quit
\q