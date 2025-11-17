# Captain's Log - 2025-11-17

---

## 🎨 Tutorial System & UI Polish (v2.32)

### Features & Fixes

1. **Tutorial Overlay System**
   - Created new `tutorial.js` module for tutorial guidance
   - Added "Click me!" text overlay on waveform after first data fetch
   - Fire red/orange pulsing glow effect synchronized with waveform border pulse
   - Text disappears when user clicks waveform for the first time
   - Smaller font size (28px) with muted colors for subtlety

2. **Waveform Pulse Animation**
   - Added subtle pulsing glow around waveform border after data fetch
   - Only shows until user clicks waveform for the first time
   - Muted red/orange colors matching tutorial text
   - 1.2s pulse animation synchronized with tutorial text

3. **Volcano Selector Pulse**
   - Added pulsing glow around volcano dropdown selector on page load
   - Same muted red/orange color scheme
   - Disappears when user selects volcano or clicks "Fetch Data"
   - Reappears on each page load (no persistence)

4. **Speed & Volume Controls**
   - Speed and volume sliders now disabled and greyed out until data is fetched
   - Labels have reduced opacity (0.5) when disabled
   - Automatically enabled after data fetch completes
   - Disabled again when loading new data

5. **Status Message Cleanup**
   - Removed "Seeking to" status messages
   - Removed "Playing! (Worker-accelerated)" status messages
   - Removed "System ready" text (kept "Select a volcano and click 'Fetch Data.'")
   - Loading messages now clear automatically when loading completes

6. **Spectrogram Overlay Smooth Transition**
   - Fixed overlay opacity to update immediately when transition starts (not delayed)
   - Removed CSS transition, now updates directly via JavaScript during RAF loop
   - Smooth fade in/out synchronized with zoom transition

### Key Changes
- `js/tutorial.js` - New module for tutorial overlay management
- `js/data-fetcher.js` - Enable speed/volume controls after data fetch, show tutorial overlay
- `js/waveform-renderer.js` - Hide tutorial on first click
- `js/main.js` - Add volcano selector pulse, disable speed/volume on load, enable after fetch
- `js/spectrogram-complete-renderer.js` - Fixed overlay transition timing
- `js/audio-player.js` - Removed "Seeking to" status messages
- `styles.css` - Added tutorial glow animation, volcano pulse animation, disabled slider styles
- `index.html` - Disabled speed/volume controls initially, removed "System ready" text

### Benefits
- ✅ Better user guidance with tutorial overlay
- ✅ Visual feedback with pulsing elements
- ✅ Cleaner status messages
- ✅ Controls disabled until data is ready
- ✅ Smooth overlay transitions

### Version
v2.32 - Commit: "v2.32 Feat: Tutorial system with 'Click me!' overlay, waveform pulse animation, volcano selector pulse, disabled speed/volume until data fetch, status message cleanup"

---

## 🧹 Critical Memory Leak Fixes (v2.33)

### Problem Discovered
Heap snapshot analysis revealed massive memory leaks:
- **2081 ArrayBuffer instances** holding **1.9GB** of memory
- **1,116,143 Function instances** holding **1.7GB** of memory  
- **147,758 Context instances** holding **1.6GB** of memory
- Total leak: **~5.2GB** preventing garbage collection

### Root Causes & Fixes

1. **ArrayBuffer Leaks**
   - **Problem**: Event listeners (`addEventListener`) on worklet port weren't being removed, retaining closures that captured `processedChunks` with Float32Array references
   - **Problem**: Float32Array slices created from `completeSamplesArray` shared the same ArrayBuffer, preventing GC
   - **Fix**: Store handler references in State and remove them during cleanup
   - **Fix**: Copy slices to new ArrayBuffers before sending to worklet
   - **Fix**: Explicitly null old values before reassignment in setters

2. **Function Leaks**
   - **Problem**: Event listeners were being added multiple times without cleanup, creating duplicate closures
   - **Problem**: `window.stopZoomTransition` was creating new closures each time
   - **Problem**: RAF callbacks in `stopZoomTransition()` weren't being tracked
   - **Fix**: Guard to ensure event listeners are only added once
   - **Fix**: Store handler references for proper cleanup
   - **Fix**: Track RAF IDs to prevent duplicate callbacks

3. **Context Leaks**
   - **Problem**: `waveform-x-axis-renderer.js` was imported both statically and dynamically, creating duplicate Context instances
   - **Fix**: Removed dynamic import, use static imports directly

### Files Changed
- `js/audio-state.js` - Added handler state tracking, improved setter to null old values
- `js/data-fetcher.js` - Store and remove event listener handlers properly
- `js/main.js` - Fixed event listener setup, use static imports instead of dynamic
- `js/waveform-x-axis-renderer.js` - Track RAF IDs to prevent duplicates
- `js/waveform-renderer.js` - Clear old displayWaveformData before reassignment

### Memory Impact
**Before**: ~5.2GB memory leak, growing indefinitely  
**After**: Proper cleanup, memory should remain stable

### Version
v2.33 - Commit: "v2.33 Fix: Critical memory leak fixes - ArrayBuffer, Function, and Context leaks"

---

## 🎯 Tutorial System Improvements & Status Text Enhancements (v2.34)

### Features & Fixes

1. **Status Text Typing Animation**
   - All status messages now type out character-by-character with human-like jitter
   - Variable delay (20ms base ± 10ms jitter) for natural typing feel
   - Period at end of sentences pulses 5 times (appears/disappears)
   - Animation can be cancelled to prevent conflicts

2. **Click-to-Copy Status Text**
   - Status text is now clickable to copy to clipboard
   - Visual feedback: shows "✓ Copied!" for 1 second
   - Pointer cursor and tooltip indicate clickability
   - Works for all status messages

3. **Loading Message Fixes**
   - Loading animation stops immediately when all samples are received
   - Completion message replaces loading message without gap/flash
   - Fixed issue where loading text would flash or disappear prematurely
   - Message "👇 Click on the waveform below to move the playhead." appears after download completes

4. **User Guidance Flow**
   - Initial message: "<- Select a volcano and click Fetch Data." (with typing animation)
   - After 10 seconds without fetch: appends "You got this!" (if not dismissed)
   - After download: "👇 Click on the waveform below to move the playhead."
   - After first click: "Well done!" (holds 2 seconds) → "Click and drag to select a region (sideways)"
   - Removed "Playing..." messages per user request

5. **Animation Cancellation**
   - Fixed memory leak where typing animations would continue after being cleared
   - Added `cancelTyping()` function to stop both typing and pulse animations
   - Properly tracks and clears both `activeTypingTimeout` and `activePulseTimeout`

6. **Session-Level Tracking**
   - Tutorial overlay and pulse animation show only once per browser session
   - Initial message dismissed flag prevents it from reappearing
   - Encouragement timeout cleared when user fetches data

### Files Changed
- `js/tutorial.js` - Added typing animation, pulse animation, click-to-copy, animation cancellation
- `js/main.js` - Initial message with typing, encouragement timeout, cancel typing on fetch
- `js/data-fetcher.js` - Fixed loading message timing, show completion message after download
- `js/waveform-renderer.js` - "Well done!" → "Click and drag" sequence after first click
- `index.html` - Removed pre-written status text

### Benefits
- ✅ Engaging typing animation makes status messages more noticeable
- ✅ Click-to-copy improves usability
- ✅ Smooth loading → completion message transition
- ✅ Better user guidance flow from start to finish
- ✅ Fixed animation memory leaks

### Version
v2.34 - Commit: "v2.34 UI: Tutorial system improvements - status text typing animation, click-to-copy, loading message fixes, and user guidance flow"

---

