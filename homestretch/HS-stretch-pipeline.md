# HS Stretch Pipeline — Corrected Investigation

> Previous investigation (19-33 hrs estimate) missed that a **working chunked wavelet stretch pipeline already exists**. This corrected investigation maps what's built, identifies actual gaps, and gives realistic estimates.

## Executive Summary

**The heavy lifting is done.** The entire GPU wavelet stretch pipeline — chunked processing, crossfade, background re-stretch — is implemented and working in both `stretch_test.html` (standalone test page) and `js/audio-player.js` (main app). The remaining work is **wiring and configuration**, not algorithm development.

**Revised total estimate: 4-8 hours** (down from 19-33)

---

## 1. What Already Exists and Works

### stretch_test.html (3544 lines) — Complete Standalone Test Page
- **7 stretch algorithms:** Resample, Spectral, Paul Stretch, Granular, CWT (Morlet Wavelet), CQT (Constant-Q), RTPGHI
- **GPU wavelet chunked processing** via `WaveletGPUCompute.waveletStretchChunked()` — auto-calculates chunk sizes for GPU memory limits
- **Crossfade between chunks** for seamless playback (150ms `CROSSFADE_DURATION`)
- **Background re-stretch** (`processAndCrossfadeGPU()`) — processes new stretch while old audio plays, then crossfades
- **Playhead tracking** with source-time position math (handles stretch factor changes mid-playback)
- **Looping, seek, pause/resume** with proper position bookkeeping
- **All parameter controls:** w0, dj, phase mode, interpolation mode, bins per octave, etc.
- **Waveform visualization** with playhead overlay
- **WAV export** of stretched audio

### js/audio-player.js — Main App Integration (Already Done!)
- **`waveletStretchAndLoad()`** (line ~450): Runs GPU stretch and loads into wavelet AudioWorklet
  - Fast path: uses cached CWT coefficients (single GPU pass)
  - Chunked fallback: auto-splits long files via `waveletStretchChunked()`
- **`waveletComputeCWT()`** (line ~420): Pre-caches CWT on GPU when audio loads
- **`primeStretchProcessors()`** (line ~575): Sends raw audio to all stretch worklets
- **`switchStretchAlgorithm(algorithm)`** (line ~811): Switches between resample/paul/granular/wavelet
- **`updatePlaybackSpeed()`** (line ~297): Handles speed changes, auto-engages stretch <1x
- **`calculateSliderForSpeed(targetSpeed)`** (line ~896): Programmatic speed setting

### js/wavelet-gpu-compute.js — GPU Engine
- **`waveletStretchChunked()`** (line ~2266): Production chunked pipeline with overlap, crossfade, progress callbacks
- **Auto chunk sizing** based on GPU memory limits
- **`stretchAudio()`**: Fast re-stretch using cached CWT coefficients
- **Normalize utility**: `WaveletGPUCompute.normalize()`

### workers/ — All 4 Stretch Worklet Processors
- `resample-stretch-processor.js` — Simple sample rate change
- `paul-stretch-processor.js` — STFT phase randomization  
- `granular-stretch-processor.js` — Granular time-stretch
- `wavelet-stretch-processor.js` — Wavelet-based playback from pre-computed buffer

### js/study-flow.js — Partial Wiring (Processing Only)
- **`PROCESSING_MAP`** (line 158): Maps builder values → audio-state: `{ resample: 'resample', paulStretch: 'paul', wavelet: 'wavelet' }`
- **`_assignedProcessing`** applied at analysis entry (line ~1988): calls `switchStretchAlgorithm(mapped)`
- **Condition assignment** (line ~302): Sets `step1._assignedProcessing` and `step2._assignedProcessing` from condition config

### study-builder.html — Config UI
- **Data Playback panel** with `pb_speed` input (line ~1754) and `stepSpeed()` function
- **Conditions panel** with task1Processing / task2Processing dropdowns
- **Per-step `playbackSpeed`** field in analysis step config (line ~4398)
- **`experimentalDesign.playbackSpeed`** exported in config (line ~4132)

---

## 2. Actual Gaps (What's Missing)

### Gap 1: Playback Speed Not Applied from Study Config
**Status:** `_assignedProcessing` is applied. **`playbackSpeed` is NOT.**

In `study-flow.js` at line ~1988, the code applies the stretch algorithm:
```js
if (step._assignedProcessing) {
    const mapped = PROCESSING_MAP[step._assignedProcessing];
    switchStretchAlgorithm(mapped);
}
```
But there's **no equivalent for speed**. The `playbackSpeed` from config/step is never wired to `audio-player.js`.

**Fix:** ~10 lines of code. After the processing block, add:
```js
const targetSpeed = parseFloat(step.playbackSpeed) || parseFloat(studyConfig.experimentalDesign?.playbackSpeed) || 1.0;
if (targetSpeed !== 1.0) {
    const { calculateSliderForSpeed, updatePlaybackSpeed } = await import('./audio-player.js');
    document.getElementById('playbackSpeed').value = calculateSliderForSpeed(targetSpeed);
    updatePlaybackSpeed();
}
```

**Estimate: 30 min** (code + test)

### Gap 2: Per-Condition Speed (Not Just Global)
**Status:** The study builder has a **global** `playbackSpeed` and **per-step** `playbackSpeed`, but conditions only map `task1Processing` / `task2Processing`. There's no `task1Speed` / `task2Speed` in the condition row.

**Question for Robert:** Does the study need per-condition speed variation, or is one speed (e.g., 1.25x) applied globally to the wavelet condition? If global, Gap 1 alone solves it.

If per-condition: Add speed columns to condition rows in study-builder.html and wire `_assignedSpeed` in study-flow.js alongside `_assignedProcessing`.

**Estimate: 1-2 hrs** if per-condition needed, **0 hrs** if global

### Gap 3: HS30 "Fixed at 1.25x" Implementation
**Status:** Marked done in SHIP_IT.md but no code enforces 1.25x. Likely this was a design decision ("we'll use 1.25x") rather than code. The actual enforcement comes from Gap 1 — setting `playbackSpeed: 1.25` in the study config and wiring it.

**Estimate: 0 hrs** (solved by Gap 1)

### Gap 4: HS31 — Spectrogram Shift on Speed Change
**Status:** No code exists for this. No UI toggle in study builder.

**What it means:** When playback speed changes (e.g., 1.25x), the spectrogram's time axis should optionally compress/expand to match the audio timing. Currently, spectrogram shows real-time data regardless of playback speed.

The spectrogram renderer already has viewport/zoom controls. The "shift" would be adjusting the time-to-pixel mapping by the speed factor.

**Implementation:** 
1. Add a toggle in the Data Playback panel of study-builder.html (~15 lines HTML)
2. Wire the setting into the study config
3. In `audio-player.js` or `main-window-renderer.js`, when speed changes and the flag is set, scale the spectrogram viewport

**Estimate: 1-2 hrs**

### Gap 5: HS1 — "Ideal Settings" for Wavelet and Paul Stretch
**Status:** This is a **listening/tuning task**, not a code task. `stretch_test.html` is literally the tool built for this — load GOES data, try different algorithms and parameters, compare results.

The settings to determine:
- **Paul Stretch:** Window size, overlap %
- **Wavelet (CWT):** w0 (morlet parameter), dj (scale resolution), phase mode, interpolation mode

**Estimate: 1-2 hrs** of listening and comparing with Robert. Then save the chosen params as defaults in the study config.

### Gap 6: HS3.2 — Verify Correct Order Based on Condition
**Status:** The condition assignment system works (`assignCondition()` in study-flow.js). Steps are reordered based on condition's presentation order. Processing is applied. Need to verify end-to-end with a test run.

**Estimate: 30 min** (manual test with different conditions)

---

## 3. Task-by-Task Revised Estimates

| Task | Description | What's Needed | Estimate |
|------|-------------|---------------|----------|
| **HS1** | Ideal stretch settings | Listening session with Robert using stretch_test.html | 1-2 hrs |
| **HS3.1** | Wire randomization playback speed | Apply `playbackSpeed` from config in study-flow.js | 30 min |
| **HS3.2** | Verify condition order + stretch mode | Manual test of condition assignment flow | 30 min |
| **HS26** | Chunked wavelet as data arrives | **Already done** — `waveletStretchChunked()` exists | 0 hrs |
| **HS27** | Background render ahead of playhead | **Already done** — `processAndCrossfadeGPU()` / `waveletStretchAndLoad()` | 0 hrs |
| **HS28** | Crossfade between chunks | **Already done** — 150ms crossfade in both test page and main app | 0 hrs |
| **HS29** | Playhead jump with opacity fade | Partially done (fade exists in stretch_test.html). May need wiring in main app | 30 min |
| **HS31** | Spectrogram shift toggle | New toggle in study builder + viewport scaling | 1-2 hrs |

**Total: 4-6 hours** (vs previous 19-33 hour estimate)

---

## 4. Fastest Path: Test Page → Study

The path is **not** "port stretch_test.html to the study app." The study app (`audio-player.js`) **already has the wavelet stretch pipeline integrated.** The path is:

1. **Wire playback speed from study config** (Gap 1) — 30 min
2. **Determine ideal parameters** (HS1) — 1-2 hrs with Robert  
3. **Test end-to-end** (HS3.2) — 30 min
4. **Add spectrogram shift toggle** (HS31) — 1-2 hrs
5. **Verify playhead jump fade** (HS29) — 30 min

### Step 6: Cache stretched audio locally
Once the wavelet stretch produces final audio buffers, cache them locally (IndexedDB or similar) keyed by dataset + time range + stretch params + speed. On subsequent plays, seeks, or page reloads, check cache first — if hit, skip the GPU stretch entirely and play from cache. This avoids re-computing on every replay and makes playhead jumps instant (no opacity fade needed if the stretched audio is already cached). Investigate what caching infrastructure the app already uses (the background-data-cache system may be adaptable).

**Estimate: 1-2 hrs** (depending on existing cache infrastructure)

That's it. The architecture is already connected:
```
study-flow.js assigns condition
  → _assignedProcessing → switchStretchAlgorithm('wavelet')
  → [NEW: _assignedSpeed → calculateSliderForSpeed(1.25) → updatePlaybackSpeed()]
    → updatePlaybackSpeed() detects speed < 1.0 or stretch algorithm
      → engageStretch() / waveletStretchAndLoad()
        → waveletGPU.waveletStretchChunked() (if needed)
        → wavelet-stretch-processor.js plays the buffer
```

---

## 5. Key Insight: Why the Previous Estimate Was So Wrong

The previous investigation treated HS26-29 as **greenfield development** — designing and building a chunked wavelet pipeline from scratch. In reality:

- `waveletStretchChunked()` in `wavelet-gpu-compute.js` is a **production-ready chunked pipeline** with auto-sizing, overlap, crossfade, and progress callbacks
- `audio-player.js` already imports and uses it via `waveletStretchAndLoad()`  
- `stretch_test.html` is a **3500-line test harness** that proves it all works
- `stretch_test_python_renders/` has **reference renders** for validation
- The 4 stretch processor worklets are all implemented and registered

The actual remaining work is configuration and wiring, not algorithm implementation.
