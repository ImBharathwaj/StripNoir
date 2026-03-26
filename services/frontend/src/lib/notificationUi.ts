/** Normalize REST (snake_case) and WS (camelCase) notification payloads. */

export type NormalizedNotification = {
  id: string;
  type: string;
  status: string;
  title: string;
  body: string | null;
  deepLink: string | null;
  createdAt: string | null;
  readAt: string | null;
};

export function normalizeNotification(raw: Record<string, any> | null | undefined): NormalizedNotification | null {
  if (!raw || !raw.id) return null;
  return {
    id: String(raw.id),
    type: String(raw.type || 'general'),
    status: String(raw.status || 'unread'),
    title: String(raw.title || raw.type || 'Notification'),
    body: raw.body != null ? String(raw.body) : null,
    deepLink: (raw.deepLink ?? raw.deep_link ?? null) != null ? String(raw.deepLink ?? raw.deep_link) : null,
    createdAt: (raw.createdAt ?? raw.created_at ?? null) != null ? String(raw.createdAt ?? raw.created_at) : null,
    readAt: (raw.readAt ?? raw.read_at ?? null) != null ? String(raw.readAt ?? raw.read_at) : null
  };
}

export function iconForNotificationType(type: string): string {
  const t = (type || '').toLowerCase();
  if (t.includes('tip')) return '💸';
  if (t.includes('live') || t.includes('stream')) return '🔴';
  if (t.includes('call') || t.includes('video')) return '📞';
  if (t.includes('chat') || t.includes('message') || t.includes('dm')) return '💬';
  if (t.includes('sub')) return '⭐';
  if (t.includes('pay') || t.includes('wallet') || t.includes('credit') || t.includes('deposit')) return '💳';
  if (t.includes('follow')) return '➕';
  if (t.includes('mod') || t.includes('report') || t.includes('block')) return '🛡️';
  return '🔔';
}

/** Turn stored deep links into in-app paths (handles absolute URLs). */
export function appPathFromDeepLink(link: string | null | undefined): string | null {
  if (link == null) return null;
  const s = String(link).trim();
  if (!s) return null;
  if (s.startsWith('/')) return s;
  try {
    const u = new URL(s);
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}
