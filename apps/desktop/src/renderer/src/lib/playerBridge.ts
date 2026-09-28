import type { FrameRate } from '@tactix/contracts';

/**
 * A tiny imperative handle on the <video> element.
 *
 * Commands (keyboard, menu, buttons) need to drive playback, but React state
 * is the wrong place to keep a video element. This is a one-way reference: the
 * Player registers the element, commands call through it, and no component
 * ever reaches for the DOM directly.
 */
interface PlayerBridge {
  el: HTMLVideoElement | null;
  fps: FrameRate;
  /**
   * Wall-clock time until which presented frames must not move the playhead.
   *
   * `requestVideoFrameCallback` keeps firing for the frame the browser was
   * already decoding, and the seek target itself takes a moment to present. The
   * standard VideoFrameCallbackMetadata has no "I caused this" flag, so a short
   * suppression window is the honest fix: without it the playhead visibly jumps
   * backwards on every frame step, which destroys trust in the frame counter.
   */
  suppressUntil: number;
}

export const playerBridge: PlayerBridge = {
  el: null,
  fps: { num: 25, den: 1 },
  suppressUntil: 0,
};

export const frameDurationMs = (fps: FrameRate): number =>
  Math.round((1000 * fps.den) / fps.num);

/** How long to ignore presented frames after a programmatic seek. */
const SEEK_SETTLE_MS = 160;

export function seekTo(ms: number): void {
  const el = playerBridge.el;
  if (!el) return;
  playerBridge.suppressUntil = performance.now() + SEEK_SETTLE_MS;
  el.currentTime = Math.max(0, ms) / 1000;
}

export function stepFrames(count: number, fromMs: number): void {
  const dur = frameDurationMs(playerBridge.fps);
  seekTo(fromMs + count * dur);
}

export function togglePlay(): void {
  const el = playerBridge.el;
  if (!el) return;
  if (el.paused) {
    void el.play().catch(() => undefined);
  } else {
    el.pause();
  }
}

/**
 * The only place playback speeds are defined. Anything that changes rate -
 * hotkey, menu, dropdown - must step through this ladder so the values are
 * always reachable and always in the same order.
 */
export const RATE_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4] as const;
export type PlaybackRate = (typeof RATE_STEPS)[number];

export function stepRate(direction: 1 | -1, current: number): number {
  const i = RATE_STEPS.findIndex((r) => r >= current - 0.001);
  const next = Math.max(0, Math.min(RATE_STEPS.length - 1, (i < 0 ? 4 : i) + direction));
  return RATE_STEPS[next]!;
}
