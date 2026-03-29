"use client";

import Link from "next/link";
import Avatar from "../ui/Avatar";
import Badge from "../ui/Badge";

export type AvailableCreator = {
  id: string;
  userId: string;
  stageName?: string | null;
  displayName?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
  about?: string | null;
  liveEnabled?: boolean;
  chatEnabled?: boolean;
  videoCallEnabled?: boolean;
};

export default function AvailableCreatorCard({
  creator,
  primaryHref,
  stats
}: {
  creator: AvailableCreator;
  primaryHref: string;
  stats?: {
    isFollowing?: boolean;
    isSubscribed?: boolean;
    verificationStatus?: string;
  };
}) {
  const name = creator.displayName || creator.stageName || creator.username || "Creator";
  return (
    <Link
      href={primaryHref}
      className="block overflow-hidden rounded-2xl border border-border bg-bg shadow-sm no-underline transition hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-card"
    >
      <div className="relative aspect-square w-full bg-surface2">
        <div className="absolute inset-0 bg-gradient-to-b from-transparent via-bg/10 to-bg/90" />
        <div className="relative flex h-full flex-col items-center justify-center gap-5 p-8 text-center sm:p-10">
          <Avatar name={name} src={creator.avatarUrl} size={120} />
          <div className="min-w-0">
            <div className="truncate text-lg font-black text-white">{name}</div>
            <div className="mt-1 truncate text-sm text-muted">@{creator.username || creator.userId.slice(0, 8)}</div>
            {creator.about ? <div className="mt-3 line-clamp-2 text-sm text-muted">{creator.about}</div> : null}
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            {creator.liveEnabled ? <Badge variant="danger">Live</Badge> : null}
            {creator.chatEnabled ? <Badge variant="accent">Chat</Badge> : null}
            {creator.videoCallEnabled ? <Badge variant="success">Calls</Badge> : null}
            {stats?.verificationStatus ? <Badge>{stats.verificationStatus}</Badge> : null}
            {stats?.isFollowing ? <Badge variant="warning">Following</Badge> : null}
            {stats?.isSubscribed ? <Badge variant="success">Subscribed</Badge> : null}
          </div>
        </div>
      </div>
    </Link>
  );
}
