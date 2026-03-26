"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { apiGet, apiPost } from '../../../lib/apiClient';
import { trackEvent } from '../../../lib/analytics';
import Button from '../../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../../components/ui/Card';
import Badge from '../../../components/ui/Badge';
import { useRef } from 'react';
import { isVideoMediaAsset, resolveMediaAssetUrl } from '../../../lib/publicMediaUrl';

type Content = {
  id: string;
  creatorId: string;
  title: string;
  caption: string | null;
  visibility: string;
  requiresPayment: boolean;
  unlockPriceCredits: number;
  status: string;
  publishedAt: string | null;
  metadata: any;
  createdAt: string;
  updatedAt: string;
};

type MediaAsset = {
  id: string;
  mediaType: string;
  storageProvider: string;
  storageBucket: string;
  objectKey: string;
  originalFilename: string;
  mimeType: string;
  isPublic: boolean;
  metadata: any;
  createdAt: string;
};

export default function ContentDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = String((params as any).id || '');

  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [content, setContent] = useState<Content | null>(null);
  const [media, setMedia] = useState<MediaAsset[]>([]);
  const [unlocking, setUnlocking] = useState(false);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [loadedMedia, setLoadedMedia] = useState<Record<string, boolean>>({});
  const [theaterMode, setTheaterMode] = useState(false);
  const mediaZoneRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setBusy(true);
      setError(null);
      try {
        const data = await apiGet<{ content: Content; media: MediaAsset[] }>(`/content/${id}`);
        if (!cancelled) {
          setContent(data.content);
          setMedia(data.media || []);
        }
        const wallet = await apiGet<{ wallet?: { available_credits?: number; availableCredits?: number } }>(
          '/wallet/balance'
        );
        if (!cancelled) {
          const available = wallet?.wallet?.available_credits ?? wallet?.wallet?.availableCredits ?? null;
          setWalletBalance(typeof available === 'number' ? available : null);
        }
      } catch (err: any) {
        if (err?.status === 401 || err?.message === 'not authenticated') {
          router.replace('/login');
          return;
        }
        if (!cancelled) setError(err?.body?.error || err?.message || 'failed to load content');
      } finally {
        if (!cancelled) setBusy(false);
      }
    }

    if (id) run();
    return () => {
      cancelled = true;
    };
  }, [id, router]);

  async function onUnlock() {
    if (!content) return;
    setUnlocking(true);
    setError(null);
    setNotice('Unlocking content...');
    try {
      const data = await apiPost(`/content/${content.id}/unlock`);
      if (data?.content) setContent(data.content);
      setNotice('Content unlocked successfully.');
      trackEvent('unlock_ppv', {
        contentId: content.id,
        creatorId: content.creatorId,
        unlockPriceCredits: content.unlockPriceCredits
      });
      const wallet = await apiGet<{ wallet?: { available_credits?: number; availableCredits?: number } }>(
        '/wallet/balance'
      );
      const available = wallet?.wallet?.available_credits ?? wallet?.wallet?.availableCredits ?? null;
      setWalletBalance(typeof available === 'number' ? available : null);
    } catch (err: any) {
      if (err?.status === 401 || err?.message === 'not authenticated') {
        router.replace('/login');
        return;
      }
      if (err?.status === 402) {
        setError('Insufficient credits to unlock this PPV content.');
        return;
      }
      setError(err?.body?.error || err?.message || 'unlock failed');
      setNotice(null);
    } finally {
      setUnlocking(false);
    }
  }

  function resolveMediaUrl(asset: MediaAsset, forVideo: boolean): string | null {
    return resolveMediaAssetUrl(asset as unknown as Record<string, unknown>, forVideo);
  }

  function isVideoAsset(asset: MediaAsset): boolean {
    return isVideoMediaAsset(asset as unknown as Record<string, unknown>);
  }

  async function onEnterFullscreen() {
    const node = mediaZoneRef.current;
    if (!node || typeof node.requestFullscreen !== 'function') return;
    try {
      await node.requestFullscreen();
    } catch {
      // Ignore browser fullscreen restrictions and continue with normal layout.
    }
  }

  return (
    <div className="py-4">
      <h1>Content</h1>
      {busy ? <div className="text-muted mt-2">Loading...</div> : null}
      {error ? <div className="text-danger font-bold mt-3">{error}</div> : null}
      {notice ? <div className="text-success font-bold mt-3">{notice}</div> : null}

      {content ? (
        <Card className="mt-4">
          <CardHeader>
            <div className="text-2xl font-black text-white">{content.title}</div>
            {content.caption ? <div className="text-muted mt-2">{content.caption}</div> : null}
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge>{content.visibility}</Badge>
              {content.requiresPayment ? <Badge variant="warning">PPV</Badge> : <Badge variant="success">Free</Badge>}
            </div>
          </CardHeader>
          <CardBody>
            <div ref={mediaZoneRef} className={theaterMode ? 'bg-surface2 rounded-xl p-3' : ''}>
              <div className="mb-3 flex items-center justify-between">
                <div className="text-sm text-muted">
                  {media.length > 0
                    ? `Media preview (${media.length} asset${media.length > 1 ? 's' : ''})`
                    : 'No media attached'}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant={theaterMode ? 'primary' : 'secondary'}
                    size="sm"
                    onClick={() => setTheaterMode((v) => !v)}
                  >
                    {theaterMode ? 'Exit theater' : 'Theater mode'}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={onEnterFullscreen}>
                    Fullscreen
                  </Button>
                </div>
              </div>

              {media.length > 0 ? (
                <div className={theaterMode ? 'grid gap-3 grid-cols-1' : 'grid gap-3 grid-cols-1 md:grid-cols-2'}>
                  {media.map((asset) => {
                    const isVideo = isVideoAsset(asset);
                    const src = resolveMediaUrl(asset, isVideo);
                    const isLoaded = Boolean(loadedMedia[asset.id]);
                    return (
                      <div key={asset.id} className="rounded-xl border border-border bg-bg p-2">
                        {!src ? (
                          <div className="rounded-lg border border-border bg-surface2 p-3 text-xs text-muted">
                            Media preview unavailable (missing object key or metadata URL).
                          </div>
                        ) : isVideo ? (
                          <div className="relative">
                            {!isLoaded ? <div className="absolute inset-0 animate-pulse rounded-lg bg-surface2" /> : null}
                            <video
                              src={src}
                              controls
                              preload="metadata"
                              className={`w-full rounded-lg transition ${isLoaded ? 'opacity-100' : 'opacity-0 blur-sm'}`}
                              onLoadedData={() => setLoadedMedia((prev) => ({ ...prev, [asset.id]: true }))}
                            />
                          </div>
                        ) : (
                          <div className="relative">
                            {!isLoaded ? <div className="absolute inset-0 animate-pulse rounded-lg bg-surface2" /> : null}
                            <img
                              src={src}
                              alt={asset.originalFilename || 'media'}
                              className={`w-full rounded-lg object-cover transition ${isLoaded ? 'opacity-100' : 'opacity-0 blur-sm'}`}
                              onLoad={() => setLoadedMedia((prev) => ({ ...prev, [asset.id]: true }))}
                            />
                          </div>
                        )}
                        <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                          <span className="text-muted">{asset.mimeType || asset.mediaType}</span>
                          {src ? (
                            <a href={src} target="_blank" rel="noreferrer" className="text-accent underline">
                              Open source
                            </a>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>

            {content.requiresPayment && content.visibility === 'exclusive_ppv' ? (
              <div className="rounded-xl border border-border bg-surface2 p-4">
                <div className="text-lg font-black text-white">Premium paywall</div>
                <div className="mt-1 text-sm text-muted">
                  Unlock this PPV item to view premium media and creator-only content.
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Badge variant="warning">Unlock price: {content.unlockPriceCredits} credits</Badge>
                  <Badge>Wallet balance: {walletBalance ?? '...'} credits</Badge>
                </div>
                <div className="mt-4 flex items-center gap-2">
                  <Button onClick={onUnlock} disabled={unlocking}>
                    {unlocking ? 'Unlocking...' : 'Unlock'}
                  </Button>
                  {error?.toLowerCase().includes('insufficient credits') ? (
                    <Link href="/wallet" className="text-accent underline text-sm">
                      Deposit credits in wallet
                    </Link>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="text-muted">No paywall is required for this item.</div>
            )}
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

