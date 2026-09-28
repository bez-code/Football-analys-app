import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, spriteCount, spriteUrl } from '../lib/api';
import { useEditor } from '../lib/store';
import { useTimeline } from '../lib/timelineStore';
import { seekTo } from '../lib/playerBridge';
import type { MediaAsset, TagEvent, TagTypeWithDescriptors } from '@tactix/contracts';

const RULER_H = 18;
const THUMB_H = 40;
const WAVE_H = 34;
const MARKER_H = 12;
const TOTAL_H = RULER_H + THUMB_H + WAVE_H + MARKER_H;

interface Waveform {
  peaks: Float32Array;
  peakCount: number;
  bucketMs: number;
  version: number;
}

/**
 * The timeline is a single canvas, not a DOM tree.
 *
 * A 90-minute match can carry thousands of tags and 900+ thumbnails. React
 * reconciliation for that at 60 fps is not viable, and even a naive DOM
 * approach stutters. Canvas also lets us draw the ruler, waveform, thumbnails
 * and markers into one composited pass.
 */
export function Timeline({ asset }: { asset: MediaAsset }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  const playheadMs = useEditor((s) => s.playheadMs);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const events = useEditor((s) => s.events);
  const loopIn = useEditor((s) => s.loopInMs);
  const loopOut = useEditor((s) => s.loopOutMs);
  const setLoop = useEditor((s) => s.setLoop);

  const viewStartMs = useTimeline((s) => s.viewStartMs);
  const viewSpanMs = useTimeline((s) => s.viewSpanMs);
  const zoomAt = useTimeline((s) => s.zoomAt);
  const panBy = useTimeline((s) => s.panBy);

  const { data: types = [] } = useQuery({
    queryKey: ['tagTypes'],
    queryFn: () => api.tagging.listTypes(),
    staleTime: Infinity,
  });

  const { data: wave } = useQuery({
    queryKey: ['wave', asset.id],
    queryFn: () => api.media.wave(asset.id) as Promise<Waveform | null>,
    staleTime: Infinity,
  });

  const colorByType = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of types as TagTypeWithDescriptors[]) map.set(t.id, t.color);
    return map;
  }, [types]);

  // ── layout ────────────────────────────────────────────────────────────
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWidth(Math.max(0, Math.floor(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const msToX = useCallback(
    (ms: number) => ((ms - viewStartMs) / viewSpanMs) * width,
    [viewStartMs, viewSpanMs, width],
  );
  const xToMs = useCallback(
    (x: number) => viewStartMs + (x / Math.max(1, width)) * viewSpanMs,
    [viewStartMs, viewSpanMs, width],
  );

  // ── thumbnail cache ───────────────────────────────────────────────────
  const imagesRef = useRef(new Map<number, HTMLImageElement>());
  useEffect(() => {
    imagesRef.current.clear();
  }, [asset.id]);

  const ensureThumbs = useCallback(
    (visible: { from: number; to: number }) => {
      const total = spriteCount(asset);
      if (total === 0) return;
      const forRange = (from: number, to: number) => {
        for (let i = from; i <= to; i++) {
          if (i < 1 || i > total) continue;
          if (imagesRef.current.has(i)) continue;
          const url = spriteUrl(asset, i);
          if (!url) continue;
          const img = new Image();
          img.src = url;
          imagesRef.current.set(i, img);
        }
      };
      forRange(visible.from, visible.to);
    },
    [asset],
  );

  // ── render ────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(TOTAL_H * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${TOTAL_H}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, TOTAL_H);

    // background
    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, width, TOTAL_H);

    // ── ruler ───────────────────────────────────────────────────────────
    drawRuler(ctx, width, viewStartMs, viewSpanMs, asset.durationMs);

    // ── thumbnails ──────────────────────────────────────────────────────
    const total = spriteCount(asset);
    if (total > 0) {
      const tileMs = asset.durationMs / total;
      const thumbTop = RULER_H;
      // Only the thumbs intersecting the view, so a 900-tile match is cheap.
      const first = Math.max(0, Math.floor(viewStartMs / tileMs) - 1);
      const last = Math.min(total - 1, Math.ceil((viewStartMs + viewSpanMs) / tileMs) + 1);
      ensureThumbs({ from: first + 1, to: last + 1 });

      const targetTileW = 56;
      const step = Math.max(1, Math.ceil(targetTileW / Math.max(1, (tileMs / viewSpanMs) * width)));

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, thumbTop, width, THUMB_H);
      ctx.clip();
      ctx.fillStyle = '#05070b';
      ctx.fillRect(0, thumbTop, width, THUMB_H);

      for (let i = first; i <= last; i += step) {
        const x = msToX(i * tileMs);
        const w = Math.max(1, (tileMs / viewSpanMs) * width) - 1;
        const img = imagesRef.current.get(i + 1);
        if (img?.complete && img.naturalWidth > 0) {
          try {
            ctx.drawImage(img, x, thumbTop + 2, Math.max(1, w), THUMB_H - 4);
          } catch {
            /* image not decodable yet */
          }
        } else {
          ctx.fillStyle = '#11151f';
          ctx.fillRect(x, thumbTop + 2, Math.max(1, w), THUMB_H - 4);
        }
      }
      ctx.restore();
    }

    // ── waveform ────────────────────────────────────────────────────────
    const waveTop = RULER_H + THUMB_H;
    drawWaveform(ctx, width, waveTop, WAVE_H, wave, xToMs);

    // ── tag markers ─────────────────────────────────────────────────────
    const markTop = waveTop + WAVE_H;
    ctx.fillStyle = '#0d1017';
    ctx.fillRect(0, markTop, width, MARKER_H);
    drawMarkers(ctx, width, markTop, events as TagEvent[], colorByType, msToX);

    // ── loop region ─────────────────────────────────────────────────────
    if (loopIn !== null || loopOut !== null) {
      const a = loopIn ?? viewStartMs;
      const b = loopOut ?? viewStartMs + viewSpanMs;
      const xa = msToX(a);
      const xb = msToX(b);
      ctx.fillStyle = 'rgba(245, 197, 66, 0.14)';
      ctx.fillRect(Math.min(xa, xb), RULER_H, Math.abs(xb - xa), TOTAL_H - RULER_H);
      ctx.strokeStyle = 'rgba(245, 197, 66, 0.75)';
      ctx.lineWidth = 1;
      for (const x of [xa, xb]) {
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, RULER_H);
        ctx.lineTo(Math.round(x) + 0.5, TOTAL_H);
        ctx.stroke();
      }
    }

    // ── played region ───────────────────────────────────────────────────
    const px = msToX(playheadMs);
    if (px >= 0 && px <= width) {
      ctx.fillStyle = 'rgba(245, 197, 66, 0.07)';
      ctx.fillRect(0, RULER_H, px, TOTAL_H - RULER_H);
    }

    // ── playhead ────────────────────────────────────────────────────────
    if (px >= -2 && px <= width + 2) {
      ctx.strokeStyle = '#f5c542';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(px) + 0.5, 0);
      ctx.lineTo(Math.round(px) + 0.5, TOTAL_H);
      ctx.stroke();
      ctx.fillStyle = '#f5c542';
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 5, 0);
      ctx.lineTo(px, 7);
      ctx.closePath();
      ctx.fill();
    }
  }, [
    width, playheadMs, viewStartMs, viewSpanMs, events, colorByType,
    loopIn, loopOut, wave, asset, msToX, xToMs, ensureThumbs,
  ]);

  // ── interaction ────────────────────────────────────────────────────────
  const dragRef = useRef<{ mode: 'none' | 'seek' | 'loop' | 'pan'; startX: number; startStartMs: number }>({
    mode: 'none', startX: 0, startStartMs: 0,
  });

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ms = xToMs(x);
    if (e.shiftKey) {
      dragRef.current = { mode: 'loop', startX: x, startStartMs: ms };
      setLoop(Math.min(ms, ms), null);
    } else if (e.button === 1) {
      dragRef.current = { mode: 'pan', startX: x, startStartMs: viewStartMs };
    } else {
      dragRef.current = { mode: 'seek', startX: x, startStartMs: ms };
      seekTo(ms);
      setPlayhead(ms);
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const d = dragRef.current;
    if (d.mode === 'none') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ms = xToMs(x);
    if (d.mode === 'seek') {
      seekTo(ms);
      setPlayhead(ms);
    } else if (d.mode === 'loop') {
      setLoop(Math.min(d.startStartMs, ms), Math.max(d.startStartMs, ms));
    } else if (d.mode === 'pan') {
      const deltaMs = ((d.startX - x) / Math.max(1, width)) * viewSpanMs;
      panBy(deltaMs);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    dragRef.current = { mode: 'none', startX: 0, startStartMs: 0 };
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const anchorMs = xToMs(x);
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e.deltaY < 0 ? 1 / 1.18 : 1.18, anchorMs);
    } else if (e.shiftKey) {
      panBy((e.deltaY / Math.max(1, width)) * viewSpanMs * 2);
    } else {
      // Trackpad horizontal scroll pans; vertical zooms.
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        panBy((e.deltaX / Math.max(1, width)) * viewSpanMs);
      } else {
        zoomAt(e.deltaY < 0 ? 1 / 1.18 : 1.18, anchorMs);
      }
    }
  };

  return (
    <div ref={wrapRef} className="relative shrink-0 border-t border-[--color-line] bg-[--color-surface-0]">
      <canvas
        ref={canvasRef}
        className="block cursor-crosshair"
        style={{ height: TOTAL_H }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      />
      <div className="pointer-events-none absolute top-0.5 right-2 flex gap-2 text-[9px] text-[--color-ink-faint]">
        <span>⇧drag = loop</span>
        <span>⌘wheel = zoom</span>
        <span>middle-drag = pan</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── drawing ──

function drawRuler(
  ctx: CanvasRenderingContext2D,
  width: number,
  viewStart: number,
  viewSpan: number,
  duration: number,
): void {
  ctx.fillStyle = '#11151f';
  ctx.fillRect(0, 0, width, RULER_H);
  ctx.strokeStyle = '#262d3d';
  ctx.beginPath();
  ctx.moveTo(0, RULER_H - 0.5);
  ctx.lineTo(width, RULER_H - 0.5);
  ctx.stroke();

  // Choose a tick step that yields at least ~90px between labels.
  const targetPx = 90;
  const msPerPx = viewSpan / Math.max(1, width);
  const candidates = [
    100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000,
    60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000,
  ];
  const step = candidates.find((c) => c / msPerPx >= targetPx) ?? candidates[candidates.length - 1]!;
  const sub = step / 5;

  ctx.font = '9px ui-monospace, Menlo, monospace';
  ctx.textBaseline = 'middle';

  // minor ticks
  ctx.strokeStyle = '#1b2130';
  ctx.beginPath();
  for (let t = Math.floor(viewStart / sub) * sub; t <= viewStart + viewSpan; t += sub) {
    if (t < 0 || t > duration) continue;
    const x = Math.round(((t - viewStart) / viewSpan) * width) + 0.5;
    ctx.moveTo(x, RULER_H - 4);
    ctx.lineTo(x, RULER_H);
  }
  ctx.stroke();

  // major ticks + labels
  ctx.strokeStyle = '#3a4459';
  ctx.fillStyle = '#7d879c';
  ctx.beginPath();
  for (let t = Math.floor(viewStart / step) * step; t <= viewStart + viewSpan; t += step) {
    if (t < 0 || t > duration) continue;
    const x = Math.round(((t - viewStart) / viewSpan) * width) + 0.5;
    ctx.moveTo(x, RULER_H - 8);
    ctx.lineTo(x, RULER_H);
    ctx.fillText(tickLabel(t, step), x + 3, 6);
  }
  ctx.stroke();
}

function tickLabel(ms: number, step: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (step >= 3_600_000) return `${h}h${m.toString().padStart(2, '0')}`;
  if (step >= 60_000) return `${h > 0 ? `${h}:` : ''}${m}m`;
  const s = Math.floor((ms % 60_000) / 1000);
  return `${h > 0 ? `${h}:` : ''}${m}:${String(s).padStart(2, '0')}`;
}

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  width: number,
  top: number,
  height: number,
  wave: Waveform | null | undefined,
  xToMs: (x: number) => number,
): void {
  ctx.fillStyle = '#0d1017';
  ctx.fillRect(0, top, width, height);
  if (!wave || wave.peakCount === 0 || wave.bucketMs <= 0) return;

  const mid = top + height / 2;
  ctx.strokeStyle = 'rgba(120, 132, 155, 0.55)';
  ctx.fillStyle = 'rgba(120, 132, 155, 0.55)';
  ctx.beginPath();
  ctx.moveTo(0, Math.round(mid) + 0.5);
  ctx.lineTo(width, Math.round(mid) + 0.5);
  ctx.stroke();

  const peaks = wave.peaks;
  for (let x = 0; x < width; x++) {
    const t0 = xToMs(x);
    const t1 = xToMs(x + 1);
    const b0 = Math.max(0, Math.floor(t0 / wave.bucketMs));
    const b1 = Math.min(wave.peakCount - 1, Math.max(b0, Math.floor(t1 / wave.bucketMs)));
    let lo = 0;
    let hi = 0;
    for (let b = b0; b <= b1; b++) {
      const min = peaks[b * 2] ?? 0;
      const max = peaks[b * 2 + 1] ?? 0;
      if (min < lo) lo = min;
      if (max > hi) hi = max;
    }
    const y0 = mid - hi * (height / 2 - 1);
    const y1 = mid - lo * (height / 2 - 1);
    ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
}

function drawMarkers(
  ctx: CanvasRenderingContext2D,
  width: number,
  top: number,
  events: readonly TagEvent[],
  colorByType: Map<string, string>,
  msToX: (ms: number) => number,
): void {
  ctx.fillStyle = '#0d1017';
  ctx.fillRect(0, top, width, 12);

  for (const e of events) {
    const x = Math.round(msToX(e.tInMs));
    if (x < -4 || x > width + 4) continue;
    const color = colorByType.get(e.tagTypeId) ?? '#5f6a80';
    ctx.fillStyle = color;
    ctx.fillRect(x, top + 1, 2, 10);
    // Cap so a dense cluster reads as "a lot here" rather than a solid block.
    ctx.fillStyle = `${color}55`;
    ctx.fillRect(x, top + 1, 1, 10);
  }
}
