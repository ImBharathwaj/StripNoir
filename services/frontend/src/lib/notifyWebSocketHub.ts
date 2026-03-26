import { apiGet } from "./apiClient";
import { createReconnectingWebSocket, type WsConnectionStatus } from "./reconnectingWebSocket";

type Hub = {
  messageListeners: Set<(ev: MessageEvent) => void>;
  statusListeners: Set<(open: boolean) => void>;
  disconnect: (() => void) | null;
};

let hub: Hub | null = null;
let lastNotifyOpen = false;

function emitStatus(s: WsConnectionStatus) {
  if (!hub) return;
  const open = s === "open";
  lastNotifyOpen = open;
  hub.statusListeners.forEach((fn) => fn(open));
}

/**
 * Single notifications WebSocket for the whole app (dedupes TopNav + /notifications page).
 */
export function subscribeNotifyWebSocket(handlers: {
  onMessage: (ev: MessageEvent) => void;
  onConnection?: (open: boolean) => void;
}): () => void {
  if (!hub) {
    hub = {
      messageListeners: new Set(),
      statusListeners: new Set(),
      disconnect: null
    };
    const bridge = (ev: MessageEvent) => {
      hub!.messageListeners.forEach((fn) => {
        try {
          fn(ev);
        } catch {
          // ignore
        }
      });
    };
    const { disconnect } = createReconnectingWebSocket({
      getUrl: async () => {
        const data = await apiGet<{ wsUrl?: string }>("/notifications/ws-token");
        return String(data?.wsUrl || "");
      },
      onMessage: bridge,
      onStatus: emitStatus,
      analyticsChannel: "notifications"
    });
    hub.disconnect = disconnect;
  }

  hub.messageListeners.add(handlers.onMessage);
  if (handlers.onConnection) {
    hub.statusListeners.add(handlers.onConnection);
    handlers.onConnection(lastNotifyOpen);
  }

  return () => {
    if (!hub) return;
    hub.messageListeners.delete(handlers.onMessage);
    if (handlers.onConnection) hub.statusListeners.delete(handlers.onConnection);
    if (hub.messageListeners.size === 0) {
      hub.disconnect?.();
      hub = null;
      lastNotifyOpen = false;
    }
  };
}
