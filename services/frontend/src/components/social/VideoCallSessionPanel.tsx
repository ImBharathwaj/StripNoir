"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../../lib/apiClient";
import { trackEvent } from "../../lib/analytics";
import { subscribeRoomWebSocket } from "../../lib/roomWebSocketHub";
import LiveKitViewer, { type LiveKitCredentials } from "../live/LiveKitViewer";
import Button from "../ui/Button";
import { Card, CardBody, CardHeader } from "../ui/Card";
import Badge from "../ui/Badge";
import Avatar from "../ui/Avatar";

type Call = {
  id: string;
  requestId?: string;
  roomId: string | null;
  status: string;
  clientUserId: string;
  creatorId: string;
  creatorUserId: string;
  livekitRoomName: string | null;
  expiresAt?: string | null;
  startedAt?: string | null;
  creditsPerBlock?: number;
  blockDurationSeconds?: number;
  totalBilledCredits?: number;
  creator?: {
    displayName?: string;
    stageName?: string;
    username?: string;
  };
};

type ChatWsEvent = {
  eventType?: string;
  payload?: any;
};

type LogEntry = { at: string; type: string; detail?: string };

type Props = {
  callId: string;
  title?: string;
  onEnded?: () => void;
};

function fmtDuration(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

export default function VideoCallSessionPanel({ callId, title = "1:1 video call", onEnded }: Props) {
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [meUserId, setMeUserId] = useState<string | null>(null);
  const [call, setCall] = useState<Call | null>(null);
  const [clientLabel, setClientLabel] = useState<{ name: string; sub: string; avatarUrl?: string } | null>(null);
  const [livekit, setLivekit] = useState<LiveKitCredentials | null>(null);
  const [viewerCount, setViewerCount] = useState<number>(0);
  const [eventLog, setEventLog] = useState<LogEntry[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const isClient = Boolean(meUserId && call && call.clientUserId === meUserId);
  const isCreator = Boolean(meUserId && call && call.creatorUserId === meUserId);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!callId) return;
    let cancelled = false;

    async function run() {
      setBusy(true);
      setError(null);
      try {
        const [callData, meData] = await Promise.all([
          apiGet<{ call: Call }>(`/calls/${encodeURIComponent(callId)}`),
          apiGet<{ user: { id: string } }>("/auth/me")
        ]);
        if (cancelled) return;

        const nextCall = callData.call || null;
        setCall(nextCall);
        setMeUserId(meData?.user?.id || null);

        if (nextCall?.creatorUserId && meData?.user?.id === nextCall.creatorUserId && nextCall.clientUserId) {
          try {
            const userData = await apiGet<{
              user?: { displayName?: string; username?: string; avatarUrl?: string | null };
            }>(`/users/${nextCall.clientUserId}`);
            const usr = userData.user;
            if (!cancelled && usr) {
              setClientLabel({
                name: usr.displayName || usr.username || nextCall.clientUserId,
                sub: usr.username ? `@${usr.username}` : `${nextCall.clientUserId.slice(0, 8)}…`,
                avatarUrl: usr.avatarUrl || undefined
              });
            }
          } catch {
            if (!cancelled) setClientLabel(null);
          }
        } else if (!cancelled) {
          setClientLabel(null);
        }
      } catch (err: any) {
        if (!cancelled) setError(err?.body?.error || err?.message || "failed to fetch call");
      } finally {
        if (!cancelled) setBusy(false);
      }
    }

    run();

    return () => {
      cancelled = true;
    };
  }, [callId]);

  useEffect(() => {
    const roomId = call?.roomId;
    if (!roomId) return;

    return subscribeRoomWebSocket(String(roomId), {
      onMessage: (ev) => {
        try {
          const evt: ChatWsEvent = JSON.parse(ev.data);
          const eventType = evt.eventType;
          if (!eventType) return;

          if (eventType === "live.ws_presence") {
            const count = Number(evt?.payload?.wsViewerCount ?? 0);
            setViewerCount(Number.isFinite(count) ? count : 0);
            return;
          }

          if (eventType.startsWith("call.")) {
            let detail: string | undefined;
            try {
              const raw = JSON.stringify(evt.payload ?? {});
              detail = raw.length > 180 ? `${raw.slice(0, 180)}...` : raw;
            } catch {
              detail = undefined;
            }

            setEventLog((prev) => [{ at: new Date().toISOString(), type: eventType, detail }, ...prev].slice(0, 40));
          }
        } catch {
          // ignore
        }
      }
    });
  }, [call?.roomId]);

  async function onJoin() {
    setError(null);
    setBusy(true);
    try {
      const data = await apiPost<any>(`/calls/${encodeURIComponent(callId)}/join`, undefined);
      setCall(data?.call || call);
      if (data?.livekit) setLivekit(data.livekit);
    } catch (err: any) {
      if (err?.status === 402) {
        setError("Insufficient credits to join or extend this call.");
        return;
      }
      setError(err?.body?.error || err?.message || "failed to join call");
    } finally {
      setBusy(false);
    }
  }

  async function onExtend() {
    setError(null);
    setBusy(true);
    try {
      const data = await apiPost<any>(`/calls/${encodeURIComponent(callId)}/extend`, undefined);
      setCall(data?.call || call);
      trackEvent("extend_call", { callId });
    } catch (err: any) {
      if (err?.status === 402) {
        setError("Insufficient credits to extend.");
        return;
      }
      setError(err?.body?.error || err?.message || "failed to extend call");
    } finally {
      setBusy(false);
    }
  }

  async function onEnd() {
    setError(null);
    setBusy(true);
    try {
      await apiPost<any>(`/calls/${encodeURIComponent(callId)}/end`, undefined);
      onEnded?.();
    } catch (err: any) {
      setError(err?.body?.error || err?.message || "failed to end call");
      setBusy(false);
    }
  }

  const expiresMs = call?.expiresAt ? Date.parse(call.expiresAt) : NaN;
  const expiresLeftSec = Number.isFinite(expiresMs) ? Math.max(0, (expiresMs - nowMs) / 1000) : null;
  const startedMs = call?.startedAt ? Date.parse(call.startedAt) : NaN;
  const sessionElapsedSec =
    Number.isFinite(startedMs) && call?.status === "active" ? Math.max(0, (nowMs - startedMs) / 1000) : null;
  const canExtend = isClient && call?.status === "active";

  return (
    <div className="space-y-4">
      {error ? <div className="font-bold text-danger">{error}</div> : null}
      {error?.toLowerCase().includes("insufficient credits") ? (
        <a href="/wallet" className="inline-block text-sm text-accent underline">
          Open wallet
        </a>
      ) : null}
      {busy && !call ? <div className="text-muted">Loading call...</div> : null}

      {call ? (
        <>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="text-lg font-black text-text">{title}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Badge>{call.status}</Badge>
                    {isClient ? <Badge variant="accent">You are the client</Badge> : null}
                    {isCreator ? <Badge variant="warning">You are the creator</Badge> : null}
                  </div>
                  <div className="mt-3 grid gap-2 text-sm text-muted sm:grid-cols-2">
                    <div>
                      Billing:{" "}
                      <span className="font-bold text-text">
                        {call.creditsPerBlock ?? "—"} credits / {call.blockDurationSeconds ?? "—"}s block
                      </span>
                    </div>
                    <div>
                      Billed so far: <span className="font-bold text-text">{call.totalBilledCredits ?? 0}</span> credits
                    </div>
                    <div>1:1 room: {call.roomId || "—"}</div>
                    <div>WS presence connections: {viewerCount}</div>
                  </div>
                </div>

                <div className="flex min-w-[200px] flex-col gap-2">
                  {sessionElapsedSec != null ? (
                    <div className="rounded-lg border border-border bg-surface2 px-3 py-2">
                      <div className="text-xs text-muted">Session time</div>
                      <div className="font-mono text-xl font-black text-text">{fmtDuration(sessionElapsedSec)}</div>
                    </div>
                  ) : null}
                  {expiresLeftSec != null ? (
                    <div className="rounded-lg border border-border bg-surface2 px-3 py-2">
                      <div className="text-xs text-muted">Expires in</div>
                      <div className="font-mono text-xl font-black text-text">{fmtDuration(expiresLeftSec)}</div>
                    </div>
                  ) : (
                    <div className="rounded-lg border border-border bg-surface2 px-3 py-2 text-sm text-muted">
                      No expiry on record
                    </div>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardBody>
              <div className="mb-4 flex flex-wrap items-center gap-4 border-b border-border pb-4">
                <div className="flex items-center gap-2">
                  <Avatar name={call.creator?.displayName || call.creator?.stageName || "Creator"} src={undefined} size={40} />
                  <div>
                    <div className="text-xs text-muted">Creator</div>
                    <div className="font-bold text-text">
                      {call.creator?.displayName || call.creator?.stageName || call.creator?.username || call.creatorUserId}
                    </div>
                  </div>
                </div>
                {isCreator && clientLabel ? (
                  <div className="flex items-center gap-2">
                    <Avatar name={clientLabel.name} src={clientLabel.avatarUrl} size={40} />
                    <div>
                      <div className="text-xs text-muted">Client</div>
                      <div className="font-bold text-text">{clientLabel.name}</div>
                      <div className="text-xs text-muted">{clientLabel.sub}</div>
                    </div>
                  </div>
                ) : isClient ? (
                  <div className="text-sm text-muted">This call stays inside the current 1:1 creator conversation.</div>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-2">
                <Button onClick={onJoin} disabled={busy}>
                  {busy ? "Working..." : "Join"}
                </Button>
                {canExtend ? (
                  <Button variant="secondary" onClick={onExtend} disabled={busy}>
                    Extend (+{call.creditsPerBlock ?? "?"} credits)
                  </Button>
                ) : (
                  <span className="self-center text-xs text-muted">
                    {isCreator
                      ? "Only the client can extend billing."
                      : call?.status !== "active"
                        ? "Extend becomes available after the call is active."
                        : ""}
                  </span>
                )}
                <Button variant="danger" onClick={onEnd} disabled={busy}>
                  End call
                </Button>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>LiveKit</CardHeader>
            <CardBody>
              {livekit ? <LiveKitViewer livekit={livekit} showPublisherControls /> : <div className="text-muted">Join to receive LiveKit credentials.</div>}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>Call events</CardHeader>
            <CardBody>
              {eventLog.length === 0 ? <div className="text-muted">No call events yet.</div> : null}
              <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-bg p-2 text-sm">
                {eventLog.map((entry, idx) => (
                  <div key={`${entry.at}-${idx}`} className="border-b border-border py-2 last:border-0">
                    <div>
                      <span className="text-muted">{new Date(entry.at).toLocaleTimeString()}</span>{" "}
                      <span className="font-mono text-accent">{entry.type}</span>
                    </div>
                    {entry.detail ? <div className="mt-1 break-all text-xs text-muted">{entry.detail}</div> : null}
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        </>
      ) : null}
    </div>
  );
}
