"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiPut } from '../../../lib/apiClient';

export default function CreatorOnboardingPage() {
  const router = useRouter();

  const [stageName, setStageName] = useState('');
  const [about, setAbout] = useState('');
  const [categoryTags, setCategoryTags] = useState('');
  const [defaultSubscriptionPriceCredits, setDefaultSubscriptionPriceCredits] = useState('10');
  const [liveEnabled, setLiveEnabled] = useState(true);
  const [videoCallEnabled, setVideoCallEnabled] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const tags = categoryTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      // This updates the creator profile for the authenticated user.
      await apiPut('/creators/me', {
        stageName: stageName.trim() || null,
        about: about.trim() || null,
        categoryTags: tags,
        defaultSubscriptionPriceCredits: Number(defaultSubscriptionPriceCredits),
        liveEnabled,
        videoCallEnabled
      });

      router.replace('/feed/creators');
    } catch (err: any) {
      if (err?.status === 401 || err?.message === 'not authenticated') {
        router.replace('/login');
        return;
      }
      setError(err?.body?.error || err?.message || 'failed to save creator profile');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 520, margin: '60px auto', padding: 16 }}>
      <h1>Creator onboarding</h1>
      <div style={{ color: '#94a3b8', marginTop: 6 }}>
        Set up your creator profile basics. You can refine more details later.
      </div>

      <form onSubmit={onSubmit} style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label>
          <div>Stage name</div>
          <input value={stageName} onChange={(e) => setStageName(e.target.value)} placeholder="e.g. NoirArtist" />
        </label>
        <label>
          <div>About</div>
          <textarea value={about} onChange={(e) => setAbout(e.target.value)} rows={4} />
        </label>
        <label>
          <div>Category tags (comma-separated)</div>
          <input value={categoryTags} onChange={(e) => setCategoryTags(e.target.value)} placeholder="music, gaming, art" />
        </label>
        <label>
          <div>Default subscription price (credits per period)</div>
          <input type="number" min={0} value={defaultSubscriptionPriceCredits} onChange={(e) => setDefaultSubscriptionPriceCredits(e.target.value)} />
        </label>

        <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input type="checkbox" checked={liveEnabled} onChange={(e) => setLiveEnabled(e.target.checked)} />
          <div>Enable live streaming</div>
        </label>
        <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input type="checkbox" checked={videoCallEnabled} onChange={(e) => setVideoCallEnabled(e.target.checked)} />
          <div>Enable video calls</div>
        </label>

        {error ? <div style={{ color: 'crimson' }}>{error}</div> : null}
        <button type="submit" disabled={busy} style={{ background: '#2563eb', color: '#fff', border: 'none', borderRadius: 10, padding: '10px 14px', cursor: 'pointer', fontWeight: 900 }}>
          {busy ? 'Saving...' : 'Save creator profile'}
        </button>
      </form>
    </div>
  );
}

