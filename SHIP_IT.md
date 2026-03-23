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

#### 🎧 Listening & Content (you + headphones)
- [x] **HS1.** Tune wavelet + Paul stretch params ✅
  - ✅ Paul stretch confirmed: window size 1024
  - ✅ Wavelet CWT: w0=10, dj=0.125, phase=unwrapped (pitch-accurate), interp=cubic (Catmull-Rom)
  - ✅ Gain curve pipeline: piecewise linear envelope in `gain_curves.json`, applied post-detrend pre-normalize
  - ✅ RMS matched between regions within 0.02%
- [x] **HS43.** De-trended audio in study flow ✅
  - ✅ De-trend toggle wired in study builder (HS39), auto-applies on fetch, persists across sessions
  - ✅ End-to-end tested — de-trended audio plays correctly through all 12 conditions

#### 🌊 Pre-rendered wavelet audio pipeline
> **Key insight:** Wavelet-stretched audio is ~4 MB per file. Pre-render locally via `stretch_test.html`, upload to R2, serve to participants. No WebGPU needed on client. Paul stretch remains real-time in the worklet — only wavelet needs pre-rendering.

- [x] **HS44.** Generate pre-rendered wavelet-stretched audio for all study conditions ✅
  - ✅ Gain-curved, de-trended, peak-normalized WAVs (16-bit PCM, 44100 Hz, ~4 MB each)
  - ✅ Pipeline matches app exactly: raw → removeDCOffset → applyGainCurve → peakNormalize → CWT
  - ✅ `spike_review.html` gain envelope editor for tuning curves
  - ✅ `process_gain_curves.js` Node script for reproducible WAV generation
- [x] **HS45.** Wire pre-rendered wavelet audio into study flow ✅
  - ✅ Uploaded to R2: `emic-data/audio/GOES_REGION_{1,2}_speed_cwt_1.25x.wav`
  - ✅ Study builder toggles: `gainCurve` + `vizGainCurve` in Playback & Presentation panel
  - ✅ Default wavelet audio map + speed in study-flow.js, R2 fetch + IndexedDB cache
  - ✅ Client: fetch WAV → decodeAudioData → load into wavelet worklet, bypass GPU CWT
  - ✅ Speed metadata (1.25x) for playhead math via `waveletBakedSpeed`
  - ✅ All 12 conditions verified end-to-end with correct stretch types
- [x] ~~**HS26-29.**~~ Client-side GPU wavelet stretch — superseded by pre-rendered approach
  - Streaming prototype complete in `stretch_test.html` (kept as rendering tool + future portal feature)

#### 🔌 Wiring & Integration
- [x] **HS3.1.** Wire stretch algorithm assignment from randomized conditions ✅ (remaining work merged into HS45)
  - ✅ Playback speed done — `step.playbackSpeed` applied in study-flow.js + feature-viewer.js
  - ✅ Global speed toggle in study builder syncs to all per-card inputs
  - ✅ `_assignedProcessing` routing → covered by HS45 (wavelet → R2 fetch, Paul → real-time worklet)
- [x] **HS39.** De-trend toggle in study builder Data Playback panel ✅
  - Toggle in Data Playback panel, saved in `experimentalDesign.detrend`
  - Applied on analysis start via `applyAnalysisConfig()`, consolidated duplicate checkboxes to single `removeDCOffset`
  - Preload computes pyramid from de-trended buffer (skips redundant rebuild)

#### 📊 Spectrogram visual tuning
- [x] **HS40.** Spectrogram gain & contrast sliders ✅
- [x] **HS41.** Auto-gain normalization system ✅
  - Dropdown: **None / Outliers / RMS / Both**
  - Piggybacks on FFT pass — minimal overhead
  - Config option in study builder Data Playback panel

#### ✅ Verification
- [x] **HS3.2a.** Verify correct data (dates/spacecraft) per condition ✅
- [x] **HS3.2b.** Verify correct stretch algorithm per condition ✅
  - ✅ All 12 conditions tested end-to-end — stretch types and region orders match study config
  - ~~**BUG A — Spectrogram not de-trended on first load:**~~ ✅ Fixed
  - ~~**BUG B — Paul stretch wrong audio on section 2:**~~ ✅ Fixed
  - **BUG C — Double engage/register in section 2:** `switchStretchAlgorithm('paul')` and `pyramid-ready` listener each fire twice for step 5. Something in the analysis setup path is double-triggering. (moved to LPI)
- [x] **HS46.** Condition preview buttons + delete guard ✅
  - Preview 👁 button per condition row (hover-only, opens study in preview mode with `?condition=N`)
  - `?condition=N` URL param parsed in study-flow.js — forces condition client-side, no server call
  - Delete × now requires confirmation dialog
  - Fixed toggle jump on reload (CSS `no-transition` class + cached participant counts)

#### 🎵 Completed stretch work
- [x] **HS30.** Fixed at 1.25x speed ✅
- [x] **HS31.** Spectrogram lock to 1x view ✅
- [x] **HS37.** Global speed toggle ✅

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
- [x] **HS38.** D1 read optimization — If-Modified-Since polling + background tab pause ✅
  - Server: `touchStudy()` bumps `studies.updated_at` on all write endpoints; `/participants` and `/dashboard` return 304 if unchanged (1 row read vs full JOIN)
  - Client: `If-Modified-Since` header on all polls, `visibilitychange` pauses polling when tab hidden
  - Client heartbeat disabled (`last_heartbeat` column never read)
  - Result: ~150x reduction in D1 reads (47M/day → projected <50k/day)
- [x] **HS25.** Auto-trigger GPU pyramid computation → [`homestretch/HS25.md`](homestretch/HS25.md) ✅
  - Compute pipeline runs during welcome modals: `computeSpectrogramTiles()` → FFT → tiles → pyramid cache (no display)
  - Present pipeline at analysis start: detects pre-computed tiles → viewport + waveform/minimap → instant `renderFrame()`
  - Config toggle: `experimentalDesign.preRenderPyramid` in study builder Data Playback panel
  - Cache key validation (`spacecraft:dataset:startTime:endTime`) prevents stale tiles
  - Resume/refresh: preloads current step first, pre-renders correct section (respects randomized date assignments)
  - Section 2: pre-renders during between-section modal after section 1 completes
  - Clean visual reset between sections (spectrogram, minimap, axes, feature boxes, playhead)
  - Fallback: if download still in progress or compute not done, progressive path kicks in — zero degradation

#### 👁️ Feature Viewer
- [x] **HS32.** Feature viewer section switching bug (2→1 hangs on "loading") ✅
  - Root cause: completed sessions had processedChunks nulled by onComplete cleanup, reuse replayed empty data
  - Fix: detect freed sessions, create fresh ones from IndexedDB cache; added #dataSource/#dataRendering, try-catch, progressive re-force, read-only feature boxes
- [x] **HS33.** Feature viewer participant dropdown ✅
  - Dropdown in header, populated from `/api/study/:id/participants`, navigates via URL
  - Per-participant session data fetch from `/data` endpoint (respects condition ordering)
  - Persistent annotations default, animated details open/close, brighter detail text

#### 🧭 Study Builder Navigation
- [x] **HS34.** Recently viewed studies dropdown ✅
  - Custom dropdown replacing native select, recency-sorted with participant counts + relative timestamps
  - History tracking in localStorage (capped at 20), counts fetched from `/api/studies`
- [x] **HS36.** Switching studies must update full UI state ✅
- [x] **HS35.** "New Study" flow (Start Fresh / Clone / Template) ✅
  - File menu: Create New, Duplicate Current, Delete This Study (with confirmation)
  - Header redesign: four distinct treatments (heavy picker, ghost File, accent Preview, outlined Data Viewer)
  - Panels collapse + vnav rebuilds on new/switch study. Template system deferred.
- [x] **HS42.** Save/restore study config backups to server (R2) ✅
  - File menu: Save Backup + Restore from Backup in Save section
  - R2 storage at `study_backups/{slug}/{timestamp}.json` in BUCKET binding
  - Worker endpoints: POST (save), GET (list), GET/:label (download)
  - Restore flow: list backups → pick from numbered list → confirm → load into builder

#### 🧪 Testing & tuning (~1 hr)
- [x] **HS7.1.** Test study launch functionality ✅
  - 12/12 conditions verified across test mode with forced conditions
  - All stretch types (resample, paulStretch, wavelet) × all region orders confirmed
  - Full completions with features, questionnaires, and submissions verified on server

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

#### 🎧 Stretch Test Page
- [x] **ST1.** Add GOES Region 1 & 2 audio presets (raw + detrended) to stretch_test.html ✅
- [x] **ST2.** Fix speed slider persistence across sessions (was saved but not restored) ✅

### IT'S GO TIME (IGT)

- [ ] **IGT1.** Send links to Lauren and Lucy, requesting review and feedback
  - Send stretch test page — data is loaded in, show chosen default settings
  - Study preview link for end-to-end walkthrough

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
- [ ] **LPI12.** Spectrogram sometimes flashes on load — shows, disappears, reappears during overlay-to-analysis transition
- [ ] **LPI13.** Double engage/register in section 2 — `switchStretchAlgorithm` and `pyramid-ready` listener each fire twice for step 5 (BUG C from HS3.2b)
- [ ] **LPI10.** Stretch test: changing CWT/CQT params during streaming playback layers new audio on top of old instead of crossfading — `onGPUParamChange` needs streaming-aware path
- [x] **LPI11.** Lock down conditions panel when study is live ✅
  - All condition selects, delete buttons, add/generate buttons disabled + dimmed when live
  - Preview buttons remain clickable
  - Unlocks automatically when study ends (or on resetLiveModeUI)
  - Follows existing lock pattern (study name, URL tag, timing controls)

---

**Total estimated time: ~10-14 hrs**
**Total elapsed time: 0 hrs**
