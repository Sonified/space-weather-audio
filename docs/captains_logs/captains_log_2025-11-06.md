# Captain's Log - 2025-11-06

## Session: Critical Bug Fixes - Playhead, Worker, and Progressive Streaming

### Major Bugs Fixed

#### 1. **Playhead Stopped at 66% Bug**
**Problem**: Playhead would stop at ~66% even though audio continued playing
- `completeSamplesArray`: 120,000 samples ✅
- `workletNode totalSamples`: 80,064 samples ❌
- Worklet was setting `totalSamples = samplesInBuffer` when receiving `data-complete` message
- At that moment, only 80,064 samples had been buffered (rest still in transit)

**Fix**: Send explicit `totalSamples` with `data-complete` message
```javascript
workletNode.port.postMessage({ 
    type: 'data-complete',
    totalSamples: totalWorkletSamples  // Explicitly pass the correct total
});
```

**Files Changed**: `index.html` (lines ~2459, ~1249)

---

#### 2. **Playhead Animation Not Starting on First Playthrough**
**Problem**: Red playhead line wouldn't move during first playback (worked on subsequent plays)

**Root Cause**: `updatePlaybackIndicator()` stopped the animation loop when `totalAudioDuration === 0`, which is true before waveform finishes drawing.

**Fix**: Keep animation loop running, only skip drawing if duration not ready
```javascript
function updatePlaybackIndicator() {
    if (!isPlaying || isPaused) {
        return; // Stop loop only when paused/stopped
    }
    
    // Only draw if we have duration
    if (totalAudioDuration > 0) {
        drawWaveformWithSelection();
    }
    
    // Continue animation loop regardless
    requestAnimationFrame(updatePlaybackIndicator);
}
```

**Files Changed**: `index.html` (lines ~3757-3777)

---

#### 3. **Worker Infinite Loop Bug (CRITICAL)**
**Problem**: Worker would timeout on 240+ minute requests with thousands of identical "Skipping chunk" logs

**Root Cause**: Time quantization happened EVERY iteration
1. Select 10m chunks 03:40-04:40 ✅
2. After 60 minutes, switch to 1h chunk type
3. Quantize time to hour boundary: 04:00
4. Find 1h chunk at 04:00
5. Detect overlap with 10m chunk at 04:00
6. Skip, advance 1 second to 04:00:01
7. **Quantize again → back to 04:00** ← INFINITE LOOP!
8. Repeat until worker times out (503 error)

**Fix**: Replaced messy loop-based approach with **clean time grid builder**
- Build exact list of timestamps needed upfront
- Direct lookup of each chunk in metadata
- No overlaps, no loops, no edge cases

**Files Changed**: `worker/src/index.js` (lines ~942-1032)

---

#### 4. **Missing Chunks When Switching Granularities**
**Problem**: Jump from 03:09:59 → 04:00:00 (missing 03:10-03:59)

**Root Cause**: When switching from 10m to 1h chunks, code jumped to next hour boundary instead of filling the gap

**Example**:
- Start: 02:07:25 (rounds to 02:00)
- After 60 minutes (at 03:07:25), switch to "1h chunk type"  
- **BUG**: Jump to 04:00 ❌
- **CORRECT**: Fill 03:10, 03:20, 03:30, 03:40, 03:50, THEN 04:00 ✅

**Fix**: Only use larger chunks when AT the appropriate boundary
```javascript
} else if (currentMinute === 0) {
    // After first hour AND at hour boundary: use 1h
    chunkType = '1h';
} else {
    // After first hour but NOT at hour boundary: keep using 10m
    chunkType = '10m';
}
```

**Files Changed**: `worker/src/index.js` (lines ~978-1024)

---

#### 5. **Spectrogram Scroll Speed Too Fast**
**Problem**: What displayed as "0.25x" was actually scrolling at 1.0x speed

**Root Cause**: Code multiplied scroll speed by 4.0 for historical reasons

**Fix**: Removed multiplier, now 1:1 mapping between displayed and actual speed
```javascript
// BEFORE: const actualScrollSpeed = spectrogramScrollSpeed * 4.0;
// AFTER:  const actualScrollSpeed = spectrogramScrollSpeed;
```

**Files Changed**: `index.html` (line ~3781)

---

### Infrastructure Improvements

#### 1. **Cloudflare Workers Plan Upgrade**
- Upgraded from Free tier (10ms CPU limit) → Paid tier (30s CPU limit)
- Eliminated worker timeouts on large requests (240-360 minute ranges)
- Cost: Small monthly fee vs. constant 503 errors

#### 2. **Worker Observability Enabled**
Added comprehensive logging configuration to `wrangler.toml`:
```toml
[observability]
enabled = true
head_sampling_rate = 1

[observability.logs]
enabled = true
head_sampling_rate = 1
persist = true
invocation_logs = true
```

Now all worker logs persist in Cloudflare dashboard for debugging.

**Files Changed**: `worker/wrangler.toml`

---

#### 3. **Removed Noisy Filter Debug Logs**
Removed console spam from anti-aliasing filter processing (was logging every sample value as audio played)

**Files Changed**: `index.html` (removed lines ~1556-1559)

---

### Technical Learnings

1. **Time Grid Approach is Elegant**: 
   - Building explicit list of timestamps upfront eliminates all edge cases
   - No overlap detection needed, no infinite loops possible
   - Easy to debug: just log the grid to see what's requested
   - Separates "what chunks do I need?" from "where are they?"

2. **AudioWorklet Buffer States**:
   - `samplesInBuffer` != `totalSamples` when data is still loading
   - Always send explicit counts with messages, don't rely on internal state
   - Worklet state can lag behind main thread during progressive loading

3. **Animation Loop Management**:
   - Keep loops running, skip draws when data not ready
   - Don't stop loop based on data availability
   - Stop only on explicit pause/stop actions

4. **Progressive Streaming Edge Cases**:
   - Must fill gaps with smaller chunks before switching to larger ones
   - Can't jump to boundaries, must walk there naturally
   - Chunk type switch ≠ time boundary jump

---

### Files Modified This Session

**Frontend**:
- `index.html` - Playhead fixes, animation loop, spectrogram speed

**Worker**:
- `worker/src/index.js` - Time grid builder, chunk selection logic
- `worker/wrangler.toml` - Observability configuration

---

### Testing Results

✅ **30-minute requests**: Working perfectly  
✅ **240-minute (4 hour) requests**: Now completing successfully  
✅ **360-minute (6 hour) requests**: Loading all chunks correctly  
✅ **Playhead**: Reaches 100% consistently  
✅ **No more discontinuities**: Smooth audio across chunk boundaries  
✅ **Worker performance**: <1s for metadata, no timeouts

---

### Architecture: Progressive Streaming System

#### Overview
The volcano-audio app uses a multi-tier progressive streaming architecture:
1. **Backend** (Python/Flask): Fetches from IRIS, processes, compresses to R2
2. **R2 Worker** (Cloudflare): Serves metadata and chunks directly from R2
3. **Frontend** (Browser): Progressive decompression, stitching, and playback

---

#### Progressive Metadata Endpoint (`/progressive-metadata`)

**Purpose**: Return ONLY the chunks needed for a specific time range, with accurate min/max for normalization

**Request**:
```
GET /progressive-metadata?network=HV&station=OBL&location=--&channel=HHZ
                        &start_time=2025-11-06T02:00:00Z&duration_minutes=360
```

**Strategy Selection** (based on duration):
- **0-60 min**: All 10m chunks
- **1-6 hours**: First hour in 10m, rest in 1h chunks
- **6+ hours**: First hour in 10m, next 5 hours in 1h, rest in 6h chunks

**Time Grid Algorithm**:
```javascript
1. Round start time to nearest 10m boundary
2. Build grid of exact timestamps:
   - Use 10m chunks for first hour
   - Switch to 1h ONLY when at hour boundary (XX:00:00)
   - Switch to 6h ONLY when at 6h boundary (00:00, 06:00, 12:00, 18:00)
3. Look up each timestamp directly in metadata
4. Calculate min/max from ONLY selected chunks
```

**Example** (6-hour request starting 02:07:25):
```
02:00, 02:10, 02:20, 02:30, 02:40, 02:50,  ← First hour (10m chunks)
03:00, 03:10, 03:20, 03:30, 03:40, 03:50,  ← Keep using 10m until boundary
04:00, 05:00, 06:00, 07:00                ← Now at boundaries, use 1h chunks
```

**Response**:
```json
{
  "station": "HV.OBL.--.HHZ",
  "start_time": "2025-11-06T02:07:25Z",
  "duration_minutes": 360,
  "sample_rate": 100,
  "strategy": "first_hour_10m_then_1h",
  "total_chunks": 11,
  "total_samples": 1860000,
  "normalization": {
    "min": -10783,
    "max": 14429
  },
  "chunks": [
    {"type": "10m", "start": "02:00:00", "end": "02:09:59", "samples": 60000, ...},
    {"type": "10m", "start": "02:10:00", "end": "02:19:59", "samples": 60000, ...},
    ...
    {"type": "1h", "start": "04:00:00", "end": "04:59:59", "samples": 360000, ...},
    ...
  ]
}
```

**Key Insight**: The min/max is calculated from ONLY the chunks being returned, ensuring normalization matches the actual audio data.

---

#### Progressive Streaming Flow

**Browser Side**:
```javascript
1. Fetch progressive metadata
   ↓
2. Extract normalization range (min/max from selected chunks)
   ↓
3. Fetch chunks sequentially:
   - Request chunk 1 → Decompress → Normalize → Send to worklet
   - Start playback as soon as first chunk arrives (TTFA)
   - Request chunk 2 → Decompress → Normalize → Send to worklet
   - Continue until all chunks loaded
   ↓
4. Stitch complete array for waveform display
   ↓
5. Apply DC offset removal (detrending) to complete waveform
```

**Chunk Fetching**:
```javascript
GET /chunk?network=HV&station=OBL&location=--&channel=HHZ
         &date=2025-11-06&start=02:00:00&end=02:09:59
```
Returns: Binary `.zst` compressed int32 data

**Decompression & Normalization**:
```javascript
// Decompress .zst file
const decompressed = fzstd.decompress(compressedData);
const int32Samples = new Int32Array(decompressed.buffer);

// Normalize to [-1, 1] using metadata min/max
const normalized = new Float32Array(int32Samples.length);
for (let i = 0; i < int32Samples.length; i++) {
    normalized[i] = 2 * (int32Samples[i] - normMin) / range - 1;
}

// Send to worklet immediately (progressive playback)
workletNode.port.postMessage({ type: 'audio-data', data: normalized });
```

**Stitching**:
```javascript
// After all chunks arrive, build complete array
const stitchedInt32 = new Int32Array(totalSamplesReceived);
let offset = 0;
for (const chunk of allInt32Samples) {
    stitchedInt32.set(chunk, offset);
    offset += chunk.length;
}
```

**Benefits**:
- ✅ Fast TTFA (Time To First Audio): ~1s even for 6-hour requests
- ✅ Progressive playback: Audio starts while later chunks download
- ✅ Accurate normalization: Min/max matches actual data
- ✅ Efficient: Browser decompresses, worker just streams files
- ✅ No gaps: Chunks stitch seamlessly

---

### Architecture: Waveform De-trending System

#### The Problem
Seismic data has **DC offset drift** - the baseline slowly shifts up/down over time due to:
- Temperature changes affecting sensors
- Ground tilt
- Electronic drift in recording equipment

Without removing drift, the waveform appears "tilted" and doesn't center around zero, making it hard to see actual seismic signals.

---

#### DC Offset Removal (High-Pass Filter)

**Implementation**: First-order recursive high-pass filter (removes very low frequencies)

```javascript
function removeDCOffset(data, alpha = 0.995) {
    let mean = data[0];
    const y = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
        mean = alpha * mean + (1 - alpha) * data[i];
        y[i] = data[i] - mean;
    }
    return y;
}
```

**How it works**:
- `alpha` = 0.995 is the time constant (controls how much drift to remove)
- Higher alpha (closer to 1.0) = removes slower drift, keeps faster signals
- Lower alpha = removes more drift, but may affect actual signals

**Alpha calculation** (based on sample rate):
```javascript
// Cutoff frequency calculation
const totalDurationSeconds = samples.length / sampleRate;
const filterCutoff = 1.0 / totalDurationSeconds; // Remove drift slower than total duration
const dt = 1.0 / sampleRate;
const RC = 1.0 / (2.0 * Math.PI * filterCutoff);
const alpha = RC / (RC + dt);
```

For typical seismic data:
- Sample rate: 100 Hz
- Duration: 30 minutes = 1800s
- Alpha ≈ 0.9749
- This removes drift slower than ~30 minutes while preserving earthquake signals

---

#### Waveform Processing Pipeline

**Stage 1: Raw Data** (int32 sensor counts)
```
[5927, 5931, 5929, ..., 13251]  ← Raw counts from sensor
```

**Stage 2: Normalize to [-1, 1]**
```javascript
const normalized = new Float32Array(data.length);
for (let i = 0; i < data.length; i++) {
    normalized[i] = 2 * (data[i] - min) / range - 1;
}
```
```
[-0.84, -0.83, -0.84, ..., 0.99]  ← Normalized but may have drift
```

**Stage 3: Remove DC Offset (Detrend)**
```javascript
const detrended = removeDCOffset(normalized, alpha);
```
```
[-0.02, -0.01, -0.02, ..., 0.15]  ← Centered around zero, drift removed
```

**Stage 4: Re-normalize**
```javascript
const final = normalize(detrended);  // Scale back to full [-1, 1] range
```
```
[-0.15, -0.08, -0.14, ..., 1.00]  ← Final waveform ready for display
```

---

#### When De-trending is Applied

**For Waveform Display**:
- Applied AFTER all chunks are stitched together
- Runs in background (non-blocking setTimeout)
- Result is displayed with crossfade animation
- Removes long-term drift for clean visualization

**NOT Applied to Audio**:
- Audio worklet receives normalized data WITHOUT detrending
- This preserves the original signal character
- User can enable high-pass filter separately for audio if desired

**Code Location**:
```javascript
// index.html, lines ~2358-2396
setTimeout(() => {
    console.log(`🎛️ Filtering complete waveform in background...`);
    
    // Convert to Float32 (keep in sensor count range)
    const stitchedFloat32 = new Float32Array(stitchedInt32.length);
    for (let i = 0; i < stitchedInt32.length; i++) {
        stitchedFloat32[i] = stitchedInt32[i];
    }
    
    let processedData = stitchedFloat32;
    
    // Calculate alpha for high-pass filter
    const totalDurationSeconds = processedData.length / 100; // 100 Hz
    const filterCutoff = 1.0 / totalDurationSeconds;
    const dt = 1.0 / 100;
    const RC = 1.0 / (2.0 * Math.PI * filterCutoff);
    const alpha = RC / (RC + dt);
    
    console.log(`  🎛️ Removing drift with alpha=${alpha.toFixed(4)}...`);
    processedData = removeDCOffset(processedData, alpha);
    
    // Normalize processed data
    const normalizedWaveform = normalize(processedData);
    console.log(`  📏 Normalized waveform`);
    
    // Update display with crossfade
    completeSamplesArray = normalizedWaveform;
    drawWaveform();
}, 50);
```

**Key Benefits**:
- ✅ Clean waveform visualization centered at zero
- ✅ Easier to see seismic signals against baseline
- ✅ Non-blocking (doesn't delay playback)
- ✅ Preserves signal content (just removes ultra-low frequencies)
- ✅ Adaptive (alpha calculated based on data duration)

---

### Next Steps

- Test 24-hour requests (should use 6h chunks after first 6 hours)
- Consider caching progressive metadata for frequently requested ranges
- Monitor worker CPU usage in Cloudflare dashboard
- Document the time grid approach for future reference

---

### Session 2: Web Worker Architecture Implementation (Late Night)

#### Attempted: Optimize Time To First Audio (TTFA)

**Goal**: Reduce TTFA from ~800ms to <50ms

**Approach Tried**: Implement Web Worker for audio processing
- Created `audio-processor-worker.js` to handle decompression/normalization off main thread
- Worker initialization at startStreaming() for immediate readiness
- Zero-copy ArrayBuffer transfers for efficiency
- Priority processing: Wait for chunk 1 to complete before fetching chunk 2

**Implementation**:
- Worker signals 'ready' when initialized
- Main thread waits for ready signal before sending data
- First chunk gets priority processing
- Promise-based synchronization to ensure audio starts before fetching remaining chunks

**Current Status**: PARTIALLY WORKING BUT INVESTIGATING
- Worker processes chunks correctly (12ms, 16ms, 5ms)
- Main thread remains unblocked ✅
- First chunk sent at ~20ms ✅
- BUT: AudioWorklet.process() doesn't get called until ~900ms ❌

**Mystery**: Everything happens in <50ms but playback doesn't start for 900ms
- Data arrives at worklet at T=26ms
- worklet.hasStarted = true at T=26ms
- But process() first called at T=900ms
- Suspect: AudioContext rendering thread scheduling issue
- May be related to AudioContext.currentTime already being at 0.9s when data arrives

**Files Modified**:
- `audio-processor-worker.js` (NEW) - Web Worker for decompression/normalization
- `index.html` - Worker integration, promise-based chunk priority

**To Debug Tomorrow**:
- Log AudioContext.currentTime when sending first chunk
- Investigate why AudioContext rendering thread has 900ms delay
- Consider if AudioContext needs to be "kicked" differently
- User has seen 30ms TTFA before, so it's definitely possible

**Conclusion**: Worker architecture is solid, but browser audio thread scheduling needs investigation.

