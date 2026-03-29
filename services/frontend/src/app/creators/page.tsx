"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet } from '../../lib/apiClient';
import AvailableCreatorCard from '../../components/social/AvailableCreatorCard';
import { useAppSession } from '../../context/AppSessionContext';

type CreatorRow = {
  creator: {
    id: string;
    userId: string;
    stageName?: string | null;
    username?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    about?: string | null;
    verificationStatus?: string;
    defaultSubscriptionPriceCredits?: number;
    liveEnabled?: boolean;
    chatEnabled?: boolean;
    videoCallEnabled?: boolean;
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

export default function CreatorsPage() {
  const router = useRouter();
  const { user, creatorProfile } = useAppSession();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creators, setCreators] = useState<CreatorRow[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setBusy(true);
      setError(null);
      try {
        const data = await apiGet<{ creators: CreatorRow[] }>('/feed/creators?limit=100&offset=0');
        const items = data.creators || [];
        const hasCurrentCreator =
          creatorProfile?.id && items.some(({ creator }) => creator.id === creatorProfile.id);

        const mergedCreators =
          creatorProfile?.id && user && !hasCurrentCreator
            ? [
                {
                  creator: {
                    id: creatorProfile.id,
                    userId: creatorProfile.userId,
                    stageName: creatorProfile.stageName,
                    username: user.username || null,
                    displayName: user.displayName || null,
                    avatarUrl: user.avatarUrl || null,
                    about: creatorProfile.about || user.bio || null,
                    verificationStatus: creatorProfile.verificationStatus,
                    defaultSubscriptionPriceCredits: creatorProfile.defaultSubscriptionPriceCredits,
                    liveEnabled: creatorProfile.liveEnabled,
                    chatEnabled: creatorProfile.chatEnabled,
                    videoCallEnabled: creatorProfile.videoCallEnabled
                  },
                  stats: {
                    activeSubscribers: 0,
                    subscriptionPriceCredits: creatorProfile.defaultSubscriptionPriceCredits
                  },
                  viewer: {
                    isFollowing: false,
                    isSubscribed: false
                  }
                },
                ...items
              ]
            : items;

        if (!cancelled) setCreators(mergedCreators);
      } catch (err: any) {
        if (err?.status === 401 || err?.message === 'not authenticated') {
          router.replace('/login');
          return;
        }
        if (!cancelled) setError(err?.body?.error || err?.message || 'failed to load creators');
      } finally {
        if (!cancelled) setBusy(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [creatorProfile, router, user]);

  return (
    <div className="mx-auto w-full max-w-[1500px] px-6 py-6 sm:px-8 xl:px-10">
      <div className="mx-auto max-w-[1320px]">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-black tracking-tight text-white">Creators</h1>
            <div className="mt-1 text-sm text-muted">
              Available creators with profile photos and profile links.
            </div>
          </div>
        </div>

        {error ? <div className="mt-3 text-center font-bold text-danger">{error}</div> : null}
        {busy ? <div className="mt-3 text-center text-muted">Loading creators...</div> : null}

        <div className="mt-8 grid justify-items-center gap-8 md:grid-cols-2 2xl:grid-cols-3">
          {creators.map(({ creator, stats, viewer }) => (
            <div key={creator.id} className="w-full max-w-[380px]">
              <AvailableCreatorCard
                creator={creator}
                primaryHref={`/creators/${creator.id}`}
                stats={{
                  isFollowing: viewer.isFollowing,
                  isSubscribed: viewer.isSubscribed,
                  verificationStatus: creator.verificationStatus
                }}
              />
            </div>
          ))}
        </div>

        {!busy && creators.length === 0 ? (
          <div className="mt-6 rounded-xl border border-border bg-surface2 p-4 text-center text-muted">
            No creators available right now.
          </div>
        ) : null}
      </div>
    </div>
  );
}
