# Tactix

Local-first football video analysis for match tagging, tactical metrics, telestration
and skill assessment. Desktop app, no account, no server, no browser tab.

## Shape of the thing

```
Electron main (Node)
  ├─ SQLite (node:sqlite, WAL)      library, taxonomy, events, jobs
  ├─ ffmpeg / ffprobe (bundled)      proxy, thumbnails, waveform
  ├─ job queue                       SQLite table + in-process workers
  └─ tactix:// protocol              serves derived media to <video>/<img>
        ⇅ contextBridge (sandboxed, no Node in the renderer)
React renderer
  ├─ library grid
  ├─ player + frame-accurate transport
  ├─ canvas timeline (ruler / thumbnails / waveform / tag markers / loop)
  └─ coding pad + event list
```

Nothing listens on a port and nothing is uploaded. The original video is only ever
read; everything else is derived and lives in the app's `userData` directory.

## Requirements

- Node 20.20 or newer
- No compiler, and no `npm rebuild`. There is no native module: SQLite comes from
  `node:sqlite`, which is built into the Node 24 that Electron 44 bundles. That is
  deliberate — `better-sqlite3` cannot be compiled against Electron 44's V8 (it calls
  `v8::Context::GetIsolate`, which no longer exists), and a native module would mean a
  per-platform compile step on every install and a cross-compilation problem for
  installers.

## Commands

| command | what it does |
| --- | --- |
| `npm run dev` | run the app with hot reload |
| `npm run typecheck` | typecheck main/preload and renderer separately |
| `npm run build` | bundle into `apps/desktop/out` |
| `npm run smoke` | headless end-to-end check (see below) |
| `npm run dist:mac` | macOS arm64 `.dmg` — **must run on macOS** |
| `npm run dist:win` | Windows x64 NSIS installer — **must run on Windows** |

`npm run smoke` is the one test that runs anywhere. It generates a 12-second clip with
ffmpeg, then exercises migrations, seeding, ingest, probing, the job queue, proxy,
sprite and waveform generation, and tag-event round-tripping. It has since caught
several real bugs: an extension test that matched nothing, a job queue that handed
handlers the raw JSON string, and an ffmpeg filter that cannot exist. It runs inside
Electron's own Node (`scripts/run-smoke.mjs`, `ELECTRON_RUN_AS_NODE=1`) so the test
exercises the same runtime the app ships in.

Packaging: a macOS `.dmg` must be produced on macOS (Apple tooling, and the bundle
is code-signed). With no native modules left, a Windows installer is no longer
blocked on a compiler, but electron-builder still wants its own platform toolchain
for some steps, so build each target on its own OS to be safe.

## Conventions worth knowing before you change things

- **Time is integer milliseconds** everywhere it is stored or compared. Floats only
  exist in the ffmpeg command line.
- **Frame rates are rationals** (`fps_num` / `fps_den`), because 30000/1001 is a real
  frame rate and rounding it to 30 drifts.
- **Pitch coordinates are Metrica-normalised** `0..1` with an explicit `attackDir`.
  Metric coordinates are derived, never stored.
- **Calibration belongs to a camera shot, not a file.** A phone recording that pans
  needs a new homography; reusing the previous one silently corrupts every metric.
- **Originals are immutable.** Proxies, thumbnails, waveforms, clips and reports are
  all derived and regenerable.
- **One command registry.** `renderer/src/lib/commands.ts` is the only place an action
  is defined. The menu, the keyboard and the buttons all dispatch the same ids, so they
  cannot disagree.

## Layout

```
packages/contracts     shared types, time and coordinate maths
apps/desktop
  src/main              db, jobs, media, tagging, ipc, store
  src/preload           the entire renderer-visible API surface
  src/common            channel names + the TactixApi type
  src/renderer          React app
  scripts/smoke.ts      headless end-to-end check
```

## Status

Working: ingest, proxying, thumbnails, waveform, timeline, coding pad, event log,
keyboard/menu command registry, library search, drag-and-drop ingest.

Not built yet: pitch calibration and the tactical metrics that depend on it,
telestration (Konva is installed but unused), clip export, reports, fixtures and squads,
tracking, and the training/analysis views beyond their navigation.
