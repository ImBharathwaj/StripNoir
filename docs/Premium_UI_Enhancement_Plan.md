## Premium UI enhancement plan (StripNoir)

**Goal:** Evolve the current Next.js UI in `services/frontend/` into a **premium video platform** experience (creator discovery → paywall → playback/live/calls → retention), while staying aligned with the existing Node + Go backend and nginx gateway routing.

**Non-goals (for this plan):**
- Backend feature changes (except where explicitly called out as “backend follow-up”).
- Native mobile apps.

**Current UI baseline (already implemented):**
- Auth (F0), profiles/feeds/content (F1), wallet/payments basics (F2), DM chat (F3), notifications (F4), live + LiveKit viewer (F5), video calls + LiveKit (F6), basic offline + 429 handling + GET dedupe (F7).

---

## 0. Product quality bar (what “premium” means)

- **Performance**: fast navigation, minimal layout shift, responsive streaming pages, resilient realtime.
- **Polish**: consistent typography/colors, modern card layouts, subtle motion, skeleton loading, empty states.
- **Trust & safety**: clear paywalls, verified creator badges, report/block flows, admin-friendly moderation UX later.
- **Monetization UX**: transparent pricing, wallet-first flows, frictionless unlock/subscribe.
- **Accessibility**: keyboard + screen-reader-friendly, color contrast, focus states.

---

## 1. Design system + UI foundation (P0)

### 1.1 Introduce a real styling system
- [x] Add **Tailwind CSS** (or CSS Modules + tokens) for consistent layouts, spacing, and theme.
- [x] Define design tokens:
  - [x] colors (background, surfaces, borders, text, accent, danger, warning)
  - [x] typography scale + font weights
  - [x] radius, elevation, spacing scale
- [x] Add shared components:
  - [x] `Button`
  - [x] `Input`, `Card`, `Badge`, `Toast`, `Skeleton`
  - [x] `Avatar`, `CreatorBadge` (verification), `PriceTag`

### 1.2 Navigation and layout polish
- [x] Upgrade `TopNav` to a premium header:
  - [x] responsive layout (mobile hamburger)
  - [x] auth state (profile dropdown)
  - [x] notification bell with unread count (from REST + realtime)
- [x] Add route-level loading skeletons (app router `loading.tsx` where useful).
- [x] Add a global error boundary page (`error.tsx`) with helpful CTA.

---

## 2. Premium discovery + creator browsing (P0)

### 2.1 “Home” discovery experience
- [x] Replace plain creator feed with a **premium discovery page**:
  - [x] search bar (wire to `GET /api/v1/feed/creators?search=...`)
  - [x] chips for `category` and `verification_status`
  - [x] rich creator cards: avatar, name, stage name, subscriber count, default price, category tags
  - [x] follow CTA + “Subscribed” state

### 2.2 Creator profile page (premium)
- [x] Add a “hero” section:
  - [x] avatar + display name + verification badge
  - [x] pricing + subscribe CTA + follow CTA
  - [x] about + category tags
- [x] Add creator content tabs:
  - [x] Posts / PPV / Subscriber-only catalog (depending on backend catalog endpoints you expose)
- **Backend follow-up (optional)**:
  - [x] add a creator content list endpoint (e.g. `/api/v1/creators/:id/content`) if not already present.

---

## 3. Premium paywalls + entitlements (P0)

### 3.1 Subscription UX
- [x] Subscribe flow should show:
  - [x] price in credits, renewal note, “what you get”
  - [x] “insufficient credits” path → wallet deposit CTA
- [x] Better subscribe button behavior:
  - [x] optimistic UI + disabled states + clear errors

### 3.2 PPV unlock UX
- [x] On `content/[id]`:
  - [x] if `exclusive_ppv` and `requiresPayment`, show a premium paywall card
  - [x] show unlock price + wallet balance snapshot
  - [x] “Unlock” button calls `POST /api/v1/content/:id/unlock`
  - [x] handle `402` (insufficient credits) → wallet deposit CTA

---

## 4. Video playback experience (P1)

### 4.1 Media rendering
- [x] Render media previews and playback UI (image/video) from API media objects.
- [x] Progressive loading + blur-up placeholders.
- [x] Fullscreen + theater mode (desktop).

### 4.2 Creator timeline / feed polish
- [x] Enhance feed cards:
  - [x] creator header + timestamp
  - [x] content preview media grid
  - [x] locked badge and price when paywalled

---

## 5. Live streaming UX (P1)

### 5.1 Live list + live detail improvements
- [x] Live list:
  - [x] “LIVE” badges, viewer counts, thumbnails
  - [x] category filtering
- [x] Live detail:
  - [x] room presence indicator (use `live.ws_presence`)
  - [x] tips panel (surface `tip.received` events)
  - [x] “Join” + “Extend” UX with countdown to `watchExpiresAt` (from join/extend responses)

### 5.2 LiveKit viewer polish
- [x] Provide explicit audio/video controls and reconnect status.
- [x] Handle LiveKit not configured (`503`) with a friendly message.

---

## 6. Premium DM chat UX (P1)

- [x] Room list should show:
  - [x] other participant identity (name + avatar)
  - [x] last message preview + unread indicator (requires backend read state / room summary)
- [x] Chat thread:
  - [x] message bubbles, timestamps, edited/deleted rendering
  - [x] “report message” flow (`POST /api/v1/chat/rooms/:id/messages/:messageId/report`)
  - [x] “block user” flow (`POST /api/v1/users/:id/block`) from the chat UI
- **Backend follow-up (optional)**:
  - [x] add a room summary endpoint returning “other participant” profile + last message + unread count.

---

## 7. Video calls UX (P1)

- [x] Calls page:
  - [x] show call requests with participant display names
  - [x] accept/decline with clearer pricing (creditsPerBlock + duration)
- [x] Call detail:
  - [x] show call timer / expiry countdown (from `expires_at` in call payload)
  - [x] extend CTA only for client (backend enforces)
  - [x] room events log for `call.*`

---

## 8. Notifications UX (P2)

- [x] Toast notifications on `notification.created` realtime events.
- [x] Notification types with icons and deep-links.
- [x] “Mark read” batch UX.

---

## 9. Performance + reliability hardening (P2)

- [x] Add reconnection/backoff logic for chat/live/call websockets.
- [x] Centralize websocket manager(s) to avoid duplicate connections:
  - [x] one notify WS per user
  - [x] one room WS per active room (chat/live/call)
- [x] Add request caching + revalidation patterns (Next app router best practices).
- [x] Add image optimization strategy (Next `<Image>` + remote patterns if needed).

---

## 10. Analytics + UX instrumentation (P2)

- [x] Track key funnel events (frontend only, initially console/log):
  - [x] view creator
  - [x] click subscribe
  - [x] deposit credits
  - [x] unlock PPV
  - [x] join live
  - [x] start call / join call / extend call
- [x] Add lightweight performance markers (navigation timing, WS connect time).

---

## 11. Accessibility + compliance (P2)

- [x] Keyboard navigation for all forms and CTAs.
- [x] Focus outlines and skip-to-content link.
- [x] Color contrast checks.
- [x] Screen-reader labels for controls and LiveKit UI.

---

## Suggested implementation order (fastest premium impact)

1. **Design system + nav polish** (P0)
2. **Discovery + creator pages** (P0)
3. **Paywalls + wallet/credits UX** (P0)
4. **Media playback polish** (P1)
5. **Live + calls UI polish** (P1)
6. **Chat UX + safety actions** (P1)
7. **Notifications toast + deep links** (P2)
8. **Perf/analytics/accessibility hardening** (P2)

---

## 12. Post-plan polish (stretch)

- [x] Align legacy **wallet** + **auth** routes (`/wallet`, `/login`, `/register`, `/register/user`, `/register/creator`) with the shared **Tailwind + Card/Input/Button** design system.
- [x] Respect **`prefers-reduced-motion`** for transitions and animations (global CSS).

