# Waveform Rendering Optimization — Mipmap + Prefix Sum

## The Problem

Waveform rendering gets slow when zoomed in because every frame scans **all visible samples** to find min/max per pixel. At 10 Hz × 3 days = 2.6M samples, even showing 1% of the data means scanning 26K samples per pixel column. Three bottlenecks:

1. **Per-pixel min/max** — iterating raw samples for each canvas pixel column: O(visible_samples)
2. **Visible range min/max** — scanning all visible samples for Y-axis scaling: O(visible_samples)
3. **Local mean line** (zero-crossing reference) — per-pixel sliding window average: O(pixels × window_size)

Total cost per frame: **O(visible_samples × pixels)** — gets worse the more you zoom in.

## The Solution

Two precomputed acceleration structures, both CPU-side, both cached per `Float32Array` identity via `WeakMap`:

### 1. Min/Max Mipmap Pyramid

Binary tree of min/max pairs. Each level halves the sample count:

```
L0: [2.6M buckets of 2 samples]  → min/max of every pair
L1: [1.3M buckets of 4 samples]  → min/max of every 4
L2: [650K buckets of 8 samples]   → min/max of every 8
...
L21: [1 bucket]                    → global min/max
```

**Build cost**: O(N) — single pass per level, ~50ms for 2.6M samples.
**Memory**: ~2× raw data size across all levels (geometric series converges to 2N).

**Query: range min/max** — O(log N). Walk the largest level whose bucket size fits, scan partial buckets at edges with raw data.

**Query: per-pixel min/max** — O(canvas_width). For each pixel column, pick the level where `bucketSize ≤ samplesPerPixel`, scan at most a few buckets + partial edges.

```javascript
// Pick level where bucketSize ≤ samplesPerPixel
let level = -1;
for (let l = 0; l < mipmap.levels.length; l++) {
    if (mipmap.levels[l].bucketSize <= samplesPerPixel) level = l;
    else break;
}

// For each pixel: align to bucket boundaries, read mipmap for full buckets, raw for partials
const bs = lv.bucketSize;
const firstFull = Math.ceil(startIdx / bs);
const lastFull = Math.floor(endIdx / bs);
// scan raw [startIdx, firstFull*bs)
// scan mipmap [firstFull, lastFull)
// scan raw [lastFull*bs, endIdx)
```

### 2. Prefix Sum (Cumulative Sum)

A Float64Array of length N+1 where `ps[i] = sum(data[0..i))`.

**Build cost**: O(N) — single pass, ~10ms for 2.6M samples.
**Memory**: 2× raw data (Float64 for precision on large sums).

**Query: any window mean** — O(1):
```javascript
function prefixSumMean(ps, start, end) {
    return (ps[end] - ps[start]) / (end - start);
}
```

This replaces the O(window_size) sliding window average for the local mean / zero-crossing reference line. The entire line renders in O(canvas_width) — one O(1) lookup per pixel.

## Caching Strategy

Both structures are cached via `WeakMap` keyed on the `Float32Array` identity:

```javascript
const mipmapCache = new WeakMap();  // Float32Array → { levels }
const prefixSumCache = new WeakMap(); // Float32Array → Float64Array
```

- **Auto-invalidation**: When `processRegion()` creates new arrays (via `normalizeArray()`, `detrend()`, etc.), the old arrays become GC-eligible, and new arrays get fresh caches on first render.
- **No manual cache clearing** needed — WeakMap handles lifecycle automatically.
- **First render** of new data pays the build cost (~60ms total). All subsequent renders (zoom, pan) are instant.

## Performance Summary

| Operation | Before | After |
|-----------|--------|-------|
| Per-pixel waveform | O(visible_samples) | O(canvas_width) |
| Visible range Y-axis | O(visible_samples) | O(log N) via mipmap |
| Local mean line | O(pixels × window) | O(canvas_width) via prefix sum |
| **Total per frame** | **O(samples × pixels)** | **O(canvas_width)** |

At 1920px canvas width, this is the difference between scanning millions of samples and scanning ~2000 values. Zoom level doesn't matter — cost is always proportional to pixels, not data.

## Applicability to Main App

The main app's `minimap-window-renderer.js` and `waveform-worker.js` face the same problem at larger scale (7+ days of data, multiple components). The mipmap approach would:

- Replace the current waveform downsampling in `waveform-worker.js`
- Enable instant zoom/pan on the minimap without re-computing from raw data
- Work alongside the existing GPU spectrogram pipeline (spectrograms need FFT, waveforms just need min/max)

The prefix sum is particularly valuable for the minimap's "current view" indicator and any running-average overlays.

## Reference Implementation

See `spike_review.html` — functions `buildMipmap()`, `mipmapMinMax()`, `mipmapPerPixel()`, `buildPrefixSum()`, `prefixSumMean()`, and their usage in `renderWaveform()`.
