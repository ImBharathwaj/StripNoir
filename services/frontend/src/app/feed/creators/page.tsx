"use client";

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function LegacyCreatorsFeedPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/creators');
  }, [router]);

  return (
    <div className="py-8 text-center text-muted">Redirecting to creators...</div>
  );
}
