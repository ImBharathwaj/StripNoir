# Internal Service Contracts (Node <-> Go)

This document defines service-to-service contracts used inside the platform.  
These are non-public APIs and are versioned independently from client APIs.

## 1. Node -> Go contracts

### 1.1 Publish chat event
- Endpoint: `POST /internal/chat/publish` (Go chat service)
- Auth: `x-internal-key` header (when `CHAT_INTERNAL_API_KEY` is configured)
- Purpose: Fan-out chat/read/edit/delete events through Redis pub/sub

Request body:
```json
{
  "roomId": "uuid",
  "eventType": "message.created",
  "payload": {}
}
```

Response:
```json
{
  "status": "published"
}
```

### 1.2 Chat token verification model
- Issuer: Node API (`GET /api/v1/chat/ws-token`)
- Consumer: Go chat service (`/ws` + `/realtime/rooms/:id/events`)
- JWT claims contract:
  - `sub` (user id)
  - `roomId`
  - `typ = "chat"`
  - `exp`

### 1.3 Publish user notification event
- Endpoint: `POST /internal/notify/publish` (Go chat service)
- Auth: `x-internal-key` header (when `CHAT_INTERNAL_API_KEY` is configured)
- Purpose: Fan-out per-user notification events through Redis pub/sub (`user_notify:{userId}`)

Request body:
```json
{
  "userId": "uuid",
  "eventType": "notification.created",
  "payload": {}
}
```

Response:
```json
{
  "status": "published"
}
```

### 1.4 Notification stream token model
- Issuer: Node API (`GET /api/v1/notifications/ws-token`)
- Consumer: Go chat service (`/ws?token=...` and `GET /realtime/notify/events?token=...`)
- JWT claims contract:
  - `sub` (user id)
  - `typ = "notify"`
  - `exp`  
  (no `roomId`)

### 1.5 Chat history (delegated hot path)
- Endpoints (Go chat service, **not** exposed at public gateway):
  - `GET /internal/history/rooms/{roomId}/messages?limit=&before=`
  - `POST /internal/history/rooms/{roomId}/messages` — JSON `{ "body": "..." }`
  - `PATCH /internal/history/rooms/{roomId}/messages/{messageId}` — JSON `{ "body": "..." }`
  - `DELETE /internal/history/rooms/{roomId}/messages/{messageId}`
- Auth: `x-internal-key` when `CHAT_INTERNAL_API_KEY` is set; **`X-Delegate-User-Id`** (authenticated user id) required on every request. Go verifies `chat_room_participant` membership and performs the same SQL + Redis publish as Node (`message.created|edited|deleted`).
- Caller: Node API when `CHAT_HISTORY_DELEGATE=1` (or `true`) forwards public `/api/v1/chat/rooms/.../messages` after its own participant check. Default remains Node-only.

### 1.6 Live session aggregate (internal)
- Endpoint: `GET /internal/live/sessions/{sessionId}/aggregate`
- Auth: `x-internal-key` when configured
- Response (JSON): `liveSessionId`, `roomId`, `dbActiveViewers` (billing-relevant active rows), `wsViewerConnections` (Redis `SCARD` on WS presence set), `source` (`go_aggregate`)
- Caller: Node `GET /api/v1/streams/:id` when `LIVE_AGGREGATE_DELEGATE=1` merges `stats.wsViewerConnections` and `stats.aggregateSource`; `stats.activeViewers` stays from Node SQL.

### 1.7 Ledger stub (placeholder)
- `GET /internal/ledger/health` — JSON status `not_implemented`
- `POST /internal/ledger/transfer` — **501**; credits remain authoritative in Node until a future cutover.

### 1.8 Shadow traffic (chat history)
- When `CHAT_HISTORY_SHADOW=1` and **not** delegating, Node still serves messages from Postgres and asynchronously compares list length against Go `GET /internal/history/...` (logs warnings on mismatch).

## 2. Planned Go -> Node/internal hooks

These are defined now for boundary clarity and can be implemented incrementally:

### 2.1 Auth lookup
- Proposed endpoint: `POST /internal/auth/resolve`
- Purpose: Resolve user/session state for realtime gateway decisions

### 2.2 Moderation hook
- Proposed endpoint: `POST /internal/moderation/message-check`
- Purpose: Pre-delivery moderation policy check

### 2.3 Ledger hook
- Production ledger remains Node (`transferCredits` / wallet tables). Go exposes a **stub** only (`1.7`). A future `POST /internal/ledger/charge` (or similar) would require a full contract version.

## 3. Compatibility Rules

- Additive request/response fields are backward-compatible.
- Removing or renaming fields requires a major contract version bump.
- New internal endpoints must be documented here before rollout.
