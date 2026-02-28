# Captain's Log — 2026-02-27

## TL;DR
Built the complete EMIC study participant flow, server integration, and debug tooling. Two rounds of deep code audits caught a showstopper crash bug in the real submission path. All code is syntax-verified and ready for browser testing. Git push blocked by Xcode license.

---

## What Was Built Today

### 1. Simulate Flow (`js/emic-simulate-flow.js` — NEW, ~860 lines)
Complete 8-step walkthrough of the EMIC participant experience:

**Login → Welcome → Draw Features → Complete → Confirm → Questionnaire Intro → 5 Questionnaires → Submission Complete**

Key design decisions:
- **Test users**: Creates `{username}_TEST1`, `_TEST2` etc. instead of clearing features (no exported clear function exists — features are canvas-drawn). Test user naturally has zero regions.
- **Overlay monkey-patch**: Patches `modalManager.closeModal` during flow to force `keepOverlay:true`, keeping dark backdrop persistent across all modal transitions.
- **Cancel button**: Replaces "Simulate Flow" button with red "Cancel" during flow. Auto-switches display mode to Participant View, restores on cancel/complete.
- **Silent data fetch**: Triggers `startBtn.click()` + enables silentDownload/autoDownload during welcome modal so data loads in background.
- **Server upload**: Calls shared `uploadEmicSubmission()` after localStorage save.
- **Flags**: Sets 11 EMIC flags at each step for state tracking.

### 2. Server Integration (Cloudflare Worker — DEPLOYED)
Four new endpoints in `worker/src/index.js`, using `EMIC_DATA` R2 bucket:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/emic/participants/:id/submit` | Save submission (individual + master) |
| GET | `/api/emic/participants` | List all (from master) |
| GET | `/api/emic/participants/:id` | All submissions for one participant |
| GET | `/api/emic/participants/_master.json` | Raw master download |

- **Master JSON stores FULL submission data** (not summaries) — Robert's explicit requirement
- Individual files are append-only audit trail: `emic/participants/{id}/submission_{timestamp}.json`
- Route order: `_master.json` exact match before `:id` catch-all
- Shared upload function: `uploadEmicSubmission()` in `js/data-uploader.js` (used by both simulate flow and real study path)

### 3. EMIC Study Flags (`js/emic-study-flags.js` — NEW)
11 localStorage flags tracking participant progress:
```
is_simulating, has_registered, has_closed_welcome, active_feature_count,
has_completed_analysis, has_submitted, has_submitted_background,
has_submitted_data_analysis, has_submitted_musical, has_submitted_referral,
has_submitted_feedback
```
- **Event-driven**: All setters dispatch `CustomEvent('emic-flag-change')` — no polling
- **Debug panel**: Interactive checkboxes in UI (Show Flags button), toggle any flag to simulate states
- **Wired into**: simulate flow, ui-controls (registration, welcome), main.js (questionnaire submits), region-tracker (feature count)

### 4. Real Study Submission Path Fixed
`checkAndSubmitIfComplete()` in `ui-controls.js` had a **crash bug**: referenced `jsonDump` which was defined in a different function (`attemptSubmission`). This meant real participant R2 uploads silently failed every time (caught by try/catch, logged as warning).

**Fixed by**: Building features directly from `getCurrentRegions()` and questionnaires from `combinedResponses` — both available in scope. Also includes `qualtricsResponseId` and `sessionState.startedAt`.

---

## Audit Findings (Two Rounds, All Fixed)

### Round 1 — Single-file issues
| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 6 | 🔴 | Upload failures silently swallowed (dead catch block) | Check `result.status` instead of try/catch |
| 3 | 🟡 | ~1.5s delay in questionnaire transitions | `__overlay_active__` sentinel + fast path in openModal |
| 4 | 🟡 | Cancel leaves dangling promises | Resolve `_closeResolver(false)` on all modals |
| 10 | 🟡 | Feature count flag never updated | Added `updateActiveFeatureCount()` in polling interval |
| 8 | 🟢 | innerHTML with localStorage values | Resolved by checkbox rewrite (createElement) |
| 9 | 🟢 | Flags polling never stops if panel removed | Auto-stop guard (then replaced with events entirely) |

### Round 2 — Cross-module integration
| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 3 | 🔴 | **`jsonDump` undefined — real R2 uploads crash** | Rebuilt from in-scope data |
| 1 | 🔴 | Real submissions send empty questionnaires `{}` | Extract from `combinedResponses` |
| 2 | 🔴 | Feature schema mismatch (real vs simulation) | Uniform `{index, timeRange, freqRange, drawnAt}` |
| 4 | 🟡 | Feature count fallback `||1` vs `||0` | Standardized to `||0` |
| 6 | 🟡 | Dynamic import in hot path (`setCurrentRegions`) | Cached module reference |

---

## All Modified Files (NOT pushed — git blocked)

| File | Changes |
|------|---------|
| `js/emic-simulate-flow.js` | **NEW** — 860 lines, full simulate flow |
| `js/emic-study-flags.js` | **NEW** — 11 flags, event dispatch, debug panel |
| `js/modal-manager.js` | `__overlay_active__` sentinel, fast-path openModal |
| `js/region-tracker.js` | Cached emic flags module, feature count `||0`, EMIC hook in `setCurrentRegions` |
| `js/data-uploader.js` | Added `uploadEmicSubmission()` shared function |
| `js/ui-controls.js` | Real EMIC upload fix, EMIC flags wiring (registration, welcome) |
| `js/main.js` | autoDownload checkbox, EMIC questionnaire flag setters |
| `emic_study.html` | Simulate Flow + Show Flags buttons, flags panel, script imports |
| `worker/src/index.js` | 4 EMIC endpoints, EMIC_DATA bucket — **DEPLOYED** |

---

## What's Next (When Robert Is at Computer)

---

## CRITICAL: Feature Tracking Architecture

**The region workflow (`getCurrentRegions()`) is DEAD CODE.** Do not use it for feature counting or data collection.

In EMIC study mode (windowed), participants draw features directly onto the spectrogram canvas. These are tracked as **standalone features** in `region-tracker.js`:

- `getStandaloneFeatures()` — returns the actual feature array (EXPORTED)
- `addStandaloneFeature(data)` — adds a feature (internal, called by spectrogram drawing)
- `deleteStandaloneFeature(index)` — removes by index (EXPORTED)
- `saveStandaloneFeatures()` — persists to localStorage keyed by spacecraft+user (EXPORTED)
- Storage key: `{storageKey}_standalone`
- `updateStandaloneFeatureCount()` — fires EMIC flag update with `standaloneFeatures.length`

**The simulate flow's Complete button is broken** because `countFeatures()` in `emic-simulate-flow.js` calls `getCurrentRegions()` (dead code) instead of `getStandaloneFeatures()`. The button never appears because regions are always empty.

**To fix:**
1. Import `getStandaloneFeatures` from `region-tracker.js`
2. Replace `countFeatures()` to use `getStandaloneFeatures().length`
3. Update `buildSubmissionData()` to build features from standalone features, not regions
4. Same fix needed in `ui-controls.js` `checkAndSubmitIfComplete()` — the EMIC upload block currently calls `getCurrentRegions()` which will also return nothing

**The `setCurrentRegions()` hook** that updates `ACTIVE_FEATURE_COUNT` via EMIC flags is also on the wrong data source — but `updateStandaloneFeatureCount()` already exists and correctly updates the flag from standalone features. So the flag system works, but `countFeatures()` in simulate flow bypasses it.

### Must do:
1. **Fix `countFeatures()` + `buildSubmissionData()`** — switch from `getCurrentRegions()` to `getStandaloneFeatures()` in both `emic-simulate-flow.js` and `ui-controls.js` EMIC upload block
2. **`sudo xcodebuild -license accept`** — unblocks git (only git on machine is Xcode shim)
3. **Git commit + push** all changes
4. **Browser test** the simulate flow end-to-end (nothing has been visually tested yet)
5. **Clear test data** from EMIC_DATA R2 master before real study launch

### Known accepted limitations:
- Test username generation checks localStorage not server (fine for <20 users)
- R2 master JSON has no atomic read-modify-write (individual files are safety net)
- `sanitizeUsername` strips non-alphanumeric chars (e.g., `user@email.com` → `user_email_com`)
- No auth on EMIC submit endpoint (acceptable for <20 participants)

### Stretch:
- Wire `tools.exec.ask: "on-miss"` with safeBins for routine commands
- Sub-agent lockdown: `tools.subagents.tools.deny: ["exec", "message", "gateway", "cron"]`
- Disable AirPlay Receiver, fix Tailscale config mismatch
