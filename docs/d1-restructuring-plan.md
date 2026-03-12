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
