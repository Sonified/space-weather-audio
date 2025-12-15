# Frequency Scale + Zoom Bug Fix

## 🔥 TL;DR - The Missing Piece

**If you've already implemented region detection and coordinate conversion but the fix STILL doesn't work:**

The issue is almost certainly the **`completeSpectrogramRendered` flag not being set**. After rendering a region or restoring a cached view, you MUST set this flag:

```javascript
completeSpectrogramRendered = true;
State.setSpectrogramInitialized(true);
```

Without this flag, the frequency scale change logic will skip re-rendering entirely, even if all your other code is correct.

**Where to add it:**
1. Inside `renderCompleteSpectrogramForRegion()` - after rendering completes
2. Inside `restoreInfiniteCanvasFromCache()` - after restoring cached full view (zoom out)

See [Fix Part 4](#fix-part-4-set-completespectrogramrendered-flag-critical) below for details.

---

## The Problem

**Symptoms:**
When zoomed into a region, changing the frequency scale (linear/sqrt/logarithmic) or FFT size would cause the spectrogram to render the full zoom view instead of staying zoomed into the region. The user would suddenly see the entire dataset instead of just the region they were examining.

**User Description:**
> "Ok so when I zoom into a region... change the frequency scaling, and then click on the waveform, it renders the wide zoom spectrogram... so I am suddenly just looking at the whole window while zooming in"

## Root Cause

**Primary Issue:** The `completeSpectrogramRendered` flag was not being set after certain rendering operations, causing the frequency scale change logic to skip re-rendering entirely.

**Secondary Issues:**
1. The code didn't properly detect when the user was in "region zoom mode" when changing frequency scale or FFT size
2. Even when detected, it would fail to specify which region to render, causing it to default to the full view
3. Coordinate system mismatch: the region time range was stored as `Date` objects, but the rendering function expected time values in **seconds** relative to the dataset start time

**The three flag-related bugs (from Captain's Log 2025-11-16):**
1. **Flag Lost After Zoom Out** - `restoreInfiniteCanvasFromCache()` wasn't setting `completeSpectrogramRendered = true`, so frequency scale changes didn't work after zooming out
2. **Flag Lost After Region Render** - `renderCompleteSpectrogramForRegion()` wasn't setting `completeSpectrogramRendered = true`, so subsequent scale changes in regions failed
3. **Region Scale Changes Skip Animation** - Region frequency scale changes needed fade animation added (previously skipped entirely)

## The Fix

### Fix Part 1: Detect Region Zoom Mode

When changing frequency scale or FFT size, check if we're currently zoomed into a region:

```javascript
// Check if we're zoomed into a region
if (zoomState.isInitialized() && zoomState.isInRegion()) {
    // REGION ZOOM PATH - re-render the region view
    const regionRange = zoomState.getRegionRange();
    console.log(`🔍 Inside region - animating scale transition`);

    // ... handle region rendering ...
} else {
    // FULL VIEW PATH - render entire dataset
    clearCompleteSpectrogram();
    await renderCompleteSpectrogram();
}
```

**Key points:**
- `zoomState.isInRegion()` returns `true` if currently zoomed into a region
- `zoomState.getRegionRange()` returns the region's time range as `{ startTime: Date, endTime: Date }`

### Fix Part 2: Convert Date Objects to Seconds

The rendering function `renderCompleteSpectrogramForRegion()` expects time values in **seconds** (relative to dataset start), NOT `Date` objects:

```javascript
// 🔥 FIX: Convert Date objects to seconds
const dataStartMs = State.dataStartTime ? State.dataStartTime.getTime() : 0;
const startSeconds = (regionRange.startTime.getTime() - dataStartMs) / 1000;
const endSeconds = (regionRange.endTime.getTime() - dataStartMs) / 1000;

// Re-render region with new frequency scale
resetSpectrogramState();
await renderCompleteSpectrogramForRegion(startSeconds, endSeconds, false);
```

**Key conversion formula:**
```javascript
seconds = (timestamp_ms - dataset_start_ms) / 1000
```

Where:
- `timestamp_ms` = `Date.getTime()` (milliseconds since Unix epoch)
- `dataset_start_ms` = `State.dataStartTime.getTime()` (dataset's first sample timestamp)
- Result is seconds from the start of the dataset

### Fix Part 3: Update "Elastic Friend" in Background

After re-rendering the region view, also re-render the full spectrogram in the background (called the "elastic friend"). This ensures smooth zoom-out transitions:

```javascript
// Update the elastic friend in background (for zoom-out)
console.log(`🏠 Starting background render of full spectrogram for elastic friend...`);
updateElasticFriendInBackground();
```

This prevents a second "zoom-out flash" when the user eventually zooms back out to the full view.

### Fix Part 4: Set completeSpectrogramRendered Flag (CRITICAL!)

**This is the most important fix!** After rendering operations, you MUST set the `completeSpectrogramRendered` flag. Without this flag, the frequency scale change logic will think there's no spectrogram to re-render and skip the operation entirely.

**In `renderCompleteSpectrogramForRegion()` function:**
```javascript
// After rendering completes, set the flag
completeSpectrogramRendered = true;  // ✅ THE FIX!
State.setSpectrogramInitialized(true);
```

**In `restoreInfiniteCanvasFromCache()` function:**
```javascript
// After restoring cached full view (zoom out), set the flag
completeSpectrogramRendered = true;  // ✅ THE FIX!
State.setSpectrogramInitialized(true);
```

**Why this matters:**
The `changeFrequencyScale()` function checks this flag to decide whether to re-render:
```javascript
if (isCompleteSpectrogramRendered()) {  // ← This check fails without the flag!
    // Re-render with new scale
} else {
    // Skip re-rendering (BUG!)
}
```

Without setting the flag:
- Zoom into region → flag not set
- Change frequency scale → `isCompleteSpectrogramRendered()` returns false
- Re-render skipped → user sees old frequency scale
- OR renders full view instead of region → user gets zoomed out

**Location in this codebase:**
- [js/spectrogram-complete-renderer.js:2348](js/spectrogram-complete-renderer.js#L2348) - In `renderCompleteSpectrogramForRegion()`
- [js/spectrogram-complete-renderer.js:612](js/spectrogram-complete-renderer.js#L612) - In `restoreInfiniteCanvasFromCache()`

## Complete Implementation

### In `changeFrequencyScale()` function:

```javascript
export async function changeFrequencyScale() {
    const select = document.getElementById('frequencyScale');
    const value = select.value; // 'linear', 'sqrt', or 'logarithmic'

    // ... validation and state updates ...

    State.setFrequencyScale(value);

    // Re-render if spectrogram is already rendered
    if (isCompleteSpectrogramRendered()) {
        // 🔧 FIX: Check if we're zoomed into a region
        if (zoomState.isInitialized() && zoomState.isInRegion()) {
            const regionRange = zoomState.getRegionRange();
            console.log(`🔍 Inside region - animating scale transition`);

            // 🔥 FIX: Convert Date objects to seconds
            const dataStartMs = State.dataStartTime ? State.dataStartTime.getTime() : 0;
            const startSeconds = (regionRange.startTime.getTime() - dataStartMs) / 1000;
            const endSeconds = (regionRange.endTime.getTime() - dataStartMs) / 1000;

            // 🔥 Capture old spectrogram BEFORE re-rendering (for fade animation)
            const oldSpectrogram = document.createElement('canvas');
            oldSpectrogram.width = width;
            oldSpectrogram.height = height;
            oldSpectrogram.getContext('2d').drawImage(canvas, 0, 0);

            // Re-render region with new frequency scale
            resetSpectrogramState();

            const spectrogramRenderPromise = renderCompleteSpectrogramForRegion(
                startSeconds,
                endSeconds,
                true  // Skip viewport update - we'll fade manually
            );

            await spectrogramRenderPromise;

            // ... fade animation code ...

            // 🏠 PROACTIVE FIX: Re-render full spectrogram in background
            console.log('🏠 Starting background render of full spectrogram for elastic friend...');
            updateElasticFriendInBackground();

            return; // IMPORTANT: Return here to avoid full view rendering below
        }

        // Full view path (not in region)
        resetSpectrogramState();
        await renderCompleteSpectrogram(true);

        // ... fade animation code for full view ...
    }
}
```

### In `changeFftSize()` function:

Same fix applies! FFT size changes have the exact same issue:

```javascript
export async function changeFftSize() {
    const select = document.getElementById('fftSize');
    const value = parseInt(select.value, 10);

    // ... validation and state updates ...

    State.setFftSize(value);

    // Re-render if spectrogram is already rendered
    if (isCompleteSpectrogramRendered()) {
        // 🔧 FIX: Check if we're zoomed into a region
        if (zoomState.isInitialized() && zoomState.isInRegion()) {
            const regionRange = zoomState.getRegionRange();
            console.log(`📐 Zoomed into region - re-rendering region view + elastic friend`);

            // 🔥 FIX: Convert Date objects to seconds
            const dataStartMs = State.dataStartTime ? State.dataStartTime.getTime() : 0;
            const startSeconds = (regionRange.startTime.getTime() - dataStartMs) / 1000;
            const endSeconds = (regionRange.endTime.getTime() - dataStartMs) / 1000;

            // Clear and re-render the region view
            resetSpectrogramState();
            await renderCompleteSpectrogramForRegion(startSeconds, endSeconds, false);

            // Update the elastic friend in background (for zoom-out)
            console.log(`🏠 Starting background render of full spectrogram for elastic friend...`);
            updateElasticFriendInBackground();

            return; // IMPORTANT: Return here
        } else {
            // Full view: clear and re-render
            clearCompleteSpectrogram();
            await renderCompleteSpectrogram();
        }
    }
}
```

## Implementation Checklist for Other Codebase

Apply this fix to ANY function that re-renders the spectrogram while the user might be zoomed into a region:

- [ ] **Frequency scale changes** - `changeFrequencyScale()` or similar
- [ ] **FFT size changes** - `changeFftSize()` or similar
- [ ] **Colormap changes** (if re-rendering is needed)
- [ ] **Playback rate changes** (if re-rendering spectrogram)
- [ ] **Any other parameter** that triggers spectrogram re-render

**For each function, add:**

1. Check if in region zoom mode:
   ```javascript
   if (zoomState.isInitialized() && zoomState.isInRegion()) {
   ```

2. Get region range:
   ```javascript
   const regionRange = zoomState.getRegionRange();
   ```

3. Convert timestamps to seconds:
   ```javascript
   const dataStartMs = State.dataStartTime ? State.dataStartTime.getTime() : 0;
   const startSeconds = (regionRange.startTime.getTime() - dataStartMs) / 1000;
   const endSeconds = (regionRange.endTime.getTime() - dataStartMs) / 1000;
   ```

4. Render region view (not full view):
   ```javascript
   resetSpectrogramState();
   await renderCompleteSpectrogramForRegion(startSeconds, endSeconds, false);
   ```

5. **🔥 CRITICAL: Set the flag after rendering:**
   ```javascript
   completeSpectrogramRendered = true;
   State.setSpectrogramInitialized(true);
   ```

6. Update background full view:
   ```javascript
   updateElasticFriendInBackground();
   ```

7. **IMPORTANT:** Return early to prevent full view rendering:
   ```javascript
   return;
   ```

**Also add flag-setting to these functions:**

- **In `renderCompleteSpectrogramForRegion()`**: Set `completeSpectrogramRendered = true` after rendering completes
- **In `restoreInfiniteCanvasFromCache()`** (or your zoom-out restore function): Set `completeSpectrogramRendered = true` after restoring cached full view

## Critical Details

### 1. Always Return After Region Rendering

**WRONG:**
```javascript
if (zoomState.isInRegion()) {
    await renderCompleteSpectrogramForRegion(startSeconds, endSeconds, false);
    // Missing return! Code continues to full view rendering below!
}

// This will still execute - BUG!
clearCompleteSpectrogram();
await renderCompleteSpectrogram();
```

**RIGHT:**
```javascript
if (zoomState.isInRegion()) {
    await renderCompleteSpectrogramForRegion(startSeconds, endSeconds, false);
    return; // STOP HERE!
}

// Only executes if NOT in region
clearCompleteSpectrogram();
await renderCompleteSpectrogram();
```

### 2. Time Unit Conversion

Your rendering functions might expect:
- Milliseconds (ms)
- Seconds (s)
- Sample indices
- Date objects

**Know what your function expects!** In this codebase:
- `renderCompleteSpectrogramForRegion()` expects **seconds** (relative to dataset start)
- `zoomState.getRegionRange()` returns **Date objects**
- Must convert: `(Date.getTime() - dataStartMs) / 1000`

### 3. Background Full View Rendering

The "elastic friend" is a cached full-view spectrogram that enables smooth zoom-out animations. After changing frequency scale/FFT while in region zoom:

1. User sees: Region view with new scale
2. Background: Full view is being re-rendered with new scale
3. When user zooms out: Smooth transition to the already-rendered full view

Without this, zooming out would show the old frequency scale briefly, then pop to the new scale.

## Testing

To verify the fix works:

1. **Load a dataset**
2. **Zoom into a region** (select on waveform)
3. **Change frequency scale** (linear → sqrt → logarithmic)
   - ✅ Should stay zoomed into region
   - ❌ Should NOT jump to full view
4. **Change FFT size** (e.g., 512 → 1024)
   - ✅ Should stay zoomed into region
   - ❌ Should NOT jump to full view
5. **Zoom back out** (click "Full View" or zoom out button)
   - ✅ Should show full view with the new scale
   - ✅ Transition should be smooth (no flash of old scale)

## Related Files in This Codebase

- [js/spectrogram-renderer.js](js/spectrogram-renderer.js) (lines 567-589, 693-836)
  - `changeFrequencyScale()` - frequency scale change handling
  - `changeFftSize()` - FFT size change handling
- [js/zoom-state.js](js/zoom-state.js)
  - `isInRegion()` - check if zoomed into region
  - `getRegionRange()` - get region time bounds
- [js/spectrogram-complete-renderer.js](js/spectrogram-complete-renderer.js)
  - `renderCompleteSpectrogramForRegion()` - render region view
  - `updateElasticFriendInBackground()` - render full view in background

## Summary

**The bug:** Changing frequency scale or FFT size while zoomed into a region would incorrectly render the full view instead of the region view, OR skip re-rendering entirely.

**The fix (in order of importance):**
1. **🔥 MOST CRITICAL:** Set `completeSpectrogramRendered = true` flag after:
   - Rendering region view (`renderCompleteSpectrogramForRegion()`)
   - Restoring cached full view (`restoreInfiniteCanvasFromCache()`)
   - Without this flag, frequency scale changes won't work at all!
2. Detect if in region zoom mode (`zoomState.isInRegion()`)
3. Convert region time range from Date objects to seconds
4. Explicitly call region rendering function with correct time bounds
5. Update background full view for smooth zoom-out
6. Return early to prevent full view rendering

**Key insights:**
- **The flag is everything**: Without `completeSpectrogramRendered = true`, the frequency scale change logic won't even attempt to re-render. This is the #1 reason the fix doesn't work in other codebases.
- When the user changes a parameter that requires spectrogram re-rendering, you must explicitly specify WHETHER to render the full view or a region view. The default behavior (no specification) will render the full view, causing the "zoom out" bug.

**From Captain's Log 2025-11-16 (v2.20):**
> "Flag Lost After Zoom Out - Fixed `restoreInfiniteCanvasFromCache()` to set `completeSpectrogramRendered = true` so frequency scale changes work after zooming out"
>
> "Flag Lost After Region Render - Fixed `renderCompleteSpectrogramForRegion()` to set `completeSpectrogramRendered = true` so subsequent scale changes animate correctly"
