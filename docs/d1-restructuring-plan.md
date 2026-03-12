# D1 Restructuring + Admin Step Navigation

## Overview
Replace three separate data tables (`data_study`, `data_test`, `data_preview`) with two clean tables (`participants` + `features`). Add server-side progress tracking. Add admin step navigation UI.

**Status:** Phase 5 (admin step nav) is done. Phases 1-4 remain.

---

## Phase 1: SQL Migration

**New tables:**

```sql
-- participants: one row per participant per study
CREATE TABLE participants (
  participant_id TEXT NOT NULL,
  study_id TEXT NOT NULL,
  current_step INTEGER DEFAULT 0,
  registered_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  responses TEXT DEFAULT '{}',   -- JSON: survey answers, settings
  flags TEXT DEFAULT '{}',       -- JSON: welcomed, skipLogin, etc.
  PRIMARY KEY (participant_id, study_id)
);

-- features: one row per annotated feature
CREATE TABLE features (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  study_id TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  low_freq REAL,
  high_freq REAL,
  confidence TEXT DEFAULT 'confirmed',  -- 'confirmed' or 'uncertain'
  notes TEXT DEFAULT '',
  speed_factor REAL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_features_lookup
  ON features(participant_id, study_id);
```

**Migration:** DROP old tables, CREATE new ones. Old tables have no production data worth keeping (pilot only).

---

## Phase 2: Worker Endpoint Changes

**File:** `cloudflare-worker/src/index.js`

1. **Delete** `dataTable()` helper
2. **Rewrite** `POST /api/study/:studyId/participants` → UPSERT into `participants` table
3. **Rewrite** `POST /api/study/:studyId/responses` → INSERT into `features` (for type=feature) or UPDATE `participants.responses` JSON (for surveys/milestones)
4. **Add** `GET /api/study/:studyId/participants/:pid/progress` → return `current_step`, `responses`, `flags`
5. **Add** `PUT /api/study/:studyId/participants/:pid/step` → update `current_step`

Mode detection stays the same — just read the prefix from `participant_id` when needed for logging. No separate tables.

---

## Phase 3: Frontend d1-sync.js

**File:** `js/d1-sync.js`

1. **Add** `d1Put(path, body)` — same pattern as `d1Post` but PUT method
2. **Add** `syncStep(step)` — fire-and-forget PUT to update `current_step`
3. **Add** `fetchProgress(participantId, studyId)` → GET progress, return `{ current_step, responses, flags }`
4. **Update** `saveFeature()` to post to a features-specific endpoint (or keep generic — features go into `features` table server-side)

---

## Phase 4: study-flow.js Integration

**File:** `js/study-flow.js`

1. On step completion, call `syncStep(stepIndex)` (fire-and-forget)
2. On page load (after participant ID known), call `fetchProgress()` and use `Math.max(localStep, serverStep)` to determine where to resume
3. Save survey answers to D1 as they're completed (already partially works via `saveResponse`)

---

## Phase 5: Admin Step Navigation UI ✅ DONE

**File:** `study.html` + `js/study-flow.js`

- Left/right arrow buttons + step label in header bar
- Only visible in admin/test/preview mode
- Back button: re-run previous step
- Forward button: skip to next step
- Step label shows current step name from study config

---

## Order of Operations

1. Write migration SQL → run via `wrangler d1 execute`
2. Update worker endpoints → deploy with `wrangler deploy`
3. Update `d1-sync.js` with new functions
4. Wire into `study-flow.js`
5. ~~Add admin step nav UI~~ ✅
6. Test end-to-end (test mode → registration → analysis → survey → complete)

---

## Implementation Notes (2026-03-12)

### Status: Phases 1-4 Complete

All four phases were already implemented in the codebase prior to this branch. This branch adds the missing `step_history` column to the SQL migration and creates the canonical migration file.

### What was done

**Phase 1 — SQL Migration:**
- Created `cloudflare-worker/migrations/0001_restructure.sql` with DROP of old tables (`data_study`, `data_test`, `data_preview`) and CREATE of `participants` + `features` tables
- Added `step_history TEXT DEFAULT '[]'` column to `participants` — this was missing from the existing `0001_restructure_tables.sql` but is referenced by the worker's PUT `/step` endpoint (`json_insert(step_history, ...)`)
- Updated existing `0001_restructure_tables.sql` to also include `step_history`
- Run via: `wrangler d1 execute <DB_NAME> --file=cloudflare-worker/migrations/0001_restructure.sql`

**Phase 2 — Worker endpoints (already implemented in `cloudflare-worker/src/index.js`):**
- `POST /api/study/:studyId/participants` — UPSERT into participants table
- `POST /api/study/:studyId/responses` — routes to `features` table (type=feature), `participants.completed_at` (type=milestone+completed), or `participants.responses` JSON (surveys)
- `GET /api/study/:studyId/participants/:pid/progress` — returns `current_step`, `responses`, `flags`, `step_history`, `completed_at`
- `PUT /api/study/:studyId/participants/:pid/step` — updates `current_step` and appends to `step_history`
- `GET /api/study/:studyId/participants/:pid/features` — returns all features for a participant
- Mode detection via participant ID prefix (`Preview_`, `TEST_`, or live)

**Phase 3 — Frontend d1-sync.js (already implemented):**
- `d1Put()` — PUT wrapper with offline queue
- `d1Get()` — GET wrapper
- `syncStep(step)` — fire-and-forget PUT to update `current_step`
- `fetchProgress()` — GET progress, returns `{ current_step, responses, flags, step_history, completed_at }`
- `fetchFeatures()` — GET all features for a participant

**Phase 4 — study-flow.js integration (already implemented):**
- `saveProgress()` calls `syncStep(currentStepIndex)` on every step transition
- `init()` calls `fetchProgress()` and uses `Math.max(localStep, serverStep)` to resume
- Survey answers saved via `saveSurveyAnswer()` → D1 on each answer
- Features saved via `saveFeature()` at analysis step completion
- `markComplete()` called on study completion

### Files changed
- `cloudflare-worker/migrations/0001_restructure.sql` — **NEW** canonical migration file with `step_history`
- `cloudflare-worker/migrations/0001_restructure_tables.sql` — added missing `step_history` column
- `docs/d1-restructuring-plan.md` — this section

### Notes for review
- The `step_history` column stores a JSON array of `{ step, completed_at }` entries, appended via SQLite `json_insert(step_history, '$[#]', ...)`
- Both migration files are now in sync; use whichever naming convention you prefer
- All existing worker endpoints, d1-sync.js functions, and study-flow.js integration were already in place — this branch just fixes the schema gap
