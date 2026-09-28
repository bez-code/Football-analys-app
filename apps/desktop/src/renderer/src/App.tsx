import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { HelpModal, JobBar, Toasts } from './components/Chrome';
import { LibraryView, Sidebar } from './components/Shell';
import { PlayerView } from './components/Player';
import { Timeline } from './components/Timeline';
import { SidePanel } from './components/SidePanel';
import { api } from './lib/api';
import { setQueryClient, registerCommands, dispatchCommand } from './lib/commands';
import { useEditor } from './lib/store';
import { playerBridge } from './lib/playerBridge';

export default function App(): React.JSX.Element {
  const qc = useQueryClient();
  const view = useEditor((s) => s.view);
  const asset = useEditor((s) => s.activeAsset);
  const setEvents = useEditor((s) => s.setEvents);
  const notify = useEditor((s) => s.notify);

  setQueryClient(qc);

  useEffect(() => registerCommands(), []);

  // The application menu runs in the main process, so its clicks arrive as
  // `event:menuAction` rather than as commands. Without this subscription the
  // entire menu bar is decoration: File > Add Video and Playback > Play/Pause
  // would silently do nothing while the equivalent hotkey worked.
  useEffect(() => {
    return window.tactix.events.onMenuAction((action) => {
      if (!dispatchCommand(action)) {
        useEditor.getState().notify('info', `Not available: ${action}`);
      }
    });
  }, []);

  // Load the event log once per asset and keep it in the store so the timeline
  // and the event list share one source of truth.
  useEffect(() => {
    if (!asset) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    void qc
      .fetchQuery({ queryKey: ['events', asset.id], queryFn: () => api.tagging.listEvents(asset.id) })
      .then((evts) => {
        if (!cancelled) setEvents(evts);
      })
      .catch((e: unknown) => {
        if (!cancelled) notify('error', `Could not load events: ${String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [asset, qc, setEvents, notify]);

  // Loop enforcement.
  useEffect(() => {
    const el = playerBridge.el;
    if (!el || !asset) return;

    const seekToLoopIn = () => {
      const { loopInMs, loopOutMs } = useEditor.getState();
      if (loopInMs === null || loopOutMs === null) return;
      if (el.currentTime * 1000 >= loopOutMs) el.currentTime = loopInMs / 1000;
    };

    // requestVideoFrameCallback fires once per *presented* frame, so the
    // playhead can overshoot loop-out by at most one frame. Polling on a timer
    // is frame-rate blind: a 40 ms interval overshoots by 160 ms of media at
    // 4x playback, which is long enough to tag the wrong moment, and the error
    // grows with the playback rate.
    if (typeof el.requestVideoFrameCallback === 'function') {
      let handle = 0;
      const onFrame = () => {
        seekToLoopIn();
        handle = el.requestVideoFrameCallback(onFrame);
      };
      handle = el.requestVideoFrameCallback(onFrame);
      return () => el.cancelVideoFrameCallback(handle);
    }

    // Older Chromium without the frame-callback API.
    const id = setInterval(seekToLoopIn, 40);
    return () => clearInterval(id);
  }, [asset, view]);

  const showPlayer = view === 'match' || view === 'training' || view === 'analysis';

  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-[--color-surface-0] text-[--color-ink]">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {showPlayer && asset ? (
          <>
            <TitleBar />
            <div className="min-h-0 flex-1">
              <PlayerView />
            </div>
            <Timeline asset={asset} />
            <JobBar />
          </>
        ) : (
          <>
            <LibraryView />
            <JobBar />
          </>
        )}
      </main>
      {showPlayer && <SidePanel />}
      <Toasts />
      <HelpModal />
    </div>
  );
}

function TitleBar(): React.JSX.Element | null {
  const asset = useEditor((s) => s.activeAsset);
  const side = useEditor((s) => s.activeSide);
  const setSide = useEditor((s) => s.setActiveSide);
  if (!asset) return null;
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-[--color-line] bg-[--color-surface-1] px-3">
      <span className="truncate text-[12px] font-medium" title={asset.path}>
        {asset.name}
      </span>
      <div className="ml-auto flex items-center gap-1 rounded border border-[--color-line] p-0.5 text-[10px]">
        {(['HOME', 'AWAY'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSide(s)}
            className={`rounded px-2 py-0.5 font-medium transition-colors ${
              side === s ? 'bg-[--color-surface-3] text-[--color-ink]' : 'text-[--color-ink-faint]'
            }`}
            title="Team side being tagged (Tab)"
          >
            {s === 'HOME' ? 'Home' : 'Away'}
          </button>
        ))}
      </div>
    </header>
  );
}
