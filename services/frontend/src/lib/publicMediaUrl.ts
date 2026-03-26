/**
 * Browser-reachable base for MinIO/S3 objects (path-style: `${base}/${bucket}/${objectKey}`).
 * Set `NEXT_PUBLIC_MEDIA_PUBLIC_BASE` in env (e.g. http://localhost:19000).
 */
export function getMediaPublicBase(): string {
  if (typeof window !== 'undefined') {
    const ls = window.localStorage.getItem('stripnoir_media_public_base');
    if (ls) return ls.replace(/\/$/, '');
  }
  const env = process.env.NEXT_PUBLIC_MEDIA_PUBLIC_BASE;
  if (env) return env.replace(/\/$/, '');
  return 'http://localhost:19000';
}

/** Match API `rfc3986Encode` / `encodeObjectKey` so GET URLs match PUT presign paths. */
function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function publicObjectUrl(bucket: string, objectKey: string): string {
  const base = getMediaPublicBase();
  const encodedPath = String(objectKey)
    .split('/')
    .map((seg) => rfc3986Encode(seg))
    .join('/');
  return `${base}/${rfc3986Encode(bucket)}/${encodedPath}`;
}

/** Same-origin URL: API 302 → presigned MinIO GET (no public bucket needed). */
export function buildMediaPublicReadPath(bucket: string, objectKey: string): string {
  const q = new URLSearchParams({ bucket, key: objectKey });
  return `/api/v1/media/public-read?${q.toString()}`;
}

/** Range-safe video proxy (same query params as public-read). */
export function buildMediaPublicStreamPath(bucket: string, objectKey: string): string {
  const q = new URLSearchParams({ bucket, key: objectKey });
  return `/api/v1/media/public-stream?${q.toString()}`;
}

/** Mirrors API `PUBLIC_MEDIA_KEY_RE` for client-side fallback URLs. */
const PROXYABLE_OBJECT_KEY_RE = /^(uploads|content|subscription-content)\/[\da-f-]{36}\/[\da-f-]{36}$/i;

export function getDefaultMediaBucket(): string {
  const env = process.env.NEXT_PUBLIC_MINIO_BUCKET;
  if (env && String(env).trim()) return String(env).trim();
  return 'stripnoir';
}

/** Normalize DB/API snake_case and client camelCase on media rows. */
export function normalizeMediaAssetFields(asset: Record<string, unknown>) {
  const objectKey = String(asset.objectKey ?? asset.object_key ?? '').trim();
  const rawBucket = String(asset.storageBucket ?? asset.storage_bucket ?? '').trim();
  const storageBucket = rawBucket || getDefaultMediaBucket();
  const mimeType = String(asset.mimeType ?? asset.mime_type ?? '').toLowerCase();
  const mediaType = String(asset.mediaType ?? asset.media_type ?? '').toLowerCase();
  const metadata = (asset.metadata as Record<string, unknown> | null | undefined) || {};
  return { objectKey, storageBucket, mimeType, mediaType, metadata };
}

export function isVideoMediaAsset(asset: Record<string, unknown>): boolean {
  const { objectKey, mimeType, mediaType } = normalizeMediaAssetFields(asset);
  const key = objectKey.toLowerCase();
  return (
    mimeType.startsWith('video/') ||
    mediaType === 'video' ||
    key.endsWith('.mp4') ||
    key.endsWith('.webm') ||
    key.endsWith('.mov')
  );
}

/**
 * Resolve a browser-usable URL for a `media_asset` row: metadata URLs first, then bucket+object_key via API proxy.
 */
export function resolveMediaAssetUrl(asset: Record<string, unknown>, forVideo: boolean): string | null {
  const { objectKey, storageBucket, metadata } = normalizeMediaAssetFields(asset);
  const m = metadata || {};
  const maybeUrl =
    m.playbackUrl ||
    m.playback_url ||
    m.publicUrl ||
    m.public_url ||
    m.url ||
    m.cdnUrl ||
    m.downloadUrl ||
    null;
  if (maybeUrl) {
    const raw = String(maybeUrl);
    if (forVideo) {
      return displayableVideoUrl(raw) || displayableMediaUrl(raw) || raw || null;
    }
    return displayableMediaUrl(raw) || raw || null;
  }
  if (objectKey && storageBucket && PROXYABLE_OBJECT_KEY_RE.test(objectKey)) {
    if (forVideo) {
      return buildMediaPublicStreamPath(storageBucket, objectKey);
    }
    return buildMediaPublicReadPath(storageBucket, objectKey);
  }
  return null;
}

/**
 * Turn stored direct-MinIO URLs into `/api/v1/media/public-read?...` so images load via presigned redirect.
 * Leaves blob:, data:, and already-proxied URLs unchanged.
 */
export function displayableMediaUrl(stored: string | null | undefined): string | undefined {
  if (!stored?.trim()) return undefined;
  const s = stored.trim();
  if (s.startsWith('blob:') || s.startsWith('data:')) return s;
  if (s.startsWith('/api/v1/media/public-read')) return s;
  if (s.includes('/api/v1/media/public-read')) {
    try {
      const u = new URL(s);
      return `${u.pathname}${u.search}`;
    } catch {
      return s;
    }
  }
  try {
    const publicBase = getMediaPublicBase();
    const publicHost = new URL(publicBase).host;
    const abs = s.startsWith('http') ? new URL(s) : new URL(s, typeof window !== 'undefined' ? window.location.origin : publicBase);
    const pathStyleMedia = /^\/[^/]+\/(uploads|content|subscription-content)\/[\da-f-]{36}\/[\da-f-]{36}/i.test(
      abs.pathname
    );
    if (abs.host !== publicHost && !pathStyleMedia) return s;
    const segs = abs.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
    if (segs.length < 3) return s;
    const [bkt, ...rest] = segs;
    const key = rest.join('/');
    return buildMediaPublicReadPath(bkt, key);
  } catch {
    return s;
  }
}

/**
 * Video must use streaming proxy (Range-safe). Redirect-only public-read breaks HTML5 video seeking/playback.
 */
export function displayableVideoUrl(stored: string | null | undefined): string | undefined {
  if (!stored?.trim()) return undefined;
  const s = stored.trim();
  if (s.startsWith('blob:') || s.startsWith('data:')) return s;
  if (s.startsWith('/api/v1/media/public-stream')) return s;
  const viaRead = displayableMediaUrl(s);
  if (!viaRead) return undefined;
  if (viaRead.startsWith('/api/v1/media/public-read')) {
    return viaRead.replace('/api/v1/media/public-read', '/api/v1/media/public-stream');
  }
  return viaRead;
}
