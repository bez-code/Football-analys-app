import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Volume2, VolumeX } from 'lucide-react';
import { api, proxyUrl } from '../lib/api';
import { useEditor } from '../lib/store';
import {
  frameDurationMs,
  playerBridge,
  RATE_STEPS,
  seekTo,
  togglePlay,
} from '../lib/playerBridge';
import { msToFrame, type FrameRate, type MediaAsset } from '@tactix/contracts';

const RATE_LABELS: Record<string, string> = {
  '0.1': '0.1x',
  '0.25': '0.25x',
  '0.5': '0.5x',
  '0.75': '0.75x',
  '1': '1x',
  '1.5': '1.5x',
  '2': '2x',
  '4': '4x',
};

export function PlayerView(): React.JSX.Element {
  const asset = useEditor((s) => s.activeAsset);
  if (!asset) return <NoAsset />;
  return (
    <div className="flex h-full flex-col">
      <VideoStage asset={asset} />
      <Transport asset={asset} />
    </div>
  );
}

function NoAsset(): React.JSX.Element {
  const setView = useEditor((s) => s.setView);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2">
      <p className="text-[13px] text-[--color-ink-dim]">No video open</p>
      <button className="btn" onClick={() => setView('library')}>
        Go to library
      </button>
    </div>
  );
}

function VideoStage({ asset }: { asset: MediaAsset }): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const setPlaying = useEditor((s) => s.setPlaying);
  const rate = useEditor((s) => s.rate);
  const volume = useEditor((s) => s.volume);
  const muted = useEditor((s) => s.muted);
  const fps: FrameRate = { num: asset.fpsNum, den: asset.fpsDen };

  const src = proxyUrl(asset);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    playerBridge.fps = fps;
  }, [fps]);

  /**
   * requestVideoFrameCallback gives us the *presented* frame time, which is
   * what the analyst is actually looking at. `timeupdate` fires on a timer
   * (roughly 4 Hz) and is far too coarse to draw a playhead against.
   */
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    playerBridge.el = el;
    let handle = 0;
    let stopped = false;

    const onFrame = (_now: number, meta: VideoFrameCallbackMetadata): void => {
      if (stopped) return;
      if (performance.now() < playerBridge.suppressUntil) {
        handle = el.requestVideoFrameCallback(onFrame);
        return;
      }
      setPlayhead(meta.mediaTime * 1000);
      handle = el.requestVideoFrameCallback(onFrame);
    };

    handle = el.requestVideoFrameCallback(onFrame);
    return () => {
      stopped = true;
      if (handle) el.cancelVideoFrameCallback(handle);
      if (playerBridge.el === el) playerBridge.el = null;
    };
  }, [setPlayhead, src]);

  useEffect(() => {
    const el = videoRef.current;
    if (el) el.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    const el = videoRef.current;
    if (el) {
      el.volume = volume;
      el.muted = muted;
    }
  }, [volume, muted]);

  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
      {src ? (
        <video
          ref={videoRef}
          src={src}
          className="max-h-full max-w-full"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => setWaiting(false)}
          onError={() =>
            setError('The playback proxy could not be loaded. Check the Jobs panel for the ffmpeg error.')
          }
          onClick={togglePlay}
        />
      ) : (
        <div className="flex flex-col items-center gap-2 text-center">
          {asset.proxyState === 'FAILED' ? (
            <>
              <AlertTriangle size={22} className="text-amber-500" />
              <p className="text-[12px] text-[--color-ink-dim]">
                Proxy generation failed — the original file cannot be played directly.
              </p>
            </>
          ) : (
            <>
              <Loader2 size={20} className="animate-spin text-[--color-ink-faint]" />
              <p className="text-[12px] text-[--color-ink-dim]">
                Building playback proxy…
              </p>
            </>
          )}
        </div>
      )}

      {waiting && src && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Loader2 size={26} className="animate-spin text-white/60" />
        </div>
      )}
      {error && (
        <div className="absolute inset-x-4 bottom-4 rounded border border-red-500/40 bg-red-950/80 px-3 py-2 text-[11px] text-red-200">
          {error}
        </div>
      )}
    </div>
  );
}

function Transport({ asset }: { asset: MediaAsset }): React.JSX.Element {
  const playheadMs = useEditor((s) => s.playheadMs);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const playing = useEditor((s) => s.playing);
  const rate = useEditor((s) => s.rate);
  const setRate = useEditor((s) => s.setRate);
  const volume = useEditor((s) => s.volume);
  const setVolume = useEditor((s) => s.setVolume);
  const muted = useEditor((s) => s.muted);
  const setMuted = useEditor((s) => s.setMuted);
  const fps: FrameRate = { num: asset.fpsNum, den: asset.fpsDen };
  const frameMs = frameDurationMs(fps);

  const onScrub = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      seekTo(ratio * asset.durationMs);
      setPlayhead(ratio * asset.durationMs);
    },
    [asset.durationMs, setPlayhead],
  );

  const frame = msToFrame(playheadMs, fps);

  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-[--color-line] bg-[--color-surface-1] px-3 py-1.5">
      <div
        className="group relative h-6 w-[220px] shrink-0 cursor-pointer overflow-hidden rounded bg-[--color-surface-0]"
        onClick={onScrub}
        title="Scrub"
      >
        <div
          className="h-full bg-[--color-surface-3]"
          style={{ width: `${(playheadMs / Math.max(1, asset.durationMs)) * 100}%` }}
        />
      </div>

      <div className="flex items-center gap-1">
        <button className="btn btn-ghost btn-icon" title="Jump to start (Home)" onClick={() => seekTo(0)}>
          ⏮
        </button>
        <button
          className="btn btn-ghost btn-icon"
          title="Back one frame (←)"
          onClick={() => seekTo(playheadMs - frameMs)}
        >
          ◀|
        </button>
        <button
          className="btn btn-icon w-[52px] justify-center"
          title="Play / Pause (Space)"
          onClick={togglePlay}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <button
          className="btn btn-ghost btn-icon"
          title="Forward one frame (→)"
          onClick={() => seekTo(playheadMs + frameMs)}
        >
          |▶
        </button>
        <button
          className="btn btn-ghost btn-icon"
          title="Jump to end (End)"
          onClick={() => seekTo(asset.durationMs)}
        >
          ⏭
        </button>
      </div>

      <div className="flex items-baseline gap-1.5 font-mono text-[12px]">
        <span className="text-[--color-ink] tabular-nums">
          {formatMs(playheadMs)}
        </span>
        <span className="text-[10px] text-[--color-ink-faint] tabular-nums">
          f{String(frame).padStart(6, '0')}
        </span>
        <span className="text-[10px] text-[--color-ink-faint]">/ {formatMs(asset.durationMs)}</span>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <select
          className="input w-[64px] py-0.5"
          value={rate}
          onChange={(e) => setRate(Number(e.target.value))}
          title="Playback speed"
        >
          {RATE_STEPS.map((r) => (
            <option key={r} value={r}>
              {RATE_LABELS[String(r)] ?? `${r}x`}
            </option>
          ))}
        </select>
        <button
          className="btn btn-ghost btn-icon"
          onClick={() => setMuted(!muted)}
          title={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          className="w-20 accent-[--color-accent]"
          title="Volume"
        />
      </div>
    </div>
  );
}

function formatMs(ms: number): string {
  const abs = Math.max(0, Math.round(ms));
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const s = Math.floor((abs % 60_000) / 1000);
  const cs = Math.floor((abs % 1000) / 10);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}.${pad(cs)}` : `${m}:${pad(s)}.${pad(cs)}`;
}

/** Waveform lives in the timeline; this is only used by the scrub widget. */
export function useWaveform(assetId: string | null) {
  return useQuery({
    queryKey: ['wave', assetId],
    queryFn: () => api.media.wave(assetId!),
    enabled: Boolean(assetId),
    staleTime: Infinity,
  });
}
