# Background Data Cache

## Problem

The app can only hold one dataset at a time. When a study has multiple analysis steps with different date ranges (e.g., Aug 17-20 and Jan 14-17), the second step must re-download all its data from R2 when the user reaches it. There's no persistent cache — fetched chunks are decoded, rendered, and lost when the next dataset loads.

## Goal

Download data chunks in the background and store them in a persistent browser cache. When an analysis step activates, it checks the cache first and only hits the network for missing chunks. Multi-step studies feel instant because the data is already local.

## Current Flow

```
study-flow.js → applyAnalysisConfig(step)     # sets spacecraft/dates/source
             → startStreaming()                # clears everything, fetches from R2
             → goes-cloudflare-fetcher.js      # fetches chunks sequentially
             → decode → render → display
```

- `startStreaming()` destroys previous dataset (spectrogram, waveform, audio context, zoom state)
- No caching layer — chunks fetched via `fetch()` with no persistence
- Browser HTTP cache may help on re-fetch, but no guarantee (depends on R2 cache headers)
- `triggerPreloadForStep()` calls `startBtn.click()` which runs the full destructive pipeline

## Proposed Architecture

### Cache Layer (Cache API)

Use the browser [Cache API](https://developer.mozilla.org/en-US/docs/Web/API/Cache) — designed for exactly this. Persistent, per-origin, URL-keyed, browser-managed eviction.

```
┌─────────────────────────────────────────────────┐
│ study-flow.js                                    │
│                                                  │
│  initDataPreload()                               │
│    ├─ step 1: backgroundDownload(step)           │
│    └─ step 2: backgroundDownload(step)           │
│                                                  │
│  backgroundDownload(step):                       │
│    1. Compute chunk URLs for date range          │
│    2. For each chunk:                            │
│       - Check cache: caches.match(url)           │
│       - If miss: fetch(url) → cache.put(url, r)  │
│       - No decoding, no rendering                │
│    3. Fire event: 'preload-complete-{stepIndex}' │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│ goes-cloudflare-fetcher.js (modified)            │
│                                                  │
│  fetchChunk(url):                                │
│    1. Check cache: caches.match(url)             │
│    2. If hit: return cached response             │
│    3. If miss: fetch(url) → cache.put → return   │
└─────────────────────────────────────────────────┘
```

### Cache Key Strategy

Cache name: `sw-audio-data-v1`

Keys are the raw R2 URLs:
```
https://spaceweather.now.audio/api/goes/DN_MAGN-L2-HIRES_G16/2022-08-17T00:00:00Z/2022-08-17T06:00:00Z
```

No need for custom keying — the URL already encodes spacecraft, dataset, and time range.

### Background Download Function

New module: `js/background-preloader.js`

```js
const CACHE_NAME = 'sw-audio-data-v1';

export async function backgroundDownload(step) {
    const urls = computeChunkUrls(step);  // same logic as goes-cloudflare-fetcher
    const cache = await caches.open(CACHE_NAME);

    let cached = 0, fetched = 0;
    for (const url of urls) {
        const hit = await cache.match(url);
        if (hit) { cached++; continue; }

        try {
            const resp = await fetch(url);
            if (resp.ok) {
                await cache.put(url, resp);
                fetched++;
            }
        } catch (e) {
            console.warn(`⬇️ Background fetch failed: ${url}`, e);
        }
    }

    console.log(`⬇️ Background download: ${cached} cached, ${fetched} fetched, ${urls.length} total`);
}
```

### Integration with Fetcher

Modify `goes-cloudflare-fetcher.js` to check cache before network:

```js
async function fetchChunk(url) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(url);
    if (cached) return cached;

    const resp = await fetch(url);
    if (resp.ok) cache.put(url, resp.clone());
    return resp;
}
```

### Integration with Study Flow

In `initDataPreload()`:

```js
if (step.dataPreload === 'pageLoad') {
    // Background download — doesn't touch renderer
    backgroundDownload(step);
}
```

When the user actually enters the analysis step, `startStreaming()` runs as normal but every chunk fetch is a cache hit → effectively instant.

### Chunk URL Computation

Need to extract the URL-building logic from `goes-cloudflare-fetcher.js` into a shared function that both the fetcher and the background preloader can use. This is the main refactor needed — currently the chunk boundaries and URL construction are buried inside the streaming pipeline.

Key inputs: spacecraft, dataset, startTime, endTime, chunk duration (6h default for GOES).

## D1 Integration

The background cache is browser-side only. D1's role:

- **Study config** (already done): stores `dataPreload` setting per analysis step
- **Cache manifest** (future, optional): D1 could store a pre-computed list of chunk URLs per study, so the background preloader doesn't need to compute them client-side
- **Cache status tracking** (future, optional): D1 could track which participants have successfully cached data, useful for diagnostics

## Migration Steps

1. **Extract chunk URL computation** from `goes-cloudflare-fetcher.js` into shared utility
2. **Create `background-preloader.js`** — downloads chunks to Cache API without rendering
3. **Modify fetcher** to check Cache API before network (`fetchChunk` wrapper)
4. **Update `initDataPreload`** to use background download instead of `startBtn.click()`
5. **Test**: two analysis steps with different date ranges, verify step 2 loads from cache

## Considerations

- **Storage limits**: Cache API typically allows ~50MB-1GB+ per origin (browser-dependent). A 7-day GOES dataset at 6h chunks ≈ 28 chunks × ~2MB = ~56MB. Two datasets ≈ ~112MB. Well within limits.
- **Eviction**: Browser may evict under storage pressure. Not critical — falls back to network fetch.
- **Service Worker**: Not needed. Cache API is available from main thread and web workers.
- **CDAWeb source**: Would need equivalent cache logic if data comes from CDAWeb instead of R2. Same pattern, different URL structure.
- **Cache invalidation**: R2 data is immutable (historical spacecraft data doesn't change), so no invalidation needed. Version the cache name (`v1`) for breaking changes.

---

## Implementation Notes (2026-03-12)

### What Was Done

All 5 migration steps implemented on `feature/browser-cache`:

1. **Extracted chunk URL computation** → `js/chunk-url-utils.js`
   - Exports: `fetchAllDayMetadata`, `buildChunkSchedule`, `resolveStepParams`
   - Exports shared constants: `WORKER_BASE`, `INSTRUMENT_SAMPLE_RATE`, `DATASET_TO_SATELLITE`, `COMPONENT_MAP`
   - `resolveStepParams(step)` maps study step config → `{ satellite, component, dataset, startTimeISO, endTimeISO }`

2. **Created `js/background-preloader.js`**
   - `backgroundDownload(step, signal)` — fetches all chunks for a step into Cache API, no decoding/rendering
   - `fetchWithCache(url, opts)` — drop-in fetch wrapper that checks cache first
   - Cache name: `sw-audio-data-v1`
   - Dispatches `preload-complete` event on window when done

3. **Modified `js/goes-cloudflare-fetcher.js`**
   - Replaced inline constants with imports from `chunk-url-utils.js`
   - Added `fetchChunk(url, signal)` that checks Cache API before network
   - Replaced `fetch(chunk.url, ...)` call in download loop with `fetchChunk()`
   - Imported `CACHE_NAME` from `background-preloader.js` for consistent cache name

4. **Updated `js/study-flow.js`**
   - `initDataPreload()` now calls `backgroundDownload(step)` for `pageLoad` preloads instead of `triggerPreloadForStep()` (which called `startBtn.click()` and ran the full destructive pipeline)
   - `step:N` trigger preloads also use `backgroundDownload()` instead of `triggerPreloadForStep()`

### Files Changed

| File | Change |
|------|--------|
| `js/chunk-url-utils.js` | **NEW** — shared chunk URL computation |
| `js/background-preloader.js` | **NEW** — Cache API background downloader |
| `js/goes-cloudflare-fetcher.js` | Import shared utils, add cache-aware `fetchChunk()` |
| `js/study-flow.js` | Import `backgroundDownload`, replace `triggerPreloadForStep` calls |

### Review Notes

- The `buildChunkSchedule` algorithm in `chunk-url-utils.js` is an exact copy of the one in `goes-cloudflare-fetcher.js`. The fetcher still has its own copy (used in the rendering pipeline with metadata it fetches itself). Future cleanup could have the fetcher import it from the shared module, but that would require refactoring metadata flow.
- `fetchWithCache` in `background-preloader.js` and `fetchChunk` in `goes-cloudflare-fetcher.js` do the same thing. The fetcher uses its own version for tighter abort signal handling. Could be unified later.
- The background preloader defaults to component `bx` (index 0). If a study step specifies a different component, it should set `componentIndex` in the step config.
- No service worker needed — Cache API works from the main thread.
