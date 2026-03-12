-- Migration: Add updated_at and step_history columns to participants
-- Date: 2026-03-12

-- Track when each participant row was last modified
ALTER TABLE participants ADD COLUMN updated_at TEXT DEFAULT (datetime('now'));

-- Backfill existing rows
UPDATE participants SET updated_at = registered_at WHERE updated_at IS NULL;

-- NOTE: step_history is added by migration 0001 (d1-restructuring branch).
-- If merging both branches, ensure 0001 runs first.
