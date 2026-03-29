# Scale-Up Strategy For 5,000 Simultaneous Users

## Scope

This note describes a practical production scaling strategy for handling at least `5,000` simultaneous users in StripNoir.

Important distinction:

- `5,000 logged-in users` is much easier than `5,000 actively chatting / polling / watching live streams`
- the current standalone Docker setup is a development-style setup, not a production capacity target

## Current Reality

The current app can not be treated as a true `5,000 active-user` architecture yet because:

- chat still has polling-heavy paths on the frontend
- Node.js still sits in front of Go for public API routing
- frontend and API are currently run in development mode in Docker
- PostgreSQL and Redis are single-instance in the default setup
- PgBouncer default pool sizing is still small for serious multi-thousand-user traffic

## Assumptions For 5,000 Simultaneous Users

This plan assumes:

- most users are browsing, not all sending chat messages at the same time
- only a fraction of users are in active realtime chat at once
- media delivery is offloaded to object storage / CDN
- WebSocket and Go-based realtime are preferred over repeated HTTP polling

If the target means `5,000 users all actively chatting/live at the same time`, more optimization and more infrastructure will be required.

## Recommended Production Topology

### Application Layer

- `2-3` gateway containers
- `2` frontend containers
- `3-4` Node.js API containers
- `4-6` Go chat containers
- `2` worker containers

### Data Layer

- `1` PostgreSQL primary
- `1` PostgreSQL read replica recommended after initial rollout
- `1-2` PgBouncer instances
- `1` Redis primary
- `1` Redis replica / Sentinel recommended for HA

## Recommended System Specs

### App Nodes

Start with `3` application nodes:

- `8 vCPU`
- `16-32 GB RAM`
- fast SSD / NVMe storage

These nodes can host:

- gateway
- frontend
- Node API
- Go chat
- worker containers

### Database Node

Use a dedicated PostgreSQL machine:

- `8-16 vCPU`
- `32-64 GB RAM`
- fast NVMe SSD

PostgreSQL will usually become the first serious bottleneck before Go chat does.

### Redis Node

Use a dedicated Redis machine:

- `2-4 vCPU`
- `8-16 GB RAM`

## Suggested Initial Replica Counts

For a serious first production rollout targeting `5,000` simultaneous users:

- `gateway`: `2`
- `frontend`: `2`
- `api`: `3`
- `chat`: `4`
- `worker`: `2`
- `pgbouncer`: `1-2`
- `postgres`: `1 primary`
- `redis`: `1 primary`

That is roughly `14-16` containers total, excluding observability stack and optional replicas.

## What Must Be Improved Before Trusting 5k Load

### Chat / Realtime

- reduce unnecessary frontend polling
- rely more on WebSocket or long-poll event streams
- avoid repeated `/auth/me` calls in active chat views
- avoid repeated room summary fetches where event-driven updates are enough
- continue moving hot chat read paths fully to Go

### API / Gateway

- keep Node.js focused on auth and business APIs
- keep high-frequency realtime and chat traffic on Go
- add explicit load balancer health checks and autoscaling thresholds

### Database

- tune PgBouncer pool sizes
- add read replicas for heavy read paths
- add indexes for hot chat, notifications, and live-session queries
- validate query plans under load

### Media / Static Delivery

- serve media via object storage + CDN
- do not route large media delivery through app containers

## Bottlenecks Most Likely To Appear First

In the current architecture, the likely order of bottlenecks is:

1. PostgreSQL
2. PgBouncer pool limits
3. frontend/API polling overhead
4. Node API containers
5. Redis

Go chat is not likely to be the first hard bottleneck unless websocket/chat traffic becomes extremely high.

## Practical Capacity Guidance

### Likely Safe Zone

- `5,000` simultaneous users where most are browsing and only a smaller fraction are active in chat/live features

### Not Safe Without More Work

- `5,000` simultaneous users all actively chatting every few seconds
- `5,000` simultaneous users all using live streams or calls at once

That type of load requires:

- deeper Go migration
- tighter realtime architecture
- much more aggressive database tuning
- proper load testing

## Rollout Strategy

1. Move more hot chat and notification read paths to Go
2. Reduce frontend polling pressure
3. Run production builds instead of development mode
4. Deploy with:
   - `2` gateway
   - `2` frontend
   - `3` Node API
   - `4` Go chat
   - dedicated PostgreSQL, Redis, and PgBouncer
5. Load test with realistic traffic patterns
6. Increase Go chat replicas to `6-8` only if realtime traffic justifies it
7. Add PostgreSQL read replica if read-heavy traffic becomes dominant

## Bottom Line

A realistic first production target for this application at `5,000 simultaneous users` is:

- `3` app nodes at `8 vCPU / 16-32 GB RAM`
- `1` dedicated PostgreSQL node at `8-16 vCPU / 32-64 GB RAM`
- `1` dedicated Redis node at `2-4 vCPU / 8-16 GB RAM`
- `2` gateway, `2` frontend, `3` Node API, `4` Go chat, `2` worker containers

That is a reasonable starting point, but it still needs load testing before being treated as a guaranteed production number.
