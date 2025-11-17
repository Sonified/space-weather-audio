# Captain's Log - 2025-11-17

---

## 🧹 Memory Leak Fixes - Event Listeners & Observers (v2.37)

### Problem Discovered
Memory snapshot analysis revealed:
- **54 Window objects** with **191MB retained size** (81% of total)
- **Detached HTMLDocument** instances accumulating
- Event listeners accumulating without cleanup
- ResizeObserver not being disconnected

### Root Causes & Fixes

1. **ResizeObserver Leak** (`tutorial-effects.js`)
   - **Problem**: ResizeObserver for tutorial overlay was never disconnected
   - **Fix**: Track ResizeObserver instance and disconnect when overlay is hidden
   - **Impact**: Prevents observer from holding references to DOM nodes

2. **Event Listener Accumulation** (`spectrogram-renderer.js`)
   - **Problem**: `setupSpectrogramSelection()` was adding duplicate `document` listeners each time it was called
   - **Fix**: Added guard to only setup once, store handler references for cleanup
   - **Fix**: Added `cleanupSpectrogramSelection()` function
   - **Impact**: Prevents multiple closures holding references to entire module scopes

3. **Event Listener Accumulation** (`keyboard-shortcuts.js`)
   - **Problem**: `initKeyboardShortcuts()` could potentially be called multiple times
   - **Fix**: Added guard to only initialize once
   - **Fix**: Added `cleanupKeyboardShortcuts()` function
   - **Impact**: Prevents duplicate listeners creating multiple Window object references

4. **setTimeout Chain Leaks** (`tutorial-coordinator.js`)
   - **Problem**: Recursive setTimeout chains in `waitForPlaybackResume` weren't always cleaned up
   - **Fix**: Track timeout IDs and provide cleanup functions
   - **Fix**: Improved cleanup in `skippableWait` to call cleanup functions
   - **Impact**: Prevents timeout chains from accumulating

5. **Window Properties** (`tutorial-coordinator.js`)
   - **Problem**: `window._onSpeedSliderTutorialComplete` wasn't cleaned up after tutorial completion
   - **Fix**: Clean up in finally block of `runMainTutorial()`
   - **Impact**: Prevents window properties from accumulating

6. **Cleanup on Page Unload** (`main.js`)
   - **Fix**: Added cleanup calls to page unload handler
   - **Fix**: Uses statically imported functions to avoid creating new Context instances
   - **Impact**: Ensures listeners are removed when page unloads

### Files Changed
- `js/tutorial-effects.js` - Track and disconnect ResizeObserver
- `js/spectrogram-renderer.js` - Prevent duplicate listeners, add cleanup function
- `js/keyboard-shortcuts.js` - Prevent duplicate listeners, add cleanup function
- `js/tutorial-coordinator.js` - Fix setTimeout chain leaks, cleanup window properties
- `js/main.js` - Add cleanup calls to unload handler

### Memory Impact
**Before**: 54 Window objects, 191MB retained size, accumulating over time  
**After**: Proper cleanup prevents accumulation, memory should stabilize

### Version
v2.37 - Commit: "v2.37 Fix: Memory leak fixes - ResizeObserver cleanup, event listener accumulation prevention, setTimeout chain cleanup"

---

## 🎓 Tutorial System Complete Refactoring with Async/Await (v2.36)

### Major Refactoring

1. **Complete Tutorial System Overhaul**
   - Refactored entire tutorial system to use elegant async/await pattern
   - Replaced nested setTimeout callbacks with clean linear async functions
   - Created `tutorial-coordinator.js` - beautiful LEGO-block style tutorial sequence
   - Each tutorial section is now a clean async function that can be easily reordered

2. **Pause Button Tutorial Refactored**
   - Converted from nested callbacks to async/await
   - Uses `skippableWait()` for timed sections (skippable with Enter key)
   - Uses `waitForPlaybackState()` to wait for user actions
   - Clean linear flow: show message → wait for pause → wait 1s → show "press again" → wait for resume → wait 1s → show "Great!" → wait 2s → complete

3. **Speed Slider Tutorial Refactored**
   - Converted from complex event-driven callbacks to async/await
   - Uses helper functions: `waitForSliderInteraction()`, `waitForDirectionDetection()`, `waitForThresholdCross()`, `waitForClick()`
   - All timed sections use `skippableWait()` - can be skipped with Enter
   - Dynamic speed message updates without retyping - only speed value changes

4. **Spectrogram Explanation Enhanced**
   - Added "This is a spectrogram of the data." as first message
   - Expanded to three messages: introduction, time flow, frequency explanation
   - Each message has appropriate wait times (3s, 5s, 5s)
   - Glow stays active through all spectrogram messages

### Features & Fixes

1. **Skippable Waits**
   - All timed sections can be skipped with Enter key
   - Makes testing and iteration much faster
   - Uses `setTutorialPhase()` to track and allow skipping

2. **Emoji Rendering Fix**
   - Fixed emoji rendering issue where they appeared as bullets
   - Changed typing animation to use `Array.from(text)` for proper Unicode handling
   - Added emoji font fallbacks to CSS

3. **Speed Message Dynamic Updates**
   - Initial message types out with animation
   - Updates to speed value happen instantly without retyping
   - Only the speed number changes (e.g., "1.11x" → "1.15x")

4. **Timing Improvements**
   - "Great!" message triggers immediately when crossing 1x speed threshold
   - Threshold flag resets when showing "try other way" message
   - Increased wait times for spectrogram messages (5s for time/frequency, 5s/6s for feature messages)

5. **Message Updates**
   - Updated speed reset message: "Click on the text that says 'Speed: X.XXx' to reset the playback speed."
   - Updated spectrogram messages with proper flow and timing

### Technical Changes

- `js/tutorial-coordinator.js` - NEW: Clean orchestration layer with async/await
- `js/tutorial-sequence.js` - Refactored pause button and speed slider tutorials to async/await
- `js/tutorial-effects.js` - Fixed emoji rendering in typing animation
- `js/tutorial-state.js` - Added `setTutorialPhase` import for skippable waits
- `js/data-fetcher.js` - Updated to use new `runMainTutorial()` function
- `js/tutorial.js` - Updated exports to include coordinator
- `styles.css` - Added emoji font fallbacks, improved pause button glow

### Benefits

- ✅ **Much cleaner code** - Linear async/await instead of nested callbacks
- ✅ **Easier to modify** - Reorder tutorial sections by moving lines
- ✅ **Skippable waits** - All timed sections can be skipped with Enter
- ✅ **Better maintainability** - Each section is a LEGO block
- ✅ **Fixed emoji rendering** - Proper Unicode handling
- ✅ **Dynamic updates** - Speed message updates without retyping

### Version
v2.36 - Commit: "v2.36 Refactor: Complete tutorial system refactoring with async/await - elegant linear flow, skippable waits, emoji fixes, dynamic speed updates"

---

## 🎯 Speed Slider Tutorial & Skip Functionality (v2.35)

### Features

1. **Speed Slider Tutorial**
   - Added interactive tutorial for playback speed slider before waveform tutorial
   - Slider knob pulses with orange glow animation (scales 1x to 1.3x)
   - Shows message: "👇 Click the playback speed slider and drag left/right to change playback speed."
   - Detects user interaction direction (faster/slower) and shows contextual feedback
   - "Notice how the frequencies stretch up as playback gets faster!" or compress down when slower
   - Prompts user to "try going the other way" after first movement
   - Detects when user crosses 1.0x threshold and shows "Great!" message
   - Adds encouragement message if user doesn't explore after 5 seconds

2. **Enter Key Skip Functionality**
   - Press Enter/Return to skip current typing animation and advance to next tutorial step
   - Works as a "next button" for rapid testing
   - Skips animations but doesn't interfere with input fields
   - Immediately executes next step in tutorial sequence

3. **Tutorial State Machine**
   - Refactored tutorial flow to use helper functions for each step
   - Each step can be immediately executed when Enter is pressed
   - Tracks current phase and manages timeout cancellation
   - Cleaner code structure with `executeVolcanoMessage`, `executeSpectrogramExplanation`, `executeSpeedSliderTutorial`

### Technical Changes
- `js/tutorial.js` - Added speed slider tutorial functions, state machine, Enter key listener
- `js/data-fetcher.js` - Refactored tutorial flow to use helper functions, integrated speed slider tutorial
- `styles.css` - Added pulsing knob animation for speed slider (`speedSliderKnobPulse` keyframes)
- Tutorial sequence: Well done → Volcano message → Spectrogram explanation → Speed slider → Waveform tutorial

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

