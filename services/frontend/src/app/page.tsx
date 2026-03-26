"use client";

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { loadTokens } from '../lib/tokenStore';

export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    const tokens = loadTokens();
    // If the user has tokens, go to /me; otherwise go to /login.
    router.replace(tokens?.refreshToken ? '/me' : '/login');
  }, [router]);

  // This component only redirects; render nothing.
  return null;
}

