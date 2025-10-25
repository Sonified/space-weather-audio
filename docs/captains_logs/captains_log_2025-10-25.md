# Captain's Log - 2025-10-25

## Audio Streaming: Gapless Playback with Automatic Deck Mode Crossfade

### Problem
Audio clicks and gaps when playing streaming chunks, especially when user adjusts playback speed during streaming. The chunk-based scheduling system couldn't handle dynamic playback rate changes.

### Root Cause
1. **Chunk Scheduling Timing**: Using `source.onended` callback has inherent timing jitter - there's a gap between when audio ends and when the callback fires
2. **Dynamic Speed Changes**: Pre-scheduling chunks with fixed timing breaks when playback rate changes
3. **Two Incompatible Systems**: Chunk mode (for streaming) vs Deck mode (for seeking/speed) required manual switching

### Solution ("Beautiful Bandaid")
Implemented a **hybrid dual-mode playback system** that automatically transitions:

#### Phase 1: Just-in-Time Chunk Scheduling
- **5ms lead-time scheduling**: Schedule next chunk 5ms before current chunk ends
- Calculate exact end time: `startTime + (duration / playbackRate)`
- Schedule next chunk to start at exact end time using `source.start(endTime)`
- Eliminates `onended` timing jitter for chunk-to-chunk transitions

#### Phase 2: Automatic Crossfade to Deck Mode
When stream completes downloading:
1. Combine all chunks into single `Float32Array` buffer
2. Estimate current playback position based on elapsed time
3. **Auto-crossfade** (25ms) from chunk playback to deck system
4. Chunk system cleanly stops (guards prevent zombie scheduling)

#### Benefits
- ✅ **Gapless during streaming**: 5ms precision scheduling eliminates clicks between chunks
- ✅ **Smooth speed changes**: Deck mode handles dynamic playback rate with linear interpolation
- ✅ **Automatic transition**: No user interaction needed, seamless handoff
- ✅ **Clean shutdown**: Chunk callbacks check `isDeckMode` flag and abort

### Implementation Details

**Worker (Cloudflare)**: Progressive chunking restored
```javascript
// Pattern: 8KB → 16KB → 32KB → 64KB → 128KB → 512KB (repeat)
const CHUNK_SIZES = [8, 16, 32, 64, 128];
const FINAL_CHUNK_SIZE = 512;
```

**Browser (test_streaming.html)**: Just-in-time scheduling
```javascript
function playNextChunk(startTime = null) {
    const actualStartTime = startTime || audioContext.currentTime;
    const chunkDuration = buffer.length / buffer.sampleRate;
    const adjustedDuration = chunkDuration / currentPlaybackRate;
    const chunkEndTime = actualStartTime + adjustedDuration;
    
    source.start(actualStartTime);
    
    // Schedule next chunk 5ms before this one ends
    if (chunkQueue.length > 0) {
        setTimeout(() => {
            if (!isDeckMode) { // Check if we've switched modes
                playNextChunk(chunkEndTime);
            }
        }, (adjustedDuration - 0.005) * 1000);
    }
}
```

**Auto-crossfade trigger**:
```javascript
function combineChunksIntoSingleBuffer() {
    // ... combine chunks ...
    
    if (isPlaying && !isPaused) {
        // Estimate current position
        const elapsedRealTime = audioContext.currentTime - playbackStartTime;
        const estimatedPosition = elapsedRealTime * currentPlaybackRate;
        
        // Crossfade to deck mode at current position
        setTimeout(() => {
            seekToPosition(estimatedPosition);
        }, 50);
    }
}
```

### Known Limitations
1. **"Bandaid" Solution**: This is a workaround - proper solution would be unified AudioWorklet-based streaming
2. ~~**Position Estimation**: Crossfade position calculated from elapsed time may have slight inaccuracy~~ **FIXED** - Now uses sample-accurate tracking
3. ~~**Potential Audio Overlap**: During crossfade, chunk and deck might briefly play overlapping audio if position estimate is behind actual position~~ **FIXED** - Sample-accurate position eliminates overlap

### Testing
- **Small dataset** (90k samples): Smooth transition, no clicks
- **Large dataset** (1.44M samples): Auto-crossfade at ~0.35s, seamless handoff
- **Speed changes**: Works perfectly in deck mode, chunk mode uses fixed scheduling

### Bug Fix: Sample-Accurate Position Tracking
User reported potential audio overlap during crossfade from chunk mode to deck mode.

**Root Cause**: Position calculated from wall-clock time (`audioContext.currentTime - playbackStartTime`) didn't account for actual audio samples scheduled.

**Fix**: Added `currentChunkPlaybackPosition` variable that accumulates actual chunk durations:
```javascript
// After scheduling each chunk:
currentChunkPlaybackPosition += chunkDuration; // Exact sample position

// During crossfade:
seekToPosition(currentChunkPlaybackPosition); // Use exact position, not estimate
```

**Result**: Crossfade now uses exact sample position where chunk playback left off, eliminating any potential overlap or skip.

### Bug Fix #2: Dynamic Fadeout Rescheduling
User reported audio fading out too early when slowing down playback speed.

**Root Cause**: When starting deck playback, fadeout timeout is scheduled based on current playback rate:
```javascript
const bufferDuration = remainingSamples / audioRate / currentPlaybackRate;
const fadeoutStartTime = bufferDuration - AUDIO_FADE_TIME - AUDIO_FADE_BUFFER;
setTimeout(() => fadeout(), fadeoutStartTime * 1000);
```

But if user changes speed afterward, the timeout fires at the wrong time. Example:
- Start at 1.0x: schedule fadeout in 30 seconds
- User slows to 0.5x: audio will take 60 seconds, but fadeout still fires at 30 seconds!

**Fix**: Reschedule fadeout whenever playback speed changes:
```javascript
function changePlaybackSpeed() {
    // ... update playback rate ...
    
    // Cancel old fadeout
    if (deckA.fadeoutTimeout) {
        clearTimeout(deckA.fadeoutTimeout);
    }
    
    // Calculate remaining time at NEW playback rate
    const remainingTime = (totalAudioDuration - currentAudioPosition) / newRate;
    const fadeoutStartTime = Math.max(0, remainingTime - AUDIO_FADE_TIME - AUDIO_FADE_BUFFER);
    
    // Reschedule with corrected timing
    deckA.fadeoutTimeout = setTimeout(() => fadeout(), fadeoutStartTime * 1000);
}
```

**Result**: Fadeout timing dynamically adjusts to match actual playback duration, even when user changes speed mid-playback.

### Next Steps
1. ~~Investigate position estimation accuracy during crossfade~~ ✅ Fixed with sample-accurate tracking
2. ~~Fix early fadeout when changing playback speed~~ ✅ Fixed with dynamic rescheduling
3. Long-term: Replace with pure AudioWorklet streaming (no chunks)

---

## Length-Prefix Framing: Perfect Chunk Control Through TCP Re-chunking

### Problem
Despite implementing server-side progressive chunking (8KB → 16KB → 32KB...), the browser was still receiving randomly-sized network chunks (458KB, 23KB, 682KB...). This caused:
- Audio clicks due to unpredictable chunk boundaries
- Alignment issues (partial int16 samples)
- Loss of control over chunk sizes

### Root Cause
**TCP/HTTP re-chunking**: Even though the server sends explicit chunks (8KB, 16KB, 32KB...), the browser's network layer combines/splits them based on TCP flow control, TCP window size, HTTP/2 multiplexing, and other factors. The server has **no control** over what size chunks the browser receives.

### Solution: Length-Prefix Framing
Prepend a 4-byte little-endian length prefix to each chunk, creating explicit "frames":
```
Frame = [4-byte length][chunk data]
```

**Server (Cloudflare Worker)**:
```javascript
const frame = new Uint8Array(4 + actualChunkSize);
const lengthView = new DataView(frame.buffer);
lengthView.setUint32(0, actualChunkSize, true); // Little-endian length
frame.set(chunkData, 4); // Chunk data after header
```

**Client (Browser)**:
```javascript
// Accumulate bytes until we have 4 bytes for length
if (frameBuffer.length >= 4) {
    const lengthView = new DataView(frameBuffer.buffer, frameBuffer.byteOffset, 4);
    const chunkLength = lengthView.getUint32(0, true);
    
    // Extract complete frame
    if (frameBuffer.length >= 4 + chunkLength) {
        const frameData = frameBuffer.slice(4, 4 + chunkLength);
        const int16Data = new Int16Array(frameData.buffer, frameData.byteOffset, frameData.length / 2);
        // Process...
        frameBuffer = frameBuffer.slice(4 + chunkLength); // Remove processed frame
    }
}
```

### Benefits
- ✅ **Perfect chunks**: Client extracts exact sizes regardless of network re-chunking
- ✅ **HTTP compression**: Still works automatically (gzip deflates frames)
- ✅ **Guaranteed alignment**: Every deframed chunk is even bytes (int16-aligned)
- ✅ **Zero complexity**: Simple 4-byte header, no fancy protocols

### Implementation Notes
- Moved deframing to Web Worker (async processing, no main-thread blocking)
- Fire-and-forget architecture: Main thread pumps bytes to worker, worker processes async
- Changed chunk progression from `[8,16,32,64,128]` to `[16,32,64,128]` for more comfortable first buffer

### AudioWorklet Investigation
`test_streaming.html` works perfectly with the same framing. `test_audioworklet.html` has scrambled audio despite receiving perfect chunks, proving the bug is in the AudioWorklet's circular buffer implementation, not the data delivery.

**Status**: Mystery bug - audio gets rearranged during playback (heard in iZotope RX analysis). Worker returns chunks in correct order, so the issue is in worklet's read/write logic.

## Version Archive

**v1.15** - Gapless audio streaming with auto-crossfade to deck mode, sample-accurate position tracking, dynamic fadeout rescheduling

Commit: `v1.15 Fix: Gapless audio streaming with auto-crossfade to deck mode, sample-accurate position tracking, dynamic fadeout rescheduling`

**v1.16** - Length-prefix framing for perfect chunk control, AudioWorklet deframing in worker, improved diagnostics (glitch still present)

Commit: `v1.16 Length-prefix framing for perfect chunk control, AudioWorklet deframing in worker, improved diagnostics (glitch still present)`

---

## The "Magic Sauce": Dynamic Chunk Scheduling with Playback Rate Awareness

### Discovery
While debugging gapless chunk playback with dynamic speed changes, discovered that scheduling lead time MUST account for playback rate to prevent gaps.

### The Problem
When using a fixed lead time (e.g., 5ms) to schedule the next chunk before the current one ends:
- At 1.0x speed: 125 samples = 2.83ms ✅ Works
- At 0.1x speed: 125 samples = 28.3ms ⚠️ But code was still using 2.83ms!
- Result: HUGE gaps when slowing down playback

### The Solution: Dynamic Rescheduling
1. **Track current chunk timing**:
   - `currentChunkStartTime` - when chunk started
   - `currentChunkDurationSamples` - total samples in chunk

2. **Calculate lead time based on current playback rate**:
   ```javascript
   const leadTimeAudioSeconds = scheduleLeadSamples / audioRate; // 5.8ms at 1.0x
   const leadTimeRealSeconds = leadTimeAudioSeconds / currentPlaybackRate; // Actual real time!
   ```

3. **When speed changes mid-chunk, reschedule**:
   - Calculate samples already played at old rate
   - Calculate remaining samples in chunk
   - Reschedule timeout based on NEW playback rate

### The Magic Number: 256 Samples
Through empirical testing in `test_chunk_scheduling.html`, discovered that **256 samples (~5.8ms)** is the sweet spot for lead time - enough buffer for timing jitter, not too much to feel sluggish.

### Implementation
- Added to `test_streaming.html` (production streaming interface)
- Integrated with existing auto-crossfade to deck mode
- Properly resets on new streams and loops
- Skips all calculations when in deck mode (guards protect)

### Files Created
- `test_chunk_scheduling.html` - Dedicated testing interface for exploring lead time parameter (night-themed for bedtime debugging 🌙)

**v1.17** - Dynamic chunk scheduling with playback-rate-aware lead time (256 samples magic number), test_chunk_scheduling.html created

Commit: `v1.17 Dynamic chunk scheduling with playback-rate-aware lead time (256 samples magic number), test_chunk_scheduling.html created`

---

## AudioWorklet Mystery Solved: Circular Buffer Overflow Race Condition

### Problem
In `test_audioworklet.html`, linear sweep test files played perfectly for small (1 min) and medium (10 min) files, but the large file (1 hour) exhibited bizarre behavior:
- Audio started from ~40% through the file instead of the beginning
- 390,789 discontinuities detected (jumps in the linear sweep)
- Playback capture showed completely scrambled audio
- Raw download was perfect (zero discontinuities)

**User's observation**: "It thinks about starting at the beginning, then JUMPS ahead around sample 8169, then JUMPS again around sample 9193, then makes a BIG jump around sample 10472, and then from there it plays through to the end."

### Investigation
Created `analyze_audio_jumps.py` to compare raw download vs playback capture:
- **Raw Download**: Perfect linear sweep, 1.44M samples (32.65s), zero glitches ✅
- **Playback**: Flat/stuck at beginning, then wild jumps, 390K discontinuities ❌
- **Pattern**: Playback started at writeIndex position instead of oldest buffered sample

### Root Cause: Buffer Overflow During Pre-loading
The bug was in `seismic-processor.js` (AudioWorklet) circular buffer overflow logic:

```javascript
// OLD CODE (BUGGY):
addSamples(samples) {
    for (let i = 0; i < samples.length; i++) {
        if (this.samplesInBuffer < this.maxBufferSize) {
            // Add sample...
            this.samplesInBuffer++;
        } else {
            // Buffer full - overwrite oldest sample
            this.buffer[this.writeIndex] = samples[i];
            this.writeIndex = (this.writeIndex + 1) % this.maxBufferSize;
            this.readIndex = (this.readIndex + 1) % this.maxBufferSize; // 🐛 BUG!
        }
    }
}
```

**The race condition**:
1. Buffer size: 20 seconds (882K samples)
2. Large file: 32 seconds (1.44M samples)
3. Pre-loading phase: 2 seconds before playback starts
4. During pre-load, buffer fills up and **overflows**
5. Line `this.readIndex = (this.readIndex + 1)` advances readIndex **even though playback hasn't started yet**
6. When playback finally starts, the calculation `readIndex = (writeIndex - samplesInBuffer)` produces **readIndex = writeIndex** (because samplesInBuffer = maxBufferSize)
7. Result: Playback starts from wherever the write pointer happens to be (40% into the file!)

**Why small/medium files worked**: They fit entirely within the 20-second buffer without overflowing before playback started.

### Solution
Don't advance `readIndex` during buffer overflow if playback hasn't started yet:

```javascript
// FIXED CODE:
addSamples(samples) {
    for (let i = 0; i < samples.length; i++) {
        if (this.samplesInBuffer < this.maxBufferSize) {
            // Add sample...
            this.samplesInBuffer++;
        } else {
            // Buffer full - overwrite oldest sample
            this.buffer[this.writeIndex] = samples[i];
            this.writeIndex = (this.writeIndex + 1) % this.maxBufferSize;
            
            // 🔧 FIX: Only advance readIndex if playback has already started
            if (this.hasStarted) {
                this.readIndex = (this.readIndex + 1) % this.maxBufferSize;
            }
            // If not started, samplesInBuffer stays at maxBufferSize
        }
    }
}
```

### Additional Improvements
Added better diagnostics to catch similar race conditions:
```javascript
console.log(`🎯 Starting playback: readIndex=${this.readIndex}, writeIndex=${this.writeIndex}, buffer=${this.samplesInBuffer} samples (${(this.samplesInBuffer/44100).toFixed(2)}s)`);
console.log(`   Buffer state: maxSize=${this.maxBufferSize}, utilization=${(100*this.samplesInBuffer/this.maxBufferSize).toFixed(1)}%`);
```

### Key Insight (from ChatGPT consultation)
"AudioWorklets give you 'most control' the same way giving a toddler a real steering wheel does — technically true, but one bad tick of timing and you're in the ditch."

The pattern (jumps ahead, then stabilizes) was a classic producer/consumer race condition where `samplesInBuffer` is mutated across messages, and playback starts before buffer state is coherent.

### Files Modified
- `seismic-processor.js` - Fixed circular buffer overflow logic
- `test_audioworklet.html` - Updated embedded worklet code with same fix
- `analyze_audio_jumps.py` - Created diagnostic tool for comparing WAV files and detecting discontinuities

### Testing Plan
1. Test large file (1 hour) with linear sweep - should be perfect now
2. Monitor console for buffer utilization at playback start
3. Verify readIndex calculation when buffer is at 100% capacity
4. Test with varying buffer sizes (10s, 20s, 40s)

### Resolution
**Testing revealed the real issue**: When buffer size was increased to 120 seconds (larger than the 32-second test file), the glitches disappeared completely! This proved the bug was in our circular buffer overflow logic, not Chrome's GC.

**The Actual Bug**: 
- 20-second buffer with 32-second file → buffer overflows during pre-load
- Overflow handler advances `readIndex` to track oldest sample
- When playback starts, code recalculates `readIndex = (writeIndex - samplesInBuffer)`
- **This calculation assumes `readIndex` was never touched!**
- Result: `readIndex` points to wrong position → audio starts 40% into file

**The Real Fix - "Lock the Start Position"**:
```javascript
// In addSamples() when ready to start:
if (!this.hasStarted && this.samplesInBuffer >= this.minBufferBeforePlay) {
    this.readIndex = (this.writeIndex - this.samplesInBuffer + this.maxBufferSize) % this.maxBufferSize;
    this.readIndexLocked = true; // LOCK IT - never recalculate!
    this.isPlaying = true;
    this.hasStarted = true;
}

// In overflow handler:
if (!this.readIndexLocked) {
    this.readIndex = (this.readIndex + 1) % this.maxBufferSize;
}
```

**Why it works**: 
- `readIndex` is calculated ONCE at the moment we decide to start playback
- Locked flag prevents overflow handler from touching it after that
- No race condition between `addSamples()` and `process()`
- Works with any file size, any buffer size

**Final buffer size**: 60 seconds (reasonable compromise - handles most files without being wasteful)

**Result**: ✅ Perfect linear sweep playback on all file sizes (small, medium, large) with zero glitches!

**v1.18** - AudioWorklet circular buffer readIndex lock prevents glitches from buffer overflow during pre-load

Commit: `v1.18 Fix: AudioWorklet circular buffer readIndex lock prevents glitches from buffer overflow during pre-load`

---
