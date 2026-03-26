"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiDelete, apiGet, apiPost } from '../../../lib/apiClient';
import Button from '../../../components/ui/Button';
import Input from '../../../components/ui/Input';
import { Card, CardBody } from '../../../components/ui/Card';
import Badge from '../../../components/ui/Badge';
import Avatar from '../../../components/ui/Avatar';
import CreatorBadge from '../../../components/ui/CreatorBadge';
import PriceTag from '../../../components/ui/PriceTag';

type CreatorCard = {
  creator: {
    id: string;
    userId: string;
    stageName?: string;
    displayName?: string;
    username?: string;
    avatarUrl?: string;
    about?: string;
    categoryTags?: string[];
    verificationStatus?: string;
  };
  stats: {
    activeSubscribers: number;
    subscriptionPriceCredits: number;
  };
  viewer: {
    isFollowing: boolean;
    isSubscribed: boolean;
  };
};

export default function CreatorsFeedPage() {
  const router = useRouter();
  const [creators, setCreators] = useState<CreatorCard[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [verificationStatus, setVerificationStatus] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setBusy(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ limit: '20', offset: '0' });
        if (search.trim()) qs.set('search', search.trim());
        if (category.trim()) qs.set('category', category.trim());
        if (verificationStatus.trim()) qs.set('verification_status', verificationStatus.trim());

        const data = await apiGet<{ creators: CreatorCard[] }>(`/feed/creators?${qs.toString()}`);
        if (!cancelled) setCreators(data.creators || []);
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
  }, [router, search, category, verificationStatus]);

  async function onToggleFollow(card: CreatorCard) {
    try {
      if (card.viewer.isFollowing) {
        await apiDelete(`/users/${card.creator.userId}/unfollow`);
        setCreators((prev) =>
          prev.map((c) =>
            c.creator.id === card.creator.id
              ? { ...c, viewer: { ...c.viewer, isFollowing: false } }
              : c
          )
        );
      } else {
        await apiPost(`/users/${card.creator.userId}/follow`);
        setCreators((prev) =>
          prev.map((c) =>
            c.creator.id === card.creator.id
              ? { ...c, viewer: { ...c.viewer, isFollowing: true } }
              : c
          )
        );
      }
    } catch (err: any) {
      if (err?.status === 401 || err?.message === 'not authenticated') {
        router.replace('/login');
        return;
      }
      setError(err?.body?.error || err?.message || 'follow action failed');
    }
  }

  const categoryOptions = Array.from(
    new Set(
      creators.flatMap((c) => (c.creator.categoryTags || []).map((t) => t.trim()).filter(Boolean))
    )
  ).slice(0, 12);

  return (
    <div className="py-4">
      <h1>Discover Creators</h1>
      <div className="mt-2 text-muted">
        Browse verified and emerging creators, compare pricing, then follow or subscribe.
      </div>
      {error ? <div className="mt-3 text-danger font-bold">{error}</div> : null}

      <Card className="mt-4">
        <CardBody className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by username, display name, stage name, about..."
              aria-label="Search creators"
              onKeyDown={(e) => {
                if (e.key === 'Enter') setSearch(searchInput);
              }}
            />
            <Button onClick={() => setSearch(searchInput)} variant="primary">
              Search
            </Button>
            <Button
              onClick={() => {
                setSearchInput('');
                setSearch('');
                setCategory('');
                setVerificationStatus('');
              }}
              variant="secondary"
            >
              Reset
            </Button>
          </div>

          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by verification status">
            <Button
              variant={verificationStatus === '' ? 'primary' : 'secondary'}
              size="sm"
              aria-pressed={verificationStatus === ''}
              onClick={() => setVerificationStatus('')}
            >
              All
            </Button>
            <Button
              variant={verificationStatus === 'approved' ? 'primary' : 'secondary'}
              size="sm"
              aria-pressed={verificationStatus === 'approved'}
              onClick={() => setVerificationStatus('approved')}
            >
              Verified
            </Button>
            <Button
              variant={verificationStatus === 'pending' ? 'primary' : 'secondary'}
              size="sm"
              aria-pressed={verificationStatus === 'pending'}
              onClick={() => setVerificationStatus('pending')}
            >
              Pending
            </Button>
            <Button
              variant={verificationStatus === 'rejected' ? 'primary' : 'secondary'}
              size="sm"
              aria-pressed={verificationStatus === 'rejected'}
              onClick={() => setVerificationStatus('rejected')}
            >
              Rejected
            </Button>
          </div>

          {categoryOptions.length > 0 ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by category">
              <Button variant={category === '' ? 'primary' : 'secondary'} size="sm" aria-pressed={category === ''} onClick={() => setCategory('')}>
                Any category
              </Button>
              {categoryOptions.map((t) => (
                <Button
                  key={t}
                  variant={category === t ? 'primary' : 'secondary'}
                  size="sm"
                  aria-pressed={category === t}
                  onClick={() => setCategory(t)}
                >
                  {t}
                </Button>
              ))}
            </div>
          ) : null}
        </CardBody>
      </Card>

      {busy ? <div className="mt-4 text-muted">Loading creators...</div> : null}

      <div className="mt-4 grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {creators.map((card) => (
          <Card key={card.creator.id}>
            <CardBody>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <Avatar
                    name={card.creator.displayName || card.creator.stageName || card.creator.username}
                    src={card.creator.avatarUrl}
                    size={46}
                  />
                  <div>
                    <Link href={`/creators/${card.creator.id}`} className="text-text text-lg font-black hover:underline">
                      {card.creator.displayName || card.creator.stageName || card.creator.username || 'Creator'}
                    </Link>
                    <div className="mt-1">
                      <CreatorBadge status={card.creator.verificationStatus} />
                    </div>
                  </div>
                </div>

                <div className="text-right">
                  <PriceTag credits={card.stats.subscriptionPriceCredits} />
                  <div className="mt-2 text-xs text-muted">{card.stats.activeSubscribers} subscribers</div>
                </div>
              </div>

              <div className="mt-3 text-sm text-muted min-h-[40px]">
                {card.creator.about ? card.creator.about.slice(0, 120) : 'No bio yet.'}
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {(card.creator.categoryTags || []).slice(0, 4).map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
              </div>

              <div className="mt-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {card.viewer.isSubscribed ? <Badge variant="success">Subscribed</Badge> : null}
                  {card.viewer.isFollowing ? <Badge variant="accent">Following</Badge> : null}
                </div>
                <Button
                  onClick={() => onToggleFollow(card)}
                  variant={card.viewer.isFollowing ? 'secondary' : 'primary'}
                  size="sm"
                  aria-label={
                    card.viewer.isFollowing
                      ? `Unfollow ${card.creator.displayName || card.creator.stageName || card.creator.username || 'creator'}`
                      : `Follow ${card.creator.displayName || card.creator.stageName || card.creator.username || 'creator'}`
                  }
                >
                  {card.viewer.isFollowing ? 'Unfollow' : 'Follow'}
                </Button>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      {!busy && creators.length === 0 ? (
        <div className="mt-6 rounded-xl border border-border bg-surface2 p-4 text-muted">
          No creators match your filters.
        </div>
      ) : null}
    </div>
  );
}

