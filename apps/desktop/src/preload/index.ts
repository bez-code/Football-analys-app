import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ProgressEvent } from '@tactix/contracts';
import { CH, type MenuAction, type TactixApi } from '../common/ipc.js';

/**
 * The bridge is the trust boundary. The renderer is treated as hostile: it gets
 * a fixed set of named operations and nothing else. No fs, no child_process,
 * no arbitrary ipcRenderer.invoke - a compromised renderer cannot turn an XSS
 * into arbitrary file access.
 */
const api: TactixApi = {
  app: {
    paths: () => ipcRenderer.invoke(CH.appPaths),
    info: () => ipcRenderer.invoke(CH.appInfo),
    // Synchronous by design: it is a pure property lookup on a File the
    // renderer already holds, and the drop handler needs the paths immediately
    // to decide whether to even attempt an ingest. Anything that goes wrong
    // degrades to "no paths", which the renderer turns into a helpful message.
    pathsForFiles: (files) => {
      const out: string[] = [];
      for (const file of files) {
        try {
          const p = webUtils.getPathForFile(file);
          if (p) out.push(p);
        } catch {
          /* not a real on-disk file (e.g. dragged from a browser) */
        }
      }
      return out;
    },
  },
  dialog: {
    openVideos: () => ipcRenderer.invoke(CH.dialogOpenVideos),
    openFolder: () => ipcRenderer.invoke(CH.dialogOpenFolder),
    saveFile: (defaultName: string) => ipcRenderer.invoke(CH.dialogSaveFile, defaultName),
  },
  library: {
    list: (search) => ipcRenderer.invoke(CH.libraryList, search ?? ''),
    get: (id) => ipcRenderer.invoke(CH.libraryGet, id),
    ingest: () => ipcRenderer.invoke(CH.libraryIngest),
    ingestPaths: (paths) => ipcRenderer.invoke(CH.libraryIngestPaths, paths),
    remove: (id) => ipcRenderer.invoke(CH.libraryRemove, id),
    reveal: (path) => ipcRenderer.invoke(CH.libraryReveal, path),
  },
  media: {
    wave: (assetId) => ipcRenderer.invoke(CH.mediaWave, assetId),
  },
  tagging: {
    listTypes: () => ipcRenderer.invoke(CH.taggingListTypes),
    listEvents: (assetId) => ipcRenderer.invoke(CH.taggingListEvents, assetId),
    insertEvent: (input) => ipcRenderer.invoke(CH.taggingInsertEvent, input),
    patchEvent: (id, patch) => ipcRenderer.invoke(CH.taggingPatchEvent, id, patch),
    deleteEvent: (id) => ipcRenderer.invoke(CH.taggingDeleteEvent, id),
    listAnnotations: (assetId) => ipcRenderer.invoke(CH.taggingListAnnotations, assetId),
  },
  jobs: {
    list: () => ipcRenderer.invoke(CH.jobsList),
    cancel: (id) => ipcRenderer.invoke(CH.jobsCancel, id),
  },
  events: {
    onJobProgress: (cb) => subscribe<ProgressEvent>(CH.eventJobProgress, cb),
    onMenuAction: (cb) => subscribe<MenuAction>(CH.eventMenuAction, cb),
  },
};

/** Always return an unsubscribe function so React effects can clean up. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('tactix', api);
