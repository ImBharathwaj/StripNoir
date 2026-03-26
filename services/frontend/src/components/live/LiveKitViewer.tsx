"use client";

import { useMemo, useState } from "react";
import {
  ControlBar,
  DisconnectButton,
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
  VideoConference
} from "@livekit/components-react";
import "@livekit/components-styles";

export type LiveKitCredentials = {
  url: string;
  token: string;
  roomName: string;
  participantIdentity?: string;
  role?: string;
  grants?: any;
  expiresInSeconds?: number;
};

function LiveKitInner({ showPublisherControls }: { showPublisherControls: boolean }) {
  const [roomAudioMuted, setRoomAudioMuted] = useState(false);

  return (
    <>
      <RoomAudioRenderer muted={roomAudioMuted} />
      <VideoConference />
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <StartAudio label="Enable audio playback" className="rounded-lg bg-accent px-3 py-1.5 text-sm font-bold text-white" />
        <button
          type="button"
          onClick={() => setRoomAudioMuted((m) => !m)}
          aria-pressed={roomAudioMuted}
          aria-label={roomAudioMuted ? "Unmute room audio" : "Mute room audio"}
          className="rounded-lg border border-border bg-surface2 px-3 py-1.5 text-sm font-bold text-text hover:bg-surface"
        >
          {roomAudioMuted ? "Unmute room audio" : "Mute room audio"}
        </button>
        {showPublisherControls ? (
          <ControlBar
            variation="minimal"
            controls={{
              microphone: true,
              camera: true,
              screenShare: false,
              chat: false,
              settings: true,
              leave: false
            }}
            className="!border-0 !bg-transparent !p-0"
          />
        ) : null}
        <DisconnectButton
          className="rounded-lg border border-danger/50 bg-surface2 px-3 py-1.5 text-sm font-bold text-danger hover:bg-surface"
          aria-label="Leave stream and disconnect"
        >
          Leave stream
        </DisconnectButton>
      </div>
    </>
  );
}

export default function LiveKitViewer({
  livekit,
  notConfiguredMessage,
  showPublisherControls = false
}: {
  livekit: LiveKitCredentials;
  /** Shown when parent passes placeholder creds because server has no LiveKit */
  notConfiguredMessage?: string;
  /** Mic/camera/screen for calls or hosts; off for passive live viewers */
  showPublisherControls?: boolean;
}) {
  const serverUrl = useMemo(() => livekit?.url, [livekit]);
  const token = livekit?.token;
  const [connectionStatus, setConnectionStatus] = useState<
    "idle" | "connecting" | "connected" | "disconnected" | "error"
  >("connecting");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);

  if (!serverUrl || !token) {
    return (
      <section
        className="mt-4 rounded-xl border border-border bg-surface2 p-4 text-muted"
        role="status"
        aria-label="Live video unavailable"
      >
        {notConfiguredMessage ||
          "LiveKit is not configured or credentials were not returned. Video playback is unavailable."}
      </section>
    );
  }

  return (
    <section className="mt-4" aria-label="Live video and audio session">
      <div
        className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="font-bold text-text">LiveKit:</span>
        {connectionStatus === "connecting" ? <span className="text-warning">Connecting…</span> : null}
        {connectionStatus === "connected" ? <span className="text-success">Connected</span> : null}
        {connectionStatus === "disconnected" ? (
          <span className="text-warning">Disconnected — try leaving and joining again if video stops.</span>
        ) : null}
        {connectionStatus === "error" ? <span className="text-danger">Connection error</span> : null}
        {statusDetail ? <span className="text-muted">({statusDetail})</span> : null}
      </div>
      <LiveKitRoom
        token={token}
        serverUrl={serverUrl}
        connect={true}
        audio={false}
        video={false}
        onConnected={() => {
          setConnectionStatus("connected");
          setStatusDetail(null);
        }}
        onDisconnected={(reason) => {
          setConnectionStatus("disconnected");
          setStatusDetail(reason != null ? String(reason) : null);
        }}
        onError={(err) => {
          setConnectionStatus("error");
          setStatusDetail(err?.message || "unknown error");
        }}
      >
        <LiveKitInner showPublisherControls={showPublisherControls} />
      </LiveKitRoom>
    </section>
  );
}
