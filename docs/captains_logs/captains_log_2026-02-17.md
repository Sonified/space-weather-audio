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

### What's Next

- Run remaining EMIC study days (Jan 23–27, 2022)
- Wire up browser-side progressive streaming from the `emic-study` R2 bucket
- Adapt `fetchFromR2Worker()` in `data-fetcher.js` to read from the new R2 structure

### Files Changed

- `backend/goes_to_r2.py` — **NEW** — CDAWeb CDF download → chunk → compress → R2 upload pipeline, fill value interpolation
