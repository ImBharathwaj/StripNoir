"use client";

import { useEffect, useState } from 'react';

export default function NetworkBanner() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    // On initial hydration.
    setOnline(typeof navigator !== 'undefined' ? navigator.onLine : true);

    function handleOnline() {
      setOnline(true);
    }
    function handleOffline() {
      setOnline(false);
    }

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (online) return null;

  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 1000,
        background: '#7f1d1d',
        color: '#fff',
        padding: '10px 12px',
        textAlign: 'center',
        fontWeight: 900
      }}
    >
      You are offline. Actions may fail.
    </div>
  );
}

