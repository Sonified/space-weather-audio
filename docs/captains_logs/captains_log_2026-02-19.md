# Captain's Log - 2026-02-19

## EMIC Study: New Time Range + Data Pipeline + Architecture Cleanup

Official study time range received from study coordinator. Downloaded full dataset to R2 and cleaned up the config architecture.

---

## Study Time Range: August 17–24, 2022

Updated from the placeholder January 21–27, 2022 window to the official study week: **August 17–24, 2022** (7 days, chosen for strong EMIC wave activity).

End time set to `2022-08-24T00:00:00.000Z` (start of the 24th = exactly 7 days).

---

## Single Source of Truth: `window.__EMIC_CONFIG`

Previously, the EMIC study time range was scattered across 4+ locations — hardcoded in `main.js`, HTML date inputs, IndexedDB cache key, and a CDAWeb fetch call. Changing the date meant updating all of them (and missing one meant silent bugs — which is exactly what happened).

Consolidated into a single config object defined once at the top of `emic_study.html`:

```javascript
window.__EMIC_CONFIG = {
    spacecraft: 'GOES',
    dataset: 'DN_MAGN-L2-HIRES_G16',
    startTime: '2022-08-17T00:00:00.000Z',
    endTime: '2022-08-24T00:00:00.000Z'
};
```

All consumers now read from this:
- **`main.js`** — `startStreaming(e, window.__EMIC_CONFIG)` (was 6 lines of DOM reads + hardcoded fallbacks)
- **IndexedDB cache key** — `c.dataset + '_' + c.startTime + '_' + c.endTime + '_b_gse'`
- **CDAWeb post-fetch cache store** — reads spacecraft, dataset, start/end from config

Removed the hidden date picker inputs (`#startDate`, `#startTime`, `#endDate`, `#endTime`) from the EMIC study HTML — they were never visible to users and served no purpose.

### Files Changed

- `emic_study.html` — Added `window.__EMIC_CONFIG`; removed hidden date/time inputs; cache key and getAudioData call read from config
- `js/main.js` — EMIC mode fetch reads `window.__EMIC_CONFIG` instead of hardcoded dates

---

## R2 Data Download: All 8 Days Uploaded

Ran `python backend/goes_to_r2.py 2022-08-17 2022-08-24` — downloaded all 8 days (inclusive) from CDAWeb, chunked into 10m/1h/6h granularities, compressed with zstd, uploaded to R2 `emic-data` bucket.

### Results

| Day | Bx range (nT) | By range (nT) | Bz range (nT) | Fill values | Compressed size |
|-----|---------------|---------------|---------------|-------------|-----------------|
| Aug 17 | -99 to +71 | -104 to +6 | +27 to +156 | 3 (0.00%) | 23.5 MB |
| Aug 18 | -31 to +115 | -99 to +50 | +31 to +121 | 0 | 23.8 MB |
| Aug 19 | -31 to +99 | -97 to +24 | +21 to +144 | 0 | 23.8 MB |
| Aug 20 | -13 to +104 | -108 to +41 | +17 to +113 | 0 | 23.4 MB |
| Aug 21 | -20 to +81 | -86 to +22 | +19 to +108 | 0 | 23.3 MB |
| Aug 22 | -15 to +82 | -75 to +14 | +30 to +107 | 0 | 23.0 MB |
| Aug 23 | -13 to +67 | -77 to +7 | +62 to +107 | 0 | 22.8 MB |
| Aug 24 | -13 to +63 | -75 to +1 | +60 to +114 | 3 (0.00%) | 22.8 MB |

- **Total: 4,152 files, ~186 MB compressed** across 3 components × 3 chunk sizes × 8 days
- Only 6 fill values in the entire dataset — excellent data quality
- Aug 24 is an extra day (study only needs 7) — harmless, just won't be requested

### Chunk breakdown per day per component
- 10m: 144 chunks (~2.5–2.7 MB total)
- 1h: 24 chunks (~2.6–2.8 MB total)
- 6h: 4 chunks (~2.5–2.7 MB total)

---

## Playback Duration Estimates

GOES-16 magnetometer: 10 Hz instrument, CDAWeb audification at 22 kHz → 2,200× time compression.

### Full 7 days

| Speed | Duration |
|-------|----------|
| 1.0x | ~4 min 35 sec |
| 0.75x | ~6 min 7 sec |
| 0.50x | ~9 min 10 sec |

### Per-day subsets (for discrete analysis tasks)

| Days | @ 1x | @ 0.5x |
|------|------|--------|
| 3 | ~1 min 58 sec | ~3 min 55 sec |
| 4 | ~2 min 37 sec | ~5 min 14 sec |
| 5 | ~3 min 16 sec | ~6 min 33 sec |

Each second of audio ≈ 37 minutes of real magnetometer data.

---

## Study Design Discussion Notes

Thinking through options to discuss with the team next week:

**Continuous vs. discrete listening tasks:**
- One continuous 7-day stream: attention drifts, ambiguous events get skipped, primacy bias
- Seven discrete day-by-day tasks: fresh attention per day (~40 sec at 1x, ~1:20 at 0.5x), participants can replay individual days, richer per-day response data

**The learning effect:**
- Participants will self-train during listening — early markings are less informed than later ones
- Day-by-day in fixed order lets you measure the learning curve explicitly (day 1 vs day 7 accuracy)
- Randomizing day order across participants controls for both learning and event difficulty
- Quiet days provide natural controls for false positive rates

**EMIC ambiguity is the core challenge:**
- "Is this an EMIC event or too low frequency?"
- "This sounds like EMIC but does it qualify?"
- Short discrete clips encourage deliberation and replay vs. snap decisions during continuous playback

**Wavelet-stretched audio option:**
- Pre-rendered audio at 2× length: ~23 MB per component (uncompressed WAV), ~2-4 MB compressed
- Could be served as plain audio files without chunking
- Architecture decision deferred — needs team discussion on whether wavelet approach is needed

---

## Post-Study Questionnaire Modals

Added four questionnaire modals for the EMIC study, accessible from a new "Questionnaires" panel bar below the main visualization.

### Questions

1. **Background** — "What is your background in physics or space science?" — 5-point radio scale (None → Extensive)
2. **Data Analysis Experience** — "Have you previously analyzed scientific data?" — 5-point radio scale (Never → Extensively)
3. **Feedback** — "Do you have any additional feedback you'd like to share?" — free-response textarea, Skip/Submit toggle
4. **How Did You Learn?** — "How did you learn about this experiment?" — free-response textarea (half-height), Skip/Submit toggle

### Design rationale

- Originally planned as a single pre-test question ("Do you have any background in physics or space science?"). Identified that asking before the task could **prime** participants — making them self-conscious about expertise level, biasing their responses. Moved both demographic questions to post-test.
- Split into two separate questions (background vs. data analysis experience) for cleaner analysis — someone can have physics background without data analysis experience, or vice versa.
- Free-response feedback and referral questions are optional (Skip button) to reduce participant fatigue.

### Implementation

- **`js/modal-templates.js`** — Four new create functions: `createBackgroundQuestionModal()`, `createDataAnalysisQuestionModal()`, `createFeedbackQuestionModal()`, `createReferralQuestionModal()`. All registered in `initializeModals()`.
- **`emic_study.html`** — Questionnaires panel with 4 buttons, styled with `var(--accent-bg)` to match the main visualization panel. CSS overrides for modal widths (612px for radio modals, 680px for textarea modals). Radio choice hover/selected styles.
- **`js/main.js`** — Button→modal wiring with event listeners. Radio modals enable submit on selection. Textarea modals toggle Skip/Submit based on content. Panel visibility gated by Advanced mode.

### Questionnaires panel

- Hidden by default, shown only when Advanced mode is checked
- Uses `var(--accent-bg)` background with subtle white border — matches the main visualization panel rather than the metallic sub-panels

### TDZ fix

Moving the questionnaires panel visibility toggle into `applyAdvancedMode()` exposed a temporal dead zone error: `closeSettingsDrawer()` referenced `const drawerEl` declared later in the same scope. Fixed by moving drawer declarations (`drawerEl`, `hamburgerBtn`, `drawerCloseBtn` and the open/close functions) above the advanced mode toggle section.

---

## Main Window View Mode Selector

Added a "Show" dropdown to the main window gear popover, mirroring the minimap's existing `miniMapView` dropdown. The main spectrogram window can now display three modes:

- **Spectrogram** (default) — FFT frequency-domain view
- **Time Series** — raw waveform amplitude view
- **Combination** — spectrogram behind, waveform overlaid with transparent background

### Architecture

The minimap (top window) and main spectrogram (bottom window) use **separate WebGL contexts** — they can't share GPU textures. The minimap already had both a spectrogram mesh and a waveform mesh in its Three.js scene. The main spectrogram only had a spectrogram mesh.

Added a second mesh (waveform) to the spectrogram renderer's scene:

- **Waveform fragment shader** — identical to the minimap's waveform shader (min/max mip acceleration for zoomed-out views, raw sample scanning when zoomed in, center line, colormap-based coloring)
- **Brightness-boosted colormap** — `buildWaveformColormapTexture()` duplicated from `waveform-renderer.js` (40% boost + 150 minimum brightness) so waveform lines are visible both standalone and overlaid on spectrogram
- **Separate GPU textures** — `uploadMainWaveformSamples()` creates sample + mip textures from `State.completeSamplesArray` in the spectrogram's WebGL context (called after FFT computation completes)

### Render frame logic

`renderFrame()` now checks `getMainWindowMode()` (reads `#mainWindowView` dropdown) and:
- Toggles `mesh.visible` (spectrogram) and `waveformMesh.visible` based on mode
- Sets `uTransparentBg = 1.0` in combination mode so waveform background is transparent
- Syncs waveform viewport uniforms with spectrogram viewport (same start/end values)
- Render order: spectrogram at 0, waveform at 1 (waveform draws on top)

### Persistence

`mainWindowView` added to the `navControls` localStorage array (`emic_main_view` key). Change handler calls `updateSpectrogramViewport()` to trigger immediate re-render.

### Files Changed

- `emic_study.html` — `#mainWindowView` select added to main window gear popover (Spectrogram/Time Series/Combination)
- `js/spectrogram-three-renderer.js` — Waveform state variables, fragment shader, `getMainWindowMode()`, `buildWaveformColormapTexture()`, `uploadMainWaveformSamples()`, waveform mesh/material in `initThreeScene()`, mode-aware `renderFrame()`; waveform cleanup in `clearCompleteSpectrogram()`
- `js/main.js` — `mainWindowView` in navControls array, change handler calling `updateSpectrogramViewport()`, added import

### Bug fixes

**Zoom viewport mismatch:** When zoomed in, the spectrogram switches to a region texture where `uViewportStart/End` are relative to the region's coordinate space (0–1 within the zoomed slice). The waveform was naively copying these values but needs coordinates relative to the full sample array. Fixed by computing the waveform viewport independently from `zoomState.currentViewStartTime/EndTime` mapped to [0,1] in terms of the full data range.

**Waveform disappears on FFT size change:** `clearCompleteSpectrogram()` disposes the scene mesh/material and nulls `material`, which causes `initThreeScene()` to rebuild the scene from scratch on the next render. But the waveform mesh/material/textures weren't included in the cleanup, so they were orphaned. And `wfLastUploadedSamples` still referenced the old array, causing `uploadMainWaveformSamples()` to skip the re-upload. Fixed by adding full waveform disposal to `clearCompleteSpectrogram()` (mesh, material, sample texture, mip texture, colormap texture, and resetting `wfLastUploadedSamples = null`). On re-init, `initThreeScene()` recreates the waveform mesh and `uploadMainWaveformSamples()` re-uploads fresh textures.

---

## Spectrogram Playbar Stutter Fix (Sub-pixel Rendering)

The red playbar on the spectrogram (bottom panel) visibly stuttered while the waveform playbar (top panel) moved butter-smooth. Both are driven by the same `requestAnimationFrame` loop in `updatePlaybackIndicator()`, so timing wasn't the issue.

### Root cause: `Math.floor()` pixel snapping

The spectrogram playhead in `spectrogram-playhead.js` used `Math.floor(progress * width)` to compute the X position — snapping to integer pixels. On a 1200px canvas showing 7 days of data, each pixel ≈ 8.4 minutes of real-time, so the playbar would "stick" then "jump" one full pixel at a time.

The waveform playhead in `waveform-renderer.js` used raw floating-point `x = progress * width` — no floor. The browser's canvas antialiasing smoothly interpolates sub-pixel line positions, making the line appear to glide between pixels.

### Fix

Removed all `Math.floor()` calls from playhead and scrub preview position calculations in `spectrogram-playhead.js`, matching the waveform renderer's approach. Six instances total across `drawSpectrogramPlayhead()` and `drawSpectrogramScrubPreview()`.

### Files Changed

- `js/spectrogram-playhead.js` — Removed `Math.floor()` from all playhead/preview X position calculations (6 instances); sub-pixel float values now match waveform renderer behavior
