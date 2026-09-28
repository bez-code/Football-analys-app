import { create } from 'zustand';
import { useEditor } from './store';

export interface TimelineState {
  /**
   * Visible window in milliseconds. `viewStartMs` .. `viewStartMs + viewSpanMs`.
   * Timeline state is deliberately separate from editor state: it changes on
   * every wheel tick and must not re-render the event table.
   */
  viewStartMs: number;
  viewSpanMs: number;
  durationMs: number;

  setDuration: (ms: number) => void;
  setView: (startMs: number, spanMs: number) => void;
  zoomBy: (factor: number) => void;
  zoomAt: (factor: number, anchorMs: number) => void;
  fitAll: () => void;
  centerOnPlayhead: () => void;
  panBy: (deltaMs: number) => void;
}

const MIN_SPAN_MS = 500; // 0.5 s - roughly 12 frames at 25 fps
const MAX_SPAN_MS = 6 * 60 * 60 * 1000;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const useTimeline = create<TimelineState>((set, get) => ({
  viewStartMs: 0,
  viewSpanMs: 60_000,
  durationMs: 0,

  setDuration: (ms) => {
    const { viewStartMs, viewSpanMs } = get();
    // Keep the current window if it still fits; otherwise refit.
    if (ms > 0 && viewStartMs + viewSpanMs > ms + 1) {
      set({ durationMs: ms, viewStartMs: 0, viewSpanMs: ms });
    } else {
      set({ durationMs: ms });
    }
  },

  setView: (startMs, spanMs) => {
    const { durationMs } = get();
    const span = clamp(spanMs, MIN_SPAN_MS, Math.max(MIN_SPAN_MS, durationMs || MAX_SPAN_MS));
    const maxStart = Math.max(0, durationMs - span);
    set({ viewStartMs: clamp(startMs, 0, maxStart), viewSpanMs: span });
  },

  /**
   * Zoom around an anchor rather than the window centre, so the pixel under
   * the cursor stays put. This is the difference between usable zoom and
   * "why did the playhead jump".
   */
  zoomAt: (factor, anchorMs) => {
    const { viewStartMs, viewSpanMs, durationMs } = get();
    const span = clamp(viewSpanMs / factor, MIN_SPAN_MS, Math.max(MIN_SPAN_MS, durationMs || MAX_SPAN_MS));
    const ratio = (anchorMs - viewStartMs) / viewSpanMs;
    const start = anchorMs - ratio * span;
    const maxStart = Math.max(0, durationMs - span);
    set({ viewStartMs: clamp(start, 0, maxStart), viewSpanMs: span });
  },

  zoomBy: (factor) => {
    const { viewStartMs, viewSpanMs } = get();
    get().zoomAt(factor, viewStartMs + viewSpanMs / 2);
  },

  fitAll: () => {
    const { durationMs } = get();
    if (durationMs > 0) set({ viewStartMs: 0, viewSpanMs: durationMs });
  },

  centerOnPlayhead: () => {
    const { playheadMs } = useEditor.getState();
    const { viewSpanMs, durationMs } = get();
    const maxStart = Math.max(0, durationMs - viewSpanMs);
    set({ viewStartMs: clamp(playheadMs - viewSpanMs / 2, 0, maxStart) });
  },

  panBy: (deltaMs) => {
    const { viewStartMs, viewSpanMs, durationMs } = get();
    const maxStart = Math.max(0, durationMs - viewSpanMs);
    set({ viewStartMs: clamp(viewStartMs + deltaMs, 0, maxStart) });
  },
}));
