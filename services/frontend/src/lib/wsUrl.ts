export function normalizeWsUrl(url: string): string {
  const u = url.trim();
  if (u.startsWith("http://")) return u.replace("http://", "ws://");
  if (u.startsWith("https://")) return u.replace("https://", "wss://");
  return u;
}
