"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { apiDelete, apiGet, apiPost } from '../../../lib/apiClient';
import { trackEvent } from '../../../lib/analytics';
import Button from '../../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../../components/ui/Card';
import Badge from '../../../components/ui/Badge';
import Avatar from '../../../components/ui/Avatar';
import CreatorBadge from '../../../components/ui/CreatorBadge';
import PriceTag from '../../../components/ui/PriceTag';

type CreatorProfile = {
  id: string;
  userId: string;
  stageName: string;
  about: string | null;
  categoryTags: string[];
  verificationStatus: string;
  defaultSubscriptionPriceCredits: number;
  liveEnabled: boolean;
  chatEnabled: boolean;
  videoCallEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  bio?: string | null;
};

type UserStats = {
  followers: number;
  following: number;
  isFollowing: boolean;
};

type UserProfileResponse = {
  user: any;
  stats: UserStats;
};

type CreatorPost = {
  id: string;
  title: string | null;
  caption: string | null;
  visibility: 'public' | 'followers' | 'exclusive_ppv' | string;
  requiresPayment: boolean;
  unlockPriceCredits: number;
  status: string;
  publishedAt?: string | null;
};

type SubscriptionContent = {
  id: string;
  title: string | null;
  caption: string | null;
  status: string;
  publishedAt?: string | null;
};

type CreatorTab = 'posts' | 'ppv' | 'subscribers';

export default function CreatorDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = String((params as any).id || '');

  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creator, setCreator] = useState<CreatorProfile | null>(null);
  const [userStats, setUserStats] = useState<UserStats | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<CreatorTab>('posts');
  const [tabBusy, setTabBusy] = useState(false);
  const [posts, setPosts] = useState<CreatorPost[]>([]);
  const [subscriberCatalog, setSubscriberCatalog] = useState<SubscriptionContent[]>([]);
  const [isSubscribedToCreator, setIsSubscribedToCreator] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setBusy(true);
      setError(null);
      try {
        const data = await apiGet<{ creator: CreatorProfile; stats: any }>(`/creators/${id}`);
        if (cancelled) return;
        setCreator(data.creator);

        const userProfile = await apiGet<UserProfileResponse>(`/users/${data.creator.userId}`);
        if (cancelled) return;
        setUserStats(userProfile.stats);
      } catch (err: any) {
        if (err?.status === 401 || err?.message === 'not authenticated') {
          router.replace('/login');
          return;
        }
        if (!cancelled) setError(err?.body?.error || err?.message || 'failed to load creator');
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
    let cancelled = false;

    async function loadCatalog() {
      if (!creator?.id) return;

      setTabBusy(true);
      try {
        if (activeTab === 'subscribers') {
          const data = await apiGet<{ subscribed: boolean; content: SubscriptionContent[] }>(
            `/creators/${creator.id}/subscription-content?limit=30`
          );
          if (cancelled) return;
          setIsSubscribedToCreator(Boolean(data.subscribed));
          setSubscriberCatalog(data.content || []);
          return;
        }

        const data = await apiGet<{ content: CreatorPost[] }>(`/creators/${creator.id}/content?limit=30`);
        if (cancelled) return;
        setPosts(data.content || []);
      } catch (err: any) {
        if (err?.status === 401 || err?.message === 'not authenticated') {
          router.replace('/login');
          return;
        }
        if (!cancelled) setError(err?.body?.error || err?.message || 'failed to load creator catalog');
      } finally {
        if (!cancelled) setTabBusy(false);
      }
    }

    loadCatalog();
    return () => {
      cancelled = true;
    };
  }, [activeTab, creator?.id, router]);

  async function onToggleFollow() {
    if (!creator || !userStats) return;
    setActionBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (userStats.isFollowing) {
        await apiDelete(`/users/${creator.userId}/unfollow`);
        setUserStats((prev) => (prev ? { ...prev, isFollowing: false } : prev));
      } else {
        await apiPost(`/users/${creator.userId}/follow`);
        setUserStats((prev) => (prev ? { ...prev, isFollowing: true } : prev));
      }
    } catch (err: any) {
      if (err?.status === 401 || err?.message === 'not authenticated') {
        router.replace('/login');
        return;
      }
      setError(err?.body?.error || err?.message || 'follow action failed');
    } finally {
      setActionBusy(false);
    }
  }

  async function onSubscribe() {
    if (!creator) return;
    trackEvent('subscribe_click', {
      creatorId: creator.id,
      amountCredits: creator.defaultSubscriptionPriceCredits,
      source: 'creator_profile'
    });
    setActionBusy(true);
    setError(null);
    setNotice('Processing subscription...');
    const previous = isSubscribedToCreator;
    setIsSubscribedToCreator(true); // Optimistic subscription state for faster UX.
    try {
      await apiPost('/payments/subscribe', {
        creatorId: creator.id,
        amountCredits: creator.defaultSubscriptionPriceCredits
      });
      setNotice('Subscription completed successfully.');
      trackEvent('subscribe_success', {
        creatorId: creator.id,
        amountCredits: creator.defaultSubscriptionPriceCredits,
        source: 'creator_profile'
      });
    } catch (err: any) {
      setIsSubscribedToCreator(previous);
      if (err?.status === 401 || err?.message === 'not authenticated') {
        router.replace('/login');
        return;
      }
      if (err?.status === 402) {
        setError('Insufficient credits. Deposit in wallet and try again.');
        return;
      }
      setError(err?.body?.error || err?.message || 'subscription failed');
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div className="py-4">
      <h1>Creator</h1>
      {busy ? <div className="text-muted mt-2">Loading...</div> : null}
      {error ? <div className="text-danger font-bold mt-3">{error}</div> : null}
      {notice ? <div className="text-success font-bold mt-3">{notice}</div> : null}

      {creator ? (
        <>
          <Card className="mt-4">
            <CardHeader>
              <div className="flex items-start gap-3">
                <Avatar name={creator.displayName || creator.stageName} src={creator.avatarUrl} size={64} />
                <div>
                  <div className="text-2xl font-black">{creator.displayName || creator.stageName}</div>
                  <div className="text-muted mt-1">@{creator.username || 'creator'}</div>
                  <div className="mt-2">
                    <CreatorBadge status={creator.verificationStatus} />
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardBody>
              <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                <div className="md:max-w-[65%]">
                  {creator.about ? <div className="text-text2">{creator.about}</div> : <div className="text-muted">No bio yet.</div>}

                  <div className="mt-3 flex flex-wrap gap-2">
                    {(creator.categoryTags || []).map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </div>
                </div>

                <div className="md:text-right md:min-w-[270px] space-y-2">
                  <PriceTag credits={creator.defaultSubscriptionPriceCredits} />
                  <div className="text-xs text-muted">Renews each billing period while active.</div>
                  <div className="text-xs text-muted">Includes subscriber-only catalog access and premium unlocks.</div>
                  {userStats ? <div className="text-xs text-muted">{userStats.following} following</div> : null}
                  <div className="flex md:justify-end gap-2">
                    <Button onClick={onSubscribe} disabled={actionBusy} size="sm">
                      {actionBusy ? 'Subscribing...' : isSubscribedToCreator ? 'Subscribed' : 'Subscribe'}
                    </Button>
                    <Button
                      onClick={onToggleFollow}
                      disabled={actionBusy || !userStats}
                      variant={!userStats || userStats.isFollowing ? 'secondary' : 'primary'}
                      size="sm"
                    >
                      {userStats ? (userStats.isFollowing ? 'Unfollow' : 'Follow') : 'Loading...'}
                    </Button>
                  </div>
                  <div className="text-xs text-muted">
                    {creator.liveEnabled ? 'Live enabled' : 'Live disabled'} •{' '}
                    {creator.chatEnabled ? 'Chat enabled' : 'Chat disabled'} •{' '}
                    {creator.videoCallEnabled ? 'Video calls enabled' : 'Video calls disabled'}
                  </div>
                  {error?.toLowerCase().includes('insufficient credits') ? (
                    <a href="/wallet" className="text-accent underline text-sm">
                      Deposit credits in wallet
                    </a>
                  ) : null}
                </div>
              </div>
            </CardBody>
          </Card>

          <Card className="mt-4">
            <CardBody>
              <div className="flex flex-wrap gap-2">
                <Button variant={activeTab === 'posts' ? 'primary' : 'secondary'} size="sm" onClick={() => setActiveTab('posts')}>
                  Posts
                </Button>
                <Button variant={activeTab === 'ppv' ? 'primary' : 'secondary'} size="sm" onClick={() => setActiveTab('ppv')}>
                  PPV
                </Button>
                <Button
                  variant={activeTab === 'subscribers' ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setActiveTab('subscribers')}
                >
                  Subscriber-only
                </Button>
              </div>

              {tabBusy ? <div className="mt-3 text-muted">Loading {activeTab}...</div> : null}

              {activeTab === 'posts' ? (
                <div className="mt-3 grid gap-3">
                  {posts
                    .filter((p) => !p.requiresPayment && p.visibility !== 'exclusive_ppv')
                    .map((p) => (
                      <div key={p.id} className="rounded-xl border border-border bg-surface2 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-black text-text">{p.title || 'Untitled post'}</div>
                          <Badge>{p.visibility}</Badge>
                        </div>
                        {p.caption ? <div className="mt-1 text-sm text-muted">{p.caption}</div> : null}
                        <div className="mt-2">
                          <Link href={`/content/${p.id}`} className="text-accent underline text-sm">
                            View post
                          </Link>
                        </div>
                      </div>
                    ))}
                  {posts.filter((p) => !p.requiresPayment && p.visibility !== 'exclusive_ppv').length === 0 ? (
                    <div className="mt-2 text-muted">No standard posts yet.</div>
                  ) : null}
                </div>
              ) : null}

              {activeTab === 'ppv' ? (
                <div className="mt-3 grid gap-3">
                  {posts
                    .filter((p) => p.requiresPayment || p.visibility === 'exclusive_ppv')
                    .map((p) => (
                      <div key={p.id} className="rounded-xl border border-border bg-surface2 p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-black text-text">{p.title || 'Untitled PPV'}</div>
                          <Badge variant="warning">{p.unlockPriceCredits} credits</Badge>
                        </div>
                        {p.caption ? <div className="mt-1 text-sm text-muted">{p.caption}</div> : null}
                        <div className="mt-2">
                          <Link href={`/content/${p.id}`} className="text-accent underline text-sm">
                            Open paywall
                          </Link>
                        </div>
                      </div>
                    ))}
                  {posts.filter((p) => p.requiresPayment || p.visibility === 'exclusive_ppv').length === 0 ? (
                    <div className="mt-2 text-muted">No PPV catalog items yet.</div>
                  ) : null}
                </div>
              ) : null}

              {activeTab === 'subscribers' ? (
                <div className="mt-3">
                  {!isSubscribedToCreator ? (
                    <div className="rounded-xl border border-border bg-surface2 p-3 text-warning">
                      Subscribe to unlock this creator&apos;s subscriber-only catalog.
                    </div>
                  ) : (
                    <div className="grid gap-3">
                      {subscriberCatalog.map((p) => (
                        <div key={p.id} className="rounded-xl border border-border bg-surface2 p-3">
                          <div className="flex items-start justify-between gap-2">
                            <div className="font-black text-text">{p.title || 'Untitled subscriber item'}</div>
                            <Badge variant="success">Subscriber-only</Badge>
                          </div>
                          {p.caption ? <div className="mt-1 text-sm text-muted">{p.caption}</div> : null}
                        </div>
                      ))}
                      {subscriberCatalog.length === 0 ? <div className="text-muted">No subscriber-only items yet.</div> : null}
                    </div>
                  )}
                </div>
              ) : null}
            </CardBody>
          </Card>
        </>
      ) : null}
    </div>
  );
}

