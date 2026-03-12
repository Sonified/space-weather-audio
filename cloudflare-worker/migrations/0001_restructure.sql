-- Migration: Restructure D1 from 3 data tables to participants + features
-- Date: 2026-03-12
--
-- Drops: data_study, data_test, data_preview (pilot-only data, not worth keeping)
-- Creates: participants (one row per participant per study)
--          features (one row per annotated feature)

-- Drop old tables
DROP TABLE IF EXISTS data_study;
DROP TABLE IF EXISTS data_test;
DROP TABLE IF EXISTS data_preview;

-- participants: one row per participant per study
CREATE TABLE IF NOT EXISTS participants (
  participant_id TEXT NOT NULL,
  study_id TEXT NOT NULL,
  current_step INTEGER DEFAULT 0,
  registered_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  responses TEXT DEFAULT '{}',
  flags TEXT DEFAULT '{}',
  step_history TEXT DEFAULT '[]',
  PRIMARY KEY (participant_id, study_id)
);

-- features: one row per annotated feature
CREATE TABLE IF NOT EXISTS features (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  study_id TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  low_freq REAL,
  high_freq REAL,
  confidence TEXT DEFAULT 'confirmed',
  notes TEXT DEFAULT '',
  speed_factor REAL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_features_lookup
  ON features(participant_id, study_id);
