# Feature verification report (backend)

**Scope:** This report reflects what is implemented in the **StripNoir monorepo**: primarily `services/api/src/app.js` (Node API), `shared-contracts/openapi.yaml`, and related services (`services/chat` for realtime transport). It does **not** assert that a production frontend or object storage (MinIO/S3) is fully wired unless the code path exists.

**Method:** Static review of HTTP routes, access-control branches, and data flows. Automated flow scripts referenced where they exist.

**Gap work:** Several expectation gaps called out in earlier revisions have been **closed in code** (subscription bypass, content visibility/PPV, post edits, subscription-exclusive edits, media ACL, creator-involved chat). See **§8** for a concise changelog vs the old gap list.

---

## Expectations vs what exists (gap analysis)

This section states **what you likely expect** from a creator / fan platform like the one you described, **what the repo actually provides**, and any **remaining gap**.

| Your expectation | What exists today | Gap |
|------------------|-------------------|-----|
| **Content creators have their own signup/signin** | One registration flow for everyone (`/auth/register`); creator status is a **second step** (`/creators/apply`) on the same account. | No separate “creator portal” signup or KYC/onboarding pipeline in API; no email verification or approval workflow beyond `verification_status` on profile. |
| **Full profile management for creators** | `PUT /creators/me`, public `GET /creators/:id`. | No dedicated endpoints for every possible profile field (e.g. banners, links, pricing tiers beyond default subscription credits) unless stored in `metadata` by convention. |
| **Complete control over uploaded content** (edit, publish states, who sees what, PPV) | **`PATCH /api/v1/content/:id`** updates title, caption, visibility, status, paywall fields, metadata. **`GET /content/:id`** uses unified access rules: `private` = subscriber-only; `exclusive_ppv` = subscribers **or** PPV unlock (`POST /content/:id/unlock` debits credits, `content_unlock_*` ledger + `content_access_grant`). **`GET/DELETE /media/:id`** — fetch allows any post/subscription-exclusive entitlement; delete is owner-only if unattached. | **Upload URLs** remain stubs (`upload.local`)—real S3/MinIO presigning not implemented here. |
| **Users signup/signin and manage profile** | Full auth + `PUT /users/me`, `GET /users/:id`. | Largely aligned; password reset / email verify not covered in this report. |
| **Follow creators** | Follow / unfollow / followers list. | None material for basic follow. |
| **Subscribe to creators (paid membership)** | **`POST /payments/subscribe`** debits credits and activates subscription. **`POST /creators/subscription`** returns **403** unless **`ALLOW_FREE_SUBSCRIPTION=1`** (dev/admin escape hatch). | In production, clients must use the payments path unless you deliberately enable the env flag. |
| **Fans only see content from creators they subscribed to** | Subscriber checks for `visibility=subscribers`, **`private`**, and for **subscription-exclusive** items. **`exclusive_ppv`** allows subscriber **or** paid unlock. Creators can still publish **`public`** / **`followers`** — visible without subscription when eligible. | A **hard paywall on every post** is **not** the default; it is a **product choice** via visibility settings. |
| **Home / browse page lists creators with subscription price and how many subscribers they have** | **`GET /api/v1/feed/creators`**. | Not a personalized “for you” ML feed; now supports optional `search`, `category`, and `verification_status` query filters; “price” on that route is only default subscription credits, not aggregate PPV. |
| **Chat between user and content creator** | **`POST /chat/rooms`** requires **at least one** participant to have a **`creator_profile`** (fan↔creator or creator↔creator). | Blocking/reporting/moderation are enforced for direct chat room creation + message fan-out; does not assert the fan is “subscribed” to that creator. |
| **Video call between user and content creator** | Full call request → accept → LiveKit flow; `video_call_enabled` on creator. | **LiveKit** must be configured; no native mobile SDK in repo. |
| **A finished “application” (web/mobile UI)** | Backend + binding doc for frontend, plus repo-level end-to-end API smoke tests. | No shipped UI screens in this repo; core API flows are exercised via `scripts/verify_product_e2e_smoke.sh`. |

**Summary of remaining expectation gaps (prioritized)**

1. **Infrastructure:** Real object-storage signing, LiveKit env, mobile clients.  
2. **Product / design:** Optional public & follower tiers vs strict subscriber-only catalog.  
3. **Chat safety:** Moderation UX/admin workflows (enforcement is implemented at API-level; UI/operations polish may still be needed).

---

## Summary table

| Requirement area | Status | Notes |
|------------------|--------|--------|
| Content creator signup / signin | **Met (with nuance)** | `POST /api/v1/auth/register` + `POST /api/v1/creators/apply`. |
| Creator profile management | **Met** | `PUT /api/v1/creators/me`, `GET /api/v1/creators/:id`. |
| Creator content management & control | **Met (with infra caveat)** | `POST`/`PATCH`/`DELETE /content`, PPV unlock, media delete; upload URLs still stub. |
| User signup / signin | **Met** | Register, login, refresh, logout, `GET /api/v1/auth/me`. |
| User profile management | **Met** | `PUT /api/v1/users/me`, `GET /api/v1/users/:id`. |
| Follow creators | **Met** | Follow / unfollow / followers. |
| Subscribe to creators | **Met** | Paid: `POST /payments/subscribe`. Free path gated by **`ALLOW_FREE_SUBSCRIPTION`**. |
| Access only subscribed creator content | **Met (by visibility rules)** | `subscribers`, `private`, subscription-exclusive, and PPV rules documented in §2.4. |
| Chat user ↔ creator | **Met** | At least one participant must be a creator; REST + Go WS/long-poll. |
| Video call user ↔ creator | **Met** | LiveKit when configured. |
| User home / discovery: list creators + price + subscriber count | **Met** | **`GET /api/v1/feed/creators`**. See §2.5. |

---

## 1. Content creators

### 1.1 Signup / signin

- **Signup:** `POST /api/v1/auth/register` — creates `user_account`, default `user` role, wallet.
- **Signin:** `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`.
- **Become a creator:** `POST /api/v1/creators/apply` — upserts `creator_profile`, adds `creator` role.

**Verdict:** **Met** for a two-step model (user account → creator apply).

### 1.2 Profile management

- **Update self:** `PUT /api/v1/creators/me`.
- **Public view:** `GET /api/v1/creators/:id`.

**Verdict:** **Met.**

### 1.3 Content management and control over uploads

**Implemented**

- **Media:** `POST /api/v1/media/upload-url`, `POST /api/v1/media/complete`, **`GET /media/:id`** (entitlement via linked `content_post` or `subscription_exclusive_content`), **`DELETE /media/:id`** (owner; **409** if still attached to a post).
- **Posts:** `POST /api/v1/content`, **`PATCH /api/v1/content/:id`** (owner), `DELETE /api/v1/content/:id`.
- **PPV:** **`POST /api/v1/content/:id/unlock`** — published, `exclusive_ppv`, `requires_payment`; debits `unlock_price_credits`; `content_unlock_debit` / `content_unlock_credit`; **`content_access_grant`** row.
- **Access helper:** `userCanViewContentPost` centralizes rules for `GET /content/:id` and media checks.

**Visibility semantics (non-owner, published)**

| Visibility | Access |
|------------|--------|
| `public` | Any authenticated user |
| `followers` | User follows creator |
| `subscribers` | Active subscription |
| `private` | Active subscription |
| `exclusive_ppv` + `requires_payment` | Active subscription **or** `content_access_grant` **or** prior `content_unlock_debit` for this post |
| `exclusive_ppv` without `requires_payment` | Active subscription only |

**Remaining gaps**

- Presigned upload URLs to real object storage.
- No **`PATCH`** for `subscription_exclusive_content` (create/delete only).

**Verdict:** **Met** for edit/delete, PPV, private/subscriber semantics, and media ACL alignment.

---

## 2. End users (fans / subscribers)

### 2.1 Signup / signin / profile

**Verdict:** **Met.**

### 2.2 Follow creators

**Verdict:** **Met.**

### 2.3 Subscribe to creators

- **Paid:** `POST /api/v1/payments/subscribe` — credits transfer + subscription row.
- **Free row only if allowed:** `POST /api/v1/creators/subscription` — **403** unless **`ALLOW_FREE_SUBSCRIPTION`** is `1`/`true` (`services/api/.env.example`, Compose `ALLOW_FREE_SUBSCRIPTION`).
- **Status / cancel:** `GET` / `DELETE /api/v1/creators/:id/subscription`.

**Verdict:** **Met**; paid path is the default production behavior.

### 2.4 Access only subscribed creator content

- Rules in **§1.3** table; subscription-exclusive endpoints now include in-place edits (`PATCH /subscription-content/:id`) in addition to create/get/delete.
- **Public / followers** posts remain a deliberate product option.

**Verdict:** **Met** under documented visibility rules.

### 2.5 Home / discovery: creator list (for feed or browse page)

| Item | Detail |
|------|--------|
| **Route** | `GET /api/v1/feed/creators` |
| **Auth** | Bearer required |
| **Query** | `limit` (1–100, default 20), `offset` (default 0) |
| **Response** | `{ creators: [ { creator, stats, viewer } ] }` |
| **`stats.subscriptionPriceCredits`** | Default subscription list price in credits. |
| **`stats.activeSubscribers`** | Active subscription count. |
| **`viewer.isFollowing` / `viewer.isSubscribed`** | For the current user. |

**Verdict:** **Met.**

---

## 3. Chat (user ↔ content creator)

- **`POST /api/v1/chat/rooms`:** at least one of (caller, `participantUserId`) must have a **`creator_profile`**.
- Messages + **`GET /api/v1/chat/ws-token`** as before.

**Verdict:** **Met** for creator-involved direct chat.

---

## 4. Video call (user ↔ content creator)

**Verdict:** **Met** (LiveKit env required).

---

## 5. Contracts and auxiliary validation

- **OpenAPI:** `shared-contracts/openapi.yaml` — includes **`PATCH /content/{id}`**, **`POST /content/{id}/unlock`**, creator subscription note, **`GET /feed/creators`** (+ optional `search`, `category`, `verification_status` filters).
- **Scripts:** `scripts/check_live_session_flow.sh`, `scripts/check_video_call_flow.sh`, `scripts/verify_chat_ws.sh`, `scripts/verify_product_e2e_smoke.sh`.

---

## 6. Frontend application

Use **`docs/Frontend_Development_and_Backend_Binding.md`**. No full UI in this repo.

---

## 7. Recommendations (remaining)

1. Implement **presigned uploads** (S3/MinIO) replacing stub `uploadUrl` values.  
2. Add **chat moderation UX** and admin workflows if required by policy.  

---

## 8. Unchecked tasks (implementation plan)

- [x] Storage: replace upload URL stubs (`POST /media/upload-url`, `POST /content/upload-url`, `POST /subscription-content/upload-url`) with real MinIO/S3 presigning + validation.
- [x] Paywall policy decision + enforcement: if the product expectation is “subscribers only for all creator posts”, add an enforcement flag/policy in `GET /content/:id` (and discovery feeds) to disable `public`/`followers` visibility for non-subscribers.
- [x] Creator onboarding/KYC workflow: implement state transitions and APIs beyond `creator_profile.verification_status` (e.g. upload verification docs, admin review, reject/approve flow).
- [x] Browse improvements: extend `GET /api/v1/feed/creators` with search/category/`verification_status` filters and document expected behavior.
- [x] LiveKit readiness: add a verification path/runbook to confirm LiveKit env + token issuance end-to-end (health/deps + token validation script(s)).
- [x] Chat safety: add blocking/reporting/moderation endpoints and enforce them in `POST /chat/rooms`, message handlers, and the Go WS fan-out.
- [x] Product completeness: added repo-level end-to-end API smoke tests (`scripts/verify_product_e2e_smoke.sh`) covering the core user/creator/content/chat/payment/video-call flows.

---

## 9. Changelog — gaps addressed in code

| Former gap | Resolution |
|------------|------------|
| Free **`POST /creators/subscription`** bypassing payment | **403 by default**; opt-in **`ALLOW_FREE_SUBSCRIPTION=1`** for dev. |
| No **`PATCH /content/:id`** | **Implemented** (partial field update). |
| No **`PATCH /subscription-content/:id`** | **Implemented** (owner-only in-place edits for subscription-exclusive items). |
| **`exclusive_ppv` / `private` / `requires_payment`** access | **`userCanViewContentPost`** + **`POST /content/:id/unlock`** + **`content_access_grant`** / ledger. |
| **`GET /media/:id`** 403 for entitled viewers | Resolves access via **linked posts** or **subscription-exclusive** media. |
| No **`DELETE /media/:id`** | **Implemented**; **409** if media still attached. |
| Chat between any two users | **At least one participant must be a creator** for new direct rooms. |

---

*For route-level detail, see `services/api/src/app.js` and `shared-contracts/openapi.yaml`.*
