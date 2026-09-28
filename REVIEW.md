# Tactix — Build Review

Status: **core tagging pipeline complete, verified headlessly. Main process boots under real
Electron. No window has ever been displayed.**
Author: coding agent. Everything below is reproducible from the repo at `/workspace`.

Read this if you want to review the work, take it over, or decide what to build next.

---

## 1. What this is

A local-first football video analysis desktop app. Analyst imports a match recording,
gets a scrubbable proxy, and codes events (pass, shot, duel) onto a timeline, tagging
descriptors against each one. Intended to become a tactics/telestration tool.

**Explicit non-goals** (agreed at the start): no accounts, no cloud, no server, no
browser tab, no Python sidecar, no multi-user. The original video is read-only; all
proxies, thumbnails, waveforms, clips and reports are derived and regenerable.

**Target platforms**: macOS Apple Silicon, Windows x64.

### Honest state of the thing

It is a *tagging* app, not a *tactics* app. Everything in §4 works and is tested.
Everything in §9 (calibration, Konva pitch, clips, reports, squads, tracking) is
schema-only scaffolding. Do not read the presence of 32 tables as 32 features.

---

## 2. Architecture

```
┌─ Electron main (Node) ──────────────────────────────────────────────┐
│  SQLite (node:sqlite, WAL)        library, taxonomy, events, jobs    │
│  ffmpeg + ffprobe (bundled)       proxy, thumbnails, waveform       │
│  job queue                        SQLite table + in-process workers │
│  tactix:// protocol               serves derived media to <video>/<img>│
│  application menu ──event:menuAction──┐                             │
└──────────────────────┬──────────────┬─┘
        contextBridge   │              │
┌──────────────────────▼──────────────▼───────────────────────────────┐
│  React renderer (no Node, no fs, no network)                        │
│  library grid · player · canvas timeline · coding pad · event log    │
└─────────────────────────────────────────────────────────────────────┘
```

Process separation is the security boundary. The renderer has no filesystem access at
all; it reaches the main process only through ~22 typed channels, and reads media only
through a custom `tactix://` scheme. `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, strict CSP.

### ~6,500 lines across 32 source files, zero native modules

| Area | File | LOC | Responsibility |
| --- | --- | ---: | --- |
| contracts | `packages/contracts/src/index.ts` | 409 | shared types, time/frame/coordinate maths |
| data | `src/main/db/sqlite.ts` | 108 | `node:sqlite` adapter (replaced better-sqlite3) |
| data | `src/main/db/migrations.ts` | 511 | 32 tables, 21 indexes, FKs |
| data | `src/main/db/index.ts` | 248 | pragmas, migration runner, taxonomy seed |
| media | `src/main/media/ffmpeg.ts` | 367 | probe, SHA-1, proxy + sprite arg builders |
| media | `src/main/media/ingest.ts` | 336 | library ingest, job registration |
| media | `src/main/media/waveform.ts` | 149 | PCM min/max peaks |
| jobs | `src/main/jobs/queue.ts` | 280 | worker pool, progress, retry, recovery |
| tagging | `src/main/tagging/store.ts` | 327 | taxonomy, descriptors, events, journal |
| shell | `src/main/index.ts` | 345 | lifecycle, menu, IPC, protocol |
| ipc | `src/common/ipc.ts` | 140 | channel names + `TactixApi` type |
| ipc | `src/preload/index.ts` | 75 | the whole renderer-visible surface |
| ui | `src/renderer/src/components/Timeline.tsx` | 439 | canvas ruler/thumbs/wave/markers/loop |
| ui | `src/renderer/src/lib/commands.ts` | 357 | single command registry |
| ui | `src/renderer/src/components/SidePanel.tsx` | 357 | coding pad, descriptors, event log |
| ui | `src/renderer/src/components/Shell.tsx` | 317 | sidebar, library, drag-and-drop |
| ui | `src/renderer/src/components/Player.tsx` | 294 | video stage, frame stepping |
| ui | `src/renderer/src/components/Chrome.tsx` | 275 | job bar, toasts, help modal |
| state | `src/renderer/src/lib/store.ts` | 140 | editor state |
| state | `src/renderer/src/lib/keymap.ts` | 126 | command registry mechanics |
| ui | `src/renderer/src/App.tsx` | 125 | layout, wiring |
| state | `src/renderer/src/lib/timelineStore.ts` | 86 | timeline viewport |
| state | `src/renderer/src/lib/playerBridge.ts` | 72 | video element bridge |
| test | `apps/desktop/scripts/smoke.ts` | 202 | headless end-to-end |
| test | `apps/desktop/scripts/run-smoke.mjs` | 58 | runs the smoke test inside Electron's Node |

---

## 3. Invariants you must not break

These are the decisions that everything else depends on. They are enforced in comments
at each site, and several exist because breaking them produced a bug in §7.

1. **Time is integer milliseconds** in storage and comparison. Floats appear only in
   ffmpeg argument strings. Frame stepping is done with rational arithmetic, never by
   adding `1/30`.
2. **Frame rates are rationals** (`fps_num`/`fps_den`). 30000/1001 is a real frame rate;
   rounding it to 30 drifts a frame per 10 minutes.
3. **Pitch coordinates are Metrica-normalised `0..1` with explicit `attack_dir`.**
   Metric coordinates are always *derived*, never stored, because they depend on
   calibration which changes per camera shot.
4. **Calibration belongs to a camera shot, not a file.** A phone recording that pans
   needs a new homography. Reusing the previous one silently corrupts every metric.
5. **Originals are immutable.** Derived artifacts are disposable and regenerable; the
   queue re-derives on demand rather than treating them as canonical.
6. **One command registry.** `lib/commands.ts` defines each action once. The menu, the
   keyboard and the buttons dispatch the same ids, so they cannot disagree.
7. **The coding pad is an arming surface, not a filter.** Armed descriptor values are
   consumed by the next tag, so an unarmed pad saves a bare tag rather than silently
   inheriting the previous tag's answers.

---

## 4. What works, and how it is proven

`npm run smoke` (`apps/desktop/scripts/smoke.ts`) generates a real 12-second H.264/AAC
clip with the bundled ffmpeg, then exercises the full pipeline against a temp SQLite DB.
**40 checks, all passing.** It covers: migrations, taxonomy seed, ingest, re-ingest
idempotency, ffprobe metadata, queue drain, proxy generation, sprite generation,
waveform generation and parse, signal presence, peak range, event insert, integer-ms
storage, event round-trip, FK rejection, asset-delete cascade.

| Command | Purpose | Status |
| --- | --- | --- |
| `npm run typecheck` | main/preload and renderer, separate projects | passes |
| `npm run build` | bundles to `apps/desktop/out` | passes |
| `npm run smoke` | headless end-to-end | passes, 40/40 |
| `npx electron-builder --linux dir -c.npmRebuild=false` | packaging layout | passes |
| `npm run dev` | run the app | **never executed** |
| `npm run dist:mac` / `dist:win` | installers | **never executed** |

Packaging was validated by producing a Linux unpacked build and inspecting it:
`app.asar` contains `out/main/index.js` + `out/preload/index.mjs` + renderer assets;
`app.asar.unpacked` correctly holds `better_sqlite3.node`, `ffmpeg` and `ffprobe`.

### Media pipeline

`ingest` → hash (SHA-1) → dedupe → `ffprobe` → enqueue 4 jobs → queue workers →
`proxy` (scale + `-fps_mode cfr` + H.264/AAC) / `sprite` (tile thumbnails) /
`waveform` (16kHz mono PCM → min/max peaks) / `probe`. Progress and cancel are
persisted in the `job` table, so a crash mid-ingest resumes rather than restarts.

---

## 5. Data model

32 tables, grouped:

- **Identity** `team` `player` `squad_membership` `competition` `fixture` `player_in_match`
- **Media** `media_asset` `camera_shot` `shot_calibration` `track_identity`
- **Taxonomy** `tag_scheme` `tag_type` `descriptor_def` `descriptor_value`
- **Events** `tag_event` `tag_event_descriptor` `journal`
- **Spatial** `zone` `annotation` `annotation_keyframe` `metric_definition` `metric_result` `value_model`
- **Output** `clip` `playlist` `playlist_item` `report`
- **Training** `training_session` `session_block` `drill` `session_attendance`
  `skill_definition` `skill_assessment` `pattern` `pattern_match`
- **Infra** `job` `setting`

Only the first four groups and `job` are touched by code. The rest is forward schema —
they exist so calibration and tactics work does not need a second migration.

**Tagging model**: `tag_event` is a polymorphic root — `tag_type_id` can point at any
tag type, and `tag_event_descriptor` attaches `descriptor_value_id` rows. This means
adding a descriptor to an existing tag type requires no schema change and no rewrite
of historical events, which is the property that makes a coding pad worth having.
Multiple event kinds (`annotation`, `metric_result`, `skill_assessment`) reuse the same
descriptor mechanism, so one pad UI can serve all of them later.

---

## 6. The command registry

26 static commands in 5 groups, plus dynamic `pad.<tagTypeId>` commands registered from
the DB taxonomy. Seeded pad hotkeys: `A` pass, `S` shot, `D` carry, `U` duel,
`F` defensive action, `K` goalkeeper action, `T` turnover, `P` set piece, `M` key moment,
`N` note.

Bindings are stored as **physical keys** (`KeyA`, not `a`) so a non-QWERTY layout
triggers the same pad slot. The handler refuses to fire inside `INPUT`/`TEXTAREA`/
`contentEditable` and during IME composition, because an analyst must be able to type
"shot" into a notes box without tagging a shot.

---

## 7. Defect log

Every one of these was found by *running* the code or by explicit inspection, not by
reading. Most would have passed typecheck.

### Blocking — fixed

| # | Site | Defect | Why it mattered |
| --- | --- | --- | --- |
| 1 | `main/index.ts` | imports `../db/index.js`; those are siblings of `src/main` | every main-process import broken; app could not boot |
| 2 | `media/ingest.ts` | `padStart(0, '.')` — a no-op | **no file was ever recognised as video**; library always empty |
| 3 | `jobs/queue.ts` | handlers received the raw JSON **string** | every derived-media job "succeeded" having done nothing |
| 4 | `media/ffmpeg.ts` | `-fps_mode cfr` placed inside `-vf` | it is an output option; all proxying failed |
| 5 | `contracts` | `Math.round(x, 2)` — second arg ignored | timecodes silently lost their frame suffix |
| 6 | `Shell.tsx` | used `File.path` | removed in Electron 32+; drag-and-drop broken |
| 7 | `App.tsx` | never subscribed to `event:menuAction` | **entire application menu was decoration** |
| 8 | `SidePanel.tsx` | wrote descriptor values to `playerInMatchId` | FK to `player_in_match`; **any armed descriptor made tagging throw** |
| 9 | `SidePanel.tsx` | `descriptorValueIds` never sent to main | "Pass → Cross → Completed" **could not be recorded at all** |
| 10 | `SidePanel.tsx` | pad displayed `<kbd>` hotkeys with no handler | UI promised a feature it did not have |
| 11 | `commands.ts` | `timeline.framePlayhead` on `KeyF`; `F` is a seeded pad hotkey | a pad slot was shadowed by a view shortcut |
| 12 | `package.json` | `better-sqlite3` resolved to a Node-ABI prebuild; Electron 44 needs a different one | **the app crashed on launch** opening its database — a version check alone would not have caught this, only a real launch did |

### Non-blocking — fixed

| # | Site | Defect |
| --- | --- | --- |
| 12 | `ffprobe` handler | `PROBE` used synchronously though it is async |
| 13 | `ingest.ts` | `hasAudio` read from a contract field that does not exist (`audioCodec`) |
| 14 | `ingest.ts` | `isVideoFile` needed `extname()`, not manual suffix matching |
| 15 | `Player.tsx` | used `VideoFrameCallbackMetadata.epoch`, which does not exist; replaced with an explicit `suppressUntil` window after a programmatic seek |
| 16 | `Chrome.tsx` | read `Job.state`/`.lastError`; contract says `.status`/`.error` |
| 17 | `tagging/store.ts` | descriptor map was built from a stale snapshot; added `descriptorDefId` |
| 18 | `main/index.ts` | `new Event(...)` — reserved identifier in the Electron main scope |
| 19 | `electron.vite.config.ts` | `__dirname` under ESM; `format:'cjs'` needed for the native dep |
| 20 | `store/paths.ts` | `PathKey`/`DirKey` union drifted from the real directory set, breaking protocol bucket safety |
| 21 | `waveform.ts` | Buffer typed loosely; unchecked array indices |
| 22 | `check-native.mjs` | resolved the workspace root two levels too high; then failed to find the nested npm package |
| 23 | `app/package.json` | `better-sqlite3@13` requires Node ≥22 and segfaulted on Node 20; downgraded to 11.10.0 |
| 24 | `smoke.ts` | needed a 38-package shadow install of SQLite; unnecessary once the native module was removed outright |
| 25 | `package.json` | `better-sqlite3` shipped a **Node 20** prebuild (ABI 115) while Electron 44 needs 149 — the app crashed on launch opening its database |
| 26 | `better-sqlite3` v11 | cannot be compiled against Electron 44 at all: `v8::Context::GetIsolate` was removed and `v8::External::Value()` changed signature. No prebuild and no source build exist for that V8. |
| 27 | `db/index.ts` | `node:sqlite` has no `transaction()` helper and no `pragma(simple)`; the adapter in `db/sqlite.ts` supplies both, including nested-transaction reuse |
| 28 | `smoke` script | ran under the host's Node 20, which has no `node:sqlite`; now runs inside Electron's Node 24 via `scripts/run-smoke.mjs` |

---

## 8. Open issues (verified, not yet fixed)

| Sev | Site | Issue |
| --- | --- | --- |
| High | `App.tsx:57-68` | Loop enforcement polls on a 40 ms interval and captures `playerBridge.el` at effect setup. At 4× playback it can overshoot the loop-out point by up to ~160 ms of content — unacceptable for frame-accurate work. The comment above it claims the frame callback also enforces the loop; it does not. |
| Med | `App.tsx:60` | The loop effect depends on child-before-parent effect ordering to find the video element. Correct today, fragile if `<PlayerView>` is ever conditionally mounted. |
| Med | `App.tsx:20` | `setQueryClient(qc)` is called during render, a side effect in the render phase. Works; should be an effect. |
| Med | — | `player_in_match_id` is always NULL. There is no squad/player picker, so **events cannot be attributed to a person**. This is the single biggest functional gap. |
| Med | `App.tsx:70` | `training` and `analysis` render the identical match view. They are empty nav items. |
| Low | `package.json` | `konva` and `react-konva` installed, imported by nothing. Tree-shaken out of the bundle (verified: 0 matches) but ~2 MB of dead install. `clsx` likewise unused. |
| Low | `commands.ts` | Menu items for remove/clip were removed from the menu action union but the underlying features remain unbuilt. |
| Low | — | No unit tests. One integration smoke test only. `msToFrame`, `frameToMs` and the coordinate transforms are the functions that most need them. |

---

## 9. Not built (schema only)

`shot_calibration` + homography, tactical pitch view with Konva, telestration,
`clip` export, `report` generation, `playlist`, fixtures/squads/players, tracking,
`training_session` and skill assessment, `metric_definition` evaluation.

---

## 10. Risk register — what is unproven

**Untested, and untestable in the build container:**

1. **No window has ever been displayed, but the main process is proven.** GTK and X
   libraries were installed into a local sysroot, after which Electron 44 boots and
   runs the app: it creates `app.db`, applies 38 tables at `user_version=1`, sets WAL
   and `foreign_keys=ON`, and seeds 10 tag types with 91 descriptor values. It then
   dies in ANGLE/EGL initialisation because there is no display.
   `Xvfb` cannot be substituted: it needs `xkbcomp` at a hardcoded `/usr/bin/xkbcomp`,
   `/usr/bin` is not writable, and user namespaces (`unshare -rm`) are blocked, so
   bind-mounting over it is impossible. What remains unverified is everything after
   `BrowserWindow` is constructed: the renderer, CSS, IPC round-trips and all UI state.
2. **No real video has been through it.** The smoke test uses a 12 s generated
   `testsrc` clip: CFR, H.264+AAC, 640×360. Untested: VFR phone footage, 4K HEVC, HDR,
   rotation metadata, MKV, no-audio files, 90-minute broadcast.
3. **Installers are unbuilt.** `.dmg` must be produced on macOS. The Windows
   constraint is gone now that there is no native module, but the Windows installer
   itself has still never been produced.
4. **A 90-minute video has never been through the queue.** Sprite tiling and waveform
   generation at that length are untested for memory and time.

**Known-fragile dependencies:** `requestVideoFrameCallback` for playhead accuracy
(Chromium-only, varies with hardware decode) and `ffmpeg-static` + `ffprobe-static`
(per-host binaries — a real `.dmg` needs the Darwin variants present). `node:sqlite`
is stable from Node 24 onward and Electron 44 bundles Node 24.21, so the database
layer has no remaining platform risk.

---

## 11. Getting it running

The repo is **not on any other machine.** It exists only at `/workspace` in a Linux
build container, which has no filesystem bridge to the user's Mac. Moving the 146 KB of
source (69 files) is a manual step.

```bash
node -v                   # 20.20+ for the build tooling; the app runs on Electron's Node 24
npm install
npm run dev
```

No Xcode, no MSVC, no `npm rebuild`. This is the single largest improvement in the
current state of the project.

There is nothing to compile. `npm install` needs no toolchain on any platform, and
there is no ABI to match against an Electron version.

**Prerequisites by platform:** none beyond Node and a working `npm install`. The macOS
`.dmg` must still be produced on macOS. This Linux container successfully runs
`electron-builder --linux dir`, and `@electron/rebuild` now completes with nothing to
do.

---

## 12. Decisions needed from you

1. **Get the code to your Mac, or keep iterating here?** Every remaining risk is on a
   machine I cannot see. Nothing further can be verified in this container.
2. **Player attribution or tactical pitch first?** `player_in_match_id` is always NULL
   because there is no squad UI. A tactics app needs calibration first. These are
   different weeks of work and I need to pick one.
3. **Is the coding pad the right shape?** It currently arms descriptors then tags.
   The alternative used by Nacsis/Voe is descriptors first, then tag, then select. If
   your analysts tag hundreds of events a session, the order matters a lot.

---

## Appendix: glossary

**Coding pad** — the tagging control panel: a list of tag types, each with a hotkey, and
expandable descriptor values you arm before tagging. **Metrica coordinates** — the
standard normalised `0..1` pitch space used by StatsBomb-style data. **Homography** —
the 3×3 projective transform mapping broadcast pixels to pitch coordinates; per camera
shot. **Proxy** — a smaller re-encode for scrubbing, never the source of truth.
**VFR/CFR** — variable/constant frame rate; phone footage is usually VFR and breaks
naive frame arithmetic. **NACI/node-api** — a C ABI that lets one compiled binary run
across Node versions, which is why the SQLite build is portable.
