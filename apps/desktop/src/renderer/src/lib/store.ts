import { create } from 'zustand';
import type { Job, MediaAsset, PitchPoint, PlayerSide, TagEvent } from '@tactix/contracts';

export type View = 'library' | 'match' | 'training' | 'analysis';

interface EditorState {
  // ── navigation ──────────────────────────────────────────────────────────
  view: View;
  setView: (v: View) => void;

  // ── selection ───────────────────────────────────────────────────────────
  /** The asset currently open in the player. */
  activeAsset: MediaAsset | null;
  openAsset: (a: MediaAsset | null) => void;

  // ── transport ───────────────────────────────────────────────────────────
  /** Integer ms. Never a float - see the time rules in @tactix/contracts. */
  playheadMs: number;
  setPlayhead: (ms: number) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  rate: number;
  setRate: (r: number) => void;
  volume: number;
  setVolume: (v: number) => void;
  muted: boolean;
  setMuted: (m: boolean) => void;

  // ── selection overlays ──────────────────────────────────────────────────
  loopInMs: number | null;
  loopOutMs: number | null;
  setLoop: (inMs: number | null, outMs: number | null) => void;
  activeTagTypeId: string | null;
  setActiveTagTypeId: (id: string | null) => void;
  activeSide: PlayerSide;
  setActiveSide: (s: PlayerSide) => void;
  /**
   * Descriptor values armed in the coding pad, consumed by the next event.
   *
   * These are NOT `playerInMatchId`: a descriptor value ("Cross", "Right foot")
   * and a player are different vocabularies with different foreign keys, and
   * conflating them writes a value that the schema rejects. There is no player
   * picker yet because there is no squad UI to pick from.
   */
  pendingDescriptorValueIds: string[];
  toggleDescriptorValue: (id: string) => void;
  setPendingDescriptorValueIds: (ids: string[]) => void;
  /** Where a new pitch-space annotation is anchored. */
  pitchAnchor: PitchPoint | null;
  setPitchAnchor: (p: PitchPoint | null) => void;

  // ── data ────────────────────────────────────────────────────────────────
  events: TagEvent[];
  setEvents: (e: TagEvent[]) => void;
  addEvent: (e: TagEvent) => void;
  updateEvent: (id: string, patch: Partial<TagEvent>) => void;
  removeEvent: (id: string) => void;

  jobs: Job[];
  setJobs: (j: Job[]) => void;

  // ── transient UI ────────────────────────────────────────────────────────
  toast: { kind: 'info' | 'error' | 'ok'; message: string } | null;
  notify: (kind: 'info' | 'error' | 'ok', message: string) => void;
  dismissToast: () => void;
  helpOpen: boolean;
  setHelpOpen: (v: boolean) => void;
}

let toastSeq = 0;

export const useEditor = create<EditorState>((set, get) => ({
  view: 'library',
  setView: (view) => set({ view }),

  activeAsset: null,
  openAsset: (activeAsset) =>
    set({
      activeAsset,
      playheadMs: 0,
      loopInMs: null,
      loopOutMs: null,
      events: [],
      activeTagTypeId: null,
      pendingDescriptorValueIds: [],
      pitchAnchor: null,
    }),

  playheadMs: 0,
  setPlayhead: (playheadMs) => set({ playheadMs: Math.max(0, Math.round(playheadMs)) }),
  playing: false,
  setPlaying: (playing) => set({ playing }),
  rate: 1,
  setRate: (rate) => set({ rate }),
  volume: 1,
  setVolume: (volume) => set({ volume: Math.max(0, Math.min(1, volume)) }),
  muted: false,
  setMuted: (muted) => set({ muted }),

  loopInMs: null,
  loopOutMs: null,
  setLoop: (loopInMs, loopOutMs) => set({ loopInMs, loopOutMs }),
  activeTagTypeId: null,
  setActiveTagTypeId: (activeTagTypeId) => set({ activeTagTypeId }),
  activeSide: 'HOME',
  setActiveSide: (activeSide) => set({ activeSide }),
  pendingDescriptorValueIds: [],
  toggleDescriptorValue: (id) =>
    set((s) => ({
      pendingDescriptorValueIds: s.pendingDescriptorValueIds.includes(id)
        ? s.pendingDescriptorValueIds.filter((v) => v !== id)
        : [...s.pendingDescriptorValueIds, id],
    })),
  setPendingDescriptorValueIds: (pendingDescriptorValueIds) => set({ pendingDescriptorValueIds }),
  pitchAnchor: null,
  setPitchAnchor: (pitchAnchor) => set({ pitchAnchor }),

  events: [],
  setEvents: (events) => set({ events }),
  addEvent: (e) => set((s) => ({ events: [...s.events, e] })),
  updateEvent: (id, patch) =>
    set((s) => ({ events: s.events.map((e) => (e.id === id ? { ...e, ...patch } : e)) })),
  removeEvent: (id) => set((s) => ({ events: s.events.filter((e) => e.id !== id) })),

  jobs: [],
  setJobs: (jobs) => set({ jobs }),

  toast: null,
  notify: (kind, message) => {
    const seq = ++toastSeq;
    set({ toast: { kind, message } });
    // Auto-dismiss; newer toasts win the race via the captured sequence.
    setTimeout(() => {
      if (get().toast && toastSeq === seq) set({ toast: null });
    }, kind === 'error' ? 8000 : 3500);
  },
  dismissToast: () => set({ toast: null }),
  helpOpen: false,
  setHelpOpen: (helpOpen) => set({ helpOpen }),
}));
