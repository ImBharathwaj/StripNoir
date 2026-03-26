"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiGet, apiPost } from "../../lib/apiClient";
import { trackEvent } from "../../lib/analytics";
import Button from "../../components/ui/Button";
import Input from "../../components/ui/Input";
import { Card, CardBody, CardHeader } from "../../components/ui/Card";
import Badge from "../../components/ui/Badge";
import Avatar from "../../components/ui/Avatar";
import LiveCreatorSquareCard, { type LiveStreamCardModel } from "../../components/social/LiveCreatorSquareCard";

type CallRequest = {
  id: string;
  requester_user_id: string;
  target_creator_id: string;
  status: string;
  requested_at?: string;
  responded_at?: string | null;
  expires_at?: string | null;
  decline_reason?: string | null;
  metadata?: any;
};

type IncomingOutgoingResponse = {
  requests: CallRequest[];
};

type UserProfile = {
  user?: { id: string; username?: string; displayName?: string; avatarUrl?: string | null };
};

type CreatorProfile = {
  creator?: {
    id: string;
    stageName?: string;
    username?: string;
    displayName?: string;
    avatarUrl?: string | null;
  };
};

function displayUser(p: UserProfile | undefined) {
  const u = p?.user;
  if (!u) return null;
  return {
    label: u.displayName || u.username || u.id,
    sub: u.username ? `@${u.username}` : u.id.slice(0, 8) + "…",
    avatarUrl: u.avatarUrl || undefined
  };
}

function displayCreator(p: CreatorProfile | undefined) {
  const c = p?.creator;
  if (!c) return null;
  return {
    label: c.displayName || c.stageName || c.username || c.id,
    sub: c.username ? `@${c.username}` : "Creator",
    avatarUrl: c.avatarUrl || undefined
  };
}

export default function CallsRequestsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [incoming, setIncoming] = useState<CallRequest[]>([]);
  const [outgoing, setOutgoing] = useState<CallRequest[]>([]);
  const [requesterProfiles, setRequesterProfiles] = useState<Record<string, UserProfile>>({});
  const [targetCreators, setTargetCreators] = useState<Record<string, CreatorProfile>>({});

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [creatorId, setCreatorId] = useState("");
  const [expiresInSeconds, setExpiresInSeconds] = useState("300");

  /** Used when a creator accepts an incoming request (API defaults match these if omitted). */
  const [acceptCreditsPerBlock, setAcceptCreditsPerBlock] = useState("1");
  const [acceptBlockSeconds, setAcceptBlockSeconds] = useState("120");

  const [liveStreams, setLiveStreams] = useState<LiveStreamCardModel[]>([]);

  useEffect(() => {
    const c = searchParams.get("creator");
    if (c?.trim()) setCreatorId(c.trim());
  }, [searchParams]);

  const loadProfiles = useCallback(async (inReqs: CallRequest[], outReqs: CallRequest[]) => {
    const userIds = Array.from(new Set(inReqs.map((r) => r.requester_user_id).filter(Boolean)));
    const creatorIds = Array.from(new Set(outReqs.map((r) => r.target_creator_id).filter(Boolean)));

    const userPairs = await Promise.all(
      userIds.map(async (uid) => {
        try {
          const p = await apiGet<UserProfile>(`/users/${uid}`);
          return [uid, p] as const;
        } catch {
          return [uid, {} as UserProfile] as const;
        }
      })
    );

    const creatorPairs = await Promise.all(
      creatorIds.map(async (cid) => {
        try {
          const p = await apiGet<CreatorProfile>(`/creators/${cid}`);
          return [cid, p] as const;
        } catch {
          return [cid, {} as CreatorProfile] as const;
        }
      })
    );

    setRequesterProfiles(Object.fromEntries(userPairs));
    setTargetCreators(Object.fromEntries(creatorPairs));
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const [inData, outData, liveData] = await Promise.all([
        apiGet<IncomingOutgoingResponse>("/calls/requests/incoming"),
        apiGet<IncomingOutgoingResponse>("/calls/requests/outgoing"),
        apiGet<{ streams: LiveStreamCardModel[] }>("/streams/live").catch(() => ({ streams: [] as LiveStreamCardModel[] }))
      ]);
      setLiveStreams(liveData.streams || []);
      const inc = inData.requests || [];
      const out = outData.requests || [];
      setIncoming(inc);
      setOutgoing(out);
      await loadProfiles(inc, out);
    } catch (err: any) {
      if (err?.status === 401 || err?.message === "not authenticated") {
        router.replace("/login");
        return;
      }
      setError(err?.body?.error || err?.message || "failed to load call requests");
    } finally {
      setBusy(false);
    }
  }, [loadProfiles, router]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const cid = creatorId.trim();
      const data = await apiPost<any>("/calls/request", {
        creatorId: cid,
        expiresInSeconds: Number(expiresInSeconds)
      });
      trackEvent("start_call_request", { creatorId: cid, requestId: data?.request?.id ?? null });
      await refresh();
      if (data?.request?.id && data?.alreadyOpen) {
        return;
      }
    } catch (err: any) {
      if (err?.status === 401 || err?.message === "not authenticated") {
        router.replace("/login");
        return;
      }
      setError(err?.body?.error || err?.message || "failed to request call");
    } finally {
      setBusy(false);
    }
  }

  async function onAccept(requestId: string) {
    setError(null);
    setBusy(true);
    try {
      const credits = Math.max(1, parseInt(acceptCreditsPerBlock, 10) || 1);
      const secs = Math.max(30, parseInt(acceptBlockSeconds, 10) || 120);
      const res = await apiPost<any>(`/calls/${requestId}/accept`, {
        creditsPerBlock: credits,
        blockDurationSeconds: secs
      });
      const callId = res?.call?.id;
      if (callId) {
        trackEvent("accept_call_request", {
          requestId,
          callId,
          creditsPerBlock: credits,
          blockDurationSeconds: secs
        });
        router.replace(`/calls/${callId}`);
        return;
      }
      await refresh();
    } catch (err: any) {
      if (err?.status === 401 || err?.message === "not authenticated") {
        router.replace("/login");
        return;
      }
      setError(err?.body?.error || err?.message || "failed to accept call");
    } finally {
      setBusy(false);
    }
  }

  async function onDecline(requestId: string) {
    setError(null);
    setBusy(true);
    try {
      await apiPost<any>(`/calls/${requestId}/decline`, { reason: "declined" });
      await refresh();
    } catch (err: any) {
      if (err?.status === 401 || err?.message === "not authenticated") {
        router.replace("/login");
        return;
      }
      setError(err?.body?.error || err?.message || "failed to decline call");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="py-4">
      <h1>Video calls</h1>
      <p className="mt-1 text-muted">Request a creator, review incoming requests with clear pricing, then join the session from the call page.</p>
      {error ? <div className="mt-3 font-bold text-danger">{error}</div> : null}

      {liveStreams.length > 0 ? (
        <Card className="mt-4">
          <CardHeader>Creators live now</CardHeader>
          <CardBody>
            <p className="mb-3 text-sm text-muted">
              Creators who are broadcasting appear here with their profile photo. Request a call using their creator id prefilled.
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {liveStreams.map((s) => (
                <LiveCreatorSquareCard
                  key={s.id}
                  stream={s}
                  primaryHref={`/calls?creator=${encodeURIComponent(s.creatorId)}`}
                  primaryLabel="Request call"
                />
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card className="mt-4">
        <CardHeader>Request a call</CardHeader>
        <CardBody>
          <form onSubmit={onCreate} className="flex flex-wrap items-center gap-2">
            <Input
              value={creatorId}
              onChange={(e) => setCreatorId(e.target.value)}
              placeholder="creatorId (creator_profile id)"
              className="min-w-[220px] flex-1"
              required
            />
            <Input
              value={expiresInSeconds}
              onChange={(e) => setExpiresInSeconds(e.target.value)}
              type="number"
              min={60}
              max={3600}
              className="w-36"
            />
            <Button type="submit" disabled={busy}>
              {busy ? "Submitting…" : "Request"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => refresh()} disabled={busy}>
              Refresh
            </Button>
          </form>
        </CardBody>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>Incoming requests</CardHeader>
          <CardBody className="space-y-3">
            <div className="rounded-lg border border-border bg-surface2 p-3 text-sm text-muted">
              <div className="font-bold text-text2">Accept pricing (client billing)</div>
              <div className="mt-1">
                Each <strong className="text-white">accept</strong> uses the block rate below (charged when the client joins / extends).
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Input
                  value={acceptCreditsPerBlock}
                  onChange={(e) => setAcceptCreditsPerBlock(e.target.value)}
                  type="number"
                  min={1}
                  className="w-28"
                />
                <span className="self-center text-xs text-muted">credits / block</span>
                <Input
                  value={acceptBlockSeconds}
                  onChange={(e) => setAcceptBlockSeconds(e.target.value)}
                  type="number"
                  min={30}
                  className="w-28"
                />
                <span className="self-center text-xs text-muted">seconds / block</span>
              </div>
            </div>

            {incoming.length === 0 && !busy ? <div className="text-muted">No incoming requests.</div> : null}
            <div className="flex flex-col gap-3">
              {incoming.map((r) => {
                const who = displayUser(requesterProfiles[r.requester_user_id]);
                return (
                  <div key={r.id} className="rounded-xl border border-border bg-bg p-3">
                    <div className="flex items-start gap-3">
                      <Avatar name={who?.label || "Fan"} src={who?.avatarUrl} size={44} />
                      <div className="min-w-0 flex-1">
                        <div className="font-black text-white">{who?.label || r.requester_user_id}</div>
                        <div className="text-xs text-muted">{who?.sub}</div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Badge>{r.status}</Badge>
                          {r.expires_at ? (
                            <Badge variant="warning">expires {new Date(r.expires_at).toLocaleString()}</Badge>
                          ) : null}
                        </div>
                        <div className="mt-2 text-xs text-muted">
                          On accept: <span className="text-accent font-bold">{acceptCreditsPerBlock || "1"}</span> credits per{" "}
                          <span className="text-accent font-bold">{acceptBlockSeconds || "120"}</span>s block
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {r.status === "requested" ? (
                        <>
                          <Button type="button" disabled={busy} onClick={() => onAccept(r.id)}>
                            Accept
                          </Button>
                          <Button type="button" variant="secondary" disabled={busy} onClick={() => onDecline(r.id)}>
                            Decline
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>Outgoing requests</CardHeader>
          <CardBody>
            {outgoing.length === 0 && !busy ? <div className="text-muted">No outgoing requests.</div> : null}
            <div className="flex flex-col gap-3">
              {outgoing.map((r) => {
                const cr = displayCreator(targetCreators[r.target_creator_id]);
                return (
                  <div key={r.id} className="rounded-xl border border-border bg-bg p-3">
                    <div className="flex items-start gap-3">
                      <Avatar name={cr?.label || "Creator"} src={cr?.avatarUrl} size={44} />
                      <div className="min-w-0 flex-1">
                        <div className="font-black text-white">{cr?.label || r.target_creator_id}</div>
                        <div className="text-xs text-muted">{cr?.sub}</div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Badge>{r.status}</Badge>
                          {r.expires_at ? (
                            <Badge variant="warning">expires {new Date(r.expires_at).toLocaleString()}</Badge>
                          ) : null}
                        </div>
                        <div className="mt-2 text-xs text-muted">
                          Billing is set when the creator accepts (defaults 1 credit / 120s unless they change accept settings).
                        </div>
                        {r.decline_reason ? <div className="mt-2 text-sm text-danger">Declined: {r.decline_reason}</div> : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
