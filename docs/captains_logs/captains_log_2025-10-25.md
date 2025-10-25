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

## Version Archive

**v1.15** - Gapless audio streaming with auto-crossfade to deck mode, sample-accurate position tracking, dynamic fadeout rescheduling

Commit: `v1.15 Fix: Gapless audio streaming with auto-crossfade to deck mode, sample-accurate position tracking, dynamic fadeout rescheduling`

---
