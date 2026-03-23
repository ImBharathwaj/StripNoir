# Test Scripts

All repeatable manual verification commands should be added here as executable scripts.

## Available scripts
- `check_services_health.sh` : API/chat health and dependency health checks.
- `check_auth_api.sh` : register/login/me/refresh/logout flow checks.
- `check_chat_api.sh` : Node chat persistence + Go realtime long-poll delivery check.
- `check_chat_message_ops.sh` : message edit/delete/read-state API checks.

## Run
```bash
cd /home/bharathwaj/Code/StripNoir
./docs/scripts/check_services_health.sh
./docs/scripts/check_auth_api.sh
./docs/scripts/check_chat_api.sh
./docs/scripts/check_chat_message_ops.sh
```
