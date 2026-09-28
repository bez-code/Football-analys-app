import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { AppPaths, FrameRate, MediaProbe } from '@tactix/contracts';

// ─────────────────────────────────────────────────────────── process ──────

export interface RunResult {
  readonly code: number;
  readonly stderr: string;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

/**
 * Run ffmpeg with machine-readable progress on stdout. We use `-progress`
 * rather than scraping the human-readable stderr, because the latter format is
 * not API-stable across ffmpeg versions.
 */
export function runFfmpeg(
  paths: AppPaths,
  args: readonly string[],
  totalMs: number,
  onProgress?: (fraction: number) => void,
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(paths.ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args, '-progress', 'pipe:1', '-nostats'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let stdoutBuf = '';
    let sawOutput = false;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      sawOutput = true;
      stdoutBuf += chunk;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (key === 'out_time_ms' && totalMs > 0) {
          const micros = Number(value);
          if (Number.isFinite(micros) && micros >= 0) {
            onProgress?.(Math.min(1, micros / 1000 / totalMs));
          }
        } else if (key === 'progress' && value === 'end') {
          onProgress?.(1);
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });

    child.on('error', (err) => {
      reject(
        new FfmpegError(
          `Could not start ${basename(paths.ffmpeg)}: ${err.message}. ` +
            `Set TACTIX_FFMPEG to a working ffmpeg binary.`,
          '',
        ),
      );
    });

    child.on('close', (code) => {
      if (code === 0) {
        onProgress?.(1);
        resolvePromise({ code: 0, stderr });
      } else {
        reject(new FfmpegError(`ffmpeg exited with code ${code}`, stderr));
      }
    });

    void sawOutput;
  });
}

export function runFfmpegCapture(
  paths: AppPaths,
  args: readonly string[],
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(paths.ffmpeg, ['-hide_banner', '-nostdin', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    child.stderr.on('data', (c: string) => (err += c));
    child.on('error', (e) => reject(new FfmpegError(e.message, '')));
    child.on('close', (code) =>
      code === 0 ? resolvePromise(out) : reject(new FfmpegError(`ffmpeg exited ${code}`, err)),
    );
  });
}

// ───────────────────────────────────────────────────────────── probe ──────

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  duration?: string;
  pix_fmt?: string;
  color_transfer?: string;
  side_data_list?: { rotation?: number }[];
  tags?: Record<string, string>;
  bit_rate?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string; bit_rate?: string; size?: string };
}

function parseRational(value: string | undefined): { num: number; den: number } | null {
  if (!value) return null;
  const [num, den] = value.split('/');
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return { num: n, den: d };
}

const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b));

/**
 * Variable frame rate detection. Broadcast material is very often VFR, and
 * every downstream assumption (frame index <-> time) breaks on VFR. We
 * therefore always rebuild the proxy as CFR and remember the original state.
 */
function isCfr(rate: string | undefined, avg: string | undefined): boolean {
  const r = parseRational(rate);
  const a = parseRational(avg);
  if (!r || !a) return true;
  const rf = r.num / r.den;
  const af = a.num / a.den;
  if (!Number.isFinite(rf) || !Number.isFinite(af) || rf === 0) return true;
  return Math.abs(rf - af) / rf < 0.01;
}

export async function probe(paths: AppPaths, file: string): Promise<MediaProbe> {
  const { stdout } = await new Promise<{ stdout: string }>((resolvePromise, reject) => {
    const child = spawn(
      paths.ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    child.stderr.on('data', (c: string) => (err += c));
    child.on('error', (e) =>
      reject(new FfmpegError(`Could not start ffprobe: ${e.message}`, '')),
    );
    child.on('close', (code) =>
      code === 0
        ? resolvePromise({ stdout: out })
        : reject(new FfmpegError(`ffprobe exited ${code}: ${err}`, err)),
    );
  });

  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const video = parsed.streams?.find((s) => s.codec_type === 'video');
  const audio = parsed.streams?.find((s) => s.codec_type === 'audio');
  if (!video) throw new FfmpegError('No video stream found in this file.', '');

  const avg = parseRational(video.avg_frame_rate);
  const num = avg?.num ?? 25;
  const den = avg?.den ?? 1;
  const divisor = gcd(num, den) || 1;

  const durationSec = Number(
    video.duration ?? parsed.format?.duration ?? 0,
  );
  const rotation = video.side_data_list?.[0]?.rotation ?? 0;

  return {
    width: video.width ?? 0,
    height: video.height ?? 0,
    durationMs: Math.round(durationSec * 1000),
    fpsNum: Math.round(num / divisor),
    fpsDen: Math.round(den / divisor),
    videoCodec: video.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    pixFmt: video.pix_fmt ?? null,
    hdrTransfer: video.color_transfer ?? null,
    rotationDeg: ((Math.round(rotation / 90) * 90) % 360 + 360) % 360,
    wasCfr: isCfr(video.r_frame_rate, video.avg_frame_rate),
    bitrate: parsed.format?.bit_rate ? Number(parsed.format.bit_rate) : null,
    fileSize: parsed.format?.size ? Number(parsed.format.size) : 0,
    hasAudio: Boolean(audio),
  };
}

// ─────────────────────────────────────────────────────────── hashing ──────

/**
 * Content hash so re-importing the same footage from a different folder is
 * detected, and so derived artifacts (proxy, sprite, waveform) have stable
 * content-addressed names. SHA-1 over gigabytes is slow; we hash the first and
 * last 8 MiB plus the size, which is enough to key a personal library.
 */
export async function hashFile(file: string): Promise<string> {
  const size = statSync(file).size;
  const CHUNK = 8 * 1024 * 1024;
  const hash = createHash('sha1');
  hash.update(`size:${size}`);

  const stream = createReadStream(file, { start: 0, end: Math.min(CHUNK, size) - 1 });
  await new Promise<void>((res, rej) => {
    stream.on('data', (c) => hash.update(c));
    stream.on('end', res);
    stream.on('error', rej);
  });

  if (size > CHUNK) {
    const tail = createReadStream(file, { start: Math.max(0, size - CHUNK) });
    await new Promise<void>((res, rej) => {
      tail.on('data', (c) => hash.update(c));
      tail.on('end', res);
      tail.on('error', rej);
    });
  }
  return hash.digest('hex');
}

// ──────────────────────────────────────────────────────────── proxy ──────

export interface ProxyOptions {
  /** Longest-edge cap. 720 is the sweet spot: small enough to scrub, sharp enough to tag. */
  readonly maxHeight: number;
  readonly fps: FrameRate;
  readonly crf: number;
  /**
   * Dense keyframes. This single flag is the difference between seeking that
   * feels instant and seeking that feels broken, because a browser can only
   * seek to a keyframe.
   */
  readonly gopSeconds: number;
  readonly audio: boolean;
}

export const DEFAULT_PROXY: ProxyOptions = {
  maxHeight: 720,
  fps: { num: 25, den: 1 },
  crf: 23,
  gopSeconds: 0.5,
  audio: true,
};

export function buildProxyArgs(
  input: string,
  output: string,
  sourceFps: FrameRate,
  opts: ProxyOptions,
  seekStartMs?: number,
): string[] {
  const targetFps = opts.fps;
  // Encode at the *source* frame rate unless it is pathological, so we do not
  // invent frames on a 25 fps clip. A genuine VFR source is normalised to 25.
  const useFps = sourceFps.num / sourceFps.den < 20 ? targetFps : sourceFps;
  const gop = Math.max(1, Math.round((useFps.num / useFps.den) * opts.gopSeconds));

  const args: string[] = [];

  if (seekStartMs !== undefined && seekStartMs > 0) {
    // Seek before -i so ffmpeg does not decode-and-discard the whole head.
    args.push('-ss', (seekStartMs / 1000).toFixed(3));
  }
  args.push('-i', input);

  // `fps=` is a filter; `fps_mode` is an output option and must not appear in
  // the filtergraph (ffmpeg rejects the whole chain when it does).
  const filters = [`scale=-2:${opts.maxHeight}:flags=bicubic`, `fps=fps=${useFps.num}/${useFps.den}`];
  args.push('-vf', filters.join(','));
  args.push('-fps_mode', 'cfr');

  if (opts.audio) {
    args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000');
  } else {
    args.push('-an');
  }

  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', String(opts.crf),
    '-pix_fmt', 'yuv420p',
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-sc_threshold', '0',
    '-movflags', '+faststart',
    // Metadata bloat hurts seek performance on long files.
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    output,
  );
  return args;
}

// ────────────────────────────────────────────────────── sprite / wave ────

/** Height of each scrub-bar thumbnail, and the gap between them. */
export const SPRITE_TILE_HEIGHT = 72;
export const SPRITE_MIN_INTERVAL_SEC = 2;
export const SPRITE_MAX_INTERVAL_SEC = 10;
export const SPRITE_MAX_TILES = 4096;

/**
 * Thumbnails are emitted as a numbered JPEG sequence rather than a packed
 * atlas. A strip of small files costs a few MB of disk and lets the renderer
 * load only the tiles currently visible in the scrub bar, which an atlas
 * cannot do without a repack.
 */
export function spriteIntervalSec(durationMs: number): number {
  return Math.max(
    SPRITE_MIN_INTERVAL_SEC,
    Math.min(SPRITE_MAX_INTERVAL_SEC, durationMs / 1000 / 900),
  );
}

export function spritePattern(sha1: string): string {
  return `sprite_${sha1}_%04d.jpg`;
}

export function buildSpriteArgs(
  input: string,
  outputPattern: string,
  durationMs: number,
): string[] {
  const intervalSec = spriteIntervalSec(durationMs);
  return [
    '-i', input,
    '-vf',
    `fps=1/${intervalSec.toFixed(3)},scale=-2:${SPRITE_TILE_HEIGHT}:flags=bilinear`,
    '-frames:v', String(SPRITE_MAX_TILES),
    '-fps_mode', 'vfr',
    '-q:v', '6',
    outputPattern,
  ];
}
