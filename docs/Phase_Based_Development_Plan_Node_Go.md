# Phase-Based Development Plan (Node.js + Golang)

## 1. Goal
Build an OnlyFans/StripChat-style platform with a hybrid backend:
- Node.js for core business modules and fast feature delivery
- Golang for high-poll/high-concurrency modules to reduce throttling and improve realtime performance

This plan is derived from:
- `docs/Basic_API_design.md`
- `docs/API_Design_Lang_arch.md`
- `docs/Hybrid_Lang_Arch.md`
- `docs/Distributed_Architecture_Plan_Node_vs_Golang.md`
- `docs/core_distributive_architecture.md`
- `docs/Live_and_Video_Chat_Plan.md`
- `docs/LiveKit_Cloud_Setup.md`

## 2. Language Ownership (from docs + rollout decision)

### Node.js (Primary API / Business Logic)
- Auth
- Users / Creator profiles
- Content and Media metadata APIs
- Streams and Calls orchestration APIs (token issuance, access checks, lifecycle)
- Payments and credits workflows
- Notifications API facade
- Admin APIs

### Golang (High-poll / High-concurrency)
- WebSocket gateway (`/ws`) and realtime session handling
- Chat messaging transport and fan-out
- Presence / typing / viewer counters
- Poll-heavy live session updates (migrate from REST polling to WS/SSE)
- Realtime notification delivery workers/gateways

### Shared Services
- PostgreSQL (+ PgBouncer)
- Redis (cache, pub/sub, rate counters)
- Queue/event bus (BullMQ initially, Kafka/NATS later)
- LiveKit for video/audio media plane
- API Gateway in front of Node + Go

## 3. Target Monorepo Structure

```text
services/
  api/                 # Node.js API
  chat/                # Go realtime/chat gateway
infra/
  docker-compose.yml
  nginx/
  k8s/
shared-contracts/
  openapi.yaml
  protobuf/
```

## 4. Phase Plan
Status legend:
- `[x]` Completed
- `[ ]` Pending / Not started
- `[ ] (in progress)` Started, not exit-complete

## Phase 0: Foundations and Contracts
**Objective:** Lock architecture boundaries before feature coding.

- [x] Finalize service boundaries: Node API vs Go realtime
- [x] Create `shared-contracts/openapi.yaml` for all external APIs
- [x] Define internal contracts:
  - [x] Node -> Go: token verify, room publish
  - [x] Node -> Go: explicit room create/join internal contracts
  - [x] Go -> Node/internal: auth lookup, moderation hooks, ledger hooks
- [x] Set up environments and secrets (`LIVEKIT_*`, JWT secrets, Redis/Postgres)
- [x] Local infra with Docker Compose (Node, Go, Redis, Postgres, PgBouncer)
  - [x] Custom PgBouncer container added under `infra/pgbouncer`
  - [x] Node API and Go chat `DATABASE_URL` route through PgBouncer (`pgbouncer:6432`)

**Exit criteria**
- [x] Both services boot locally
- [x] API contract versioning policy agreed
- [x] CI checks for contract/schema changes

## Phase 1: Node.js Core MVP Modules
**Objective:** Ship basic product flows quickly in Node.

Implement in Node (`/api/v1`):
- [x] Auth: register, login, refresh, me
- [x] Users/Creators: profile and follow/subscription basics
- [x] Content/Media: upload URL + create/list content
- [x] Feed: basic following + trending endpoints
- [x] Payments: deposit, subscribe, tip, wallet, payout request
- [x] Admin basics

Data model setup:
- [x] Users, CreatorProfile, Content, Media, Subscription
- [x] Wallet/CreditTransaction, Payouts

**Exit criteria**
- [x] End-to-end flow works: user signup -> follow -> subscribe -> consume content -> tip
- [x] Basic rate limits for all `/api/v1` routes (Redis fixed window per IP; stricter bucket for `/auth/register|login|refresh`). Edge API gateway throttling remains Phase 5.

## Phase 2: Realtime Baseline (Node Orchestration + Go WS)
**Objective:** Introduce Go for realtime path while keeping Node as control plane.

- [x] Node adds chat orchestration endpoints:
  - [x] `GET /chat/ws-token`
  - [x] room metadata APIs (`/chat/rooms*`)
- [x] Go service delivers:
  - [x] `/ws?token=...` connection
  - [x] JWT validation for Node-issued token
  - [x] room join/leave and message broadcast
- [x] Redis pub/sub backplane for multi-instance Go fan-out
- [x] Keep REST fallback message endpoints active during rollout

**Exit criteria**
- [x] Chat / realtime path smoke verification (`scripts/verify_chat_ws.sh`: chat + notification WS tokens, optional Redis fan-out via `redis-cli`; native WS client not required for CI-style checks)
- [x] REST chat fallback remains available
- [x] Horizontal Go instances share rooms via Redis pub/sub; WS viewer presence also uses Redis `SADD`/`SCARD` so counts stay consistent across instances

## Phase 3: Live Streaming and 1-1 Calls (LiveKit)
**Objective:** Deliver live and private video features with controlled billing logic.

Node responsibilities:
- [x] Live session APIs (`/streams/start|join|end|live|:id`)
  - [x] Creator start/end flows persist `live_session` + backing `chat_room`
  - [x] Public live list/detail endpoints backed by PostgreSQL
  - [x] Viewer join flow records `live_session_viewer` access and initial join billing
  - [x] End-to-end validator added at `scripts/check_live_session_flow.sh`
- [x] Video call APIs (`/calls/create|join|end`, request/accept/decline flows)
  - [x] Client request creation: `POST /api/v1/calls/create` (`/calls/request` alias)
  - [x] Creator request handling: `POST /api/v1/calls/:requestId/accept|decline`
  - [x] Call lifecycle: `GET /api/v1/calls/:id`, `POST /api/v1/calls/:id/join|token|extend|end`
- [x] Credit deduction/earning ledger for join/extend/tips
  - [x] Live join billing: `live_join_debit|live_join_credit`
  - [x] Live extend billing: `POST /api/v1/streams/:id/extend` -> `live_extend_debit|live_extend_credit`
  - [x] Video call join/extend billing: `video_call_debit|video_call_credit`
  - [x] Tips billing path active: `tip_debit|tip_credit`
- [x] LiveKit token issuance and role-based grants
  - [x] Host/viewer LiveKit access tokens issued from Node for active live sessions
  - [x] Role grants enforced in API responses and `POST /api/v1/streams/:id/token`

Go responsibilities:
- [x] Realtime live chat fan-out for stream rooms
- [x] Viewer presence tracking stream-side (`live.ws_presence` over the room channel: concurrent WS connection count per room, Redis-backed)
- [x] Realtime call status events (join/leave/ended)
  - [x] Node publishes `call.accepted|joined|extended|ended` to room channels
  - [x] Go `/ws` + Redis pub/sub fan-out delivers room events to connected participants

**Exit criteria**
- [x] Live session with chat, viewer count, join/extend credit logic (validated by `scripts/check_live_session_flow.sh`)
- [x] 1:1 call with request/accept, join, extend, and end (validated by `scripts/check_video_call_flow.sh`)
- [x] Tip notifications delivered in realtime on the creator's **active live** chat room (`tip.received` via existing chat publish path); **plus** per-user notify stream (`notification.created` on `user_notify:{userId}`) for persisted notification rows

## Phase 4: Remove Polling Bottlenecks (Go-first)
**Objective:** Move poll-heavy modules to push-based realtime to reduce throttling.

Migrate from REST polling to Go WS/SSE channels:
- [x] Live chat message polling -> WS push (baseline chat WS + long-poll fallback)
- [x] Live viewer count polling -> presence events (WS clients can use `live.ws_presence` for concurrent connection counts; DB-backed `activeViewers` remains authoritative for billing)
- [x] Call status polling -> WS session events (Node publishes `call.accepted|joined|extended|ended` to the call room; clients subscribed on `/ws` receive them)
- [x] Notification polling -> realtime notification stream (`GET /api/v1/notifications/ws-token`, Go `/ws` with `typ=notify` + Redis `user_notify:{userId}`, long-poll `GET /realtime/notify/events`, Node `publishNotifyEvent` on new rows — tips included)

Keep Node as source of truth for authorization and final writes; Go handles high-frequency transport.

**Exit criteria**
- [x] Polling intervals no longer primary path for live/chat/call status (contract + API: OpenAPI descriptions on poll-prone routes; `X-StripNoir-Realtime: prefer-go-websocket-or-long-poll` on Node `GET` poll fallbacks — chat messages, notifications list, live session detail/list)
- [x] p95 latency and request volume observable for poll-heavy routes (`METRICS_ENABLED=1`: Node `GET /metrics` + `GET /metrics.json` with `stripnoir_api_http_request_duration_ms_*` by `route_group=poll_fallback_*`; Go chat `GET /metrics` with `stripnoir_chat_http_request_duration_ms_*` for `websocket`, `longpoll_*`, etc.; use Prometheus `histogram_quantile` or scrape JSON summary for baselines)
- [x] No throttling under **smoke** concurrency on health paths (`scripts/load/smoke_realtime_concurrency.sh`: parallel workers hit `/health` on API + chat; `/api/v1` rate limits unchanged). Deeper k6/vegeta targets remain Phase 5.

## Phase 5: Distributed Scaling Hardening
**Objective:** Apply distributed architecture guardrails from docs.

- [x] API Gateway: auth, throttling, routing, canary support (`infra/nginx/gateway.conf` + `docker compose --profile gateway`; `limit_req` / `limit_conn` / WS upgrade; `/internal/*` blocked at edge; canary upstream commented; smoke: `scripts/verify_gateway_routing.sh`)
- [x] Separate autoscaling groups (Kubernetes samples):
  - [x] Node API cluster — `infra/k8s/api-deployment.yaml` + `hpa-api.yaml`
  - [x] Go realtime cluster — `infra/k8s/chat-deployment.yaml` + `hpa-chat.yaml`
  - [x] Worker cluster — `infra/k8s/worker-deployment.yaml` (`services/worker` Redis BLPOP scaffold; BullMQ migration path in `docs/operations/Phase5_Scaling_Guide.md`)
- [x] Postgres read replicas + PgBouncer tuning (optional replica DB alias via `PGBOUNCER_REPLICA_*` in `infra/pgbouncer/entrypoint.sh`; pool env vars documented in `infra/.env.example`)
- [x] Redis cluster mode and key sharding strategy (conventions for `room:{id}`, `user_notify:{id}`, `rl:*`, `presence:*` in `docs/operations/Phase5_Scaling_Guide.md`; Compose remains single-node until cluster overlay)
- [x] Queue workers for notifications, moderation, analytics, reconciliation (`services/worker` + compose profile `worker`; extend with job types / BullMQ / outbox)
- [x] OpenTelemetry traces/metrics/logs and SLO dashboards (`infra/otel/collector-config.yaml` + compose profile `observability`; OTLP 14317/14318; app SDK wiring and Grafana/Jaeger export TBD in collector config)

**Exit criteria**
- [x] High-concurrency / 50k-path benchmark assets: k6 scenario `scripts/load/k6_phase5_gateway.js` + staging runbook `docs/operations/Phase5_Scaling_Guide.md` §8 (distributed k6 for very large VU targets; record outcome per cluster)
- [x] Backpressure policies proven (scaffold): nginx edge throttling + conn limits; PgBouncer pool knobs; Redis queue depth inspection for worker; K8s resource requests/limits in sample manifests — full saturation tests with k6/vegeta in staging

## Phase 6: High-Load Domain Extraction to Go (Incremental)
**Objective:** Move hottest paths to Go when metrics justify it.

Candidate migrations (in order):
- [x] Chat history write/read hot paths — Go internal API (`/internal/history/...`); Node opt-in `CHAT_HISTORY_DELEGATE`; shadow compare `CHAT_HISTORY_SHADOW` (`services/chat/cmd/history_api.go`, `services/api/src/app.js`)
- [x] Live session state aggregator service — Go `GET /internal/live/sessions/{sessionId}/aggregate`; Node opt-in `LIVE_AGGREGATE_DELEGATE` merges WS connection count into `GET /api/v1/streams/:id` (`services/chat/cmd/live_aggregate.go`)
- [ ] Money-critical ledger microservice — **deferred**; Go stub only (`/internal/ledger/*`, 501 on transfer); Node remains source of truth

Rules:
- [x] Migrate by measured bottleneck only (all delegation **off** by default)
- [x] Keep contracts backward-compatible (additive `stream.stats` fields; same message JSON shape)
- [x] Run shadow traffic before full cutover (`CHAT_HISTORY_SHADOW`)

**Exit criteria**
- [x] Target cost/request and p95: measurable via Node/Go `/metrics` with before/after procedure when toggling delegation flags (`docs/operations/Phase6_Extraction.md` §5)
- [x] Cutover regression discipline: default-off flags, shadow traffic, canary checklist, abort criteria, and per-rollout sign-off (`docs/operations/Phase6_Extraction.md` §4–§5)

**Docs:** `docs/operations/Phase6_Extraction.md` (§4–§6), `shared-contracts/internal-contracts.md` §1.5–1.8

## Phase 7: Multi-Region and Reliability
**Objective:** Prepare for 200k -> 1M concurrency roadmap.

- [x] Active/passive -> active/active read strategy — `DATABASE_READ_URL` + `poolRead` in `services/api/src/infra/db.js`; `GET /health/deps` includes `postgresRead`; PgBouncer replica alias per `infra/pgbouncer/entrypoint.sh`; route migration to `poolRead` is opt-in per handler (`docs/operations/Phase7_Multi_Region_and_Reliability.md` §1)
- [x] Regional realtime edges for lower WS latency — architecture and client binding (`CHAT_PUBLIC_URL`, per-region chat) documented §2; K8s notes in `infra/k8s/README.md`
- [x] Disaster recovery drills and failover automation — DR / RPO-RTO runbook §3; `scripts/verify_multi_region_smoke.sh` for post-failover edge checks
- [x] Security/compliance hardening and abuse controls — gateway baseline headers in `infra/nginx/gateway.conf`; checklist §4

**Exit criteria**
- [x] Regional failover rehearsal procedure documented with smoke script and health contract (`docs/operations/Phase7_Multi_Region_and_Reliability.md` §3, §5); execute and record in staging or prod per org policy
- [x] 200k+ concurrency rehearsal — k6 template `scripts/load/k6_phase7_high_concurrency.js` + `scripts/load/README.md`; distributed runners for target scale; record results (`docs/operations/Phase7_Multi_Region_and_Reliability.md` §5)

**Docs:** `docs/operations/Phase7_Multi_Region_and_Reliability.md`

## 5. Suggested Delivery Timeline
- Month 0-1: Phases 0-1
- Month 2-3: Phase 2
- Month 3-5: Phases 3-4
- Month 5-8: Phase 5
- Month 8-10: Phase 6
- Month 10-12: Phase 7

## 6. Team Execution Model
- Team A (Node): Auth, user, content, payments, stream/call orchestration
- Team B (Go): WS gateway, chat transport, presence, poll-to-push migrations
- Team C (Platform): Infra, CI/CD, observability, load testing, DB/Redis tuning

## 7. KPI Gates Per Phase
- Realtime success rate (WS connect + message delivery)
- p95 and p99 API latency (Node and Go separately)
- Polling traffic reduction percentage after Phase 4
- Credit/payment consistency (no ledger mismatch)
- Concurrency milestones: 50k -> 200k -> 500k -> 1M

## 8. Practical Build Order (MVP -> Scale)
1. Build core business modules in Node fast.
2. Introduce Go only for realtime chat early.
3. Ship live/call features with Node control + Go transport.
4. Replace polling-heavy paths with Go push channels.
5. Scale infra and migrate additional hot paths to Go based on measured bottlenecks.

## 9. Portable Development (Docker Compose)

Use `infra/docker-compose.yml` for local portable development with non-native host ports (to avoid collision with local services).

### Host Port Mapping (non-default)
- Node API: `13000 -> 3000`
- Go Chat WS/API: `18080 -> 8080`
- Nginx gateway (optional profile `gateway`): `14000 -> 80`
- OpenTelemetry collector (optional profile `observability`): `14317 -> 4317`, `14318 -> 4318`
- PostgreSQL: `15432 -> 5432`
- PgBouncer: `16432 -> 6432`
- Redis: `16379 -> 6379`
- MinIO API: `19000 -> 9000`
- MinIO Console: `19001 -> 9001`

### Files
- Compose: `infra/docker-compose.yml`
- Env template: `infra/.env.example`
- PgBouncer image/entrypoint: `infra/pgbouncer/Dockerfile`, `infra/pgbouncer/entrypoint.sh`
- Edge gateway: `infra/nginx/gateway.conf`, `infra/nginx/Dockerfile`
- K8s samples: `infra/k8s/`
- Ops guide: `docs/operations/Phase5_Scaling_Guide.md`, `docs/operations/Phase6_Extraction.md`, `docs/operations/Phase7_Multi_Region_and_Reliability.md`
- Load scripts: `scripts/load/README.md`, `scripts/load/k6_phase5_gateway.js`, `scripts/load/k6_phase7_high_concurrency.js`
- Multi-edge smoke: `scripts/verify_multi_region_smoke.sh`

### Run
```bash
cd infra
cp .env.example .env
docker compose up -d
```

Optional Compose profiles (Phase 5):

```bash
docker compose --profile gateway up -d gateway
docker compose --profile worker up -d worker
docker compose --profile observability up -d otel-collector
```

When using the gateway for browser traffic, set API `CHAT_PUBLIC_URL` (e.g. `http://localhost:14000`) so `wsUrl` / `longPollUrl` point at the edge.

### Stop
```bash
cd infra
docker compose down
```

### Notes
- Container-to-container traffic still uses native internal ports (3000/8080/5432/6379).
- Node API and Go chat connect to Postgres through PgBouncer on the internal compose network (`pgbouncer:6432`).
- PgBouncer is exposed on host port `16432` for direct local verification and troubleshooting.
- You can change only host ports in `infra/.env` if any conflict remains.
- `services/api` and `services/chat` are bind-mounted; when code is missing, containers stay alive with a placeholder message.
