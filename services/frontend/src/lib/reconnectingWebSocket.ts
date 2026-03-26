import { trackWsConnectMs } from "./analytics";
import { normalizeWsUrl } from "./wsUrl";

export type WsConnectionStatus = "idle" | "connecting" | "open" | "closed" | "error";

/**
 * Maintains a WebSocket with exponential backoff + jitter.
 * Refetches URL on each attempt (fresh tokens for room/notify WS).
 */
export function createReconnectingWebSocket(options: {
  getUrl: () => Promise<string>;
  onMessage: (ev: MessageEvent) => void;
  onStatus?: (s: WsConnectionStatus) => void;
  /** Cap for backoff delay (ms). Default 30s. */
  maxDelayMs?: number;
  /** If set, logs handshake duration on each successful open (perf marker). */
  analyticsChannel?: string;
}): { disconnect: () => void } {
  let stopped = false;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  const maxDelay = options.maxDelayMs ?? 30_000;

  function clearTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    clearTimer();
    attempt += 1;
    const exp = Math.min(maxDelay, 1000 * Math.pow(2, Math.min(attempt, 6)));
    const jitter = Math.floor(Math.random() * 500);
    reconnectTimer = setTimeout(() => void connect(), exp + jitter);
  }

  async function connect() {
    if (stopped) return;
    clearTimer();
    options.onStatus?.("connecting");
    try {
      const raw = await options.getUrl();
      const url = normalizeWsUrl(String(raw || ""));
      if (!url) {
        options.onStatus?.("error");
        scheduleReconnect();
        return;
      }

      const connectStartedAt = typeof performance !== "undefined" ? performance.now() : 0;
      const socket = new WebSocket(url);
      ws = socket;

      socket.onopen = () => {
        attempt = 0;
        options.onStatus?.("open");
        if (options.analyticsChannel && connectStartedAt && typeof performance !== "undefined") {
          trackWsConnectMs(options.analyticsChannel, performance.now() - connectStartedAt);
        }
      };

      socket.onmessage = options.onMessage;

      socket.onerror = () => {
        options.onStatus?.("error");
      };

      socket.onclose = () => {
        if (ws === socket) ws = null;
        options.onStatus?.("closed");
        if (!stopped) scheduleReconnect();
      };
    } catch {
      options.onStatus?.("error");
      if (!stopped) scheduleReconnect();
    }
  }

  connect();

  return {
    disconnect: () => {
      stopped = true;
      clearTimer();
      try {
        ws?.close();
      } catch {
        // ignore
      }
      ws = null;
    }
  };
}
