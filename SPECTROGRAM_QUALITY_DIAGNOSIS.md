# Spectrogram Pyramid Architecture

**Date:** 2026-02-19  
**Branch:** `spectrogram-pyramids`  
**Goal:** Elite spectrogram rendering — sharp at every zoom level, streaming-ready

---

## Architecture: Bottom-Up LOD Pyramid

Build from high-resolution base tiles upward. Data arrives in chunks, each chunk renders immediately, pyramid levels cascade upward by averaging/downsampling.

```
Top (L6):    [=============== full dataset ===============]   1 tile
L5:          [======= half ========][======= half ========]   2 tiles  
L4:          [== qtr ==][== qtr ==][== qtr ==][== qtr ==]    4 tiles
L3:          [2h][2h][2h][2h][2h][2h][2h][2h]...             ~84 tiles
L2:          [1h][1h][1h][1h][1h][1h][1h][1h]...             168 tiles
L1:          [30m][30m][30m]...                               336 tiles  
L0 (base):   [15m][15m][15m][15m]...                          672 tiles
                                                              ↑ highest res
Viewport:    [===]  ← live render for extreme zoom            1 texture
```

### Why 15-Minute Base Tiles (Not 1-Hour)

Robert's question: "At what point is a realistic size render going to give clear quality?"

**The answer is driven by the spectrogram physics:**

With FFT size 2048 and a tile width of 1024 columns:

| Base tile duration | Sec/col | Pixel-perfect at | Quality verdict |
|---|---|---|---|
| 4 hours | 14.1s | ~4.7hr zoom | Instrument lines dotted at <2hr |
| 1 hour | 3.5s | ~1.2hr zoom | Good, but dots at <30min |
| **15 minutes** | **0.88s** | **~17min zoom** | **Solid lines at all practical zooms** |
| 5 minutes | 0.29s | ~6min zoom | Overkill — viewport render handles this |

**15 minutes is the sweet spot.** At 0.88 sec/col:
- Instrument sinusoids (period ~seconds) render as solid lines ✓
- EMIC wave features (minutes-scale) are fully resolved ✓
- No practical zoom level shows dots before viewport render kicks in ✓
- Still reasonable tile count (672 for 7 days) and render time

### Starting Zoomed to 6 Hours

If the default view is 6 hours, the system needs:
- **L0 (base):** 24 tiles of 15 minutes each cover the 6-hour view
- At 1200px canvas: each tile contributes ~50px, with 1024 cols per tile
- That's **~20 cols per pixel** — massively oversampled, GPU downsamples beautifully
- **User sees pixel-perfect spectrogram immediately after tiles render**

As they zoom in from 6 hours:

| Zoom level | What renders | Cols across 1200px | Quality |
|---|---|---|---|
| 6 hours | L0 tiles (24 × 1024 cols) | 24,576 → GPU downsamples | Perfect |
| 3 hours | L0 tiles (12 × 1024 cols) | 12,288 → GPU downsamples | Perfect |
| 1 hour | L0 tiles (4 × 1024 cols) | 4,096 → ~3.4 cols/px | Perfect |
| 30 min | L0 tiles (2 × 1024 cols) | 2,048 → ~1.7 cols/px | Perfect |
| 15 min | L0 tile (1 × 1024 cols) | 1,024 → ~0.85 cols/px | Excellent |
| 5 min | Viewport render (1200 cols) | 1,200 → 1:1 | Pixel-perfect |

**You don't hit any quality degradation until below 15 minutes.** And at that point, the viewport render takes over seamlessly.

As they zoom OUT from 6 hours:

| Zoom level | What renders | Source |
|---|---|---|
| 6 hours | L0 tiles | Base level — best quality |
| 12 hours | L1 tiles (each = 2 averaged L0 tiles) | 2:1 downsample |
| 1 day | L2 tiles (each = 2 averaged L1 tiles) | 4:1 downsample |
| 2 days | L3 tiles | 8:1 downsample |
| 4 days | L4 tiles | 16:1 downsample |
| 7 days (full) | L5 or L6 tile | 32:1 or 64:1 downsample |

---

## Where Quality Degrades (and How to Optimize)

### The Downsampling Question

When building L1 from L0, we combine two 1024-col tiles into one 1024-col tile. Two approaches:

**Option A: Simple decimation (take every other column)**
- Fast, but aliases. A narrow-band feature that falls between sampled columns disappears.
- For spectrograms: bad. Instrument lines could vanish at upper levels.

**Option B: Averaging adjacent column pairs**
- Each L1 column = average of 2 L0 columns' magnitudes
- Preserves energy, narrow features get halved in amplitude but never disappear
- Slightly softer than L0 at equivalent zoom — but never broken
- **This is the correct approach for magnitude data**

**Option C: Max-pooling (take the brighter of each pair)**
- Preserves peak features (lines stay bright)
- Slightly inflates background noise
- Good for feature detection, but biased

**Recommendation: Option B (averaging) for general use.** The quality loss per level:
- L0 → L1: 2:1 averaging, ~3dB softer on narrow features. Barely visible.
- L1 → L2: another 2:1. Now 4:1 from base. Features still clearly visible.
- L2 → L3: 8:1 from base. Starting to soften. Still good for navigation.
- L5+: 32:1+. Overview quality. Fine for zoomed-out navigation.

**The key insight: by the time averaging degrades quality noticeably (L3+), you're zoomed out far enough that the softening doesn't matter. The details you'd notice are too small to see at that zoom level anyway.**

### Optimizing the Optimization

1. **Render base tiles first for the initial viewport (6-hour window)**
   - 24 tiles × 1024 FFTs each = 24,576 FFTs total
   - With 7 web workers: ~3,500 FFTs per worker
   - At ~0.1ms per FFT: ~350ms total. Fast enough for initial load.

2. **Build upper levels lazily**
   - L1 from L0: just array averaging, microseconds per tile
   - Don't build L4+ until user actually zooms out that far

3. **For streaming data arrival:**
   - Each 15-min chunk arrives → render L0 tile → cascade upward
   - Visible portion updates immediately
   - Upper levels update as pairs complete

4. **Texture atlas instead of individual textures:**
   - Pack multiple tiles into one large GPU texture (e.g., 4096×1024)
   - Each 1024-wide tile = one horizontal strip
   - 4 tiles per atlas texture
   - Reduces GPU texture bind calls during rendering
   - At L0 with 672 tiles: 168 atlas textures (only ~4-8 loaded at once)

---

## Memory Budget

| What | Size | Notes |
|---|---|---|
| L0 tiles (visible, ~8) | 32 MB | 8 × 1024 × 1024 × 4 bytes |
| L0 tiles (prefetched neighbors, ~8) | 32 MB | Smooth panning |
| L1-L6 tiles (visible, ~12) | 48 MB | All upper levels combined |
| Viewport render texture | 4.7 MB | 1200 × 1024 × 4 |
| **Total active** | **~120 MB** | Constant regardless of dataset length |

Tiles not near the viewport are disposed. Memory stays flat whether dataset is 1 day or 30 days.

---

## Pyramid Levels (7-Day Dataset, 15-Min Base)

| Level | Tile duration | Tiles for 7 days | Sec/col (1024 cols) | Sharp at zoom |
|---|---|---|---|---|
| **L0 (base)** | **15 min** | **672** | **0.88s** | **~17 min** |
| L1 | 30 min | 336 | 1.76s | ~35 min |
| L2 | 1 hour | 168 | 3.5s | ~1.2 hr |
| L3 | 2 hours | 84 | 7s | ~2.3 hr |
| L4 | 4 hours | 42 | 14s | ~4.7 hr |
| L5 | 8 hours | 21 | 28s | ~9.3 hr |
| L6 | 16 hours | ~11 | 56s | ~18.7 hr |
| L7 | 32 hours | ~6 | 112s | ~37 hr |
| L8 | 64 hours | ~3 | 225s | ~3.1 days |
| L9 (top) | full span | 1 | ~590s | 7 days |
| **Viewport** | any | 1 | pixel-perfect | < 17 min |

**10 pyramid levels + viewport render = sharp at literally every zoom level.**

---

## Implementation Plan

### Phase 1: Pyramid Tile Manager
New module: `js/spectrogram-pyramid.js`
- `PyramidTileCache` class: manages tile creation, caching, disposal
- Tile structure: `{ level, index, startSec, endSec, magnitudeData, texture, ready }`
- LRU eviction: keep ~30-40 tiles max, evict furthest from viewport
- Level picking: given viewport [startSec, endSec] and canvasWidth, pick optimal level

### Phase 2: Base Tile Renderer  
- Renders L0 tiles from audio data using existing worker pool
- Priority queue: tiles overlapping current viewport first, then outward
- Progress callback for loading UI

### Phase 3: Pyramid Builder
- When two adjacent tiles at level N are ready, build level N+1 tile
- Downsampling: average magnitude pairs (or max-pool, configurable)
- Cascades upward automatically

### Phase 4: Viewport Integration
- Replace tile rendering in `spectrogram-three-renderer.js`
- Level picker selects tiles where cols/pixel ≥ 1 (never undersample)
- During active zoom: instantly switch to best available level
- On zoom settle: viewport render for extreme deep zoom

### Phase 5: Streaming Support
- Hook into data arrival events
- Render base tiles incrementally as chunks arrive
- Pyramid cascades upward progressively

---

## What Gets Removed

- `renderTilesInBackground()` — replaced by pyramid builder
- `tileCache[]`, `tileMeshes[]` — replaced by `PyramidTileCache`
- `tilesOutresolveRegion()` — no longer needed, pyramid always has right level
- `getVisibleTiles()`, `tilesCoverViewport()` — replaced by pyramid level picker
- Tile fragment shader — reused but with pyramid-aware UV mapping
- `upgradeFullTextureToHiRes()` — pyramid L9 replaces this

**The tile shader, mesh system, and GPU rendering pipeline stay.** Only the data management and level selection change.

---

*Architecture spec by Nova, 2026-02-19*
