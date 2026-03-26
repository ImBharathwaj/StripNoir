export type FeedOrientation = "portrait" | "landscape" | "square" | "unknown";

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Read width/height from API row (snake_case or camelCase) or nested metadata. */
export function getAssetDimensions(asset: Record<string, unknown>): { w: number | null; h: number | null } {
  const meta = (asset.metadata as Record<string, unknown> | undefined) || {};
  return {
    w: num(
      asset.width ??
        asset.video_width ??
        (asset as { videoWidth?: unknown }).videoWidth ??
        meta.width ??
        meta.videoWidth
    ),
    h: num(
      asset.height ??
        asset.video_height ??
        (asset as { videoHeight?: unknown }).videoHeight ??
        meta.height ??
        meta.videoHeight
    )
  };
}

export function orientationFromDimensions(w: number | null, h: number | null): FeedOrientation {
  if (w == null || h == null) return "unknown";
  const r = h / w;
  if (r > 1.08) return "portrait";
  if (r < 0.92) return "landscape";
  return "square";
}
