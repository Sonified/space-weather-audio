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

---


