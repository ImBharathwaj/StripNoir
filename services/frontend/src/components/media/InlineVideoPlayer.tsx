"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  getAssetDimensions,
  orientationFromDimensions,
  type FeedOrientation
} from "../../lib/feedMediaOrientation";

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function Icon({
  children,
  className = ""
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center justify-center ${className}`} aria-hidden="true">
      {children}
    </span>
  );
}

/**
 * Native HTML5 video with full controls. Sizes from intrinsic aspect ratio:
 * portrait → tall cap; landscape → wide short frame in the feed.
 */
export default function InlineVideoPlayer({
  src,
  label,
  dimensionSource
}: {
  src: string;
  label?: string | null;
  /** Media row (or any object with width/height) for early orientation hint. */
  dimensionSource?: Record<string, unknown> | null;
}) {
  const { w, h } = dimensionSource ? getAssetDimensions(dimensionSource) : { w: null, h: null };
  const hinted = orientationFromDimensions(w, h);
  const [orient, setOrient] = useState<FeedOrientation>(hinted);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState<number>(1);

  useEffect(() => {
    setOrient(hinted);
  }, [hinted, src]);

  const onLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    if (v.videoWidth > 0 && v.videoHeight > 0) {
      setOrient(orientationFromDimensions(v.videoWidth, v.videoHeight));
    }
    if (Number.isFinite(v.duration) && v.duration > 0) {
      setDuration(v.duration);
    }
  };

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    setIsMuted(Boolean(v.muted));
    setVolume(clamp(v.volume ?? 1, 0, 1));
    setDuration(Number.isFinite(v.duration) ? v.duration : 0);
    setCurrentTime(Number.isFinite(v.currentTime) ? v.currentTime : 0);
  }, [src]);

  const sizeClass = useMemo(
    () =>
      orient === "landscape"
        ? "w-full h-auto max-h-[85vh] object-contain"
        : "w-full h-auto max-h-[min(92vh,920px)] object-contain",
    [orient]
  );

  const togglePlay = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (v.paused) {
        await v.play();
      } else {
        v.pause();
      }
    } catch {
      // ignore play() errors (autoplay policy, etc.)
    }
  };

  const seekTo = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    const next = clamp(t, 0, duration || 0);
    v.currentTime = next;
    setCurrentTime(next);
  };

  const onTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    setCurrentTime(v.currentTime || 0);
  };

  const onPlay = () => setIsPlaying(true);
  const onPause = () => setIsPlaying(false);

  const onDurationChange = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    if (Number.isFinite(v.duration) && v.duration > 0) setDuration(v.duration);
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    const nextMuted = !v.muted;
    v.muted = nextMuted;
    setIsMuted(nextMuted);
  };

  const setVolumeSafe = (next: number) => {
    const v = videoRef.current;
    if (!v) return;
    const nextVol = clamp(next, 0, 1);
    v.volume = nextVol;
    v.muted = nextVol === 0;
    setVolume(nextVol);
    setIsMuted(v.muted);
  };

  const requestFullscreen = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (typeof v.requestFullscreen === "function") {
        await v.requestFullscreen();
      }
    } catch {
      // ignore fullscreen errors
    }
  };

  return (
    <div className="relative overflow-hidden rounded-lg bg-black">
      <video
        ref={videoRef}
        src={src}
        // We use custom controls overlay for better visual consistency.
        controls={false}
        playsInline
        preload="metadata"
        className={sizeClass}
        aria-label={label || "Video"}
        onLoadedMetadata={onLoadedMetadata}
        onDurationChange={onDurationChange}
        onTimeUpdate={onTimeUpdate}
        onPlay={onPlay}
        onPause={onPause}
        onClick={togglePlay}
      />

      <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/65 via-black/35 to-transparent">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              togglePlay();
            }}
            className="h-9 w-9 rounded-md bg-white/10 hover:bg-white/15 flex items-center justify-center border border-white/10"
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <Icon>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 5h4v14H6z" />
                  <path d="M14 5h4v14h-4z" />
                </svg>
              </Icon>
            ) : (
              <Icon>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </Icon>
            )}
          </button>

          <div className="flex items-center gap-2 min-w-[96px]">
            <span className="text-[11px] text-white/80 tabular-nums">{formatTime(currentTime)}</span>
            <span className="text-[11px] text-white/50 tabular-nums">/</span>
            <span className="text-[11px] text-white/80 tabular-nums">
              {duration > 0 ? formatTime(duration) : "0:00"}
            </span>
          </div>

          <div className="flex-1">
            <input
              type="range"
              min={0}
              max={duration > 0 ? duration : 0}
              step={0.1}
              value={clamp(currentTime, 0, duration || 0)}
              onChange={(e) => seekTo(Number(e.target.value))}
              aria-label="Seek"
              className="w-full accent-accent"
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleMute();
              }}
              className="h-9 w-9 rounded-md bg-white/10 hover:bg-white/15 flex items-center justify-center border border-white/10"
              aria-label={isMuted ? "Unmute" : "Mute"}
            >
              {isMuted ? (
                <Icon>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 5L6 9H2v6h4l5 4V5z" />
                    <path d="M23 9l-6 6" />
                    <path d="M17 9l6 6" />
                  </svg>
                </Icon>
              ) : (
                <Icon>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M11 5L6 9H2v6h4l5 4V5z" />
                    <path d="M15.54 8.46a5 5 0 010 7.07" />
                    <path d="M19.07 4.93a10 10 0 010 14.14" />
                  </svg>
                </Icon>
              )}
            </button>

            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => setVolumeSafe(Number(e.target.value))}
              aria-label="Volume"
              className="w-20 accent-accent"
            />

            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                requestFullscreen();
              }}
              className="h-9 w-9 rounded-md bg-white/10 hover:bg-white/15 flex items-center justify-center border border-white/10"
              aria-label="Fullscreen"
            >
              <Icon>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M8 3H3v5" />
                  <path d="M21 8V3h-5" />
                  <path d="M3 16v5h5" />
                  <path d="M16 21h5v-5" />
                </svg>
              </Icon>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
