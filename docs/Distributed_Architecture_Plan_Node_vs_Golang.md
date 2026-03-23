# Distributed Architecture Plan (Node.js and Golang)

## 1) Objective

Design Escorta to scale as a distributed system for very high concurrency, regardless of backend language (Node.js or Golang).

## 2) Core principle

- Language is not the scaling strategy.
- **Distributed architecture** is mandatory for 1M-concurrency goals.
- Node.js and Go should follow the same system design; Go mainly improves per-node efficiency.

## 3) Shared distributed blueprint (applies to both)

## 3.1 Edge and traffic
- Global DNS + CDN (Cloudflare/Fastly/CloudFront).
- WAF + bot/rate controls at edge.
- Regional load balancers routing to stateless API clusters.

## 3.2 App/API tier
- Stateless API services in containers (Kubernetes/ECS/Nomad).
- Horizontal pod autoscaling on CPU, memory, p95 latency, queue depth.
- API gateway for auth, routing, throttling, canary releases.

## 3.3 Realtime tier
- Dedicated realtime gateway cluster for WebSocket/SSE.
- Redis/NATS/Kafka pub-sub backplane for fan-out.
- Room/session sharding by `sessionId`/`roomId`.

## 3.4 Data tier
- PostgreSQL primary + read replicas.
- PgBouncer for connection pooling.
- Redis cluster for cache/session/rate-limit counters.
- Optional partitioning/sharding for heavy write domains (messages/events/ledger).

## 3.5 Media tier
- Object storage (S3/MinIO) + CDN.
- Async media processing workers (thumbnails, blur, moderation hooks).
- Signed URL/tokenized media access.

## 3.6 Async jobs/events
- Queue platform (Kafka/RabbitMQ/SQS + workers).
- Jobs: notifications, emails, moderation, analytics pipeline, reconciliation.
- Outbox pattern for reliable event publishing.

## 3.7 Observability and reliability
- OpenTelemetry traces, metrics, centralized logs.
- SLOs per service (p95 latency, error budget).
- Multi-AZ deployment, backups, disaster recovery runbooks.

## 4) Node.js distributed implementation

## 4.1 Suggested stack
- API: Fastify/Nest/Next API routes (gradually separated).
- Realtime: `ws`/Socket.IO + Redis adapter.
- Queues: BullMQ (Redis) initially, Kafka later.
- Process manager: PM2 only for small phase; move to containers early.

## 4.2 Node-specific guardrails
- Keep handlers non-blocking; offload CPU-heavy tasks to workers.
- Use cluster mode only as transitional step; prioritize multi-instance orchestration.
- Strict memory limits and restart policies to avoid event-loop stalls.

## 4.3 Scale phases (Node)
1. Single-region multi-instance + Redis + PgBouncer.
2. Realtime tier separated from API tier.
3. Read replicas + caching + queue workers.
4. Multi-region active/passive, then active/active for reads.

## 5) Golang distributed implementation

## 5.1 Suggested stack
- API: `gin` or `chi`.
- DB: `pgx + sqlc`.
- Realtime: native WebSocket services + Redis/NATS/Kafka backplane.
- Queues/workers: Go consumers for Kafka/SQS/RabbitMQ.

## 5.2 Go-specific guardrails
- Context deadlines and cancellation on all I/O.
- Connection pool sizing and backpressure controls.
- Avoid monolith regrowth: enforce service boundaries early.

## 5.3 Scale phases (Go)
1. Multi-instance API services + Redis + PgBouncer.
2. Dedicated realtime and worker services.
3. Domain service split (ledger, messaging, live/video orchestration).
4. Multi-region active/active with regional data strategy.

## 6) Node vs Go at distributed scale

| Area | Node.js | Golang |
|---|---|---|
| Developer velocity | Faster for existing team | Medium (depends on team familiarity) |
| Per-node throughput | Good | Higher |
| Memory efficiency | Moderate | Better |
| Realtime implementation | Mature ecosystem | Excellent performance/control |
| Operational complexity | Similar at distributed scale | Similar at distributed scale |
| Need for distribution at 1M users | Required | Required |

## 7) Recommended path for this project

1. Keep frontend in Next.js.
2. Build distributed foundations now (Redis, PgBouncer, queues, observability, gateway).
3. Keep Node for fast feature shipping.
4. Migrate high-load APIs to Go incrementally (chat/live/ledger) once bottlenecks are measured.
5. Run mixed architecture (Node + Go) behind one gateway.

## 8) 12-month rollout plan (practical)

## Months 0-2
- Add gateway, Redis cluster, PgBouncer, centralized telemetry.
- Split realtime traffic from web traffic.
- Introduce queue workers for async jobs.

## Months 3-5
- Add read replicas, caching strategy, and traffic shadowing.
- Move chat/live/session endpoints to dedicated services.
- Capacity tests at 5x expected peak.

## Months 6-8
- Migrate money-critical flows to isolated ledger service.
- Add idempotency and reconciliation jobs.
- Regional failover drills.

## Months 9-12
- Multi-region rollout for reads + realtime edge optimization.
- Autoscaling refinement by SLO metrics.
- Security/compliance hardening for growth stage.

## 9) Capacity checkpoints before “million-user” claim

- 50k concurrent: stable single-region distributed stack.
- 200k concurrent: dedicated realtime tier + replicas + queue saturation controls.
- 500k concurrent: multi-region reads, sharded hot datasets, aggressive caching.
- 1M concurrent: proven multi-region architecture, traffic engineering, and incident automation.

## 10) Final decision rule

- If your bottleneck is **product iteration speed**: stay mostly Node and distribute correctly.
- If your bottleneck is **API efficiency/cost at high concurrency**: move hot paths to Go.
- In both cases, scale target is achieved by architecture, not by language alone.

