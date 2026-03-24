SHELL := /bin/bash

DB_CONTAINER ?= stripnoir-postgres
DB_USER ?= app
DB_NAME ?= stripnoir
USE_SUDO ?= 0

.PHONY: db-migrate db-tables check-contracts check-schema check-phase0

db-migrate:
	DB_CONTAINER=$(DB_CONTAINER) DB_USER=$(DB_USER) DB_NAME=$(DB_NAME) USE_SUDO=$(USE_SUDO) ./infra/scripts/db_migrate.sh

db-tables:
	@if [ "$(USE_SUDO)" = "1" ]; then \
		sudo docker exec -it $(DB_CONTAINER) psql -U $(DB_USER) -d $(DB_NAME) -c "\\dt public.*"; \
	else \
		docker exec -it $(DB_CONTAINER) psql -U $(DB_USER) -d $(DB_NAME) -c "\\dt public.*"; \
	fi

check-contracts:
	bash ./scripts/ci/check_contracts.sh

check-schema:
	bash ./scripts/ci/check_schema_migrations.sh

check-phase0: check-contracts check-schema
