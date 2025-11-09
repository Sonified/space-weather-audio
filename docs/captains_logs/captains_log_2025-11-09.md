# Captain's Log - 2025-11-09

## Session: Progressive Waveform Drawing - v1.68

### Major Feature: Left-to-Right Progressive Waveform Rendering

#### Problem: Waveform Not Drawing Progressively
The waveform worker was spreading accumulated samples across the entire canvas width, rather than filling left-to-right as chunks arrived in temporal order.

**Issues**:
1. Progressive chunks arriving out of order (due to parallel downloads)
2. Worker building waveform for all samples across full canvas width
3. No visual crossfade between loading state and final detrended waveform
4. Duplicate samples being sent to worker (doubled from 300k to 600k)

#### Solution: Temporal Order + Effective Width + Crossfade

**1. Temporal Ordering (index.html)**
```javascript
// Track which chunks to send to waveform worker in order
let nextWaveformChunk = 0;

// Send all consecutive chunks that are ready, starting from nextWaveformChunk
while (nextWaveformChunk < chunksToFetch.length && processedChunks[nextWaveformChunk]) {
    const chunk = processedChunks[nextWaveformChunk];
    waveformWorker.postMessage({
        type: 'add-samples',
        samples: chunk.samples,
        rawSamples: chunk.rawSamples
    });
    nextWaveformChunk++;
}
```

**2. Progressive Left-to-Right Filling (waveform-worker.js)**
```javascript
// Calculate effective width based on samples received so far
const effectiveWidth = totalExpectedSamples 
    ? Math.floor((displaySamples.length / totalExpectedSamples) * canvasWidth)
    : canvasWidth;

const waveformData = buildMinMaxWaveform(displaySamples, effectiveWidth);
```

**3. Smooth Crossfade (index.html)**
```javascript
// When final detrended waveform arrives, crossfade from gray to pink
if (isShowingFinalWaveform && cachedWaveformCanvas) {
    // 300ms crossfade animation
    ctx.globalAlpha = 1.0 - progress; // Old gray fades out
    ctx.drawImage(oldCanvas, 0, 0);
    
    ctx.globalAlpha = progress; // New pink fades in
    ctx.drawImage(newCanvas, 0, 0);
}
```

**4. First 3 Chunks Download Individually**
To ensure fast audio startup with 30 minutes of runway:
```javascript
// First 3 ten-minute chunks download individually for runway
const isFirst3TenMinute = (currentType === '10m' && chunksOfTypeProcessed < 3);

if (isFirst3TenMinute) {
    // Always flush after 1 chunk for first 3 ten-minute chunks
    batches.push([...remainingInType]);
    chunksOfTypeProcessed++;
}
```

---

### Implementation Details

#### Progressive Rendering Flow
1. **Download**: Chunks download in parallel batches (optimized for speed)
2. **Store**: Chunks stored in `processedChunks[chunkIndex]` as they arrive
3. **Order**: `while` loop sends chunks to waveform worker in temporal order (0, 1, 2, 3...)
4. **Accumulate**: Worker accumulates samples (60k → 120k → 180k → 240k → 300k)
5. **Build**: Every 3 chunks, worker builds waveform for accumulated samples
6. **Fill**: Worker calculates `effectiveWidth` to fill only left portion (e.g., 60k/300k = 20% of canvas)
7. **Draw**: Main thread draws gray waveform progressively filling left-to-right
8. **Complete**: All chunks arrive → worker applies DC removal → 300ms crossfade to pink waveform

#### Batch Pattern (with runway optimization)
**Example: 2-hour request (6×10m + 6×1h)**

**10m chunks (runway building)**:
- Batch 1: `[0]` alone → Start audio playback!
- Batch 2: `[1]` alone → 20 minutes runway
- Batch 3: `[2]` alone → 30 minutes runway ✅
- Batch 4: `[3]` alone 
- Batch 5: `[4, 5]` parallel ← Progressive batching starts

**1h chunks (type change, reset)**:
- Batch 6: `[0]` alone
- Batch 7: `[1, 2]` parallel
- Batch 8: `[3, 4, 5]` parallel

---

### Bug Fixes

**Bug 1: Duplicate Samples in Worker**
- **Problem**: `buildCompleteWaveform` was re-sending all samples to worker, causing 600k total (300k × 2)
- **Fix**: Worker already has samples from progressive updates, just trigger final build with DC removal

**Bug 2: Waveform Not Respecting Temporal Order**
- **Problem**: Sending chunks to waveform worker as they arrive (out of order)
- **Fix**: Only send consecutive chunks starting from `nextWaveformChunk`

**Bug 3: Full Canvas Spread Instead of Progressive Fill**
- **Problem**: Worker spreading samples across full canvas width
- **Fix**: Calculate `effectiveWidth` based on `samplesReceived / totalExpectedSamples`

---

### Performance Results

**Progressive Loading (Gray Waveform)**:
- Chunk 0 (60k samples): Draws 452 pixels on left (17% of canvas) - **1ms**
- Chunk 0-2 (180k samples): Draws 1,358 pixels on left (50% of canvas) - **3ms**
- Visual feedback: User sees waveform building left-to-right as chunks arrive

**Final Complete (Pink Waveform)**:
- All chunks (300k samples): Full canvas width (2,716 pixels) - **9ms** (with DC removal)
- Crossfade animation: **300ms** smooth transition from gray to pink

**Total Time**: First waveform visible in ~230ms, final detrended waveform at ~313ms

---

### Files Modified

**Frontend**:
- `index.html` - Temporal ordering, crossfade animation, first 3 chunks individually
- `waveform-worker.js` - Effective width calculation for progressive left-to-right fill

---

### Version: v1.68

**Commit Message**: v1.68 Feature: Progressive left-to-right waveform drawing with smooth crossfade to detrended version, first 3 chunks download individually for fast runway

**Key Features**:
- ✅ Progressive waveform fills left-to-right as chunks arrive (gray)
- ✅ Smooth 300ms crossfade to final detrended waveform (pink)
- ✅ First 3 ten-minute chunks download individually (30-minute runway)
- ✅ Min/max pre-processing for efficiency (2,716 pixels vs 300k samples)
- ✅ Temporal ordering ensures correct left-to-right progression
- ✅ No duplicate samples sent to worker

---

### What's Next

**Potential Future Optimizations**:
1. **Adaptive crossfade duration** - Scale based on waveform complexity
2. **Waveform caching** - Cache processed waveforms in IndexedDB
3. **Progressive DC removal** - Show approximate detrending during loading
4. **Batch size optimization** - Dynamic batching based on network speed

---

## Session: Bug Fixes - v1.69 & v1.70

### v1.69: Critical Bug - Final Waveform Not Building

**Problem**: The final detrended waveform (pink) was never being built, leaving only the progressive gray waveform visible.

**Root Cause**: Race condition in completion detection:
1. `isFetchingNewData` flag was set to `true` at start of `startStreaming()`
2. Completion handler checked `!isFetchingNewData` before running
3. `isFetchingNewData` was only set to `false` INSIDE the completion handler
4. Catch-22: completion handler couldn't run because flag was true, but flag couldn't be set to false until handler ran

**Additional Issues**:
- `chunksReceived` counter could exceed `chunksToFetch.length` (e.g., 13/12) due to realistic chunk being processed twice
- Completion check relied on `chunksReceived === chunksToFetch.length`, which failed when count exceeded expected
- Missing chunks weren't detected properly

**Solution**:
1. **Removed `isFetchingNewData` check** from completion condition - `completionHandled` flag is sufficient to prevent duplicates
2. **Check `allChunksPresent` on every message** - Verify all chunks 0-N are actually in `processedChunks` array
3. **Added debug logging** - Log completion check status to diagnose issues
4. **Fixed waveform length mismatch** - Final waveform now uses actual sample count (`completeSamplesArray.length`) instead of theoretical total

**Code Changes**:
```javascript
// OLD (broken):
if (chunksReceived === chunksToFetch.length && allChunksPresent && !isFetchingNewData && !completionHandled)

// NEW (fixed):
const allChunksPresent = chunksToFetch.every((_, idx) => processedChunks[idx] !== undefined);
if (allChunksPresent && !completionHandled) {
    completionHandled = true;
    // ... completion logic
}
```

**Result**: Final detrended waveform now builds correctly and crossfades from gray to pink as intended.

### v1.70: Playback Speed Not Preserved

**Problem**: When starting a new fetch, playback speed always defaulted to 1.0x, ignoring the user's slider setting.

**Root Cause**: When `initAudioWorklet()` created a new worklet node, it didn't apply the current playback speed from the slider. The worklet constructor defaults to `speed = 1.0`, and no code was setting it to the user's preference.

**Solution**: Call `updatePlaybackSpeed()` immediately after creating the worklet node in `initAudioWorklet()`. This reads the current slider value and sends it to the worklet via `set-speed` message.

**Code Change**:
```javascript
workletNode.connect(gainNode);
gainNode.connect(analyserNode);
gainNode.connect(audioContext.destination);

// Apply current playback speed from slider (preserve user's speed setting)
updatePlaybackSpeed();
```

**Result**: Playback speed is now preserved across new fetches - if user sets 2.0x, new fetches will start at 2.0x.

### Version: v1.70

**Commit Message**: v1.70 Fix: Playback speed now preserved when starting new fetch - apply current slider value to new worklet node

**Key Fixes**:
- ✅ Final detrended waveform builds correctly (v1.69)
- ✅ Completion handler runs when all chunks are present (v1.69)
- ✅ Fixed waveform length mismatch (v1.69)
- ✅ Playback speed preserved across fetches (v1.70)

---
