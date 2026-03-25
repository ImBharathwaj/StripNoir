# Phase 6: High-load extraction (Go internal APIs)

This phase adds **opt-in** delegation from the Node API to the Go chat service for measured hot paths. Defaults keep Node as the only writer for chat history and unchanged stream responses unless env flags are set.

## 1. Chat history

Go registers internal routes when `DATABASE_URL` is set (`services/chat/cmd/main.go`):

| Method | Path |
|--------|------|
| GET | `/internal/history/rooms/{roomId}/messages` |
| POST | `/internal/history/rooms/{roomId}/messages` |
| PATCH | `/internal/history/rooms/{roomId}/messages/{messageId}` |
| DELETE | `/internal/history/rooms/{roomId}/messages/{messageId}` |

- **Auth:** `x-internal-key` (if `CHAT_INTERNAL_API_KEY` is set) and **`X-Delegate-User-Id`** (Node sets this to the JWT `sub` after `authRequired`).
- **Node flags:** `CHAT_HISTORY_DELEGATE=1` — forward the matching public `/api/v1/chat/rooms/:id/messages` traffic to Go and return its status/body (Go publishes Redis chat events; Node does not double-publish).
- **Shadow:** `CHAT_HISTORY_SHADOW=1` with delegate **off** — Node serves from Postgres, then `setImmediate` compares message **count** with Go GET (warnings in API logs on mismatch).

Set the same `CHAT_INTERNAL_API_KEY` on API and chat in Compose or K8s.

## 2. Live session aggregate

- **Go:** `GET /internal/live/sessions/{sessionId}/aggregate` — DB active viewer count + Redis WS presence `SCARD` for the session’s `room_id`.
- **Node:** `LIVE_AGGREGATE_DELEGATE=1` — `GET /api/v1/streams/:id` adds `stream.stats.wsViewerConnections` and `stream.stats.aggregateSource`. `activeViewers` remains the Node SQL value (billing authority).

## 3. Ledger

Go exposes `GET /internal/ledger/health` and `POST /internal/ledger/transfer` (501 stub). **Do not** point production traffic here; wallet/ledger stays in Node.

## 4. Rollout checklist

1. Deploy chat with `DATABASE_URL` + Redis; verify `GET /health/deps` on chat.
2. Set `CHAT_INTERNAL_API_KEY` on both services.
3. Enable `CHAT_HISTORY_SHADOW=1` in staging; watch for `[chat-history-shadow]` warnings.
4. Enable `CHAT_HISTORY_DELEGATE=1` for a canary; monitor error rate and Redis fan-out.
5. Optionally enable `LIVE_AGGREGATE_DELEGATE=1` and validate UI/analytics that consume `stats`.

## 5. Metrics and regression gates (exit criteria)

**Cost / p95 (staging):** With `METRICS_ENABLED=1`, scrape Node `GET /metrics` or `GET /metrics.json` and Go chat `GET /metrics` before and after enabling `CHAT_HISTORY_DELEGATE` / `LIVE_AGGREGATE_DELEGATE`. Compare `stripnoir_*_http_request_duration_ms_*` (or Prometheus `histogram_quantile`) on the routes you care about. Improvement targets are environment-specific; the gate is *documented measurement*, not a fixed number in-repo.

**Critical regressions:** Keep delegation **off** by default. Use `CHAT_HISTORY_SHADOW` first, then canary `CHAT_HISTORY_DELEGATE`. Abort if error rate spikes, shadow count mismatches persist, or wallet/chat semantics diverge from baseline. Record a short sign-off per cutover window (who enabled what, when, metrics snapshot).

## 6. References

- Contract: `shared-contracts/internal-contracts.md`
- Plan: `docs/Phase_Based_Development_Plan_Node_Go.md` — Phase 6
