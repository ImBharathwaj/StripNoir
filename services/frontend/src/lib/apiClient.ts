import { clearTokens, loadTokens, saveTokens } from './tokenStore';

const DEFAULT_API_BASE = '';

const inflightGet = new Map<string, Promise<any>>();

/** Short-lived GET response cache (client-only). Keys include token prefix so users do not cross-read. */
const getResponseCache = new Map<string, { expires: number; data: unknown }>();

export function invalidateApiGetCache(pathSubstring?: string) {
  if (!pathSubstring) {
    getResponseCache.clear();
    return;
  }
  for (const k of [...getResponseCache.keys()]) {
    if (k.includes(pathSubstring)) getResponseCache.delete(k);
  }
}

/**
 * Cached GET for read-heavy paths (badge counts, summaries). Always bypasses cache after TTL.
 * Still uses the same auth + inflight dedupe as `apiGet` underneath.
 */
export async function apiGetCached<T = unknown>(path: string, ttlMs: number): Promise<T> {
  const tokens = loadTokens();
  if (!tokens?.accessToken || !tokens?.refreshToken) {
    throw new Error('not authenticated');
  }
  const ck = `${tokens.accessToken.slice(0, 12)}|${path}`;
  const hit = getResponseCache.get(ck);
  const now = Date.now();
  if (hit && hit.expires > now) return hit.data as T;
  const data = await apiGet<T>(path);
  getResponseCache.set(ck, { expires: now + ttlMs, data });
  return data;
}

function apiBase() {
  // Same-origin is expected behind nginx at `/api/v1/...`.
  // Allow override for local dev if needed.
  if (typeof window === 'undefined') return DEFAULT_API_BASE;
  const stored = window.localStorage.getItem('stripnoir_api_base_url');
  return stored ? stored : DEFAULT_API_BASE;
}

async function requestJson(path: string, init: RequestInit) {
  const res = await fetch(`${apiBase()}${path}`, init);
  const text = await res.text();
  const json = text ? safeJsonParse(text) : null;
  const retryAfter = res.headers.get('retry-after');
  const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;

  const msgBase = json?.error || `Request failed (${res.status})`;
  const msg =
    res.status === 429 && retryAfterMs
      ? `${msgBase} (retry in ${Math.ceil(retryAfterMs / 1000)}s)`
      : msgBase;
  if (!res.ok) {
    const err: any = new Error(msg);
    err.status = res.status;
    err.body = json;
    err.retryAfterMs = retryAfterMs;
    err.rateLimitRemaining = res.headers.get('rateLimit-remaining') || res.headers.get('ratelimit-remaining');
    err.rateLimitLimit = res.headers.get('rateLimit-limit') || res.headers.get('ratelimit-limit');
    throw err;
  }
  return json;
}

function safeJsonParse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function refreshAccessToken(refreshToken: string) {
  const data = await requestJson('/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken })
  });

  if (!data?.token || !data?.refreshToken) {
    clearTokens();
    throw new Error('refresh failed (invalid response)');
  }

  saveTokens({
    accessToken: data.token,
    refreshToken: data.refreshToken,
    sessionId: data.sessionId
  });

  return data.token as string;
}

export async function apiGet<T = any>(path: string): Promise<T> {
  const tokens = loadTokens();
  if (!tokens?.accessToken || !tokens?.refreshToken) {
    throw new Error('not authenticated');
  }

  const key = `${tokens.accessToken.slice(0, 12)}|${path}`;
  const existing = inflightGet.get(key);
  if (existing) return existing as Promise<T>;

  try {
    const p = requestJson(`/api/v1${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      cache: 'no-store'
    })
      .finally(() => {
        inflightGet.delete(key);
      });

    inflightGet.set(key, p);
    return await p;
  } catch (e: any) {
    if (e?.status === 401) {
      const freshAccess = await refreshAccessToken(tokens.refreshToken);
      return await requestJson(`/api/v1${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${freshAccess}` },
        cache: 'no-store'
      });
    }
    if (e?.status === 429 && typeof e?.retryAfterMs === 'number' && e.retryAfterMs > 0 && e.retryAfterMs <= 8000) {
      await sleep(e.retryAfterMs);
      return await requestJson(`/api/v1${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
        cache: 'no-store'
      });
    }
    throw e;
  }
}

export async function apiPost<T = any>(path: string, body?: any): Promise<T> {
  const tokens = loadTokens();
  if (!tokens?.accessToken || !tokens?.refreshToken) {
    throw new Error('not authenticated');
  }

  try {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      authorization: `Bearer ${tokens.accessToken}`
    };
    if (payload) headers['content-type'] = 'application/json';

    return await requestJson(`/api/v1${path}`, {
      method: 'POST',
      headers,
      ...(payload ? { body: payload } : {})
    });
  } catch (e: any) {
    if (e?.status === 401) {
      const freshAccess = await refreshAccessToken(tokens.refreshToken);
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string> = {
        authorization: `Bearer ${freshAccess}`
      };
      if (payload) headers['content-type'] = 'application/json';

      return await requestJson(`/api/v1${path}`, {
        method: 'POST',
        headers,
        ...(payload ? { body: payload } : {})
      });
    }
    throw e;
  }
}

export async function apiDelete<T = any>(path: string): Promise<T> {
  const tokens = loadTokens();
  if (!tokens?.accessToken || !tokens?.refreshToken) {
    throw new Error('not authenticated');
  }

  try {
    return await requestJson(`/api/v1${path}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tokens.accessToken}` }
    });
  } catch (e: any) {
    if (e?.status === 401) {
      const freshAccess = await refreshAccessToken(tokens.refreshToken);
      return await requestJson(`/api/v1${path}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${freshAccess}` }
      });
    }
    throw e;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function apiPut<T = any>(path: string, body: any): Promise<T> {
  const tokens = loadTokens();
  if (!tokens?.accessToken || !tokens?.refreshToken) {
    throw new Error('not authenticated');
  }

  try {
    return await requestJson(`/api/v1${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.accessToken}` },
      body: JSON.stringify(body)
    });
  } catch (e: any) {
    if (e?.status === 401) {
      const freshAccess = await refreshAccessToken(tokens.refreshToken);
      return await requestJson(`/api/v1${path}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${freshAccess}` },
        body: JSON.stringify(body)
      });
    }
    throw e;
  }
}
