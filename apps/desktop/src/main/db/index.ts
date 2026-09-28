import { Database, type Db } from './sqlite.js';
import { join } from 'node:path';
import { MIGRATIONS } from './migrations.js';
import type { AppPaths } from '@tactix/contracts';

let db: Db | null = null;

/**
 * Pragmas matter here and are not optional:
 *  - WAL: the renderer polls job progress while the main process writes. WAL
 *    keeps readers off the writer's back.
 *  - synchronous=NORMAL: with WAL this is the right durability point for a
 *    single-user tool. FULL costs an fsync per commit and buys nothing.
 *  - foreign_keys=ON: SQLite leaves this OFF by default, which means our
 *    cascade deletes silently do nothing.
 *  - busy_timeout: a job worker and an IPC write can collide.
 */
export function openDatabase(paths: AppPaths): Db {
  if (db) return db;

  const handle = new Database(join(paths.db, 'app.db'));
  handle.pragma('journal_mode = WAL');
  handle.pragma('synchronous = NORMAL');
  handle.pragma('foreign_keys = ON');
  handle.pragma('busy_timeout = 5000');
  handle.pragma('temp_store = MEMORY');
  handle.pragma('mmap_size = 268435456');

  migrate(handle);
  seed(handle);

  db = handle;
  return handle;
}

export function getDb(): Db {
  if (!db) throw new Error('Database not opened. Call openDatabase() during app bootstrap.');
  return db;
}

export function closeDatabase(): void {
  db?.close();
  db = null;
}

function migrate(handle: Db): void {
  const current = handle.pragma('user_version', { simple: true }) as number;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;

    // Each migration is atomic. A half-applied schema is worse than no schema:
    // it fails later, somewhere unrelated, with data already written.
    const run = handle.transaction(() => {
      handle.exec(migration.sql);
      handle.pragma(`user_version = ${migration.version}`);
    });
    run();
  }
}

/**
 * The default coding board. A football analyst expects certain buttons to
 * exist; shipping an empty taxonomy means the app is unusable on first launch.
 * This is the minimum viable set, fully editable by the user afterwards.
 */
function seed(handle: Db): void {
  const now = Date.now();

  const already = handle
    .prepare(`SELECT COUNT(*) AS n FROM tag_scheme WHERE is_active = 1`)
    .get() as { n: number };
  if (already.n > 0) return;

  const schemeId = 'scheme_default';
  const insertScheme = handle.prepare(
    `INSERT INTO tag_scheme (id, name, version, is_active, created_at) VALUES (?, ?, 1, 1, ?)`,
  );
  const insertType = handle.prepare(
    `INSERT INTO tag_type
       (id, scheme_id, name, color, hotkey, min_select, max_select, kind, default_duration_ms, sort, is_system)
     VALUES (@id, @scheme_id, @name, @color, @hotkey, @min_select, @max_select, @kind, @default_duration_ms, @sort, 1)`,
  );
  const insertDef = handle.prepare(
    `INSERT INTO descriptor_def (id, tag_type_id, name, hotkey, min_select, max_select, sort)
     VALUES (@id, @tag_type_id, @name, @hotkey, 0, 1, @sort)`,
  );
  const insertVal = handle.prepare(
    `INSERT INTO descriptor_value (id, descriptor_def_id, value, color, sort)
     VALUES (@id, @descriptor_def_id, @value, @color, @sort)`,
  );

  interface TypeSpec {
    name: string;
    color: string;
    hotkey: string;
    duration: number;
    descriptors: { name: string; values: string[] }[];
  }

  const SPECS: TypeSpec[] = [
    {
      name: 'Pass',
      color: '#4a90d9',
      hotkey: 'A',
      duration: 0,
      descriptors: [
        { name: 'Pass type', values: ['Ground', 'Lofted', 'Through ball', 'Cross', 'Switch', 'Corner', 'Free kick', 'Penalty', 'Back pass', 'Hand-off'] },
        { name: 'Result', values: ['Completed', 'Failed', 'Offside', 'Intercepted'] },
      ],
    },
    {
      name: 'Shot',
      color: '#e8503a',
      hotkey: 'S',
      duration: 0,
      descriptors: [
        { name: 'Shot type', values: ['Open play', 'Free kick', 'Penalty', 'Header', 'Volley', 'Half volley', 'Deflected'] },
        { name: 'Result', values: ['Goal', 'On target', 'Off target', 'Blocked', 'Post', 'Saved'] },
        { name: 'Body part', values: ['Right foot', 'Left foot', 'Head', 'Other'] },
      ],
    },
    {
      name: 'Carry / Dribble',
      color: '#3fb950',
      hotkey: 'D',
      duration: 0,
      descriptors: [
        { name: 'Result', values: ['Won foul', 'Lost ball', 'Fouled', 'Kept possession'] },
      ],
    },
    {
      name: 'Duel',
      color: '#d9a13a',
      hotkey: 'U',
      duration: 0,
      descriptors: [
        { name: 'Duel type', values: ['Aerial', 'Ground', 'Tackle', 'Standing', 'Shoulder'] },
        { name: 'Result', values: ['Won', 'Lost'] },
      ],
    },
    {
      name: 'Defensive action',
      color: '#8b5cf6',
      hotkey: 'F',
      duration: 0,
      descriptors: [
        { name: 'Action', values: ['Tackle', 'Interception', 'Clearance', 'Block', 'Pressure', 'Recovery', 'Sweep'] },
        { name: 'Result', values: ['Won', 'Lost'] },
      ],
    },
    {
      name: 'Goalkeeper action',
      color: '#06b6d4',
      hotkey: 'K',
      duration: 0,
      descriptors: [
        { name: 'Action', values: ['Save', 'Catch', 'Claim', 'Parry', 'Smother', 'Distribution', 'Error'] },
        { name: 'Outcome', values: ['Safe', 'Danger', 'Goal conceded'] },
      ],
    },
    {
      name: 'Turnover',
      color: '#ef4444',
      hotkey: 'T',
      duration: 0,
      descriptors: [
        { name: 'Cause', values: ['Lost possession', 'Ball out', 'Offside', 'Foul', 'Challenge lost', 'Misplaced pass'] },
        { name: 'Zone', values: ['Own third', 'Middle third', 'Opposition third'] },
      ],
    },
    {
      name: 'Set piece',
      color: '#ec4899',
      hotkey: 'P',
      duration: 0,
      descriptors: [
        { name: 'Set piece', values: ['Corner', 'Free kick', 'Throw-in', 'Goal kick', 'Kick-off', 'Drop ball', 'Penalty'] },
        { name: 'Delivery', values: ['Inswing', 'Outswing', 'Short', 'Whipped', 'Drilled', 'On the ground'] },
        { name: 'Shot', values: ['Shot', 'Header', 'No attempt'] },
      ],
    },
    {
      name: 'Key moment',
      color: '#f5c542',
      hotkey: 'M',
      duration: 0,
      descriptors: [
        { name: 'Importance', values: ['1', '2', '3', '4', '5'] },
      ],
    },
    {
      name: 'Note',
      color: '#94a3b8',
      hotkey: 'N',
      duration: 0,
      descriptors: [],
    },
  ];

  const seedTx = handle.transaction(() => {
    insertScheme.run(schemeId, 'Default football board', now);

    SPECS.forEach((spec, i) => {
      const typeId = `tt_${slug(spec.name)}`;
      insertType.run({
        id: typeId,
        scheme_id: schemeId,
        name: spec.name,
        color: spec.color,
        hotkey: spec.hotkey,
        min_select: 0,
        max_select: spec.descriptors.length,
        kind: 'INSTANT',
        default_duration_ms: spec.duration,
        sort: i,
      });

      spec.descriptors.forEach((desc, di) => {
        const defId = `dd_${slug(spec.name)}_${slug(desc.name)}`;
        insertDef.run({
          id: defId,
          tag_type_id: typeId,
          name: desc.name,
          hotkey: null,
          sort: di,
        });
        desc.values.forEach((value, vi) => {
          insertVal.run({
            id: `dv_${slug(spec.name)}_${slug(desc.name)}_${slug(value)}`,
            descriptor_def_id: defId,
            value,
            color: null,
            sort: vi,
          });
        });
      });
    });
  });
  seedTx();
}

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
