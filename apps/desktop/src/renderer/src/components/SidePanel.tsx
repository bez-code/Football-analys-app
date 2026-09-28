import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Trash2, X } from 'lucide-react';
import { api } from '../lib/api';
import { insertTagAt, registerPadCommands } from '../lib/commands';
import { useEditor } from '../lib/store';
import { seekTo } from '../lib/playerBridge';
import { formatDuration, type TagEvent, type TagTypeWithDescriptors } from '@tactix/contracts';

type Panel = 'coding' | 'events';

export function SidePanel(): React.JSX.Element {
  const [panel, setPanel] = useState<Panel>('coding');

  return (
    <aside className="flex w-[268px] shrink-0 flex-col border-l border-[--color-line] bg-[--color-surface-1]">
      <div className="flex shrink-0 border-b border-[--color-line]">
        {(['coding', 'events'] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPanel(p)}
            className={`flex-1 border-b-2 py-2 text-[11px] font-medium capitalize transition-colors ${
              panel === p
                ? 'border-[--color-accent] text-[--color-ink]'
                : 'border-transparent text-[--color-ink-faint] hover:text-[--color-ink-dim]'
            }`}
          >
            {p === 'coding' ? 'Coding pad' : 'Events'}
            {p === 'events' && <EventCount />}
          </button>
        ))}
      </div>

      {panel === 'coding' ? <CodingPad /> : <EventList />}
    </aside>
  );
}

function EventCount(): React.JSX.Element | null {
  const n = useEditor((s) => s.events.length);
  return <span className="ml-1.5 text-[10px] text-[--color-ink-faint]">{n}</span>;
}

// ───────────────────────────────────────────────────────────── coding pad ──

function CodingPad(): React.JSX.Element {
  const activeTagTypeId = useEditor((s) => s.activeTagTypeId);
  const [filter, setFilter] = useState('');

  const { data: types = [] } = useQuery({
    queryKey: ['tagTypes'],
    queryFn: () => api.tagging.listTypes(),
    staleTime: Infinity,
  });

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return types;
    return types.filter(
      (t) => t.name.toLowerCase().includes(q) || t.descriptors.some((d) => d.name.toLowerCase().includes(q)),
    );
  }, [types, filter]);

  // Group by parent so the pad reads as the scheme's shape, not a flat list.
  const grouped = useMemo(() => {
    const roots = filtered.filter((t) => !t.parentId);
    return roots.map((root) => ({
      root,
      children: filtered.filter((t) => t.parentId === root.id),
    }));
  }, [filtered]);

  // Hotkeys come from the DB, so the pad is the component that knows about
  // them. Re-registered whenever the taxonomy changes.
  useEffect(() => registerPadCommands(types), [types]);

  const insert = useCallback(
    async (t: TagTypeWithDescriptors) => {
      await insertTagAt(t.id);
    },
    [],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative shrink-0 border-b border-[--color-line] p-2">
        <Search
          size={12}
          className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-[--color-ink-faint]"
        />
        <input
          className="input py-1 pl-6 text-[11px]"
          placeholder="Find a tag…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {grouped.length === 0 ? (
          <p className="p-3 text-[11px] text-[--color-ink-faint]">No tag types loaded.</p>
        ) : (
          grouped.map(({ root, children }) => (
            <div key={root.id} className="mb-1.5">
              <TagButton type={root} active={activeTagTypeId === root.id} onPick={() => void insert(root)} />
              {children.length > 0 && (
                <div className="mt-0.5 ml-3 border-l border-[--color-line] pl-1.5">
                  {children.map((child) => (
                    <TagButton
                      key={child.id}
                      type={child}
                      depth={1}
                      active={activeTagTypeId === child.id}
                      onPick={() => void insert(child)}
                    />
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function TagButton({
  type,
  active,
  depth = 0,
  onPick,
}: {
  type: TagTypeWithDescriptors;
  active: boolean;
  depth?: number;
  onPick: () => void;
}): React.JSX.Element {
  const armed = useEditor((s) => s.pendingDescriptorValueIds);
  const toggleDescriptorValue = useEditor((s) => s.toggleDescriptorValue);
  const [showValues, setShowValues] = useState(false);

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={onPick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onPick();
          }
        }}
        className={`group flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors ${
          active ? 'bg-[--color-surface-3]' : 'hover:bg-[--color-surface-2]'
        }`}
        style={{ paddingLeft: `${6 + depth * 4}px` }}
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
          style={{ background: type.color }}
          aria-hidden
        />
        <span className="flex-1 truncate text-[11.5px] leading-tight">{type.name}</span>
        {type.descriptors.length > 0 && (
          <button
            className="shrink-0 rounded px-1 text-[13px] leading-none text-[--color-ink-faint] hover:text-[--color-ink]"
            title="Descriptors"
            onClick={(e) => {
              e.stopPropagation();
              setShowValues((v) => !v);
            }}
          >
            {showValues ? '▾' : '▸'}
          </button>
        )}
        {type.hotkey && (
          <kbd className="shrink-0 rounded border border-[--color-line] px-1 font-mono text-[9px] text-[--color-ink-faint]">
            {type.hotkey}
          </kbd>
        )}
      </div>

      {showValues && (
        <div className="ml-4 border-l border-[--color-line] pl-1.5">
          {type.descriptors.map((d) => (
            <div key={d.id}>
              <div className="px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-[--color-ink-faint]">
                {d.name}
              </div>
              <div className="flex flex-wrap gap-1 px-1 pb-1">
                {d.values.map((v) => {
                  const on = armed.includes(v.id);
                  return (
                    <button
                      key={v.id}
                      title={on ? 'Armed — applied to the next tag' : 'Arm this value'}
                      aria-pressed={on}
                      onClick={() => toggleDescriptorValue(v.id)}
                      className="rounded px-1.5 py-0.5 text-[10px] transition-colors"
                      style={{
                        background: on ? (v.color ?? '#3a6ff0') : 'transparent',
                        color: on ? '#fff' : 'var(--color-ink-dim)',
                        border: `1px solid ${on ? 'transparent' : 'var(--color-line)'}`,
                      }}
                    >
                      {v.value}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────── event list ──

function EventList(): React.JSX.Element {
  const events = useEditor((s) => s.events);
  const removeEvent = useEditor((s) => s.removeEvent);
  const notify = useEditor((s) => s.notify);
  const asset = useEditor((s) => s.activeAsset);
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: types = [] } = useQuery({
    queryKey: ['tagTypes'],
    queryFn: () => api.tagging.listTypes(),
    staleTime: Infinity,
  });
  const byId = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);

  if (!asset) return <p className="p-3 text-[11px] text-[--color-ink-faint]">No video open.</p>;

  const sorted = [...events].sort((a, b) => a.tInMs - b.tInMs);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {sorted.length === 0 ? (
        <p className="p-3 text-[11px] text-[--color-ink-faint]">
          No events yet. Pick a tag in the coding pad — it lands at the playhead.
        </p>
      ) : (
        <table className="w-full text-[11px]">
          <tbody>
            {sorted.map((e) => {
              const t = byId.get(e.tagTypeId);
              const isOpen = expanded === e.id;
              return (
                <tr
                  key={e.id}
                  onClick={() => {
                    setSelected(e.id);
                    seekTo(e.tInMs);
                  }}
                  className={`cursor-pointer border-b border-[--color-line]/60 ${
                    selected === e.id ? 'bg-[--color-surface-3]' : 'hover:bg-[--color-surface-2]'
                  }`}
                >
                  <td className="w-[2px] p-0">
                    <span className="block h-full w-full" style={{ background: t?.color ?? '#555' }} />
                  </td>
                  <td className="py-1 pr-1 pl-2 align-top">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[10px] text-[--color-ink-faint] tabular-nums">
                        {formatDuration(e.tInMs)}
                      </span>
                      {e.tOutMs !== null && (
                        <span className="text-[9px] text-[--color-ink-faint]">
                          →{formatDuration(e.tOutMs)}
                        </span>
                      )}
                      {e.side && (
                        <span className="text-[9px] text-[--color-ink-faint]">
                          {e.side === 'HOME' ? 'H' : 'A'}
                        </span>
                      )}
                      <button
                        className="ml-auto shrink-0 text-[--color-ink-faint] hover:text-[--color-ink]"
                        title="Notes"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setExpanded(isOpen ? null : e.id);
                        }}
                      >
                        ▸
                      </button>
                      <button
                        className="shrink-0 text-[--color-ink-faint] hover:text-red-400"
                        title="Delete event"
                        onClick={async (ev) => {
                          ev.stopPropagation();
                          try {
                            await api.tagging.deleteEvent(e.id);
                            removeEvent(e.id);
                            void qc.invalidateQueries({ queryKey: ['events', asset.id] });
                          } catch (err) {
                            notify('error', String(err));
                          }
                        }}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                    <div className="truncate text-[11px]">{t?.name ?? e.tagTypeId}</div>
                    {isOpen && <EventNotes event={e} onClose={() => setExpanded(null)} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="h-2" />
    </div>
  );
}

function EventNotes({ event, onClose }: { event: TagEvent; onClose: () => void }): React.JSX.Element {
  const notify = useEditor((s) => s.notify);
  const [text, setText] = useState(event.notes ?? '');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      if (!dirty) return;
      void api.tagging
        .patchEvent(event.id, { notes: text })
        .then(() => setDirty(false))
        .catch((e: unknown) => notify('error', String(e)));
    }, 400);
    return () => clearTimeout(t);
  }, [text, dirty, event.id, notify]);

  return (
    <div className="mt-1" onClick={(e) => e.stopPropagation()}>
      <textarea
        className="input min-h-[46px] w-full resize-y text-[11px]"
        value={text}
        placeholder="Notes…"
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
        onBlur={() => setDirty(true)}
      />
      <button className="btn btn-ghost mt-0.5" onClick={onClose}>
        <X size={10} /> Close
      </button>
    </div>
  );
}
