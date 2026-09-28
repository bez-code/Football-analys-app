import type {
  Annotation,
  AppPaths,
  IngestSummary,
  Job,
  MediaAsset,
  NewTagEvent,
  ProgressEvent,
  Result,
  TagEvent,
  TagEventPatch,
  TagTypeWithDescriptors,
} from '@tactix/contracts';

/**
 * The single source of truth for the main <-> renderer contract. Both the
 * preload bridge and the main-process handlers import this, so a channel
 * cannot drift between the two sides.
 */
export const CH = {
  appPaths: 'app:paths',
  appInfo: 'app:info',
  dialogOpenVideos: 'dialog:openVideos',
  dialogOpenFolder: 'dialog:openFolder',
  dialogSaveFile: 'dialog:saveFile',
  libraryList: 'library:list',
  libraryGet: 'library:get',
  libraryIngest: 'library:ingest',
  libraryIngestPaths: 'library:ingestPaths',
  libraryRemove: 'library:remove',
  libraryReveal: 'library:reveal',
  mediaWave: 'media:wave',
  taggingListTypes: 'tagging:listTypes',
  taggingListEvents: 'tagging:listEvents',
  taggingInsertEvent: 'tagging:insertEvent',
  taggingPatchEvent: 'tagging:patchEvent',
  taggingDeleteEvent: 'tagging:deleteEvent',
  taggingListAnnotations: 'tagging:listAnnotations',
  jobsList: 'jobs:list',
  jobsCancel: 'jobs:cancel',
  eventJobProgress: 'event:jobProgress',
  eventMenuAction: 'event:menuAction',
} as const;

export interface FilePickerResult {
  readonly canceled: boolean;
  readonly paths: readonly string[];
}

export interface SaveFileResult {
  readonly canceled: boolean;
  readonly path: string | null;
}

export interface AppInfo {
  readonly version: string;
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
}

/** Actions the application menu dispatches into the renderer. */
export const MENU_ACTIONS = [
  'library.addVideo',
  'nav.library',
  'nav.match',
  'nav.training',
  'nav.analysis',
  'play.playPause',
  'play.stepBack',
  'play.stepForward',
  'play.jumpStart',
  'play.jumpEnd',
  'loop.setIn',
  'loop.setOut',
  'loop.clear',
  'tag.addFromPlayhead',
  'help.shortcuts',
] as const;

export type MenuAction = (typeof MENU_ACTIONS)[number];

/**
 * The entire surface exposed to the renderer via contextBridge. Deliberately
 * narrow: no `readFile`, no arbitrary path argument, no shell access. Every
 * method here is a named, audited operation.
 */
export interface TactixApi {
  app: {
    paths(): IpcResult<AppPaths>;
    info(): IpcResult<AppInfo>;
    /**
     * Resolve dropped File objects to real filesystem paths.
     *
     * `File.path` was removed in Electron 32; `webUtils.getPathForFile` is the
     * only supported way, and it lives in the preload. Drag-and-drop is
     * therefore the one ingest path that cannot be a plain named IPC call.
     */
    pathsForFiles(files: readonly File[]): readonly string[];
  };
  dialog: {
    openVideos(): IpcResult<FilePickerResult>;
    openFolder(): IpcResult<FilePickerResult>;
    saveFile(defaultName: string): IpcResult<SaveFileResult>;
  };
  library: {
    list(search?: string): IpcResult<MediaAsset[]>;
    get(id: string): IpcResult<MediaAsset | null>;
    ingest(): IpcResult<IngestSummary>;
    ingestPaths(paths: string[]): IpcResult<IngestSummary>;
    remove(id: string): IpcResult<void>;
    reveal(path: string): IpcResult<void>;
  };
  media: {
    wave(assetId: string): IpcResult<unknown | null>;
  };
  tagging: {
    listTypes(): IpcResult<TagTypeWithDescriptors[]>;
    listEvents(assetId: string): IpcResult<TagEvent[]>;
    insertEvent(input: NewTagEvent): IpcResult<TagEvent>;
    patchEvent(id: string, patch: TagEventPatch): IpcResult<TagEvent | null>;
    deleteEvent(id: string): IpcResult<void>;
    listAnnotations(assetId: string): IpcResult<Annotation[]>;
  };
  jobs: {
    list(): IpcResult<Job[]>;
    cancel(id: string): IpcResult<void>;
  };
  events: {
    onJobProgress(cb: (event: ProgressEvent) => void): () => void;
    onMenuAction(cb: (action: MenuAction) => void): () => void;
  };
}

/** Result envelope used for operations that can fail with a useful message. */
export type IpcResult<T> = Promise<Result<T>>;

export const PROTOCOL = 'tactix';
