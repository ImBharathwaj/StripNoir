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

## 2. Planned Go -> Node/internal hooks

These are defined now for boundary clarity and can be implemented incrementally:

### 2.1 Auth lookup
- Proposed endpoint: `POST /internal/auth/resolve`
- Purpose: Resolve user/session state for realtime gateway decisions

### 2.2 Moderation hook
- Proposed endpoint: `POST /internal/moderation/message-check`
- Purpose: Pre-delivery moderation policy check

### 2.3 Ledger hook
- Proposed endpoint: `POST /internal/ledger/charge`
- Purpose: Realtime-triggered credit deductions for live/call events

## 3. Compatibility Rules

- Additive request/response fields are backward-compatible.
- Removing or renaming fields requires a major contract version bump.
- New internal endpoints must be documented here before rollout.
