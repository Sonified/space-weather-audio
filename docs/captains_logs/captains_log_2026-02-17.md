# Captain's Log - 2026-02-17

## EMIC Study UI Polish: Speed Buttons & Scroll-to-Zoom Toggle

Quick session focused on wiring up disconnected UI controls in `emic_study.html`.

---

## Speed Buttons Now Functional

The EMIC study interface had three speed buttons (0.5x, 0.75x, 1x) that toggled their `active` class but never actually changed the playback speed. Fixed by reverse-engineering the logarithmic slider mapping to compute the correct slider value for each target speed, then dispatching an `input` event to trigger the existing `changePlaybackSpeed()` pipeline.

The logarithmic formula (slider value 0-1000, with 667 = 1.0x):
- For speed <= 1.0: `sliderValue = 667 * log10(speed / 0.1)`
- For speed > 1.0: `sliderValue = 667 + 333 * log(speed) / log(15)`

This means the buttons set the hidden `#playbackSpeed` slider to ~466 (0.5x), ~584 (0.75x), or 667 (1x), and the existing listener handles everything downstream — worklet speed, spectrogram viewport, axis labels, feature box positions.

---

## Scroll Behavior: Dropdown to Checkbox

The "Scroll" control was a `<select>` dropdown with two options ("Default" and "Zoom in/out"). Converted it to a simple checkbox toggle labeled "Scroll to zoom" — much cleaner for a binary choice. Moved it from its original position to sit directly left of the "Day Markers" checkbox, matching the same styling (gap, label size, checkbox size, accent color). Updated the persistence config in `main.js` from `type: 'select'` to `type: 'checkbox'` so localStorage save/restore works correctly.

---

---

## Day Markers: Rendering Fixes & Auto-Display on Data Load

The day markers overlay (`js/day-markers.js`) had several rendering issues and a missing auto-display behavior. Worked through them one by one:

### Left-aligned date labels
Date labels ("Feb 17", etc.) were centered on the dashed line, making them visually ambiguous about which side of the boundary they referred to. Changed to left-align: the pill and text now start just to the right of the dashed line (`pillX = x + 3`, `textAlign = 'left'`).

### Labels on both spectrogram and waveform
Waveform markers previously had no date labels (comment said "spectrogram labels are sufficient"). Added the same "Mon DD" labels to the waveform overlay for clarity.

### DPR scaling fix for waveform overlay
The waveform canvas buffer is scaled by `devicePixelRatio` (e.g., 2400px buffer at 1200px CSS on Retina), but the day marker overlay inherited that buffer size and drew at 1:1 buffer pixels — making text and dashes appear at half their intended size. Fixed by applying `ctx.scale(dpr, dpr)` and using CSS-pixel coordinates (`bufW / dpr`) for all drawing on the waveform overlay.

### Spectrogram overlay buffer mismatch
The spectrogram (Three.js) canvas has a smaller buffer than its CSS display size (`setSize(w, h, false)` doesn't set CSS styles). The overlay was copying the small buffer dimensions and getting CSS-stretched, causing horizontally distorted and blurry text. Fixed by using `canvas.offsetWidth`/`offsetHeight` (the actual CSS display size) as the overlay's buffer dimensions, so it renders 1:1 with the display.

### Z-index: day markers behind glow overlay
The spectrogram has a `rgba(0, 0, 0, 0.3)` glow overlay div at z-index 10. Day markers were at z-index 9, rendering behind it and appearing dimmed. Bumped day markers to z-index 15 (still below live annotations at 25).

### Auto-display on data load
Day markers weren't appearing when the checkbox was already checked and data was fetched — `drawDayMarkers()` was only called during EMIC init (before data existed) and on checkbox change. Added a `drawDayMarkers()` call at the end of `startStreaming()` so markers appear immediately when data finishes loading.

---

## Scroll-to-Zoom: Full Implementation

New module `js/scroll-zoom.js` — cursor-anchored scroll-to-zoom for spectrogram and waveform canvases, gated behind the "Scroll to zoom" checkbox. Mouse wheel and trackpad two-finger pinch/scroll both work (macOS fires trackpad gestures as `wheel` events). `passive: false` on the listeners so `preventDefault()` actually blocks page scroll in Chrome.

### Zoom math
Cursor position maps to a fraction across the canvas → timestamp under cursor. Zoom factor derived from `deltaY`, clamped to `[0.8, 1.2]` per tick to prevent wild jumps. New viewport computed keeping the cursor timestamp anchored:
```
newStart = cursorTime - (cursorTime - oldStart) * zoomFactor
newEnd = cursorTime + (oldEnd - cursorTime) * zoomFactor
```
Clamped to data bounds, minimum 1 second visible, snaps to full view when zoomed all the way out.

### The mode bypass — key architectural decision
The existing zoom system uses `zoomState.mode` (`'full'` vs `'region'`) to control UI behavior throughout ~15 code paths. Calling `setViewportToRegion()` sets `mode='region'`, which triggers `isInRegion()=true` — hiding blue region boxes, region zoom/play buttons, and changing click behavior. Scroll-zoom needs continuous viewport changes without any of those side effects.

Solution: directly set `zoomState.currentViewStartTime` / `currentViewEndTime` without touching `mode` (stays `'full'`). This required updating four viewport-reading functions that all had the same fallback pattern of `isInRegion() ? regionRange : dataStartTime/dataEndTime`:
- `getWaveformViewport()` in `waveform-renderer.js` — computes sample range from zoomState timestamps
- `drawWaveformXAxis()` in `waveform-x-axis-renderer.js` — reads viewport for axis label placement
- `getInterpolatedTimeRange()` in `waveform-x-axis-renderer.js` — used by region boxes and buttons for positioning
- `getVisibleTimeRange()` in `day-markers.js` — used for midnight boundary calculations
- `updateSpectrogramViewportFromZoom()` in `spectrogram-three-renderer.js` — new function (see below)

### New: `updateSpectrogramViewportFromZoom()`
The existing `updateSpectrogramViewport()` (called during playback) never sets `uViewportStart`/`uViewportEnd` shader uniforms — those are set once during full render. Created `updateSpectrogramViewportFromZoom()` that reads zoomState timestamps, computes viewport fractions, and writes them directly to the shader uniforms. Also hides the dimming overlay and triggers a render frame.

### EMIC dark overlay removal
`updateSpectrogramOverlay()` was setting opacity 1.0 in full view mode, causing a dark `rgba(0,0,0,0.3)` layer over the spectrogram. Added an early return in EMIC mode that always keeps the overlay transparent (`opacity = '0'`). This fixed both the initial data load and scroll-zoom scenarios.

### Instant render pipeline
Each scroll tick fires the full chain with zero animation:
```
drawWaveformFromMinMax() → drawWaveformXAxis() → updateSpectrogramViewportFromZoom()
→ updateAllFeatureBoxPositions() → drawSpectrogramPlayhead() → drawDayMarkers()
```

---

## Files Changed

- `js/scroll-zoom.js` — **NEW** — Scroll-to-zoom module with cursor-anchored zoom, checkbox gating, preventDefault
- `js/day-markers.js` — Left-aligned labels, waveform labels, DPR scaling, spectrogram buffer sizing, z-index bump, scroll-zoom viewport support
- `js/main.js` — `drawDayMarkers()` + `initScrollZoom()` calls after data load; initial draw on EMIC init
- `js/spectrogram-three-renderer.js` — New `updateSpectrogramViewportFromZoom()`, EMIC dark overlay bypass
- `js/waveform-renderer.js` — `getWaveformViewport()` reads zoomState timestamps for scroll-zoom
- `js/waveform-x-axis-renderer.js` — `drawWaveformXAxis()` and `getInterpolatedTimeRange()` read zoomState timestamps

---

## Scroll-Zoom Performance: From Choppy to Butter

### rAF throttle
Trackpad wheel events fire far faster than 60fps. Every event was triggering the full render pipeline — redundant draws that the GPU couldn't keep up with at 7-day zoom. Fixed with a classic `requestAnimationFrame` coalescing pattern: zoom math runs on every wheel event (so `preventDefault()` fires immediately), but the render pipeline only runs once per animation frame via a `rafPending` flag.

### The real bottleneck: waveform shader looping 5000× per pixel
At 7-day zoom (~6M samples across ~1200 pixels), the fragment shader was scanning ~5000 raw texture samples per pixel to find min/max. That's ~6 million texture lookups per frame — the GPU was grinding.

### Solution: Min/max mip texture (250× speedup)
Pre-computed a min/max mip texture at upload time — each texel stores the min and max of 256 consecutive raw samples in a two-channel `RG Float32` texture. The shader now has two paths:

```glsl
if (samplesPerPixel > uMipBinSize && uMipTotalBins > 0.0) {
    // Zoomed out: loop over ~20 mip bins instead of ~5000 raw samples
    for (int i = 0; i < 512; i++) {
        vec2 mm = getMipBin(binStart + float(i));
        minVal = min(minVal, mm.r);
        maxVal = max(maxVal, mm.g);
    }
} else {
    // Zoomed in: scan raw samples (few per pixel, already fast)
}
```

At 7-day zoom: `5000 samples / 256 per bin = ~20 mip lookups per pixel`. That's a 250× reduction in texture reads. The result: perfectly smooth butter-scrolling through a week of 10 Hz magnetometer data on a GPU waveform renderer. Universal optimization — works for EMIC study, main site, volcano data, everything.

### Mip texture construction (in `uploadWaveformSamples()`)
```javascript
const mipBins = Math.ceil(totalSamples / 256);
const mipData = new Float32Array(texWidth * texHeight * 2); // RG channels
for (let bin = 0; bin < mipBins; bin++) {
    // scan 256 samples, store min in R, max in G
}
wfMipTexture = new THREE.DataTexture(mipData, w, h, THREE.RGFormat, THREE.FloatType);
```

---

## Region Zoom: Viewport-Aware Animation

When clicking the magnifying glass on a region while scroll-zoomed, the animation hardcoded its start point as `State.dataStartTime / dataEndTime` — the full data range. So it always animated from fully-zoomed-out, even if you were already zoomed into a nearby section. Same problem in reverse with `zoomToFull()`.

Fix: both `zoomToRegion()` and `zoomToFull()` in `region-tracker.js` now read `zoomState.currentViewStartTime / currentViewEndTime` as the animation origin when zoomState is initialized, falling back to full data range otherwise. Animations now start from wherever you actually are.

---

## Day Marker Styling Polish

### Label positioning: spectrogram top, waveform bottom
Date labels were at the top of both canvases, overlapping with region play/zoom buttons on the waveform. Added a `labelPosition` parameter to `drawMarkerLine()` — spectrogram keeps default `'top'`, waveform passes `'bottom'`. Labels now sit at opposite ends, never collide with buttons.

### Drop shadow instead of pill background
Replaced the filled pill background behind date text with a lightweight CSS text shadow (`shadowBlur: 4, shadowColor: rgba(0,0,0,0.8)`). Cleaner look, less visual weight, still readable against any background.

---

## Waveform Line Disappearing on Zoom-In

When zooming in past single-sample-per-pixel resolution, the waveform data line faded to nothing and disappeared entirely. Root cause: the shader computes `yMin = minVal * 0.9` and `yMax = maxVal * 0.9` per pixel column. When each pixel covers ≤1 sample, `minVal == maxVal`, so `yMax - yMin == 0` — a zero-width band. The check `amplitude >= yMin && amplitude <= yMax` matches zero pixels.

Fix: enforce minimum band thickness in the shader:
```glsl
float minThickness = 2.0 / uCanvasHeight;
if (yMax - yMin < minThickness) {
    float center = (yMin + yMax) * 0.5;
    yMin = center - minThickness * 0.5;
    yMax = center + minThickness * 0.5;
}
```
Guarantees at least a 2-device-pixel-thick line at any zoom level. At full zoom-in, you now see a clean thin trace through the data instead of nothing.

---

## Files Changed (Session 2)

- `js/scroll-zoom.js` — rAF throttle for wheel event coalescing
- `js/waveform-renderer.js` — Min/max mip texture system, shader two-path branching, minimum band thickness fix
- `js/region-tracker.js` — `zoomToRegion()` and `zoomToFull()` read current scroll-zoom viewport
- `js/day-markers.js` — Label position parameter (top/bottom), drop shadow text styling, text nudge

---

## GOES Magnetometer Data → R2 Progressive Streaming Pipeline

Built a new pipeline to download GOES magnetometer data from CDAWeb and upload it to Cloudflare R2 for progressive streaming — replacing the current approach of pulling pre-audified WAV files from CDAWeb on every page load.

### The Problem

The EMIC study currently fetches audio-format WAV files from CDAWeb's REST API (`?format=audio`) in real time. This works but ties every playback to a live CDAWeb request. For the study, we want pre-staged data on our own CDN for fast, reliable progressive streaming — the same pattern that powers the volcano seismic audio.

### CDAWeb Format Investigation

Tested two CDAWeb output formats for GOES-16 magnetometer data (`DN_MAGN-L2-HIRES_G16`, variable `b_gse`):

| Format | 10 min of data | Notes |
|--------|---------------|-------|
| `?format=json` | **37 MB** | Absurdly bloated — CDAWeb dumps the full day's `time` variable (864K records as JSON objects) even for a 10-minute query. Actual science data is 70 KB buried in 37 MB of ceremony. 530x overhead. |
| `?format=cdf` | **1.9 MB** | Compact binary. Same `time` variable but binary-packed. Easily parsed with `cdflib`. |
| Raw Float32 | **70 KB** | The actual `b_gse` payload: `(6000, 3)` float32 array |

CDF was the clear winner.

### Full Day Size Breakdown (24h at 10 Hz)

864,000 samples per component:

| What | Size |
|------|------|
| CDF from CDAWeb | 17.9 MB |
| Raw Float32 (all 3 axes) | 9.9 MB |
| Raw Float32 (single axis) | 3.3 MB |
| Zstd-3 compressed (single axis) | **~2.4 MB** |

Decision: store each component (Bx, By, Bz) separately since the study likely only needs one component at a time. ~18 KB per 10-minute chunk compressed — tiny.

### Pipeline Script: `backend/goes_to_r2.py`

Python script that lives in the repo (not a cron job — run manually when we need data):

1. Hits CDAWeb REST API with `?format=cdf` for the specified date range
2. Downloads CDF, extracts `b_gse` via `cdflib`
3. Trims to exact day boundary (CDAWeb returns 864,001 samples — one extra at midnight)
4. Splits each component (Bx, By, Bz) into 10m/1h/6h chunks
5. Zstd-3 compresses each chunk
6. Uploads `.bin.zst` files + per-component metadata JSON to R2

Usage:
```bash
python3 backend/goes_to_r2.py 2022-01-21              # Single day
python3 backend/goes_to_r2.py 2022-01-21 2022-01-27   # Date range
python3 backend/goes_to_r2.py 2022-01-21 --dry-run    # Preview without uploading
```

### R2 Structure (emic-study bucket)

```
data/2022/01/21/GOES-16/mag/bx/metadata.json
data/2022/01/21/GOES-16/mag/bx/10m/GOES-16_mag_bx_10m_2022-01-21-00-00-00_to_2022-01-21-00-10-00.bin.zst
data/2022/01/21/GOES-16/mag/bx/1h/GOES-16_mag_bx_1h_2022-01-21-00-00-00_to_2022-01-21-01-00-00.bin.zst
data/2022/01/21/GOES-16/mag/bx/6h/GOES-16_mag_bx_6h_2022-01-21-00-00-00_to_2022-01-21-06-00-00.bin.zst
```

Same pattern for `by/` and `bz/`. Metadata includes per-chunk `min`, `max`, `samples`, `compressed_size`, `filename` — matching the volcano system's metadata structure for browser-side global normalization.

### Test Run: 2022-01-21

Successfully uploaded one full day to the `emic-study` R2 bucket:
- 528 files total (3 components × 172 chunks + 3 metadata files)
- 22.6 MB total
- 144 ten-minute + 24 one-hour + 4 six-hour chunks per component
- Fixed a boundary issue: CDAWeb's extra sample at midnight created 13-byte "runt" chunks with matching start/end times. Added trimming to `extract_components()` and cleaned up the ghosts from R2.

### Fill Value Interpolation (−9999 sentinel)

Jan 22 data revealed min values of −9999.00 across all components — CDAWeb's fill/missing data sentinel. These blow up normalization ranges and would produce wild spikes in the waveform.

Added `interpolate_fill_values()` to the pipeline: scans for any value ≤ −9990, replaces with `np.nan`, then linearly interpolates across valid neighbors using `np.interp`. Crucially, this runs on the full-day array *before* chunking — so gaps that happen to land on a chunk boundary get interpolated cleanly across the seam.

Had to nuke the entire R2 bucket (1,038 objects from Jan 21 + 22) and re-upload both days with clean interpolated data.

### R2 Bucket Rename: `emic-study` → `emic-data`

Decided on clean bucket naming for the project: `emic-data` (public, GOES magnetometer data) and `emic-participants` (private, future participant data). Created the new `emic-data` bucket, nuked all 1,038 objects from `emic-study`, updated all code references (`goes_to_r2.py`, `presign_server.py`, `test_r2_audification.html`), and re-uploaded Jan 21–22 to the new bucket.

### Serving Data via Cloudflare Worker (not public bucket URL)

Initially tried making the R2 bucket publicly accessible via the `r2.dev` development URL, but that returned 401 and is rate-limited / not production-ready anyway. Realized the volcano seismic data used the same pattern: a Cloudflare Worker with a native R2 binding serves the files with CORS headers and caching — no public URLs, no presigned URLs needed.

Added `emic-data` as a second R2 binding (`EMIC_DATA`) in the existing worker (`worker/wrangler.toml`), and added a `/emic/data/*` route to `worker/src/index.js` that:
- Strips the `/emic/` prefix to get the R2 key
- Reads from the `EMIC_DATA` bucket binding
- Serves with CORS headers and 24-hour cache (`Cache-Control: public, max-age=86400`)
- Sets `Content-Type` based on extension (`.json` → `application/json`, `.zst` → `application/zstd`)

Data URLs will be: `https://spaceweather.now.audio/emic/data/2022/01/21/GOES-16/mag/bz/metadata.json`

### Browser Test Page Updated

Rewired `tests/browser/test_r2_audification.html` to fetch directly from the worker (`spaceweather.now.audio/emic/data/...`) instead of using the local presign server. No Python server needed anymore. The `presign_server.py` can be deprecated.

Moved to top level as `test_r2_audification.html` so it's accessible at `spaceweather.now.audio/test_r2_audification.html` via the worker's GitHub Pages proxy.

Replaced the static "First chunk / Last chunk" dropdown with a dynamic chunk browser: click **Load Chunks** to fetch metadata, then a dropdown lists every chunk with its UTC time range (e.g. `#0: 2022-01-21 00:00–00:10 UTC`). Changing component or chunk type auto-reloads the list. Metadata is cached so `fetchAndPlay` no longer re-fetches it on every click.

### Minimap Viewport Indicator Fixes

Two bugs in the waveform minimap's white zoom box:

1. **Box disappeared at full zoom-out**: `drawWaveformOverlays()` had an inline threshold check (`viewStartFrac > 0.001 || viewEndFrac < 0.999`) that hid the viewport indicator when the view covered the full data range. Removed the threshold — now always shows the white box in windowed mode, even at full zoom-out.

2. **`isMinimapZoomed()` had the same threshold**: A separate function used elsewhere had the identical stale check. Simplified to always return `true` in windowed mode.

### Day Markers Disappearing on Zoom

When the zoom viewport didn't cross a midnight boundary, `drawDayMarkers()` called `getMidnightBoundaries()` on the zoomed range, got zero results, and bailed early with `clearDayMarkers()` — which also cleared the *minimap's* day markers (which use the full data range, not the zoomed range). Removed the early return so the function continues to the waveform minimap section, which correctly computes its own midnight boundaries from the full data range.

### Feature Boxes Not Tracking Spectrogram During Scroll

Canvas-based red feature boxes (drawn by `drawSavedBox()` via `redrawCanvasBoxes()`) use `getInterpolatedTimeRange()` for x-positioning — same as the orange DOM boxes. But they were only being redrawn during audio playback (via `updateCanvasAnnotations()` in the animation loop) or on explicit zoom events. During scroll-wheel zoom or minimap drag, the spectrogram texture shifted but the canvas overlay with the red boxes stayed frozen at their old pixel positions.

Fix: added `updateCanvasAnnotations()` to both scroll render paths:
- `renderMinimapDragFrame()` in `waveform-renderer.js` (minimap drag-to-pan)
- `renderFrame()` in `scroll-zoom.js` (scroll-wheel zoom)

Now both the orange DOM boxes AND the red canvas boxes stay pinned to the spectrogram content during all forms of scrolling.

### What's Next

- Run remaining EMIC study days (Jan 23–27, 2022)
- Wire up browser-side progressive streaming from `emic-data` into the main app
- Adapt `fetchFromR2Worker()` in `data-fetcher.js` to read from the new R2 structure

### Files Changed

- `backend/goes_to_r2.py` — **NEW** — CDAWeb CDF download → chunk → compress → R2 upload pipeline, fill value interpolation
- `worker/wrangler.toml` — Added `emic-data` R2 binding (`EMIC_DATA`)
- `worker/src/index.js` — Added `/emic/data/*` route serving from `emic-data` bucket
- `test_r2_audification.html` — **NEW** (top-level) — Dynamic chunk browser, fetches from worker
- `tests/browser/test_r2_audification.html` — Synced copy of above
- `tests/browser/presign_server.py` — **NEW** (now deprecated) — Was temporary presign helper
- `js/waveform-renderer.js` — Minimap viewport indicator always visible in windowed mode; canvas feature boxes redrawn during minimap drag
- `js/scroll-zoom.js` — Canvas feature boxes redrawn during scroll-wheel zoom
- `js/day-markers.js` — Don't bail early when zoomed viewport has no midnight boundaries

---

## Waveform Navigation Bar (Minimap) for Windowed Modes

Converted the waveform from a zooming view into a static navigation/overview bar for EMIC study's "Windowed Scroll" and "Windowed Page Turn" modes. The waveform always shows the full dataset; when scroll-zoomed, a white-bordered viewport indicator highlights the visible portion and everything outside is dimmed (60% black overlay). Region Creation mode is completely unaffected — the waveform still zooms normally there.

### Mode gating

All minimap behavior is gated on the `#viewingMode` dropdown value (`scroll` or `pageTurn`), not on `window.__EMIC_STUDY_MODE` alone. This was the key insight after three wrong gates:
1. First tried `__EMIC_STUDY_MODE` — broke Region Creation mode
2. Then `!zoomState.isInRegion()` — `isInRegion()` means "zoomed into a specific region", not "regions exist"; at full view with regions, minimap activated and hid them
3. Then `isInRegion()` as part of the gate — broke scroll-zoom in Region Creation mode

The correct gate: `isEmicWindowedMode()` checks `#viewingMode` for `scroll` or `pageTurn`.

### What changed

- **`getWaveformViewport()`** returns `{start: 0, end: 1}` in windowed mode — shader always renders full sample range
- **`drawWaveformOverlays()`** draws viewport indicator (white border + dimmed exterior) when zoomed in
- **Playhead** maps to full data range in windowed mode (not zoomed viewport)
- **Click/seek** maps to full data range — clicking at 50% of the minimap = 50% through the audio
- **Region highlights and buttons** hidden entirely in windowed modes (gates inside `drawRegionHighlights()` and `drawRegionButtons()`)
- **X-axis labels** always show full time range in windowed mode
- **Day markers** on waveform always use full data range in windowed mode
- **Mode switch listener** on `#viewingMode`: switching to windowed mode resets zoom to full view and re-renders everything

### Minimap drag-to-pan

Click and drag on the minimap to slide the viewport window around. Implemented as a parallel mouse interaction path in `setupWaveformInteraction()`:
- `mousedown` in windowed mode records cursor timestamp and viewport position, starts drag
- `mousemove` computes delta in timestamp space, shifts viewport (clamped to data bounds)
- `mouseup`/`mouseleave` stops drag
- Render coalesced via `requestAnimationFrame` — same pipeline as scroll-zoom (waveform, x-axis, spectrogram viewport, feature boxes, playhead, day markers)

No region selection, no seek, no "Add Region" button during drag — just pure viewport sliding.

### Files Changed (Session 3 — Minimap)

- `js/waveform-renderer.js` — `isEmicWindowedMode()` helper, `getWaveformViewport()` full range, viewport indicator overlay, playhead/selection/click mapping, minimap drag-to-pan interaction
- `js/waveform-buttons-renderer.js` — `drawRegionButtons()` bails in windowed modes
- `js/region-tracker.js` — `drawRegionHighlights()` bails in windowed modes
- `js/waveform-x-axis-renderer.js` — X-axis labels use full range in windowed mode
- `js/day-markers.js` — Waveform markers use full data range in windowed mode
- `js/main.js` — `#viewingMode` change listener: resets zoom, re-renders all

---

## Spectrogram Click-to-Seek & Selection Box Fix

### Click-to-seek in windowed modes

Added click-to-seek on the spectrogram in windowed scroll/pageTurn modes. Clicking anywhere on the spectrogram moves the playhead to that position. Uses `pixelToTimestamp()` to map the click to a timestamp in the current viewport, then converts to audio time via fraction-of-dataset mapping.

**Bug: wrong playhead position** — Initial implementation used `zoomState.timestampToSeconds()`, which returns real-world seconds from data start (e.g., 604800 for 7 days). But audio time is compressed — `totalAudioDuration` might be 300 seconds. Fixed by converting timestamp → fraction of full dataset → audio seconds: `fraction * totalAudioDuration`.

**Bug: feature box clicks zoomed to region** — In windowed mode, clicking on a feature box (red outline) triggered `zoomToRegion()`, switching the entire state to region mode and breaking the viewport. Fixed by bypassing the feature box zoom handler in windowed modes — clicks fall through to click-to-seek instead.

### Circular dependency from new imports

Adding `seekToPosition` (from `audio-player.js`) and `drawWaveformWithSelection` (from `waveform-renderer.js`) as static imports in `spectrogram-renderer.js` created circular dependency chains:
- `spectrogram-renderer.js` → `waveform-renderer.js` → `spectrogram-renderer.js`
- `spectrogram-renderer.js` → `audio-player.js` → `spectrogram-renderer.js`

This broke ES module initialization — the spectrogram selection overlay never set up properly, so feature box drawing in Region Creation mode silently failed.

Fix: replaced static imports with dynamic `import()` calls inside the click-to-seek handler. These only resolve at click time, long after all modules have finished loading:
```javascript
Promise.all([
    import('./audio-player.js'),
    import('./spectrogram-playhead.js'),
    import('./waveform-renderer.js')
]).then(([audioPlayer, playhead, waveform]) => {
    audioPlayer.seekToPosition(clamped, true);
    playhead.drawSpectrogramPlayhead();
    waveform.drawWaveformWithSelection();
});
```

### Selection box invisible during drag (while audio playing)

`updateCanvasAnnotations()` runs every animation frame during audio playback. It clears the entire spectrogram selection overlay canvas and redraws only completed feature boxes — wiping out the in-progress red selection box drawn by the `mousemove` handler 60 times per second.

Fix: both `updateCanvasAnnotations()` and `redrawCanvasBoxes()` now check `spectrogramSelectionActive` and call `drawSpectrogramSelectionBox()` after drawing completed boxes, preserving the drag-in-progress red box.

### Files Changed (Session 4 — Click-to-Seek & Fixes)

- `js/spectrogram-renderer.js` — Click-to-seek in windowed modes, dynamic imports for circular dependency fix, selection box preserved during playback animation, feature box clicks bypassed in windowed modes

---

## Minimap Display Mode Selector: Spectrogram / Line Plot / Combination

Added a mode selector to the Navigation Bar gear popover that switches the minimap (waveform navigation bar) between three display modes:

### Three modes, all GPU-rendered

- **Line Plot** (default): The existing GPU waveform shader — min/max amplitude bands colored by the waveform colormap. This is what the minimap always showed before.
- **Spectrogram**: GPU spectrogram shader running on the waveform canvas, reusing the `fullMagnitudeTexture` already computed by the main spectrogram renderer. No FFT recomputation — just grabs the existing 1x texture.
- **Combination**: Both passes composited — spectrogram renders first, then the waveform renders on top with transparent background pixels (alpha blending).

### Architecture: dual-shader on a single WebGL canvas

The waveform canvas (`#waveform`) already had a Three.js WebGL renderer with one shader material for the amplitude waveform. Added a second `ShaderMaterial` (`wfSpectroMaterial`) with the same spectrogram fragment shader used by the main window. Both meshes live in the same scene; `renderMinimapWithMode()` toggles visibility based on the selected mode.

For combination mode, the waveform shader needed transparent background support. Added a `uTransparentBg` uniform — when set to 1.0, background pixels output `alpha=0` instead of the solid background color, and the center line drops to 60% opacity. The waveform material has `transparent: true` so Three.js enables blending, and `renderOrder` ensures spectrogram (0) draws before waveform (1).

### Separate colormaps

The waveform shader uses a brightness-boosted colormap (`buildWaveformColorLUT()`) so amplitude bands are visible on dark backgrounds. The spectrogram shader needs the raw colormap — using the boosted version washed everything out to near-white. Added `buildSpectroColormapTexture()` which reads directly from `getColorLUT()` without brightness adjustment. Both colormaps rebuild when the user changes colormaps.

### Spectrogram texture access

Exported two new functions from `spectrogram-three-renderer.js`:
- `getFullMagnitudeTexture()` — returns `{ texture, width, height }` for the existing FFT magnitude texture
- `getSpectrogramParams()` — returns frequency scale, min/max freq, dB floor/range for shader uniform sync

### Auto-refresh on spectrogram ready

The spectrogram computes its FFT asynchronously after audio loads. If the minimap is in spectrogram mode when data first loads, the texture doesn't exist yet — minimap would be blank until the user interacts. Fixed with a `spectrogram-ready` custom event dispatched from `renderCompleteSpectrogram()`, listened to in the waveform renderer to trigger `drawWaveformFromMinMax()`.

### UI: gear popover placement

Moved the minimap mode selector from a standalone dropdown in the navigation controls bar into the Navigation Bar gear popover (top gear icon), alongside the existing "Click: Move window / Move & play" control. New row: "Mode: Line Plot / Spectrogram / Combination". Persisted to localStorage via the existing `navControls` system.

### index.html safety

`getMinimapMode()` returns `'linePlot'` when no `#miniMapView` element exists — so the main site is completely unaffected by these changes.

### Viewport dim overlay

Reduced the outside-viewport dimming from 50% to 30% black opacity for better spectrogram visibility when scroll-zoomed.

### Files Changed (Session 5 — Minimap Mode Selector)

- `js/waveform-renderer.js` — `getMinimapMode()`, `renderMinimapWithMode()` multi-pass renderer, `wfSpectroMaterial`/`wfSpectroMesh`, `uTransparentBg` uniform in waveform shader, `buildSpectroColormapTexture()`, `spectrogram-ready` listener, viewport dim 50%→30%
- `js/spectrogram-three-renderer.js` — `getFullMagnitudeTexture()`, `getSpectrogramParams()` exports, `spectrogram-ready` event dispatch
- `js/main.js` — `miniMapView` change listener triggers `drawWaveformFromMinMax()`
- `emic_study.html` — Mode selector moved into `#navBarPopover` gear popover, old standalone selector removed

---

## Per-Panel Gear Icon Settings UI

Added gear icon (⚙) settings popovers overlaid on each canvas panel in EMIC study mode. Each gear sits in the top-right corner of its canvas and opens a small popover with panel-specific controls.

### Two gear popovers

- **Navigation Bar** (waveform): "Click: Move window / Move & play" dropdown + "Mode: Line Plot / Spectrogram / Combination" dropdown
- **Main Window** (spectrogram): "Play on click" checkbox — gates whether clicking the spectrogram starts playback or just moves the playhead

### The `<button>` saga

Multiple rounds of CSS overrides (background: none, border: none, outline: none, appearance: none, fixed dimensions, flex centering) couldn't fully eliminate browser button chrome around the gear icon. The Unicode gear glyph ⚙ renders taller than wide, so `width: auto; height: auto` created a tall rectangle, and forced square dimensions still showed a visible box due to browser `<button>` defaults (padding, min-height, focus rings, border-box).

**The fix**: swap `<button>` to `<span>` with `cursor: pointer`. Eliminated all browser defaults in one step — final CSS is just 6 lines: `color`, `font-size`, `cursor`, `line-height`, `transition`, `user-select`. **Lesson: never use `<button>` for icon-only clickable elements.**

### Positioning

Gears are positioned via JS using canvas `offsetTop`/`offsetLeft`/`offsetWidth`, not CSS `right`, because `.panel-visualization` has `padding: 20px` that shifts the canvas inward. A `ResizeObserver` on each canvas keeps gears pinned on resize.

### Select dropdown dark mode fix

After picking an option from the dropdown, the OS renders a light focus highlight with white text over the dark select — making the selection invisible. Two fixes:
1. `color-scheme: dark` on the `<select>` tells the browser to use dark-mode native rendering
2. `sel.addEventListener('change', () => sel.blur())` immediately removes focus after selection, dropping the highlight

### Play on click wiring

The `#mainWindowPlayOnClick` checkbox gates `seekToPosition()`'s second argument (`shouldStartPlayback`). When unchecked, clicking the spectrogram calls `seekToPosition(clamped, false)` — moves the playhead without starting playback. When checked (default), passes `true` to seek and play.

### Old Click dropdown removed

The standalone "Click" dropdown that was in the navigation options panel has been removed — its functionality is now split between the two gear popovers (nav bar click mode + main window play-on-click).

### Files Changed (Session 6 — Gear Icons)

- `emic_study.html` — Gear icon HTML (`<span>` elements), popovers with controls, removed old Click dropdown
- `styles.css` — `.panel-gear`, `.gear-btn`, `.gear-popover`, `.gear-select` styles, dark mode form control fixes
- `js/main.js` — Gear positioning via canvas offsets + ResizeObserver, popover toggle/click-outside-close, blur-on-change for selects, localStorage persistence for new control IDs, removed old `clickBehavior` persistence entry
- `js/spectrogram-renderer.js` — Click-to-seek gated by `#mainWindowPlayOnClick` checkbox

---

## Feature Boxes Duplicated onto Minimap

Duplicated the red spectrogram feature boxes onto the waveform minimap so users can see where they've annotated features in the timeline overview. The minimap boxes are true rectangles with both time (X) and frequency (Y) mapping — not just vertical bands.

### Coordinate mapping

- **X (time)**: In windowed modes (scroll/pageTurn), features map to the full data range since the minimap always shows everything. In Region Creation mode, features map to the current viewport (same as how the playhead and selection box work).
- **Y (frequency)**: Uses the same `getYPositionForFrequencyScaled()` function that `drawSavedBox()` uses on the spectrogram — handles linear, logarithmic, and square root frequency scales, plus playback rate stretching. Just passes the minimap canvas height instead of the spectrogram canvas height.

### Drawing style

Matches the spectrogram exactly:
- Red border (`#ff4444`, 1.5px stroke)
- Semi-transparent red fill (`rgba(255, 68, 68, 0.2)`)
- Feature number labels (`1.1`, `1.2`, etc.) in 10px font (scaled down from 16px on the spectrogram)
- Minimum 2px dimensions enforced so tiny features stay visible at full zoom-out

### Integration

Added `drawMinimapFeatureBoxes()` in `drawWaveformOverlays()`, drawn after the viewport indicator but before region highlights and the playhead — so boxes sit under the dim overlay and don't obscure the playhead. Renders on every overlay pass (which runs on every frame during playback, every scroll event, every zoom change, etc.), reading directly from `getRegions()` which was already imported.

### Files Changed (Session 7 — Minimap Feature Boxes)

- `js/waveform-renderer.js` — New `drawMinimapFeatureBoxes()` function, `getYPositionForFrequencyScaled` import from `spectrogram-axis-renderer.js`, called from `drawWaveformOverlays()`

---

## Main Window Gear: "Click" Mode Dropdown

Replaced the "Play on click" checkbox in the main window gear popover with a "Click:" dropdown offering two modes:

- **Play audio** (default): Clicking the spectrogram seeks to that position and starts playback (previous behavior)
- **Draw feature**: Clicking and dragging draws a feature box on the spectrogram

### Begin Analysis integration

When the user clicks "Begin Analysis", the dropdown auto-switches to "Draw feature" mode so they can immediately start annotating without manually changing the gear setting.

### Files Changed (Session 8 — Click Mode Dropdown)

- `emic_study.html` — Replaced `#mainWindowPlayOnClick` checkbox with `#mainWindowClick` select dropdown
- `js/main.js` — `mainWindowClick` persistence via localStorage, Begin Analysis sets dropdown to `drawFeature`
- `js/spectrogram-renderer.js` — Click handler checks `mainWindowClick` value instead of checkbox

---

## Standalone Features & Flat Numbering (Region-Free Feature Drawing)

### The problem

In windowed modes (scroll/pageTurn), there are no regions — the entire dataset is the viewport. But the feature drawing system required an active region to store features inside (`region.features[]`). Drawing a feature box triggered "No active region - cannot create feature".

### Standalone features — no regions required

Added a new `standaloneFeatures[]` array in `region-tracker.js` that stores features independently of regions. In windowed mode with "Draw feature" selected, drawing a box creates a standalone feature directly — no auto-created regions, no lazy workarounds.

Each standalone feature has the same shape as region features: `{ type, repetition, lowFreq, highFreq, startTime, endTime, notes, speedFactor }`. They're persisted to localStorage with a `_standalone` suffix on the storage key.

### How it works

In `handleSpectrogramSelection()`, when `activeRegionIndex === null` and we're in windowed + draw-feature mode, `regionIndex` is set to `-1` (sentinel value). After coordinate conversion, the feature is pushed to `standaloneFeatures[]` via `addStandaloneFeature()` instead of into a region's features array.

### Flat sequential numbering

All features — both region-based and standalone — are now numbered with a single flat sequence (1, 2, 3...) instead of the old region.feature format (1.1, 1.2, 2.1...).

`getFlatFeatureNumber(regionIndex, featureIndex)` counts features across all regions first, then standalone features continue the sequence. `regionIndex === -1` indicates a standalone feature.

Updated in all rendering paths:
- Canvas box labels (`drawSavedBox` in spectrogram-renderer.js)
- DOM feature box labels (`addFeatureBox` in spectrogram-feature-boxes.js)
- Minimap feature box labels (`drawMinimapFeatureBoxes` in waveform-renderer.js)
- Sidebar feature labels (`renderFeatures` in region-tracker.js)

### Sidebar rendering

`renderStandaloneFeaturesList()` renders standalone features in the regions list container with type/repetition dropdowns, notes textarea, and delete buttons. Changes auto-persist to localStorage.

### Canvas box rebuild

`rebuildCanvasBoxesFromFeatures()` now includes standalone features (with `regionIndex: -1`) alongside region features, so they appear as red boxes on the spectrogram and minimap.

### Architecture note

This is a stepping stone toward completely removing the regions panel in windowed mode. Features now exist as first-class entities independent of regions.

### Files Changed (Session 8 — Standalone Features & Flat Numbering)

- `js/region-tracker.js` — `standaloneFeatures[]` storage, `getStandaloneFeatures()`, `addStandaloneFeature()`, `deleteStandaloneFeature()`, `saveStandaloneFeatures()`, `loadStandaloneFeatures()`, `renderStandaloneFeaturesList()`, `getFlatFeatureNumber()`, standalone branch in `handleSpectrogramSelection()`
- `js/spectrogram-renderer.js` — `rebuildCanvasBoxesFromFeatures()` includes standalone features, `drawSavedBox()` uses flat numbering, imports `getStandaloneFeatures`/`getFlatFeatureNumber`
- `js/spectrogram-feature-boxes.js` — `addFeatureBox()` and `renumberFeatureBoxes()` use flat numbering
- `js/waveform-renderer.js` — `drawMinimapFeatureBoxes()` draws standalone features, uses flat numbering
