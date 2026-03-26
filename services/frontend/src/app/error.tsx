"use client";

import { useEffect } from 'react';
import Button from '../components/ui/Button';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Keep it minimal; real logging can be added later.
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <h1>Something went wrong</h1>
      <div className="mt-3 text-muted">
        Try again. If the issue persists, refresh the page.
      </div>

      <div className="mt-6 flex gap-3">
        <Button onClick={reset} variant="primary">
          Try again
        </Button>
        <Button onClick={() => location.reload()} variant="secondary">
          Reload
        </Button>
      </div>
    </div>
  );
}

