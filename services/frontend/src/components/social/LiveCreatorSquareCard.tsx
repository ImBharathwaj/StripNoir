"use client";

import Link from "next/link";
import Avatar from "../ui/Avatar";
import Badge from "../ui/Badge";
import { displayableMediaUrl } from "../../lib/publicMediaUrl";

export type LiveStreamCardModel = {
  id: string;
  creatorId: string;
  creatorUserId: string;
  title: string;
  description?: string | null;
  streamThumbnailUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  creator?: {
    displayName?: string | null;
    stageName?: string | null;
    username?: string | null;
    avatarUrl?: string | null;
  };
  stats?: {
    activeViewers?: number;
  };
};

export default function LiveCreatorSquareCard({
  stream,
  primaryHref,
  primaryLabel
}: {
  stream: LiveStreamCardModel;
  primaryHref: string;
  primaryLabel: string;
}) {
  const label =
    stream.creator?.displayName || stream.creator?.stageName || stream.creator?.username || "Creator";
  const thumb = stream.streamThumbnailUrl?.trim();
  const thumbSrc = thumb ? displayableMediaUrl(thumb) || thumb : null;
  const avatarSrc = stream.creator?.avatarUrl || null;

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-bg shadow-sm">
      <div className="relative aspect-square w-full bg-surface2">
        {thumbSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbSrc} alt="" className="absolute inset-0 h-full w-full object-cover opacity-35" />
        ) : null}
        <div className="relative flex h-full flex-col items-center justify-center gap-2 p-4">
          <Badge variant="danger" className="absolute left-3 top-3 shadow-md">
            LIVE
          </Badge>
          <Avatar name={label} src={avatarSrc} size={88} />
          <div className="text-center">
            <div className="text-sm font-black text-white">{label}</div>
            <div className="mt-1 line-clamp-2 text-xs text-muted">{stream.title}</div>
            <div className="mt-1 text-[11px] text-muted">{stream.stats?.activeViewers ?? 0} watching</div>
          </div>
        </div>
      </div>
      <div className="border-t border-border p-3">
        <Link
          href={primaryHref}
          className="block w-full rounded-lg bg-accent py-2.5 text-center text-sm font-black text-bg no-underline hover:opacity-90"
        >
          {primaryLabel}
        </Link>
      </div>
    </div>
  );
}
