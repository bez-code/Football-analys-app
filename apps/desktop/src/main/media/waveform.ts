import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import type { AppPaths } from '@tactix/contracts';

export interface Waveform {
  /** min/max pairs, length = peaks * 2, values in -1..1. */
  readonly peaks: Float32Array;
  readonly peakCount: number;
  readonly bucketMs: number;
  readonly version: 1;
}

/** Full-match overview resolution. Enough to eyeball commentary, whistle and crowd. */
export const WAVEFORM_PEAKS = 3000;
const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 2; // s16le

/**
 * Decode the audio to raw mono PCM and reduce it to min/max buckets in a single
 * streaming pass.
 *
 * We do not use ffmpeg's `showwavespic` because it rasterises to an image, and
 * we cannot zoom, resample on resize, or tint by channel from a PNG. Peaks are
 * data: the renderer draws them at whatever resolution the window happens to
 * be, which is what makes the scrub bar look right on a Retina display and on
 * a 4K monitor from the same source file.
 */
export function buildWaveform(
  paths: AppPaths,
  input: string,
  durationMs: number,
  onProgress?: (fraction: number) => void,
): Promise<Waveform> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      paths.ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-i', input,
        '-vn',
        '-ac', '1',
        '-ar', String(SAMPLE_RATE),
        '-f', 's16le',
        '-',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      stderr += c;
      if (stderr.length > 16_000) stderr = stderr.slice(-8_000);
    });

    // Bucket width is derived from the probed duration, not from the number of
    // samples we happen to decode. Otherwise a truncated or partial decode
    // would silently squash the whole waveform into the first few buckets.
    const seconds = Math.max(0.001, durationMs / 1000);
    const bucketMs = seconds / WAVEFORM_PEAKS;
    const samplesPerBucket = Math.max(1, (SAMPLE_RATE * bucketMs));

    const peaks = new Float32Array(WAVEFORM_PEAKS * 2);
    const counts = new Uint32Array(WAVEFORM_PEAKS);
    let samplesSeen = 0;
    // Explicitly Buffer<ArrayBufferLike>: a subarray of a pooled stdout chunk
    // can point at a SharedArrayBuffer, which Buffer.alloc's inferred
    // Buffer<ArrayBuffer> would reject.
    let carry: Buffer = Buffer.alloc(0);

    child.stdout.on('data', (chunk: Buffer) => {
      // stdout hands over pooled buffers, which are views onto a shared
      // ArrayBuffer. Annotate the union explicitly rather than letting
      // inference pick Buffer<ArrayBuffer> from the concat() branch.
      let buf: Buffer = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % BYTES_PER_SAMPLE);
      carry = buf.subarray(usable);
      buf = buf.subarray(0, usable);

      for (let i = 0; i < buf.length; i += BYTES_PER_SAMPLE) {
        const sample = buf.readInt16LE(i) / 32768;
        const bucket = Math.min(
          WAVEFORM_PEAKS - 1,
          Math.floor(samplesSeen / samplesPerBucket),
        );
        const idx = bucket * 2;
        if (counts[bucket] === 0) {
          peaks[idx] = sample;
          peaks[idx + 1] = sample;
        } else {
          // noUncheckedIndexedAccess: typed arrays are read as T | undefined.
          // The min/max pair for a bucket is written together, so the only
          // way `lo` is unset is if the array is shorter than peakCount*2,
          // which the allocation above rules out.
          const lo = peaks[idx] as number;
          const hi = peaks[idx + 1] as number;
          if (sample < lo) peaks[idx] = sample;
          if (sample > hi) peaks[idx + 1] = sample;
        }
        counts[bucket] = (counts[bucket] ?? 0) + 1;
        samplesSeen++;
      }
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Waveform extraction failed (ffmpeg ${code}): ${stderr.slice(-500)}`));
        return;
      }
      onProgress?.(1);
      resolvePromise({
        peaks,
        peakCount: WAVEFORM_PEAKS,
        bucketMs: Math.round(bucketMs * 1000) / 1000,
        version: 1 as const,
      });
    });
  });
}

/**
 * Persist as base64 Float32. JSON keeps the file human-inspectable and
 * greppable, which matters more than a few MB for a personal tool.
 */
export async function writeWaveform(file: string, wave: Waveform): Promise<void> {
  const payload = {
    version: wave.version,
    peakCount: wave.peakCount,
    bucketMs: wave.bucketMs,
    // Round to 3 decimals: -1..1 at 16-bit source resolution, and this cuts
    // the file by ~60% with no visible difference at scrub-bar scale.
    peaks: Array.from(wave.peaks, (v) => Math.round(v * 1000) / 1000),
  };
  await writeFile(file, JSON.stringify(payload), 'utf8');
}

export function readWaveform(payload: unknown): Waveform | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as { version?: number; peakCount?: number; bucketMs?: number; peaks?: number[] };
  if (p.version !== 1 || !Array.isArray(p.peaks) || typeof p.peakCount !== 'number') return null;
  return {
    peaks: Float32Array.from(p.peaks),
    peakCount: p.peakCount,
    bucketMs: p.bucketMs ?? 0,
    version: 1,
  };
}
