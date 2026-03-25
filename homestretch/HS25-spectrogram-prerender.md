# HS25: Spectrogram Pre-rendering Investigation

## Current Rendering Pipeline

### Data Flow: Data Arrival → FFT → Pyramid → Display

```
study-flow.js::runAnalysis()
  ├── applyAnalysisConfig(step)           // sets spacecraft, dates, dataset (line ~1984)
  ├── overlay fade-out (300ms)            // hides welcome modals (line ~2025)
  ├── window.triggerDataRender()          // or startBtn.click() (line ~2045-2055)
  │
  └─→ goes-cloudflare-fetcher.js         // streams chunks from Cloudflare R2
       ├── chunk arrives → processedChunks[]
       ├── growProgressiveBuffer()         // accumulates into Float32Array
       └── renderProgressiveSpectrogram()  // main-window-renderer.js:2639
            │
            ├── FIRST CALL (progressiveInitDone = false):
            │   ├── initThreeScene()              // WebGPU renderer + materials
            │   ├── initPyramid(duration, sr)     // pyramid structure (no data yet)
            │   ├── setOnTileReady(callback)       // wires tile→render updates
            │   ├── initScrollZoom()
            │   └── progressiveInitDone = true
            │
            ├── EVERY CALL:
            │   ├── minimap FFT (full-view texture for navigation bar)
            │   ├── uploadMainWaveformSamples()
            │   ├── uploadWaveformSamples() → drawWaveformFromMinMax()
            │   └── renderBaseTiles(audioData, sr, fftSize, 0)  ← THE KEY CALL
            │       ├── GPU compute FFT per tile (spectrogram-gpu-compute.js)
            │       ├── cascadeUpward() builds L1+ from L0 pairs
            │       └── onTileReady → renderFrame() shows tiles
            │
            └── FINAL CALL (isComplete = true):
                ├── setSuppressPyramidReady(false)
                └── dispatches 'pyramid-ready' + 'spectrogram-ready' events
```

### Key File References

| Step | File | Line | Function |
|------|------|------|----------|
| Analysis entry | `study-flow.js` | ~1970 | `runAnalysis(step)` |
| Config applied | `study-flow.js` | ~1284 | `applyAnalysisConfig(step)` |
| Data trigger | `study-flow.js` | ~2045 | `triggerDataRender()` or `startBtn.click()` |
| Progressive render | `main-window-renderer.js` | 2639 | `renderProgressiveSpectrogram()` |
| Pyramid init | `spectrogram-pyramid.js` | ~127 | `initPyramid()` |
| Base tile FFT | `spectrogram-pyramid.js` | ~240 | `renderBaseTiles()` |
| GPU FFT compute | `spectrogram-gpu-compute.js` | ~315 | `processTiles()` / `processTilesZeroCopy()` |
| Tile display | `main-window-renderer.js` | ~2071 | `tryUseTiles()` |

## Where Rendering Is Currently Triggered in study-flow.js

In `runAnalysis()` (~line 2045):

```js
// Trigger data fetch/render
if (typeof window.triggerDataRender === 'function') {
    window.triggerDataRender();
} else {
    const startBtn = document.getElementById('startBtn');
    if (startBtn && !startBtn.disabled) {
        startBtn.click();
    }
}
```

This triggers `goes-cloudflare-fetcher.js` to start streaming data, which calls `renderProgressiveSpectrogram()` as chunks arrive. The spectrogram tiles are computed AND displayed simultaneously — there's no separation between compute and show.

## Data Preloading (Already Exists)

The study config already supports data preloading via `step.dataPreload`:
- `'pageLoad'` — fetch data immediately on page load (`study-flow.js` ~866)
- `'step:N'` — fetch when step N begins (`study-flow.js` ~877)

**This preloads the RAW DATA (Cloudflare fetch), not the spectrogram tiles.** The spectrogram FFT/pyramid computation only happens when `renderProgressiveSpectrogram()` is called during analysis entry.

## Proposed Hook Point for Background Pre-rendering

### The Opportunity

Between data preload completing and analysis starting, there's a window where:
1. Raw audio data sits in memory (from `prefetchCloudflareData()`)
2. User is clicking through welcome/info modals
3. GPU is idle

### Proposed Hook: After Data Preload Completes

In `goes-cloudflare-fetcher.js`, after the data stream completes and `State.completeSamplesArray` is set (around line ~1047), **if rendering mode is `'triggered'`**, the code waits for `triggerDataRender()`. This is exactly when we could start background pre-rendering.

**New function needed: `preRenderSpectrogramTiles(audioData)`**

This would:
1. Call `initThreeScene()` (if not done)
2. Call `initPyramid()` + `renderBaseTiles()` to compute FFT tiles
3. Set `setSuppressPyramidReady(true)` so tiles compute but don't trigger display
4. Store tiles in the pyramid cache (they're already in GPU memory via the tile LRU)

**When analysis starts:** Instead of computing tiles from scratch, just:
1. Set up the viewport/camera
2. Call `renderFrame()` — tiles are already in the pyramid cache
3. Fire `'pyramid-ready'` event

### Where to Hook in study-flow.js

In `runCurrentStep()` (~line 1598), when entering a modal step that precedes an analysis step:

```js
// In runCurrentStep(), after checking preload triggers:
if (step.type === 'modal' || step.type === 'info') {
    // Check if the NEXT analysis step's data is already loaded
    const nextAnalysisIdx = findNextAnalysisStepIndex(currentStepIndex);
    if (nextAnalysisIdx !== -1 && isDataPreloaded(nextAnalysisIdx)) {
        backgroundPreRenderTiles(nextAnalysisIdx);
    }
}
```

Alternatively, listen for data preload completion:
```js
window.addEventListener('data-preload-complete', (e) => {
    const { stepIndex } = e.detail;
    backgroundPreRenderTiles(stepIndex);
});
```

## How to Separate "Compute" from "Show"

### Current State: Tightly Coupled

`renderProgressiveSpectrogram()` does both:
- **Compute:** `renderBaseTiles()` → GPU FFT → pyramid cascade
- **Show:** `setOnTileReady()` callback → `renderFrame()` → visible tiles

### Proposed Separation

**Step 1: New function `computePyramidTilesOnly(audioData, step)`**

```js
export async function computePyramidTilesOnly(audioData, dataDurationSec, sampleRate, fftSize) {
    await initThreeScene();
    
    // Initialize pyramid structure
    setTileDuration('adaptive', dataDurationSec, audioData.length);
    initPyramid(dataDurationSec, sampleRate);
    
    // Suppress all display callbacks
    setSuppressPyramidReady(true);
    const savedCallback = onTileReady;  // needs to be exported or accessed
    setOnTileReady(null);  // no render triggers
    
    // Compute tiles (GPU FFT + cascade)
    await renderBaseTiles(audioData, sampleRate, fftSize, 0);
    
    // Restore callback (will be set properly when analysis starts)
    setOnTileReady(savedCallback);
}
```

**Step 2: Modified `renderProgressiveSpectrogram()` for pre-rendered case**

Add a check at the top:
```js
if (pyramidAlreadyComputed()) {
    // Skip FFT — just set up viewport, waveform, and show tiles
    updateSpectrogramViewportFromZoom();
    renderFrame();
    setSuppressPyramidReady(false);
    window.dispatchEvent(new Event('pyramid-ready'));
    return;
}
```

### What Needs to Change

1. **`spectrogram-pyramid.js`**: `renderBaseTiles()` already supports `onTileReady = null` suppression. The `setSuppressPyramidReady()` function exists. Need to add a way to check if tiles are already computed (`pyramidReady` flag — already exists via `getStatus()`).

2. **`main-window-renderer.js`**: `renderProgressiveSpectrogram()` needs a fast path that skips FFT when pyramid is pre-computed. The `progressiveInitDone` flag can be leveraged.

3. **`study-flow.js`**: Need to trigger pre-rendering after data preload completes, during modal display.

4. **`goes-cloudflare-fetcher.js`**: After preload data is assembled, fire an event with the audio data and metadata so pre-rendering can begin.

## Section 1 vs Section 2 Data

### How Sections Work

Each analysis step has its own config (`step.spacecraft`, `step.startDate`, `step.endDate`, `step.dataSource`). These are different datasets with different time periods.

`applyAnalysisConfig(step)` (study-flow.js ~1288) updates:
- `window.__STUDY_CONFIG` (spacecraft, dataset, startTime, endTime)
- Hidden DOM elements (`#spacecraft`, `#dataType`, `#startDate`, `#endDate`)

### The Problem

When section 2 starts, `runAnalysis()` calls `applyAnalysisConfig()` which changes the global config, then triggers a fresh data fetch. The old pyramid is disposed and a new one is built.

**Currently:** `resetProgressiveSpectrogram()` (main-window-renderer.js:2798) + `disposePyramid()` clear all state between sections.

### Proposed Handling

Pre-render ONLY the tiles for the upcoming section:

1. **Before section 1:** Pre-render using section 1's data (preloaded via `dataPreload: 'pageLoad'` or `dataPreload: 'step:0'`)
2. **Before section 2:** Pre-render using section 2's data (preloaded via `dataPreload: 'step:N'` where N is the last modal before section 2)

The preload system already handles sequential fetching (`processPreloadQueue()` in study-flow.js ~789). We just need to:
- After each preload completes, check if the user is still in a modal phase
- If so, start background pyramid computation for that section's data
- Store pre-rendered pyramids keyed by step index
- When entering analysis, check if a pre-rendered pyramid exists for this step

**Key constraint:** Only ONE pyramid can exist at a time (shared GPU resources, shared scene). So we can only pre-render the NEXT section's tiles, and must dispose when switching to a different section.

### Data Identity

Each section's data is identified by:
- Spacecraft + dataset
- Start time + end time
- Sample rate (derived from spacecraft)

A simple cache key: `${spacecraft}:${dataset}:${startTime}:${endTime}`

## Estimated Complexity and Risks

### Complexity: Medium (2-3 days)

| Component | Effort | Notes |
|-----------|--------|-------|
| `computePyramidTilesOnly()` | Small | Mostly extracting from existing code |
| Fast path in progressive render | Small | Skip FFT when pyramid exists |
| Hook in study-flow.js | Small | Event listener + trigger |
| Event from preload completion | Small | Add CustomEvent dispatch |
| Section-aware cache key | Small | Simple string comparison |
| Testing section transitions | Medium | Must verify dispose/rebuild works |
| Edge cases (resize, abort) | Medium | What if user resizes during pre-render? |

### Risks

1. **GPU memory contention:** Pre-rendering tiles while modals are up shouldn't cause issues since the WebGPU renderer is idle. But if the user has a low-memory GPU, holding two sections' tiles could be a problem. **Mitigation:** Only pre-render the NEXT section.

2. **Race condition:** User clicks through modals faster than tiles can compute. **Mitigation:** Check if pre-render is complete; if not, fall back to normal progressive rendering.

3. **State pollution:** Pre-rendering initializes `progressiveInitDone`, pyramid structure, etc. If the analysis step then tries to re-initialize, it'll skip setup. **Mitigation:** The fast path must ensure all viewport/axis/overlay setup still happens.

4. **Audio data lifecycle:** Pre-rendered tiles reference `State.completeSamplesArray`. Between sections, this gets replaced. **Mitigation:** Tiles store their own magnitude data (Uint8Array or GPU texture), not references to audio samples. Once computed, they're self-contained.

5. **`initThreeScene()` idempotency:** Already guarded by `if (material) return;` — safe to call multiple times. ✅

6. **Waveform not pre-rendered:** This proposal only pre-renders spectrogram tiles, not the waveform overlay or minimap. Those are fast enough to compute on-demand. The spectrogram FFT pyramid is the expensive part.

### Expected Performance Gain

For a typical GOES dataset (~10Hz, 24hr = ~864K samples):
- Current: ~1-3 seconds of GPU FFT computation AFTER analysis starts (user sees loading)
- With pre-render: Tiles ready instantly when analysis starts (computed during 30+ seconds of modal browsing)

The perceived improvement is significant — the spectrogram appears immediately instead of building progressively.
