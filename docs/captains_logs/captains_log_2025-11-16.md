# Captain's Log - 2025-11-16

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

