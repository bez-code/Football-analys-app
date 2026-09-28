import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { getDb } from '../db/index.js';
import type { Job, JobKind, JobState, ProgressEvent } from '@tactix/contracts';

export interface JobHandler {
  (params: never, ctx: JobContext): Promise<void>;
}

export interface JobContext {
  readonly jobId: string;
  /** Report 0..1. Safe to call as often as you like; writes are debounced. */
  progress(fraction: number): void;
  /** Cooperative cancellation, checked at natural await points. */
  throwIfCanceled(): void;
  signal: AbortSignal;
}

interface JobRow {
  id: string;
  kind: string;
  params: string;
  state: JobState;
  progress: number;
  priority: number;
  attempts: number;
  last_error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

const MAX_ATTEMPTS = 2;
const POLL_INTERVAL_MS = 250;
const PROGRESS_WRITE_MIN_MS = 120;

const toJob = (row: JobRow): Job =>
  ({
    id: row.id,
    kind: row.kind as JobKind,
    params: JSON.parse(row.params) as unknown,
    state: row.state,
    progress: row.progress,
    priority: row.priority,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }) as Job;

/**
 * SQLite-backed job queue with a worker pool.
 *
 * Why not BullMQ or Celery: both need Redis. This is a single-user desktop app
 * that owns its own SQLite file, so the queue is a table and the workers are
 * threads in this process. The design that scales to 10,000 jobs a minute is
 * also the design that needs you to run a Docker container, which is exactly
 * the wrong trade for a personal tool.
 *
 * `dedupe_key` is what makes re-importing a video cheap: the key is a hash of
 * (kind, normalised params), so the same proxy request twice inserts nothing.
 */
class JobQueue extends EventEmitter {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly inflight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private concurrency = 2;
  private stopped = false;

  register(kind: JobKind, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.min(8, n));
  }

  start(): void {
    this.stopped = false;
    this.recoverOrphans();
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const c of this.controllers.values()) c.abort();
    this.controllers.clear();
  }

  /**
   * Enqueue unless an identical job is already known. Returns the existing row
   * when deduplicated so the caller can report the real state to the user.
   */
  enqueue<T>(kind: JobKind, params: T, options: { priority?: number; dedupeKey?: string } = {}): Job {
    const db = getDb();
    const id = randomUUID();
    const now = Date.now();
    const dedupeKey = options.dedupeKey ?? defaultDedupeKey(kind, params);

    const existing = db
      .prepare(`SELECT * FROM job WHERE dedupe_key = ?`)
      .get(dedupeKey) as JobRow | undefined;
    if (existing) return toJob(existing);

    db.prepare(
      `INSERT INTO job (id, kind, params, state, progress, priority, dedupe_key, attempts, created_at)
       VALUES (?, ?, ?, 'PENDING', 0, ?, ?, 0, ?)`,
    ).run(id, kind, JSON.stringify(params), options.priority ?? 0, dedupeKey, now);

    const row = db.prepare(`SELECT * FROM job WHERE id = ?`).get(id) as JobRow;
    return toJob(row);
  }

  cancel(jobId: string): void {
    const db = getDb();
    this.controllers.get(jobId)?.abort();
    db.prepare(
      `UPDATE job SET state = 'CANCELED', finished_at = ? WHERE id = ? AND state IN ('PENDING','RUNNING')`,
    ).run(Date.now(), jobId);
  }

  get(jobId: string): Job | null {
    const row = getDb().prepare(`SELECT * FROM job WHERE id = ?`).get(jobId) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  list(limit = 200): Job[] {
    const rows = getDb()
      .prepare(`SELECT * FROM job ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as JobRow[];
    return rows.map(toJob);
  }

  /** Requeue everything that died mid-flight when the app was closed. */
  private recoverOrphans(): void {
    getDb()
      .prepare(
        `UPDATE job SET state = 'PENDING', started_at = NULL
         WHERE state = 'RUNNING'`,
      )
      .run();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const free = this.concurrency - this.inflight.size;
    if (free <= 0) return;

    const db = getDb();
    const rows = db
      .prepare(
        `SELECT * FROM job
         WHERE state = 'PENDING'
         ORDER BY priority DESC, created_at ASC
         LIMIT ?`,
      )
      .all(free) as JobRow[];

    for (const row of rows) {
      // Atomically claim. Two ticks cannot grab the same row because the UPDATE
      // is conditional on the row still being PENDING.
      const claimed = db
        .prepare(
          `UPDATE job SET state = 'RUNNING', started_at = ?, attempts = attempts + 1
           WHERE id = ? AND state = 'PENDING'`,
        )
        .run(Date.now(), row.id);
      if (claimed.changes === 0) continue;
      void this.execute({ ...row, state: 'RUNNING', started_at: Date.now() });
    }
  }

  private async execute(row: JobRow): Promise<void> {
    const db = getDb();
    const job = toJob(row);
    this.inflight.add(job.id);

    const controller = new AbortController();
    this.controllers.set(job.id, controller);

    let lastWrite = 0;
    const ctx: JobContext = {
      jobId: job.id,
      signal: controller.signal,
      progress: (fraction: number) => {
        const now = Date.now();
        // Throttle: progress is called per ffmpeg chunk, and a write per chunk
        // would contend with the worker for the same write lock.
        if (now - lastWrite < PROGRESS_WRITE_MIN_MS && fraction < 1) return;
        lastWrite = now;
        const clamped = Math.max(0, Math.min(1, fraction));
        db.prepare(`UPDATE job SET progress = ? WHERE id = ?`).run(clamped, job.id);
        this.emitProgress({ type: 'progress', job: { ...job, progress: clamped } });
      },
      throwIfCanceled: () => {
        if (controller.signal.aborted) {
          throw new Error('Canceled');
        }
      },
    };

    try {
      const handler = this.handlers.get(job.kind);
      if (!handler) throw new Error(`No handler registered for job kind "${job.kind}"`);

      // row.params is the raw JSON column. Handlers are written against the
      // decoded object; handing them the string made every `params.assetId`
      // lookup silently miss, and the job 'succeeded' having done nothing.
      await (handler as JobHandler)(parseParams(row.params) as never, ctx);

      db.prepare(
        `UPDATE job SET state = 'DONE', progress = 1, finished_at = ? WHERE id = ?`,
      ).run(Date.now(), job.id);
      this.emitProgress({ type: 'done', job: { ...job, state: 'DONE', progress: 1 } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const canceled = controller.signal.aborted || message === 'Canceled';
      const attempts = row.attempts + 1;

      if (canceled) {
        db.prepare(
          `UPDATE job SET state = 'CANCELED', finished_at = ?, last_error = ? WHERE id = ?`,
        ).run(Date.now(), message, job.id);
      } else if (attempts < MAX_ATTEMPTS) {
        db.prepare(`UPDATE job SET state = 'PENDING', last_error = ? WHERE id = ?`).run(
          message,
          job.id,
        );
      } else {
        db.prepare(
          `UPDATE job SET state = 'FAILED', finished_at = ?, last_error = ? WHERE id = ?`,
        ).run(Date.now(), message, job.id);
        this.emitProgress({ type: 'failed', job: { ...job, state: 'FAILED' }, error: message });
      }
    } finally {
      this.controllers.delete(job.id);
      this.inflight.delete(job.id);
    }
  }

  private emitProgress(event: ProgressEvent): void {
    this.emit('progress', event);
  }
}

function parseParams(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // A row written by an older build with a malformed payload must not wedge
    // the worker; the handler will reject it with a useful error.
    return null;
  }
}

function defaultDedupeKey(kind: string, params: unknown): string {
  // Stable stringify: key order must not affect the dedupe result.
  return `${kind}:${stableStringify(params)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

let queue: JobQueue | null = null;
export const getQueue = (): JobQueue => {
  if (!queue) queue = new JobQueue();
  return queue;
};
