"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../../lib/apiClient";
import { subscribeRoomWebSocket } from "../../lib/roomWebSocketHub";
import Button from "../ui/Button";
import Input from "../ui/Input";
import { Card, CardBody, CardHeader } from "../ui/Card";
import Badge from "../ui/Badge";

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
  eventType?: string;
  payload?: any;
};

type RoomSummary = {
  id: string;
  otherParticipant: {
    userId: string;
    username?: string | null;
    displayName?: string | null;
  } | null;
};

type Props = {
  roomId: string;
  title?: string;
  subtitle?: string | null;
};

export default function ChatThreadPanel({ roomId, title = "Direct chat", subtitle }: Props) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [meUserId, setMeUserId] = useState<string | null>(null);
  const [otherUserId, setOtherUserId] = useState<string | null>(null);
  const [otherUserLabel, setOtherUserLabel] = useState<string>("Other user");
  const [blockBusy, setBlockBusy] = useState(false);

  const mergeMessages = useCallback((incoming: ChatMessage[]) => {
    setMessages((prev) => {
      const byId = new Map(prev.map((msg) => [msg.id, msg]));
      for (const msg of incoming) {
        byId.set(msg.id, {
          ...(byId.get(msg.id) || {}),
          ...msg
        });
      }
      return Array.from(byId.values()).sort((a, b) =>
        String(a.sent_at || "").localeCompare(String(b.sent_at || ""))
      );
    });
  }, []);

  const loadThread = useCallback(async (cancelled = false, options?: { silent?: boolean }) => {
    const silent = Boolean(options?.silent);
    if (!silent) {
      setBusy(true);
      setError(null);
      setWsConnected(false);
      setMessages([]);
    }

    try {
      const [msgData, meData, summaryData] = await Promise.all([
        apiGet<{ messages: ChatMessage[] }>(`/chat/rooms/${roomId}/messages?limit=50`),
        apiGet<{ user: { id: string } }>("/auth/me"),
        apiGet<{ rooms: RoomSummary[] }>("/chat/rooms/summary")
      ]);

      if (cancelled) return;

      const nextMessages = (msgData.messages || [])
        .slice()
        .sort((a, b) => String(a.sent_at || "").localeCompare(String(b.sent_at || "")));
      const roomSummary = (summaryData?.rooms || []).find((room) => room.id === roomId);

      if (silent) {
        mergeMessages(nextMessages);
      } else {
        setMessages(nextMessages);
      }
      setMeUserId(meData?.user?.id || null);
      setOtherUserId(roomSummary?.otherParticipant?.userId || null);
      setOtherUserLabel(
        roomSummary?.otherParticipant?.displayName
          || roomSummary?.otherParticipant?.username
          || roomSummary?.otherParticipant?.userId
          || "Other user"
      );

      const last = nextMessages[nextMessages.length - 1];
      if (last?.id) {
        apiPost(`/chat/rooms/${roomId}/read`, { lastReadMessageId: last.id }).catch(() => {});
      }
    } catch (err: any) {
      if (!cancelled) setError(err?.body?.error || err?.message || "failed to load chat");
    } finally {
      if (!cancelled && !silent) setBusy(false);
    }
  }, [mergeMessages, roomId]);

  useEffect(() => {
    if (!roomId) return;

    let cancelled = false;

    loadThread(cancelled);
    const timer = setInterval(() => {
      if (!cancelled) {
        loadThread(cancelled, { silent: true });
      }
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [loadThread, roomId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, roomId]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last?.id) {
      apiPost(`/chat/rooms/${roomId}/read`, { lastReadMessageId: last.id }).catch(() => {});
    }
  }, [messages, roomId]);

  useEffect(() => {
    if (!roomId) return;

    return subscribeRoomWebSocket(roomId, {
      onConnection: (open) => setWsConnected(open),
      onMessage: (ev) => {
        try {
          const evt: ChatEvent = JSON.parse(ev.data);
          const incomingMessage = evt?.payload?.message as ChatMessage | undefined;
          if (!evt?.eventType || !incomingMessage?.id) return;

          mergeMessages([incomingMessage]);
        } catch {
          // Ignore malformed events.
        }
      }
    });
  }, [mergeMessages, roomId]);

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const response = await apiPost<{ message?: ChatMessage }>(`/chat/rooms/${roomId}/messages`, { body: body.trim() });
      if (response?.message?.id) {
        mergeMessages([response.message]);
      }
      setBody("");
      loadThread(false, { silent: true }).catch(() => {});
    } catch (err: any) {
      setError(err?.body?.error || err?.message || "send failed");
    } finally {
      setSending(false);
    }
  }

  async function onBlockOtherUser() {
    if (!otherUserId) return;
    setBlockBusy(true);
    setError(null);
    try {
      await apiPost(`/users/${otherUserId}/block`);
      setError("User blocked. Refresh the thread list if needed.");
    } catch (err: any) {
      setError(err?.body?.error || err?.message || "block failed");
    } finally {
      setBlockBusy(false);
    }
  }

  function formatMessageTime(value?: string) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  return (
    <Card className="overflow-hidden rounded-[26px] border-border/90">
      <CardHeader className="border-b border-border/80 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0))]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[11px] font-black uppercase tracking-[0.22em] text-muted">Conversation</div>
            <div className="mt-2 text-lg font-black tracking-[-0.02em] text-text">{title}</div>
            {subtitle ? <div className="mt-1 max-w-xl text-xs leading-5 text-muted">{subtitle}</div> : null}
          </div>
          <div
            className={`rounded-full border px-3 py-1 text-[11px] font-black uppercase tracking-[0.16em] ${
              wsConnected ? "border-success/30 bg-success/10 text-success" : "border-border bg-surface2 text-muted"
            }`}
          >
            {wsConnected ? "Live sync" : "Reconnecting"}
          </div>
        </div>
      </CardHeader>
      <CardBody className="space-y-4 bg-[radial-gradient(circle_at_top,rgba(37,99,235,0.12),transparent_32%),linear-gradient(180deg,rgba(10,14,23,0.9),rgba(10,14,23,0.98))]">
        <div className="flex flex-wrap items-center gap-2">
          {otherUserId ? <Badge>Private</Badge> : null}
          {otherUserId ? (
            <Button size="sm" variant="secondary" onClick={onBlockOtherUser} disabled={blockBusy}>
              {blockBusy ? "Blocking..." : "Block user"}
            </Button>
          ) : null}
        </div>

        {error ? <div className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm font-bold text-danger">{error}</div> : null}
        {busy ? <div className="text-sm text-muted">Loading chat...</div> : null}

        <div className="max-h-[30rem] min-h-[24rem] space-y-3 overflow-y-auto rounded-[22px] border border-border/80 bg-black/20 p-4 backdrop-blur">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.sender_user_id === meUserId ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[78%] rounded-[20px] border px-4 py-3 shadow-sm ${
                  message.sender_user_id === meUserId
                    ? "border-accent/30 bg-[linear-gradient(180deg,rgba(37,99,235,0.26),rgba(37,99,235,0.16))]"
                    : "border-border/80 bg-white/5"
                }`}
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="text-[11px] font-black uppercase tracking-[0.16em] text-muted">
                    {message.sender_user_id === meUserId ? "You" : otherUserLabel}
                  </div>
                  <div className="text-[11px] text-muted">
                    {formatMessageTime(message.sent_at)}
                  </div>
                </div>
                <div className={`mt-2 text-sm leading-6 ${message.status === "deleted" ? "text-danger" : "text-text2"}`}>
                  {message.status === "deleted" || message.deleted_at ? "[deleted]" : message.body}
                </div>
                {message.edited_at && !message.deleted_at ? <div className="mt-3"><Badge>edited</Badge></div> : null}
              </div>
            </div>
          ))}
          {!busy && messages.length === 0 ? (
            <div className="flex min-h-[16rem] items-center justify-center rounded-2xl border border-dashed border-border/80 bg-white/5 px-4 text-center text-sm text-muted">
              No messages yet. Start the conversation below.
            </div>
          ) : null}
          <div ref={endRef} />
        </div>

        <form onSubmit={onSend} className="rounded-[22px] border border-border/80 bg-black/20 p-3 backdrop-blur">
          <div className="flex flex-wrap items-end gap-3">
            <Input
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write a message..."
              className="min-h-12 min-w-[260px] flex-1 border-0 bg-white/5"
            />
            <Button type="submit" disabled={sending} className="min-w-28">
              {sending ? "Sending..." : "Send"}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
