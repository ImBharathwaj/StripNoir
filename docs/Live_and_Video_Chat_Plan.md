# Live Video & 1-1 Video Chat — Feature Plan

This document outlines a plan to add **companion live streaming** (with client text chat) and **1-1 video chat** between clients and companions.

---

## Implementation status (updated)

### Live video — implemented

| Item | Status | Notes |
|------|--------|--------|
| **Provider** | Done | LiveKit Cloud (free tier); tokens via `livekit-server-sdk` and `src/lib/livekit.ts`. |
| **DB models** | Done | `LiveSession`, `LiveSessionViewer` (with `watchExpiresAt`), `LiveSessionMessage` in Prisma. `VideoCallSession` for 1-1; `SessionReport` and soft-delete on `LiveSessionMessage` for moderation. |
| **Credits** | Done | 1 credit to join (first 2 min included). Extend: 1 credit = +2 min. Companion earns on join and extend (`live_watch`, `live_earned`). |
| **APIs** | Done | `POST /api/live/start`, `PATCH /api/live/[sessionId]/end`, `GET /api/live/sessions`, `GET /api/live/[sessionId]` (returns `viewerCount`), `POST /api/live/[sessionId]/join` (returns `watchExpiresAt`), `POST /api/live/[sessionId]/extend`, `POST /api/live/[sessionId]/leave`, `GET/POST /api/live/[sessionId]/messages`, `DELETE /api/live/[sessionId]/messages/[messageId]`, `POST /api/live/[sessionId]/report`, `GET /api/live/[sessionId]/tips`. |
| **Companion UI** | Done | Header “Go live” → `/live/go`. Start live, LiveKit room (camera/mic or VOD), live chat (polling), viewer count (“X watching”), End live. **Premium:** upload VOD and stream as “live”. Companion can delete chat messages and sees tip toasts when clients tip during live. |
| **Client UI** | Done | Header link “Live” → `/live`. List sessions (thumbnail, name, current viewer count). Join (1 credit) → watch 2 min then extend (1 credit = 2 min); countdown; "Live ended" card when companion ends; live chat + Leave. When watch time expires, video and chat pause with an overlay prompting to **extend watch time (1 credit = 2 min)**; chat input is disabled until extended or the user leaves. |
| **Chat** | Done | REST + polling (companion 5s, client 4s). Stored in `LiveSessionMessage`. Deleted messages are hidden for viewers. |

### 1-1 video chat — implemented

| Item | Status | Notes |
|------|--------|--------|
| **DB model** | Done | `VideoCallSession` (clientId, escortId, roomName, startedAt, endedAt, expiresAt, status). |
| **Credits** | Done | `VIDEO_CALL_CREDITS_PER_BLOCK = 1`, `VIDEO_CALL_BLOCK_MINUTES = 2`; client charged when companion accepts and on extend; companion earns (`video_call`, `video_call_extend`, `video_call_earned`). |
| **APIs** | Done | Request-based consensual flow: `POST /api/video-call/request`, `GET /api/video-call/requests`, `POST /api/video-call/request/[requestId]/accept`, `POST /api/video-call/request/[requestId]/decline`, `POST /api/video-call/request/[requestId]/cancel`; session APIs: `GET /api/video-call/active`, `GET /api/video-call/[sessionId]` (token + session), `GET /api/video-call/[sessionId]/status` (active/expired/ended), `POST /api/video-call/[sessionId]/extend` (client), `PATCH /api/video-call/[sessionId]/end` (either), `GET /api/video-call/[sessionId]/tips`. |
| **Client UI** | Done | “Request video call” button in connection chat header when connected; client sees “Waiting for acceptance…” and can cancel. In-call page at `/video-call/[sessionId]` (remote + local video, timer, **Extend**, **End**, and a **Tip** button). When time expires, the video is blurred and an overlay prompts the client to **extend (+2 min, 1 credit)**; if they ignore it for 30 seconds, the call is ended for both. |
| **Escort UI** | Done | Dashboard banner “Video call in progress with X – Join call” when active; “Join video call” on connection chat; in-call page mirrors the client’s view. Escort sees tip toasts during the call when the client tips. |

### Key files (live feature)

- **Backend:** `src/lib/livekit.ts`, `src/lib/credits.ts` (LIVE_JOIN_CREDITS, LIVE_WATCH_INITIAL_MINUTES, LIVE_EXTEND_CREDITS, LIVE_EXTEND_MINUTES), `src/lib/creditLedger.ts` (recordLiveWatchAndEarn). API routes under `src/app/api/live/` (start, sessions, [sessionId], [sessionId]/end, join, **extend**, leave, messages).
- **Companion UI:** `src/app/live/go/page.tsx` (go live, stream, **viewer count**, chat, end).
- **Client UI:** `src/app/live/page.tsx` (live list, join, watch with **2 min / extend**, **"Live end" card** when stream ends, chat, leave).
- **Header:** `src/components/layout/Header.tsx` — “Go live” (escort), “Live” (client).

### Key files (1-1 video call)

- **Backend:** `src/lib/credits.ts` (VIDEO_CALL_*), `src/lib/creditLedger.ts` (recordVideoCallAndEarn). API routes under `src/app/api/video-call/` (start, active, [sessionId], [sessionId]/extend, [sessionId]/end).
- **Client:** `src/components/escort/ConnectForm.tsx` (ConnectActions with “Video call” when connected), `src/app/connections/[id]/page.tsx` (“Video call” in chat header), `src/app/video-call/[sessionId]/page.tsx` (in-call UI).
- **Escort:** `src/app/dashboard/page.tsx` (active call banner + “Join call”), `src/app/connections/[id]/page.tsx` (“Join video call” when active call with that client), same in-call page.

### Phase 4 (Polish) — in progress

| Item | Status | Notes |
|------|--------|--------|
| **Moderation** | Done | Report live session: `POST /api/live/[sessionId]/report`; client/companion; admin list at `/admin/reports`. Delete live message: companion only (`DELETE /api/live/[sessionId]/messages/[messageId]`); GET excludes deleted. |
| **Analytics** | Done | Companion: earnings by type on `/dashboard/credits`. Admin: `/admin/analytics` (credits, sessions, reports), `/admin/reports` (reported sessions). |
| **Tips & UI polish** | Done | Generic `POST /api/tips` (contexts: booking, sexter_session, live_session, video_call) with min/max validation and atomic credit transfers plus ledger entries (`tip`, `tip_earned`). Tip button/modal added to: connection chat, sexter chat, live watch, and 1-1 video call. Success animations for tipping and for connection acceptance. Escorts see tip notifications (bell + in-context toasts for live, sexter, booking chat, and 1-1 calls). |
| **Admin tools** | Done | `/api/admin/add-credits` + `/admin/credits` page allow admins to grant credits (type `admin_grant`) to any user for testing; credits history and earnings by type updated accordingly. |
| **WebSocket chat** | Not started | Live, connection, and in-call chat still use REST + polling. |

### Setup and docs

- **LiveKit Cloud setup:** `docs/LiveKit_Cloud_Setup.md` (signup, env, token API, optional test page).
- **Token API:** `POST /api/livekit/token` (generic); live flow uses tokens from `/api/live/start` and `/api/live/[sessionId]/join`.

---

## 1. Overview

| Feature | Description | Who participates |
|--------|-------------|-------------------|
| **Live video** | Companion goes live; clients watch the stream and can send text messages in the live session. | One companion (broadcaster), many clients (viewers + text). |
| **1-1 video chat** | Private video call between one client and one companion, with optional in-call text. | One client, one companion. |

Both features consume credits (client pays; companion earns). The plan assumes the existing credit and companion-discovery flows stay as-is.

---

## 2. Feature 1: Companion Live Video + Client Text

### 2.1 Behavior

- Companion can **start a live session** (video + optional audio).
- Live sessions appear in a **“Live now”** list for clients (e.g. on homepage or a dedicated “Live” page).
- Clients can **join a live session** (watch stream only; no client video).
- Clients in the session can **send text messages** in a live chat; companion sees the chat and can reply by text or verbally.
- Companion can **end the live session**; clients see a **"Live ended"** card and can click "Back to live".
- **Watch time:** First 2 minutes included with join; then **1 credit = 2 more minutes** (extend). Client sees countdown and "Add 2 min (1 credit)" when under 1 min; after expiry can extend to re-join.
- **Viewer count:** Only current watchers (not left) are counted; companion and client both see "X watching".

### 2.2 Key Flows

1. **Companion**
   - Start live → create “live session” record, acquire stream key/URL from streaming infra.
   - See **current viewer count** ("X watching") and live chat.
   - End live → stop stream, close session; **all watching clients see "Live ended" card** (poll detects 410).

2. **Client**
   - Browse “Live now” → see active companions and **current viewer count** per stream.
   - Join a live session (1 credit) → stream starts, **first 2 min** included; chat panel opens.
   - Send text in live chat; see companion’s text replies (and hear verbal replies via stream).
   - **Countdown** and "Add 2 min (1 credit)" when under 1 min; extend to keep watching.
   - Send text in live chat; see companion's text replies (and hear verbal replies via stream).
   - **When companion ends:** client sees **"Live ended"** card with "Back to live"; chat disabled.
   - Leave or session ends → stream and chat UI close; credits as per rules (join + extend).

### 2.3 Data Model (implemented)

- **LiveSession**
  - `id`, `escortId`, `roomName` (unique, used as LiveKit room name), `startedAt`, `endedAt`, `status` (live | ended).
- **LiveSessionViewer**
  - `liveSessionId`, `clientId`, `joinedAt`, `leftAt` (nullable), **`watchExpiresAt`** (nullable; client can watch until this time; extend adds more). Unique on (liveSessionId, clientId); re-join clears `leftAt`. **Viewer count** = count where `leftAt` is null.
- **LiveSessionMessage**
  - `id`, `liveSessionId`, `senderId` (User), `message`, `createdAt`. Sender can be client or companion.

### 2.4 Credits & Earnings (implemented)

- **1 credit to join** (`LIVE_JOIN_CREDITS`); **first 2 minutes** included (`LIVE_WATCH_INITIAL_MINUTES`). Join returns `watchExpiresAt`.
- **Extend:** 1 credit = +2 minutes (`LIVE_EXTEND_CREDITS`, `LIVE_EXTEND_MINUTES`). Client calls `POST /api/live/[sessionId]/extend` when time is low or after expiry (then re-joins without extra charge).
- Companion earns 1 credit per join and per extend; recorded via `recordLiveWatchAndEarn` (types `live_watch`, `live_earned` in `CreditTransaction`).
- Credit history shows “Live stream” for both client usage and companion earnings.

---

## 3. Feature 2: 1-1 Video Chat

### 3.1 Behavior

- Client and companion can start a **private 1-1 video call** (both can send video/audio).
- Only the two participants join; no other viewers.
- Optional **in-call text chat** (e.g. for links, notes) persisted for the session.
- Session is **time-boxed** (1 credit = 2 minutes per block) with option to extend (more credits).
- Either party can **end the call**; the other is notified and the session closes.

### 3.2 Key Flows

1. **Starting a call**
   - Client (or companion) initiates from profile/connection or chat.
   - System checks: connection accepted (or platform rule: “any companion”), sufficient credits.
   - Create **VideoCallSession**; deduct first block of credits; companion earns.
   - Both get a link/room ID and join the same WebRTC/sfu room.

2. **During the call**
   - Video/audio via WebRTC (or managed service).
   - Optional text chat: messages stored with `videoCallSessionId`.
   - Timer shows remaining time; “Extend” button adds time and deducts more credits.

3. **Ending**
   - Either party clicks “End”; session marked ended, credits finalized.
   - If time runs out, session auto-ends; optional short grace period.

### 3.3 Data Model (conceptual)

- **VideoCallSession**
  - `id`, `clientId`, `escortId` (EscortProfile id or userId), `bookingId` (optional, if tied to connection).
  - `startedAt`, `endedAt`, `status` (active | ended).
  - `durationMinutes` or `expiresAt` for time limit; optional `roomId` for provider.
- **VideoCallMessage** (optional in-call text)
  - `id`, `videoCallSessionId`, `senderId`, `message`, `createdAt`.

### 3.4 Credits & Earnings

- **1 credit per 2 minutes** (`VIDEO_CALL_BLOCK_MINUTES`); deduct when companion accepts request and on extend.
- On start: deduct first block; record client debit + companion credit.
- On extend: deduct again; record again.
- Store in `CreditTransaction` with types e.g. `video_call`, `video_call_extend`, `video_call_earned`.

---

## 4. Technical Approach

### 4.1 Streaming (Live Video)

- **Option A — Managed live streaming**
  - Use a provider (e.g. **Mux**, **LiveKit**, **Agora**, **Twilio**) for ingest (companion) and playback (clients).
  - Companion app gets a **stream key / ingest URL**; clients get **playback URL** or HLS/DASH.
  - Backend creates a `LiveSession`, calls provider API to create stream/room; stores `streamId`/`playbackUrl`.
- **Option B — WebRTC-based “live”**
  - One-to-many via SFU (e.g. LiveKit, Janus): companion publishes one stream; many clients subscribe.
  - Same provider can power both “live” and “1-1” with one SDK.

Recommendation: use a **single provider** (e.g. **LiveKit** or **Agora**) for both live and 1-1 to simplify auth, tokens, and billing.

### 4.2 1-1 Video Chat

- **WebRTC** via an SFU or managed service (LiveKit, Agora, Twilio Video, Daily.co).
- Backend:
  - Creates a **room** (or session) and returns **room id**.
  - Issues **short-lived tokens** (JWT) for client and companion so they can join the same room.
- Client and companion UIs use the provider’s SDK (React/JS) to join room, publish/subscribe video and audio.

### 4.3 Real-time Chat (Live + Optional 1-1)

- **Option A** — REST + polling: same as current chat (poll messages every N seconds).
- **Option B** — WebSocket/SSE: one connection per session; push new messages for lower latency and less polling.
- **Option C** — Provider’s data channel (e.g. LiveKit data messages) for in-session only; persist in DB via your API when message is sent.

Recommendation: start with **REST + polling** for live chat and in-call text to reuse existing patterns; add WebSocket or provider data channel in a later phase if needed.

### 4.4 Paid vs free for development

**You do not need to pay for an SDK during development.** Options:

| Option | Cost for development | Notes |
|--------|------------------------|--------|
| **LiveKit Cloud (free tier)** | **$0** — no credit card required | **Build** plan: 5,000 WebRTC minutes/month, 100 concurrent connections. Enough for building and testing live + 1-1 video. SDK is free; you only pay when you exceed free tier or move to Ship ($50/mo) for production. |
| **LiveKit self-hosted** | **$0** | LiveKit server and SDK are **open source**. You can run the media server on your own machine or VM (Docker). No paid SDK; no cloud bill. Good for dev and for avoiding vendor lock-in; you own ops and scaling. |
| **Agora** | **$0** for dev | **10,000 free minutes per month** per account for video/live. Enough for development and early testing. SDK is free; billing applies after free minutes. |
| **Twilio Video** | Free trial credits | Trial credits for testing; then pay-as-you-go. |
| **Mux / Daily.co** | Free tier or trial | Each has limited free usage for getting started. |

**Recommendation for development:**

- **Zero cost:** Use **LiveKit self-hosted** (open-source server + free SDK) or **LiveKit Cloud free tier** (5k minutes, 100 concurrent). No paid SDK required.
- **Minimal setup:** Use **LiveKit Cloud** or **Agora** free tier; both offer free minutes so you can build and demo without paying. Move to a paid plan only when you go to production or exceed the free limits.

**Production:** After launch, you either pay for the provider’s cloud (LiveKit Ship/Scale, Agora beyond free minutes, etc.) or run and maintain self-hosted LiveKit (or another open-source SFU) on your own infrastructure.

---

## 5. API Outline

### 5.1 Live Video

| Method | Endpoint | Purpose |
|--------|----------|--------|
| POST | `/api/live/start` | Companion: start live session; returns stream key/playback URL (or room id). |
| PATCH | `/api/live/[sessionId]/end` | Companion: end session. |
| GET | `/api/live/sessions` | List active live sessions (for “Live now” list). |
| GET | `/api/live/[sessionId]` | Get session details; returns `viewerCount` (current watchers only, `leftAt` null). Returns 410 when session ended. |
| POST | `/api/live/[sessionId]/join` | Client: join (deduct 1 credit), return token + `watchExpiresAt` (first 2 min). Re-join (same viewer, not left) returns token + current `watchExpiresAt` without charging. |
| POST | `/api/live/[sessionId]/extend` | Client: extend watch time (1 credit = +2 min); returns new `watchExpiresAt`. |
| POST | `/api/live/[sessionId]/leave` | Client: leave, set `leftAt` on viewer record. |
| GET | `/api/live/[sessionId]/messages` | Get live chat messages (paginated; excludes deleted). |
| POST | `/api/live/[sessionId]/messages` | Send message (client or companion). |
| DELETE | `/api/live/[sessionId]/messages/[messageId]` | Companion: hide/delete a message (soft delete). |
| POST | `/api/live/[sessionId]/report` | Client or companion: report this session (optional reason); idempotent per user. |
| GET | `/api/live/[sessionId]/tips` | Escort only: list tips earned in this live session (for live tip toasts). |
| POST | `/api/tips` | Client only: generic tip endpoint (contexts: `booking`, `sexter_session`, `live_session`, `video_call`); validates amount, resolves escort, updates balances, records ledger, and creates a `tip` notification. |

### 5.2 1-1 Video Chat

| Method | Endpoint | Purpose |
|--------|----------|--------|
| POST | `/api/video-call/request` | Client: create video call request (body: `escortId`); companion gets notification. No credits deducted yet. |
| GET | `/api/video-call/requests` | List pending/active requests (for client or escort). |
| POST | `/api/video-call/request/[requestId]/accept` | Companion: accept request; credits deducted, session created, client notified. |
| POST | `/api/video-call/request/[requestId]/decline` | Companion: decline request. |
| POST | `/api/video-call/request/[requestId]/cancel` | Client: cancel own pending request. |
| POST | `/api/video-call/start` | Get token for existing active session only (after companion accepted). |
| GET | `/api/video-call/[sessionId]` | Get session + join token for current user. |
| POST | `/api/video-call/[sessionId]/extend` | Extend session; deduct credits again. |
| PATCH | `/api/video-call/[sessionId]/end` | End session (either party). |
| GET | `/api/video-call/[sessionId]/status` | Lightweight status check: `active`, `expired` (time up, waiting for client to extend), or `ended`. Used to control client blur/extend overlay and escort disconnect. |
| GET | `/api/video-call/[sessionId]/tips` | Escort only: list tips earned during this video call (for in-call tip toasts). |
| GET | `/api/video-call/[sessionId]/messages` | Optional in-call text. |
| POST | `/api/video-call/[sessionId]/messages` | Send in-call message. |

Token endpoint can be separate, e.g. `POST /api/video-call/[sessionId]/token` returning a short-lived JWT for the provider.

---

## 6. UI / Pages (High Level)

### 6.1 Live Video

- **Companion**
  - Dashboard: “Go live” button → start flow; “End live” when live.
  - Live studio view: own video preview, **"X watching"** (current viewer count), live chat list, “End stream” button. When ended, all clients see "Live ended" card.
- **Client**
  - “Live” or “Live now” in nav → list of active companions (thumbnail, name, **current viewer count**).
  - Click companion → join (1 credit, 2 min) → playback + countdown + "Add 2 min (1 credit)" when low; chat panel; "Leave". **When companion ends:** "Live ended" card + "Back to live".

### 6.2 1-1 Video Chat

- **Entry points**
  - From connection/chat: “Video call” on companion profile or in chat header.
  - Companion: “Video call” from connection list or chat.
- **In-call UI**
  - Full-screen or large video area; remote party; local preview (optional); timer; “Extend” and “End call” buttons; optional text chat drawer.
  - When the **paid block expires**, the **client** sees the escort video blurred with an overlay prompting them to extend (+2 min, 1 credit) or end; if they do nothing for 30 seconds, the call is automatically ended for both. The **escort** stays in the call UI until the call is explicitly ended or auto-ended.

---

## 7. Implementation Phases

### Phase 1 — Foundation — done

- Provider: **LiveKit Cloud** (free tier); dev account and env vars per `docs/LiveKit_Cloud_Setup.md`.
- Prisma: **LiveSession**, **LiveSessionViewer**, **LiveSessionMessage**, **VideoCallSession** (for future 1-1).
- Backend: token creation via `src/lib/livekit.ts` and `livekit-server-sdk`; session creation in `POST /api/live/start`.

### Phase 2 — Live Video MVP — done

- APIs: start, end, list sessions, join, **extend**, leave, messages (GET/POST) as in section 5.1. Session and list return **viewer count** (current watchers). GET session returns 410 when ended.
- Credits: 1 credit on join (first 2 min); extend 1 credit = +2 min; companion earn on join and extend; `recordLiveWatchAndEarn`; credit history labels for live.
- Companion UI: `/live/go` — Start live, LiveKit room (camera/mic or VOD), **viewer count (“X watching”)**, live chat panel, End live.
- Client UI: `/live` — “Live now” list (with **viewer count**), join (1 credit, 2 min), countdown and extend, watch stream + chat, **“Live ended” card** when companion ends, Leave.
- Chat: REST + polling; stored in `LiveSessionMessage`.

### Phase 3 — 1-1 Video MVP — done

- APIs: **request** (client), **accept/decline/cancel** (companion/client), get token for active session, extend, end (see Implementation status).
- Credits: deduct when companion **accepts** request and on extend (1 credit = 2 min); companion earn (`video_call`, `video_call_extend`, `video_call_earned`).
- Client and companion UI: **consensual flow** — client requests from profile/chat; companion sees request and accepts/declines; in-call view (video + timer + extend + end), optional text.

### Phase 4 — Polish — in progress

- **WebSocket/real-time chat:** Not started; polling remains. Can add WebSocket or LiveKit data channel later.
- **Moderation (done):** Companion can hide/delete any message in live chat (`DELETE /api/live/[sessionId]/messages/[messageId]`); GET messages exclude deleted. Report session: client or companion can report (`POST /api/live/[sessionId]/report`); admin sees at `/admin/reports`.
- **Analytics (done):** Companion Credits earned page shows earnings by type. Admin `/admin/analytics`: platform credits, session counts, reports; `/admin/reports` lists reported sessions.

---

## 8. Credit Constants

**Implemented** in `src/lib/credits.ts`:

```ts
// Live: 1 credit to join; first 2 min included; extend = 1 credit per 2 min.
export const LIVE_JOIN_CREDITS = 1;
export const LIVE_WATCH_INITIAL_MINUTES = 2;
export const LIVE_EXTEND_CREDITS = 1;
export const LIVE_EXTEND_MINUTES = 2;

// 1-1 video: consensual request; 1 credit per 2 min when companion accepts.
export const VIDEO_CALL_CREDITS_PER_BLOCK = 1;
export const VIDEO_CALL_BLOCK_MINUTES = 2;
export const VIDEO_CALL_REQUEST_EXPIRY_MINUTES = 3;
```

Ledger types in `src/lib/creditLedger.ts`: `live_watch`, `live_earned`, `video_call`, `video_call_extend`, `video_call_earned`.

---

## 9. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Cost of streaming/video provider | Start with capped concurrency and time limits; use metered billing and alerts. |
| Abuse (recordings, screenshots) | Terms of use; in-app warnings; consider watermarking or short-lived streams. |
| No show (client or companion doesn’t join) | Auto-end after N minutes if only one party in room; refund policy (e.g. no refund after join). |
| Cross-browser/device issues | Rely on provider’s SDK; test on target browsers and devices. |

---

## 10. Summary

- **Live video (implemented):** Companion streams via LiveKit; clients join (1 credit, first 2 min), extend (1 credit = 2 min), watch and text in a shared chat; companion earns on join and extend. **Viewer count** (current watchers only) shown to companion and client. When companion **ends live**, clients see a **"Live ended"** card and "Back to live". Pages: `/live/go` (companion), `/live` (client). APIs and DB as in section 5.1 and 2.3.
- **1-1 video (implemented):** Private call; time-based credits (1 credit = 2 min) and extend; consensual request flow. Client requests from profile or chat; escort accepts/declines; shared in-call page with LiveKit.
- **Tech:** LiveKit Cloud for live and 1-1 (WebRTC); backend issues tokens, stores sessions; credits and ledger integrated.
- **Phasing:** Phase 1, 2, and 3 done; Phase 4 (polish) — moderation and analytics done; WebSocket for chat deferred.

See **Implementation status** at the top of this document for a quick checklist of what is done and what is not.
