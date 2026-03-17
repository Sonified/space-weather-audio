-- Migration: Add mode column to assignment_sessions (test vs live)
-- Date: 2026-03-17

ALTER TABLE assignment_sessions ADD COLUMN mode TEXT DEFAULT 'test';
