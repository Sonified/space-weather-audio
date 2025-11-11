# Captain's Log - 2025-11-11

## Session: SharedArrayBuffer Zero-Copy Architecture (FAILED)

### Objective: Eliminate Audio Dropouts During Large Chunk Downloads
**Goal**: Implement SharedArrayBuffer to enable zero-copy data transfer between Web Worker and AudioWorklet, preventing main thread blocking during large chunk processing.

### Background: The Problem
When downloading and processing large audio chunks (especially 1-hour chunks), the main thread would block during the decompression and sample transfer, causing brief audio dropouts even though the AudioWorklet runs on a separate real-time thread.

**Root Cause**: 
- Worker decompresses chunk → sends Float32Array via `postMessage()`
- Main thread receives samples → forwards to AudioWorklet via `postMessage()`
- Large arrays (360,000 samples = 1.4MB) cause main thread blocking during structured cloning

**Hypothesis**: SharedArrayBuffer would allow worker to write directly to shared memory, and AudioWorklet to read from it, with zero copying and no main thread involvement.

---

## Implementation Attempt

### Phase 1: CloudFlare Headers Setup ✅
To enable SharedArrayBuffer in the browser, we needed to set Cross-Origin headers:

**Headers Required**:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`
- `Cross-Origin-Resource-Policy: cross-origin`

**CloudFlare Setup**:
1. Navigated to: Rules → Transform Rules → Modify Response Header
2. Created rule to set all three headers on R2 CDN responses
3. Verified with `curl -I` that headers were present

**Local Dev Server**:
Created `dev_server.py` to serve with proper headers:
```python
class CORSRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()
```

### Phase 2: SharedArrayBuffer Architecture ✅

**Buffer Structure**:
```javascript
// Samples buffer (Int16 for space efficiency)
const totalSamples = /* calculated from chunks */;
const sharedBuffer = new SharedArrayBuffer(totalSamples * Int16Array.BYTES_PER_ELEMENT);
const sharedSamples = new Int16Array(sharedBuffer);

// Metadata buffer (Int32 for atomic operations)
const sharedMetadata = new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT);
const metaView = new Int32Array(sharedMetadata);
// [0] = writePosition, [1] = readPosition, [2] = totalSamples, [3] = isComplete
```

**Data Flow**:
1. **Main Thread** (startStreaming): Create SharedArrayBuffer, send to worker + worklet
2. **Worker** (audio-processor-worker.js): Decompress chunk, write Int16 samples directly to sharedBuffer, update writePosition with `Atomics.add()`
3. **AudioWorklet** (audio-worklet.js): Read from sharedBuffer, convert Int16→Float32, output to speakers

**Key Implementation Details**:
- Worker writes to `sharedSamples[writePos++]` and atomically updates `metaView[0]` (writePosition)
- Worklet reads from `sharedSamples[readPos++]` and checks `Atomics.load(metaView, 0)` for available samples
- No structured cloning, no main thread involvement after initial setup

### Phase 3: Integration & Testing ✅ (Code worked, audio did not)

**Files Modified**:
- `js/main.js`: Create SharedArrayBuffer, pass to worker and worklet
- `workers/audio-processor-worker.js`: Write decompressed samples to SharedArrayBuffer
- `workers/audio-worklet.js`: Read from SharedArrayBuffer with fast path (bypass interpolation for audification)
- `js/data-fetcher.js`: Skip sending samples to waveform worker in SharedArrayBuffer mode

**Test Results**:
```
✅ SharedArrayBuffer SUPPORTED - using zero-copy architecture
✅ SharedArrayBuffer initialized in worker
✅ SharedArrayBuffer initialized in worklet
✅ Worker: Writing chunk 0 at position 0 (60000 samples)
✅ Worker: Updated writePos to 60000
✅ WORKLET: samplesAvailable=60000, isPlaying=true
✅ WORKLET: readSample[0] = 2405 (as float: 0.073397)
✅ WORKLET END OF process(): output buffer[0-4] = [0.073303, 0.078513, ...]
✅ AudioContext state: running
✅ Initial gain set to: 1 (from volume slider)
✅ Gain set immediately to: 1 at time 0.046439909297052155
```

---

## The Mystery: NO AUDIO 🤯

### What Was Working
- ✅ SharedArrayBuffer detected and initialized
- ✅ Worker writing samples correctly to shared memory
- ✅ Worklet reading samples correctly (non-zero values logged)
- ✅ AudioWorklet outputting non-zero samples to output buffer
- ✅ AudioContext state: "running"
- ✅ GainNode set to 1.0 (full volume)
- ✅ No JavaScript errors
- ✅ No console warnings
- ✅ All metrics indicating audio should be playing

### What Was NOT Working
- ❌ **NO AUDIBLE SOUND** from speakers
- ❌ No waveform drawing (samples not sent to waveform worker in SharedArrayBuffer mode)
- ❌ No playback position indicator moving

### The Bizarre Symptom
**When the volume slider was touched (even without changing value), audio immediately started playing perfectly.**

This suggested:
1. Not a browser autoplay policy issue (AudioContext already "running")
2. Not a gain problem (already set to 1.0)
3. Not a sample problem (worklet outputting correct values)
4. Some bizarre timing or initialization issue with AudioParam automation

### Debugging Attempts (All Failed)

**Attempt 1: AudioContext Resume**
- Added explicit `audioContext.resume()` in user gesture (Fetch Data button)
- Result: AudioContext already running, no change

**Attempt 2: Gain Scheduling**
- Changed from direct `.value = 1.0` to `setValueAtTime()` + `linearRampToValueAtTime()`
- Result: No change, still silent

**Attempt 3: Remove Fade-In**
- Set gain immediately with `setValueAtTime()` (no ramp)
- Result: No change, still silent

**Attempt 4: Initial Gain Value**
- Changed from `gain.gain.value = 0.0001` to `gain.gain.value = initialVolume` (1.0)
- Result: No change, still silent

**Attempt 5: Remove All Automation**
- Cancelled all scheduled values, set gain with simple assignment
- Result: No change, still silent

### Theory: Undiagnosed Browser Issue
The only explanation that makes sense:
- Some internal browser state related to AudioParam automation is not properly initialized
- Touching the volume slider triggers some browser-internal recalculation or refresh
- This issue does NOT occur with the circular buffer implementation (which works perfectly)
- Possibly related to how SharedArrayBuffer + AudioWorklet interact with the Web Audio API

---

## Resolution: Revert to Circular Buffer

### Command Run
```bash
git stash push -m "BROKEN: SharedArrayBuffer implementation - audio not playing until volume slider touched"
```

### Test After Revert ✅
```
🎵 AudioContext ready
⚡ FIRST CHUNK SENT in 12ms - starting playback!
🔊 Fade-in scheduled: 0.0001 → 1.00 over 50ms
⏱️ [393ms] Worklet confirmed playback
✅ Waveform drawn from min/max data (732 pixels) - progressive
✅ Waveform crossfade complete - pink detrended waveform
```

**Result**: Audio plays immediately, waveform draws progressively, everything works perfectly.

---

## Lessons Learned

### What Worked
1. ✅ CloudFlare header configuration
2. ✅ SharedArrayBuffer detection and initialization
3. ✅ Worker → SharedArrayBuffer write path
4. ✅ Worklet → SharedArrayBuffer read path
5. ✅ Atomic operations for synchronization
6. ✅ All logging and metrics

### What Failed
1. ❌ Audio output (despite all metrics showing it should work)
2. ❌ Understanding why volume slider touch fixes it
3. ❌ Diagnosing the root cause after 2+ hours of debugging

### Hypothesis for Future Investigation
The issue is likely:
- A timing issue with AudioParam automation when the worklet uses SharedArrayBuffer for reads
- A browser quirk where the audio graph doesn't "commit" changes until a user interaction
- A race condition between SharedArrayBuffer initialization and audio graph compilation
- An undocumented interaction between SharedArrayBuffer cross-origin isolation and Web Audio API

---

## Current State

### Branch: `linear-buffer-v2`
- Circular buffer implementation (working perfectly)
- Progressive waveform drawing
- Detrended waveform crossfade
- Time to first audio: ~390ms
- No audio dropouts (chunks small enough)

### Stashed: "BROKEN: SharedArrayBuffer implementation"
- Complete implementation available for future investigation
- All code written and tested
- Mystery audio issue unresolved

### Known Issues (From Earlier Sessions)
1. Seek/alignment bugs with circular buffer (reported but not yet reproduced in current session)
2. Waveform playback position not aligning with audio (reported but not yet reproduced)

---

## Next Steps

### Priority 1: Verify Seek Functionality
Test the circular buffer implementation with:
- Click-to-seek on waveform
- Looping behavior
- Playback speed changes
- Selection start/end boundaries

### Priority 2: Fix Any Seek Bugs (If Found)
Address any timing or alignment issues discovered in testing.

### Priority 3: SharedArrayBuffer Investigation (Optional)
If audio dropouts become an issue with larger files:
- Create minimal reproduction test case (separate HTML file)
- Test in different browsers (Chrome, Firefox, Safari)
- Report to browser vendors if confirmed as bug
- Consider alternative approaches (OffscreenCanvas, AudioWorklet → Main thread messages)

---

## Files Modified (Stashed)

### Added
- `dev_server.py` - Local development server with COOP/COEP headers
- `test_sharedarraybuffer.html` - Standalone test (noise generation worked perfectly)
- `workers/noise-processor-worklet.js` - Test worklet for noise playback
- `check_gain.js` - Debug script for monitoring gain value

### Modified (Stashed)
- `js/main.js` - SharedArrayBuffer creation and initialization
- `js/data-fetcher.js` - Skip sample transfer in SharedArrayBuffer mode
- `workers/audio-processor-worker.js` - Write to SharedArrayBuffer
- `workers/audio-worklet.js` - Read from SharedArrayBuffer
- `workers/waveform-worker.js` - Skip undefined samples in SharedArrayBuffer mode

### CloudFlare (Live)
- Transform Rules → Modify Response Header (COOP/COEP/CORP headers set)

---

## Performance Notes

### Circular Buffer (Current)
- **Memory**: Circular buffer size ~10s at 44.1kHz = 441,000 samples = 1.76 MB
- **CPU**: Main thread handles sample transfer via postMessage (structured cloning)
- **Dropouts**: None observed with current chunk sizes (10m chunks = ~125 KB)
- **Scalability**: May encounter issues with very large files or slow networks

### SharedArrayBuffer (Stashed)
- **Memory**: Linear buffer = exact file size (e.g., 180,000 samples = 360 KB for Int16)
- **CPU**: Zero main thread involvement after initialization
- **Dropouts**: Theoretically zero (if audio worked)
- **Scalability**: Should handle any file size without main thread blocking

---

## Conclusion

The SharedArrayBuffer implementation was technically sound but failed due to an undiagnosed audio output issue. The circular buffer works perfectly for current use cases, so we're proceeding with that approach. The SharedArrayBuffer work is preserved in a stash for future investigation if needed.

**Current focus**: Ensure circular buffer implementation is robust for all use cases (seek, loop, speed changes).

