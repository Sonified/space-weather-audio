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

---

## Minimap Viewport Edge-Drag Resize

The minimap viewport window (the highlighted region on the top panel showing what's visible in the spectrogram below) previously only supported click-to-snap and drag-to-pan. Added edge-drag resize so users can grab the left or right edge of the window to widen or narrow it.

### Hover cursor

In the canvas `mousemove` handler, when not dragging and in windowed mode, the mouse position is compared to the left and right viewport edge pixel positions. Within 8px of either edge, the cursor changes to `ew-resize` (horizontal resize arrows). Outside that zone it stays `pointer`.

### Mousedown edge detection

On mousedown, if the click is within 8px of a viewport edge, `minimapResizeEdge` is set to `'left'` or `'right'` and the cursor stays `ew-resize`. If both edges are within threshold (very narrow window), the closer edge wins. Clicks away from edges enter the existing pan mode with snap-center-on-outside-click behavior unchanged.

### Drag behavior

In the document-level `mousemove` handler, resize mode only moves the dragged edge while the opposite edge stays fixed. Pan mode (existing) translates both edges together. Both modes are clamped to data bounds. Resize enforces a 1-minute minimum window width (`MINIMAP_MIN_WINDOW_MS = 60000`) to prevent collapsing the window to zero.

### State variables

- `minimapResizeEdge` — `null` (pan), `'left'`, or `'right'`
- `MINIMAP_EDGE_THRESHOLD_PX = 8` — hover/click detection zone in pixels
- `MINIMAP_MIN_WINDOW_MS = 60000` — minimum viewport width in milliseconds

### Files Changed

- `js/waveform-renderer.js` — Added `minimapResizeEdge`, `MINIMAP_EDGE_THRESHOLD_PX`, `MINIMAP_MIN_WINDOW_MS` state; edge proximity detection in mousedown; resize vs pan branching in document mousemove; `ew-resize` cursor on hover near viewport edges in canvas mousemove

---

## Feature Box Close Buttons (×)

Added red × close buttons to the upper-right inside corner of feature boxes on the spectrogram. Clicking the × deletes the feature after a confirmation prompt.

### Drawing

In `drawSavedBox()`, after the box stroke/fill, a close button is drawn if the box is large enough (width/height > `closeSize + closePad * 3`):
- Dark semi-transparent circle backdrop (`rgba(0,0,0,0.5)`, radius `closeSize/2 + 2`)
- Red × lines (`#ff4444`, lineWidth 2, round caps) with 3px inset from circle edges
- Positioned at top-right inside corner: `closePad` from right edge, `closePad` from top

### Hit testing

`getClickedCloseButton(x, y)` performs circular hit-testing around the × center with a generous radius (`closeSize/2 + 4`). Uses the same coordinate conversion logic as `getClickedBox()` — device pixel scaling, frequency scale transitions, interpolated time range. Returns `{ regionIndex, featureIndex }` or `null`.

### Delete routing

The mousedown handler checks close buttons before any other click logic. Routes based on `regionIndex`:
- **`regionIndex === -1`** (standalone feature): calls `deleteStandaloneFeature(featureIndex)` + `redrawAllCanvasFeatureBoxes()` + `renderStandaloneFeaturesList()`
- **`regionIndex >= 0`** (region-based feature): calls `deleteRegion(regionIndex)`

### Bug fix: standalone features weren't deletable

The original implementation always called `deleteRegion(closedBox.regionIndex)` regardless of feature type. In windowed modes (page turn, scroll, static), all features are standalone (`regionIndex = -1`). `deleteRegion(-1)` tried `regions[-1]` → `undefined`, showed the confirm dialog but silently failed to delete anything. Fixed by checking `regionIndex === -1` and routing to `deleteStandaloneFeature()` instead.

### Cursor

Mousemove handler checks `getClickedCloseButton()` and sets `cursor: pointer` on hover.

### Files Changed

- `js/spectrogram-renderer.js` — Close button drawing in `drawSavedBox()`, `getClickedCloseButton()` hit-test function, mousedown handler routing (standalone vs region), cursor change on hover, added `deleteStandaloneFeature` and `renderStandaloneFeaturesList` imports
- `js/region-tracker.js` — No changes (existing `deleteStandaloneFeature()` and `deleteRegion()` used as-is)

---

## Gear Popover Heading Rename

Renamed the third gear popover section heading from "Numbers" to "Feature Numbers" for clarity — it controls the color and location of feature box number annotations on the spectrogram.

### Files Changed

- `emic_study.html` — `.gear-popover-title` text changed from "Numbers" to "Feature Numbers"

---

## Minimap Viewport Edge-Drag Resize

Added edge-drag resize to the minimap viewport window. Users can grab the left or right edge to widen or narrow the viewport, in addition to the existing click-to-snap and drag-to-pan behavior.

- Hover within 8px of viewport edge shows `ew-resize` cursor
- Mousedown near edge enters resize mode (moves only that edge, opposite stays fixed)
- 1-minute minimum window width enforced (`MINIMAP_MIN_WINDOW_MS = 60000`)
- Click outside viewport still snap-centers as before

### Files Changed

- `js/waveform-renderer.js` — `minimapResizeEdge`, `MINIMAP_EDGE_THRESHOLD_PX`, `MINIMAP_MIN_WINDOW_MS` state; edge proximity detection in mousedown; resize vs pan branching in document mousemove; `ew-resize` cursor on hover

---

## Feature Box Close Buttons (x)

Added red x close buttons to the upper-right inside corner of feature boxes on the spectrogram. Clicking deletes the feature after confirmation.

- Dark circle backdrop + red x lines, positioned `closePad` from right/top edges
- `getClickedCloseButton(x, y)` circular hit-testing with generous radius
- Routes based on `regionIndex`: standalone features use `deleteStandaloneFeature()`, region-based use `deleteRegion()`
- Fixed bug: standalone features (windowed modes) weren't deletable — `deleteRegion(-1)` silently failed

### Files Changed

- `js/spectrogram-renderer.js` — Close button drawing, hit-test function, mousedown routing, cursor on hover, added imports for `deleteStandaloneFeature` and `renderStandaloneFeaturesList`

---

## Spectrogram X-Axis Time Ticks

Added time ticks below the main spectrogram window, matching the existing minimap x-axis pattern.

### Architecture

- **New file: `js/spectrogram-x-axis-renderer.js`** — Separate renderer importing tick calculators from `waveform-x-axis-renderer.js`
- Three exported functions: `drawSpectrogramXAxis()`, `positionSpectrogramXAxisCanvas()`, `resizeSpectrogramXAxisCanvas()`
- Uses `getInterpolatedTimeRange()` for time range (handles zoom transitions automatically)
- No EMIC windowed override (unlike minimap which always shows full range in windowed mode)
- Lazy `import()` in `waveform-x-axis-renderer.js` zoom transition RAF loop to avoid circular dependency

### Tick calculator exports

Seven tick functions in `waveform-x-axis-renderer.js` changed from private to `export function`: `calculateHourlyTicks`, `calculateSixHourTicks`, `calculateFourHourTicks`, `calculateTwoHourTicks`, `calculateOneMinuteTicks`, `calculateFiveMinuteTicks`, `calculateThirtyMinuteTicks`

### X-Axis Show/Hide Toggle

Added "X-Axis" dropdown to the main window gear popover with "Show Ticks" (default) and "Hide Ticks" options.

- `#mainWindowXAxis` select persisted via `navControls` (`emic_main_xaxis` localStorage key)
- When hidden: `#spectrogram-x-axis` canvas `display: none`, spectrogram `margin-bottom: 0`
- When shown: canvas visible, `margin-bottom: 30px`
- All three renderer functions gate on `isSpectrogramXAxisVisible()` — bail early when hidden (no tick math, no DOM measurements)

### Call sites wired

- **`js/main.js`** — Import + 4 sites: init positioning, resize handler (position + debounced resize), viewing mode change
- **`js/data-fetcher.js`** — Import + 3 sites alongside existing waveform x-axis calls
- **`js/waveform-x-axis-renderer.js`** — 2 lazy import sites in zoom transition RAF loop
- **`js/waveform-renderer.js`** — Import + 4 `drawSpectrogramXAxis()` + 2 `positionSpectrogramXAxisCanvas()` calls
- **`js/scroll-zoom.js`** — Import + 1 site in `renderFrame()`
- **`js/region-tracker.js`** — Import + 2 sites (zoom-to-region, zoom-to-full)

### Layout

- `styles.css` — `margin-bottom: 30px` on `#spectrogram`; combined `#waveform-x-axis, #spectrogram-x-axis` CSS rules; added to touch-action mobile rule
- `emic_study.html` — Added `<canvas id="spectrogram-x-axis">` after spectrogram-axis

### Files Changed

- `js/spectrogram-x-axis-renderer.js` (new) — Full renderer with visibility gate
- `js/waveform-x-axis-renderer.js` — Exported 7 tick calculators, 2 lazy import call sites
- `js/main.js` — Import, navControls entry, x-axis toggle handler, 4 call sites
- `js/data-fetcher.js` — Import + 3 call sites
- `js/waveform-renderer.js` — Import + 6 call sites
- `js/scroll-zoom.js` — Import + 1 call site
- `js/region-tracker.js` — Import + 2 call sites
- `emic_study.html` — Canvas element + gear popover dropdown
- `styles.css` — Margin, shared CSS rules, touch-action

---

## Day Markers Disappear on Browser Zoom Fix

The spectrogram day marker overlay has a `ResizeObserver` that resizes its canvas buffer when the spectrogram canvas resizes. Resizing a canvas buffer clears all drawn content. No `drawDayMarkers()` call followed, so markers vanished on browser zoom (Cmd+/Cmd-). The minimap markers survived because the waveform redraw path calls `drawDayMarkers()` as a side effect.

### Fix

Added `drawDayMarkers()` to the end of the window resize handler in `main.js`.

### Files Changed

- `js/main.js` — Added `drawDayMarkers()` call in resize handler after `updateAllFeatureBoxPositions()`

---

## Feature Box Visual Polish

Tweaked the feature box close button and number label rendering for consistency and readability.

### Close button backdrop removed

The dark semi-transparent circle behind the × (`rgba(0,0,0,0.5)`) was too prominent. Removed it — now just bare red × lines against the box background.

### Feature number color matched to ×

The feature number label was `rgba(255, 80, 80, 0.9)` — lighter and translucent compared to the × at `#ff4444`. Changed to `#ff4444` so both elements match exactly.

### Inside-mode number repositioned

When "Location: Inside box" is selected, the feature number now sits at `x + closePad, y + closePad` — mirroring the × button's inset on the opposite (top-left) corner. Previously used ad-hoc `x+3, y+3` positioning.

### Size and spacing tuning

Iterative refinements to get × and number visually balanced:
- `closeSize` 16 → 12, `inset` 3 → 2, `lineWidth` 2.5 → 2 — × was too large relative to the number
- `closePad` 4 → 6 — both × and number pulled further from box corners
- Font changed from `bold 16px` → `15px` Arial — dropped bold, slightly smaller to match × proportions

### Files Changed

- `js/spectrogram-renderer.js` — Removed circle backdrop from close button draw, changed number fillStyle from `rgba(255,80,80,0.9)` to `#ff4444`, repositioned inside-mode number to use `closePad` offset, tuned closeSize/closePad/inset/lineWidth/font for visual balance (both draw and hit-test functions)

---

## FFT Size Change While Scroll-Zoomed: Viewport-First Hi-Res Rendering

Changing FFT size while scroll-zoomed in previously showed only a blurry UV-crop of the full texture — no hi-res re-render was triggered for the viewport.

### Root cause

`changeFftSize()` had two branches: region-zoom (renders region hi-res first, full texture in background) and everything else (renders full texture, UV-crops to viewport). The "everything else" branch handled scroll-zoom poorly — it re-rendered the entire full-resolution texture first (slow), then UV-cropped it to the viewport (blurry), and never triggered the hi-res viewport render that normally fires after scroll events settle.

### Fix

Added a third branch for scroll-zoom state (`zoomState.isInitialized()` but not `isInRegion()`). Mirrors the region-zoom pattern:

1. Compute current viewport bounds from `zoomState.currentViewStartTime/EndTime` with 30% padding
2. `resetSpectrogramState()` — clears stale hi-res texture and flags
3. `renderCompleteSpectrogramForRegion(expandedStart, expandedEnd)` — hi-res render of just the viewport (fast, small region)
4. `setScrollZoomHiRes()` + `updateSpectrogramViewportFromZoom()` — activate the hi-res texture
5. `updateElasticFriendInBackground()` — full texture renders in background for eventual zoom-out

User sees crisp viewport immediately, full texture prepares silently behind the scenes.

### Files Changed

- `js/spectrogram-renderer.js` — Three-branch `changeFftSize()`: region-zoom, scroll-zoom (new), full-view. Added `setScrollZoomHiRes` import from spectrogram-three-renderer.js
