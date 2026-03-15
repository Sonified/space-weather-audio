-- Migration: Add assignment state tracking
-- Date: 2026-03-15

-- Algorithm state (block table + pointers) stored as JSON on the study
ALTER TABLE studies ADD COLUMN assignment_state TEXT;
ALTER TABLE studies ADD COLUMN assignment_version INTEGER DEFAULT 0;

-- Per-participant assignment metadata
ALTER TABLE participants ADD COLUMN assigned_condition INTEGER;
ALTER TABLE participants ADD COLUMN assignment_mode TEXT;
ALTER TABLE participants ADD COLUMN assigned_at TEXT;
