# From repo root
bash infra/scripts/docker-stripnoir.sh help

# Examples
bash infra/scripts/docker-stripnoir.sh stack-up
bash infra/scripts/docker-stripnoir.sh stack-ps
bash infra/scripts/docker-stripnoir.sh psql
bash infra/scripts/docker-stripnoir.sh rebuild-frontend
bash infra/scripts/docker-stripnoir.sh gateway-up

sudo docker compose -f infra/docker-compose.yml --profile gateway up -d gateway frontend api
sudo docker compose -f infra/docker-compose.yml restart gateway frontend api

# Restart specific services
sudo docker compose -f infra/docker-compose.yml restart gateway frontend api

export DC="sudo docker compose"
bash infra/scripts/docker-stripnoir.sh stack-up

sudo docker compose --profile gateway up -d --build --force-recreate frontend