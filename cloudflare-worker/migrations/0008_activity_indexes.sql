-- Indexes for the activity feed endpoint
-- Queries filter by study_id + updated_at/created_at with ORDER BY DESC + LIMIT
CREATE INDEX IF NOT EXISTS idx_participants_activity
  ON participants(study_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_features_activity
  ON features(study_id, created_at DESC);
