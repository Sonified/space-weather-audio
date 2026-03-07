-- D1 Schema for EMIC Study Data
-- Replaces the R2 master JSON approach with proper relational storage
-- Run: wrangler d1 execute study-db --file schema.sql

CREATE TABLE IF NOT EXISTS studies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  current_day INTEGER DEFAULT 1,
  consent TEXT DEFAULT '{}',
  demographics TEXT DEFAULT '{}',
  FOREIGN KEY (study_id) REFERENCES studies(id)
);

CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  study_id TEXT NOT NULL,
  day INTEGER,
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (participant_id) REFERENCES participants(id),
  FOREIGN KEY (study_id) REFERENCES studies(id)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_responses_participant ON responses(participant_id);
CREATE INDEX IF NOT EXISTS idx_responses_study_day ON responses(study_id, day);
CREATE INDEX IF NOT EXISTS idx_responses_type ON responses(type);
CREATE INDEX IF NOT EXISTS idx_participants_study ON participants(study_id);
