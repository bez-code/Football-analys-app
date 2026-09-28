/**
 * Headless end-to-end check of everything that does not need a window:
 * migrations, seeding, ffmpeg probing, proxy/sprite/waveform generation, the
 * job queue, and tag-event round-tripping.
 *
 * This exists because the GUI cannot be exercised on a headless CI box, and
 * because the failure modes it targets (a typo in a migration, a wrong ffmpeg
 * argument) are exactly the ones that only surface on a user's machine.
 *
 *   npm run smoke
 *
 * It generates its own 12-second test clip, so it needs no fixtures and cannot
 * touch real media.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { closeDatabase, getDb, openDatabase } from '../src/main/db/index.js';
import { getQueue } from '../src/main/jobs/queue.js';
import { getAsset, ingestFiles, isVideoFile, registerMediaJobs, removeAsset } from '../src/main/media/ingest.js';
import { readWaveform } from '../src/main/media/waveform.js';
import { insertEvent, listEvents, listTagTypes } from '../src/main/tagging/store.js';
import type { AppPaths } from '@tactix/contracts';

const run = promisify(execFile);

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

async function waitForQueue(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const busy = getQueue()
      .list()
      .some((j) => j.state === 'PENDING' || j.state === 'RUNNING');
    if (!busy) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'tactix-smoke-'));
  const paths: AppPaths = {
    userData: root,
    db: join(root, 'db'),
    proxies: join(root, 'media', 'proxies'),
    sprites: join(root, 'media', 'sprites'),
    waves: join(root, 'media', 'waves'),
    clips: join(root, 'clips'),
    exports: join(root, 'exports'),
    models: join(root, 'models'),
    ffmpeg: ffmpegPath!,
    ffprobe: ffprobeStatic.path,
  };
  for (const key of ['db', 'proxies', 'sprites', 'waves', 'clips', 'exports', 'models'] as const) {
    mkdirSync(paths[key], { recursive: true });
  }

  const clip = join(root, 'sample.mp4');
  console.log('\ntactix smoke test\n');

  // ── fixture ────────────────────────────────────────────────────────────
  console.log('fixture');
  await run(ffmpegPath!, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', clip,
  ]);
  check('generated a 12s test clip', existsSync(clip));

  // ── schema ─────────────────────────────────────────────────────────────
  console.log('\nschema');
  // Regression guard: the extension test used to build the suffix by hand and
  // silently matched nothing, so no file could ever be ingested.
  check('recognises .mp4', isVideoFile('/x/match.mp4'));
  check('recognises .MOV case-insensitively', isVideoFile('/x/MATCH.MOV'));
  check('rejects a sidecar', !isVideoFile('/x/notes.txt'));
  check('rejects an extensionless file', !isVideoFile('/x/rawfootage'));
  openDatabase(paths);
  const tables = (
    getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as { name: string }[]
  ).map((r) => r.name);
  check('migrations created the tables', tables.length >= 15, `${tables.length} tables`);
  for (const required of ['media_asset', 'tag_type', 'tag_event', 'job', 'journal', 'fixture']) {
    check(`  ${required} exists`, tables.includes(required));
  }
  check(
    'foreign keys are enforced',
    (getDb().pragma('foreign_keys', { simple: true }) as number) === 1,
  );

  const types = listTagTypes();
  check('default taxonomy seeded', types.length >= 10, `${types.length} tag types`);
  check('descriptors are attached', types.some((t) => t.descriptors.length > 0));

  // ── ingest ─────────────────────────────────────────────────────────────
  console.log('\ningest');
  const summary = await ingestFiles(paths, [clip]);
  check('asset added', summary.added.length === 1, JSON.stringify(summary.errored));
  check('nothing errored', summary.errored.length === 0, JSON.stringify(summary.errored));

  const assetId = summary.added[0]?.id;
  if (!assetId) {
    console.log('\nno asset to test further');
    return;
  }
  const asset = getAsset(assetId)!;
  check('duration probed', asset.durationMs > 10_000, `${asset.durationMs}ms`);
  check('resolution probed', asset.width === 640 && asset.height === 360, `${asset.width}x${asset.height}`);
  check('frame rate probed', asset.fpsNum === 25 && asset.fpsDen === 1, `${asset.fpsNum}/${asset.fpsDen}`);
  check('codec probed', asset.videoCodec === 'h264', String(asset.videoCodec));
  check('audio detected', asset.audioCodec === 'aac', String(asset.audioCodec));
  check('content hash recorded', asset.sha1.length === 40, asset.sha1);

  // Re-ingesting the same path must be idempotent.
  const again = await ingestFiles(paths, [clip]);
  check('re-ingest is a no-op', again.added.length === 0 && again.skipped.length === 1);

  // ── derived artifacts ──────────────────────────────────────────────────
  console.log('\nderived artifacts');
  registerMediaJobs(paths);
  getQueue().setConcurrency(2);
  getQueue().start();
  const drained = await waitForQueue(120_000);
  check('queue drained', drained);
  for (const j of getQueue().list()) {
    if (j.state === 'FAILED') console.log(`        job ${j.kind} failed: ${j.lastError}`);
  }

  const done = getAsset(assetId)!;
  check('proxy generated', Boolean(done.proxyPath) && existsSync(done.proxyPath!), String(done.proxyPath));
  check('proxy marked ready', done.proxyState === 'READY', done.proxyState);
  check('sprites generated', Boolean(done.spritePath), String(done.spritePath));
  check('waveform generated', Boolean(done.wavePath) && existsSync(done.wavePath!), String(done.wavePath));

  if (done.wavePath && existsSync(done.wavePath)) {
    const wave = readWaveform(JSON.parse(readFileSync(done.wavePath, 'utf8')) as unknown);
    check('waveform parses', wave !== null && wave.peakCount > 0);
    if (wave) {
      let nonZero = 0;
      for (const v of wave.peaks) if (v !== 0) nonZero++;
      check('waveform carries signal', nonZero > 100, `${nonZero} non-zero samples`);
      check('waveform peaks within -1..1', wave.peaks.every((v) => v >= -1.001 && v <= 1.001));
    }
  }

  // ── tagging ────────────────────────────────────────────────────────────
  console.log('\ntagging');
  const created = insertEvent({
    assetId,
    tInMs: 4_200,
    tagTypeId: types[0]!.id,
    side: 'HOME',
    notes: 'smoke',
  });
  check('event inserted', Boolean(created.id));
  check('time stored as integer ms', created.tInMs === 4_200);
  const events = listEvents(assetId);
  check('event round-trips', events.length === 1 && events[0]?.notes === 'smoke');

  // A foreign key that does not exist must fail, not silently insert.
  let fkHeld = false;
  try {
    insertEvent({ assetId: 'no-such-asset', tInMs: 0, tagTypeId: types[0]!.id });
  } catch {
    fkHeld = true;
  }
  check('foreign keys block a bad asset id', fkHeld);

  removeAsset(assetId);
  check('removing the asset cascades', listEvents(assetId).length === 0);

  // ── teardown ───────────────────────────────────────────────────────────
  getQueue().stop();
  closeDatabase();
  rmSync(root, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL - ${failures} check(s) failed`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('\nsmoke test crashed:', err);
  process.exit(1);
});
