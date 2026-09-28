import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import type { AppPaths } from '@tactix/contracts';

/**
 * ffmpeg / ffprobe resolution order:
 *   1. TACTIX_FFMPEG / TACTIX_FFPROBE  - escape hatch, e.g. a Homebrew build
 *   2. the bundled ffmpeg-static binaries
 *   3. whatever is on PATH
 *
 * A personal tool should not be hostage to a package download. If the bundled
 * binary is missing we degrade to PATH rather than refusing to start, and the
 * media layer surfaces a clear error only when a job actually needs it.
 */
function resolveBinary(envVar: string, bundled: string | null, name: string): string {
  const override = process.env[envVar];
  if (override && override.trim().length > 0) return override.trim();
  if (bundled && bundled.length > 0) return bundled;
  return name;
}

const DIR_KEYS = ['db', 'proxies', 'sprites', 'waves', 'clips', 'exports', 'models'] as const;
export type DirKey = (typeof DIR_KEYS)[number];
export const dirKeys: readonly DirKey[] = DIR_KEYS;

export function appPaths(): AppPaths {
  const root = app.getPath('userData');
  return {
    userData: root,
    db: join(root, 'db'),
    proxies: join(root, 'media', 'proxies'),
    sprites: join(root, 'media', 'sprites'),
    waves: join(root, 'media', 'waves'),
    clips: join(root, 'clips'),
    exports: join(root, 'exports'),
    models: join(root, 'models'),
    ffmpeg: resolveBinary('TACTIX_FFMPEG', (ffmpegStatic as unknown as string | null) ?? null, 'ffmpeg'),
    ffprobe: resolveBinary(
      'TACTIX_FFPROBE',
      (ffprobeStatic as unknown as { path?: string } | null)?.path ?? null,
      'ffprobe',
    ),
  };
}

/** Create every directory the app writes to. Idempotent, called on boot. */
export function ensurePaths(paths: AppPaths): void {
  for (const key of DIR_KEYS) {
    mkdirSync(paths[key], { recursive: true });
  }
}

export const dirFor = (paths: AppPaths, key: DirKey): string => paths[key];
