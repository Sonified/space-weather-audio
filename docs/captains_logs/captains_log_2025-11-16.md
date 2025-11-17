# Captain's Log - 2025-11-16

---

## 🔄 Zoom State Reset Fix (v2.18)

### Problem
When zoomed into a region and then selecting a new volcano to listen to, the new file would load but the playhead wouldn't begin rendering immediately. The playhead rendering was using stale zoom state from the previous volcano.

### Root Cause
When loading new data in `startStreaming()`, the zoom state wasn't being reset. If you were zoomed into a region from volcano A, then switched to volcano B:
- `zoomState.mode` was still 'region'
- `zoomState.currentViewStartSample` and `currentViewEndSample` still had old region bounds
- `zoomState.activeRegionId` still referenced the old region
- When new data loaded, `zoomState.initialize()` set `totalSamples` but didn't reset the mode or view bounds
- Playhead rendering used `zoomState.sampleToPixel()` which used the stale region bounds, causing incorrect positioning

### Solution
Reset zoom state to full view when loading new data in `startStreaming()`, before the new data is fetched. This ensures:
1. `mode` is reset to 'full'
2. `currentViewStartSample` is reset to 0
3. `activeRegionId` is cleared
4. When new data loads, `zoomState.initialize()` sets `currentViewEndSample` to the new total samples

### Key Changes
- `js/main.js`: Added zoom state reset in `startStreaming()` before loading new data
- Added import for `zoomState` from `zoom-state.js`

### How It Works
1. User switches volcano while zoomed into a region
2. `startStreaming()` is called
3. **NEW**: Zoom state is reset to full view (mode='full', startSample=0, activeRegionId=null)
4. New data is fetched and loaded
5. `zoomState.initialize()` sets `totalSamples` and `currentViewEndSample` for new data
6. Playhead rendering uses correct full-view bounds

### Benefits
- ✅ Playhead renders immediately when switching volcanoes
- ✅ No state leakage between different volcanoes
- ✅ Clean zoom state for each new dataset
- ✅ Prevents rendering issues from stale region bounds

### Files Modified
- `js/main.js` - Added zoom state reset in `startStreaming()`

### Version
v2.18 - Commit: "v2.18 Fix: Reset zoom state when loading new data - prevents playhead rendering issues when switching volcanoes while zoomed into a region"

---

## ⌨️ Spacebar Play/Pause Fix (v2.17)

### Problem
The spacebar handler had complex logic that was trying to auto-select regions when starting playback, which caused multiple issues:
1. When paused in zoom mode, pressing spacebar would auto-select the region (unwanted behavior)
2. When starting playback in zoom mode, pressing spacebar would auto-select the region (preventing users from creating their own selections)
3. When zoomed out and pressing spacebar, it would jump into a region unexpectedly

### Root Cause
The spacebar handler was calling `setSelectionFromActiveRegionIfExists()` before `togglePlayPause()`, trying to be "helpful" by setting selections. However, the play/pause button works perfectly without any of this logic - it just calls `togglePlayPause()` directly.

### Solution
Simplified the spacebar handler to exactly mirror the play/pause button behavior - just call `togglePlayPause()` directly, no selection logic at all.

### Key Changes
- `js/main.js`: Removed all auto-selection logic from spacebar handler, now just calls `togglePlayPause()` like the button does
- Removed unused `zoomState` import

### How It Works
1. Spacebar pressed → Check if button is enabled
2. If enabled → Call `togglePlayPause()` directly
3. That's it! No selection logic, no zoom checks, just toggle play/pause

### Benefits
- ✅ Spacebar behavior now matches button exactly
- ✅ No unexpected auto-selection behavior
- ✅ Users can create their own selections within regions
- ✅ Much simpler, easier to maintain code

### Files Modified
- `js/main.js` - Simplified spacebar handler to mirror button behavior

### Version
v2.17 - Commit: "v2.17 Fix: Spacebar play/pause now mirrors button behavior exactly - removed auto-selection logic that was causing issues"

---

## 🎨 Spectrogram Regions & Selections (v2.16)

### Feature
Added lightweight region highlights and selection boxes to the spectrogram canvas, mirroring the waveform functionality but with subtler styling.

### Implementation
1. **New Functions in `region-tracker.js`**:
   - `drawSpectrogramRegionHighlights()` - Draws blue region highlights (15% active, 8% inactive opacity)
   - `drawSpectrogramSelection()` - Draws yellow selection boxes (8% fill, 35% stroke opacity)
   - Both use zoom-aware positioning and interpolated time ranges for smooth transitions

2. **Integration in `spectrogram-complete-renderer.js`**:
   - Added drawing calls in `updateSpectrogramViewport()` and `drawInterpolatedSpectrogram()`
   - Regions/selections drawn on top of spectrogram after rendering

3. **Playhead Integration in `spectrogram-playhead.js`**:
   - All playhead functions now redraw regions/selections after restoring from viewport
   - Uses clipping for strip updates to maintain performance optimization
   - Ensures regions/selections stay visible during playhead movement and scrub preview

### Styling
- **Regions**: Lighter than waveform (15%/8% vs 50%/25% opacity), 1px borders (vs 2px)
- **Selections**: Subtle yellow (8% fill, 35% stroke vs 20%/80% on waveform), 1px borders
- **Fade-out**: Regions fade to 0% opacity when zooming into a region (smooth transition)
- **No UI clutter**: No numbers or buttons, just clean highlights

### Benefits
- ✅ Visual consistency between waveform and spectrogram
- ✅ Regions/selections stay aligned during zoom transitions
- ✅ Lightweight styling doesn't distract from spectrogram data
- ✅ Smooth fade-out when zooming into regions

### Files Modified
- `js/region-tracker.js` - Added spectrogram drawing functions
- `js/spectrogram-complete-renderer.js` - Integrated region/selection drawing
- `js/spectrogram-playhead.js` - Redraw regions/selections after playhead updates

### Version
v2.16 - Commit: "v2.16 Feat: Spectrogram regions and selections - lightweight blue highlights and yellow selection boxes, fade out when zooming into regions"

---

## 🔍 Waveform Zoom-Out & Zoom Button Click Fixes (v2.15)

### Problem 1: Waveform Zoom-Out Issue
When zooming back out from a region, the waveform would zoom back out to the zoomed-in region itself rather than immediately showing the full view. The animation was stretching the zoomed-in cached canvas instead of using the full waveform.

### Problem 2: Zoom Button Clicks Triggering Scrub Preview
Clicking the zoom buttons (🔍/↩️) on the canvas would trigger the white playhead/scrub preview to appear, which was distracting and not intended behavior.

### Root Cause 1
The waveform wasn't caching the full view before zooming in (unlike the spectrogram which has an "elastic friend"). When zooming out:
1. `zoomToFull()` would set zoom state to 'full'
2. Animation would start, calling `drawInterpolatedWaveform()`
3. `drawInterpolatedWaveform()` used `State.cachedWaveformCanvas` which still contained the zoomed-in waveform
4. The full waveform was only rebuilt AFTER the animation completed
5. Result: Animation stretched the zoomed-in waveform instead of the full waveform

### Root Cause 2
The `mousedown` handler immediately called `updateScrubPreview()` which draws the white playhead, but the zoom button check only happened in `mouseup`. So the scrub preview would appear before the zoom button click was detected.

### Solution 1: Cache Full Waveform Before Zooming In
1. **Added `cachedFullWaveformCanvas` to state** - Stores the full waveform before zooming in (like spectrogram's elastic friend)
2. **Cache before zooming in** - In `zoomToRegion()`, cache the full waveform canvas before changing zoom state
3. **Restore when zooming out** - In `zoomToFull()`, immediately restore the cached full waveform to `State.cachedWaveformCanvas`
4. **Let interpolation handle transition** - `drawInterpolatedWaveform()` now uses the cached full waveform and stretches it during animation

### Solution 2: Check Zoom Buttons in mousedown
1. **Check zoom buttons BEFORE scrub preview** - In `mousedown` handler, check for zoom button clicks before calling `updateScrubPreview()`
2. **Return early if zoom button** - If a zoom button is clicked, return early to prevent scrub preview from starting
3. **Handle zoom in mouseup** - Check for zoom buttons in `mouseup` even when not dragging (in case we returned early from mousedown)

### Key Changes
- `js/audio-state.js`: Added `cachedFullWaveformCanvas` state variable and setter
- `js/region-tracker.js`:
  - `zoomToRegion()`: Cache full waveform before zooming in
  - `zoomToFull()`: Restore cached full waveform immediately, clear cache after transition
- `js/waveform-renderer.js`:
  - `mousedown`: Check for zoom buttons before starting scrub preview
  - `mouseup`: Check for zoom buttons first, even when not dragging

### How It Works
1. **Zooming IN**: Full waveform is cached before zoom state changes
2. **Zooming OUT**: Cached full waveform is restored immediately, `drawInterpolatedWaveform()` stretches it during animation
3. **Zoom button clicks**: Detected in `mousedown` before scrub preview starts, preventing white playhead from appearing

### Benefits
- ✅ Instant visual feedback when zooming out (uses cached full waveform)
- ✅ Smooth interpolation transition (stretches cached full waveform)
- ✅ No scrub preview when clicking zoom buttons
- ✅ Consistent with spectrogram behavior (both use cached full view)

### Files Modified
- `js/audio-state.js` - Added `cachedFullWaveformCanvas` state
- `js/region-tracker.js` - Cache/restore full waveform for zoom transitions
- `js/waveform-renderer.js` - Prevent scrub preview on zoom button clicks

### Version
v2.15 - Commit: "v2.15 Fix: Waveform zoom-out now uses cached full waveform (like spectrogram), zoom button clicks no longer trigger scrub preview"

---

## 🐛 Spectrogram Playback Rate Stretch Bug Fix (v2.14)

### Problem
When changing playback speed, the spectrogram would show ghosting/flickering - the correctly stretched spectrogram would appear, then immediately get overwritten by an unstretched version. The spectrogram appeared to "fight" between two different renderings.

### Root Cause
The `drawSpectrogramPlayhead()` function was using `getCachedSpectrogramCanvas()` which returns the **unstretched "elastic friend"** (stored at neutral 1x playback rate). When the playback rate changed:
1. `updateSpectrogramViewport()` correctly drew the stretched spectrogram ✅
2. Playback RAF loop called `drawSpectrogramPlayhead()` 
3. `drawSpectrogramPlayhead()` restored strips from the **unstretched cache**, overwriting the stretched version ❌

The same issue affected `drawSpectrogramScrubPreview()`, `clearSpectrogramScrubPreview()`, and `resetSpectrogramPlayhead()`.

### Solution
Changed all playhead functions to use `getSpectrogramViewport(playbackRate)` instead of `getCachedSpectrogramCanvas()`. This ensures they always restore from the **correctly stretched viewport** that matches the current playback rate.

### Key Changes
- `js/spectrogram-playhead.js`:
  - Changed import from `getCachedSpectrogramCanvas` to `getSpectrogramViewport`
  - `drawSpectrogramPlayhead()`: Now gets viewport with current playback rate and restores from stretched viewport
  - `drawSpectrogramScrubPreview()`: Now draws stretched viewport when showing scrub preview
  - `clearSpectrogramScrubPreview()`: Now restores from stretched viewport
  - `resetSpectrogramPlayhead()`: Now redraws from stretched viewport

### How It Works
- `getSpectrogramViewport(playbackRate)` returns a canvas with the spectrogram correctly stretched for the given playback rate
- All playhead operations now use this stretched viewport instead of the unstretched cache
- The spectrogram stays correctly stretched at all playback rates without ghosting

### Benefits
- ✅ No more ghosting/flickering when changing playback speed
- ✅ Spectrogram stays correctly stretched at all playback rates
- ✅ Playhead operations are consistent with the displayed spectrogram
- ✅ Works correctly for all frequency scales (linear, sqrt, logarithmic)

### Files Modified
- `js/spectrogram-playhead.js` - Changed all functions to use stretched viewport instead of unstretched cache
- `js/spectrogram-complete-renderer.js` - Added logging to track all spectrogram drawing operations (debugging)

### Version
v2.14 - Commit: "v2.14 Fix: Spectrogram playback rate stretch bug - playhead now uses stretched viewport instead of unstretched cache"

---

## 🎨 Smooth Opacity Transitions for Regions During Zoom (v2.13)

### Problem
Region highlights had fixed opacity that changed instantly when zooming, creating a jarring visual experience. Also, inactive regions disappeared immediately when zooming in, preventing smooth fade-out.

### Solution
1. **Smooth opacity interpolation during zoom transitions** - Opacity now smoothly fades over the 1-second transition period
2. **Direction-aware transitions** - Tracks whether zooming IN (to region) or OUT (to full view) to interpolate correctly
3. **All regions visible during transitions** - Non-active regions stay visible during transitions so they can fade out smoothly

### Key Changes
- `js/waveform-x-axis-renderer.js`:
  - Added `isZoomingToRegion` flag to track transition direction
  - Added `getRegionOpacityProgress()` function for opacity interpolation (0.0 = full view, 1.0 = zoomed in)
  - Added `isZoomTransitionInProgress()` helper function
  - Updated `animateZoomTransition()` to accept `zoomingToRegion` parameter
- `js/region-tracker.js`:
  - Active regions: Smoothly interpolate from 50% → 20% opacity (full view → zoomed in)
  - Inactive regions: Smoothly interpolate from 25% → 10% opacity (full view → zoomed in)
  - Only skip non-active regions when fully zoomed in AND not in transition
  - Border opacity also interpolates smoothly (90% → 40% for active regions)

### How It Works
- **Zooming IN**: Opacity smoothly fades from full view values to zoomed values over 1 second
- **Zooming OUT**: Opacity smoothly fades from zoomed values back to full view values over 1 second
- **During transition**: All regions are drawn so they can fade smoothly
- **After transition**: When fully zoomed in, only active region is shown (performance optimization)
- Uses ease-out cubic easing for smooth deceleration

### Benefits
- ✅ Smooth, professional-looking transitions
- ✅ Less visual intensity when zoomed in (easier to see waveform details)
- ✅ Inactive regions fade out gracefully instead of disappearing instantly
- ✅ Consistent visual experience in both zoom directions

### Files Modified
- `js/waveform-x-axis-renderer.js` - Added transition direction tracking and opacity progress helpers
- `js/region-tracker.js` - Implemented smooth opacity interpolation for all regions

### Version
v2.13 - Commit: "v2.13 Feat: Smooth opacity transitions for regions during zoom - active regions fade 50%→20%, inactive fade 25%→10%, all regions visible during transitions"

---

## 🎯 Region Visibility During Zoom Transitions (v2.12)

### Problem
Regions were disappearing during zoom transitions, specifically during the 300ms crossfade animation when the waveform worker finished rebuilding. Users would see regions disappear briefly at the end of transitions.

### Root Cause
The crossfade animation in `drawWaveformFromMinMax()` was drawing the old and new waveforms but **never calling `drawRegionHighlights()` during the animation**. Regions were only drawn AFTER the crossfade completed, creating a visible gap.

### Solution
1. **Added `drawRegionHighlights()` inside crossfade animation loop** - Regions now draw on every frame of the crossfade
2. **Moved initial `drawWaveformWithSelection()` call** - Called immediately after updating `zoomState`, before animation starts

### Key Changes
- `js/waveform-renderer.js` (line 189): Added `drawRegionHighlights(ctx, width, height)` inside crossfade animation loop
- `js/region-tracker.js` (line 1605): Moved `drawWaveformWithSelection()` to immediately after `zoomState` update

### How It Works
1. Update `zoomState` → regions immediately redraw at new positions
2. RAF animation → regions drawn via `drawInterpolatedWaveform()`
3. Animation completes → `drawWaveform()` sends to worker
4. Worker finishes → `drawWaveformFromMinMax()` starts crossfade
5. **Crossfade animation → regions drawn on EVERY frame** (fixes the gap!)
6. Crossfade completes → `drawWaveformWithSelection()` called (regions already visible)

### Benefits
- ✅ Regions stay visible throughout entire transition
- ✅ No flash or disappearance during crossfade
- ✅ Smooth visual experience

### Files Modified
- `js/waveform-renderer.js` - Added region drawing to crossfade animation loop
- `js/region-tracker.js` - Moved initial region draw to immediately after zoomState update

### Version
v2.12 - Commit: "v2.12 Fix: Region visibility during zoom transitions - regions now stay visible throughout crossfade animation"

---

## ⌨️ Hourglass Button Spacebar Fix (v2.10)

### Problem
When clicking the hourglass button (zoom button) for region zooming, the button would capture focus and prevent spacebar from working to play/pause audio. Users had to click elsewhere before spacebar would work.

### Solution
1. **Updated spacebar handler** to specifically allow zoom buttons (`.zoom-btn`) to work with spacebar
2. **Added blur() to zoom button click handler** so the button doesn't maintain focus after clicking

### Key Changes
- `js/main.js` (line 878-883): Added check for zoom button class, allowing spacebar to work with zoom buttons
- `js/region-tracker.js` (line 728): Added `e.target.blur()` after zoom button click to remove focus

### How It Works
- Spacebar handler now checks if button is a zoom button (`isZoomButton`)
- If it's a zoom button, spacebar handler continues (doesn't return early)
- Zoom button automatically blurs after click, so spacebar works immediately

### Files Modified
- `js/main.js` - Updated spacebar handler to allow zoom buttons
- `js/region-tracker.js` - Added blur() to zoom button click handler

### Version
v2.10 - Commit: "v2.10 Fix: Hourglass button spacebar fix - zoom buttons no longer capture spacebar"

---

## 🎵 Graceful Auto-Resume with Fade-In (v2.11)

### Problem
When playing back at high speeds (e.g., 10x), playback can catch up to the download stream. When the worklet's buffer runs dry (`samplesInBuffer === 0`), playback stops, but new data continues arriving. The worklet accumulates data silently without resuming playback, leaving the system in a confused state where:
- Playback has stopped
- Status still shows "downloading"
- User can hit play, but the system is confused

### Root Cause
The worklet's `addSamples()` method has `autoResume` parameter support, but:
1. Main thread wasn't setting `autoResume: true` during progressive download
2. When buffer ran dry during download, `isPlaying` was set to false
3. New chunks arrived but didn't trigger auto-resume because `autoResume` wasn't set

### Solution
1. **Added `autoResume: true` to chunk messages** during progressive streaming (both CDN and Railway paths)
2. **Enhanced worklet's auto-resume logic** to start fade-in when resuming after buffer underrun

### Key Changes
- `js/data-fetcher.js` (line 591, 1349): Added `autoResume: true` when sending chunks to worklet
- `workers/audio-worklet.js` (line 457): Enhanced auto-resume to call `startFade(+1, this.fadeTimeMs)` for graceful resumption

### How It Works
1. Playback at 10x speed → buffer runs dry → playback stops
2. New chunks arrive → `addSamples()` receives `autoResume: true`
3. When buffer reaches threshold (1,024 samples ≈ 23ms) → auto-resume with fade-in
4. Playback resumes smoothly without user intervention

### Benefits
- ✅ Uses existing `autoResume` infrastructure (minimal code change)
- ✅ Fast recovery (uses seek threshold, not initial threshold)
- ✅ Graceful fade-in on resume (no clicks/pops)
- ✅ No status confusion - worklet handles it autonomously

### Files Modified
- `js/data-fetcher.js` - Added `autoResume: true` to chunk messages
- `workers/audio-worklet.js` - Enhanced auto-resume to start fade-in

### Version
v2.11 - Commit: "v2.11 Feat: Graceful auto-resume with fade-in when playback catches up to download stream"

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

