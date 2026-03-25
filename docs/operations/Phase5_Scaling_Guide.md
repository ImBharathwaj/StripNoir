# Phase 5 operations: scaling, gateway, queues, observability

This guide ties repository scaffolding to production-style hardening. **Very high concurrency** (including 50k-class VUs) is proven in a dedicated load environment using the k6 scenario in `scripts/load/k6_phase5_gateway.js` and §8 below — not in CI.

## 1. API gateway (nginx)

- **Config:** `infra/nginx/gateway.conf` + `infra/nginx/Dockerfile`
- **Compose:** `gateway` service (profile `gateway`), host port `GATEWAY_PORT` (default **14000**)
- **Run:** `cd infra && docker compose --profile gateway up -d gateway` (with api + chat already up)

Routes:

- `/api/*`, `/health`, `/metrics` → Node API
- `/ws`, `/realtime/*` → Go chat (WebSocket upgrade + long-poll)
- `/internal/*` → **403** at the edge (Node still calls `http://chat:8080/internal/*` on the Docker network)

**Throttling / backpressure at edge:** `limit_req` on `/api/`, `limit_conn` per IP, `client_max_body_size`, upstream `keepalive`, extended read timeouts for long-poll.

**Canary:** Commented second upstream in `gateway.conf`; split traffic in the mesh (Istio/Linkerd) or duplicate Deployment + weighted Service.

## 2. Browser vs internal chat URLs

- **Internal (server-to-server):** `CHAT_SERVICE_URL=http://chat:8080` (Compose default)
- **Client WebSocket/long-poll:** set **`CHAT_PUBLIC_URL`** on the API to the **browser-reachable** origin (e.g. `http://localhost:14000` when using the gateway, or your public `https://` host).  
  Implemented in `services/api/src/app.js` (`chatPublicUrl` for `wsUrl` / `longPollUrl` only).

## 3. Postgres read replicas + PgBouncer

- **Primary** pool unchanged: database name from `PGBOUNCER_DATABASE`.
- **Optional replica alias:** set `PGBOUNCER_REPLICA_HOST` (and optionally `PGBOUNCER_REPLICA_ALIAS`, default `{db}_ro`) in `infra/pgbouncer/entrypoint.sh` environment. Point read-only app connections at the `*_ro` DB name in PgBouncer.
- **App:** introduce a read-only `DATABASE_READ_URL` in Node when you split queries (not wired automatically).

Tuning already exposed via compose: `PGBOUNCER_POOL_MODE`, `PGBOUNCER_MAX_CLIENT_CONN`, `PGBOUNCER_DEFAULT_POOL_SIZE`.

## 4. Redis cluster and key conventions

Single-node Redis is used in Compose. For cluster mode later, keep **hash tags** stable so pub/sub and rate-limit keys land predictably:

| Pattern | Purpose |
|---------|---------|
| `room:{roomId}` | Chat fan-out channel |
| `user_notify:{userId}` | Notification stream |
| `presence:ws:{roomId}` | WS presence set |
| `rl:*` | API rate limit counters |

## 5. Queue workers

- **Scaffold:** `services/worker` — Redis `BLPOP` on `stripnoir:queue:notifications` (configurable).
- **Compose:** `worker` service (profile **`worker`**): `docker compose --profile worker up -d worker`
- **Production:** migrate to **BullMQ** (or Kafka) for retries, DLQ, and reconciliation jobs; keep the same queue names or use an outbox table in Postgres.

## 6. OpenTelemetry

- **Collector:** `infra/otel/collector-config.yaml`, Compose service `otel-collector` (profile **`observability`**), OTLP gRPC **14317** / HTTP **14318** on the host.
- **Apps:** enable Node/Go OTLP exporters when you add SDKs; point to `http://otel-collector:4318` inside Compose.
- **SLO dashboards:** wire exporter in `collector-config.yaml` to Grafana Cloud / Prometheus / Jaeger (commented stub in file).

## 7. Kubernetes autoscaling groups

Sample **separate** Deployments + Services + HPA for API and chat under `infra/k8s/`. Worker Deployment included as a third scaling group. See `infra/k8s/README.md`.

## 8. Benchmark and backpressure checklist

| Check | Tool / signal |
|-------|----------------|
| Edge saturation | nginx `limit_req` 429s, upstream 502/504 |
| API pool | Postgres/PgBouncer wait events; `stripnoir_api_*` metrics |
| Chat | `stripnoir_chat_*` metrics; Redis `connected_clients` |
| Queue depth | Redis `LLEN stripnoir:queue:notifications` (after LPUSH) |
| High-concurrency path (incl. 50k-class) | k6: `scripts/load/k6_phase5_gateway.js` against `GATEWAY_BASE_URL`; tune `TARGET_VUS`, `HOLD_DURATION`, `RAMP_DURATION`. Distribute k6 for very large VU counts; add WS soak separately if needed |

### 8.1 Staging run (gateway)

1. Bring up stack with `docker compose --profile gateway up -d` (API + chat + gateway).
2. Install k6; from repo root:

   ```bash
   GATEWAY_BASE_URL=http://localhost:14000 TARGET_VUS=500 HOLD_DURATION=5m \
     k6 run scripts/load/k6_phase5_gateway.js
   ```

3. Pass criteria: thresholds in the script (adjust for your SLO), no sustained 502/504, PgBouncer wait time acceptable, Redis `connected_clients` within capacity.
4. For **~50k concurrent** HTTP-style load, scale out k6 runners and cluster replicas per `infra/k8s/`; record run id, cluster size, and outcome in your release notes.

## 9. Gateway smoke script

`scripts/verify_gateway_routing.sh` — expects gateway on `GATEWAY_BASE_URL` (default `http://localhost:14000`).
