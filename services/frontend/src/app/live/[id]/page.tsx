"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { apiGet, apiPost } from "../../../lib/apiClient";
import { trackEvent } from "../../../lib/analytics";
import { subscribeRoomWebSocket } from "../../../lib/roomWebSocketHub";
import LiveKitViewer, { type LiveKitCredentials } from "../../../components/live/LiveKitViewer";
import Button from "../../../components/ui/Button";
import { Card, CardBody, CardHeader } from "../../../components/ui/Card";
import Badge from "../../../components/ui/Badge";

type LiveStream = {
  id: string;
  roomId: string | null;
  livekitRoomName?: string | null;
  title: string;
  description?: string | null;
  status: string;
  baseJoinPriceCredits?: number;
  extendPriceCredits?: number;
  extendDurationSeconds?: number;
  stats: {
    activeViewers: number;
    wsViewerConnections?: number;
    aggregateSource?: string;
  };
};

type ChatEvent = {
  eventType?: string;
  payload?: any;
};

type TipEntry = {
  id: string;
  fromUserId: string;
  creatorUserId: string;
  amountCredits: number;
  at: number;
};

function readWatchExpires(viewer: any): string | null {
  if (!viewer) return null;
  const v = viewer.watch_expires_at ?? viewer.watchExpiresAt;
  return v ? String(v) : null;
}

export default function LiveDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = String((params as any).id || "");

  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [stream, setStream] = useState<LiveStream | null>(null);
  /** Viewer paid / active in session */
  const [viewerJoined, setViewerJoined] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [livekit, setLivekit] = useState<LiveKitCredentials | null>(null);

  const realtimeActive = viewerJoined || isHost;

  const [activeViewers, setActiveViewers] = useState<number>(0);
  const [wsPresenceCount, setWsPresenceCount] = useState<number | null>(null);
  const [tips, setTips] = useState<TipEntry[]>([]);
  const [watchExpiresAt, setWatchExpiresAt] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [extendBusy, setExtendBusy] = useState(false);

  useEffect(() => {
    tickRef.current = setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setBusy(true);
      setError(null);
      try {
        const data = await apiGet<{ stream: LiveStream }>(`/streams/${encodeURIComponent(id)}`);
        if (cancelled) return;
        setStream(data.stream || null);
        setActiveViewers(data.stream?.stats?.activeViewers ?? 0);
        const wsC = data.stream?.stats?.wsViewerConnections;
        if (typeof wsC === "number") setWsPresenceCount(wsC);
      } catch (err: any) {
        if (err?.status === 401 || err?.message === "not authenticated") {
          router.replace("/login");
          return;
        }
        if (!cancelled) setError(err?.body?.error || err?.message || "failed to load live session");
      } finally {
        if (!cancelled) setBusy(false);
      }
    }

    if (id) run();
    return () => {
      cancelled = true;
    };
  }, [id, router]);

  useEffect(() => {
    const roomId = stream?.roomId;
    if (!realtimeActive || !roomId) return;

    return subscribeRoomWebSocket(String(roomId), {
      onMessage: (ev) => {
        try {
          const evt: ChatEvent = JSON.parse(ev.data);
          const t = evt.eventType;
          if (!t) return;

          if (t === "live.viewer.joined") {
            setActiveViewers((v) => v + 1);
          } else if (t === "live.viewer.extended") {
            const p = evt.payload || {};
            const exp = p.watchExpiresAt ?? p.watch_expires_at;
            if (exp) setWatchExpiresAt(String(exp));
          } else if (t === "live.ws_presence") {
            const p = evt.payload || {};
            if (typeof p.wsViewerCount === "number") {
              setWsPresenceCount(p.wsViewerCount);
            }
          } else if (t === "tip.received") {
            const p = evt.payload || {};
            if (p.fromUserId && p.creatorUserId) {
              const entry: TipEntry = {
                id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                fromUserId: String(p.fromUserId),
                creatorUserId: String(p.creatorUserId),
                amountCredits: Number(p.amountCredits || 0),
                at: Date.now()
              };
              setTips((prev) => [entry, ...prev].slice(0, 20));
            }
          } else if (t === "live.ended") {
            setActiveViewers((v) => Math.max(0, v - 1));
          }
        } catch {
          // ignore malformed events
        }
      }
    });
  }, [realtimeActive, stream?.roomId]);

  async function onJoin() {
    if (!id) return;
    setError(null);
    setBusy(true);
    try {
      const data = await apiPost<any>(`/streams/${encodeURIComponent(id)}/join`, undefined);
      const livekitCreds: LiveKitCredentials | null = data?.livekit || null;
      const role = data?.role;

      setStream(data?.stream || stream);
      setViewerJoined(Boolean(data?.joined));
      setIsHost(role === "host");
      if (data?.stream?.stats?.activeViewers !== undefined) setActiveViewers(data.stream.stats.activeViewers);
      setLivekit(livekitCreds);

      const exp = readWatchExpires(data?.viewer);
      if (exp) setWatchExpiresAt(exp);
      trackEvent("join_live", {
        streamId: id,
        role: role === "host" ? "host" : "viewer",
        joined: Boolean(data?.joined)
      });
    } catch (err: any) {
      if (err?.status === 401 || err?.message === "not authenticated") {
        router.replace("/login");
        return;
      }
      if (err?.status === 402) {
        setError("Insufficient credits to join. Add credits in your wallet and try again.");
        return;
      }
      setError(err?.body?.error || err?.message || "failed to join live session");
    } finally {
      setBusy(false);
    }
  }

  async function onExtend() {
    if (!id) return;
    setExtendBusy(true);
    setError(null);
    try {
      const data = await apiPost<any>(`/streams/${encodeURIComponent(id)}/extend`, undefined);
      const exp = readWatchExpires(data?.viewer);
      if (exp) setWatchExpiresAt(exp);
    } catch (err: any) {
      if (err?.status === 401 || err?.message === "not authenticated") {
        router.replace("/login");
        return;
      }
      if (err?.status === 402) {
        setError("Insufficient credits to extend. Deposit in wallet and try again.");
        return;
      }
      setError(err?.body?.error || err?.message || "failed to extend");
    } finally {
      setExtendBusy(false);
    }
  }

  const expiresMs = watchExpiresAt ? Date.parse(watchExpiresAt) : NaN;
  const secondsLeft = Number.isFinite(expiresMs) ? Math.max(0, Math.floor((expiresMs - nowMs) / 1000)) : null;
  const fmtCountdown = secondsLeft == null ? "—" : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`;

  const showLiveKitUnavailable = realtimeActive && !isHost && !livekit?.url;

  return (
    <div className="py-4">
      <h1>Live session</h1>
      {error ? <div className="mt-3 font-bold text-danger">{error}</div> : null}
      {error?.toLowerCase().includes("insufficient credits") ? (
        <Link href="/wallet" className="mt-2 inline-block text-sm text-accent underline">
          Open wallet to deposit credits
        </Link>
      ) : null}

      {busy && !stream ? <div className="mt-2 text-muted">Loading…</div> : null}

      {stream ? (
        <div className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xl font-black text-text">{stream.title}</div>
                  {stream.description ? <div className="mt-1 text-muted">{stream.description}</div> : null}
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted">
                    <span>{activeViewers} active viewers (session)</span>
                    {wsPresenceCount != null ? (
                      <span>
                        · {wsPresenceCount} WS presence{stream.stats?.aggregateSource ? ` (${stream.stats.aggregateSource})` : ""}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-col items-stretch gap-2 sm:items-end">
                  {!isHost && viewerJoined && secondsLeft != null ? (
                    <div className="rounded-lg border border-border bg-surface2 px-3 py-2 text-right">
                      <div className="text-xs text-muted">Watch time remaining</div>
                      <div className="font-mono text-lg font-black text-text">{fmtCountdown}</div>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={onJoin}
                      disabled={busy || viewerJoined || isHost}
                      variant="primary"
                      size="sm"
                    >
                      {isHost ? "Hosting" : viewerJoined ? "Joined" : busy ? "Joining…" : "Join live"}
                    </Button>
                    {!isHost && viewerJoined ? (
                      <Button onClick={onExtend} disabled={extendBusy} variant="secondary" size="sm">
                        {extendBusy
                          ? "Extending…"
                          : `Extend (+${stream.extendPriceCredits ?? 0} credits / ${stream.extendDurationSeconds ?? 0}s)`}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            </CardHeader>
          </Card>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2 space-y-4">
              {showLiveKitUnavailable ? (
                <div className="rounded-xl border border-border bg-surface2 p-4 text-muted">
                  <div className="font-black text-warning">LiveKit unavailable (503)</div>
                  <p className="mt-1 text-sm">
                    The server does not have LiveKit configured or did not return viewer credentials. You can still use realtime
                    chat/events for this room when connected; video requires LiveKit on the backend.
                  </p>
                </div>
              ) : null}
              {livekit?.url && livekit?.token ? (
                <LiveKitViewer
                  livekit={livekit}
                  showPublisherControls={isHost}
                  notConfiguredMessage="LiveKit is not configured on the server. Video playback is unavailable."
                />
              ) : isHost && realtimeActive && (!livekit?.url || !livekit?.token) ? (
                <LiveKitViewer
                  livekit={{ url: "", token: "", roomName: stream.livekitRoomName || "" }}
                  showPublisherControls
                  notConfiguredMessage="LiveKit is not configured. Host preview cannot start until the server exposes LiveKit URL and token."
                />
              ) : !realtimeActive ? (
                <div className="rounded-xl border border-dashed border-border bg-surface2 p-6 text-center text-muted">
                  Join the session to load the video player and start your watch window.
                </div>
              ) : null}
            </div>

            <Card>
              <CardHeader>
                <div className="font-black text-text">Tips</div>
                <div className="text-xs text-muted">Recent tip.received events from the room</div>
              </CardHeader>
              <CardBody>
                {tips.length === 0 ? <div className="text-sm text-muted">No tips yet.</div> : null}
                <ul className="max-h-64 space-y-2 overflow-y-auto text-sm">
                  {tips.map((t) => (
                    <li key={t.id} className="rounded-lg border border-border bg-bg px-2 py-1.5">
                      <Badge variant="warning">{t.amountCredits} credits</Badge>
                      <span className="ml-2 text-muted">
                        {new Date(t.at).toLocaleTimeString()} · from {t.fromUserId.slice(0, 8)}…
                      </span>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          </div>
        </div>
      ) : null}
    </div>
  );
}
