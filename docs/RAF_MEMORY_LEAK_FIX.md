# RAF Memory Leak Fix - Closure Chain Death Spiral

**Date:** 2025-11-15  
**Issue:** Massive memory leak (132MB) from requestAnimationFrame closure chains  
**Status:** ✅ FIXED

---

## The Problem: Closure Chain Death Spiral

### What Was Happening

Two animation loops were creating infinite closure chains:
- `updatePlaybackIndicator()` in `waveform-renderer.js`
- `drawSpectrogram()` in `spectrogram-renderer.js`

Each RAF call captured the **entire previous execution context**, creating a chain:

```
Tr() → Context → 
  Tr() → Context → 
    Tr() → Context → 
      ... 103,198 times deep
```

At ~1.3KB per closure × 100k calls = **132MB memory leak**

### Root Cause

Both functions had this pattern:

```javascript
export function updatePlaybackIndicator() {
    if (State.isDragging) {
        requestAnimationFrame(updatePlaybackIndicator);  // ⚠️ Creates closure
        return;
    }
    
    if (State.playbackState !== PlaybackState.PLAYING) {
        return;  // ⚠️ RETURNS but RAF already scheduled!
    }
    
    // ... work ...
    
    requestAnimationFrame(updatePlaybackIndicator);  // ⚠️ ANOTHER ONE!
}
```

**Problem:** RAF was scheduled BEFORE early returns, creating new closures even when not needed.

---

## The Fix

### 1. Added RAF ID Tracking (`audio-state.js`)

```javascript
// Animation frame IDs (for cleanup to prevent memory leaks)
export let playbackIndicatorRAF = null;
export let spectrogramRAF = null;

export function setPlaybackIndicatorRAF(value) { playbackIndicatorRAF = value; }
export function setSpectrogramRAF(value) { spectrogramRAF = value; }
```

### 2. Fixed `updatePlaybackIndicator()` (`waveform-renderer.js`)

```javascript
export function updatePlaybackIndicator() {
    // 🔥 FIX: Cancel any existing RAF to prevent closure chain
    if (State.playbackIndicatorRAF !== null) {
        cancelAnimationFrame(State.playbackIndicatorRAF);
        State.setPlaybackIndicatorRAF(null);
    }
    
    // Early exit: dragging - schedule next frame
    if (State.isDragging) {
        State.setPlaybackIndicatorRAF(requestAnimationFrame(updatePlaybackIndicator));
        return;
    }
    
    // Early exit: not playing - STOP the loop completely
    if (State.playbackState !== PlaybackState.PLAYING) {
        return;  // No RAF scheduled = loop stops
    }
    
    // ... work ...
    
    // 🔥 FIX: Store RAF ID for proper cleanup
    State.setPlaybackIndicatorRAF(requestAnimationFrame(updatePlaybackIndicator));
}
```

### 3. Fixed `drawSpectrogram()` (`spectrogram-renderer.js`)

Same pattern:
- Cancel existing RAF at start
- Store RAF ID when scheduling
- Only schedule when actually needed

### 4. Added Cleanup Helper (`audio-player.js`)

```javascript
export function cancelAllRAFLoops() {
    if (State.playbackIndicatorRAF !== null) {
        cancelAnimationFrame(State.playbackIndicatorRAF);
        State.setPlaybackIndicatorRAF(null);
    }
    if (State.spectrogramRAF !== null) {
        cancelAnimationFrame(State.spectrogramRAF);
        State.setSpectrogramRAF(null);
    }
}
```

### 5. Added Cleanup Calls

Called `cancelAllRAFLoops()` in:
- `pausePlayback()` - when pausing
- Worklet message handler - when playback finishes
- `startStreaming()` - when starting new audio

---

## Key Principles

### ✅ DO:
1. **Store RAF IDs** in state for cleanup
2. **Cancel existing RAF** at the start of each frame
3. **Stop loops** when not needed (return without scheduling)
4. **Clean up on pause/stop** to prevent orphaned loops

### ❌ DON'T:
1. **Schedule RAF before early returns** - creates endless chains
2. **Forget to cancel** - leaves orphaned animation loops
3. **Schedule multiple times** - creates parallel loops
4. **Rely on garbage collection** - closures hold references

---

## Testing

To verify the fix:
1. Open Chrome DevTools → Memory → Take Heap Snapshot
2. Start audio playback
3. Let it run for 30+ seconds
4. Take another snapshot
5. Compare closure chains

**Before:** 103,198 nested `Tr()` calls, 132MB leak  
**After:** Single RAF loop, no closure accumulation

---

## Related Files Modified

- `js/audio-state.js` - Added RAF ID state tracking
- `js/waveform-renderer.js` - Fixed updatePlaybackIndicator loop
- `js/spectrogram-renderer.js` - Fixed drawSpectrogram loop
- `js/audio-player.js` - Added cancelAllRAFLoops helper
- `js/main.js` - Added cleanup calls on stop

---

## Prevention

**Pattern to follow for ALL future RAF loops:**

```javascript
export function myAnimationLoop() {
    // 1. Cancel existing RAF first
    if (State.myRAF !== null) {
        cancelAnimationFrame(State.myRAF);
        State.setMyRAF(null);
    }
    
    // 2. Check if loop should continue
    if (!shouldContinue) {
        return; // Stop loop completely
    }
    
    // 3. Do work
    // ...
    
    // 4. Schedule next frame and STORE THE ID
    State.setMyRAF(requestAnimationFrame(myAnimationLoop));
}
```

**Never do this:**
```javascript
function badLoop() {
    requestAnimationFrame(badLoop); // ⚠️ Creates closure chain
    if (!shouldContinue) return;    // ⚠️ RAF already scheduled!
}
```

---

## Memory Impact

**Before Fix:**
- Memory grows ~1.3KB per frame
- 60 FPS = ~78KB/second
- After 30 seconds = ~2.3MB wasted
- After 10 minutes = ~47MB wasted
- Closures never released

**After Fix:**
- Constant memory usage
- Old closures released each frame
- No accumulation over time
- Clean GC behavior

---

## Lesson Learned

**requestAnimationFrame creates closures that capture the entire scope.**

If you schedule RAF in a loop without canceling the previous one, each new call captures the previous call's context, creating an infinite chain that **cannot be garbage collected** because each closure holds a reference to the previous one.

**The fix:** Treat RAF IDs like any other resource that needs explicit cleanup. Store them, track them, and cancel them when done.

