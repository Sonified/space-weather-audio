-- Clean rebuild: rename session_id → group_id, drop dead columns from studies,
-- nuke all test data in the process (fresh tables).

-- ── Participants ──────────────────────────────────────────────
DROP TABLE IF EXISTS participants;
CREATE TABLE participants (
  participant_id    TEXT NOT NULL,
  study_id          TEXT NOT NULL,
  group_id          TEXT,
  current_step      INTEGER DEFAULT 0,
  registered_at     TEXT DEFAULT (datetime('now')),
  completed_at      TEXT,
  updated_at        TEXT,
  responses         TEXT DEFAULT '{}',
  flags             TEXT DEFAULT '{}',
  step_history      TEXT DEFAULT '[]',
  last_event        TEXT DEFAULT '{}',
  last_heartbeat    TEXT,
  assigned_condition INTEGER,
  assigned_block    INTEGER,
  assignment_mode   TEXT,
  assigned_at       TEXT,
  PRIMARY KEY (participant_id, study_id)
);

-- ── Features ──────────────────────────────────────────────────
DROP TABLE IF EXISTS features;
CREATE TABLE features (
  id                TEXT PRIMARY KEY,
  participant_id    TEXT NOT NULL,
  study_id          TEXT NOT NULL,
  analysis_session  INTEGER,
  start_time        TEXT,
  end_time          TEXT,
  low_freq          REAL,
  high_freq         REAL,
  confidence        TEXT DEFAULT 'confirmed',
  notes             TEXT DEFAULT '',
  speed_factor      REAL,
  created_at        TEXT DEFAULT (datetime('now'))
);

-- ── Assignment Sessions ───────────────────────────────────────
DROP TABLE IF EXISTS assignment_sessions;
CREATE TABLE assignment_sessions (
  session_id          TEXT PRIMARY KEY,
  study_id            TEXT NOT NULL,
  mode                TEXT DEFAULT 'test',
  started_at          TEXT DEFAULT (datetime('now')),
  ended_at            TEXT,
  assignment_state    TEXT,
  assignment_version  INTEGER DEFAULT 0
);

-- ── Studies (rebuild without dead columns) ────────────────────
-- Preserve study configs — they're not test data
CREATE TABLE studies_new (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  config          TEXT NOT NULL DEFAULT '{}',
  admin_key       TEXT,
  auth_fails      INTEGER DEFAULT 0,
  auth_locked_until TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO studies_new (id, name, config, admin_key, auth_fails, auth_locked_until, created_at, updated_at)
  SELECT id, name, config, admin_key, auth_fails, auth_locked_until, created_at, updated_at FROM studies;
DROP TABLE studies;
ALTER TABLE studies_new RENAME TO studies;
