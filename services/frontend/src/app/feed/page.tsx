"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiGet } from '../../lib/apiClient';
import { Card, CardBody } from '../../components/ui/Card';
import Badge from '../../components/ui/Badge';
import Avatar from '../../components/ui/Avatar';
import { isVideoMediaAsset, resolveMediaAssetUrl } from '../../lib/publicMediaUrl';
import InlineVideoPlayer from '../../components/media/InlineVideoPlayer';
import FeedPostImage from '../../components/media/FeedPostImage';
import FeedColumn from '../../components/layout/FeedColumn';

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

export default function FeedPage() {
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
        const data = await apiGet<{ feed: ContentCard[] }>('/feed?limit=20');
        if (!cancelled) setFeed(data.feed || []);

        const items = data.feed || [];
        const creatorIds = Array.from(new Set(items.map((item) => item.creatorId)));
        const creatorPairs = await Promise.all(
          creatorIds.map(async (creatorId) => {
            try {
              const response = await apiGet<{ creator: CreatorMeta }>(`/creators/${creatorId}`);
              return [creatorId, response.creator] as const;
            } catch {
              return [creatorId, { id: creatorId }] as const;
            }
          })
        );
        if (!cancelled) setCreatorsById(Object.fromEntries(creatorPairs));

        const mediaPairs = await Promise.all(
          items.map(async (item) => {
            try {
              const response = await apiGet<{ media: MediaAsset[] }>(`/content/${item.id}`);
              return [item.id, response.media || []] as const;
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

  function mediaPreview(asset: MediaAsset): { src: string | null; video: boolean } {
    const rec = asset as unknown as Record<string, unknown>;
    const video = isVideoMediaAsset(rec);
    const src = resolveMediaAssetUrl(rec, video);
    return { src, video };
  }

  return (
    <FeedColumn className="py-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-black tracking-tight text-white">Feed</h1>
          <div className="mt-1 text-sm text-muted">
            Public posts from creators plus follower-only posts from people you follow.
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/creators" className="rounded-lg border border-border px-3 py-2 text-sm font-black text-text no-underline hover:bg-surface2/80">
            Browse creators
          </Link>
          <Link href="/feed/following" className="rounded-lg border border-border px-3 py-2 text-sm font-black text-text no-underline hover:bg-surface2/80">
            Following only
          </Link>
          <Link href="/feed/trending" className="rounded-lg border border-border px-3 py-2 text-sm font-black text-text no-underline hover:bg-surface2/80">
            Trending
          </Link>
        </div>
      </div>

      {error ? <div className="mt-2 text-center font-bold text-danger">{error}</div> : null}
      {busy ? <div className="mt-2 text-center text-muted">Loading...</div> : null}

      <div className="mt-5 grid gap-4">
        {feed.map((post) => (
          <Card key={post.id}>
            <CardBody>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Avatar
                    name={
                      creatorsById[post.creatorId]?.displayName ||
                      creatorsById[post.creatorId]?.stageName ||
                      creatorsById[post.creatorId]?.username
                    }
                    src={creatorsById[post.creatorId]?.avatarUrl}
                    size={36}
                  />
                  <div>
                    <div className="text-sm font-bold text-white">
                      {creatorsById[post.creatorId]?.displayName ||
                        creatorsById[post.creatorId]?.stageName ||
                        creatorsById[post.creatorId]?.username ||
                        'Creator'}
                    </div>
                    <div className="text-xs text-muted">
                      {post.publishedAt ? new Date(post.publishedAt).toLocaleString() : 'Draft/unscheduled'}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <Badge>{post.visibility}</Badge>
                  {post.requiresPayment ? (
                    <Badge variant="warning">{post.unlockPriceCredits} credits</Badge>
                  ) : (
                    <Badge variant="success">Free</Badge>
                  )}
                </div>
              </div>

              <div className="mt-3">
                <Link href={`/content/${post.id}`} className="text-lg font-black text-white hover:underline">
                  {post.title}
                </Link>
                {post.caption ? <div className="mt-1 text-muted">{post.caption.slice(0, 140)}</div> : null}
              </div>

              {post.requiresPayment ? (
                <div className="mt-2">
                  <Badge variant="warning">Locked</Badge>
                </div>
              ) : null}

              <div className="mt-3 flex flex-col gap-2">
                {(mediaByContentId[post.id] || []).slice(0, 4).map((media) => {
                  const { src, video } = mediaPreview(media);
                  const fileLabel = media.originalFilename || media.original_filename || null;
                  const rec = media as unknown as Record<string, unknown>;
                  if (!src) {
                    return (
                      <div
                        key={media.id}
                        className="rounded-lg border border-border bg-surface2 p-2 text-center text-[11px] text-muted"
                      >
                        No preview
                      </div>
                    );
                  }
                  return (
                    <div
                      key={media.id}
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

      {!busy && feed.length === 0 ? (
        <div className="mt-6 rounded-xl border border-border bg-surface2 p-4 text-center text-muted">
          No posts available right now.
        </div>
      ) : null}
    </FeedColumn>
  );
}
