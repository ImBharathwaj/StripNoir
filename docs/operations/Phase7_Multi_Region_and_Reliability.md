# Phase 7: Multi-region, reliability, and hardening

**Objective:** Prepare for 200k → 1M concurrency and geographic distribution without changing client contracts.

## 1. Active/active read strategy

**Writes** stay on the **primary** PostgreSQL (via PgBouncer pool name matching `DATABASE_URL`).

**Reads** can fan out to **replica** backends:

1. Provision a read replica (managed Postgres, streaming replication, or logical replica).
2. Expose it through PgBouncer using `PGBOUNCER_REPLICA_HOST` (see `infra/pgbouncer/entrypoint.sh`) — connection string uses DB name alias `{database}_ro` by default.
3. Set **`DATABASE_READ_URL`** on the Node API to that replica alias (e.g. `postgresql://app:app@pgbouncer:6432/stripnoir_ro`). When unset, the API uses only `DATABASE_URL` (today’s behaviour).
4. `GET /health/deps` reports **`postgresRead`**: `mode: primary_only` or a live check against the replica pool.
5. **Route migration:** opt in high-volume **read-only** handlers to `poolRead` over time (`const { pool, poolRead } = require('./infra/db')`). Never use `poolRead` inside transactions that later write.

**Active/active** here means *multiple regional API edges* can serve reads from region-local replicas while writes forward to a single primary (or future multi-primary with conflict resolution — out of scope for this doc).

## 2. Regional realtime edges (lower WS latency)

| Concern | Approach |
|---------|----------|
| DNS / traffic | GeoDNS or anycast to nearest edge (Cloudflare, Route53 latency records, etc.). |
| **Chat / WS** | Deploy **Go chat** Deployments per region; each connects to **shared** Redis (global cluster or regional + relay — see tradeoffs below). |
| **Node API** | Regional Deployments; same `DATABASE_URL` to primary (or proxy), `DATABASE_READ_URL` to nearby replica. |
| **Pub/sub** | Redis Global / active-active replication, or single regional Redis with **cross-region** pub/sub bridge (higher latency). Document which rooms are “local” vs “global”. |
| **JWT / secrets** | Same signing keys in all regions (KMS replicated or bootstrap from single source). |

**Client binding:** browsers already use `CHAT_PUBLIC_URL` / gateway — set this to the **regional** entry hostname returned by your API or CDN.

**Compose:** remains single-region; use `infra/k8s/` plus external DNS for multi-region.

## 3. Disaster recovery and failover

**Targets (set per org):** RPO (max data loss), RTO (max downtime), and who approves failover.

| Drill | Action |
|-------|--------|
| **Replica lag** | Alert on replication lag; block or shed read load if lag > SLO. |
| **Primary failure** | Promote replica (managed “failover” button or Patroni/Orchestrator); update `DATABASE_URL` / PgBouncer primary target; roll API/chat. |
| **Region loss** | DNS failover to secondary region; ensure Redis + Postgres topology documented (cold standby vs hot). |
| **Automation** | Prefer operator-run playbooks first; automate `kill -` style DNS/ConfigMap updates after rehearsals. |

**Smoke:** `scripts/verify_multi_region_smoke.sh` — optional `REGION_A_URL`, `REGION_B_URL` (and chat paths) to confirm edges respond after DNS or manifest changes.

## 4. Security, compliance, and abuse controls

**Edge (nginx):** `infra/nginx/gateway.conf` adds baseline **`X-Content-Type-Options`**, **`X-Frame-Options`**, **`Referrer-Policy`** on gateway responses. Extend with CSP, WAF (ModSecurity / cloud WAF), and IP reputation if required.

**API:** Existing Redis rate limits on `/api/v1`; tighten `API_RATE_LIMIT_*` under attack. Add account-level throttles for sensitive routes as features mature.

**Operational checklist**

- [ ] Secrets in KMS / SealedSecrets / external vault — not in git
- [ ] TLS termination at ingress or gateway; HSTS at public edge
- [ ] Audit logs for admin and payment actions (store in append-only sink)
- [ ] Dependency and image scanning in CI
- [ ] Data retention policy aligned with jurisdiction (GDPR, etc.)

## 5. Exit criteria (rehearsal procedure)

**Regional failover “validated”** means: you executed a documented drill in **staging** (or prod with approval), captured before/after health (`/health/deps` including `postgresRead` if used), and recorded RPO/RTO outcomes — not that CI proves multi-region alone.

**200k+ concurrency rehearsal** means: distributed k6 (or equivalent) against your **production-like** gateway/cluster, with `scripts/load/k6_phase7_high_concurrency.js` as the in-repo scenario template; record clusters size, VU count, error rate, and p95 — see `scripts/load/README.md`.

## 6. References

- Phase 5 gateway / scaling: `docs/operations/Phase5_Scaling_Guide.md`
- K8s samples: `infra/k8s/README.md`
- Internal contracts: `shared-contracts/internal-contracts.md`

## 7. LiveKit readiness (token issuance verification)

**Goal:** verify that your LiveKit env is configured and that API-issued LiveKit tokens include the expected grants (host/publisher for creators, viewer/subscriber for viewers/clients).

### Prerequisites
- Configure LiveKit settings (for example, Cloud or self-hosted) as documented in `docs/LiveKit_Cloud_Setup.md`.
- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` must be set and not default placeholders.

### Verification steps
1. Health/deps sanity
   - `curl -sS "$API_BASE_URL/health/deps" | jq '.dependencies.livekit'`
   - Expect: `{ "configured": true }`

2. Live streams token validation
   - `REQUIRE_LIVEKIT=1 API_BASE_URL=<your_api_base_url> ./scripts/check_live_session_flow.sh`
   - This hits:
     - `POST /api/v1/streams/start`
     - `POST /api/v1/streams/:id/join`
     - `POST /api/v1/streams/:id/token`

3. 1-1 video calls token validation
   - `REQUIRE_LIVEKIT=1 API_BASE_URL=<your_api_base_url> ./scripts/check_video_call_flow.sh`
   - This hits:
     - `POST /api/v1/calls/create`
     - `POST /api/v1/calls/:requestId/accept`
     - `POST /api/v1/calls/:id/join`
     - `POST /api/v1/calls/:id/token`
