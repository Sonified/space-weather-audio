# The Disappearing Canvas Boxes Saga
## A 5-8 Hour Debugging Nightmare - Solved Nov 19, 2025

### 🔥 The Symptom

Feature boxes on the spectrogram would **completely disappear** when:
- Switching browser tabs and returning
- Computer going to sleep and waking up
- Any `document.hidden` → visible transition

The boxes would **NEVER come back**. Users would lose all visual feedback of their work. Hotkeys would stop working. The interface would enter a "stuck state."

### 😤 The Frustration

**Time Invested**: 5-8 hours of intense debugging during a tight deadline (all-nighter territory)

**What Made It So Hard**:
1. **Half-States**: The app would arrive in these weird intermediate states where some things worked, some didn't
2. **Inconsistent Reproduction**: Sometimes it would work, sometimes it wouldn't, making it feel like a race condition
3. **The Red Herring**: The waveform canvas on the SAME PAGE worked perfectly fine, making the broken spectrogram canvas even more baffling
4. **Misleading Error Messages**: Saw "rebuildCanvasBoxesFromRegions is not a function" but that was a SYMPTOM, not the root cause

**What Was Tried**:
- Comparing every single line against the working waveform implementation
- Checking if regions were being saved (they were!)
- Checking if regions were being loaded (they were!)
- Verifying data structures were intact (they were!)
- Emergency canvas recovery systems
- Multiple attempts at "fixing" the redraw logic
- Hair pulling

### 🕵️ The Investigation

The error logs revealed a clue:
```javascript
TypeError: rebuildCanvasBoxesFromRegions is not a function
```

But this was misleading - the function name was wrong (should be `redrawAllCanvasFeatureBoxes`), but even fixing that didn't solve it. The REAL issue was deeper.

### 💡 The Breakthrough

**The Root Cause**: During earlier optimization work, an AI assistant had implemented aggressive memory management to reduce the app's memory footprint. Part of this optimization was:

```javascript
// Previous cleanup logic (TOO AGGRESSIVE)
if (document.hidden) {
    cleanupOnUnload(); // Destroys EVERYTHING including canvas overlay
}
```

This cleanup was:
✅ **Good**: Saved memory when tab was hidden  
❌ **Bad**: Destroyed the canvas overlay completely  
❌ **CRITICAL**: Never recreated it when the page became visible again  

So the app would:
1. User switches tab → Canvas destroyed ✅
2. User returns → No canvas exists ❌
3. App tries to draw on non-existent canvas → Silent failure ❌
4. Boxes never appear → User sees "stuck state" ❌

### ✨ The Solution

**Aggressive Destroy/Recreate Strategy**:

```javascript
const visibilityChangeHandler = () => {
    if (document.hidden) {
        // Aggressive cleanup when hidden - save memory, stop animations
        console.log('💤 Page hidden - aggressive cleanup');
        audioPlayerModule.cancelAllRAFLoops();
        axisModule.cancelScaleTransitionRAF();
        cleanupSpectrogramSelection(); // Destroy canvas overlay
    } else {
        // Page visible again - recreate everything and restore state
        console.log('👁️ Page visible again - recreating canvas and restoring state');
        
        // Recreate spectrogram selection canvas
        setupSpectrogramSelection();
        
        // Redraw all feature boxes on fresh canvas
        import('./spectrogram-renderer.js').then(module => {
            if (module.redrawAllCanvasFeatureBoxes) {
                module.redrawAllCanvasFeatureBoxes();
            }
        }).catch(() => {
            // Module not loaded yet
        });
        
        // Restart playhead if playing when tab becomes visible again
        if (State.playbackState === PlaybackState.PLAYING) {
            startPlaybackIndicator();
        }
    }
};
```

**What This Does**:
1. ✅ Destroy canvas when hidden (save memory)
2. ✅ Recreate canvas when visible (restore functionality)
3. ✅ Redraw all boxes (restore visual state)
4. ✅ Continue audio playback (never interrupted)

### 🎵 Important Clarification

**`cancelAllRAFLoops()` does NOT stop audio!**

It only cancels RequestAnimationFrame loops for visual elements:
- `playbackIndicatorRAF` - Red playback line animation
- `spectrogramRAF` - Scrolling spectrogram visualization
- `resizeRAF` - Resize handler animation
- `crossfadeAnimation` - Volume crossfade animation

**Audio continues playing** in the Web Audio worklet (separate audio thread). Perfect behavior!

### 🧠 Key Lessons Learned

1. **Optimization Can Introduce Bugs**: The memory optimization was well-intentioned but broke core functionality by not having a matching restoration path.

2. **Cleanup Needs Matching Setup**: Every aggressive cleanup (destroy) MUST have a corresponding setup (recreate) triggered at the right time.

3. **Half-States Are Clues**: When you're in a "half-state" where some things work and others don't, look for asymmetric initialization/cleanup.

4. **Compare Working vs Broken**: The waveform worked because it WASN'T being destroyed on visibility change. This contrast was the key.

5. **Document Optimization Decisions**: When an AI (or developer) makes aggressive optimizations, document WHY and HOW to reverse them if needed.

### 🎯 Impact

**Before Fix**:
- ❌ Boxes disappear on tab switch
- ❌ Never come back
- ❌ Interface stuck
- ❌ Hotkeys broken
- ❌ User loses all visual feedback

**After Fix**:
- ✅ Boxes disappear on tab switch (saves memory)
- ✅ Boxes recreated on tab return (perfect restoration)
- ✅ Interface fully functional
- ✅ Hotkeys work
- ✅ Audio never interrupted
- ✅ Memory efficient

### 📝 Files Modified

- `js/main.js` - Updated `visibilityChangeHandler` with aggressive destroy/recreate strategy
- `docs/captains_logs/captains_log_2025-11-19.md` - Documented as v2.56

### 🚀 Git Commit

**Version**: v2.56  
**Commit**: `v2.56 Canvas Redrawing: Aggressive destroy/recreate strategy for overlay canvas on visibility change`  
**Date**: November 19, 2025

---

## For Future AI Assistants

If you see canvas boxes disappearing and never coming back:

1. ✅ Check if canvas is being destroyed on visibility change
2. ✅ Check if canvas is being recreated when page becomes visible
3. ✅ Verify `setupSpectrogramSelection()` is called on visibility restore
4. ✅ Verify `redrawAllCanvasFeatureBoxes()` is called after canvas recreation
5. ✅ Look for asymmetric cleanup/setup patterns

**DO NOT** try to "fix" the redraw logic - the redraw logic is fine! The canvas itself is missing!

**This bug cost 5-8 hours of debugging time. Don't let it happen again.**

