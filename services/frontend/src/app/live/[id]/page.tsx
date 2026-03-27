"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { apiGet, apiPost } from "../../../lib/apiClient";
import { trackEvent } from "../../../lib/analytics";
import { subscribeRoomWebSocket } from "../../../lib/roomWebSocketHub";
import LiveKitViewer, { type LiveKitCredentials } from "../../../components/live/LiveKitViewer";
import Button from "../../../components/ui/Button";
import { Card, CardHeader } from "../../../components/ui/Card";
import Avatar from "../../../components/ui/Avatar";
import { displayableMediaUrl } from "../../../lib/publicMediaUrl";

type LiveStream = {
  id: string;
  roomId: string | null;
  livekitRoomName?: string | null;
  title: string;
  description?: string | null;
  streamThumbnailUrl?: string | null;
  startedAt?: string | null;
  creator?: {
    displayName?: string | null;
    stageName?: string | null;
    username?: string | null;
    avatarUrl?: string | null;
  };
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
  const startedMs = stream?.startedAt ? Date.parse(stream.startedAt) : NaN;
  const elapsedMin = Number.isFinite(startedMs) ? Math.max(0, Math.floor((nowMs - startedMs) / 60000)) : null;
  const creatorName =
    stream?.creator?.displayName || stream?.creator?.stageName || stream?.creator?.username || "Creator";
  const thumb = stream?.streamThumbnailUrl?.trim();
  const thumbSrc = thumb ? displayableMediaUrl(thumb) || thumb : null;

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
                <div className="flex items-start gap-3">
                  <Avatar name={creatorName} src={stream.creator?.avatarUrl || undefined} size={42} />
                  <div>
                    <div className="text-sm font-bold text-muted">{creatorName}</div>
                    <div className="text-xl font-black text-text">{stream.title}</div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted">
                      <span>{activeViewers} active viewers</span>
                      <span>·</span>
                      <span>{(stream.baseJoinPriceCredits ?? 0) > 0 ? `${stream.baseJoinPriceCredits} credits to watch` : "Free to watch"}</span>
                      {elapsedMin != null ? (
                        <>
                          <span>·</span>
                          <span>Live for {elapsedMin}m</span>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div>
                  {thumbSrc ? (
                    <img src={thumbSrc} alt="live thumbnail" className="h-20 w-32 rounded-lg object-cover border border-border" />
                  ) : null}
                </div>
                <div className="w-full">
                  {stream.description ? <div className="mt-1 text-muted">{stream.description}</div> : null}
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

          <div className="space-y-4">
            {showLiveKitUnavailable ? (
              <div className="rounded-xl border border-border bg-surface2 p-4 text-muted">
                <div className="font-black text-warning">Video unavailable</div>
                <p className="mt-1 text-sm">Live video is temporarily unavailable for this session.</p>
              </div>
            ) : null}
            {livekit?.url && livekit?.token ? (
              <LiveKitViewer
                livekit={livekit}
                showPublisherControls={isHost}
                notConfiguredMessage="Live video is currently unavailable."
              />
            ) : isHost && realtimeActive && (!livekit?.url || !livekit?.token) ? (
              <LiveKitViewer
                livekit={{ url: "", token: "", roomName: stream.livekitRoomName || "" }}
                showPublisherControls
                notConfiguredMessage="Live video is currently unavailable."
              />
            ) : !realtimeActive ? (
              <div className="rounded-xl border border-dashed border-border bg-surface2 p-6 text-center text-muted">
                Join session to start watching.
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
