import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { getDb } from '../db/index.js';
import { getQueue, type JobContext } from '../jobs/queue.js';
import {
  DEFAULT_PROXY,
  FfmpegError,
  buildProxyArgs,
  buildSpriteArgs,
  hashFile,
  probe,
  runFfmpeg,
  spritePattern,
} from './ffmpeg.js';
import { buildWaveform, writeWaveform } from './waveform.js';
import type { AppPaths, IngestSummary, MediaAsset } from '@tactix/contracts';

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm', '.mpg', '.mpeg',
  '.ts', '.m2ts', '.wmv', '.flv', '.mts', '.3gp', '.ogv',
]);

export const isVideoFile = (file: string): boolean =>
  VIDEO_EXTENSIONS.has(extname(file).toLowerCase());

// ──────────────────────────────────────────────────────────── row mapping ──

interface AssetRow {
  id: string;
  path: string;
  sha1: string | null;
  file_size: number;
  name: string;
  width: number;
  height: number;
  duration_ms: number;
  fps_num: number;
  fps_den: number;
  video_codec: string | null;
  audio_codec: string | null;
  pix_fmt: string | null;
  hdr_transfer: string | null;
  rotation_deg: number;
  was_cfr: number;
  state: 'PENDING' | 'READY' | 'FAILED';
  proxy_state: 'NONE' | 'PENDING' | 'READY' | 'FAILED';
  proxy_path: string | null;
  sprite_path: string | null;
  wave_path: string | null;
  created_at: number;
  updated_at: number;
}

const toAsset = (r: AssetRow): MediaAsset => ({
  id: r.id,
  path: r.path,
  sha1: r.sha1 ?? '',
  fileSize: r.file_size,
  name: r.name,
  width: r.width,
  height: r.height,
  durationMs: r.duration_ms,
  fpsNum: r.fps_num,
  fpsDen: r.fps_den,
  videoCodec: r.video_codec,
  audioCodec: r.audio_codec,
  pixFmt: r.pix_fmt,
  hdrTransfer: r.hdr_transfer,
  rotationDeg: r.rotation_deg,
  wasCfr: r.was_cfr === 1,
  state: r.state,
  proxyState: r.proxy_state,
  proxyPath: r.proxy_path,
  spritePath: r.sprite_path,
  wavePath: r.wave_path,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// ─────────────────────────────────────────────────────────────── queries ──

export function listAssets(search = ''): MediaAsset[] {
  const db = getDb();
  const rows = (
    search.trim().length > 0
      ? db
          .prepare(
            `SELECT * FROM media_asset WHERE name LIKE ? ORDER BY created_at DESC LIMIT 500`,
          )
          .all(`%${search.trim()}%`)
      : db.prepare(`SELECT * FROM media_asset ORDER BY created_at DESC LIMIT 500`).all()
  ) as AssetRow[];
  return rows.map(toAsset);
}

export function getAsset(id: string): MediaAsset | null {
  const row = getDb().prepare(`SELECT * FROM media_asset WHERE id = ?`).get(id) as
    | AssetRow
    | undefined;
  return row ? toAsset(row) : null;
}

export function findAssetByPath(path: string): MediaAsset | null {
  const row = getDb().prepare(`SELECT * FROM media_asset WHERE path = ?`).get(path) as
    | AssetRow
    | undefined;
  return row ? toAsset(row) : null;
}

// ─────────────────────────────────────────────────────────────── ingest ──

/**
 * Ingest is split in two on purpose:
 *
 *   ingestFiles()  - cheap, synchronous-ish: hash + probe + insert row. Returns
 *                    fast so the user sees the file in the library immediately.
 *   job handlers   - everything slow (proxy, thumbnails, waveform) runs in the
 *                    background queue with progress.
 *
 * A 90-minute 4K file takes minutes to proxy. If the UI blocks on that, the
 * app looks broken. It must never block.
 */
export async function ingestFiles(paths: AppPaths, files: readonly string[]): Promise<IngestSummary> {
  const db = getDb();
  const added: MediaAsset[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const errored: { path: string; reason: string }[] = [];

  for (const file of files) {
    if (!isVideoFile(file)) {
      skipped.push({ path: file, reason: 'Not a recognised video extension' });
      continue;
    }
    if (!existsSync(file)) {
      skipped.push({ path: file, reason: 'File not found' });
      continue;
    }

    const existing = findAssetByPath(file);
    if (existing) {
      // Re-import of the same path: revive derived artifacts if they were
      // deleted, otherwise report as already present.
      requeueDerived(existing);
      skipped.push({ path: file, reason: 'Already in library' });
      continue;
    }

    try {
      const sha1 = await hashFile(file);
      const info = await probe(paths, file);
      const now = Date.now();
      const id = randomUUID();

      db.prepare(
        `INSERT INTO media_asset (
           id, path, sha1, file_size, name, width, height, duration_ms,
           fps_num, fps_den, video_codec, audio_codec, pix_fmt, hdr_transfer,
           rotation_deg, was_cfr, state, proxy_state, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING','PENDING',?,?)`,
      ).run(
        id,
        file,
        sha1,
        statSync(file).size,
        basename(file),
        info.width,
        info.height,
        info.durationMs,
        info.fpsNum,
        info.fpsDen,
        info.videoCodec,
        info.audioCodec,
        info.pixFmt,
        info.hdrTransfer,
        info.rotationDeg,
        info.wasCfr ? 1 : 0,
        now,
        now,
      );

      const asset = getAsset(id)!;
      added.push(asset);
      enqueueDerived(asset);
    } catch (err) {
      errored.push({ path: file, reason: describeError(err) });
    }
  }

  return { added, skipped, errored };
}

function enqueueDerived(asset: MediaAsset): void {
  getQueue().enqueue('PROBE', { assetId: asset.id });
  if (asset.durationMs > 0) {
    getQueue().enqueue('WAVEFORM', { assetId: asset.id, path: asset.path, durationMs: asset.durationMs });
  }
  getQueue().enqueue('PROXY', { assetId: asset.id, path: asset.path }, { priority: 10 });
  getQueue().enqueue('SPRITE', { assetId: asset.id, path: asset.path, durationMs: asset.durationMs }, { priority: 5 });
}

/** Re-run derived work whose artifacts are missing. */
function requeueDerived(asset: MediaAsset): void {
  const db = getDb();
  const missingProxy = !asset.proxyPath || !existsSync(asset.proxyPath);
  if (missingProxy) {
    db.prepare(`UPDATE media_asset SET proxy_state = 'PENDING', updated_at = ? WHERE id = ?`)
      .run(Date.now(), asset.id);
    getQueue().enqueue('PROXY', { assetId: asset.id, path: asset.path }, { priority: 10 });
  }
  if (!asset.spritePath || !existsSync(asset.spritePath)) {
    getQueue().enqueue(
      'SPRITE',
      { assetId: asset.id, path: asset.path, durationMs: asset.durationMs },
      { priority: 5 },
    );
  }
  if (!asset.wavePath || !existsSync(asset.wavePath)) {
    getQueue().enqueue('WAVEFORM', { assetId: asset.id, path: asset.path, durationMs: asset.durationMs });
  }
}

export function removeAsset(id: string): void {
  getDb().prepare(`DELETE FROM media_asset WHERE id = ?`).run(id);
}

// ───────────────────────────────────────────────────────── job handlers ──

interface AssetParams {
  assetId: string;
  path: string;
  durationMs?: number;
}

export function registerMediaJobs(paths: AppPaths): void {
  const db = getDb();
  const queue = getQueue();

  // Re-probe and normalise the schema if we ever change how we read metadata.
  // async is required: probe() returns a promise, and a sync handler would let
  // the queue mark the job done before the row was ever written.
  queue.register('PROBE', (async (params: AssetParams, ctx: JobContext) => {
    const asset = getAsset(params.assetId);
    if (!asset) return;
    ctx.throwIfCanceled();
    const info = await probe(paths, asset.path);
    ctx.throwIfCanceled();
    db.prepare(
      `UPDATE media_asset SET width=?, height=?, duration_ms=?, fps_num=?, fps_den=?,
         video_codec=?, audio_codec=?, pix_fmt=?, hdr_transfer=?, rotation_deg=?,
         was_cfr=?, state='READY', updated_at=? WHERE id=?`,
    ).run(
      info.width, info.height, info.durationMs, info.fpsNum, info.fpsDen,
      info.videoCodec, info.audioCodec, info.pixFmt, info.hdrTransfer,
      info.rotationDeg, info.wasCfr ? 1 : 0, Date.now(), asset.id,
    );
  }) as never);

  queue.register('WAVEFORM', (async (params: AssetParams, ctx: JobContext) => {
    const asset = getAsset(params.assetId);
    if (!asset) return;
    ctx.throwIfCanceled();
    if (asset.audioCodec === null) {
      db.prepare(`UPDATE media_asset SET wave_path = NULL, updated_at = ? WHERE id = ?`)
        .run(Date.now(), asset.id);
      return;
    }
    const wave = await buildWaveform(paths, asset.path, asset.durationMs, ctx.progress);
    ctx.throwIfCanceled();
    const out = join(paths.waves, `wave_${asset.sha1}.json`);
    await writeWaveform(out, wave);
    db.prepare(`UPDATE media_asset SET wave_path = ?, updated_at = ? WHERE id = ?`)
      .run(out, Date.now(), asset.id);
  }) as never);

  queue.register('PROXY', (async (params: AssetParams, ctx: JobContext) => {
    const asset = getAsset(params.assetId);
    if (!asset) return;
    ctx.throwIfCanceled();

    const out = join(paths.proxies, `proxy_${asset.sha1}.mp4`);
    const args = buildProxyArgs(
      asset.path,
      out,
      { num: asset.fpsNum, den: asset.fpsDen },
      { ...DEFAULT_PROXY, audio: asset.audioCodec !== null },
    );

    try {
      await runFfmpeg(paths, args, asset.durationMs, (f) => ctx.progress(f * 0.95));
    } catch (err) {
      if (err instanceof FfmpegError) {
        db.prepare(
          `UPDATE media_asset SET proxy_state='FAILED', updated_at=? WHERE id=?`,
        ).run(Date.now(), asset.id);
        void err;
      }
      throw err;
    }

    ctx.throwIfCanceled();
    if (!existsSync(out)) throw new Error('Proxy transcode produced no file');

    db.prepare(`UPDATE media_asset SET proxy_state='READY', proxy_path=?, updated_at=? WHERE id=?`)
      .run(out, Date.now(), asset.id);
    ctx.progress(1);
  }) as never);

  queue.register('SPRITE', (async (params: AssetParams, ctx: JobContext) => {
    const asset = getAsset(params.assetId);
    if (!asset) return;
    ctx.throwIfCanceled();

    const out = join(paths.sprites, spritePattern(asset.sha1));
    const args = buildSpriteArgs(asset.path, out, asset.durationMs);
    // A source with no decodable video frame at time 0 should not fail the
    // whole job; thumbnails are cosmetic.
    try {
      await runFfmpeg(paths, args, asset.durationMs, (f) => ctx.progress(f));
    } catch {
      return;
    }
    const first = out.replace('%04d', '0001');
    if (!existsSync(first)) return;
    db.prepare(`UPDATE media_asset SET sprite_path=?, updated_at=? WHERE id=?`)
      .run(out, Date.now(), asset.id);
  }) as never);
}

function describeError(err: unknown): string {
  if (err instanceof FfmpegError) {
    const tail = err.stderr.split('\n').filter((l) => l.trim()).slice(-2).join(' | ');
    return `${err.message}${tail ? `: ${tail}` : ''}`;
  }
  return err instanceof Error ? err.message : String(err);
}
