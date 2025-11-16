# Captain's Log - 2025-11-16

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

