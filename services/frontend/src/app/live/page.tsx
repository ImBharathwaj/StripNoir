"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost } from "../../lib/apiClient";
import { Card, CardBody } from "../../components/ui/Card";
import Button from "../../components/ui/Button";
import LiveCreatorSquareCard from "../../components/social/LiveCreatorSquareCard";
import Input from "../../components/ui/Input";
import { useAppSession } from "../../context/AppSessionContext";
import { uploadUserMedia } from "../../lib/mediaUpload";

type LiveStream = {
  id: string;
  creatorId: string;
  creatorUserId: string;
  roomId: string | null;
  livekitRoomName: string | null;
  title: string;
  description?: string | null;
  streamThumbnailUrl?: string | null;
  status: string;
  scheduledStartAt?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  baseJoinPriceCredits: number;
  extendPriceCredits: number;
  extendDurationSeconds: number;
  maxConcurrentViewers: number | null;
  metadata?: Record<string, unknown> | null;
  creator?: {
    displayName?: string | null;
    stageName?: string | null;
    username?: string | null;
    avatarUrl?: string | null;
  };
  stats: {
    activeViewers: number;
  };
};

function categoriesFromMetadata(meta: Record<string, unknown> | null | undefined): string[] {
  if (!meta || typeof meta !== "object") return [];
  const raw = meta.category ?? meta.categories;
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean);
  }
  return [];
}

export default function LiveListPage() {
  const router = useRouter();
  const { user, isCreator, creatorProfile } = useAppSession();
  const [streams, setStreams] = useState<LiveStream[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const [startTitle, setStartTitle] = useState("");
  const [startPrice, setStartPrice] = useState("1");
  const [startBusy, setStartBusy] = useState(false);
  const [thumbFile, setThumbFile] = useState<File | null>(null);
  const [thumbPreview, setThumbPreview] = useState<string | null>(null);

  const loadLive = useCallback(async (cancelled = false) => {
    setBusy(true);
    setError(null);
    try {
      const data = await apiGet<{ streams: LiveStream[] }>("/streams/live");
      if (!cancelled) {
        setStreams(data.streams || []);
      }
    } catch (err: any) {
      if (err?.status === 401 || err?.message === "not authenticated") {
        router.replace("/login");
        return;
      }
      if (!cancelled) setError(err?.body?.error || err?.message || "failed to load live streams");
    } finally {
      if (!cancelled) setBusy(false);
    }
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    loadLive(cancelled);
    const timer = setInterval(() => {
      if (!cancelled) loadLive(cancelled);
    }, 8000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [loadLive]);

  const allCategories = useMemo(() => {
    const set = new Set<string>();
    for (const s of streams) {
      for (const c of categoriesFromMetadata(s.metadata)) {
        set.add(c);
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [streams]);

  const filtered = useMemo(() => {
    if (!categoryFilter) return streams;
    return streams.filter((s) => categoriesFromMetadata(s.metadata).includes(categoryFilter));
  }, [streams, categoryFilter]);

  const myLiveSession = useMemo(() => {
    if (!user?.id) return null;
    return streams.find((s) => s.creatorUserId === user.id && s.status === "live") || null;
  }, [streams, user?.id]);

  async function onStartLive(e: React.FormEvent) {
    e.preventDefault();
    setStartBusy(true);
    setError(null);
    try {
      let streamThumbnailUrl: string | undefined;
      if (thumbFile) {
        const up = await uploadUserMedia(thumbFile, "image");
        streamThumbnailUrl = up.publicUrl;
      }
      const payload = await apiPost<{ stream: LiveStream }>("/streams/start", {
        title: startTitle.trim(),
        baseJoinPriceCredits: Math.max(0, Number(startPrice) || 0),
        ...(streamThumbnailUrl ? { streamThumbnailUrl } : {})
      });
      if (payload?.stream?.id) {
        await loadLive();
        router.push(`/live/${payload.stream.id}`);
        return;
      }
      router.refresh();
    } catch (err: any) {
      if (err?.status === 401 || err?.message === "not authenticated") {
        router.replace("/login");
        return;
      }
      setError(err?.body?.error || err?.message || "failed to start live session");
    } finally {
      setStartBusy(false);
    }
  }

  return (
    <div className="py-4">
      <h1>{isCreator ? "Go Live" : "Live"}</h1>
      <p className="mt-1 text-muted">
        {isCreator ? "Start your session with a title and watch price." : "Join active live sessions from creators."}
      </p>

      {!isCreator ? (
        <div className="mt-3">
          <Button size="sm" variant="secondary" onClick={() => loadLive()}>
            Refresh live list
          </Button>
        </div>
      ) : null}

      {isCreator ? (
        <Card className="mt-4 overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-accent via-success to-warning" />
          <CardBody>
            <div className="mb-1 text-xs font-black uppercase tracking-[0.15em] text-muted">Creator studio</div>
            <div className="text-lg font-black text-text">Start live session</div>
            {!creatorProfile?.liveEnabled ? (
              <div className="mt-2 text-sm text-warning">Enable live in your creator profile before starting a session.</div>
            ) : null}
            {myLiveSession ? (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface2 px-3 py-3">
                <div>
                  <div className="text-xs font-bold uppercase tracking-[0.12em] text-success">Session active</div>
                  <div className="text-sm font-extrabold text-text">{myLiveSession.title}</div>
                </div>
                <Button size="sm" onClick={() => router.push(`/live/${myLiveSession.id}`)}>
                  Open live room
                </Button>
              </div>
            ) : null}
            <form className="mt-4 grid gap-3 sm:grid-cols-3" onSubmit={onStartLive}>
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-bold text-muted">Live title</label>
                <Input value={startTitle} onChange={(e) => setStartTitle(e.target.value)} placeholder="Session title" required />
              </div>
              <div>
                <label className="mb-1 block text-xs font-bold text-muted">Watch price (credits)</label>
                <Input type="number" min={0} value={startPrice} onChange={(e) => setStartPrice(e.target.value)} required />
              </div>
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-bold text-muted">Thumbnail (optional)</label>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const f = e.target.files?.[0] || null;
                    if (thumbPreview) URL.revokeObjectURL(thumbPreview);
                    setThumbFile(f);
                    setThumbPreview(f ? URL.createObjectURL(f) : null);
                  }}
                  className="text-sm text-muted file:mr-2 file:rounded-lg file:border-0 file:bg-surface2 file:px-3 file:py-2 file:text-xs file:font-extrabold file:text-text"
                />
                {thumbPreview ? <img src={thumbPreview} alt="thumbnail preview" className="mt-2 h-16 w-24 rounded-lg object-cover" /> : null}
              </div>
              <div className="flex items-end">
                <Button type="submit" disabled={startBusy || !creatorProfile?.liveEnabled || !startTitle.trim()} className="w-full">
                  {startBusy ? "Starting..." : "Start live"}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      ) : null}

      {error ? <div className="mt-3 font-bold text-danger">{error}</div> : null}
      {busy ? <div className="mt-2 text-muted">Loading live sessions...</div> : null}

      {!isCreator && allCategories.length > 0 ? (
        <Card className="mt-4">
          <CardBody className="flex flex-wrap gap-2">
            <Button size="sm" variant={categoryFilter === "" ? "primary" : "secondary"} onClick={() => setCategoryFilter("")}>
              All categories
            </Button>
            {allCategories.map((c) => (
              <Button
                key={c}
                size="sm"
                variant={categoryFilter === c ? "primary" : "secondary"}
                onClick={() => setCategoryFilter(c)}
              >
                {c}
              </Button>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {!isCreator ? (
        <>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((s) => (
              <LiveCreatorSquareCard
                key={s.id}
                stream={s}
                primaryHref={`/live/${s.id}`}
                primaryLabel={s.baseJoinPriceCredits > 0 ? `Join · ${s.baseJoinPriceCredits} cr` : "Join free"}
              />
            ))}
          </div>

          {!busy && filtered.length === 0 ? (
            <div className="mt-6 rounded-xl border border-border bg-surface2 p-4 text-muted">
              {streams.length === 0 ? "No live sessions right now." : "No streams match this category."}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
