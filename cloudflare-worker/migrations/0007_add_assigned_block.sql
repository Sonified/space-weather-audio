-- Migration: Add assigned_block column to participants
-- Date: 2026-03-15

ALTER TABLE participants ADD COLUMN assigned_block INTEGER;
