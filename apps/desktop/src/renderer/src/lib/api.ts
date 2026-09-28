import type { MediaAsset, Result, TagEvent, TagTypeWithDescriptors } from '@tactix/contracts';
import type { TactixApi } from '../../../common/ipc';

/**
 * Thin typed wrapper over the preload bridge.
 *
 * The bridge can reject (window closed, handler threw), and it also returns a
 * Result envelope for handled failures. Both become a thrown Error here so the
 * renderer only has one error path to deal with.
 */
async function call<T>(fn: () => Promise<Result<T>>): Promise<T> {
  const res = await fn();
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

/** Like `call` but never throws - returns null instead. For optional reads. */
async function callOrNull<T>(fn: () => Promise<Result<T>>): Promise<T | null> {
  try {
    return await call(fn);
  } catch {
    return null;
  }
}

export const api = {
  app: {
    paths: () => call(() => window.tactix.app.paths()),
    info: () => call(() => window.tactix.app.info()),
  },
  library: {
    list: (search = '') => call(() => window.tactix.library.list(search)),
    get: (id: string) => callOrNull(() => window.tactix.library.get(id)),
    ingest: () => call(() => window.tactix.library.ingest()),
    ingestPaths: (paths: string[]) => call(() => window.tactix.library.ingestPaths(paths)),
    remove: (id: string) => call(() => window.tactix.library.remove(id)),
    reveal: (path: string) => call(() => window.tactix.library.reveal(path)),
  },
  media: {
    wave: (assetId: string) => callOrNull(() => window.tactix.media.wave(assetId)),
  },
  tagging: {
    listTypes: () => call(() => window.tactix.tagging.listTypes()) as Promise<TagTypeWithDescriptors[]>,
    listEvents: (assetId: string) => call(() => window.tactix.tagging.listEvents(assetId)) as Promise<TagEvent[]>,
    insertEvent: (input: Parameters<TactixApi['tagging']['insertEvent']>[0]) =>
      call(() => window.tactix.tagging.insertEvent(input)),
    patchEvent: (id: string, patch: Parameters<TactixApi['tagging']['patchEvent']>[1]) =>
      call(() => window.tactix.tagging.patchEvent(id, patch)),
    deleteEvent: (id: string) => call(() => window.tactix.tagging.deleteEvent(id)),
    listAnnotations: (assetId: string) => call(() => window.tactix.tagging.listAnnotations(assetId)),
  },
  jobs: {
    list: () => call(() => window.tactix.jobs.list()),
    cancel: (id: string) => call(() => window.tactix.jobs.cancel(id)),
  },
};

/** URL for the playback proxy, served over the custom tactix: scheme. */
export function proxyUrl(asset: MediaAsset): string | null {
  if (!asset.proxyPath) return null;
  const file = asset.proxyPath.split(/[\\/]/).pop()!;
  return `tactix://proxy/${encodeURIComponent(file)}`;
}

/** URL for one scrub-bar thumbnail. `index` is 1-based, matching ffmpeg output. */
export function spriteUrl(asset: MediaAsset, index: number): string | null {
  if (!asset.spritePath) return null;
  const file = asset.spritePath.replace('%04d', String(index).padStart(4, '0')).split(/[\\/]/).pop()!;
  return `tactix://sprite/${encodeURIComponent(file)}`;
}

/** How many thumbnails ffmpeg produced, derived from the same rule it used. */
export function spriteCount(asset: MediaAsset): number {
  if (!asset.spritePath) return 0;
  const intervalSec = Math.max(2, Math.min(10, asset.durationMs / 1000 / 900));
  return Math.min(4096, Math.floor(asset.durationMs / 1000 / intervalSec));
}
