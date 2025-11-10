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

---

## Session: Railway Backend Fixes - v1.71

### v1.71: Railway Backend Playback + Sample Rate Bug

**Problem 1: Railway Backend Audio Not Playing**
Inactive stations (Mauna Loa, etc.) using Railway backend had visible waveforms but no audio playback.

**Root Cause**: Railway path was missing playback initialization sequence:
1. Never sent `start-immediately` message to worklet
2. Never started audio fade-in
3. Never started position tracking
4. Never started playback indicator animation

**Solution**: Added complete playback startup to Railway path (matching R2 path):
```javascript
// 🎯 FORCE IMMEDIATE PLAYBACK
workletNode.port.postMessage({ type: 'start-immediately' });

// Fade-in audio
gainNode.gain.exponentialRampToValueAtTime(targetVolume, audioContext.currentTime + 0.05);

// Start position tracking
startPositionTracking();
requestAnimationFrame(updatePlaybackIndicator);
```

**Problem 2: Waveform Not Displaying for Railway Backend**
Waveform worker showed "0 samples" even though 180k samples were fetched.

**Root Cause**: Railway path never sent samples to waveform worker. The worker needs `add-samples` messages before `build-waveform`.

**Solution**: Added sample forwarding before drawing:
```javascript
// Send samples to waveform worker BEFORE building waveform
waveformWorker.postMessage({
    type: 'add-samples',
    samples: samples,
    rawSamples: rawSamples  // For drift removal
});
```

**Problem 3: Sample Rate Missing from Station Data**
Shishaldin (50Hz) and other stations were incorrectly requesting files with "100Hz" in the filename.

**Root Cause**: `loadStations()` function created station objects for dropdown but forgot to include `sample_rate` field:
```javascript
// OLD (broken):
seismic: volcanoData.seismic.map(s => ({
    network: s.network,
    station: s.station,
    // ... missing sample_rate!
}))
```

**Solution**: Include `sample_rate` in mapped objects:
```javascript
// NEW (fixed):
seismic: volcanoData.seismic.map(s => ({
    network: s.network,
    station: s.station,
    location: s.location,
    channel: s.channel,
    distance_km: s.distance_km,
    sample_rate: s.sample_rate,  // CRITICAL: Needed for URL construction!
    label: `${s.network}.${s.station}...`
}))
```

### Version: v1.71

**Commit Message**: v1.71 Fix: Railway backend playback + sample rate bug - inactive stations (Mauna Loa, etc.) now work correctly

**Key Fixes**:
- ✅ Railway backend now triggers playback with fade-in
- ✅ Railway backend waveforms display correctly
- ✅ Sample rate properly passed to station data for correct CDN URLs
- ✅ Shishaldin (50Hz), Mauna Loa (100Hz), and all stations work correctly
- ✅ Both R2 progressive and Railway fallback paths functional

**Stations Now Working**:
- Mauna Loa (HV.MOKD, HV.SWRD, HV.WILD) - via Railway backend
- Great Sitkin (AV.GSTD, etc.) - via Railway backend
- Shishaldin (AV.SSLS, AV.SSLN) - via R2 progressive (50Hz fixed!)

---

## Session: Metadata & Binary Filename Migration - v1.60

### v1.60: Remove Sample Rate from Filenames (Backend + Frontend)

**Problem**: Sample rate embedded in filenames creates "blind pinging" issue:
- Frontend can't construct CDN URLs without first downloading metadata to get sample rate
- Blocks parallel metadata + chunk downloads
- Circular dependency: need metadata to build chunk URLs

**Solution**: Remove sample rate from ALL filenames, keep in JSON content only

#### Backend Changes (`collector_loop.py`)

**Metadata Filenames**:
- **OLD**: `HV_OBL_--_HHZ_100Hz_2025-11-10.json`
- **NEW**: `HV_OBL_--_HHZ_2025-11-10.json` ✅

**Binary Chunk Filenames**:
- **OLD**: `HV_OBL_--_HHZ_100Hz_10m_2025-11-10-03-20-00_to_2025-11-10-03-29-59.bin.zst`
- **NEW**: `HV_OBL_--_HHZ_10m_2025-11-10-03-20-00_to_2025-11-10-03-29-59.bin.zst` ✅

**Code Changes**:
```python
# Metadata filename (line ~605)
metadata_filename = f"{network}_{station}_{location_str}_{channel}_{date_str}.json"

# Binary chunk filename (line ~537)
filename = f"{network}_{station}_{location_str}_{channel}_{chunk_type}_{start_str}_to_{end_str}.bin.zst"
```

**Automatic Migration**: Backend still **reads** OLD format files, but **saves** in NEW format. This means:
1. On next collection run, OLD files are read successfully
2. Updated metadata is saved with NEW filename format
3. New binary chunks are saved with NEW filename format
4. Gradual migration happens automatically over 24 hours

#### Frontend Changes (`index.html`)

**Fallback Logic** for both metadata and binary chunks:

**Metadata Fetch** (lines 2473-2498):
```javascript
// Try NEW format first
const newMetadataUrl = `.../HV_OBL_--_HHZ_2025-11-10.json`;
let response = await fetch(newMetadataUrl);

// Fallback to OLD format if NEW not found
if (!response.ok) {
    const oldMetadataUrl = `.../HV_OBL_--_HHZ_100Hz_2025-11-10.json`;
    response = await fetch(oldMetadataUrl);
}
```

**Binary Chunk Fetch** (lines 2916-2932):
```javascript
// Try NEW format first
const newChunkUrl = `.../HV_OBL_--_HHZ_10m_2025-11-10-03-20-00_to_...bin.zst`;
let response = await fetch(newChunkUrl);

// Fallback to OLD format if NEW not found
if (!response.ok) {
    const oldChunkUrl = `.../HV_OBL_--_HHZ_100Hz_10m_2025-11-10-03-20-00_to_...bin.zst`;
    response = await fetch(oldChunkUrl);
}
```

**Benefits of Blind Pinging**:
- Frontend can construct chunk URLs without metadata
- Parallel metadata + chunk downloads possible
- Faster time-to-first-audio
- Cleaner, simpler URLs

### Version: v1.60

**Commit Message**: v1.60 Refactor: Remove sample rate from metadata and binary chunk filenames for blind pinging capability, frontend fallback to old format for seamless migration

**Key Changes**:
- ✅ Backend saves NEW format files (no sample rate in filename)
- ✅ Backend reads OLD format files (automatic migration)
- ✅ Frontend tries NEW format first, falls back to OLD format
- ✅ Zero downtime during migration
- ✅ Blind pinging now possible (construct URLs without metadata)
- ✅ Sample rate still stored in JSON content

**Migration Path**:
1. Deploy v1.60 backend to Railway (saves NEW format)
2. Push v1.60 frontend to GitHub (tries NEW, falls back to OLD)
3. Over next 24 hours, all active stations migrate to NEW format
4. Frontend seamlessly handles both formats during transition
5. After 24 hours, all files use NEW format

---

## Session: Chunk Sample Count Fix - v1.61

### v1.61: Pad Short Chunks to Ensure Exact Sample Counts

**Problem**: Audio and waveform drift out of sync during playback, especially on 12-hour pulls.

**Root Cause**: Antiquated rounding logic that discarded samples from IRIS data:

**Old Logic (WRONG)**:
```python
# Always rounded DOWN based on what IRIS returned
rounded_end = UTCDateTime(int(original_end.timestamp))
duration_seconds = int(rounded_end.timestamp - trace.stats.starttime.timestamp)
full_second_samples = duration_seconds * samples_per_second
data = trace.data[:full_second_samples]  # Only truncates, never pads!
```

**Example of Data Loss**:
When IRIS returns chunk with timing offset:
- Start: `03:10:00.009999` (10ms late start)
- End: `03:19:58.999999` (ends 1 second early)
- Duration: `598.99 seconds`
- IRIS samples: `59,900`

Old code did:
- `rounded_end = int(03:19:58.999999) = 03:19:58`
- `duration_seconds = int(03:19:58 - 03:10:00.009999) = 598`
- `full_second_samples = 598 × 100 = 59,800` ← **Discarded 100 samples!**
- Metadata: `59,800 samples` (200 short of expected 60,000)

**Cumulative Effect**: Multiple short chunks across 12-hour pull caused audio to play faster than waveform, ending before waveform completed.

**New Logic (CORRECT)**:
```python
# Calculate expected samples from REQUEST (not what IRIS gave us)
requested_duration = end_time - start_time
expected_samples = int(requested_duration.total_seconds() * sample_rate)
actual_samples = len(trace.data)

if actual_samples < expected_samples:
    # Pad: Hold last sample value to fill to expected length
    missing = expected_samples - actual_samples
    last_value = trace.data[-1]
    padding = np.full(missing, last_value, dtype=trace.data.dtype)
    data = np.concatenate([trace.data, padding])
elif actual_samples > expected_samples:
    # Truncate: Remove extra samples (shouldn't happen but safeguard)
    data = trace.data[:expected_samples]
else:
    # Perfect!
    data = trace.data
```

**Key Philosophy Change**: 
- **Before**: "Process whatever IRIS gives us, round down to clean seconds"
- **After**: "We requested X samples, we MUST output X samples, period"

**Benefits**:
- ✅ Every chunk has **exactly** the expected sample count
- ✅ No cumulative drift between audio and waveform
- ✅ Chunks with IRIS timing offsets are padded correctly
- ✅ Frontend duration calculations remain accurate
- ✅ Chunks concatenate perfectly without gaps

### Version: v1.61

**Commit Message**: v1.61 Fix: Pad short chunks by holding last sample value to ensure exact sample counts, prevents audio/waveform drift

**Key Changes**:
- ✅ Removed antiquated rounding logic
- ✅ Calculate expected samples from request window (not IRIS response)
- ✅ Pad short chunks by holding last sample value
- ✅ Truncate long chunks (safeguard, shouldn't happen)
- ✅ Detailed logging shows padding/truncation when it occurs

**Testing Notes**:
- Test with stations known to have timing offsets (HV.UWB, HV.SBL)
- Verify metadata sample counts match expected (60,000 for 10m chunks)
- Confirm audio and waveform stay in sync for 12+ hour pulls

---

## Future Work / TODO

### Long-term: Metadata Filename Architecture Change

**Status**: ✅ **COMPLETE** (v1.60) - Sample rate removed from filenames

**Implementation**:
- Backend saves NEW format, reads OLD format (automatic migration)
- Frontend tries NEW format first, falls back to OLD format
- Zero downtime during migration

---
