"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { apiGet, apiPost } from '../../../../lib/apiClient';
import { subscribeRoomWebSocket } from '../../../../lib/roomWebSocketHub';
import Button from '../../../../components/ui/Button';
import Input from '../../../../components/ui/Input';
import { Card, CardBody } from '../../../../components/ui/Card';
import Badge from '../../../../components/ui/Badge';

type ChatMessage = {
  id: string;
  room_id?: string;
  sender_user_id: string;
  body: string | null;
  attachments: any[];
  status: string;
  sent_at?: string;
  edited_at?: string | null;
  deleted_at?: string | null;
};

type ChatEvent = {
  roomId?: string;
  userId?: string;
  eventType?: string;
  sentAt?: string;
  payload?: any;
};

export default function ChatRoomPage() {
  const router = useRouter();
  const params = useParams();
  const roomId = String((params as any).roomId || '');

  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [meUserId, setMeUserId] = useState<string | null>(null);
  const [otherUserId, setOtherUserId] = useState<string | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!roomId) return;

    let cancelled = false;

    async function run() {
      setBusy(true);
      setError(null);
      setWsConnected(false);
      setMessages([]);

      try {
        const [msgData, meData, summaryData] = await Promise.all([
          apiGet<{ messages: ChatMessage[] }>(`/chat/rooms/${roomId}/messages?limit=50`),
          apiGet<{ user: { id: string } }>('/auth/me'),
          apiGet<{
            rooms: Array<{
              id: string;
              otherParticipant: { userId: string } | null;
            }>;
          }>('/chat/rooms/summary')
        ]);

        if (cancelled) return;

        setMessages((msgData.messages || []).slice().sort((a, b) => String(a.sent_at || '').localeCompare(String(b.sent_at || ''))));
        setMeUserId(meData?.user?.id || null);
        const roomSummary = (summaryData?.rooms || []).find((r) => r.id === roomId);
        setOtherUserId(roomSummary?.otherParticipant?.userId || null);
        if ((msgData.messages || []).length > 0) {
          const last = msgData.messages[msgData.messages.length - 1];
          if (last?.id) {
            // Best-effort: mark initial batch as read.
            apiPost(`/chat/rooms/${roomId}/read`, { lastReadMessageId: last.id }).catch(() => {});
          }
        }
      } catch (err: any) {
        if (err?.status === 401 || err?.message === 'not authenticated') {
          router.replace('/login');
          return;
        }
        if (!cancelled) setError(err?.body?.error || err?.message || 'failed to load chat room');
      } finally {
        if (!cancelled) setBusy(false);
      }
    }

    run();

    return () => {
      cancelled = true;
    };
  }, [roomId, router]);

  useEffect(() => {
    if (!roomId) return;
    return subscribeRoomWebSocket(roomId, {
      onConnection: (open) => setWsConnected(open),
      onMessage: (ev) => {
        try {
          const evt: ChatEvent = JSON.parse(ev.data);
          const eventType = evt.eventType;
          const payloadMsg = evt?.payload?.message;
          const incomingMessage: ChatMessage | null = payloadMsg && payloadMsg.id ? (payloadMsg as ChatMessage) : null;
          if (!eventType || !incomingMessage) return;

          setMessages((prev) => {
            const byId = new Map(prev.map((m) => [m.id, m]));
            if (eventType === 'message.created') {
              byId.set(incomingMessage.id, incomingMessage);
            } else if (eventType === 'message.edited') {
              const cur = byId.get(incomingMessage.id);
              byId.set(incomingMessage.id, {
                ...(cur || incomingMessage),
                ...incomingMessage,
                status: incomingMessage.status ?? cur?.status ?? 'sent'
              });
            } else if (eventType === 'message.deleted') {
              const cur = byId.get(incomingMessage.id);
              byId.set(incomingMessage.id, { ...(cur || incomingMessage), ...incomingMessage, body: null, status: 'deleted' });
            } else {
              byId.set(incomingMessage.id, incomingMessage);
            }

            const merged = Array.from(byId.values());
            const sorted = merged.sort((a, b) => String(a.sent_at || '').localeCompare(String(b.sent_at || '')));
            const last = sorted[sorted.length - 1];
            if (last?.id) {
              apiPost(`/chat/rooms/${roomId}/read`, { lastReadMessageId: last.id }).catch(() => {});
            }
            return sorted;
          });
        } catch {
          // Ignore malformed events.
        }
      }
    });
  }, [roomId]);

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await apiPost(`/chat/rooms/${roomId}/messages`, { body: body.trim() });
      setBody('');
    } catch (err: any) {
      if (err?.status === 401 || err?.message === 'not authenticated') {
        router.replace('/login');
        return;
      }
      setError(err?.body?.error || err?.message || 'send failed');
    } finally {
      setSending(false);
    }
  }

  async function onReportMessage(messageId: string) {
    setActionBusyId(messageId);
    setError(null);
    try {
      await apiPost(`/chat/rooms/${roomId}/messages/${messageId}/report`, {
        reasonCode: 'abuse',
        reasonText: 'Reported from chat UI',
        priority: 3
      });
    } catch (err: any) {
      if (err?.status === 401 || err?.message === 'not authenticated') {
        router.replace('/login');
        return;
      }
      setError(err?.body?.error || err?.message || 'report failed');
    } finally {
      setActionBusyId(null);
    }
  }

  async function onBlockOtherUser() {
    if (!otherUserId) return;
    setActionBusyId('block');
    setError(null);
    try {
      await apiPost(`/users/${otherUserId}/block`);
      setError('User blocked. You may need to refresh rooms.');
    } catch (err: any) {
      if (err?.status === 401 || err?.message === 'not authenticated') {
        router.replace('/login');
        return;
      }
      setError(err?.body?.error || err?.message || 'block failed');
    } finally {
      setActionBusyId(null);
    }
  }

  return (
    <div className="py-4">
      <div className="flex justify-between gap-2 items-center flex-wrap">
        <h1 className="m-0">Room {roomId}</h1>
        <div className={wsConnected ? 'text-success font-black' : 'text-muted font-black'}>
          WS {wsConnected ? 'connected' : 'disconnected'}
        </div>
      </div>

      <div className="mt-2 flex gap-2 items-center flex-wrap">
        {otherUserId ? <Badge>Participant: {otherUserId.slice(0, 8)}...</Badge> : null}
        {otherUserId ? (
          <Button size="sm" variant="secondary" onClick={onBlockOtherUser} disabled={actionBusyId === 'block'}>
            {actionBusyId === 'block' ? 'Blocking...' : 'Block user'}
          </Button>
        ) : null}
        <Link href="/chat/rooms" className="text-accent underline text-sm">
          Back to rooms
        </Link>
      </div>

      {error ? <div className="text-danger mt-3">{error}</div> : null}
      {busy ? <div className="mt-3 text-muted">Loading...</div> : null}

      <Card className="mt-4">
        <CardBody className="min-h-[380px]">
        {messages.map((m) => (
          <div key={m.id} className={`py-2 flex ${m.sender_user_id === meUserId ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[78%] rounded-xl px-3 py-2 border ${m.sender_user_id === meUserId ? 'bg-accent/20 border-accent/40' : 'bg-surface2 border-border'}`}>
              <div className="flex justify-between gap-3 items-center">
                <div className="font-black text-xs text-text">{m.sender_user_id === meUserId ? 'You' : m.sender_user_id}</div>
                <div className="text-[11px] text-muted">{m.sent_at ? new Date(m.sent_at).toLocaleString() : ''}</div>
              </div>
              <div className={`mt-1 text-sm ${m.status === 'deleted' ? 'text-danger' : 'text-text2'}`}>
                {m.status === 'deleted' || m.deleted_at ? '[deleted]' : m.body}
              </div>
              <div className="mt-1 flex items-center gap-2">
                {m.edited_at && !m.deleted_at ? <Badge>edited</Badge> : null}
                {!m.deleted_at && m.sender_user_id !== meUserId ? (
                  <Button size="sm" variant="secondary" onClick={() => onReportMessage(m.id)} disabled={actionBusyId === m.id}>
                    {actionBusyId === m.id ? 'Reporting...' : 'Report'}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ))}
        {!busy && messages.length === 0 && <div className="text-muted">No messages yet.</div>}
        </CardBody>
      </Card>

      <form onSubmit={onSend} className="mt-3 flex gap-2 flex-wrap">
        <Input
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Type a message..."
          className="flex-1 min-w-[320px]"
        />
        <Button type="submit" disabled={sending}>
          {sending ? 'Sending...' : 'Send'}
        </Button>
      </form>
    </div>
  );
}

