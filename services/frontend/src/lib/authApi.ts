import { notifyAuthChanged } from './authEvents';
import { clearTokens, loadTokens, saveTokens } from './tokenStore';

type LoginInput = {
  email: string;
  password: string;
};

type RegisterInput = {
  displayName: string;
  email: string;
  password: string;
  // optional but supported by backend schema
  username?: string;
};

export type RegisterCreatorInput = RegisterInput & {
  stageName: string;
  about?: string;
  categoryTags?: string[];
  defaultSubscriptionPriceCredits?: number;
  isNsfw?: boolean;
};

export async function login(input: LoginInput) {
  const res = await fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });

  const text = await res.text();
  const data = text ? safeJsonParse(text) : null;

  if (!res.ok) {
    const msg = data?.error || `Login failed (${res.status})`;
    const err: any = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }

  if (!data?.token || !data?.refreshToken) {
    clearTokens();
    throw new Error('login failed (invalid response)');
  }

  saveTokens({
    accessToken: data.token,
    refreshToken: data.refreshToken,
    sessionId: data.sessionId
  });
  notifyAuthChanged();

  return data;
}

export async function register(input: RegisterInput) {
  const res = await fetch('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });

  const text = await res.text();
  const data = text ? safeJsonParse(text) : null;

  if (!res.ok) {
    const msg = data?.error || `Register failed (${res.status})`;
    const err: any = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }

  return data;
}

export async function registerCreator(input: RegisterCreatorInput) {
  const res = await fetch('/api/v1/auth/register/creator', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input)
  });

  const text = await res.text();
  const data = text ? safeJsonParse(text) : null;

  if (!res.ok) {
    const msg = data?.error || `Register failed (${res.status})`;
    const err: any = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }

  if (!data?.token || !data?.refreshToken) {
    clearTokens();
    throw new Error('register failed (invalid response)');
  }

  saveTokens({
    accessToken: data.token,
    refreshToken: data.refreshToken,
    sessionId: data.sessionId
  });
  notifyAuthChanged();

  return data;
}

export async function logout() {
  const tokens = loadTokens();
  try {
    if (tokens?.refreshToken) {
      await fetch('/api/v1/auth/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: tokens.refreshToken })
      });
    }
  } finally {
    clearTokens();
    notifyAuthChanged();
  }
}

function safeJsonParse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

