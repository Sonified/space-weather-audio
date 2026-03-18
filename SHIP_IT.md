# 🦋 SHIP IT — Coaching Frame for the Home Stretch

> **Note:** `emic_study.html` is a relic and is no longer actively updated. `study.html` is the canonical study page — all fixes go there.

**Purpose:** Keep us on track. When context compresses or a new session starts, re-read this file. It's the compass.

## The Goal
Get the EMIC study tool into collaborators' hands TODAY so they can step through the full interface and give feedback. That's it. Everything serves this or it waits.

## The Trap
The randomization simulator (`randomization-sim.html`) is a beautiful deep dive. The algorithm is solid. The urge to "just optimize one more thing" is real and it feels productive, but it's polish on polish. The sim is a design tool for US, not something collaborators need to test. If the conversation drifts toward tweaking the heal algorithm, tuning dropout curves, or adding features to the horse race — NAME IT. Say: "That's the sim rabbit hole. Is this needed to ship today?"

## The Frame
This isn't about saying no to fun. It's about sequencing. The paper is next, and it's going to be exciting and career-building. But we can't shift into that gear while the study tool is still in "almost ready" limbo. Ship the tool → get feedback rolling → start the paper. That's the sequence.

## How to Coach
- When the user returns, they may want to test "one small change" to the randomization. Gently redirect: "Is this needed for the collaborator link, or is this sim polish?"
- Help assess what's shippable vs what's infrastructure we build after feedback
- Stay energetic and collaborative — this is a sprint to the finish line, not a chore
- Parallel agents for independent tasks. Move fast.
- Don't generate assessments or plans unprompted. Work WITH the human. They drive.

## Re-read Trigger
If you ever consolidate memory or start a fresh session on this project, re-read this file before doing anything else. Check: are we shipping, or are we drifting?

## Status
- [x] Assess together what needs to work for the collaborator share
- [ ] Decide: full study flow vs "play with the tool, infrastructure coming next"
- [ ] Do the work
- [ ] Share the link
- [ ] Shift gears to the paper 📝

---

## Ship List

### QUICK FIXES (do first, minimal investigation)

- [x] **Q1.** Hide x-axis bar items (Annotations, FFT, Color Map, Frequency Scale) on all spaceweather.now.audio deployments (#4)
- [x] **Q2.** Remove "Audio playback paused" text (#7)
- [x] **Q3.** Change "WOWZA" to "Complete" at end of section 2 (#14)
- [x] **Q4.** Fix loop button showing as not-clickable (cancel cursor). Change to "Loop: Enabled" / "Loop: Disabled" with color cues (#15)
- [x] **Q5.** Make the blue Complete button fade up slower (#17)
- [x] **Q6.** Print participant username to console on every load — blue, bold, easy to spot (#18)
- [x] **Q7.** Drawing a feature to the canvas edge should clamp at edge, not disappear (#13)
  - *Fixed:* Mouse leaving canvas during draw now clamps to edges instead of canceling. Document-level listeners track mouse outside canvas with X/Y clamped to bounds. Bottom clamp set 5px above canvas edge. Removed 5-second safety timeout that was auto-canceling draws.
- [x] **Q8.** "Proceed" button should only be active when at least one feature exists (disable when all features deleted) (#5)

An

- [x] **I1.** Modal stacking bug — "Yes I'm Done" after analysis causes next modal to appear on same side, both visible. Same bug after second analysis. Post-study questions appear prematurely. (#10, #16)
- [x] **I2.** Clicking "Back" on a post-study question sometimes jumps without fade transition (#19)
- [x] **I3.** Standardize final question box sizes (#20)
- [x] **I4.** Final study page: remove close button OR make it close the actual browser tab (#21)
- [x] **I5.** Post-question 1 showing a selected answer when none was clicked — investigate state leak / stale localStorage from previous session (#18)
- [x] **I6.** Reduce vibrancy on "Yes" and "Possibly" feature card colors — less gradient, softer (#6)
- [x] **I7.** Evaluate when "press Proceed when complete" message displays — should it show more than once? (#8)

### AXIS FIXES

- [x] **A1.** Y-axis numbers on main canvas are too large on first draw (correct after subsequent redraws)
- [x] **A2.** Mini-map x-axis ticks flicker and disappear during horizontal window resize (main canvas x-axis ticks are fine)

### NEEDS COLLABORATION / INPUT

- [x] **C1.** Loading experience — title + controls fade in cleanly, no spinner needed (#1)
- [x] **C2.** Data pre-load optimization — start loading first example during welcome modals, progressive reveal when ready (#2)
- [x] **C3.** Background download of second dataset during first example + local cache for reload. Involves reviewing existing browser cache system (#3)
- [x] **C4.** Tutorial video integration + Help button placement — (i) now shows only during analysis sessions (#9)
- [x] **C5.** Feature copy/paste system — copy individual or all text prompts from top bar, hold in memory, paste with options: cancel / replace existing / add to existing (#11)
- [x] **C6.** Card duplication feature (low priority) (#12)


### HOME STRETCH

#### ⚡ Quick wins (~4-6 hrs)
- [x] **HS15.** New post-analysis question comparing audio experience + preference ⏱ ~1-2 hrs ▶️ 16:54 ✅ 17:47
- [x] **HS7.3.** Make sure test / study END bars appear correctly ⏱ ~30 min ▶️ 17:52 ⏸️ 18:52 ▶️ 20:54 ✅ 21:32
- [x] **HS9.5.** Download batch data for entire tests and study runs (use horizontal bar) ⏱ ~1 hr ✅
- [x] **HS9.4.** Option to download all data ⏱ ~1-2 hrs ▶️ 20:54 ✅ 21:32
- [x] **HS7.2.** Confirm study data presents well in data viewer ⏱ ~30 min ✅
- [x] **HS20.** Update placement of copy card info to prevent accidental clicking ⏱ ~30 min ▶️ 00:35 ✅ 00:50

#### 🎵 Stretch implementation — sequential chain
> 📄 Per-item architecture docs in `homestretch/HSxx.md` — read before starting work.

- [ ] **HS1.** Identify ideal settings for wavelet and Paul stretch algorithms → [`homestretch/HS1.md`](homestretch/HS1.md)
  - Listening/tuning task, not code — use `stretch_test.html` with GOES data
  - Determine: Paul (window size, overlap %), Wavelet (w0, dj, phase mode, interpolation)
  - Save chosen params as defaults in study config
- [ ] **HS3.1.** Wire up randomization playback settings for stretch modes + connect playback speed from study builder into the study → [`homestretch/HS3.1.md`](homestretch/HS3.1.md)
  - **Critical gap:** `playbackSpeed` from study config is never applied (~10 lines, 30 min)
  - `_assignedProcessing` works but speed is skipped in `applyAnalysisConfig()`
  - Fix in `study-flow.js` ~line 1988
- [ ] **HS3.2.** Double ensure analysis tasks appear in correct order based on condition, and correct stretch mode → [`homestretch/HS3.2.md`](homestretch/HS3.2.md)
  - Manual verification task — run through as different participants, check console `[ASSIGN]` logs
  - ~30 min

#### 🌊 Real-time client-side wavelet stretch (replaces pre-baked HS2)
- [x] **HS26.** Process wavelet stretch in chunks as data arrives ✅ DONE → [`homestretch/HS26.md`](homestretch/HS26.md)
  - `waveletStretchChunked()` in `wavelet-gpu-compute.js` — production chunked pipeline exists
- [x] **HS27.** Background render ahead of the playhead ✅ DONE → [`homestretch/HS27.md`](homestretch/HS27.md)
  - `processAndCrossfadeGPU()` + `waveletStretchAndLoad()` already handle this
- [x] **HS28.** Crossfade between chunks ✅ DONE → [`homestretch/HS28.md`](homestretch/HS28.md)
  - 150ms crossfade built into both stretch_test.html and main app
- [ ] **HS29.** Handle playhead jumps with an opacity fade while the stretch catches up → [`homestretch/HS29.md`](homestretch/HS29.md)
  - Partially done in stretch_test.html, may need wiring in main app
  - CSS opacity transition on spectrogram container, skip if cached
  - ~30 min
- [x] **HS30.** Fixed at 1.25x speed for now (the study's stretch condition)
- [ ] **HS31.** Add spectrogram shift on speed change option in Data Playback panel on study builder → [`homestretch/HS31.md`](homestretch/HS31.md)
  - New toggle in Data Playback panel + viewport scaling by speed factor
  - ~1-2 hrs, no dependencies

#### 🔨 Build tasks (~2-3 hrs)
- [x] **HS16.** Code for matching participant's audio score with processing type, time period, and order received ✅
  - Likert perception responses decoded with algorithm names (Wavelet/Paul Stretch) based on session ordering
  - Displayed as first 4 response rows in data viewer detail cards
- [x] ~~**HS9.6.** Create gitignored HTML page for nuking test and participant data on the server~~ — REMOVED, not needed

#### 🐛 Bugs & fixes
- [x] **HS22.** Reset analysis completion flag for section #2 ✅
  - Fix: per-section feature counters + cancel lingering fill:forwards animation + keep button visible between sections
- [x] **HS23.** Data viewer `[object Object]` bug ✅
  - Fix: unwrap d1-sync response envelope, render radio/likert/freetext as readable text, questions 40% with ellipsis
- [x] **HS24.** Free response "Enter confirms" toggle ✅

#### ⚡ Performance
- [ ] **HS25.** Pre-render spectrogram pyramids during welcome modals → [`homestretch/HS25.md`](homestretch/HS25.md)
  - Data preloading exists but GPU pyramid computation still triggers at analysis start
  - Suppression hooks exist: `setSuppressPyramidReady()`, `setOnTileReady(null)`
  - Hook after `data-preload-complete` event, compute tiles in background, show on analysis start
  - Only pre-render current section's tiles (not both)
  - ~2-3 days, main risk is race conditions if users click through modals fast

#### 👁️ Feature Viewer
- [x] **HS32.** Feature viewer section switching bug (2→1 hangs on "loading") ✅
  - Root cause: completed sessions had processedChunks nulled by onComplete cleanup, reuse replayed empty data
  - Fix: detect freed sessions, create fresh ones from IndexedDB cache; added #dataSource/#dataRendering, try-catch, progressive re-force, read-only feature boxes
- [ ] **HS33.** Feature viewer participant dropdown → [`homestretch/HS33.md`](homestretch/HS33.md)
  - API already exists: `GET /api/study/:id/participants` returns list with feature counts
  - Add `<select>` in header bar, populate on init, navigate via URL change on selection

#### 🧭 Study Builder Navigation
- [ ] **HS34.** Recently viewed studies dropdown → [`homestretch/HS34.md`](homestretch/HS34.md)
  - `#studyPicker` select already exists (hidden by default), populated from IndexedDB
  - Upgrade to show recent studies with last-edited timestamps
  - `GET /api/studies` already lists all studies with participant counts
- [x] **HS36.** Switching studies must update full UI state ✅
- [ ] **HS35.** "New Study" flow (Start Fresh / Clone / Template) → [`homestretch/HS35.md`](homestretch/HS35.md)
  - `saveAsToServer()` already does 90% of clone — prompts for name, generates slug, saves
  - No template concept exists yet — add `isTemplate` flag on IndexedDB configs
  - ~6-7 hrs total for both HS34+HS35

#### 🧪 Testing & tuning (~1 hr)
- [ ] **HS7.1.** Test study launch functionality ⏱ ~1 hr → [`homestretch/HS7.1.md`](homestretch/HS7.1.md)
  - 11-phase end-to-end checklist covering all 3 modes (preview/test/live)
  - Edge cases: dropout/resume, healing block, simultaneous participants
  - Data verification steps + reset procedures

#### ✅ Completed
- [x] **HS3.** Build deployment panel toward the bottom of study builder (above Data Stream) with settings like randomization for the two analysis sections
- [x] **HS4.** Add experimental conditions panel — map out each condition: which dataset, which order, which algorithm
- [x] **HS5.** Add participant randomization panel — options for random, block, and healing block. For healing block, include all settings from randomization-sim (algorithm settings only) using the preset from that page
- [x] **HS6.** Test flow on non-test pages — does it always re-start in the correct place?
- [x] **HS7.** Add study launch panel — options: start immediately, start on date/time, end date/time, or keep open-ended (figure out go-live system)
- [x] **HS8.** Option for doing a test round using data from test runs
- [x] **HS9.** Build participant data explorer page — list all participant data, view question answers + feature metadata, view responses on page, visual for the blocks. Button in study builder to launch it.
- [x] **HS9.1.** Add access protection to data explorer page (client-side admin gate)
- [x] **HS9.2.** Refine participant question/answer viewer in data explorer
- [x] **HS9.3.** Panel to launch page viewing a participant's analyses (feature-viewer.html)
- [x] **HS12.** Final polish round for self-healing block algorithm
- [x] **HS13.** Implement live simultaneous participant tracking — heartbeat system + smart timeout estimation
- [x] **HS14.** Confirm randomization-sim is correctly assigning participants end-to-end
- [x] **HS19.** Add Likert scale question type to study builder
- [x] **HS21.** Complete data format refactoring and audit — D1 schema rebuild (session_id→group_id, dead column cleanup), R2 config snapshots on launch, participant ID prefix system (P_/TEST_/PREVIEW_), verified full export pipeline end-to-end with 71-feature stress test
- ~~**HS10.** Fill blocks with randomization-sim~~
- ~~**HS11.** Test filling blocks live — hover over blocks for info, click to bring up data~~

### IT'S GO TIME (IGT)

- [ ] **IGT1.** Send links to Lauren and Lucy, requesting review and feedback

### LOW PRIORITY IMPORTANT (LPI)

- [ ] **LPI1.** Secure data API endpoints server-side — verify-admin returns HMAC-signed token, all /api/study/* routes require Bearer token, lock CORS to production domain
- [ ] **LPI4.** Load features from D1 on study page resume — returning participants get their features back cross-device, not just from localStorage
- [ ] **LPI2.** Regenerate admin key (current key is in committed JSON files in repo)
- [ ] **LPI3.** Remove or .gitignore study JSON files containing admin keys
- [ ] **LPI5.** Fix dashed border flow on "possibly" feature boxes during edge drag — dashes shift on opposite edge when resizing
- [ ] **LPI6.** Polish vnav scroll indicator — close but not perfect, edge cases with open cards and bar extremes could be tighter
- [ ] **LPI7.** Some elements still flash on study builder refresh — chevron/card state restore race condition not fully eliminated
- [ ] **LPI8.** Defensively clean study slug as it's written — sanitize special chars, emoji, spaces to prevent malformed session IDs and URLs
- [ ] **LPI9.** Confirmation modal at end of analysis section 1 was not clickable — core bug never identified

---

**Total estimated time: ~10-14 hrs**
**Total elapsed time: 0 hrs**
