"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiGet } from '../../../lib/apiClient';
import { Card, CardBody } from '../../../components/ui/Card';
import Badge from '../../../components/ui/Badge';
import Avatar from '../../../components/ui/Avatar';
import { isVideoMediaAsset, resolveMediaAssetUrl } from '../../../lib/publicMediaUrl';
import InlineVideoPlayer from '../../../components/media/InlineVideoPlayer';
import FeedPostImage from '../../../components/media/FeedPostImage';
import FeedColumn from '../../../components/layout/FeedColumn';

type ContentCard = {
  id: string;
  creatorId: string;
  title: string;
  caption: string | null;
  visibility: string;
  status: string;
  requiresPayment: boolean;
  unlockPriceCredits: number;
  publishedAt: string | null;
};

type CreatorMeta = {
  id: string;
  stageName?: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
};

type MediaAsset = {
  id: string;
  mediaType?: string;
  mimeType?: string;
  media_type?: string;
  mime_type?: string;
  objectKey?: string;
  object_key?: string;
  storageBucket?: string;
  storage_bucket?: string;
  originalFilename?: string;
  original_filename?: string;
  width?: number;
  height?: number;
  metadata?: any;
};

export default function FollowingFeedPage() {
  const router = useRouter();
  const [feed, setFeed] = useState<ContentCard[]>([]);
  const [creatorsById, setCreatorsById] = useState<Record<string, CreatorMeta>>({});
  const [mediaByContentId, setMediaByContentId] = useState<Record<string, MediaAsset[]>>({});
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setBusy(true);
      setError(null);
      try {
        const data = await apiGet<{ feed: ContentCard[] }>(`/feed/following?limit=20`);
        if (!cancelled) setFeed(data.feed || []);

        const items = data.feed || [];
        const creatorIds = Array.from(new Set(items.map((i) => i.creatorId)));
        const creatorPairs = await Promise.all(
          creatorIds.map(async (creatorId) => {
            try {
              const r = await apiGet<{ creator: CreatorMeta }>(`/creators/${creatorId}`);
              return [creatorId, r.creator] as const;
            } catch {
              return [creatorId, { id: creatorId }] as const;
            }
          })
        );
        if (!cancelled) setCreatorsById(Object.fromEntries(creatorPairs));

        const mediaPairs = await Promise.all(
          items.map(async (item) => {
            try {
              const r = await apiGet<{ media: MediaAsset[] }>(`/content/${item.id}`);
              return [item.id, r.media || []] as const;
            } catch {
              return [item.id, []] as const;
            }
          })
        );
        if (!cancelled) setMediaByContentId(Object.fromEntries(mediaPairs));
      } catch (err: any) {
        if (err?.status === 401 || err?.message === 'not authenticated') {
          router.replace('/login');
          return;
        }
        if (!cancelled) setError(err?.body?.error || err?.message || 'failed to load');
      } finally {
        if (!cancelled) setBusy(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [router]);

  function mediaPreview(m: MediaAsset): { src: string | null; video: boolean } {
    const rec = m as unknown as Record<string, unknown>;
    const video = isVideoMediaAsset(rec);
    const src = resolveMediaAssetUrl(rec, video);
    return { src, video };
  }

  return (
    <FeedColumn className="py-4">
      <h1 className="text-center text-xl font-black tracking-tight">Following</h1>
      {error ? <div className="text-danger font-bold mt-2 text-center">{error}</div> : null}
      {busy ? <div className="text-muted mt-2 text-center">Loading...</div> : null}

      <div className="mt-5 grid gap-4">
        {feed.map((c) => (
          <Card key={c.id}>
            <CardBody>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Avatar
                    name={
                      creatorsById[c.creatorId]?.displayName ||
                      creatorsById[c.creatorId]?.stageName ||
                      creatorsById[c.creatorId]?.username
                    }
                    src={creatorsById[c.creatorId]?.avatarUrl}
                    size={36}
                  />
                  <div>
                    <div className="text-sm text-white font-bold">
                      {creatorsById[c.creatorId]?.displayName ||
                        creatorsById[c.creatorId]?.stageName ||
                        creatorsById[c.creatorId]?.username ||
                        'Creator'}
                    </div>
                    <div className="text-xs text-muted">
                      {c.publishedAt ? new Date(c.publishedAt).toLocaleString() : 'Draft/unscheduled'}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <Badge>{c.visibility}</Badge>
                  {c.requiresPayment ? <Badge variant="warning">{c.unlockPriceCredits} credits</Badge> : <Badge variant="success">Free</Badge>}
                </div>
              </div>

              <div className="mt-3">
                <Link href={`/content/${c.id}`} className="text-white text-lg font-black hover:underline">
                  {c.title}
                </Link>
                {c.caption ? <div className="text-muted mt-1">{c.caption.slice(0, 140)}</div> : null}
              </div>

              {c.requiresPayment ? <div className="mt-2"><Badge variant="warning">Locked</Badge></div> : null}

              <div className="mt-3 flex flex-col gap-2">
                {(mediaByContentId[c.id] || []).slice(0, 4).map((m) => {
                  const { src, video } = mediaPreview(m);
                  const fileLabel = m.originalFilename || m.original_filename || null;
                  const rec = m as unknown as Record<string, unknown>;
                  if (!src) {
                    return (
                      <div
                        key={m.id}
                        className="rounded-lg border border-border bg-surface2 p-2 text-center text-[11px] text-muted"
                      >
                        No preview
                      </div>
                    );
                  }
                  return (
                    <div
                      key={m.id}
                      className="w-full overflow-hidden rounded-lg border border-border bg-black/20"
                    >
                      {video ? (
                        <InlineVideoPlayer src={src} label={fileLabel} dimensionSource={rec} />
                      ) : (
                        <FeedPostImage src={src} alt={fileLabel || 'Post image'} asset={rec} />
                      )}
                    </div>
                  );
                })}
              </div>
            </CardBody>
          </Card>
        ))}
      </div>
    </FeedColumn>
  );
}

