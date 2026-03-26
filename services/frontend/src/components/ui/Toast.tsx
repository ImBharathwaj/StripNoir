"use client";

import Link from 'next/link';
import { useEffect, useState } from 'react';

export type ToastItem = {
  id: string;
  title: string;
  body?: string;
  /** In-app path (e.g. `/wallet`) */
  href?: string;
  linkLabel?: string;
};

export default function Toast({ toast, onDone, ttlMs = 4500 }: { toast: ToastItem; onDone: () => void; ttlMs?: number }) {
  const [show, setShow] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setShow(false), ttlMs);
    return () => clearTimeout(t);
  }, [ttlMs]);

  useEffect(() => {
    if (!show) {
      const t = setTimeout(onDone, 250);
      return () => clearTimeout(t);
    }
  }, [show, onDone]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={`pointer-events-auto w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface shadow-card px-4 py-3 transition ${
        show ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
      }`}
    >
      <div className="font-black text-text">{toast.title}</div>
      {toast.body ? <div className="mt-1 text-sm text-muted">{toast.body}</div> : null}
      {toast.href ? (
        <Link
          href={toast.href}
          className="mt-2 inline-block text-sm font-bold text-accent underline"
          onClick={() => setShow(false)}
        >
          {toast.linkLabel || 'Open'}
        </Link>
      ) : null}
    </div>
  );
}

