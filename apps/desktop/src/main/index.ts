import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell, Menu } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { closeDatabase, openDatabase } from './db/index.js';
import { getQueue } from './jobs/queue.js';
import {
  getAsset,
  ingestFiles,
  listAssets,
  registerMediaJobs,
  removeAsset,
} from './media/ingest.js';
import { readWaveform } from './media/waveform.js';
import {
  deleteEvent,
  insertEvent,
  listAnnotations,
  listEvents,
  listTagTypes,
  patchEvent,
} from './tagging/store.js';
import { appPaths, dirKeys, ensurePaths, type DirKey } from './store/paths.js';
import { CH, PROTOCOL, type MenuAction } from '../common/ipc.js';
import type { IngestSummary, NewTagEvent, Result, TagEventPatch } from '@tactix/contracts';

const isDev = !app.isPackaged;

// electron-vite emits ESM (package.json has "type": "module"), so __dirname
// does not exist. Derive it once instead of scattering the dance everywhere.
const here = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

// The media protocol must be declared privileged *before* app ready, otherwise
// Chromium refuses to give it range support and <video> cannot seek.
protocol.registerSchemesAsPrivileged([
  {
    scheme: PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false,
      corsEnabled: true,
    },
  },
]);

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0b0e14',
    title: 'Tactix',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(here, '../preload/index.mjs'),
      // Hardening: the renderer gets no Node, no require, and a separate
      // process. Everything it can do goes through the preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  // A local tool has no business navigating anywhere or opening windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl && url.startsWith(devUrl)) return;
    event.preventDefault();
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(here, '../renderer/index.html'));
  }

  return win;
}

function buildMenu(): void {
  const send = (action: MenuAction): void => {
    mainWindow?.webContents.send(CH.eventMenuAction, action);
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? ([{ role: 'appMenu' }] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Add Video…', accelerator: 'CmdOrCtrl+O', click: () => send('library.addVideo') },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Tag at Playhead',
          accelerator: 'CmdOrCtrl+T',
          click: () => send('tag.addFromPlayhead'),
        },
      ],
    },
    {
      label: 'Playback',
      submenu: [
        { label: 'Play / Pause', accelerator: 'Space', click: () => send('play.playPause') },
        { label: 'Step Back', accelerator: 'CmdOrCtrl+Left', click: () => send('play.stepBack') },
        { label: 'Step Forward', accelerator: 'CmdOrCtrl+Right', click: () => send('play.stepForward') },
        { type: 'separator' },
        { label: 'Jump to Start', accelerator: 'CmdOrCtrl+Shift+Left', click: () => send('play.jumpStart') },
        { label: 'Jump to End', accelerator: 'CmdOrCtrl+Shift+Right', click: () => send('play.jumpEnd') },
        { type: 'separator' },
        { label: 'Set Loop In', accelerator: 'KeyI', click: () => send('loop.setIn') },
        { label: 'Set Loop Out', accelerator: 'KeyO', click: () => send('loop.setOut') },
        { label: 'Clear Loop', accelerator: 'KeyL', click: () => send('loop.clear') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Library', accelerator: 'CmdOrCtrl+1', click: () => send('nav.library') },
        { label: 'Match', accelerator: 'CmdOrCtrl+2', click: () => send('nav.match') },
        { label: 'Training', accelerator: 'CmdOrCtrl+3', click: () => send('nav.training') },
        { label: 'Analysis', accelerator: 'CmdOrCtrl+4', click: () => send('nav.analysis') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(process.platform === 'darwin'
          ? ([{ type: 'separator' }, { role: 'front' }] as Electron.MenuItemConstructorOptions[])
          : ([{ role: 'close' }] as Electron.MenuItemConstructorOptions[])),
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: () => send('help.shortcuts') },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Wrap a handler so thrown errors reach the renderer as data, not as a crash. */
function handle<A extends unknown[], R>(
  channel: string,
  fn: (...args: A) => Promise<R> | R,
): void {
  ipcMain.handle(channel, async (_event: IpcMainInvokeEvent, ...args: A) => {
    try {
      const value = await fn(...args);
      return { ok: true, value } satisfies Result<R>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message } satisfies Result<never>;
    }
  });
}

async function registerIpc(): Promise<void> {
  const paths = appPaths();

  handle(CH.appPaths, () => paths);
  handle(CH.appInfo, () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  }));

  handle(CH.dialogOpenVideos, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Add video',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm', 'mts', 'm2ts'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return { canceled: res.canceled, paths: res.filePaths };
  });

  handle(CH.dialogOpenFolder, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Add folder',
      properties: ['openDirectory'],
    });
    return { canceled: res.canceled, paths: res.filePaths };
  });

  handle(CH.dialogSaveFile, async (defaultName: string) => {
    const res = await dialog.showSaveDialog(mainWindow!, { defaultPath: defaultName });
    return { canceled: res.canceled, path: res.filePath ?? null };
  });

  handle(CH.libraryList, (search: string) => listAssets(search));
  handle(CH.libraryGet, (id: string) => getAsset(id));
  handle(CH.libraryIngest, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Add video',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm'] }],
    });
    if (res.canceled || res.filePaths.length === 0) {
      return { added: [], skipped: [], errored: [] } satisfies IngestSummary;
    }
    return ingestFiles(paths, res.filePaths);
  });
  handle(CH.libraryIngestPaths, (p: string[]) => ingestFiles(paths, p));
  handle(CH.libraryRemove, (id: string) => removeAsset(id));
  handle(CH.libraryReveal, (p: string) => shell.showItemInFolder(p));

  handle(CH.mediaWave, async (assetId: string) => {
    const asset = getAsset(assetId);
    if (!asset?.wavePath) return null;
    try {
      const raw = await readFile(asset.wavePath, 'utf8');
      return readWaveform(JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  });

  handle(CH.taggingListTypes, () => listTagTypes());
  handle(CH.taggingListEvents, (assetId: string) => listEvents(assetId));
  handle(CH.taggingInsertEvent, (input: NewTagEvent) => insertEvent(input));
  handle(CH.taggingPatchEvent, (id: string, patch: TagEventPatch) => patchEvent(id, patch));
  handle(CH.taggingDeleteEvent, (id: string) => deleteEvent(id));
  handle(CH.taggingListAnnotations, (assetId: string) => listAnnotations(assetId));

  handle(CH.jobsList, () => getQueue().list());
  handle(CH.jobsCancel, (id: string) => getQueue().cancel(id));
}

/**
 * Serve derived media over a custom scheme.
 *
 * `net.fetch` on a file:// URL gives us HTTP semantics for free, including
 * range requests, which is exactly what Chromium's media element needs to seek
 * in a proxy file. Serving via a scheme also keeps the renderer's <video> from
 * ever touching the filesystem directly.
 */
function registerMediaProtocol(): void {
  const paths = appPaths();
  // Only derived-media buckets. `db`, `exports` and `models` stay unreachable
  // from the renderer even though they live in the same AppPaths object.
  const SAFE_KEYS = new Set<DirKey>(['proxies', 'sprites', 'waves', 'clips']);

  protocol.handle(PROTOCOL, async (request) => {
    try {
      const url = new URL(request.url);
      // tactix://proxy/<file>  |  tactix://sprite/<file>  |  tactix://clips/<file>
      const bucket = url.hostname as DirKey;
      if (!SAFE_KEYS.has(bucket)) {
        return new Response('Not found', { status: 404 });
      }
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      // Reject traversal. The renderer must never be able to address a file
      // outside the app's own derived-media directories.
      if (relative.includes('..') || relative.includes('\0')) {
        return new Response('Forbidden', { status: 403 });
      }
      const target = join(paths[bucket], relative);
      return await net.fetch(`file://${encodeURI(target).replace(/#/g, '%23')}`);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
  });
}

void app.whenReady().then(async () => {
  const paths = appPaths();
  ensurePaths(paths);

  openDatabase(paths);
  registerMediaJobs(paths);
  getQueue().start();
  await registerIpc();
  registerMediaProtocol();
  buildMenu();

  mainWindow = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  getQueue().stop();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Stop workers first: a job in flight holds a prepared statement, and
  // better-sqlite3 will refuse to close the handle underneath it.
  getQueue().stop();
  closeDatabase();
});

export { dirKeys };
