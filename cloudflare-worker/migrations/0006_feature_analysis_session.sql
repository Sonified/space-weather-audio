-- Migration: Add analysis_session to features
-- Date: 2026-03-15

-- Which analysis session (1 or 2) this feature was drawn in
ALTER TABLE features ADD COLUMN analysis_session INTEGER;
