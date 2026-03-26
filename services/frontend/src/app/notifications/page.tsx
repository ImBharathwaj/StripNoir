"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost } from "../../lib/apiClient";
import { loadTokens } from "../../lib/tokenStore";
import { subscribeNotifyWebSocket } from "../../lib/notifyWebSocketHub";
import {
  appPathFromDeepLink,
  iconForNotificationType,
  normalizeNotification,
  type NormalizedNotification
} from "../../lib/notificationUi";
import Button from "../../components/ui/Button";
import { Card, CardBody, CardHeader } from "../../components/ui/Card";
import Badge from "../../components/ui/Badge";
import Toast, { type ToastItem } from "../../components/ui/Toast";

type ChatEvent = {
  eventType?: string;
  payload?: any;
  sentAt?: string;
};

export default function NotificationsPage() {
  const router = useRouter();

  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);

  const [items, setItems] = useState<NormalizedNotification[]>([]);
  const [selectedUnread, setSelectedUnread] = useState<Set<string>>(new Set());
  const [wsConnected, setWsConnected] = useState(false);
  const [toast, setToast] = useState<ToastItem | null>(null);

  const unreadIds = useMemo(() => items.filter((n) => n.status === "unread").map((n) => n.id), [items]);
  const selectedCount = selectedUnread.size;

  const showToastFor = useCallback((n: NormalizedNotification) => {
    const path = appPathFromDeepLink(n.deepLink);
    setToast({
      id: `${n.id}-${Date.now()}`,
      title: n.title,
      body: n.body || undefined,
      href: path || undefined,
      linkLabel: path ? "Open" : undefined
    });
  }, []);

  const showToastForRef = useRef(showToastFor);
  showToastForRef.current = showToastFor;

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setBusy(true);
      setError(null);

      try {
        const data = await apiGet<{ notifications: Record<string, any>[] }>("/notifications?limit=50");
        const normalized = (data.notifications || [])
          .map((r) => normalizeNotification(r))
          .filter(Boolean) as NormalizedNotification[];
        if (!cancelled) {
          normalized.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
          setItems(normalized);
        }
      } catch (err: any) {
        if (err?.status === 401 || err?.message === "not authenticated") {
          router.replace("/login");
          return;
        }
        if (!cancelled) setError(err?.body?.error || err?.message || "failed to load notifications");
      } finally {
        if (!cancelled) setBusy(false);
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (!loadTokens()?.accessToken) return;
    return subscribeNotifyWebSocket({
      onConnection: (open) => setWsConnected(open),
      onMessage: (ev) => {
        try {
          const evt: ChatEvent = JSON.parse(ev.data);
          if (evt?.eventType !== "notification.created") return;
          const next = normalizeNotification(evt?.payload?.notification);
          if (!next) return;

          setItems((prev) => {
            const byId = new Map(prev.map((n) => [n.id, n]));
            byId.set(next.id, next);
            return Array.from(byId.values()).sort((a, b) =>
              String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
            );
          });
          showToastForRef.current(next);
        } catch {
          // ignore malformed events
        }
      }
    });
  }, []);

  async function markAllRead() {
    setError(null);
    setBatchBusy(true);
    try {
      await apiPost("/notifications/read", { readAll: true });
      setItems((prev) =>
        prev.map((n) => (n.status === "unread" ? { ...n, status: "read", readAt: new Date().toISOString() } : n))
      );
      setSelectedUnread(new Set());
    } catch (err: any) {
      setError(err?.body?.error || err?.message || "mark read failed");
    } finally {
      setBatchBusy(false);
    }
  }

  async function markSelectedRead() {
    const ids = Array.from(selectedUnread);
    if (ids.length === 0) return;
    setError(null);
    setBatchBusy(true);
    try {
      await apiPost("/notifications/read", { ids });
      setItems((prev) =>
        prev.map((n) => (ids.includes(n.id) ? { ...n, status: "read", readAt: new Date().toISOString() } : n))
      );
      setSelectedUnread(new Set());
    } catch (err: any) {
      setError(err?.body?.error || err?.message || "mark read failed");
    } finally {
      setBatchBusy(false);
    }
  }

  async function markOneRead(id: string) {
    setError(null);
    try {
      await apiPost("/notifications/read", { ids: [id] });
      setItems((prev) =>
        prev.map((n) => (n.id === id ? { ...n, status: "read", readAt: new Date().toISOString() } : n))
      );
      setSelectedUnread((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    } catch (err: any) {
      setError(err?.body?.error || err?.message || "mark read failed");
    }
  }

  function toggleSelectUnread(id: string) {
    setSelectedUnread((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function selectAllUnread() {
    setSelectedUnread(new Set(unreadIds));
  }

  function clearSelection() {
    setSelectedUnread(new Set());
  }

  return (
    <div className="py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="m-0">Notifications</h1>
        <div className={wsConnected ? "font-black text-success" : "font-black text-muted"}>
          Realtime {wsConnected ? "live" : "offline"}
        </div>
      </div>

      {error ? <div className="mt-3 font-bold text-danger">{error}</div> : null}
      {busy ? <div className="mt-2 text-muted">Loading…</div> : null}

      <Card className="mt-4">
        <CardHeader>Batch actions</CardHeader>
        <CardBody className="flex flex-wrap items-center gap-2">
          <Button onClick={markAllRead} disabled={batchBusy || unreadIds.length === 0}>
            Mark all as read ({unreadIds.length})
          </Button>
          <Button variant="secondary" onClick={markSelectedRead} disabled={batchBusy || selectedCount === 0}>
            Mark selected ({selectedCount})
          </Button>
          <Button variant="secondary" onClick={selectAllUnread} disabled={unreadIds.length === 0}>
            Select all unread
          </Button>
          <Button variant="ghost" onClick={clearSelection} disabled={selectedCount === 0}>
            Clear selection
          </Button>
        </CardBody>
      </Card>

      <div className="mt-4 grid gap-3">
        {items.map((n) => {
          const path = appPathFromDeepLink(n.deepLink);
          const icon = iconForNotificationType(n.type);
          return (
            <Card key={n.id}>
              <CardBody>
                <div className="flex flex-wrap items-start gap-3">
                  {n.status === "unread" ? (
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 accent-accent"
                      checked={selectedUnread.has(n.id)}
                      onChange={() => toggleSelectUnread(n.id)}
                      aria-label={`Select notification ${n.title}`}
                    />
                  ) : (
                    <span className="w-4" />
                  )}
                  <div className="text-2xl leading-none" aria-hidden>
                    {icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-black text-text">{n.title}</span>
                      <Badge>{n.type}</Badge>
                      {n.status === "unread" ? <Badge variant="warning">Unread</Badge> : <Badge variant="success">Read</Badge>}
                    </div>
                    {n.body ? <div className="mt-1 text-sm text-muted">{n.body}</div> : null}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {path ? (
                        <Link href={path} className="text-sm font-bold text-accent underline">
                          Open linked page
                        </Link>
                      ) : (
                        <span className="text-xs text-muted">No deep link</span>
                      )}
                      {n.status === "unread" ? (
                        <Button size="sm" variant="secondary" onClick={() => markOneRead(n.id)}>
                          Mark read
                        </Button>
                      ) : null}
                    </div>
                    {n.createdAt ? (
                      <div className="mt-2 text-xs text-muted">{new Date(n.createdAt).toLocaleString()}</div>
                    ) : null}
                  </div>
                </div>
              </CardBody>
            </Card>
          );
        })}
        {!busy && items.length === 0 ? <div className="text-muted">No notifications.</div> : null}
      </div>

      {toast ? (
        <div className="pointer-events-none fixed bottom-4 right-4 z-[90] flex justify-end">
          <Toast toast={toast} onDone={() => setToast(null)} />
        </div>
      ) : null}
    </div>
  );
}
