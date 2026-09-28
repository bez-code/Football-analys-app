/**
 * Keymap registry.
 *
 * Every user action is a named command with a default binding and a rebindable
 * slot. The application menu, the keyboard handler and the coding pad all
 * dispatch the same command ids, which is what stops a hotkey from silently
 * disagreeing with the button next to it.
 */

export interface CommandDef {
  readonly id: string;
  readonly label: string;
  readonly group: 'Transport' | 'Timeline' | 'Library' | 'Tagging' | 'View';
  readonly defaultKeys: readonly string[];
  /** Receives a normalised keyboard event, returns true if it handled it. */
  run: (e: KeyboardEvent) => void;
}

const registry = new Map<string, CommandDef>();
const bindings = new Map<string, string[]>();
let userOverrides: Record<string, string[]> = {};

export function defineCommands(defs: readonly CommandDef[]): void {
  for (const def of defs) {
    registry.set(def.id, def);
    if (!bindings.has(def.id)) {
      bindings.set(def.id, [...def.defaultKeys]);
    }
  }
}

/** Drop a command (e.g. a pad slot whose taxonomy row is gone). */
export function undefineCommand(id: string): void {
  registry.delete(id);
  bindings.delete(id);
}

export function applyKeymap(overrides: Record<string, string[]>): void {
  userOverrides = overrides;
  for (const [id, keys] of Object.entries(overrides)) {
    if (registry.has(id)) bindings.set(id, keys);
  }
}

export function keymapOverrides(): Record<string, string[]> {
  return { ...userOverrides };
}

export function allCommands(): readonly CommandDef[] {
  return [...registry.values()];
}

export function keysFor(id: string): readonly string[] {
  return bindings.get(id) ?? [];
}

/** `Cmd+Shift+K` -> `['Meta+Shift+KeyK']` style tokens. */
function normalise(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('Mod');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  // Prefer a stable physical key so the pad works on AZERTY and Dvorak too.
  parts.push(event.code.length > 1 ? event.code : `Key${event.key.toUpperCase()}`);
  return parts.join('+');
}

export function dispatchCommand(id: string, event?: KeyboardEvent): boolean {
  const def = registry.get(id);
  if (!def) return false;
  if (event) event.preventDefault();
  def.run(event ?? ({} as KeyboardEvent));
  return true;
}

let installed = false;

export function installKeymapHandler(target: Window = window): () => void {
  if (installed) return () => undefined;
  installed = true;

  const onKeyDown = (event: KeyboardEvent): void => {
    const target_ = event.target as HTMLElement | null;
    // Never steal keys from a text field. A typing analyst must be able to
    // write "shot" into a notes box without firing the Shot tag.
    if (target_) {
      const tag = target_.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target_.isContentEditable) return;
    }
    // Modifier-only presses and IME composition.
    if (event.key === 'Meta' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Shift') {
      return;
    }
    if (event.isComposing) return;

    const token = normalise(event);
    for (const [id, keys] of bindings) {
      if (keys.includes(token)) {
        if (dispatchCommand(id, event)) return;
      }
    }
  };

  target.addEventListener('keydown', onKeyDown, { capture: true });
  return () => {
    target.removeEventListener('keydown', onKeyDown, { capture: true });
    installed = false;
  };
}

/** Human-readable form for a binding token. */
export function prettyKey(token: string): string {
  return token
    .replace('Mod', navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl')
    .replace('Alt', navigator.platform.toLowerCase().includes('mac') ? '⌥' : 'Alt')
    .replace('Shift', '⇧')
    .replace(/^Key([A-Z])$/, '$1')
    .replace('Space', '␣')
    .replace('ArrowLeft', '←')
    .replace('ArrowRight', '→')
    .replace('ArrowUp', '↑')
    .replace('ArrowDown', '↓')
    .replace('Comma', ',')
    .replace('Period', '.')
    .replace('Slash', '/');
}
