# Frontend development plan and backend binding

This document describes how a web (or mobile-web) client should be structured, how it talks to the **Node API** (`services/api`) and the **Go chat gateway** (`services/chat`), and a practical delivery order. It complements `docs/Basic_API_design.md`, `shared-contracts/openapi.yaml`, and `shared-contracts/internal-contracts.md`.

## 1. Architecture snapshot

| Concern | Service | Base path / host |
|--------|---------|-------------------|
| REST business API (auth, users, content, payments, streams, calls orchestration, notifications list, chat persistence) | Node | `/api/v1` on the API host |
| Health | Node | `/health`, `/health/deps` |
| WebSocket + long-poll realtime (chat rooms, live/call room events, per-user notifications) | Go chat | Separate origin: `/ws`, `/realtime/...` (URLs returned by Node) |
| Internal fan-out (not for browsers) | Go chat | `/internal/*` — **never** call from frontend |

**Contract source of truth:** `shared-contracts/openapi.yaml` (public Node routes). Chat transport shapes are described in `shared-contracts/internal-contracts.md` (JWT claims and event patterns); event payloads are JSON objects on the wire.

## 2. Local and deployed URLs

**Docker Compose (host defaults from `infra/docker-compose.yml` and `infra/.env.example`):**

- Node API: `http://localhost:13000` (container port `3000`)
- Go chat: `http://localhost:18080` (container port `8080`)

**Browser rule:** the app must use **public hostnames** (or dev proxies), not Docker service names (`http://chat:8080`). The Node API already returns absolute `wsUrl` / `longPollUrl` built from `CHAT_SERVICE_URL` as seen **from the API**; for local dev, ensure that URL is reachable from the **browser** (e.g. `http://localhost:18080`). In production, front an API gateway that exposes both API and chat under consistent TLS hosts, or return chat URLs that point to a public `wss://` host.

## 3. Configuration surface (frontend env)

Recommended variables (names are illustrative; adjust to your framework):

| Variable | Purpose |
|----------|---------|
| `PUBLIC_API_BASE_URL` | Origin for Node only, e.g. `https://api.example.com` (no trailing slash) |
| `PUBLIC_CHAT_HTTP_ORIGIN` | Optional override if `wsUrl` from API is wrong for browsers; prefer fixing server-side `CHAT_SERVICE_URL` |
| `PUBLIC_LIVEKIT_URL` | From stream/call API responses when present; used by LiveKit client SDK |

All authenticated REST calls: `Authorization: Bearer <access_token>`.

**Do not** embed `CHAT_INTERNAL_API_KEY` or database credentials in the frontend.

## 4. Binding to the Node API

### 4.1 HTTP client layer

- Single module (e.g. `apiClient`) that:
  - Prefixes paths with `PUBLIC_API_BASE_URL + '/api/v1'`.
  - Injects `Authorization` when a session exists.
  - Parses JSON errors (`{ error: string }` pattern used widely).
  - Handles **429** using `RateLimit-Remaining` / `RateLimit-Limit` headers where present; backoff on auth routes (`/auth/register`, `/auth/login`, `/auth/refresh`) which use a stricter limiter.
- Optional: generate types from `shared-contracts/openapi.yaml` (openapi-typescript, Orval, etc.) to stay aligned with CI contract checks (`scripts/ci/check_contracts.sh`).

### 4.2 Auth session model

1. **Register / login** → store `accessToken` (short-lived), `refreshToken`, and optionally `sessionId` from responses.
2. **Access token expiry** → `POST /api/v1/auth/refresh` with `{ refreshToken }`; rotate stored tokens.
3. **Logout** → `POST /api/v1/auth/logout` with refresh body; clear local storage.
4. **Bootstrap** → `GET /api/v1/auth/me` after load.

Realtime JWTs for chat/notifications are **separate** short-lived tokens from Node (see below); do not substitute the main access token on Go `/ws` unless you explicitly align implementations (current backend: dedicated chat/notify tokens only).

### 4.3 Polling vs push (product expectation)

Several `GET` endpoints are **intentional fallbacks** for history or occasional refresh. Prefer push for live UX:

- **Chat messages:** persist via Node `POST/PATCH/DELETE .../chat/rooms/:id/messages`; subscribe to events via Go using `GET /api/v1/chat/ws-token?roomId=...` then `wsUrl` or `longPollUrl`.
- **Notifications:** list via `GET /api/v1/notifications`; live toasts via `GET /api/v1/notifications/ws-token` then notify `wsUrl` or long-poll.
- **Live / calls:** session state and LiveKit tokens from Node; room events (tips, presence, call state) on the **room** WebSocket from chat.

Responses may include `X-StripNoir-Realtime: prefer-go-websocket-or-long-poll` on poll-prone `GET`s — treat as a hint to prefer realtime transports.

## 5. Binding to the Go chat service

### 5.1 Getting connection URLs (always via Node)

| Use case | Node endpoint | Go entrypoints (from JSON) |
|----------|---------------|----------------------------|
| Room chat + live/call room events | `GET /api/v1/chat/ws-token?roomId=<uuid>` | `wsUrl` (WebSocket), `longPollUrl` (GET, blocks up to `timeoutSec`) |
| Per-user notification stream | `GET /api/v1/notifications/ws-token` | `wsUrl`, `longPollUrl` (`/realtime/notify/events?token=...`) |

JWT claims (verified by Go):

- **Chat room:** `typ: "chat"`, `sub`, `roomId`, `exp`.
- **Notify stream:** `typ: "notify"`, `sub`, `exp` (no `roomId`).

### 5.2 WebSocket client

- Connect to `wsUrl` from Node (token is usually in query string; URL-encode if you build URLs manually).
- **Chat rooms:** optional query `roomId` must match the token’s `roomId` when present.
- **Protocol:** server sends **text frames**; each message is a JSON object (envelope includes `eventType`, `payload`, `sentAt`, and room/user fields depending on event).
- **Heartbeat:** today the server primarily uses read loops; send occasional **ping** frames or small client messages only if you confirm server behavior — otherwise rely on TCP/WebSocket keepalive and reconnect logic.

Implement **reconnect with backoff** and **re-fetch ws-token** after 401 or expiry.

### 5.3 Long-poll fallback

- `GET longPollUrl` returns `{ events: [ ... ] }` (possibly empty array on timeout).
- Use when WebSocket is blocked (corporate proxies) or for minimal clients.

### 5.4 Event types to handle in UI (non-exhaustive)

Documented in code and Node `publishChatEvent` / `publishNotifyEvent` usage; examples:

- Chat: `message.created`, `message.edited`, `message.deleted`, `room.read`.
- Live: `live.viewer.joined`, `live.viewer.extended`, `live.ended`, `live.ws_presence`, `tip.received`.
- Calls: `call.accepted`, `call.joined`, `call.extended`, `call.ended`.
- Notifications: `notification.created` (payload includes persisted notification shape when applicable).

**Rendering rule:** merge incoming events into local stores (chat threads, notification bell, live session banner) and dedupe by server ids when present.

## 6. LiveKit (video) binding

- Node returns `livekit` objects on stream/call flows (URL, token, role, grants).
- Use the **official LiveKit client SDK** for the web; connect with returned token and `LIVEKIT_URL` / `url` from API.
- Chat/WebSocket remains on **Go** for text/events; LiveKit carries media. Keep the two connection lifecycles separate in code (connect/disconnect, reconnect on token refresh).

## 7. CORS, cookies, and security

- **CORS:** Node enables `cors()` broadly today; tighten allowed origins in production.
- **Go `/ws`:** `CheckOrigin` is permissive in current code — production must restrict origins.
- **Tokens:** prefer **memory** for access token; refresh token in **httpOnly Secure cookie** if you control the web origin and add a BFF cookie route; if SPA-only on a separate domain, use secure storage patterns and short access TTL.
- **Content:** assume NSFW; gate UI by creator/content flags from API.

## 8. Suggested frontend repo layout (inside monorepo)

If you add the app beside `services/api` and `services/chat`:

```text
apps/web/                 # or web/, frontend/
  src/
    api/                  # fetch wrapper, openapi-generated types
    realtime/             # WebSocket + long-poll managers, event reducer
    features/             # auth, feed, creator, live, calls, chat, wallet
    livekit/              # LiveKit room hooks
  public/
```

Keep **one** realtime manager per scope (e.g. one WS per active room, one notify connection per logged-in user) to avoid duplicate subscriptions.

## 9. Phased delivery (recommended)

| Phase | Scope | Backend touchpoints |
|-------|--------|---------------------|
| F0 | Scaffold app, env, API client, auth pages, `auth/me` | Node `/auth/*`, `/auth/me` |
| F1 | Profiles, feed, content list/detail, basic navigation | Node users/creators/content/feed |
| F2 | Wallet display, deposit, tips, subscribe | Node payments, wallet |
| F3 | DM chat: room list, messages REST + **chat WS** | Node `/chat/*`, Go `ws` from `chat/ws-token` |
| F4 | Notification inbox + **notify WS** | Node `/notifications*`, Go notify stream |
| F5 | Live: list/detail/join, LiveKit viewer, room WS for chat/presence/tips | Node `/streams/*`, Go chat room |
| F6 | Video calls: request/accept/join/extend/end + room WS | Node `/calls/*`, Go chat room |
| F7 | Polish: offline, 429 UX, metrics-aware debouncing on fallback GETs | Optional: Node `/metrics.json` in dev |

## 10. Testing strategy

- **Contract:** run or watch `scripts/ci/check_contracts.sh` when `openapi.yaml` changes.
- **E2E smoke:** reuse existing scripts where applicable (`scripts/check_live_session_flow.sh`, `scripts/check_video_call_flow.sh`, `scripts/verify_chat_ws.sh`) against a running stack; add Playwright/Cypress later for UI.
- **Realtime:** integration test: obtain `ws-token`, open one WebSocket, assert a `message.created` or published event after `POST` message (see `docs/scripts/check_chat_api.sh` pattern).

## 11. Future alignment (Phase 5+)

- Single public API gateway host with path-based routing (`/api/v1` → Node, `/realtime` or `/ws` → Go) to simplify browser same-site cookies and CORS.
- OpenTelemetry trace context propagation from browser → Node → Go (W3C `traceparent`) for end-to-end latency dashboards.

---

**Summary:** The frontend talks **REST only to Node** for business operations and token issuance; it opens **WebSocket or long-poll only to Go** using URLs and JWTs returned by Node. Internal Go endpoints are server-only. Ship features in vertical slices (auth → social → wallet → chat WS → notify WS → live/call + LiveKit).
