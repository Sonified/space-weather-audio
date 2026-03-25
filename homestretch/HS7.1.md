# HS7.1 — Study Launch Testing

> **SHIP_IT.md:** Test study launch functionality ⏱ ~1 hr

> Comprehensive end-to-end testing checklist for the EMIC Wave Analysis Study.

---

## 1. Architecture Overview

### Complete Study Launch Flow

```
Study Builder (study-builder.html)
  │
  ├── Configure: steps, conditions, randomization, app settings
  ├── Test Mode: toggleTestMode() → generates block table → POST /api/study/:id/session/start (mode=test)
  └── Launch (Go Live): launchStudy() → generates block table → POST /api/study/:id/session/start (mode=live)
        └── Snapshots config to R2 via POST /api/study/:id/snapshot
  │
  ▼
Participant loads study.html?study=SLUG (&mode=test|preview or no param for live)
  │
  ├── study-flow.js init()
  │     ├── Fetch config from D1 (GET /api/study/:id/config)
  │     ├── Detect mode: preview / test / live
  │     ├── Restore progress (localStorage + D1 reconciliation)
  │     ├── Early registration (auto-skip path)
  │     ├── Condition assignment (load saved or POST /api/study/:id/assign)
  │     ├── Apply condition order (swap analysis steps if needed)
  │     ├── Init data preload queue
  │     └── runCurrentStep() — walks through config.steps[]
  │
  ├── Step types: registration → modal/info → analysis → questions → analysis → questions → info (completion)
  │
  └── On completion: markComplete() → stopHeartbeat() → clear localStorage
```

### Data Flow

| Action | Client | Server |
|--------|--------|--------|
| Registration | `storeParticipantId()` → localStorage + sessionStorage | `initParticipant()` → D1 `participants` table |
| Assignment | `assignCondition()` → localStorage + sessionStorage | `POST /assign` → D1 `assignment_sessions` (optimistic concurrency) → D1 `participants.assigned_condition` |
| Heartbeat | Every N seconds while in analysis | `POST /api/study/:id/heartbeat` → D1 `participants.last_heartbeat` |
| Features | Drawn on canvas, saved on "Complete" click | `saveFeature()` → D1 `features` table |
| Survey answers | `localStorage study_answer_{slug}_{qid}` | `saveSurveyAnswer()` → D1 `participants.responses` |
| Completion | `markComplete()` | D1 `participants.completed_at` |

---

## 2. Modes and Their Differences

### Preview Mode (`?mode=preview`)
- **Participant ID prefix:** `PREVIEW_`
- **Data persistence:** None — server silently drops data for PREVIEW_ participants
- **Assignment:** Skipped entirely (no server call to `/assign`)
- **Progress persistence:** None — `localStorage` progress NOT saved; always starts fresh
- **Purpose:** Visual walkthrough of the study flow from the builder
- **UI indicators:** Blue "🔍 Preview Mode" banner, `[Preview]` in tab title, eye favicon
- **Step navigation:** Admin step nav (◀/▶) shown for jumping between steps
- **Live reload:** Listens for `storage` events from builder for real-time step updates

### Test Mode (`?mode=test`)
- **Participant ID prefix:** `TEST_`
- **Data persistence:** Full — all data saved to D1/R2 but flagged with TEST_ prefix
- **Assignment:** Full server-side assignment via `/assign` endpoint
- **Session:** Requires active TEST session (created by builder's "Test" button via `POST /session/start` with `mode=test`)
- **Progress persistence:** Yes — survives page reload; cleared on first entry or `&reset`
- **Purpose:** End-to-end testing with real data flow; data can be filtered/deleted later
- **UI indicators:** `[Test]` in tab title, yellow test hints on registration
- **Special behavior:** If a TEST_ participant hits a LIVE session, they get condition 0 (bypass) — won't burn a block slot

### Live Mode (no mode param, or `?mode=live`)
- **Participant ID prefix:** `P_`
- **Data persistence:** Full production data
- **Assignment:** Full server-side assignment via `/assign` endpoint
- **Session:** Requires active LIVE session (created by builder's "🚀 Launch Study" button via `POST /session/start` with `mode=live`)
- **Progress persistence:** Yes — localStorage + D1 reconciliation for cross-device resume
- **Purpose:** Real study participants
- **UI indicators:** None (clean participant experience)

### Reset Flag (`&reset`)
- Clears participant ID, progress, condition, and all saved survey answers
- Works with any mode
- Adds ♻️ prefix to page title

---

## 3. Session Management (Builder Side)

### Test Session
1. Click "🧪 Test" button in Study Launch panel
2. `toggleTestMode()` → `generateAndUploadAssignmentState('test')`
3. Generates block table: `numBlocks × numConditions` shuffled blocks
4. `POST /api/study/:slug/session/start` with `mode=test` → creates `TEST_slug_YYYYMMDD_HHMM_XXXXX` session
5. Any previous active session is auto-ended
6. Dashboard polls begin (participant counts, block state, heartbeats)

### Live Session
1. Click "🚀 Launch Study" button
2. Pre-flight checks: conditions exist, randomization method set
3. Confirmation modal with summary (conditions, method, blocks, timing)
4. `generateAndUploadAssignmentState('live')` → same block table generation
5. `POST /session/start` with `mode=live` → creates `STUDY_slug_YYYYMMDD_HHMM_XXXXX` session
6. Config snapshot saved to R2 (`POST /snapshot`)
7. Study name and URL tag locked (disabled)
8. Dashboard polling begins

### Assignment Algorithm (Server-Side)
- **Block assignment:** Sequential walk through pre-shuffled blocks. Each block has `numConditions` slots.
- **Healing block:** Same walk + heal rounds. At heal boundary (`nextHealAt`), checks `blockIncomplete` for dropout slots. Heal queue sorted by `healPriority` (fifo, random, fifo-height, random-height). Uses optimistic concurrency (retry loop up to 10 attempts) for simultaneous participants.
- **Dropout detection:** On each `/assign` call, queries D1 for participants with `completed_at IS NULL` and `updated_at` older than `dropoutTimeoutMin`. Adds their conditions to `blockIncomplete` for healing.

---

## 4. Step-by-Step Testing Checklist

### Phase 1: Pre-Launch Setup
- [ ] Study config saved in builder (all steps, conditions, randomization settings)
- [ ] At least 2 experimental conditions defined
- [ ] Randomization method selected (block or healingBlock)
- [ ] Block count configured (e.g., 100)
- [ ] Analysis steps have spacecraft, date range, data source configured
- [ ] Post-analysis questions configured
- [ ] App settings configured (data source, rendering, etc.)

### Phase 2: Test Session Launch
- [ ] Click "🧪 Test" in builder → verify console shows block table generation
- [ ] Verify `POST /session/start` succeeds → session ID in console
- [ ] Builder dashboard appears and shows 0/0/0 metrics
- [ ] Verify session exists: `curl "https://spaceweather.now.audio/api/study/SLUG/sessions"`

### Phase 3: Registration (Test Participant)
- [ ] Open `study.html?study=SLUG&mode=test` in new tab
- [ ] Verify `[Test]` appears in tab title
- [ ] Console shows `🟡 ... | TEST mode`
- [ ] Registration modal appears with TEST_ pre-filled ID
- [ ] Submit → participant ID stored in sessionStorage + localStorage
- [ ] Verify participant created in D1: `curl "https://spaceweather.now.audio/api/study/SLUG/participants"`
- [ ] Participant ID displayed in corner (if configured)

### Phase 4: Condition Assignment
- [ ] After registration, console shows `[ASSIGN] → Requesting server-side assignment`
- [ ] Server returns condition index, order, processing algorithms
- [ ] Console shows `[ASSIGN] ✅ Condition #N`
- [ ] Condition saved to both sessionStorage and localStorage
- [ ] Builder dashboard updates: totalStarted increments
- [ ] If condition order is [1,0], analysis steps should be swapped

### Phase 5: Welcome/Info Modals
- [ ] Info modals display correctly (title, body, styling)
- [ ] Dismiss button advances to next step
- [ ] Enter key works for confirmation (if `enterConfirms !== false`)
- [ ] Crossfade animation between consecutive modals

### Phase 6: Analysis Section 1
- [ ] Overlay fades out, revealing spectrogram/waveform
- [ ] Data loads for correct spacecraft/date range
- [ ] Correct processing algorithm applied (resample/paul/wavelet per condition)
- [ ] Status text prompts appear per config (onLoad, onPlay, onFeatureDraw)
- [ ] Drawing features works — feature boxes appear
- [ ] Complete button starts greyed out, fades to blue after first feature
- [ ] Complete button disabled if all features deleted
- [ ] Clicking Complete with features → confirmation modal (if configured)
- [ ] "Go back" returns to analysis; "Yes I'm done" advances
- [ ] Features saved to D1 on confirmation
- [ ] Heartbeat visible in builder dashboard (active participant count)

### Phase 7: Post-Analysis 1 Questions
- [ ] Overlay returns, questionnaire modals appear
- [ ] Radio questions: Next disabled until selection made
- [ ] Likert questions: Next disabled until all rows answered
- [ ] Free text questions: Next disabled until text entered (if required)
- [ ] Back button works (returns to previous question)
- [ ] Answers saved to localStorage and D1
- [ ] Progress bar updates correctly

### Phase 8: Analysis Section 2
- [ ] New data loads (different spacecraft/date range per config)
- [ ] Different processing algorithm if condition specifies it
- [ ] Feature drawing works independently of section 1
- [ ] `window.__currentAnalysisSession` = 2
- [ ] ⚠️ **Known bug (HS22):** Completion flag may carry over from section 1 — verify Complete button requires new features

### Phase 9: Post-Analysis 2 Questions
- [ ] Same questionnaire flow as Phase 7
- [ ] Different question IDs (answers stored separately)

### Phase 10: Completion
- [ ] Final info modal displays (e.g., "Thank you" / "Complete")
- [ ] `onStudyComplete()` fires:
  - `stopHeartbeat()` called
  - `markComplete()` called → D1 `completed_at` set
  - localStorage progress cleared
  - Step flags cleared
  - Saved answers cleaned up
- [ ] Builder dashboard: completedCount increments
- [ ] Verify in D1: participant has `completed_at` timestamp

### Phase 11: Data Submission Verification
- [ ] Open data-viewer.html for the study
- [ ] Participant appears in list with TEST_ prefix
- [ ] Responses render correctly (not `[object Object]` — ⚠️ see HS23)
- [ ] Features appear with correct analysis_session (1 or 2)
- [ ] Feature metadata: start/end time, low/high freq, confidence, notes, speed_factor
- [ ] Condition assignment visible (condition index, mode, block)

---

## 5. Edge Cases to Test

### Dropout & Resume
- [ ] Close browser mid-analysis → reopen same URL → should resume at correct step
- [ ] Progress reconciliation: localStorage vs D1 (takes the higher step)
- [ ] Returning participant config: `defaultBehavior` = 'beginning' vs 'resume'
- [ ] Welcome-back modal appears for returning participants at analysis steps
- [ ] Condition preserved across sessions (sessionStorage → localStorage fallback)

### Healing Block Algorithm
- [ ] Start participant, abandon mid-analysis → wait for `dropoutTimeoutMin`
- [ ] Next participant's `/assign` should detect dropout and add to heal queue
- [ ] Verify healing assignment: console shows `assignmentMode: 'heal'`
- [ ] After heal round, walk resumes at correct position

### Multiple Simultaneous Participants
- [ ] Open 3+ tabs with `?mode=test&reset` — each gets unique TEST_ ID
- [ ] Each gets different condition assignment (block rotation)
- [ ] Builder dashboard shows correct active count
- [ ] Optimistic concurrency: no duplicate condition assignments (retry loop handles races)

### Cross-Tab Isolation
- [ ] Condition stored in sessionStorage (per-tab) — two tabs can have different conditions
- [ ] After reset, localStorage is untrusted (`_condition_reset` flag in sessionStorage)

### Test Participant in Live Session
- [ ] Start a live session, then open with `?mode=test`
- [ ] Should get condition 0 with `assignmentMode: 'test_in_live'` — does NOT consume a block slot

### No Active Session
- [ ] Load study with no session running → `/assign` returns `noSession: true`
- [ ] Flow continues with default order (no condition), console warns

### Preview Mode Isolation
- [ ] Preview never calls `/assign`
- [ ] Preview never saves progress to localStorage
- [ ] Preview can jump to any step via `?step=N`
- [ ] Builder live-reload updates reflected immediately in preview

---

## 6. Data Viewer Verification

After a complete test run, verify in `data-viewer.html`:

| Check | How |
|-------|-----|
| Participant listed | Filter by session ID; TEST_ participants appear |
| Condition assigned | `assigned_condition`, `assignment_mode`, `assigned_block` columns |
| Responses complete | All question IDs have answers; rendered as `{number} - {label}` (⚠️ HS23 may show `[object Object]`) |
| Features present | Section 1 and Section 2 features listed with correct `analysis_session` |
| Feature details | Each feature has: start_time, end_time, low_freq, high_freq, confidence, notes |
| Timestamps | `created_at`, `assigned_at`, `completed_at` all present and ordered |
| Step history | `step_history` JSON array shows progression through steps |
| Heartbeat trail | `last_heartbeat` timestamp recent (within analysis duration) |
| Batch download | Download all data for the test session → CSV/JSON contains all above |

### API Spot Checks
```bash
# List participants for a specific session
curl -s "https://spaceweather.now.audio/api/study/SLUG/participants?session=TEST_SLUG_..." | python3 -m json.tool

# Check dashboard state
curl -s "https://spaceweather.now.audio/api/study/SLUG/dashboard?timeout=10" | python3 -m json.tool

# List all sessions
curl -s "https://spaceweather.now.audio/api/study/SLUG/sessions" | python3 -m json.tool

# Check snapshots
curl -s "https://spaceweather.now.audio/api/study/SLUG/snapshot" | python3 -m json.tool
```

---

## 7. Resetting / Cleaning Test Data

### Quick Reset (Single Participant)
- Append `&reset` to study URL — clears that participant's local state
- Does NOT delete server-side data

### End Test Session (Builder)
- Click "🧪 Test" button again (toggles off) → `POST /session/end`
- Ends the active test session; no new assignments will be made
- Existing test data remains in D1

### Clean Server Data (D1)
```bash
# Delete all TEST_ participants for a study
npx wrangler@4 d1 execute study-db --remote \
  --command "DELETE FROM participants WHERE study_id = 'SLUG' AND participant_id LIKE 'TEST_%'"

# Delete all features from TEST_ participants
npx wrangler@4 d1 execute study-db --remote \
  --command "DELETE FROM features WHERE study_id = 'SLUG' AND participant_id LIKE 'TEST_%'"

# Delete test sessions
npx wrangler@4 d1 execute study-db --remote \
  --command "DELETE FROM assignment_sessions WHERE study_id = 'SLUG' AND mode = 'test'"

# Nuclear: delete ALL participants and features for a study (preserves study config)
npx wrangler@4 d1 execute study-db --remote \
  --command "DELETE FROM features WHERE study_id = 'SLUG'; DELETE FROM participants WHERE study_id = 'SLUG'; DELETE FROM assignment_sessions WHERE study_id = 'SLUG';"
```

### Clean Local State
```javascript
// In browser console on study.html
localStorage.clear();
sessionStorage.clear();
```

---

## 8. Known Issues to Watch

| Issue | Status | Impact |
|-------|--------|--------|
| **HS22** — Analysis completion flag carries over from section 1 to section 2 | Open | Section 2 may not require features before Complete is clickable |
| **HS23** — Data viewer shows `[object Object]` for all question responses | Open | Can't verify survey answers visually in data viewer |
| **HS24** — Free response "Submit on Return" toggle missing | Open | Minor UX gap |
| **HS3.1/3.2** — Stretch mode wiring not complete | Open | Processing algorithm assignment may not audibly change playback |
| **LPI4** — Features not loaded from D1 on resume | Open | Returning participants lose drawn features (only in localStorage) |
