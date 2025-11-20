# Captain's Log - 2025-11-20

## v2.66 - Memory Optimization: Static Imports Replace Dynamic Imports

### Memory Leak Fix
**CRITICAL: Function object accumulation from dynamic imports**
- **Problem**: 317,362 Function objects accumulating in memory, causing performance degradation
- **Root Cause**: Dynamic imports (`import('./module.js').then(...)`) create new function closures on EVERY call, even though the module itself is cached. When called in RAF loops (60fps), event handlers, or transition animations, this creates thousands of function objects per second
- **Solution**: Replaced 46 dynamic imports with static imports. Static imports resolve once at module load time - no closure accumulation, same function reference reused forever
- **Result**:
  - Eliminated Function object accumulation
  - Better memory efficiency (one function reference vs thousands)
  - Better performance (no async overhead, direct function calls)
  - Simpler code (no `.then()` chains)
- **Files Modified**:
  - `js/region-tracker.js` - Replaced 11 dynamic imports
  - `js/waveform-x-axis-renderer.js` - Replaced 3 dynamic imports (including one in RAF callback)
  - `js/main.js` - Replaced 3 dynamic imports
  - `js/audio-player.js` - Replaced 3 dynamic imports
  - `js/spectrogram-renderer.js` - Replaced 5 dynamic imports
  - `js/waveform-renderer.js` - Replaced 2 dynamic imports

---

## v2.65 - Spectrogram Transition & Zone Rendering Fixes

### Bug Fixed
**CRITICAL: Transition animation broken, zone rendering producing empty canvases**
- **Problem**: 
  1. Frame-skipping logic was dropping frames during zoom transitions, making the elastic canvas animation disappear
  2. Zone sample calculation was wrong when changing frequency scale while zoomed in, producing empty canvases
- **Root Cause**:
  1. Time-based frame skipping (16ms window) was too aggressive and skipped legitimate frames
  2. Zone sample calculation used absolute offsets instead of relative offsets from renderStartSeconds
- **Solution**:
  1. Changed frame-skipping from time-based to progress-based - only skips if called with identical progress value (same frame)
  2. Fixed zone sample calculation to use relative offsets: `zone.start - renderStartSeconds` instead of `zone.start * originalSampleRate - startSample`
- **Result**:
  - Smooth, crisp transition animations restored
  - Zone rendering works correctly when changing frequency scale while zoomed in
  - More efficient - only prevents truly redundant work, doesn't skip legitimate frames
- **Files Modified**: 
  - `js/spectrogram-complete-renderer.js` - Fixed frame-skipping logic and zone sample calculation

---

## v2.64 - UI Fix: Delete Feature Button CSS Specificity Issue

### Bug Fixed
**VISUAL: Disabled delete button was bouncing and misaligned on hover**
- **Problem**: The disabled delete button (gray circle with ×) in the first feature row was bouncing on hover and sitting at the wrong vertical position
- **Root Cause**: CSS specificity battle - `button:disabled` selector (specificity 0,1,1) was overriding `.delete-feature-btn-inline` (specificity 0,1,0) and applying `transform: none !important`, which killed the `translateY(-50%)` centering
- **Solution**: Added `transform: translateY(-50%) !important;` to `.delete-feature-btn-inline.disabled` rule to maintain vertical centering even when disabled
- **Files Modified**: `styles.css` - Updated `.delete-feature-btn-inline.disabled` to preserve transform

---

## Bug Fix: Black Spectrogram When Changing Frequency Scale While Zoomed In

### Bug Fixed

**CRITICAL: HQ Spectrogram Goes Black When Changing Frequency Scale Modes While Zoomed In**
- **Problem**: When zoomed into a region and changing frequency scale modes (linear/sqrt/logarithmic), the HQ spectrogram would go completely black instead of re-rendering with the new scale
- **Root Cause**: Two bugs working together:
  1. **Type Mismatch**: `getRegionRange()` returns `startTime` and `endTime` as Date objects, but `renderCompleteSpectrogramForRegion()` expects seconds (numbers). When Date objects were passed directly, the sample calculations produced invalid values (NaN or out-of-bounds), resulting in `zoneSampleCount=0` and an empty canvas.
  2. **Invalid hopSize Calculation**: When `zoneSampleCount` was 0 due to the type mismatch, `zoneHopSize` could be 0 or negative, causing no batches to be created and leaving the canvas empty.

### Solution

**Fixed Type Conversion in Two Locations:**
1. **`spectrogram-renderer.js`** (line ~449-468): In `changeFrequencyScale()`, convert Date objects to seconds before calling `renderCompleteSpectrogramForRegion()`:
   ```javascript
   const dataStartMs = State.dataStartTime ? State.dataStartTime.getTime() : 0;
   const startSeconds = (regionRange.startTime.getTime() - dataStartMs) / 1000;
   const endSeconds = (regionRange.endTime.getTime() - dataStartMs) / 1000;
   ```

2. **`spectrogram-complete-renderer.js`** (line ~273-278): In `renderCompleteSpectrogram()`, same conversion when rendering region instead of full view.

**Added Safety Guards:**
- Ensured `zoneHopSize` is always at least 1 to avoid division by zero
- Added validation to skip zones that can't render (with warning)
- Fixed playhead calculation in fade animation to use seconds instead of Date objects

### Result

- Frequency scale changes now work correctly while zoomed into regions
- Spectrogram re-renders with the new frequency scale instead of going black
- Diagnostic logging helps identify any future rendering issues

### Files Modified
- `js/spectrogram-renderer.js` - Fixed Date to seconds conversion in `changeFrequencyScale()`
- `js/spectrogram-complete-renderer.js` - Fixed Date to seconds conversion in `renderCompleteSpectrogram()`, added hopSize validation

---

