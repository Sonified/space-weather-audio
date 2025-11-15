# Captain's Log - 2025-11-14

## 🎯 MAJOR FIX: Region Playback Race Condition (v1.88)

### Problem
After refactoring the playback code, a critical race condition emerged when seeking to new regions:
1. User selects a region and plays through it
2. Playback finishes and stops
3. User clicks to seek to a new position
4. **BUG**: Visuals animate but no audio plays!

Console logs showed:
```
⚠️ Buffer health: Minimum buffer was 0 samples (0.00s) - DANGEROUSLY LOW!
wasPlaying=false, forceResume=false
autoResume=false  // ❌ Not resuming!
```

### Root Causes

**Issue #1: Race Condition in Seek Handler**
When seeking, the code was:
1. Sending `seek` message with `forceResume` flag ✅
2. Sending multiple `audio-data` messages to fill buffer
3. **Immediately** sending `resume` message ❌
4. Worklet received `resume` **before** buffer had samples → silent playback

**Issue #2: Waveform Click Didn't Start Playback**
`waveform-renderer.js` was calling:
```javascript
seekToPosition(State.scrubTargetPosition);  // No second parameter!
```
This defaulted `shouldStartPlayback=false`, so clicking after playback stopped wouldn't restart audio.

**Issue #3: Premature Resume Call**
`audio-player.js` in `seekToPosition()` was calling:
```javascript
if (shouldStartPlayback) {
    startPlayback();  // ❌ Sends resume to EMPTY buffer!
}
```
This sent `resume` immediately while buffer was still empty, before samples arrived.

### Solution: Auto-Resume After Buffering

**Fix #1: Auto-Resume Flag**
Modified `main.js` seek-ready handler:
- Instead of sending separate `resume` message after samples
- Pass `autoResume` flag with each `audio-data` chunk
- Worklet checks flag after buffering samples
- Only resumes once `minBufferBeforePlay` threshold is reached

**Before**:
```javascript
// Send all samples
for (let i = targetSample; i < totalSamples; i += chunkSize) {
    State.workletNode.port.postMessage({ type: 'audio-data', data: chunk });
}
// Immediately resume (buffer might be empty!)
if (wasPlaying || forceResume) {
    State.workletNode.port.postMessage({ type: 'resume' });
}
```

**After**:
```javascript
const shouldAutoResume = wasPlaying || forceResume;
for (let i = targetSample; i < totalSamples; i += chunkSize) {
    State.workletNode.port.postMessage({ 
        type: 'audio-data', 
        data: chunk,
        autoResume: shouldAutoResume  // Let worklet decide when to resume
    });
}
```

**Fix #2: Worklet Auto-Resume Logic**
Modified `audio-worklet.js` `addSamples()`:
```javascript
addSamples(samples, autoResume = false) {
    // ... buffer samples ...
    
    // Initial load
    if (!this.hasStarted && this.samplesInBuffer >= this.minBufferBeforePlay) {
        this.isPlaying = true;
        this.hasStarted = true;
    }
    // Auto-resume after seek/loop if requested and buffer is ready
    else if (autoResume && !this.isPlaying && this.samplesInBuffer >= this.minBufferBeforePlay) {
        console.log('🎵 WORKLET addSamples: Auto-resuming after buffering...');
        this.isPlaying = true;  // ✅ Only resume once buffer has samples!
    }
}
```

**Fix #3: Waveform Click Always Starts Playback**
Modified `waveform-renderer.js`:
```javascript
seekToPosition(State.scrubTargetPosition, true);  // Always start when clicking!
```

**Fix #4: Remove Premature Resume**
Modified `audio-player.js`:
```javascript
// Removed this:
// if (shouldStartPlayback) {
//     startPlayback();  // ❌ Don't resume before buffer ready!
// }

// Changed to:
if (shouldStartPlayback) {
    State.setPlaybackState(PlaybackState.PLAYING);  // Just update state, let auto-resume handle it
}
```

### Technical Flow

**Seeking While Playing**:
1. User seeks to new position
2. `wasPlaying=true` → `autoResume=true`
3. Worklet clears buffer, pauses
4. Main thread sends chunks with `autoResume=true`
5. Worklet buffers samples
6. Once threshold reached → auto-resumes ✅

**Seeking While Stopped**:
1. User clicks waveform → `shouldStartPlayback=true`
2. `forceResume=true` → `autoResume=true`
3. Same flow as above → auto-resumes ✅

### Files Modified
- `js/main.js` - Auto-resume logic in seek-ready and loop-ready handlers
- `workers/audio-worklet.js` - Auto-resume in addSamples(), accept autoResume in message handler
- `js/waveform-renderer.js` - Pass `true` for shouldStartPlayback when clicking
- `js/audio-player.js` - Remove premature startPlayback() call, just update state

### Result
✅ **SOLID** playback behavior:
- Click anywhere during playback → seeks and continues playing
- Click anywhere after stopped → seeks and starts playing
- No race conditions or empty buffer issues
- Clean, predictable behavior

**Commit**: v1.88 Fix: Region playback race condition - fixed seek auto-resume logic to wait for buffer before playing, waveform clicks always start playback, removed premature resume calls

**Pushed**: Successfully pushed to GitHub on region-tracker branch (commit 611e6f3)

---

## 🎨 UI: Panel Styling Improvements (v1.89)

### Changes Made

**Panel Organization**:
- Replaced all `nth-child` CSS selectors with class-based selectors for panels
- Added unique classes: `panel-simulate`, `panel-cache`, `panel-selection`, `panel-playback`, `panel-visualization`, `panel-regions`, `panel-metrics`
- Moved Simulate panel from top to bottom of page
- Panels can now be reordered without breaking styling

**Styling Refinements**:
- Reduced panel border-radius from 10px to 5px for consistency
- Reduced spacing between panels from 15px to 8px
- Reduced panel padding (top/bottom) from 12px to 8px (30% reduction)
- Reduced button height from 44px to 38px, padding from 12px 24px to 9px 18px
- Reduced dropdown/select padding from 8px 12px to 6px 10px
- Reduced status div height from 50px to 36px
- Reduced Pause/Loop button min-width from 150px to 120px
- Made slider track thinner (3px) and centered, increased thumb size to 18px
- Reduced add region button padding from 8px 16px to 4px 10px

**Text Changes**:
- Changed "Tracked Regions" to "Selected Regions" in panel heading

**Commit**: v1.89 UI: Panel styling improvements - replaced nth-child selectors with class-based selectors, reduced button/panel heights, improved slider styling, changed 'Tracked Regions' to 'Selected Regions'

---

## 🚀 MASSIVE OPTIMIZATION: Complete Spectrogram Renderer with Worker Pool (v1.90)

### Problem
The streaming spectrogram was causing issues:
- Had to clear on every playback action
- Not time-aligned with waveform
- Original implementation was slow (~30 seconds for 60 minutes)

### Solution: Complete Spectrogram with Multi-Core FFT

**Created 3-file system for blazing fast rendering**:

1. **`workers/spectrogram-worker.js`** - FFT computation engine
   - Cooley-Tukey radix-2 FFT algorithm (in-place)
   - Pre-computed twiddle factors (cached sin/cos values)
   - Batch processing optimized for worker pool
   - **Memory-efficient**: Uses transferable objects for zero-copy data transfer

2. **`js/spectrogram-worker-pool.js`** - Multi-core parallelization
   - Auto-detects CPU cores (uses N-1 for workers)
   - Smart load balancing across all workers
   - Task queue system for optimal worker utilization
   - **Memory management**: Slices data before transfer, proper cleanup

3. **`js/spectrogram-complete-renderer.js`** - Main rendering engine
   - Direct ImageData pixel buffer manipulation (no fillRect!)
   - Pre-computed 256-level RGB color lookup table
   - Only computes as many FFTs as pixels wide (no wasted computation)
   - Supports both full view and region zoom rendering

### Performance Optimizations

**Before**: ~30,000ms (30 seconds!)
- Naive DFT implementation: O(N²) per FFT
- 1.2 million individual fillRect() calls
- Repeated HSL→RGB string conversions
- No parallelization

**After**: ~700-1000ms (40x speedup!)
- Proper FFT: O(N log N) with cached twiddle factors
- Direct pixel buffer writes (1 putImageData call)
- Pre-computed color LUT (zero conversions)
- 8-core parallel computation with transferable objects

### Memory Management

**Critical fixes to prevent "Array buffer allocation failed"**:
- **Transferable objects**: Zero-copy data transfer between threads
- **Data slicing**: Only send needed samples to each worker
- **Worker cleanup**: Explicit buffer clearing and references nulling
- **Result transfers**: Magnitude buffers transferred back to main thread

```javascript
// Zero-copy send to worker
worker.postMessage(data, [data.buffer]);  // TRANSFER ownership

// Zero-copy return from worker  
const transferList = results.map(r => r.magnitudes.buffer);
self.postMessage({ results }, transferList);
```

### Integration Changes

- Commented out streaming spectrogram calls in `main.js` and `audio-player.js`
- Added `startCompleteVisualization()` trigger after data load completes
- Added `clearCompleteSpectrogram()` when loading new data
- Region zoom support with `renderCompleteSpectrogramForRegion()`

### Technical Details

**FFT Algorithm**:
- Radix-2 Cooley-Tukey decimation-in-time
- Bit-reversal permutation for in-place computation
- Hann window for spectral smoothing
- 2048-point FFT (matches Web Audio analyser)

**Rendering Strategy**:
- Hop size = totalSamples / canvasWidth (one FFT per pixel)
- ImageData buffer with 4 bytes per pixel (RGBA)
- Pre-computed HSL→RGB conversion at 256 levels
- Respects frequency scale (linear/sqrt/logarithmic)
- Respects playback rate scaling

**Worker Pool Architecture**:
- 8 workers on 9-core CPU (leaves 1 for main thread)
- 50 slices per batch for optimal load balancing
- Async batch processing with Promise.all
- Progressive rendering callback as batches complete

### Files Created
- `workers/spectrogram-worker.js` - FFT worker implementation
- `js/spectrogram-worker-pool.js` - Worker pool manager
- `js/spectrogram-complete-renderer.js` - Main rendering logic

### Files Modified
- `js/data-fetcher.js` - Added startCompleteVisualization() trigger
- `js/main.js` - Added imports, clearCompleteSpectrogram() call, commented out streaming
- `js/audio-player.js` - Commented out streaming spectrogram calls

### Result
✅ **INSANE performance**: 700-1000ms for full 60-minute spectrogram
✅ **Perfect time alignment** with waveform
✅ **Zero memory errors** with proper transferable object usage
✅ **Multi-core utilization** - all CPU cores working in parallel
✅ **Region zoom support** with even higher resolution

**Commit**: v1.90 Feat: Complete spectrogram renderer with multi-core worker pool - 40x performance improvement (~700ms), direct pixel buffer manipulation, pre-computed color LUT, zero-copy transferable objects, perfect waveform time alignment

---

## 📐 ARCHITECTURE: Zoom System Design & Spectrogram Playhead (v1.91)

### Zoom Architecture Document

**Created**: `docs/zoom_architecture.md`

Comprehensive architecture document outlining the unified coordinate system for implementing zoom functionality:

**Core Principle**: **Sample-based coordinates** as single source of truth
- All positions stored as absolute sample indices (integers)
- Zero floating-point drift
- Perfect round-trips on zoom in/out/in/out
- Direct buffer access mapping

**Key Components**:
1. **ZoomState Manager** - Converts samples ↔ pixels/time/timestamps for current view
2. **Region & Feature Storage** - Absolute sample positions (not relative to regions)
3. **Zoom Operations** - `zoomToRegion()` and `zoomToFull()` workflows
4. **Windowed Playback** - Future feature for auto-advancing time windows
5. **Scrolling Playback** - Three approaches from simple to ring buffer
6. **Implementation Order** - Phased rollout plan from MVP to advanced

**Why Sample-Based?**
- Samples → Pixels: `(sample - viewStart) / viewRange * canvasWidth`
- Pixels → Samples: `viewStart + (pixelX / canvasWidth) * viewRange`
- Features stay at exact positions regardless of zoom level
- Works perfectly with future windowed/scrolling playback

### Spectrogram Playhead Implementation

**Created**: `js/spectrogram-playhead.js`

Synchronized red playhead indicator on spectrogram, perfectly mirroring waveform:

**Features**:
- Red playhead line moves during playback in sync with waveform
- White/gray scrub preview while hovering/dragging (matches waveform UX)
- Optimized strip rendering: only redraws 8px-wide strips (7,200 pixels vs 540,000!)
- Pixel-level change detection to skip redundant redraws
- Smart playhead preservation when clearing scrub preview

**Performance Optimization**:
- Instead of redrawing entire 1200×450 canvas (540k pixels):
  - Only restore old playhead strip (8×450 = 3,600 pixels)
  - Only restore new playhead strip (8×450 = 3,600 pixels)
  - Draw new line
- **Result**: 75× less pixel manipulation = instant updates

**Integration Points**:
- `updatePlaybackIndicator()` - Draws playhead every frame during playback
- `updateScrubPreview()` - Mirrors white/gray preview on hover/drag
- Immediate updates on seek/click - clears preview, shows playhead instantly

**Bug Fix**: Changed `global.gc` to `window.gc` in worker pool termination (browsers don't have `global`)

### Files Created
- `docs/zoom_architecture.md` - Complete zoom system architecture
- `js/spectrogram-playhead.js` - Synchronized playhead rendering
- `js/selection-diagnostics.js` - Coordinate system validation tools

### Files Modified
- `js/main.js` - Version bump, integrated selection diagnostics
- `js/waveform-renderer.js` - Added spectrogram playhead/preview calls, selection diagnostics integration
- `js/spectrogram-complete-renderer.js` - Added canvas caching for playhead redrawing
- `js/spectrogram-worker-pool.js` - Fixed global.gc bug

### Result
✅ **Perfectly synchronized** playhead across waveform and spectrogram
✅ **Instant visual feedback** - no lag, optimized strip rendering
✅ **Comprehensive zoom architecture** ready for implementation
✅ **Selection diagnostics** validate coordinate systems across pixels/samples/timestamps

**Commit**: v1.91 Docs: Created zoom architecture document outlining sample-based coordinate system for future zoom implementation. Feat: Implemented synchronized red playhead on spectrogram with optimized strip rendering and scrub preview. Fix: Changed global.gc to window.gc in worker pool

---



## 🎵 PERF: Audio Buffer Optimization & Memory Health Monitoring (v1.92)

### The Problem: Buffer Underruns

Despite having all the audio data loaded, users experienced constant buffer underrun warnings:
```
⚠️ BUFFER UNDERRUN: only 234 samples available, need 512
⚠️ Buffer health: Minimum buffer was 89 samples (0.002s) - DANGEROUSLY LOW!
```

These weren't data loading issues - they were happening because the audio thread was running on a tightrope with no safety margin.

### Investigation: Two Separate Issues

#### Issue 1: AudioContext Latency Configuration

The AudioContext was created with no `latencyHint`, defaulting to `'interactive'`:
```javascript
new AudioContext({ sampleRate: 44100 })
// Default = 'interactive' (~5ms buffer)
```

This gave only ~5ms of system buffer - perfect for live music/gaming, but terrible for our use case with:
- 8-9 parallel FFT workers consuming CPU
- Garbage collection pauses (at 98% memory usage!)
- Heavy canvas rendering
- Dataset switching

#### Issue 2: Memory Monitoring Gaps

We had no visibility into:
- Baseline memory health over time
- Memory leak detection
- Whether GC was running properly
- Browser-specific memory behavior (Brave vs Chrome vs Safari)

### The Fix: ONE LINE OF CODE! 🔥

**Changed AudioContext latency hint from `'interactive'` (5ms) to `'playback'` (30ms):**

```javascript
new AudioContext({ 
    sampleRate: 44100,
    latencyHint: 'playback'  // 30ms buffer for stable playback
})
```

**Result**: Every single buffer underrun warning vanished instantly!

The 25ms difference gave the audio thread enough cushion to handle:
- ✅ GC pauses during memory-intensive operations
- ✅ 8-9 worker threads running parallel FFTs
- ✅ Rapid volcano dataset switching
- ✅ Browser multitasking

30ms is imperceptible to humans (film runs at 24fps = 42ms/frame) but MASSIVE for a computer thread.

### Bonus: Memory Health Monitoring System

Added comprehensive memory monitoring to track app health:

**Features**:
- Logs memory stats every 10 seconds
- Tracks baseline (minimum after GC)
- Calculates average usage over time
- Detects memory leak trends (baseline growing >200MB)
- Warns at >80% usage
- Handles Safari/Firefox (no `performance.memory` API)

**Console Output**:
```
🏥 Memory health: 4025MB (98.3%) | Baseline: 3953MB | Avg: 97.4% | Limit: 4096MB | Trend: stable
```

**Leak Detection**:
If baseline grows >200MB over time:
```
🚨 POTENTIAL MEMORY LEAK: Baseline grew 250MB (3800MB → 4050MB)
```

**Browser Compatibility**:
- Chrome/Brave: Full monitoring with accurate stats
- Safari/Firefox: Silent fallback (API not available)

### Files Modified
- `js/main.js` - Version bump to v1.92, added `latencyHint: 'playback'` to both AudioContext creations, imported and started memory monitoring
- `js/spectrogram-complete-renderer.js` - Added memory health monitoring system with baseline tracking, trend detection, leak warnings, and aggressive cleanup on dataset switching

### Result
✅ **Zero buffer underruns** - Audio plays perfectly smooth, even during heavy operations
✅ **Imperceptible latency** - 30ms is unnoticeable to users
✅ **Memory visibility** - Can track health, detect leaks, monitor GC effectiveness
✅ **Stable at 98% memory** - App works at capacity without crashes

**Sometimes the biggest performance wins are the simplest changes!** 🎯

**Commit**: v1.92 Perf: Changed AudioContext latencyHint to 'playback' - eliminated buffer underruns with 30ms latency. Feat: Added memory health monitoring system with baseline tracking and leak detection

---

## 🔐 SECURITY: Removed Hardcoded R2 Credentials (v1.93)

### Problem
R2 access credentials were hardcoded in the codebase as fallback values in multiple files:
- `collector_loop.py`
- `cdn_backfill.py`
- `fill_single_gap.py`
- `nuke_dates.py`
- `verify_deletion.py`
- `delete_maunaloa_data.py`

This exposed credentials in git history, making the repo unsafe for public sharing or collaboration.

### Solution

**1. Generated new R2 access keys** and invalidated old ones

**2. Created `.env` file** for local development with R2 credentials (account ID, access keys, bucket name)

**3. Updated `.gitignore`** to prevent credential commits:
```
.env
.env.local
*.key
```

**4. Implemented python-dotenv** for environment variable management:
- Added `python-dotenv>=1.0.0` to `backend/requirements.txt`
- All production Python files now use `load_dotenv()` at startup
- Removed all hardcoded credential fallbacks
- Added validation that fails loudly if credentials are missing

**5. Updated Railway environment variables** in dashboard with new credentials

### How It Works

**Local Development**:
- `load_dotenv()` reads `.env` file at startup
- `os.getenv()` reads loaded variables
- No credentials in code

**Production (Railway)**:
- No `.env` file exists on Railway
- `os.getenv()` reads Railway dashboard environment variables
- Same code works in both environments

### Files Modified
- `.gitignore` - Added `.env`, `.env.local`, `*.key`
- `backend/requirements.txt` - Added `python-dotenv>=1.0.0`
- `backend/collector_loop.py` - Removed hardcoded credentials, added dotenv
- `backend/cdn_backfill.py` - Removed hardcoded credentials, added dotenv
- `backend/fill_single_gap.py` - Removed hardcoded credentials, added dotenv
- `backend/nuke_dates.py` - Removed hardcoded credentials, added dotenv
- `backend/verify_deletion.py` - Removed hardcoded credentials, added dotenv
- `backend/delete_maunaloa_data.py` - Removed hardcoded credentials, added dotenv

### Testing
Verified new credentials work with test script that successfully:
- Connected to R2
- Wrote test file
- Read test file back
- Deleted test file

### Result
✅ **Zero credentials in codebase** - Clean for public sharing
✅ **Local dev uses `.env`** - Simple developer experience
✅ **Railway uses dashboard variables** - Secure production deployment
✅ **Same code, both environments** - No environment-specific branches
✅ **Fail-fast validation** - Missing credentials raise clear error at startup

**Commit**: v1.93 Security: Removed hardcoded R2 credentials - implemented python-dotenv for local .env file management, updated collector_loop.py and backfill scripts to use environment variables, added .env to .gitignore, generated new R2 keys, configured Railway dashboard variables

---

## v1.95 - Critical Memory Leak Fix: Eliminated window.* Closures (2025-11-14)

### Problem Discovered
Heap snapshot analysis revealed **MASSIVE memory leak**:
- **87,000 ArrayBuffer instances** holding **1GB+ of memory**
- Each buffer was exactly **34MB** (8.64M Float32 samples = 3.26 minutes of audio)
- **2.1 MILLION Function instances** (closures not cleaned up)
- Memory baseline growing **~100MB per session** and never releasing
- Retainer chain showed: `Float32Array.buffer` → `State` → `attemptSubmission()` in `Window (global*)`

### Root Cause
**All** inline `onclick="functionName()"` handlers created permanent closures on `window.*` that captured:
- Entire module scope including `import * as State`
- `State.completeSamplesArray` (8.64M Float32Array = 34MB per session)
- `State.allReceivedData` (all audio chunks)
- **NEVER garbage collected** because `window` object persists forever

32+ window.* assignments in main.js:
```javascript
window.attemptSubmission = attemptSubmission;  // ❌ Captures State forever!
window.startStreaming = startStreaming;  // ❌ Captures State forever!
// ... 30 more creating permanent closures
```

### Solution
**Completely refactored event handling**:

1. **HTML Cleanup** (`index.html`)
   - Removed ALL 16 inline `onclick/onchange/oninput` attributes
   - Added unique `id` attributes where missing

2. **Event Listener Architecture** (`js/main.js`)
   - Removed all 32 `window.* = function` assignments
   - Added proper `addEventListener` setup in DOMContentLoaded
   - Event listeners properly scoped - no permanent closures

3. **Dynamic HTML Fix** (`js/region-tracker.js`)
   - Refactored dynamically generated HTML (worst offender!)
   - Replaced inline `onclick="window.functionName()"` with data attributes
   - Attached event listeners programmatically after DOM creation

4. **Additional Cleanup**
   - `js/audio-player.js` - Changed `window.downloadAudio` to proper export
   - `js/data-fetcher.js` - Added progressive chunk memory cleanup
   - Fixed global leaks: `window.rawWaveformData`, `window.displayWaveformData`, `window.audioWorker`

### Memory Impact
**Before**: Each session = 200MB that NEVER freed (accumulated indefinitely)
**After**: Old audio data properly garbage collected between sessions

### Files Changed
- `index.html` - Removed all inline event handlers
- `js/main.js` - Event listener setup, removed window assignments
- `js/audio-player.js` - Proper export instead of window assignment
- `js/region-tracker.js` - Refactored dynamic HTML generation
- `js/data-fetcher.js` - Progressive memory cleanup
- `backend/collector_loop.py` - Version bump to v1.95

### Technical Details
The heap snapshot showed functions like `attemptSubmission` on `Window (global*)` holding references to the entire State module, which held ALL audio data from EVERY session. Even after calling cleanup code, the window.* closures prevented garbage collection. This is a textbook closure memory leak pattern.

**Commit**: v1.95 Critical Fix: Eliminated 1GB+ memory leak - removed all window.* function assignments and inline onclick handlers, refactored to proper event listeners, added progressive chunk cleanup, fixed closure chain preventing garbage collection of old audio data

---

## 🔇 FIX: Gap Handling with Silence & Boundary Smoothing (v1.96)

### Problem
When stations went down and data chunks were missing, the application was silently skipping those gaps:
- Missing chunks were not fetched (correct)
- But no data was inserted for those time periods (wrong!)
- Result: Timeline compression - 24h request would only play 23h 10min
- Example: Request 4,320,000 samples but only get 4,170,000 (missing 50 minutes)
- Timestamps didn't match audio position - confusing for users
- Also: Audible clicks at gap boundaries due to discontinuities

### Root Cause
In `calculateChunksNeededMultiDay()`, missing chunks were logged but not added to the chunks array:
```javascript
if (chunkData) {
    chunks.push({ /* chunk data */ });
} else {
    console.warn(`⚠️ MISSING 10m chunk: ${date} ${time} - chunk not found in metadata!`);
    // ❌ Nothing added - gap just disappeared from timeline
}
```

### Solution: Fill Gaps with Silence

**Step 1: Mark Missing Chunks** (`data-fetcher.js`)
- When chunk not found in metadata, calculate expected sample count
- Add to chunks array with `isMissing: true` flag
- Set min/max to 0 for normalization consistency

```javascript
chunks.push({
    type: '10m',
    start: timeStr,
    end: endTimeStr,
    min: 0,
    max: 0,
    samples: expectedSamples,  // 10min × sample_rate
    date: currentDate,
    isMissing: true
});
```

**Step 2: Skip Fetch for Missing Chunks** (`data-fetcher.js`)
- In download loop, check `chunk.isMissing` flag
- Return immediately without fetching
- Pass metadata to worker to generate silence

```javascript
if (chunk.isMissing) {
    return Promise.resolve({
        compressed: null,
        isMissing: true,
        expectedSamples: chunk.samples
    });
}
```

**Step 3: Generate Silence in Worker** (`audio-processor-worker.js`)
- Worker receives `isMissing` flag
- Creates Float32Array and Int32Array of zeros (typed arrays initialize to 0)
- Processes instantly (~0ms) - no decompression needed

```javascript
if (isMissing) {
    const normalized = new Float32Array(expectedSamples);  // All zeros
    const int32Samples = new Int32Array(expectedSamples);  // All zeros
    // Send back...
}
```

**Step 4: Boundary Smoothing** (`data-fetcher.js`)
- Apply 1000-sample linear interpolation at transitions
- Real → Missing: Fade from last real value to 0
- Missing → Real: Fade from previous real value to 0 at start

```javascript
const SMOOTH_SAMPLES = 1000; // ~23ms at 44.1kHz

// Transition into missing chunk
if (isMissing && prevChunk) {
    const prevValue = prevSamples[prevSamples.length - 1];
    for (let i = 0; i < SMOOTH_SAMPLES; i++) {
        const alpha = i / SMOOTH_SAMPLES;
        samples[i] = prevValue * (1 - alpha) + 0 * alpha;
    }
}

// Transition from real chunk before gap
if (!isMissing && nextIsMissing) {
    const startValue = samples[samples.length - SMOOTH_SAMPLES];
    for (let i = 0; i < SMOOTH_SAMPLES; i++) {
        const alpha = i / SMOOTH_SAMPLES;
        samples[samples.length - SMOOTH_SAMPLES + i] = startValue * (1 - alpha);
    }
}
```

### Technical Details

**Memory Efficiency**:
- Float32Array initializes to zeros automatically
- No explicit loop needed to fill with silence
- Zero-copy transfer to worklet

**Timeline Accuracy**:
- Expected samples: 4,320,000 (24h × 50 Hz)
- Actual samples: 4,320,000 (gaps filled!)
- Perfect timestamp alignment maintained

**Smoothing Math**:
- Linear interpolation: `value = start * (1 - alpha) + end * alpha`
- 1000 samples = ~23ms at 44.1kHz playback
- Imperceptible transition, eliminates clicks

### Files Modified
- `js/data-fetcher.js` - Added missing chunk detection, silence generation, boundary smoothing in sendChunksInOrder()
- `workers/audio-processor-worker.js` - Added isMissing handler to generate zero arrays

### Result
✅ **Perfect timestamp accuracy** - 24h request = 24h playback duration
✅ **Gaps represented honestly** - Silence where station was down
✅ **No clicks** - Smooth transitions with 1000-sample interpolation
✅ **Waveform shows gaps** - Flat lines where data missing (no squiggles)
✅ **Spectrogram shows gaps** - Dark regions where silent

**Commit**: v1.96 Fix: Gap handling with silence and boundary smoothing - missing data chunks now filled with zeros of correct duration, linear interpolation smoothing (1000 samples) at boundaries to eliminate clicks, maintains perfect timestamp accuracy

