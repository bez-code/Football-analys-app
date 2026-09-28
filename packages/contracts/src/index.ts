/**
 * Shared vocabulary between the Electron main process and the renderer.
 *
 * Rules that must not be broken here:
 *  - Time is ALWAYS integer milliseconds from the start of the media asset.
 *    Never float seconds. 95 minutes of float arithmetic accumulates drift.
 *  - Pitch coordinates are ALWAYS normalised 0..1 on both axes using the
 *    Metrica convention ((0,0) = top-left, (0.5,0.5) = kickoff), stored with an
 *    explicit attack direction. Metric space (metres) is derived, never stored.
 *  - Anything that both processes must agree on lives here and nowhere else.
 */

// ─────────────────────────────────────────────────────────────── time ──────

/** Integer milliseconds from asset start. The one and only time format. */
export type Tms = number;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

/** Rational frame rate. Never a float - floats drift over a full match. */
export interface FrameRate {
  readonly num: number;
  readonly den: number;
}

export const FPS_25: FrameRate = { num: 25, den: 1 };
export const FPS_50: FrameRate = { num: 50, den: 1 };
export const FPS_30: FrameRate = { num: 30, den: 1 };
export const FPS_60: FrameRate = { num: 60, den: 1 };

export const frameRateOf = (fr: FrameRate): number => fr.num / fr.den;

/** Frame index -> milliseconds. Deterministic, integer-safe for 100+ hours. */
export const frameToMs = (frame: number, fr: FrameRate): Tms =>
  Math.round((frame * 1000 * fr.den) / fr.num);

/** Milliseconds -> frame index. Floors, so a time always maps inside a frame. */
export const msToFrame = (t: Tms, fr: FrameRate): number =>
  Math.floor((t * fr.num) / (1000 * fr.den));

export const totalFrames = (durationMs: Tms, fr: FrameRate): number =>
  msToFrame(durationMs, fr) + 1;

/** `1:23:45.250` - always shows ms so frame-accurate work is verifiable. */
export function formatTimecode(t: Tms, opts: { frames?: FrameRate } = {}): string {
  const sign = t < 0 ? '-' : '';
  const abs = Math.abs(Math.round(t));
  const ms = abs % 1000;
  const totalSec = (abs - ms) / 1000;
  const s = totalSec % 60;
  const totalMin = (totalSec - s) / 60;
  const m = totalMin % 60;
  const h = (totalMin - m) / 60;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const base = h > 0
    ? `${h}:${pad(m)}:${pad(s)}`
    : `${m}:${pad(s)}`;
  let out = `${sign}${base}.${pad(ms, 3)}`;
  if (opts.frames) {
    // Frames within the current second. 30000/1001 rounds to 30, which is the
    // same convention broadcasters use for frame-addressed timecode.
    const fps = Math.max(1, Math.round(opts.frames.num / opts.frames.den));
    out += `:${pad(((msToFrame(t, opts.frames) % fps) + fps) % fps, 2)}`;
  }
  return out;
}

/** Clipboard/menu friendly duration, e.g. `4:12`. */
export function formatDuration(t: Tms): string {
  const abs = Math.max(0, Math.round(t));
  const s = Math.floor(abs / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

// ─────────────────────────────────────────────────────── coordinates ──────

export type Space = 'SCREEN' | 'PITCH';
export type AttackDir = 'L' | 'R';
export type PlayerSide = 'HOME' | 'AWAY';

/** A point in normalised 0..1 space, plus the axis convention that maps it. */
export interface Point {
  readonly u: number;
  readonly v: number;
}

/** A pitch location: normalised, with the direction the tagged team attacks. */
export interface PitchPoint {
  readonly x: number;
  readonly y: number;
  readonly attackDir: AttackDir;
}

/** Standard pitch metrics in metres. Never persisted - always derived. */
export interface PitchMetrics {
  readonly length: number;
  readonly width: number;
}

export const PITCH_105_68: PitchMetrics = { length: 105, width: 68 };
export const PITCH_100_64: PitchMetrics = { length: 100, width: 64 };
export const PITCH_110_75: PitchMetrics = { length: 110, width: 75 };

/** Pitch-normalised -> metres, origin at the attacking-right left corner. */
export const pitchToMetric = (p: PitchPoint, m: PitchMetrics = PITCH_105_68) => {
  const x = p.attackDir === 'R' ? p.x : 1 - p.x;
  return { x: x * m.length, y: (1 - p.y) * m.width } as const;
};

/** Metres -> pitch-normalised, attack-right frame. */
export const metricToPitch = (
  x: number,
  y: number,
  dir: AttackDir,
  m: PitchMetrics = PITCH_105_68,
): PitchPoint => {
  const nx = x / m.length;
  return { x: dir === 'R' ? nx : 1 - nx, y: 1 - y / m.width, attackDir: dir };
};

/** Mirror a pitch point into the other attack direction. */
export const flipAttackDir = (p: PitchPoint): PitchPoint =>
  p.attackDir === 'R'
    ? { x: 1 - p.x, y: p.y, attackDir: 'L' }
    : { x: 1 - p.x, y: p.y, attackDir: 'R' };

// ──────────────────────────────────────────────────────────── media ────────

export type ProxyState = 'NONE' | 'PENDING' | 'READY' | 'FAILED';
export type MediaState = 'PENDING' | 'READY' | 'FAILED';

export interface MediaProbe {
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  readonly fpsNum: number;
  readonly fpsDen: number;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly pixFmt: string | null;
  readonly hdrTransfer: string | null;
  readonly rotationDeg: number;
  /** false when the source is variable frame rate and must be normalised. */
  readonly wasCfr: boolean;
  readonly bitrate: number | null;
  readonly fileSize: number;
  readonly hasAudio: boolean;
}

/** Row shape of `media_asset`, as returned to the renderer. */
export interface MediaAsset {
  readonly id: string;
  readonly path: string;
  readonly sha1: string;
  readonly fileSize: number;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  readonly fpsNum: number;
  readonly fpsDen: number;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly pixFmt: string | null;
  readonly hdrTransfer: string | null;
  readonly rotationDeg: number;
  readonly wasCfr: boolean;
  readonly state: MediaState;
  readonly proxyState: ProxyState;
  readonly proxyPath: string | null;
  readonly spritePath: string | null;
  readonly wavePath: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type CameraType =
  | 'MAIN'
  | 'WIDE'
  | 'BEHIND_GOAL'
  | 'GOAL_1'
  | 'GOAL_2'
  | 'SIDE'
  | 'REVERSE'
  | 'OTHER';

export interface CameraShot {
  readonly id: string;
  readonly assetId: string;
  readonly idx: number;
  readonly tInMs: number;
  readonly tOutMs: number;
  readonly cameraType: CameraType;
}

// ───────────────────────────────────────────────────────── taxonomy ───────

export type TagKind = 'INSTANT' | 'INTERVAL';

export interface TagType {
  readonly id: string;
  readonly schemeId: string;
  readonly name: string;
  readonly color: string;
  readonly hotkey: string | null;
  readonly minSelect: number;
  readonly maxSelect: number;
  readonly kind: TagKind;
  readonly defaultDurationMs: number;
  readonly parentId: string | null;
  readonly sort: number;
  readonly isSystem: boolean;
}

export interface DescriptorValue {
  readonly id: string;
  readonly descriptorDefId: string;
  readonly value: string;
  readonly color: string | null;
  readonly sort: number;
}

export interface DescriptorDef {
  readonly id: string;
  readonly tagTypeId: string;
  readonly name: string;
  readonly hotkey: string | null;
  readonly minSelect: number;
  readonly maxSelect: number;
  readonly sort: number;
  readonly values: readonly DescriptorValue[];
}

/** A tag type together with its descriptor vocabulary, as the pad needs it. */
export interface TagTypeWithDescriptors extends TagType {
  readonly descriptors: readonly DescriptorDef[];
}

export interface NewTagEvent {
  readonly assetId: string;
  readonly tInMs: number;
  readonly tOutMs?: number | null;
  readonly tagTypeId: string;
  readonly descriptorValueIds?: readonly string[];
  readonly playerInMatchId?: string | null;
  readonly side?: PlayerSide | null;
  readonly pitch?: PitchPoint | null;
  readonly notes?: string | null;
  readonly rating?: number | null;
  readonly source?: EventSource;
  readonly confidence?: number | null;
}

export type TagEventPatch = Partial<{
  tInMs: number;
  tOutMs: number | null;
  tagTypeId: string;
  playerInMatchId: string | null;
  side: PlayerSide | null;
  pitch: PitchPoint | null;
  notes: string | null;
  rating: number | null;
  reviewed: boolean;
}>;

export type EventSource = 'MANUAL' | 'AI_PROPOSED' | 'IMPORT';

/** Row shape of `tag_event`, as returned to the renderer. */
export interface TagEvent {
  readonly id: string;
  readonly assetId: string;
  readonly fixtureId: string | null;
  readonly sessionId: string | null;
  readonly tInMs: number;
  readonly tOutMs: number | null;
  readonly tagTypeId: string;
  readonly playerInMatchId: string | null;
  readonly side: PlayerSide | null;
  readonly pitchX: number | null;
  readonly pitchY: number | null;
  readonly attackDir: AttackDir | null;
  readonly value: number | null;
  readonly notes: string | null;
  readonly rating: number | null;
  readonly confidence: number | null;
  readonly source: EventSource;
  readonly reviewed: boolean;
  readonly parentEventId: string | null;
  readonly seqIndex: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ────────────────────────────────────────────────────────────── jobs ───────

export type JobKind =
  | 'PROBE'
  | 'PROXY'
  | 'SPRITE'
  | 'WAVEFORM'
  | 'CLIP_RENDER'
  | 'PRESENTATION_RENDER'
  | 'REPORT_PDF'
  | 'CV_TRACKING'
  | 'CV_PROPOSE_TAGS';

export type JobState = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELED';

export interface Job {
  readonly id: string;
  readonly kind: JobKind;
  readonly params: unknown;
  readonly state: JobState;
  readonly progress: number;
  readonly priority: number;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
}

export type ProgressEvent =
  | { readonly type: 'progress'; readonly job: Job }
  | { readonly type: 'done'; readonly job: Job }
  | { readonly type: 'failed'; readonly job: Job; readonly error: string };

// ─────────────────────────────────────────────────────── annotations ──────

export type AnnotationKind =
  | 'LINE'
  | 'ARROW'
  | 'ZONE'
  | 'PATH'
  | 'TEXT'
  | 'SPOT'
  | 'RING'
  | 'SPOTLIGHT'
  | 'MAGNIFIER'
  | 'BUBBLE'
  | 'CONE'
  | 'TRAIL';

export interface AnnotationStyle {
  readonly color: string;
  readonly width: number;
  readonly headStyle: 'ARROW' | 'TRIANGLE' | 'CIRCLE' | 'NONE';
  readonly gradient: boolean;
  readonly opacity: number;
  readonly font: string;
  readonly fill: string | null;
}

export const DEFAULT_STYLE: AnnotationStyle = {
  color: '#f5c542',
  width: 4,
  headStyle: 'ARROW',
  gradient: false,
  opacity: 1,
  font: '600 28px Inter, system-ui, sans-serif',
  fill: null,
};

export interface Annotation {
  readonly id: string;
  readonly assetId: string;
  readonly tInMs: number;
  readonly tOutMs: number | null;
  readonly kind: AnnotationKind;
  readonly space: Space;
  readonly points: readonly Point[];
  readonly style: AnnotationStyle;
  readonly trackBindId: number | null;
  readonly layer: number;
  readonly zIndex: number;
  readonly isLocked: boolean;
  readonly text: string | null;
}

// ────────────────────────────────────────────────────────────── ipc ───────

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface IngestRequest {
  readonly paths: readonly string[];
}

export interface IngestSummary {
  readonly added: readonly MediaAsset[];
  readonly skipped: readonly { path: string; reason: string }[];
  readonly errored: readonly { path: string; reason: string }[];
}

export interface AppPaths {
  readonly userData: string;
  readonly db: string;
  readonly proxies: string;
  readonly sprites: string;
  readonly waves: string;
  readonly clips: string;
  readonly exports: string;
  readonly models: string;
  readonly ffmpeg: string;
  readonly ffprobe: string;
}
