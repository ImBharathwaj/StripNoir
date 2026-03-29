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
import ChatThreadPanel from '../../../components/social/ChatThreadPanel';
import VideoCallSessionPanel from '../../../components/social/VideoCallSessionPanel';

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

type CreatorStats = {
  followers: number;
  subscribers: number;
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

type CallRequest = {
  id: string;
  target_creator_id: string;
  status: string;
  requested_at?: string;
  responded_at?: string | null;
  expires_at?: string | null;
  decline_reason?: string | null;
  session_id?: string | null;
  session_status?: string | null;
};

export default function CreatorDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = String((params as any).id || '');

  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creator, setCreator] = useState<CreatorProfile | null>(null);
  const [userStats, setUserStats] = useState<UserStats | null>(null);
  const [creatorStats, setCreatorStats] = useState<CreatorStats | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [subscribeBusy, setSubscribeBusy] = useState(false);
  const [subscriptionAction, setSubscriptionAction] = useState<'subscribe' | 'unsubscribe' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<CreatorTab>('posts');
  const [tabBusy, setTabBusy] = useState(false);
  const [posts, setPosts] = useState<CreatorPost[]>([]);
  const [subscriberCatalog, setSubscriberCatalog] = useState<SubscriptionContent[]>([]);
  const [isSubscribedToCreator, setIsSubscribedToCreator] = useState(false);
  const [chatRoomId, setChatRoomId] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [activeCallRequest, setActiveCallRequest] = useState<CallRequest | null>(null);
  const [callBusy, setCallBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setBusy(true);
      setError(null);
      try {
        const data = await apiGet<{ creator: CreatorProfile; stats: CreatorStats }>(`/creators/${id}`);
        if (cancelled) return;
        setCreator(data.creator);
        setCreatorStats(data.stats || null);

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

  useEffect(() => {
    let cancelled = false;

    async function loadConnectionState() {
      if (!creator) return;
      try {
        const [roomsSummary, outgoing] = await Promise.all([
          creator.chatEnabled ? apiGet<{ rooms: Array<{ id: string; otherParticipant: { userId: string } | null }> }>('/chat/rooms/summary') : Promise.resolve({ rooms: [] }),
          creator.videoCallEnabled ? apiGet<{ requests: CallRequest[] }>('/calls/requests/outgoing?limit=30') : Promise.resolve({ requests: [] })
        ]);
        if (cancelled) return;

        const room = (roomsSummary.rooms || []).find((item) => item.otherParticipant?.userId === creator.userId);
        setChatRoomId(room?.id || null);

        const callRequest = (outgoing.requests || [])
          .filter((item) => item.target_creator_id === creator.id)
          .sort((a, b) => String(b.requested_at || '').localeCompare(String(a.requested_at || '')))[0];
        setActiveCallRequest(callRequest || null);
      } catch (err: any) {
        if (err?.status === 401 || err?.message === 'not authenticated') {
          router.replace('/login');
        }
      }
    }

    loadConnectionState();
    return () => {
      cancelled = true;
    };
  }, [creator, router]);

  useEffect(() => {
    let cancelled = false;

    async function loadSubscriptionState() {
      if (!creator?.id) return;
      try {
        const data = await apiGet<{ subscribed: boolean }>(`/creators/${creator.id}/subscription`);
        if (!cancelled) setIsSubscribedToCreator(Boolean(data.subscribed));
      } catch (err: any) {
        if (err?.status === 401 || err?.message === 'not authenticated') {
          router.replace('/login');
        }
      }
    }

    loadSubscriptionState();
    return () => {
      cancelled = true;
    };
  }, [creator?.id, router]);

  async function onToggleFollow() {
    if (!creator || !userStats) return;
    setFollowBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (userStats.isFollowing) {
        await apiDelete(`/users/${creator.userId}/unfollow`);
        setUserStats((prev) => (prev ? { ...prev, isFollowing: false, followers: Math.max(0, prev.followers - 1) } : prev));
        setCreatorStats((prev) => (prev ? { ...prev, followers: Math.max(0, prev.followers - 1) } : prev));
      } else {
        await apiPost(`/users/${creator.userId}/follow`);
        setUserStats((prev) => (prev ? { ...prev, isFollowing: true, followers: prev.followers + 1 } : prev));
        setCreatorStats((prev) => (prev ? { ...prev, followers: prev.followers + 1 } : prev));
      }
    } catch (err: any) {
      if (err?.status === 401 || err?.message === 'not authenticated') {
        router.replace('/login');
        return;
      }
      setError(err?.body?.error || err?.message || 'follow action failed');
    } finally {
      setFollowBusy(false);
    }
  }

  async function onToggleSubscription() {
    if (!creator) return;
    const previous = isSubscribedToCreator;
    const nextAction = previous ? 'unsubscribe' : 'subscribe';
    setSubscribeBusy(true);
    setSubscriptionAction(nextAction);
    setError(null);
    setNotice(null);
    setIsSubscribedToCreator(!previous);
    try {
      if (previous) {
        await apiDelete(`/creators/${creator.id}/subscription`);
        setNotice('Subscription cancelled.');
        setCreatorStats((prev) =>
          prev ? { ...prev, subscribers: Math.max(0, prev.subscribers - 1) } : prev
        );
      } else {
        trackEvent('subscribe_click', {
          creatorId: creator.id,
          amountCredits: creator.defaultSubscriptionPriceCredits,
          source: 'creator_profile'
        });
        setNotice('Processing subscription...');
        await apiPost('/payments/subscribe', {
          creatorId: creator.id,
          amountCredits: creator.defaultSubscriptionPriceCredits
        });
        setNotice('Subscription completed successfully.');
        setCreatorStats((prev) =>
          prev ? { ...prev, subscribers: prev.subscribers + 1 } : prev
        );
        trackEvent('subscribe_success', {
          creatorId: creator.id,
          amountCredits: creator.defaultSubscriptionPriceCredits,
          source: 'creator_profile'
        });
      }
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
      setError(err?.body?.error || err?.message || (previous ? 'unsubscribe failed' : 'subscription failed'));
    } finally {
      setSubscribeBusy(false);
      setSubscriptionAction(null);
    }
  }

  async function onOpenChat() {
    if (!creator?.chatEnabled) return;
    setChatBusy(true);
    setError(null);
    try {
      const data = await apiPost<{ roomId: string }>('/chat/rooms', { participantUserId: creator.userId });
      setChatRoomId(data.roomId);
    } catch (err: any) {
      if (err?.status === 401 || err?.message === 'not authenticated') {
        router.replace('/login');
        return;
      }
      setError(err?.body?.error || err?.message || 'failed to open direct chat');
    } finally {
      setChatBusy(false);
    }
  }

  async function onRequestCall() {
    if (!creator?.videoCallEnabled) return;
    setCallBusy(true);
    setError(null);
    try {
      const data = await apiPost<{ request: CallRequest }>('/calls/request', { creatorId: creator.id, expiresInSeconds: 300 });
      trackEvent('start_call_request', { creatorId: creator.id, requestId: data?.request?.id ?? null, source: 'creator_profile' });
      setActiveCallRequest(data.request || null);
    } catch (err: any) {
      if (err?.status === 401 || err?.message === 'not authenticated') {
        router.replace('/login');
        return;
      }
      setError(err?.body?.error || err?.message || 'failed to request call');
    } finally {
      setCallBusy(false);
    }
  }

  const creatorName = creator?.displayName || creator?.stageName || 'Creator';
  const capabilityPills = creator
    ? [
        creator.liveEnabled ? 'Live available' : 'Live offline',
        creator.chatEnabled ? 'Direct chat open' : 'Chat unavailable',
        creator.videoCallEnabled ? '1:1 calls open' : 'Calls unavailable'
      ]
    : [];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-6 lg:px-8">
      <div className="relative overflow-hidden rounded-[32px] border border-border bg-surface shadow-card">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(37,99,235,0.26),transparent_36%),radial-gradient(circle_at_top_right,rgba(52,211,153,0.14),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.03),transparent)]" />
        <div className="relative px-6 py-8 md:px-8 md:py-10">
          <div className="max-w-2xl">
            <div className="text-[11px] font-black uppercase tracking-[0.22em] text-muted">Creator Profile</div>
            <h1 className="mt-3 text-4xl font-black tracking-[-0.04em] text-text md:text-5xl">
              {creatorName}
            </h1>
            <div className="mt-2 text-sm text-muted">
              @{creator?.username || 'creator'}
              {creator?.createdAt ? ` · member since ${new Date(creator.createdAt).toLocaleDateString()}` : ''}
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              {capabilityPills.map((item) => (
                <span
                  key={item}
                  className="rounded-full border border-border bg-bg/50 px-3 py-1.5 text-xs font-bold text-muted backdrop-blur"
                >
                  {item}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {busy ? <div className="mt-4 text-muted">Loading...</div> : null}
      {error ? <div className="mt-4 rounded-2xl border border-danger/40 bg-danger/10 px-4 py-3 font-bold text-danger">{error}</div> : null}
      {notice ? <div className="mt-4 rounded-2xl border border-success/40 bg-success/10 px-4 py-3 font-bold text-success">{notice}</div> : null}

      {creator ? (
        <>
          <div className="mt-6 grid gap-6 xl:grid-cols-[1.45fr_0.95fr]">
            <Card className="overflow-hidden rounded-[28px] border-border/90">
              <CardBody className="p-0">
                <div className="grid gap-0 lg:grid-cols-[220px_minmax(0,1fr)]">
                  <div className="relative flex items-center justify-center overflow-hidden border-b border-border bg-[linear-gradient(160deg,rgba(37,99,235,0.24),rgba(15,23,42,0.1))] p-8 lg:min-h-[100%] lg:border-b-0 lg:border-r">
                    <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.08),transparent_60%)]" />
                    <div className="relative flex flex-col items-center gap-4 text-center">
                      <Avatar name={creatorName} src={creator.avatarUrl} size={120} />
                      <CreatorBadge status={creator.verificationStatus} />
                    </div>
                  </div>
                  <div className="p-6 md:p-8">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-3xl font-black tracking-[-0.03em] text-text">{creatorName}</div>
                        <div className="mt-1 text-sm text-muted">@{creator.username || 'creator'}</div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {(creator.categoryTags || []).map((t) => (
                          <Badge key={t}>{t}</Badge>
                        ))}
                      </div>
                    </div>

                    <div className="mt-6 text-[15px] leading-7 text-muted">
                      {creator.about ? creator.about : 'No bio yet.'}
                    </div>

                    <div className="mt-8 grid gap-3 sm:grid-cols-3">
                      <div className="flex min-h-[120px] flex-col justify-between rounded-2xl border border-border bg-surface2/70 px-4 py-4 backdrop-blur">
                        <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted">Subscription</div>
                        <div className="mt-3 text-2xl font-black text-text">
                          {creator.defaultSubscriptionPriceCredits}
                        </div>
                      </div>
                      <div className="flex min-h-[120px] flex-col justify-between rounded-2xl border border-border bg-surface2/70 px-4 py-4 backdrop-blur">
                        <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted">Followers</div>
                        <div className="mt-3 text-2xl font-black text-text">{creatorStats?.followers ?? 0}</div>
                      </div>
                      <div className="flex min-h-[120px] flex-col justify-between rounded-2xl border border-border bg-surface2/70 px-4 py-4 backdrop-blur">
                        <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted">Subscribers</div>
                        <div className="mt-3 text-2xl font-black text-text">{creatorStats?.subscribers ?? 0}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </CardBody>
            </Card>

            <Card className="overflow-hidden rounded-[28px] border-border/90">
              <CardBody className="p-6 md:p-7">
                <div className="text-[11px] font-black uppercase tracking-[0.22em] text-muted">Access & Actions</div>
                <div className="mt-3 text-2xl font-black tracking-[-0.03em] text-text">Premium access</div>
                <div className="mt-2 text-sm leading-6 text-muted">
                  Subscribe for premium catalog access, follow for updates, or start a private conversation directly from this profile.
                </div>

                <div className="mt-6 grid gap-3">
                  <div className="rounded-2xl border border-border bg-surface2/70 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-black text-text">Subscription</div>
                        <div className="mt-1 text-xs text-muted">
                          {isSubscribedToCreator ? 'Premium access is active.' : 'Unlock subscriber-only catalog and premium drops.'}
                        </div>
                      </div>
                      <PriceTag credits={creator.defaultSubscriptionPriceCredits} />
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Button onClick={onToggleSubscription} disabled={subscribeBusy} size="sm" className="w-full">
                      {subscribeBusy
                        ? subscriptionAction === 'unsubscribe'
                          ? 'Unsubscribing...'
                          : 'Subscribing...'
                        : isSubscribedToCreator
                          ? 'Unsubscribe'
                          : 'Subscribe'}
                    </Button>
                    <Button
                      onClick={onToggleFollow}
                      disabled={followBusy || !userStats}
                      variant={!userStats || userStats.isFollowing ? 'secondary' : 'primary'}
                      size="sm"
                      className="w-full"
                    >
                      {followBusy ? (userStats?.isFollowing ? 'Unfollowing...' : 'Following...') : userStats ? (userStats.isFollowing ? 'Unfollow' : 'Follow') : 'Loading...'}
                    </Button>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Button
                      onClick={onOpenChat}
                      disabled={chatBusy || !creator.chatEnabled}
                      variant="secondary"
                      size="sm"
                    >
                      {chatBusy ? 'Opening...' : 'Start chat'}
                    </Button>
                    <Button
                      onClick={onRequestCall}
                      disabled={callBusy || !creator.videoCallEnabled}
                      variant="secondary"
                      size="sm"
                    >
                      {callBusy ? 'Requesting...' : 'Ask for live call'}
                    </Button>
                  </div>

                  <div className="rounded-2xl border border-border bg-bg/40 p-4">
                    <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-muted">Availability</div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Badge variant={creator.liveEnabled ? 'danger' : 'default'}>
                        {creator.liveEnabled ? 'Live enabled' : 'Live disabled'}
                      </Badge>
                      <Badge variant={creator.chatEnabled ? 'accent' : 'default'}>
                        {creator.chatEnabled ? 'Chat enabled' : 'Chat disabled'}
                      </Badge>
                      <Badge variant={creator.videoCallEnabled ? 'success' : 'default'}>
                        {creator.videoCallEnabled ? 'Calls enabled' : 'Calls disabled'}
                      </Badge>
                    </div>
                  </div>

                  {error?.toLowerCase().includes('insufficient credits') ? (
                    <a href="/wallet" className="text-accent underline text-sm">
                      Deposit credits in wallet
                    </a>
                  ) : null}
                </div>
              </CardBody>
            </Card>
          </div>

          <Card className="mt-6 overflow-hidden rounded-[28px] border-border/90">
            <CardBody className="p-6 md:p-7">
              <div className="flex flex-wrap gap-2 rounded-2xl border border-border bg-surface2/60 p-2">
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

              {tabBusy ? <div className="mt-5 text-muted">Loading {activeTab}...</div> : null}

              {activeTab === 'posts' ? (
                <div className="mt-5 grid gap-4">
                  {posts
                    .filter((p) => !p.requiresPayment && p.visibility !== 'exclusive_ppv')
                    .map((p) => (
                      <div key={p.id} className="rounded-2xl border border-border bg-surface2/70 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="font-black text-text">{p.title || 'Untitled post'}</div>
                          <Badge>{p.visibility}</Badge>
                        </div>
                        {p.caption ? <div className="mt-2 text-sm leading-6 text-muted">{p.caption}</div> : null}
                        <div className="mt-3">
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
                <div className="mt-5 grid gap-4">
                  {posts
                    .filter((p) => p.requiresPayment || p.visibility === 'exclusive_ppv')
                    .map((p) => (
                      <div key={p.id} className="rounded-2xl border border-border bg-surface2/70 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="font-black text-text">{p.title || 'Untitled PPV'}</div>
                          <Badge variant="warning">{p.unlockPriceCredits} credits</Badge>
                        </div>
                        {p.caption ? <div className="mt-2 text-sm leading-6 text-muted">{p.caption}</div> : null}
                        <div className="mt-3">
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
                <div className="mt-5">
                  {!isSubscribedToCreator ? (
                    <div className="rounded-2xl border border-warning/40 bg-warning/10 p-4 text-warning">
                      Subscribe to unlock this creator&apos;s subscriber-only catalog.
                    </div>
                  ) : (
                    <div className="grid gap-4">
                      {subscriberCatalog.map((p) => (
                        <div key={p.id} className="rounded-2xl border border-border bg-surface2/70 p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="font-black text-text">{p.title || 'Untitled subscriber item'}</div>
                            <Badge variant="success">Subscriber-only</Badge>
                          </div>
                          {p.caption ? <div className="mt-2 text-sm leading-6 text-muted">{p.caption}</div> : null}
                        </div>
                      ))}
                      {subscriberCatalog.length === 0 ? <div className="text-muted">No subscriber-only items yet.</div> : null}
                    </div>
                  )}
                </div>
              ) : null}
            </CardBody>
          </Card>

          <Card className="mt-6 overflow-hidden rounded-[28px] border-border/90">
            <CardHeader>Private Connection</CardHeader>
            <CardBody className="space-y-5 p-6 md:p-7">
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-2xl border border-border bg-surface2/70 p-5">
                  <div className="text-sm font-black text-text">Direct chat</div>
                  <div className="mt-3">
                    {creator.chatEnabled ? (
                      chatRoomId ? (
                        <Badge variant="success">1:1 chat ready</Badge>
                      ) : (
                        <Button size="sm" onClick={onOpenChat} disabled={chatBusy}>
                          {chatBusy ? 'Opening...' : 'Open direct chat'}
                        </Button>
                      )
                    ) : (
                      <Badge>Chat disabled</Badge>
                    )}
                  </div>
                </div>

                <div className="rounded-2xl border border-border bg-surface2/70 p-5">
                  <div className="text-sm font-black text-text">Video call</div>
                  <div className="mt-1 text-sm text-muted">Call requests and active calls stay inside this same 1:1 creator conversation.</div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {creator.videoCallEnabled ? (
                      activeCallRequest ? (
                        <>
                          <Badge variant={activeCallRequest.status === 'accepted' ? 'success' : 'warning'}>
                            {activeCallRequest.status}
                          </Badge>
                          {activeCallRequest.session_id ? <Badge>Session ready</Badge> : null}
                        </>
                      ) : (
                        <Button size="sm" onClick={onRequestCall} disabled={callBusy}>
                          {callBusy ? 'Requesting...' : 'Request 1:1 call'}
                        </Button>
                      )
                    ) : (
                      <Badge>Calls disabled</Badge>
                    )}
                  </div>
                  {activeCallRequest?.decline_reason ? (
                    <div className="mt-2 text-sm text-danger">Declined: {activeCallRequest.decline_reason}</div>
                  ) : null}
                  {activeCallRequest?.expires_at ? (
                    <div className="mt-2 text-xs text-muted">Request expires {new Date(activeCallRequest.expires_at).toLocaleString()}</div>
                  ) : null}
                </div>
              </div>

              {chatRoomId ? (
                <ChatThreadPanel
                  roomId={chatRoomId}
                  title={`Chat with ${creator.displayName || creator.stageName}`}
                  subtitle="This thread is only between the creator and you."
                />
              ) : null}

              {activeCallRequest?.session_id ? (
                <VideoCallSessionPanel
                  callId={activeCallRequest.session_id}
                  title={`Call with ${creator.displayName || creator.stageName}`}
                  onEnded={() => setActiveCallRequest((prev) => (prev ? { ...prev, session_status: 'ended', status: 'ended' } : prev))}
                />
              ) : null}
            </CardBody>
          </Card>
        </>
      ) : null}
    </div>
  );
}
