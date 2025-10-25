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
