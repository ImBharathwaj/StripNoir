import { apiGet } from "./apiClient";
import { createReconnectingWebSocket, type WsConnectionStatus } from "./reconnectingWebSocket";

type RoomEntry = {
  messageListeners: Set<(ev: MessageEvent) => void>;
  statusListeners: Set<(open: boolean) => void>;
  disconnect: (() => void) | null;
  lastOpen: boolean;
};

const rooms = new Map<string, RoomEntry>();

function emitStatus(entry: RoomEntry, s: WsConnectionStatus) {
  const open = s === "open";
  entry.lastOpen = open;
  entry.statusListeners.forEach((fn) => fn(open));
}

/**
 * One reconnecting room WebSocket per `roomId` (shared across subscribers).
 */
export function subscribeRoomWebSocket(
  roomId: string,
  handlers: {
    onMessage: (ev: MessageEvent) => void;
    onConnection?: (open: boolean) => void;
  }
): () => void {
  let entry = rooms.get(roomId);
  if (!entry) {
    entry = {
      messageListeners: new Set(),
      statusListeners: new Set(),
      disconnect: null,
      lastOpen: false
    };
    const bridge = (ev: MessageEvent) => {
      entry!.messageListeners.forEach((fn) => {
        try {
          fn(ev);
        } catch {
          // isolate subscriber errors
        }
      });
    };
    const { disconnect } = createReconnectingWebSocket({
      getUrl: async () => {
        const data = await apiGet<{ wsUrl?: string }>(
          `/chat/ws-token?roomId=${encodeURIComponent(roomId)}`
        );
        return String(data?.wsUrl || "");
      },
      onMessage: bridge,
      onStatus: (s) => emitStatus(entry!, s),
      analyticsChannel: "room"
    });
    entry.disconnect = disconnect;
    rooms.set(roomId, entry);
  }

  entry.messageListeners.add(handlers.onMessage);
  if (handlers.onConnection) {
    entry.statusListeners.add(handlers.onConnection);
    handlers.onConnection(entry.lastOpen);
  }

  return () => {
    const e = rooms.get(roomId);
    if (!e) return;
    e.messageListeners.delete(handlers.onMessage);
    if (handlers.onConnection) e.statusListeners.delete(handlers.onConnection);
    if (e.messageListeners.size === 0) {
      e.disconnect?.();
      rooms.delete(roomId);
    }
  };
}
