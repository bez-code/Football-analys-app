export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * Migrations are TS string constants rather than .sql files on purpose: the
 * packaged app has no loose SQL files to locate, and a missing file that only
 * fails on a user's machine is not an option.
 *
 * Never edit a shipped migration. Add a new one.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: /* sql */ `
--------------------------------------------------------------------------------
-- identity
--------------------------------------------------------------------------------
CREATE TABLE team (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  short_name  TEXT,
  crest_path  TEXT
);

CREATE TABLE player (
  id                TEXT PRIMARY KEY,
  team_id           TEXT REFERENCES team(id) ON DELETE SET NULL,
  first_name        TEXT NOT NULL,
  last_name         TEXT NOT NULL,
  shirt_number      INTEGER,
  role              TEXT CHECK (role IN ('GK','CB','FB','WB','DM','CM','AM','W','ST','UNK')),
  dominant_foot     TEXT CHECK (dominant_foot IN ('L','R','B')),
  preferred_foot_pct REAL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX ix_player_team ON player(team_id);

CREATE TABLE squad_membership (
  player_id TEXT NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  team_id   TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  season    TEXT NOT NULL,
  PRIMARY KEY (player_id, season)
);

CREATE TABLE competition (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  country TEXT
);

CREATE TABLE fixture (
  id            TEXT PRIMARY KEY,
  competition_id TEXT REFERENCES competition(id) ON DELETE SET NULL,
  season        TEXT,
  round         TEXT,
  home_team_id  TEXT REFERENCES team(id) ON DELETE SET NULL,
  away_team_id  TEXT REFERENCES team(id) ON DELETE SET NULL,
  kickoff_utc   TEXT,
  venue         TEXT,
  home_score    INTEGER,
  away_score    INTEGER,
  our_side      TEXT CHECK (our_side IN ('HOME','AWAY','NA')),
  created_at    INTEGER NOT NULL
);

-- Identity for a matchday. All tag events point here, not at player directly,
-- because shirt numbers get reused and squads rotate mid-season.
CREATE TABLE player_in_match (
  id             TEXT PRIMARY KEY,
  fixture_id     TEXT NOT NULL REFERENCES fixture(id) ON DELETE CASCADE,
  player_id      TEXT REFERENCES player(id) ON DELETE SET NULL,
  team_side      TEXT NOT NULL CHECK (team_side IN ('HOME','AWAY')),
  shirt_number   INTEGER,
  position_code  TEXT,
  minutes_played INTEGER,
  UNIQUE (fixture_id, team_side, shirt_number)
);
CREATE INDEX ix_pim_fixture ON player_in_match(fixture_id);

--------------------------------------------------------------------------------
-- media
--------------------------------------------------------------------------------
CREATE TABLE media_asset (
  id           TEXT PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,
  sha1         TEXT,
  file_size    INTEGER NOT NULL DEFAULT 0,
  name         TEXT NOT NULL,
  width        INTEGER NOT NULL DEFAULT 0,
  height       INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  fps_num      INTEGER NOT NULL DEFAULT 25,
  fps_den      INTEGER NOT NULL DEFAULT 1,
  video_codec  TEXT,
  audio_codec  TEXT,
  pix_fmt      TEXT,
  hdr_transfer TEXT,
  rotation_deg INTEGER NOT NULL DEFAULT 0,
  was_cfr      INTEGER NOT NULL DEFAULT 1,
  -- proxy_state: NONE | PENDING | READY | FAILED
  state        TEXT NOT NULL DEFAULT 'PENDING',
  proxy_state  TEXT NOT NULL DEFAULT 'NONE',
  proxy_path   TEXT,
  sprite_path  TEXT,
  wave_path    TEXT,
  probe_json   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX ix_asset_sha1 ON media_asset(sha1);
CREATE INDEX ix_asset_created ON media_asset(created_at DESC);

-- A broadcast file contains many camera shots. Each shot has its own homography,
-- so calibration is per-shot and NOT per-file. Getting this wrong silently
-- corrupts every spatial metric.
CREATE TABLE camera_shot (
  id          TEXT PRIMARY KEY,
  asset_id    TEXT NOT NULL REFERENCES media_asset(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  t_in_ms     INTEGER NOT NULL,
  t_out_ms    INTEGER NOT NULL,
  camera_type TEXT NOT NULL DEFAULT 'OTHER'
              CHECK (camera_type IN ('MAIN','WIDE','BEHIND_GOAL','GOAL_1','GOAL_2','SIDE','REVERSE','OTHER')),
  UNIQUE (asset_id, idx)
);
CREATE INDEX ix_shot_asset ON camera_shot(asset_id, idx);

CREATE TABLE shot_calibration (
  id              TEXT PRIMARY KEY,
  camera_shot_id  TEXT NOT NULL REFERENCES camera_shot(id) ON DELETE CASCADE,
  homography      TEXT,             -- JSON 3x3 row-major, PITCH -> SCREEN
  ref_points      TEXT,             -- JSON [{u,v,pitchX,pitchY}]
  method          TEXT,             -- MANUAL | AUTO
  rms_px          REAL,             -- reprojection error; gates spatial metrics
  n_points        INTEGER NOT NULL DEFAULT 0,
  confidence      REAL,
  is_valid        INTEGER NOT NULL DEFAULT 0,
  t_valid_ms      INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX ix_calib_shot ON shot_calibration(camera_shot_id);

-- Track ids are only stable within one shot. Never assume otherwise.
CREATE TABLE track_identity (
  camera_shot_id      TEXT NOT NULL REFERENCES camera_shot(id) ON DELETE CASCADE,
  track_id            INTEGER NOT NULL,
  player_in_match_id  TEXT REFERENCES player_in_match(id) ON DELETE SET NULL,
  confidence          REAL,
  is_manual           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (camera_shot_id, track_id)
);

--------------------------------------------------------------------------------
-- taxonomy: versioned and fully user-editable
--------------------------------------------------------------------------------
CREATE TABLE tag_scheme (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE tag_type (
  id                  TEXT PRIMARY KEY,
  scheme_id           TEXT NOT NULL REFERENCES tag_scheme(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  color               TEXT NOT NULL DEFAULT '#f5c542',
  hotkey              TEXT,
  min_select          INTEGER NOT NULL DEFAULT 1,
  max_select          INTEGER NOT NULL DEFAULT 1,
  kind                TEXT NOT NULL DEFAULT 'INSTANT' CHECK (kind IN ('INSTANT','INTERVAL')),
  default_duration_ms INTEGER NOT NULL DEFAULT 0,
  parent_id           TEXT,
  sort                INTEGER NOT NULL DEFAULT 0,
  is_system           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_tagtype_scheme ON tag_type(scheme_id, sort);

CREATE TABLE descriptor_def (
  id          TEXT PRIMARY KEY,
  tag_type_id TEXT NOT NULL REFERENCES tag_type(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  hotkey      TEXT,
  min_select  INTEGER NOT NULL DEFAULT 0,
  max_select  INTEGER NOT NULL DEFAULT 99,
  sort        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_descdef_type ON descriptor_def(tag_type_id, sort);

CREATE TABLE descriptor_value (
  id                TEXT PRIMARY KEY,
  descriptor_def_id TEXT NOT NULL REFERENCES descriptor_def(id) ON DELETE CASCADE,
  value             TEXT NOT NULL,
  color             TEXT,
  sort              INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_descval_def ON descriptor_value(descriptor_def_id, sort);

--------------------------------------------------------------------------------
-- coded instances - the heart of the tool
--------------------------------------------------------------------------------
CREATE TABLE tag_event (
  id                TEXT PRIMARY KEY,
  asset_id          TEXT NOT NULL REFERENCES media_asset(id) ON DELETE CASCADE,
  -- exactly one of fixture_id / session_id is set for match vs training work
  fixture_id        TEXT REFERENCES fixture(id) ON DELETE CASCADE,
  session_id        TEXT,
  t_in_ms           INTEGER NOT NULL,
  t_out_ms          INTEGER,          -- NULL means instantaneous
  tag_type_id       TEXT NOT NULL REFERENCES tag_type(id) ON DELETE CASCADE,
  player_in_match_id TEXT REFERENCES player_in_match(id) ON DELETE SET NULL,
  team_side         TEXT CHECK (team_side IN ('HOME','AWAY')),
  pitch_x           REAL,             -- 0..1 normalised, Metrica convention
  pitch_y           REAL,
  attack_dir        TEXT CHECK (attack_dir IN ('L','R')),
  value             REAL,
  notes             TEXT,
  rating            INTEGER,
  confidence        REAL,
  -- source: MANUAL | AI_PROPOSED | IMPORT
  source            TEXT NOT NULL DEFAULT 'MANUAL',
  reviewed          INTEGER NOT NULL DEFAULT 1,
  -- chains events into sequences; used by the Pattern engine
  parent_event_id   TEXT,
  seq_index         INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX ix_te_time   ON tag_event(asset_id, t_in_ms);
CREATE INDEX ix_te_type   ON tag_event(tag_type_id);
CREATE INDEX ix_te_fixture ON tag_event(fixture_id, tag_type_id);
CREATE INDEX ix_te_parent ON tag_event(parent_event_id, seq_index);

CREATE TABLE tag_event_descriptor (
  tag_event_id       TEXT NOT NULL REFERENCES tag_event(id) ON DELETE CASCADE,
  descriptor_value_id TEXT NOT NULL REFERENCES descriptor_value(id) ON DELETE CASCADE,
  PRIMARY KEY (tag_event_id, descriptor_value_id)
);
CREATE INDEX ix_ted_value ON tag_event_descriptor(descriptor_value_id);

--------------------------------------------------------------------------------
-- zones
--------------------------------------------------------------------------------
CREATE TABLE zone (
  id          TEXT PRIMARY KEY,
  fixture_id  TEXT REFERENCES fixture(id) ON DELETE CASCADE,
  session_id  TEXT,
  name        TEXT NOT NULL,
  parent_id   TEXT,
  color       TEXT NOT NULL DEFAULT '#4a90d9',
  polygon     TEXT NOT NULL,     -- JSON [[x,y],...] in PITCH coords
  is_dynamic  INTEGER NOT NULL DEFAULT 0,
  parent_track_id INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX ix_zone_fixture ON zone(fixture_id);

--------------------------------------------------------------------------------
-- telestration
--------------------------------------------------------------------------------
CREATE TABLE annotation (
  id            TEXT PRIMARY KEY,
  asset_id      TEXT NOT NULL REFERENCES media_asset(id) ON DELETE CASCADE,
  t_in_ms       INTEGER NOT NULL,
  t_out_ms      INTEGER,        -- NULL = persists to end of asset
  kind          TEXT NOT NULL
                CHECK (kind IN ('LINE','ARROW','ZONE','PATH','TEXT','SPOT','RING',
                                'SPOTLIGHT','MAGNIFIER','BUBBLE','CONE','TRAIL')),
  space         TEXT NOT NULL DEFAULT 'SCREEN' CHECK (space IN ('SCREEN','PITCH')),
  points        TEXT NOT NULL,  -- JSON [[u,v],...] in the chosen space
  style         TEXT NOT NULL,  -- JSON AnnotationStyle
  text          TEXT,
  track_bind_id INTEGER,        -- follow a tracking entity
  layer         INTEGER NOT NULL DEFAULT 0,
  z_index       INTEGER NOT NULL DEFAULT 0,
  is_locked     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX ix_anno_asset ON annotation(asset_id, t_in_ms);

CREATE TABLE annotation_keyframe (
  annotation_id TEXT NOT NULL REFERENCES annotation(id) ON DELETE CASCADE,
  t_ms          INTEGER NOT NULL,
  matrix        TEXT NOT NULL,  -- JSON 6-value affine
  PRIMARY KEY (annotation_id, t_ms)
);

--------------------------------------------------------------------------------
-- metrics: definitions are versioned, results carry provenance
--------------------------------------------------------------------------------
CREATE TABLE metric_definition (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  category      TEXT NOT NULL,
  unit          TEXT,
  scope         TEXT NOT NULL CHECK (scope IN ('MATCH','PERIOD','PLAYER','FRAME')),
  params_schema TEXT,           -- JSON schema
  compute_key   TEXT NOT NULL,  -- -> registry in the engine
  created_at    INTEGER NOT NULL
);

CREATE TABLE metric_result (
  id                 TEXT PRIMARY KEY,
  metric_id          TEXT NOT NULL REFERENCES metric_definition(id) ON DELETE CASCADE,
  fixture_id         TEXT REFERENCES fixture(id) ON DELETE CASCADE,
  session_id         TEXT,
  player_in_match_id TEXT REFERENCES player_in_match(id) ON DELETE CASCADE,
  period             TEXT,
  value              REAL,
  series_blob        BLOB,       -- Float32Array for per-frame series
  computed_at        INTEGER NOT NULL
);
CREATE INDEX ix_mres_fixture ON metric_result(fixture_id, metric_id);

-- xT / xG / EPV grids. Weights + provenance, not just numbers, so any value
-- ever shown in the app can be reproduced or explained.
CREATE TABLE value_model (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('XT','XG','EPV','PPDA')),
  grid_x     INTEGER NOT NULL,
  grid_y     INTEGER NOT NULL,
  x0         REAL NOT NULL,
  y0         REAL NOT NULL,
  dx         REAL NOT NULL,
  dy         REAL NOT NULL,
  data       BLOB NOT NULL,     -- Float32, row-major
  source     TEXT,
  version    TEXT,
  params     TEXT,
  created_at INTEGER NOT NULL
);

--------------------------------------------------------------------------------
-- clips & deliverables
--------------------------------------------------------------------------------
CREATE TABLE clip (
  id              TEXT PRIMARY KEY,
  asset_id        TEXT NOT NULL REFERENCES media_asset(id) ON DELETE CASCADE,
  t_in_ms         INTEGER NOT NULL,
  t_out_ms        INTEGER NOT NULL,
  tag_event_id    TEXT REFERENCES tag_event(id) ON DELETE SET NULL,
  label           TEXT,
  -- render_state: NONE | PENDING | RENDERING | READY | FAILED
  render_state    TEXT NOT NULL DEFAULT 'NONE',
  render_path     TEXT,
  render_revision INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE INDEX ix_clip_asset ON clip(asset_id, t_in_ms);

CREATE TABLE playlist (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE playlist_item (
  playlist_id   TEXT NOT NULL REFERENCES playlist(id) ON DELETE CASCADE,
  clip_id       TEXT NOT NULL REFERENCES clip(id) ON DELETE CASCADE,
  sort          INTEGER NOT NULL,
  transition    TEXT NOT NULL DEFAULT 'CUT',
  title_card    TEXT,
  presenter_note TEXT,
  PRIMARY KEY (playlist_id, clip_id)
);

CREATE TABLE report (
  id          TEXT PRIMARY KEY,
  fixture_id  TEXT REFERENCES fixture(id) ON DELETE CASCADE,
  session_id  TEXT,
  name        TEXT NOT NULL,
  template    TEXT NOT NULL,
  params      TEXT,
  state       TEXT NOT NULL DEFAULT 'DRAFT',
  output_path TEXT,
  created_at  INTEGER NOT NULL
);

--------------------------------------------------------------------------------
-- training & skills
--------------------------------------------------------------------------------
CREATE TABLE training_session (
  id           TEXT PRIMARY KEY,
  fixture_id   TEXT REFERENCES fixture(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  session_date TEXT NOT NULL,
  phase        TEXT,
  focus        TEXT,
  duration_min INTEGER,
  notes        TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE session_block (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES training_session(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  sort         INTEGER NOT NULL,
  duration_min INTEGER
);

CREATE TABLE drill (
  id                   TEXT PRIMARY KEY,
  block_id             TEXT NOT NULL REFERENCES session_block(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  category             TEXT,
  sort                 INTEGER NOT NULL,
  setup                TEXT,
  coaching_points      TEXT,
  board_annotation_id  TEXT REFERENCES annotation(id) ON DELETE SET NULL
);

CREATE TABLE session_attendance (
  session_id        TEXT NOT NULL REFERENCES training_session(id) ON DELETE CASCADE,
  player_id         TEXT NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  player_in_match_id TEXT,
  present           INTEGER NOT NULL DEFAULT 1,
  rpe               INTEGER,       -- 1..10
  load              REAL,          -- RPE * minutes
  wellness          INTEGER,       -- 1..5
  PRIMARY KEY (session_id, player_id)
);

CREATE TABLE skill_definition (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  category   TEXT,
  scale_json TEXT NOT NULL          -- JSON [{value,label}]
);

CREATE TABLE skill_assessment (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES training_session(id) ON DELETE CASCADE,
  player_id   TEXT NOT NULL REFERENCES player(id) ON DELETE CASCADE,
  skill_id    TEXT NOT NULL REFERENCES skill_definition(id) ON DELETE CASCADE,
  score       REAL NOT NULL,
  notes       TEXT,
  clip_id     TEXT REFERENCES clip(id) ON DELETE SET NULL,
  assessed_at INTEGER NOT NULL
);
CREATE INDEX ix_sa_player ON skill_assessment(player_id, skill_id, assessed_at);

--------------------------------------------------------------------------------
-- patterns: saved multi-event queries
--------------------------------------------------------------------------------
CREATE TABLE pattern (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  query       TEXT NOT NULL,        -- safe DSL, never eval'd
  created_at  INTEGER NOT NULL
);

CREATE TABLE pattern_match (
  id             TEXT PRIMARY KEY,
  pattern_id     TEXT NOT NULL REFERENCES pattern(id) ON DELETE CASCADE,
  fixture_id     TEXT REFERENCES fixture(id) ON DELETE CASCADE,
  anchor_event_id TEXT REFERENCES tag_event(id) ON DELETE CASCADE,
  event_ids      TEXT NOT NULL,     -- JSON [eventId]
  t_in_ms        INTEGER NOT NULL,
  t_out_ms       INTEGER NOT NULL,
  computed_at    INTEGER NOT NULL
);
CREATE INDEX ix_pm_pattern ON pattern_match(pattern_id, fixture_id);

--------------------------------------------------------------------------------
-- infrastructure
--------------------------------------------------------------------------------
CREATE TABLE job (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  params       TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'PENDING'
               CHECK (state IN ('PENDING','RUNNING','DONE','FAILED','CANCELED')),
  progress     REAL NOT NULL DEFAULT 0,
  priority     INTEGER NOT NULL DEFAULT 0,
  dedupe_key   TEXT UNIQUE,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER
);
CREATE INDEX ix_job_claim ON job(state, priority DESC, created_at);

-- Append-only journal. Every mutation writes here first, which gives us undo,
-- crash recovery and "rebuild state" without full event sourcing.
CREATE TABLE journal (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  command  TEXT NOT NULL,
  payload  TEXT NOT NULL,
  inverse  TEXT,
  ts       INTEGER NOT NULL
);

CREATE TABLE setting (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER NOT NULL
);
`,
  },
];
