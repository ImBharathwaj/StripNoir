"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiGet, apiPost } from '../../../lib/apiClient';
import Input from '../../../components/ui/Input';
import Button from '../../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../../components/ui/Card';
import Badge from '../../../components/ui/Badge';
import Avatar from '../../../components/ui/Avatar';
import LiveCreatorSquareCard, { type LiveStreamCardModel } from '../../../components/social/LiveCreatorSquareCard';

type ChatRoomSummary = {
  id: string;
  roomType: string;
  subject?: string | null;
  otherParticipant: {
    userId: string;
    username?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
  } | null;
  lastMessage: {
    id: string;
    senderUserId: string;
    body: string | null;
    status: string;
    sentAt?: string | null;
  } | null;
  unreadCount: number;
};

export default function ChatRoomsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [rooms, setRooms] = useState<ChatRoomSummary[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [participantUserId, setParticipantUserId] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [liveStreams, setLiveStreams] = useState<LiveStreamCardModel[]>([]);

  useEffect(() => {
    const p = searchParams.get('participant');
    if (p?.trim()) setParticipantUserId(p.trim());
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setBusy(true);
      setError(null);
      try {
        const [summary, liveData] = await Promise.all([
          apiGet<{ rooms: ChatRoomSummary[] }>('/chat/rooms/summary'),
          apiGet<{ streams: LiveStreamCardModel[] }>('/streams/live').catch(() => ({ streams: [] as LiveStreamCardModel[] }))
        ]);
        if (!cancelled) {
          setRooms(summary.rooms || []);
          setLiveStreams(liveData.streams || []);
        }
      } catch (err: any) {
        if (err?.status === 401 || err?.message === 'not authenticated') {
          router.replace('/login');
          return;
        }
        if (!cancelled) setError(err?.body?.error || err?.message || 'failed to load rooms');
      } finally {
        if (!cancelled) setBusy(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function onCreateRoom(e: React.FormEvent) {
    e.preventDefault();
    setCreateBusy(true);
    setError(null);
    try {
      const data = await apiPost<{ roomId: string }>('/chat/rooms', { participantUserId: participantUserId.trim() });
      router.replace(`/chat/rooms/${data.roomId}`);
    } catch (err: any) {
      if (err?.status === 401 || err?.message === 'not authenticated') {
        router.replace('/login');
        return;
      }
      setError(err?.body?.error || err?.message || 'failed to create room');
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <div className="py-4">
      <h1>Direct Messages</h1>
      {error ? <div className="mt-3 text-danger font-bold">{error}</div> : null}
      {busy ? <div className="mt-2 text-muted">Loading...</div> : null}

      {liveStreams.length > 0 ? (
        <Card className="mt-4">
          <CardHeader>Creators live now</CardHeader>
          <CardBody>
            <p className="mb-3 text-sm text-muted">
              Open a direct message with a creator who is online (live). Their user id is prefilled in the form below.
            </p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {liveStreams.map((s) => (
                <LiveCreatorSquareCard
                  key={s.id}
                  stream={s}
                  primaryHref={`/chat/rooms?participant=${encodeURIComponent(s.creatorUserId)}`}
                  primaryLabel="Start DM"
                />
              ))}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card className="mt-4">
        <CardHeader>Create direct room</CardHeader>
        <CardBody>
          <form onSubmit={onCreateRoom} className="flex gap-2 items-center flex-wrap">
            <Input
            value={participantUserId}
            onChange={(e) => setParticipantUserId(e.target.value)}
            placeholder="participant user id (creator account user id)"
            required
            />
            <Button type="submit" disabled={createBusy}>
              {createBusy ? 'Creating...' : 'Create'}
            </Button>
          </form>
        </CardBody>
      </Card>

      <div className="mt-4 grid gap-3">
        {rooms.map((r) => (
          <Card key={r.id}>
            <CardBody>
              <Link href={`/chat/rooms/${r.id}`} className="no-underline">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2">
                    <Avatar
                      name={r.otherParticipant?.displayName || r.otherParticipant?.username || 'User'}
                      src={r.otherParticipant?.avatarUrl || undefined}
                      size={42}
                    />
                    <div>
                      <div className="font-black text-white">
                        {r.otherParticipant?.displayName || r.otherParticipant?.username || r.subject || 'Direct room'}
                      </div>
                      <div className="text-xs text-muted mt-1">
                        {r.lastMessage
                          ? r.lastMessage.status === 'deleted'
                            ? '[deleted]'
                            : (r.lastMessage.body || '').slice(0, 84) || '(attachment)'
                          : 'No messages yet'}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    {r.unreadCount > 0 ? <Badge variant="accent">{r.unreadCount} unread</Badge> : <Badge>Read</Badge>}
                    <div className="text-[11px] text-muted mt-1">
                      {r.lastMessage?.sentAt ? new Date(r.lastMessage.sentAt).toLocaleString() : ''}
                    </div>
                  </div>
                </div>
              </Link>
            </CardBody>
          </Card>
        ))}
        {!busy && rooms.length === 0 && <div className="text-muted">No rooms yet.</div>}
      </div>
    </div>
  );
}

