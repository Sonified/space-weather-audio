-- Migration: Add last_heartbeat column to participants
-- Date: 2026-03-15

ALTER TABLE participants ADD COLUMN last_heartbeat TEXT;
