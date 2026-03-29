"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiGet } from "../lib/apiClient";
import { AUTH_CHANGED_EVENT } from "../lib/authEvents";
import { loadTokens } from "../lib/tokenStore";

export type SessionUser = {
  id: string;
  email?: string;
  username?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  bio?: string | null;
  status?: string;
  createdAt?: string;
  role?: string;
};

export type SessionCreatorProfile = {
  id: string;
  userId: string;
  stageName: string;
  about?: string | null;
  categoryTags: string[];
  isNsfw?: boolean;
  verificationStatus: string;
  defaultSubscriptionPriceCredits: number;
  liveEnabled?: boolean;
  chatEnabled?: boolean;
  videoCallEnabled?: boolean;
} | null;

type MeResponse = {
  user: SessionUser;
  creatorProfile: SessionCreatorProfile;
};

type Ctx = {
  user: SessionUser | null;
  creatorProfile: SessionCreatorProfile;
  isCreator: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

const AppSessionContext = createContext<Ctx | null>(null);

export function AppSessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [creatorProfile, setCreatorProfile] = useState<SessionCreatorProfile>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const tokens = loadTokens();
    if (!tokens?.accessToken) {
      setUser(null);
      setCreatorProfile(null);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<MeResponse>("/auth/me");
      setUser(data.user || null);
      setCreatorProfile(data.creatorProfile ?? null);
    } catch (e: any) {
      if (e?.status === 401 || e?.message === "not authenticated") {
        setUser(null);
        setCreatorProfile(null);
      } else {
        setError(e?.body?.error || e?.message || "session load failed");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    function onAuth() {
      refresh();
    }
    window.addEventListener(AUTH_CHANGED_EVENT, onAuth);
    return () => window.removeEventListener(AUTH_CHANGED_EVENT, onAuth);
  }, [refresh]);

  const value = useMemo<Ctx>(
    () => ({
      user,
      creatorProfile,
      isCreator: Boolean(creatorProfile?.id),
      loading,
      error,
      refresh
    }),
    [user, creatorProfile, loading, error, refresh]
  );

  return <AppSessionContext.Provider value={value}>{children}</AppSessionContext.Provider>;
}

export function useAppSession() {
  const ctx = useContext(AppSessionContext);
  if (!ctx) {
    throw new Error("useAppSession must be used within AppSessionProvider");
  }
  return ctx;
}
