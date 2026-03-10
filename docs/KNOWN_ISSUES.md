# Known Issues

## Tile Boundary Discontinuities on FFT Size Change

**Status:** Open
**Severity:** Visual artifact (does not affect data integrity)
**Repro:** Change FFT size via dropdown while viewing spectrogram, then observe tile boundaries.

### Symptoms
- Spectral features (e.g., swept tones) show vertical jumps at hourly tile boundaries
- Worse with larger FFT sizes (8192 >> 4096 >> 2048 >> 1024)
- A vertical jump = time lost at the boundary (the tone rises more than expected across the gap)
- **First render after page load is correct** — issue only appears after changing FFT size

### What We Know
- All computed metadata is correct: GAP = 0.000000s between adjacent tiles
- `actualFirstColSec` / `actualLastColSec` match `startSec` / `endSec` for interior tiles
- Mesh positions correctly abut with no gap
- Tile textures are 1024 columns wide as expected
- The GPU compute shader produces correct output (first render is perfect)
- Half-texel UV inset was added to prevent linear filter bleeding at tile edges

### Root Cause (Partially Identified)
During FFT size change, the `changeFftSize` path runs `renderCompleteSpectrogramForRegion` first (region texture on main mesh), then `updateElasticFriendInBackground` rebuilds the pyramid. Diagnostic logging reveals that during the pyramid rebuild, `getVisibleTiles` returns 0 tiles for most of the compute duration — viewport tiles are computed late despite `viewCenterSec` priority ordering. When tiles finally become visible, only 2-3 get their GPU texture swap (`queueGPUTextureSwap` → `processPendingGPUTextureSwaps`). Remaining tiles display with unfilled shell DataTexture data.

The GPU texture copy mechanism (`copyTextureToTexture` from compute GPUTexture → Three.js texture) works correctly on initial page load but has a timing/ordering issue during FFT size changes where tiles arrive while the render pipeline is in a transitional state.

### Workaround
Refresh the page after changing FFT size. The fresh render will be correct.

### Diagnostic Prints
Gated behind `window.pm?.gpu` (enable GPU prints in Settings drawer):
- `⚠️ PARTIAL TILE` — tiles rendered with <100% data (spectrogram-pyramid.js)
- `🔍 TILE BOUNDARY` — sample boundary alignment check (spectrogram-pyramid.js)
- `🔍 MESH` — tile mesh positions and texture dimensions (main-window-renderer.js)
- `🖼️ Display` — display mode transitions: tiles/full/region (main-window-renderer.js)

### Files Involved
- `js/main-window-renderer.js` — tile mesh creation, GPU texture swap, display switching
- `js/spectrogram-pyramid.js` — tile computation, metadata, texture cache
- `js/spectrogram-gpu-compute.js` — GPU FFT compute shaders
- `js/spectrogram-renderer.js` — `changeFftSize()` orchestration
