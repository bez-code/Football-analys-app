import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Loader2, X } from 'lucide-react';
import { api } from '../lib/api';
import { useEditor } from '../lib/store';
import { invalidate } from '../lib/commands';
import type { Job } from '@tactix/contracts';

export function JobBar(): React.JSX.Element | null {
  const [open, setOpen] = useState(false);

  const { data: jobs = [] } = useQuery({
    queryKey: ['jobs'],
    queryFn: () => api.jobs.list(),
    refetchInterval: (q) => {
      const list = q.state.data as Job[] | undefined;
      return list?.some((j) => j.state === 'RUNNING' || j.state === 'PENDING') ? 500 : 4000;
    },
  });

  // Keep the store copy in sync for components that only need the summary.
  const setJobs = useEditor((s) => s.setJobs);
  useEffect(() => {
    setJobs(jobs);
  }, [jobs, setJobs]);

  // A finished job changes what the library can show, so refresh it.
  const active = jobs.filter((j) => j.state === 'RUNNING' || j.state === 'PENDING');
  const failed = jobs.filter((j) => j.state === 'FAILED');
  if (active.length === 0 && failed.length === 0 && !open) return null;

  return (
    <div className="flex shrink-0 flex-col border-t border-[--color-line] bg-[--color-surface-1]">
      {open && (
        <div className="max-h-[180px] overflow-y-auto border-b border-[--color-line]">
          <table className="w-full text-[11px]">
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-b border-[--color-line]/50 last:border-0">
                  <td className="w-[14px] py-1 pl-3">
                    <StatusIcon status={j.state} />
                  </td>
                  <td className="py-1 font-mono text-[10px] text-[--color-ink-dim]">{j.kind}</td>
                  <td className="py-1">
                    {j.state === 'RUNNING' ? (
                      <div className="flex items-center gap-2">
                        <div className="h-1 w-full max-w-[180px] overflow-hidden rounded bg-[--color-surface-3]">
                          <div
                            className="h-full bg-[--color-accent]"
                            style={{ width: `${Math.round((j.progress ?? 0) * 100)}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-[--color-ink-faint] tabular-nums">
                          {Math.round((j.progress ?? 0) * 100)}%
                        </span>
                      </div>
                    ) : (
                      <span className="text-[10px] text-[--color-ink-faint]">
                        {j.state === 'DONE'
                          ? 'done'
                          : j.state === 'FAILED'
                            ? (j.lastError ?? 'failed')
                            : `queued · attempt ${j.attempts}`}
                      </span>
                    )}
                  </td>
                  <td className="w-[20px] py-1 pr-2 text-right">
                    {j.state === 'PENDING' || j.state === 'RUNNING' ? (
                      <button
                        className="btn btn-ghost btn-icon"
                        title="Cancel"
                        onClick={async () => {
                          await api.jobs.cancel(j.id);
                          invalidate(['jobs']);
                        }}
                      >
                        <X size={11} />
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <button
        className="flex items-center gap-2 px-3 py-1 text-[11px] text-[--color-ink-dim] hover:bg-[--color-surface-2]"
        onClick={() => setOpen((v) => !v)}
      >
        {active.length > 0 ? (
          <>
            <Loader2 size={11} className="animate-spin" />
            {active.length} task{active.length === 1 ? '' : 's'} running
          </>
        ) : failed.length > 0 ? (
          <>
            <AlertCircle size={11} className="text-amber-500" />
            {failed.length} task{failed.length === 1 ? '' : 's'} failed
          </>
        ) : (
          <>
            <CheckCircle2 size={11} className="text-emerald-500" />
            All tasks complete
          </>
        )}
        <span className="ml-auto text-[--color-ink-faint]">
          {open ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        </span>
      </button>
    </div>
  );
}

function StatusIcon({ status }: { status: Job['state'] }): React.JSX.Element {
  switch (status) {
    case 'RUNNING':
      return <Loader2 size={11} className="animate-spin text-[--color-ink-faint]" />;
    case 'DONE':
      return <CheckCircle2 size={11} className="text-emerald-500" />;
    case 'FAILED':
      return <AlertCircle size={11} className="text-red-400" />;
    default:
      return <span className="block h-1.5 w-1.5 rounded-full bg-[--color-ink-faint]" />;
  }
}

// ──────────────────────────────────────────────────────────────── toasts ──

export function Toasts(): React.JSX.Element | null {
  const toast = useEditor((s) => s.toast);
  const dismiss = useEditor((s) => s.dismissToast);
  const setHelpOpen = useEditor((s) => s.setHelpOpen);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismiss]);

  if (!toast) return null;
  const tone =
    toast.kind === 'error'
      ? 'border-red-500/40 bg-red-950/90 text-red-100'
      : toast.kind === 'ok'
        ? 'border-emerald-500/40 bg-emerald-950/90 text-emerald-100'
        : 'border-[--color-line] bg-[--color-surface-2] text-[--color-ink]';

  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-40 -translate-x-1/2">
      <div className={`pointer-events-auto flex items-center gap-3 rounded-md border px-3 py-2 shadow-lg ${tone}`}>
        <span className="text-[12px]">{toast.message}</span>
        <button
          className="text-[10px] underline underline-offset-2 opacity-70 hover:opacity-100"
          onClick={() => {
            setHelpOpen(true);
            dismiss();
          }}
        >
          shortcuts
        </button>
        <button className="opacity-60 hover:opacity-100" onClick={dismiss}>
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────── help modal ──

const HELP_GROUPS: { group: string; rows: { keys: string; label: string }[] }[] = [
  {
    group: 'Transport',
    rows: [
      { keys: 'Space', label: 'Play / pause' },
      { keys: '←  /  ,', label: 'Step back one frame' },
      { keys: '→  /  .', label: 'Step forward one frame' },
      { keys: '⇧ ← / →', label: 'Jump one second' },
      { keys: 'Home / End', label: 'Jump to start / end' },
      { keys: '⇧ , / .', label: 'Playback slower / faster' },
      { keys: '⌘ 0', label: 'Playback speed 1×' },
      { keys: 'I / O / L', label: 'Set loop in / out / clear' },
    ],
  },
  {
    group: 'Timeline',
    rows: [
      { keys: '+ / −', label: 'Zoom in / out' },
      { keys: '0', label: 'Fit whole match' },
      { keys: 'F', label: 'Centre on playhead' },
      { keys: '⌘ scroll', label: 'Zoom at cursor' },
      { keys: '⇧ drag', label: 'Set a loop range' },
    ],
  },
  {
    group: 'Tagging',
    rows: [
      { keys: '⌘ T', label: 'Tag at playhead' },
      { keys: 'Tab', label: 'Switch team side' },
    ],
  },
  {
    group: 'Navigate',
    rows: [
      { keys: '⌘ 1…4', label: 'Library / Match / Training / Analysis' },
      { keys: '⌘ O', label: 'Add video' },
      { keys: '⌘ F', label: 'Search the library' },
      { keys: '⌘ /', label: 'This help' },
      { keys: 'Esc', label: 'Dismiss' },
    ],
  },
];

export function HelpModal(): React.JSX.Element | null {
  const open = useEditor((s) => s.helpOpen);
  const setOpen = useEditor((s) => s.setHelpOpen);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;
  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={() => setOpen(false)}
    >
      <div
        className="max-h-full w-full max-w-[680px] overflow-y-auto rounded-lg border border-[--color-line] bg-[--color-surface-1] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold">Keyboard shortcuts</h2>
          <button className="btn btn-ghost btn-icon" onClick={() => setOpen(false)}>
            <X size={13} />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-5">
          {HELP_GROUPS.map((g) => (
            <section key={g.group}>
              <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[--color-ink-faint]">
                {g.group}
              </h3>
              <dl className="flex flex-col gap-1">
                {g.rows.map((r) => (
                  <div key={r.keys} className="flex items-baseline justify-between gap-3">
                    <dt className="shrink-0">
                      <kbd className="rounded border border-[--color-line] px-1.5 py-0.5 font-mono text-[10px] text-[--color-ink-dim]">
                        {r.keys}
                      </kbd>
                    </dt>
                    <dd className="truncate text-right text-[11px] text-[--color-ink-dim]">{r.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <p className="mt-5 border-t border-[--color-line] pt-3 text-[10.5px] text-[--color-ink-faint]">
          On macOS use ⌘; on Windows use Ctrl. Frame steps follow the source frame rate, so a 25 fps
          broadcast and a 50 fps phone capture both step by the frame you actually see.
        </p>
      </div>
    </div>
  );
}
