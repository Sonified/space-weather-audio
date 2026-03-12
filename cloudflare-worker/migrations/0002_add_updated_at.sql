-- Migration: Add updated_at and step_history columns to participants
-- Date: 2026-03-12

-- Track when each participant row was last modified
ALTER TABLE participants ADD COLUMN updated_at TEXT DEFAULT (datetime('now'));

-- Backfill existing rows
UPDATE participants SET updated_at = registered_at WHERE updated_at IS NULL;

-- step_history may not exist yet depending on migration order
ALTER TABLE participants ADD COLUMN step_history TEXT DEFAULT '[]';
