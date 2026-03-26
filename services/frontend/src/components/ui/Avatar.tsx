"use client";

import { displayableMediaUrl } from '../../lib/publicMediaUrl';

export default function Avatar({
  name,
  src,
  size = 44
}: {
  name?: string | null;
  src?: string | null;
  size?: number;
}) {
  const initials = (name || 'SN')
    .split(' ')
    .map((s) => s.trim()[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const displaySrc = src ? displayableMediaUrl(src) || src : null;

  if (displaySrc) {
    return (
      <img
        src={displaySrc}
        alt={name || 'avatar'}
        width={size}
        height={size}
        className="shrink-0 overflow-hidden rounded-full border border-border object-cover"
      />
    );
  }

  return (
    <div
      className="shrink-0 overflow-hidden rounded-full border border-border bg-surface2 text-white font-black flex items-center justify-center"
      style={{ width: size, height: size }}
      aria-label={name || 'avatar'}
      title={name || 'avatar'}
    >
      {initials || 'SN'}
    </div>
  );
}

