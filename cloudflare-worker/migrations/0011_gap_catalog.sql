-- Gap catalog: data availability intervals with ms-precise boundaries
CREATE TABLE IF NOT EXISTS intervals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dataset_id TEXT NOT NULL,
    start_iso TEXT NOT NULL,
    end_iso TEXT NOT NULL,
    start_precise TEXT,
    end_precise TEXT,
    cadence_ns REAL,
    UNIQUE(dataset_id, start_iso)
);

CREATE INDEX IF NOT EXISTS idx_intervals_dataset_time
    ON intervals (dataset_id, start_iso, end_iso);
