import { useEditor } from './store';
import { defineCommands, installKeymapHandler, undefineCommand } from './keymap';
import { api } from './api';
import { useTimeline } from './timelineStore';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { playerBridge, seekTo, stepFrames, stepRate, togglePlay } from './playerBridge';

/**
 * Every user action is defined exactly once, here. The application menu, the
 * keyboard handler and the on-screen buttons all dispatch these same ids.
 *
 * That is not a stylistic preference: a coding pad where the hotkey and the
 * button can disagree is worse than no hotkey at all, because you stop
 * trusting both.
 */
export function registerCommands(): () => void {
  defineCommands([
    // ── transport ─────────────────────────────────────────────────────────
    {
      id: 'play.playPause',
      label: 'Play / Pause',
      group: 'Transport',
      defaultKeys: ['Space'],
      run: () => togglePlay(),
    },
    {
      id: 'play.stepBack',
      label: 'Step back one frame',
      group: 'Transport',
      // Arrow Left / Right rather than comma/period: they sit under the right
      // hand where frame work happens.
      defaultKeys: ['ArrowLeft', 'Comma'],
      run: () => {
        const { playheadMs } = useEditor.getState();
        stepFrames(-1, playheadMs);
      },
    },
    {
      id: 'play.stepForward',
      label: 'Step forward one frame',
      group: 'Transport',
      defaultKeys: ['ArrowRight', 'Period'],
      run: () => {
        const { playheadMs } = useEditor.getState();
        stepFrames(1, playheadMs);
      },
    },
    {
      id: 'play.jumpBack',
      label: 'Back one second',
      group: 'Transport',
      defaultKeys: ['Shift+ArrowLeft'],
      run: () => seekTo(useEditor.getState().playheadMs - 1000),
    },
    {
      id: 'play.jumpForward',
      label: 'Forward one second',
      group: 'Transport',
      defaultKeys: ['Shift+ArrowRight'],
      run: () => seekTo(useEditor.getState().playheadMs + 1000),
    },
    {
      id: 'play.jumpStart',
      label: 'Jump to start',
      group: 'Transport',
      defaultKeys: ['Home'],
      run: () => seekTo(0),
    },
    {
      id: 'play.jumpEnd',
      label: 'Jump to end',
      group: 'Transport',
      defaultKeys: ['End'],
      run: () => {
        const a = useEditor.getState().activeAsset;
        if (a) seekTo(a.durationMs);
      },
    },
    {
      id: 'play.rateUp',
      label: 'Playback faster',
      group: 'Transport',
      defaultKeys: ['Shift+Period'],
      run: () => {
        const { rate, setRate } = useEditor.getState();
        setRate(stepRate(1, rate));
      },
    },
    {
      id: 'play.rateDown',
      label: 'Playback slower',
      group: 'Transport',
      defaultKeys: ['Shift+Comma'],
      run: () => {
        const { rate, setRate } = useEditor.getState();
        setRate(stepRate(-1, rate));
      },
    },
    {
      id: 'play.resetRate',
      label: 'Playback speed 1x',
      group: 'Transport',
      defaultKeys: ['Mod+Digit0'],
      run: () => {
        const el = playerBridge.el;
        const s = useEditor.getState();
        s.setRate(1);
        if (el) el.playbackRate = 1;
      },
    },

    // ── loop ──────────────────────────────────────────────────────────────
    {
      id: 'loop.setIn',
      label: 'Set loop in point',
      group: 'Transport',
      defaultKeys: ['KeyI'],
      run: () => {
        const s = useEditor.getState();
        s.setLoop(s.playheadMs, s.loopOutMs && s.loopOutMs > s.playheadMs + 200 ? s.loopOutMs : null);
      },
    },
    {
      id: 'loop.setOut',
      label: 'Set loop out point',
      group: 'Transport',
      defaultKeys: ['KeyO'],
      run: () => {
        const s = useEditor.getState();
        s.setLoop(
          s.loopInMs !== null && s.loopInMs < s.playheadMs - 200 ? s.loopInMs : null,
          s.playheadMs,
        );
      },
    },
    {
      id: 'loop.clear',
      label: 'Clear loop',
      group: 'Transport',
      defaultKeys: ['KeyL'],
      run: () => useEditor.getState().setLoop(null, null),
    },

    // ── timeline ──────────────────────────────────────────────────────────
    {
      id: 'timeline.zoomIn',
      label: 'Zoom timeline in',
      group: 'Timeline',
      defaultKeys: ['Equal', 'NumpadAdd'],
      run: () => useTimeline.getState().zoomBy(1.6),
    },
    {
      id: 'timeline.zoomOut',
      label: 'Zoom timeline out',
      group: 'Timeline',
      defaultKeys: ['Minus', 'NumpadSubtract'],
      run: () => useTimeline.getState().zoomBy(1 / 1.6),
    },
    {
      id: 'timeline.frameAll',
      label: 'Fit whole match',
      group: 'Timeline',
      defaultKeys: ['Digit0'],
      run: () => useTimeline.getState().fitAll(),
    },
    {
      id: 'timeline.framePlayhead',
      label: 'Centre on playhead',
      group: 'Timeline',
      // Deliberately not KeyF: the seeded coding pad binds F to a shot, and a
      // pad hotkey must never be shadowed by a view shortcut.
      defaultKeys: ['KeyG'],
      run: () => useTimeline.getState().centerOnPlayhead(),
    },

    // ── library ───────────────────────────────────────────────────────────
    {
      id: 'library.addVideo',
      label: 'Add video to library',
      group: 'Library',
      defaultKeys: ['Mod+KeyO'],
      run: () => void addVideos(),
    },
    {
      id: 'library.focusSearch',
      label: 'Focus search',
      group: 'Library',
      defaultKeys: ['Mod+KeyF'],
      run: () => {
        document.getElementById('library-search')?.focus();
      },
    },

    // ── tagging ───────────────────────────────────────────────────────────
    {
      id: 'tag.addFromPlayhead',
      label: 'Tag at playhead',
      group: 'Tagging',
      defaultKeys: ['Mod+KeyT'],
      run: () => void addTagAtPlayhead(),
    },
    {
      id: 'side.toggle',
      label: 'Switch team side',
      group: 'Tagging',
      defaultKeys: ['Tab'],
      run: () => {
        const s = useEditor.getState();
        s.setActiveSide(s.activeSide === 'HOME' ? 'AWAY' : 'HOME');
      },
    },

    // ── view ──────────────────────────────────────────────────────────────
    {
      id: 'nav.library',
      label: 'Library',
      group: 'View',
      defaultKeys: ['Mod+Digit1'],
      run: () => useEditor.getState().setView('library'),
    },
    {
      id: 'nav.match',
      label: 'Match',
      group: 'View',
      defaultKeys: ['Mod+Digit2'],
      run: () => useEditor.getState().setView('match'),
    },
    {
      id: 'nav.training',
      label: 'Training',
      group: 'View',
      defaultKeys: ['Mod+Digit3'],
      run: () => useEditor.getState().setView('training'),
    },
    {
      id: 'nav.analysis',
      label: 'Analysis',
      group: 'View',
      defaultKeys: ['Mod+Digit4'],
      run: () => useEditor.getState().setView('analysis'),
    },
    {
      id: 'help.shortcuts',
      label: 'Keyboard shortcuts',
      group: 'View',
      defaultKeys: ['Mod+Slash'],
      run: () => useEditor.getState().setHelpOpen(true),
    },
  ]);

  const uninstall = installKeymapHandler();
  return uninstall;
}

// ─────────────────────────────────────────────── command implementations ──
export async function addVideos(): Promise<void> {
  const store = useEditor.getState();
  try {
    const summary = await api.library.ingest();
    if (summary.added.length > 0) {
      store.notify('ok', `Added ${summary.added.length} video${summary.added.length === 1 ? '' : 's'}`);
    } else if (summary.skipped.length > 0) {
      store.notify('info', summary.skipped[0]?.reason ?? 'Already in library');
    }
    invalidate(['assets']);
  } catch (err) {
    store.notify('error', err instanceof Error ? err.message : String(err));
  }
}

async function addTagAtPlayhead(): Promise<void> {
  const s = useEditor.getState();
  const typeId = s.activeTagTypeId ?? 'tt_pass';
  await insertTagAt(typeId);
}

/**
 * The one place a tag is created. The coding pad button, the pad hotkey and the
 * menu all land here, so an event cannot pick up a different side, timestamp or
 * armed descriptor depending on how the analyst triggered it.
 *
 * `pendingDescriptorValueIds` is consumed: the pad is an *arming* surface, not a
 * permanent filter, so an unarmed tag is a bare tag rather than an accidental
 * repeat of the previous one's answers.
 */
export async function insertTagAt(tagTypeId: string): Promise<void> {
  const s = useEditor.getState();
  const asset = s.activeAsset;
  if (!asset) {
    s.notify('info', 'Open a video first');
    return;
  }
  s.setActiveTagTypeId(tagTypeId);
  try {
    const created = await api.tagging.insertEvent({
      assetId: asset.id,
      tInMs: s.playheadMs,
      tagTypeId,
      side: s.activeSide,
      descriptorValueIds: s.pendingDescriptorValueIds,
    });
    s.addEvent(created);
    s.setPendingDescriptorValueIds([]);
    invalidate(['events', asset.id], ['jobs']);
  } catch (err) {
    s.notify('error', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Register a command per taxonomy hotkey, taken from the DB rather than
 * hardcoded. Re-registering on taxonomy change is cheap and keeps the pad in
 * sync with a user-edited scheme; ids are `pad.<tagTypeId>` so a stale hotkey
 * from a previous scheme cannot be dispatched under a new name.
 */
export function registerPadCommands(
  types: readonly { id: string; name: string; hotkey: string | null }[],
): () => void {
  const ids: string[] = [];
  for (const t of types) {
    if (!t.hotkey) continue;
    const id = `pad.${t.id}`;
    ids.push(id);
    defineCommands([
      {
        id,
        label: `Tag ${t.name}`,
        group: 'Tagging',
        // Physical `Key<letter>`: the pad is bound to positions, not to the
        // glyph, so a non-QWERTY layout still triggers the same slot.
        defaultKeys: [`Key${t.hotkey.toUpperCase()}`],
        run: () => void insertTagAt(t.id),
      },
    ]);
  }
  return () => {
    for (const id of ids) undefineCommand(id);
  };
}

/**
 * Commands are invoked from a keydown handler, a menu action and a button, so
 * they cannot use hooks. App registers the query client once at mount and any
 * command that mutates data invalidates the affected key through this.
 */
let queryClientRef: QueryClient | null = null;

export function setQueryClient(qc: QueryClient): void {
  queryClientRef = qc;
}

export function invalidate(...keys: QueryKey[]): void {
  for (const queryKey of keys) queryClientRef?.invalidateQueries({ queryKey });
}

// Re-exported so App has one import for the whole command surface.
export { dispatchCommand } from './keymap';
