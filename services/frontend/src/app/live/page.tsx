"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet } from "../../lib/apiClient";
import { Card, CardBody } from "../../components/ui/Card";
import Badge from "../../components/ui/Badge";
import Button from "../../components/ui/Button";
import LiveCreatorSquareCard from "../../components/social/LiveCreatorSquareCard";

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
  const [streams, setStreams] = useState<LiveStream[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setBusy(true);
      setError(null);
      try {
        const data = await apiGet<{ streams: LiveStream[] }>("/streams/live");
        if (!cancelled) setStreams(data.streams || []);
      } catch (err: any) {
        if (err?.status === 401 || err?.message === "not authenticated") {
          router.replace("/login");
          return;
        }
        if (!cancelled) setError(err?.body?.error || err?.message || "failed to load live streams");
      } finally {
        if (!cancelled) setBusy(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [router]);

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

  return (
    <div className="py-4">
      <h1>Live</h1>
      <p className="mt-1 text-muted">Join active streams, see viewer counts, and browse by category when creators tag their session.</p>

      {error ? <div className="mt-3 font-bold text-danger">{error}</div> : null}
      {busy ? <div className="mt-2 text-muted">Loading live sessions…</div> : null}

      {allCategories.length > 0 ? (
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
    </div>
  );
}
