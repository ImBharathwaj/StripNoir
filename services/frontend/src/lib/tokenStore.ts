// Simple MVP storage for auth tokens (until cookie/BFF is introduced).
// Keep token handling minimal and browser-only.

export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  sessionId?: string;
};

const ACCESS_KEY = 'stripnoir_access_token';
const REFRESH_KEY = 'stripnoir_refresh_token';
const SESSION_KEY = 'stripnoir_session_id';

export function loadTokens(): AuthTokens | null {
  if (typeof window === 'undefined') return null;
  const accessToken = window.localStorage.getItem(ACCESS_KEY) || '';
  const refreshToken = window.localStorage.getItem(REFRESH_KEY) || '';
  const sessionId = window.localStorage.getItem(SESSION_KEY) || undefined;

  if (!accessToken || !refreshToken) return null;
  return { accessToken, refreshToken, sessionId };
}

export function saveTokens(tokens: Partial<AuthTokens>) {
  if (typeof window === 'undefined') return;
  if (tokens.accessToken) window.localStorage.setItem(ACCESS_KEY, tokens.accessToken);
  if (tokens.refreshToken) window.localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
  if (tokens.sessionId) window.localStorage.setItem(SESSION_KEY, tokens.sessionId);
}

export function clearTokens() {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(ACCESS_KEY);
  window.localStorage.removeItem(REFRESH_KEY);
  window.localStorage.removeItem(SESSION_KEY);
}

