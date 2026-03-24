#!/usr/bin/env bash
set -euo pipefail

POSTGRESQL_HOST="${POSTGRESQL_HOST:-postgres}"
POSTGRESQL_PORT="${POSTGRESQL_PORT:-5432}"
POSTGRESQL_USERNAME="${POSTGRESQL_USERNAME:-app}"
POSTGRESQL_PASSWORD="${POSTGRESQL_PASSWORD:-app}"
POSTGRESQL_DATABASE="${POSTGRESQL_DATABASE:-stripnoir}"
PGBOUNCER_DATABASE="${PGBOUNCER_DATABASE:-$POSTGRESQL_DATABASE}"
PGBOUNCER_PORT="${PGBOUNCER_PORT:-6432}"
PGBOUNCER_POOL_MODE="${PGBOUNCER_POOL_MODE:-transaction}"
PGBOUNCER_MAX_CLIENT_CONN="${PGBOUNCER_MAX_CLIENT_CONN:-500}"
PGBOUNCER_DEFAULT_POOL_SIZE="${PGBOUNCER_DEFAULT_POOL_SIZE:-50}"

mkdir -p /etc/pgbouncer

cat > /etc/pgbouncer/pgbouncer.ini <<EOF
[databases]
${PGBOUNCER_DATABASE} = host=${POSTGRESQL_HOST} port=${POSTGRESQL_PORT} dbname=${POSTGRESQL_DATABASE} user=${POSTGRESQL_USERNAME} password=${POSTGRESQL_PASSWORD}

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = ${PGBOUNCER_PORT}
auth_type = plain
auth_file = /etc/pgbouncer/userlist.txt
admin_users = ${POSTGRESQL_USERNAME}
pool_mode = ${PGBOUNCER_POOL_MODE}
max_client_conn = ${PGBOUNCER_MAX_CLIENT_CONN}
default_pool_size = ${PGBOUNCER_DEFAULT_POOL_SIZE}
ignore_startup_parameters = extra_float_digits,options
server_reset_query = DISCARD ALL
log_connections = 1
log_disconnections = 1
EOF

cat > /etc/pgbouncer/userlist.txt <<EOF
"${POSTGRESQL_USERNAME}" "${POSTGRESQL_PASSWORD}"
EOF

exec su-exec nobody pgbouncer /etc/pgbouncer/pgbouncer.ini
