import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Clapperboard,
  Dumbbell,
  Library,
  LineChart,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { api, spriteCount, spriteUrl } from '../lib/api';
import { useEditor, type View } from '../lib/store';
import { addVideos, invalidate } from '../lib/commands';
import { useTimeline } from '../lib/timelineStore';
import { formatDuration } from '@tactix/contracts';

const NAV: { view: View; label: string; icon: typeof Library }[] = [
  { view: 'library', label: 'Library', icon: Library },
  { view: 'match', label: 'Match', icon: Clapperboard },
  { view: 'training', label: 'Training', icon: Dumbbell },
  { view: 'analysis', label: 'Analysis', icon: LineChart },
];

export function Sidebar(): React.JSX.Element {
  const view = useEditor((s) => s.view);
  const setView = useEditor((s) => s.setView);
  const activeAsset = useEditor((s) => s.activeAsset);

  return (
    <nav className="flex w-[172px] shrink-0 flex-col border-r border-[--color-line] bg-[--color-surface-1]">
      <div className="flex h-11 items-center gap-2 border-b border-[--color-line] px-3">
        <div className="h-2 w-2 rounded-full bg-[--color-accent]" />
        <span className="text-[13px] font-semibold tracking-tight">Tactix</span>
      </div>

      <div className="flex flex-col gap-0.5 p-2">
        {NAV.map(({ view: v, label, icon: Icon }) => {
          const disabled = v !== 'library' && !activeAsset;
          return (
            <button
              key={v}
              disabled={disabled}
              onClick={() => setView(v)}
              className={`flex items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                view === v
                  ? 'bg-[--color-surface-3] text-[--color-ink]'
                  : 'text-[--color-ink-dim] hover:bg-[--color-surface-2] hover:text-[--color-ink]'
              }`}
            >
              <Icon size={14} className="shrink-0" />
              {label}
            </button>
          );
        })}
      </div>

      <div className="mt-auto border-t border-[--color-line] p-2">
        <AddButton />
      </div>
    </nav>
  );
}

function AddButton(): React.JSX.Element {
  const notify = useEditor((s) => s.notify);
  return (
    <button
      className="btn btn-primary w-full justify-center"
      onClick={() => void addVideos().catch((e: unknown) => notify('error', String(e)))}
    >
      <Plus size={13} />
      Add video
    </button>
  );
}

// ─────────────────────────────────────────────────────────────── library ──

export function LibraryView(): React.JSX.Element {
  const [search, setSearch] = useState('');
  const [dropping, setDropping] = useState(false);
  const openAsset = useEditor((s) => s.openAsset);
  const setView = useEditor((s) => s.setView);
  const setDuration = useTimeline((s) => s.setDuration);
  const fitAll = useTimeline((s) => s.fitAll);
  const notify = useEditor((s) => s.notify);

  // Debounce so typing does not hammer SQLite on every keystroke.
  const debounced = useDebounced(search, 180);

  const { data: assets = [], isLoading } = useQuery({
    queryKey: ['assets', debounced],
    queryFn: () => api.library.list(debounced),
  });

  const handleDrop = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      try {
        const summary = await api.library.ingestPaths(paths);
        if (summary.added.length > 0) {
          notify('ok', `Added ${summary.added.length} video${summary.added.length === 1 ? '' : 's'}`);
        }
        if (summary.errored.length > 0) {
          notify('error', summary.errored[0]!.reason);
        }
        invalidate(['assets']);
      } catch (e) {
        notify('error', e instanceof Error ? e.message : String(e));
      }
    },
    [notify],
  );

  const open = useCallback(
    (assetId: string) => {
      const asset = assets.find((a) => a.id === assetId);
      if (!asset) return;
      openAsset(asset);
      setDuration(asset.durationMs);
      fitAll();
      setView('match');
    },
    [assets, openAsset, setDuration, fitAll, setView],
  );

  return (
    <div
      className="flex h-full flex-col"
      onDragOver={(e) => {
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        const paths = window.tactix.app.pathsForFiles([...e.dataTransfer.files]);
        if (paths.length === 0) {
          // Dropped from a browser, or the OS gave us something we cannot
          // address on disk. The dialog always works.
          notify('info', 'That drop has no file on disk - use Add video instead');
          return;
        }
        void handleDrop([...paths]);
      }}
    >
      <div className="flex items-center gap-3 border-b border-[--color-line] px-4 py-2.5">
        <h1 className="text-[13px] font-semibold">Video library</h1>
        <div className="relative max-w-[320px] flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[--color-ink-faint]"
          />
          <input
            id="library-search"
            className="input pl-7"
            placeholder="Search by filename…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span className="ml-auto text-[11px] text-[--color-ink-faint]">
          {assets.length} file{assets.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <Empty label="Loading…" />
        ) : assets.length === 0 ? (
          <Empty
            label={search ? 'No files match that search' : 'Drop video files here'}
            hint={
              search
                ? undefined
                : 'Or use Add video. Files stay where they are — nothing is copied or uploaded.'
            }
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
            {assets.map((asset) => (
              <AssetCard key={asset.id} asset={asset} onOpen={() => open(asset.id)} />
            ))}
          </div>
        )}
      </div>

      {dropping && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-[--color-accent] bg-[--color-surface-0]/80">
          <span className="text-[13px] font-medium text-[--color-accent]">
            Drop to add to library
          </span>
        </div>
      )}
    </div>
  );
}

function Empty({ label, hint }: { label: string; hint?: string }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
      <Clapperboard size={26} className="mb-1 text-[--color-ink-faint]" />
      <p className="text-[13px] text-[--color-ink-dim]">{label}</p>
      {hint && <p className="max-w-[380px] text-[11px] text-[--color-ink-faint]">{hint}</p>}
    </div>
  );
}

function AssetCard({
  asset,
  onOpen,
}: {
  asset: import('@tactix/contracts').MediaAsset;
  onOpen: () => void;
}): React.JSX.Element {
  const notify = useEditor((s) => s.notify);
  const [confirming, setConfirming] = useState(false);
  const count = spriteCount(asset);
  const thumb = count > 0 ? spriteUrl(asset, 1 + Math.floor(count / 2)) : null;
  const busy = asset.proxyState === 'PENDING';

  return (
    <div className="panel group relative overflow-hidden">
      <button onClick={onOpen} className="block w-full text-left">
        <div className="relative aspect-video w-full overflow-hidden bg-black">
          {thumb ? (
            <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <div className="flex h-full items-center justify-center text-[10px] text-[--color-ink-faint]">
              {busy ? 'Preparing…' : 'No preview'}
            </div>
          )}
          <span className="absolute right-1.5 bottom-1 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[10px] text-white/90">
            {formatDuration(asset.durationMs)}
          </span>
        </div>
        <div className="p-2">
          <p className="truncate text-[12px] font-medium" title={asset.path}>
            {asset.name}
          </p>
          <p className="mt-0.5 truncate text-[10px] text-[--color-ink-faint]">
            {asset.width}×{asset.height} · {asset.fpsNum}/{asset.fpsDen} · {asset.videoCodec ?? '?'}
          </p>
        </div>
      </button>

      <div className="pointer-events-none absolute top-1.5 right-1.5 flex gap-1">
        {!asset.wasCfr && (
          <span
            title="Source is variable frame rate. The proxy has been normalised to constant frame rate."
            className="rounded bg-amber-500/90 px-1.5 py-0.5 text-[9px] font-semibold text-black"
          >
            VFR
          </span>
        )}
        {asset.hdrTransfer && asset.hdrTransfer !== 'bt709' && (
          <span className="rounded bg-sky-500/90 px-1.5 py-0.5 text-[9px] font-semibold text-black">
            {asset.hdrTransfer.toUpperCase()}
          </span>
        )}
        {asset.proxyState === 'FAILED' && (
          <span title="Proxy generation failed - the original will still play" className="text-red-400">
            <AlertTriangle size={13} />
          </span>
        )}
      </div>

      <div className="absolute right-1 bottom-1 opacity-0 transition-opacity group-hover:opacity-100">
        {confirming ? (
          <div className="flex gap-1">
            <button
              className="btn btn-icon bg-red-600 text-white"
              onClick={async (e) => {
                e.stopPropagation();
                try {
                  await api.library.remove(asset.id);
                  invalidate(['assets']);
                  setConfirming(false);
                } catch (err) {
                  notify('error', String(err));
                }
              }}
            >
              <Trash2 size={12} />
            </button>
            <button className="btn btn-icon" onClick={(e) => { e.stopPropagation(); setConfirming(false); }}>
              ✕
            </button>
          </div>
        ) : (
          <button
            className="btn btn-icon opacity-0 group-hover:opacity-100"
            title="Remove from library (the file on disk is not deleted)"
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(true);
            }}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return v;
}
