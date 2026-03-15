-- Migration: Assignment sessions — each test/launch gets its own session
-- Date: 2026-03-15

-- Each session has its own block table and algorithm state
CREATE TABLE IF NOT EXISTS assignment_sessions (
  session_id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL,
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT,
  assignment_state TEXT,
  assignment_version INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sessions_study
  ON assignment_sessions(study_id, started_at DESC);

-- Tag each participant with their session
ALTER TABLE participants ADD COLUMN session_id TEXT;
