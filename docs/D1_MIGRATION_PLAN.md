# D1 Migration Plan — KV → Cloudflare D1

## Why

Currently participant data is saved to Cloudflare KV as a single JSON blob. This works but has real problems:

- **Concurrent writes** — two participants submitting at the same time = last-write-wins. One person's data gets silently clobbered.
- **No queryability** — to analyze results you download the entire blob and parse it locally.
- **Study config is static** — `survey_structure.json` is baked into the deploy. Researcher changes anything → redeploy.

## What D1 Is

Cloudflare's edge database. SQLite distributed across their network. Same ecosystem we're already in — same CLI (`wrangler`), same Workers, same deploy pipeline. No new platform.

Supports JSON columns with `json_extract()` queries, so we keep the flexibility of JSON without losing the power of SQL.

## What Changes

### Before (KV)
```
Participant submits → read entire blob from KV → parse JSON → append new data → write entire blob back to KV
```

### After (D1)
```
Participant submits → INSERT one row into responses table
Researcher updates study → UPDATE config JSON in studies table → live on next page load
```

## Schema

Three tables. That's it.

### `studies`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PRIMARY KEY | UUID |
| name | TEXT | Human-readable study name |
| created_by | TEXT | Researcher identifier |
| config | TEXT (JSON) | The full study config — survey questions, day definitions, feature flags, tutorial settings. Replaces `survey_structure.json` |
| created_at | TEXT | ISO timestamp |
| updated_at | TEXT | ISO timestamp |

### `participants`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PRIMARY KEY | UUID or participant code |
| study_id | TEXT | FK → studies.id |
| started_at | TEXT | ISO timestamp |
| current_day | INTEGER | Which day they're on |
| consent | TEXT (JSON) | Consent form responses |
| demographics | TEXT (JSON) | Intake survey data |

### `responses`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PRIMARY KEY | UUID |
| participant_id | TEXT | FK → participants.id |
| study_id | TEXT | FK → studies.id |
| day | INTEGER | Which study day |
| type | TEXT | `survey`, `feature_use`, `playback_event`, `region_draw`, etc. |
| data | TEXT (JSON) | The actual payload — flexible per type |
| created_at | TEXT | ISO timestamp |

### Why JSON columns?

Lucy can change survey questions without a database migration. A survey response might look like:
```json
{"q1": "agree", "q2": 4, "freetext": "the sonification helped me hear the EMIC wave"}
```

A feature_use event:
```json
{"feature": "stretch", "value": 1.25, "duration_seconds": 45, "day": 3}
```

Different shapes, same table. Query into them with:
```sql
SELECT json_extract(data, '$.feature'), count(*)
FROM responses WHERE type = 'feature_use'
GROUP BY json_extract(data, '$.feature');
```

## Migration SQL

```sql
-- schema.sql

CREATE TABLE IF NOT EXISTS studies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  study_id TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  current_day INTEGER DEFAULT 1,
  consent TEXT DEFAULT '{}',
  demographics TEXT DEFAULT '{}',
  FOREIGN KEY (study_id) REFERENCES studies(id)
);

CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  study_id TEXT NOT NULL,
  day INTEGER,
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (participant_id) REFERENCES participants(id),
  FOREIGN KEY (study_id) REFERENCES studies(id)
);

CREATE INDEX idx_responses_participant ON responses(participant_id);
CREATE INDEX idx_responses_study_day ON responses(study_id, day);
CREATE INDEX idx_responses_type ON responses(type);
CREATE INDEX idx_participants_study ON participants(study_id);
```

## Implementation Steps

### 1. Create the database
```bash
wrangler d1 create study-db
```
This returns a database ID. Add it to `wrangler.toml`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "study-db"
database_id = "<id-from-create>"
```

### 2. Run the schema
```bash
wrangler d1 execute study-db --file schema.sql
```

### 3. Seed the first study config
Take the current `survey_structure.json` + day/feature config and insert it as the first study row:
```bash
wrangler d1 execute study-db --command "INSERT INTO studies (id, name, config) VALUES ('emic-pilot', 'EMIC Pilot Study', '<json>')"
```

### 4. Update Worker routes
Add API endpoints to the existing Worker:

| Route | Method | What it does |
|-------|--------|-------------|
| `/api/study/:id/config` | GET | Returns study config (replaces static JSON) |
| `/api/study/:id/config` | PUT | Updates study config (study builder saves here) |
| `/api/study/:id/participants` | POST | Register new participant |
| `/api/study/:id/responses` | POST | Submit a response/event |
| `/api/study/:id/responses` | GET | Query responses (for analysis) |

### 5. Update front-end
- Fetch study config from `/api/study/:id/config` instead of static JSON
- POST responses to `/api/study/:id/responses` instead of writing to KV blob
- Minimal changes — the front-end still works with JSON, it just comes from a different place

### 6. Migrate existing KV data
One-time script: read the KV blob, parse it, INSERT each participant/response as individual rows.

## What This Unlocks

- **Study builder UI** — researcher edits config in a UI → saves to D1 → live immediately. No redeploy.
- **Concurrent participants** — every submission is an INSERT, no conflicts.
- **Analysis-ready data** — SQL queries at the edge. Aggregations, filters, exports.
- **Multi-study support** — different studies in the same database, same infrastructure.
- **Audit trail** — every response is a timestamped row. Nothing gets overwritten.
- **SciAct deliverable** — a real research platform, not a static page with a data hack.

## What Doesn't Change

- Cloudflare Workers — same platform, same deploy
- Front-end code — same app, just different data source
- Domain / DNS / CDN — untouched
- Audio playback, spectrograms, features — untouched
- `wrangler deploy` — same command

## Manual Steps (Robert)

All code is written. Run these commands to activate D1:

### 1. Create the D1 database
```bash
cd cloudflare-worker
wrangler d1 create study-db
```
Copy the `database_id` from the output.

### 2. Update wrangler.toml
Open `cloudflare-worker/wrangler.toml` and replace `REPLACE_WITH_D1_DATABASE_ID` with the actual ID.

### 3. Run the schema migration
```bash
wrangler d1 execute study-db --file schema.sql
```

### 4. Seed the first study config
```bash
wrangler d1 execute study-db --command "INSERT INTO studies (id, name, created_by, config) VALUES ('emic-pilot', 'EMIC Pilot Study', 'robert', '{}')"
```
(Optionally replace `'{}'` with the full contents of `survey_structure.json` later.)

### 5. Deploy the Worker
```bash
wrangler deploy
```

### 6. Migrate existing R2 data to D1
```bash
curl -X POST https://spaceweather.now.audio/api/emic/migrate-to-d1
```
This reads the R2 master JSON and inserts all records as D1 rows. Safe to run multiple times (uses unique IDs per response).

### 7. Verify
- `curl https://spaceweather.now.audio/api/study/emic-pilot/config` — should return study
- `curl https://spaceweather.now.audio/api/study/emic-pilot/participants` — should show migrated participants
- `curl https://spaceweather.now.audio/api/study/emic-pilot/responses?limit=5` — should show responses
- Test a submission from the front-end — check both D1 and R2 get the data

## Cost

D1 free tier: 5M reads/day, 100K writes/day, 5GB storage. A research study with dozens of participants won't come close.
