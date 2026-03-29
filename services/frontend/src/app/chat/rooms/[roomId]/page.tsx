"use client";

import Link from 'next/link';
import { useParams } from 'next/navigation';
import ChatThreadPanel from '../../../../components/social/ChatThreadPanel';

export default function ChatRoomPage() {
  const params = useParams();
  const roomId = String((params as any).roomId || '');

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-[11px] font-black uppercase tracking-[0.22em] text-muted">Messages</div>
          <h1 className="mt-2 text-3xl font-black tracking-[-0.03em] text-text">Direct conversation</h1>
          <p className="mt-2 text-sm text-muted">A private thread between you and the creator.</p>
        </div>
        <Link href="/creators" className="rounded-full border border-border px-4 py-2 text-sm font-black text-text no-underline hover:bg-surface2">
          Browse creators
        </Link>
      </div>
      <ChatThreadPanel roomId={roomId} title="1:1 direct chat" subtitle="Private conversation with realtime delivery." />
    </div>
  );
}
