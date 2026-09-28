import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';
import type {
  Annotation,
  NewTagEvent,
  PlayerSide,
  TagEvent,
  TagEventPatch,
  TagTypeWithDescriptors,
} from '@tactix/contracts';

// ──────────────────────────────────────────────────────────────────────
// Row <-> contract mapping. Kept explicit rather than auto-generated: the
// renderer must never be handed a raw DB row, because the moment a column is
// renamed the UI breaks in a way TypeScript cannot see.
// ──────────────────────────────────────────────────────────────────────

interface TagTypeRow {
  id: string;
  scheme_id: string;
  name: string;
  color: string;
  hotkey: string | null;
  min_select: number;
  max_select: number;
  kind: 'INSTANT' | 'INTERVAL';
  default_duration_ms: number;
  parent_id: string | null;
  sort: number;
  is_system: number;
}

export function listTagTypes(): TagTypeWithDescriptors[] {
  const db = getDb();
  const types = db
    .prepare(`SELECT * FROM tag_type ORDER BY sort, name`)
    .all() as TagTypeRow[];

  const defs = db
    .prepare(`SELECT * FROM descriptor_def ORDER BY sort, name`)
    .all() as {
    id: string;
    tag_type_id: string;
    name: string;
    hotkey: string | null;
    min_select: number;
    max_select: number;
    sort: number;
  }[];

  const values = db
    .prepare(`SELECT * FROM descriptor_value ORDER BY sort, value`)
    .all() as {
    id: string;
    descriptor_def_id: string;
    value: string;
    color: string | null;
    sort: number;
  }[];

  // The contract types `values` as readonly, which is right for consumers but
  // wrong for the accumulator we build it with.
  type DescriptorValue = TagTypeWithDescriptors['descriptors'][number]['values'][number];
  const valuesByDef = new Map<string, DescriptorValue[]>();
  for (const v of values) {
    const list: DescriptorValue[] = valuesByDef.get(v.descriptor_def_id) ?? [];
    list.push({ id: v.id, descriptorDefId: v.descriptor_def_id, value: v.value, color: v.color, sort: v.sort });
    valuesByDef.set(v.descriptor_def_id, list);
  }

  const defsByType = new Map<string, TagTypeWithDescriptors['descriptors'][number][]>();
  for (const d of defs) {
    const list = defsByType.get(d.tag_type_id) ?? [];
    list.push({
      id: d.id,
      tagTypeId: d.tag_type_id,
      name: d.name,
      hotkey: d.hotkey,
      minSelect: d.min_select,
      maxSelect: d.max_select,
      sort: d.sort,
      values: valuesByDef.get(d.id) ?? [],
    });
    defsByType.set(d.tag_type_id, list);
  }

  return types.map((t) => ({
    id: t.id,
    schemeId: t.scheme_id,
    name: t.name,
    color: t.color,
    hotkey: t.hotkey,
    minSelect: t.min_select,
    maxSelect: t.max_select,
    kind: t.kind,
    defaultDurationMs: t.default_duration_ms,
    parentId: t.parent_id,
    sort: t.sort,
    isSystem: t.is_system === 1,
    descriptors: defsByType.get(t.id) ?? [],
  }));
}

interface EventRow {
  id: string;
  asset_id: string;
  fixture_id: string | null;
  session_id: string | null;
  t_in_ms: number;
  t_out_ms: number | null;
  tag_type_id: string;
  player_in_match_id: string | null;
  team_side: PlayerSide | null;
  pitch_x: number | null;
  pitch_y: number | null;
  attack_dir: 'L' | 'R' | null;
  value: number | null;
  notes: string | null;
  rating: number | null;
  confidence: number | null;
  source: TagEvent['source'];
  reviewed: number;
  parent_event_id: string | null;
  seq_index: number | null;
  created_at: number;
  updated_at: number;
}

const toEvent = (r: EventRow): TagEvent => ({
  id: r.id,
  assetId: r.asset_id,
  fixtureId: r.fixture_id,
  sessionId: r.session_id,
  tInMs: r.t_in_ms,
  tOutMs: r.t_out_ms,
  tagTypeId: r.tag_type_id,
  playerInMatchId: r.player_in_match_id,
  side: r.team_side,
  pitchX: r.pitch_x,
  pitchY: r.pitch_y,
  attackDir: r.attack_dir,
  value: r.value,
  notes: r.notes,
  rating: r.rating,
  confidence: r.confidence,
  source: r.source,
  reviewed: r.reviewed === 1,
  parentEventId: r.parent_event_id,
  seqIndex: r.seq_index,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function listEvents(assetId: string): TagEvent[] {
  const rows = getDb()
    .prepare(`SELECT * FROM tag_event WHERE asset_id = ? ORDER BY t_in_ms ASC`)
    .all(assetId) as EventRow[];
  return rows.map(toEvent);
}

export function listEventsInRange(assetId: string, fromMs: number, toMs: number): TagEvent[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM tag_event
       WHERE asset_id = ? AND t_in_ms >= ? AND t_in_ms <= ?
       ORDER BY t_in_ms ASC`,
    )
    .all(assetId, fromMs, toMs) as EventRow[];
  return rows.map(toEvent);
}

/**
 * Insert an event and its descriptors atomically, and write the journal entry
 * in the same transaction. Undo/redo and crash recovery both depend on the
 * journal never drifting from the data.
 */
export function insertEvent(input: NewTagEvent): TagEvent {
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();
  const descriptors = input.descriptorValueIds ?? [];

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO tag_event (
         id, asset_id, t_in_ms, t_out_ms, tag_type_id, player_in_match_id, team_side,
         pitch_x, pitch_y, attack_dir, notes, rating, confidence, source, reviewed,
         created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    ).run(
      id,
      input.assetId,
      Math.round(input.tInMs),
      input.tOutMs == null ? null : Math.round(input.tOutMs),
      input.tagTypeId,
      input.playerInMatchId ?? null,
      input.side ?? null,
      input.pitch?.x ?? null,
      input.pitch?.y ?? null,
      input.pitch?.attackDir ?? null,
      input.notes ?? null,
      input.rating ?? null,
      input.confidence ?? null,
      input.source ?? 'MANUAL',
      now,
      now,
    );

    const insertDesc = db.prepare(
      `INSERT OR IGNORE INTO tag_event_descriptor (tag_event_id, descriptor_value_id) VALUES (?,?)`,
    );
    for (const valueId of descriptors) insertDesc.run(id, valueId);

    db.prepare(`INSERT INTO journal (command, payload, inverse, ts) VALUES (?,?,?,?)`).run(
      'tag_event.insert',
      JSON.stringify({ id }),
      JSON.stringify({ command: 'tag_event.delete', payload: { id } }),
      now,
    );
  });
  tx();

  return getEvent(id)!;
}

export function getEvent(id: string): TagEvent | null {
  const row = getDb().prepare(`SELECT * FROM tag_event WHERE id = ?`).get(id) as
    | EventRow
    | undefined;
  return row ? toEvent(row) : null;
}

export function patchEvent(id: string, patch: TagEventPatch): TagEvent | null {
  const current = getEvent(id);
  if (!current) return null;
  const now = Date.now();
  const db = getDb();

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE tag_event SET
         t_in_ms = ?, t_out_ms = ?, tag_type_id = ?, player_in_match_id = ?,
         team_side = ?, pitch_x = ?, pitch_y = ?, attack_dir = ?,
         notes = ?, rating = ?, reviewed = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      patch.tInMs ?? current.tInMs,
      patch.tOutMs === undefined ? current.tOutMs : patch.tOutMs,
      patch.tagTypeId ?? current.tagTypeId,
      patch.playerInMatchId === undefined ? current.playerInMatchId : patch.playerInMatchId,
      patch.side === undefined ? current.side : patch.side,
      patch.pitch === undefined ? current.pitchX : patch.pitch?.x ?? null,
      patch.pitch === undefined ? current.pitchY : patch.pitch?.y ?? null,
      patch.pitch === undefined ? current.attackDir : patch.pitch?.attackDir ?? null,
      patch.notes === undefined ? current.notes : patch.notes,
      patch.rating === undefined ? current.rating : patch.rating,
      patch.reviewed === undefined ? (current.reviewed ? 1 : 0) : patch.reviewed ? 1 : 0,
      now,
      id,
    );
    db.prepare(`INSERT INTO journal (command, payload, ts) VALUES (?,?,?)`).run(
      'tag_event.patch',
      JSON.stringify({ id, patch }),
      now,
    );
  });
  tx();

  return getEvent(id);
}

export function deleteEvent(id: string): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM tag_event WHERE id = ?`).run(id);
    db.prepare(`INSERT INTO journal (command, payload, inverse, ts) VALUES (?,?,?,?)`).run(
      'tag_event.delete',
      JSON.stringify({ id }),
      JSON.stringify({ command: 'tag_event.insertFromSnapshot', payload: { id } }),
      Date.now(),
    );
  });
  tx();
}

// ──────────────────────────────────────────────────────────────────────
// Annotations
// ──────────────────────────────────────────────────────────────────────

interface AnnotationRow {
  id: string;
  asset_id: string;
  t_in_ms: number;
  t_out_ms: number | null;
  kind: Annotation['kind'];
  space: 'SCREEN' | 'PITCH';
  points: string;
  style: string;
  text: string | null;
  track_bind_id: number | null;
  layer: number;
  z_index: number;
  is_locked: number;
}

const toAnnotation = (r: AnnotationRow): Annotation => ({
  id: r.id,
  assetId: r.asset_id,
  tInMs: r.t_in_ms,
  tOutMs: r.t_out_ms,
  kind: r.kind,
  space: r.space,
  points: JSON.parse(r.points) as readonly { u: number; v: number }[],
  style: JSON.parse(r.style) as Annotation['style'],
  text: r.text,
  trackBindId: r.track_bind_id,
  layer: r.layer,
  zIndex: r.z_index,
  isLocked: r.is_locked === 1,
});

export function listAnnotations(assetId: string): Annotation[] {
  const rows = getDb()
    .prepare(`SELECT * FROM annotation WHERE asset_id = ? ORDER BY layer, z_index`)
    .all(assetId) as AnnotationRow[];
  return rows.map(toAnnotation);
}
