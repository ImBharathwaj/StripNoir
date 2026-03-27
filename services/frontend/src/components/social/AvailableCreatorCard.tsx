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
  primaryLabel
}: {
  creator: AvailableCreator;
  primaryHref: string;
  primaryLabel: string;
}) {
  const name = creator.displayName || creator.stageName || creator.username || "Creator";
  return (
    <div className="rounded-2xl border border-border bg-bg p-4">
      <div className="flex items-start gap-3">
        <Avatar name={name} src={creator.avatarUrl} size={56} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-black text-white">{name}</div>
          <div className="truncate text-xs text-muted">@{creator.username || creator.userId.slice(0, 8)}</div>
          {creator.about ? <div className="mt-1 line-clamp-2 text-xs text-muted">{creator.about}</div> : null}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {creator.liveEnabled ? <Badge variant="danger">Live</Badge> : null}
            {creator.chatEnabled ? <Badge variant="accent">Chat</Badge> : null}
            {creator.videoCallEnabled ? <Badge variant="success">Calls</Badge> : null}
          </div>
        </div>
      </div>
      <div className="mt-3">
        <Link
          href={primaryHref}
          className="block w-full rounded-lg bg-accent py-2 text-center text-sm font-black text-bg no-underline hover:opacity-90"
        >
          {primaryLabel}
        </Link>
      </div>
    </div>
  );
}
