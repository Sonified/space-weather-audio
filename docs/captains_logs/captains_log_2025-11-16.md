# Captain's Log - 2025-11-16

---

## 🎨 Logarithmic Spectrogram Tick Sync Fix (v2.10)

### Problem
Logarithmic spectrogram ticks were drifting out of sync with the spectrogram when playback speed changed. Linear and square root scales worked perfectly, but log scale had vertical drift.

### Root Cause
Logarithmic scale is **NOT homogeneous** (unlike linear/sqrt). The tick positioning was:
1. Scaling frequency by playbackRate FIRST: `effectiveFreq = freq * playbackRate`
2. Then applying log transform with FIXED denominator: `logMax = log10(originalNyquist)`

But the spectrogram stretch factor was calculating with a CHANGING denominator based on playbackRate, causing a mismatch.

### Solution
For logarithmic scale, calculate the **1x position first** using the fixed denominator, then **apply the stretch factor to the position** (not the frequency):

1. **Calculate 1x position** using fixed `logMax = log10(originalNyquist)`
2. **Apply stretch factor** to the position itself (matches GPU stretching)
3. Added `calculateStretchFactorForLog()` helper that matches spectrogram stretch factor logic

### Key Insight
- **Linear/sqrt**: Homogeneous transforms - scaling frequency first works ✓
- **Logarithmic**: Non-homogeneous - must stretch positions, not scale frequencies ✓

### Files Modified
- `js/spectrogram-axis-renderer.js` - Updated `getYPositionForFrequencyScaled()` for log scale, added `calculateStretchFactorForLog()` helper
- `js/spectrogram-complete-renderer.js` - Fixed spectrogram rendering to use actual frequencies (not bin indices) and match tick positioning

### Version
v2.10 - Commit: "v2.10 Fix: Logarithmic spectrogram tick sync - calculate 1x position first then apply stretch factor"

---

## 🧹 ArrayBuffer Memory Leak Fix (v2.09)

### Changes Made
Fixed ArrayBuffer memory leak where 3,685+ Float32Array chunks (36MB) were being retained through RAF callback closures:

1. **Copy Slices When Storing in allReceivedData**
   - Modified `data-fetcher.js` to copy slices to new ArrayBuffers when storing in `allReceivedData`
   - Prevents all chunks from sharing the same underlying ArrayBuffer
   - Allows individual chunks to be garbage collected independently
   - Applied to both R2 worker path and Railway backend path

2. **Clear allReceivedData After Stitching**
   - Added `State.setAllReceivedData([])` immediately after stitching chunks into `completeSamplesArray`
   - Breaks closure chain: RAF callback → State → allReceivedData → 3,685 chunks
   - Now RAF callbacks only reference empty array instead of retaining all chunks
   - Applied in both R2 worker stitching and `buildCompleteWaveform` helper

3. **Optimized Seek/Loop Chunk Sending**
   - Removed unnecessary copy when sending chunks to worklet in seek/loop operations
   - Worklet copies data into its own buffer anyway, so no need to copy before sending
   - Only copy when storing in `allReceivedData` (where leak occurs)

### Memory Impact
- Before: 3,685 Float32Array chunks (36MB) retained through RAF closures
- After: `allReceivedData` cleared after stitching, chunks can be GC'd immediately
- Expected reduction: ~36MB freed after data stitching completes

### Files Modified
- `js/main.js` - Optimized seek/loop chunk sending (removed unnecessary copy)
- `js/data-fetcher.js` - Copy slices when storing in allReceivedData, clear after stitching

### Version
v2.09 - Commit: "v2.09 Memory Leak Fix: Fixed ArrayBuffer retention by copying slices and clearing allReceivedData after stitching"

---

## 🧹 Aggressive RAF Cleanup & Modal Fixes (v2.08)

### Changes Made
Added aggressive cleanup to prevent RAF callbacks from retaining detached documents:

1. **Page Unload Handlers**
   - Added `beforeunload` and `pagehide` event listeners to cancel all RAF callbacks
   - Ensures RAF callbacks scheduled before page unload are cancelled
   - Prevents detached documents from retaining RAF callbacks

2. **Visibility Change Handler**
   - Added `visibilitychange` event listener to cancel RAF when page becomes hidden
   - Catches cases where page is backgrounded or navigated away
   - Prevents RAF callbacks from accumulating when page is not visible

3. **Scale Transition RAF Cleanup**
   - Added `cancelScaleTransitionRAF()` function to `spectrogram-axis-renderer.js`
   - Exported function for cleanup during page unload
   - Prevents scale transition animations from retaining detached documents

4. **Crossfade Animation Cleanup**
   - Added crossfade animation cancellation to `cancelAllRAFLoops()`
   - Ensures waveform crossfade animations are cancelled during cleanup

5. **Improved Modal Cleanup**
   - Added guard to prevent duplicate modal initialization
   - Improved `removeModalEventListeners()` to clear all child nodes before removal
   - Better handling of both attached and detached modals

### Files Modified
- `js/main.js` - Added page unload/visibility handlers, improved cleanup
- `js/audio-player.js` - Added crossfade animation cleanup to cancelAllRAFLoops
- `js/spectrogram-axis-renderer.js` - Added cancelScaleTransitionRAF function
- `js/modal-templates.js` - Added initialization guard, improved cleanup
- `js/ui-controls.js` - Improved removeModalEventListeners cleanup

### Version
v2.08 - Commit: "v2.08 Memory Leak Fixes: Added page unload/visibility handlers to cancel RAF, improved modal cleanup, added cancelScaleTransitionRAF"

---

## 🧹 Memory Leak Fixes: NativeContext Leaks in RAF Callbacks (v2.07)

### Changes Made
Fixed NativeContext accumulation from RAF callbacks that were executing on detached documents:

1. **Spectrogram Axis Transition RAF**
   - Added document connection check to `scaleTransitionRAF` callback in `spectrogram-axis-renderer.js`
   - Stops animation and clears RAF reference if document is detached
   - Prevents RAF callbacks from retaining references to detached documents

2. **Spectrogram Fade Animation RAF**
   - Added document connection check to `fadeStep` callback in `spectrogram-renderer.js`
   - Stops fade animation if document is detached
   - Prevents crossfade RAF callbacks from accumulating

3. **Waveform Crossfade Animation RAF**
   - Added document connection check to `animate` callback in `waveform-renderer.js`
   - Clears animation reference and stops if document is detached
   - Prevents waveform crossfade RAF callbacks from accumulating

4. **Modal Event Listener Cleanup**
   - Added guard to prevent duplicate modal event listener attachment
   - Added `removeModalEventListeners()` function to clone modals before re-adding listeners
   - Ensures old closures (NativeContext instances) can be garbage collected

### Files Modified
- `js/spectrogram-axis-renderer.js` - Added document connection check to scaleTransitionRAF
- `js/spectrogram-renderer.js` - Added document connection check to fadeStep callback
- `js/waveform-renderer.js` - Added document connection check to animate callback
- `js/ui-controls.js` - Added modal listener cleanup to prevent duplicate attachment

### Version
v2.07 - Commit: "v2.07 Memory Leak Fixes: Fixed NativeContext leaks in RAF callbacks (spectrogram-axis, spectrogram fade, waveform crossfade), added modal listener cleanup"

---

## 🎨 UI Improvements: Frequency Ticks, Padding, Dropdown Transparency (v2.07)

### Changes Made
1. **Linear Frequency Ticks at 10x Speed**
   - Added 0.1 Hz increments when playback speed reaches 10x
   - Provides finer granularity for high-speed playback analysis
   - Modified `generateLinearTicks()` in `spectrogram-axis-renderer.js`

2. **Spectrogram Controls Padding**
   - Reduced top padding: `margin-top: 10px` → `8px`, `padding-top: 2px` → `4px`
   - Set bottom padding: `padding-bottom: 0` → `15px` (via `.panel-visualization`)
   - Adjusted panel top padding: `padding-top: 20px` → `12px`
   - Better spacing around "Play on Click" checkbox and frequency scale dropdown

3. **Semi-Transparent Dropdowns**
   - Frequency scale dropdown: 90% opacity (`rgba(255, 255, 255, 0.9)`)
   - Volcano dropdown: 80% opacity (`rgba(255, 255, 255, 0.8)`)
   - General select elements: 90% opacity
   - Less stark white appearance, better visual integration

### Files Modified
- `js/spectrogram-axis-renderer.js` - Added 0.1 Hz increments at 10x speed
- `index.html` - Adjusted padding for spectrogram controls, added transparency to dropdowns
- `styles.css` - Adjusted `.panel-visualization` padding, updated select background opacity

### Version
v2.07 - Commit: "v2.07 UI: Added 0.1Hz ticks at 10x speed, adjusted padding, semi-transparent dropdowns"

---

