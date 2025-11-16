# Captain's Log - 2025-11-15

## 🧹 Memory Leak Fix: Worker Closure Chain Cleanup (v1.98)

### Problem
Memory profiler showed Function count increasing on every data load, indicating web worker closures were holding onto large data arrays even after termination.

### Root Cause
When terminating web workers, the `worker.onmessage` handler remained attached. This handler's closure captured:
- Large audio data arrays
- Processing results
- State references

Simply calling `worker.terminate()` didn't break these closure chains, causing old data to remain in memory indefinitely.

### Solution
Added `worker.onmessage = null` BEFORE each `worker.terminate()` call in 4 locations:

1. **js/main.js** (line 474) - Audio processor worker cleanup
2. **js/data-fetcher.js** (line 807) - Worker termination after data fetch complete
3. **js/waveform-renderer.js** (line 627) - Waveform worker cleanup
4. **js/spectrogram-worker-pool.js** (line 171) - Worker pool termination

This breaks the closure chain before terminating, allowing garbage collection to reclaim memory held by old message handlers.

### Implementation
Minimal surgical fix - only 4 lines added total:
```javascript
worker.onmessage = null;  // Break closure chain
worker.terminate();
```

No other changes to data structures, arrays, or state management were needed.

### Testing
Monitor Function count in DevTools Memory profiler:
- Before fix: Function count increased ~5000+ per data load
- After fix: Should remain stable across multiple data loads

### Version
v1.98 - Commit: "v1.98 Fix: Memory leak - break worker closure chains with onmessage=null before terminate to allow GC"

---

## 🎨 UI: Spectrogram Scan Line Visual Improvements (v1.99)

### Changes
1. **Spectrogram scan line (playhead):**
   - Changed from red to grey (#808080)
   - Reduced opacity to 60% (from 100%)
   - Makes it less intrusive and more background visual indicator

2. **Disabled spectrogram clickability:**
   - Commented out all mouse event listeners in `setupSpectrogramSelection()`
   - Prevents frequency selection via spectrogram clicks
   - Spectrogram is now display-only

3. **Waveform & spectrogram preview lines:**
   - Reduced opacity to 60% (from 100%)
   - Applied to both hover and drag preview lines
   - Consistent visual weight across UI

4. **Fixed double line issue during scrubbing:**
   - Simplified `drawSpectrogramScrubPreview()` to do full clear/redraw (like waveform)
   - Playhead now properly hides during drag operations
   - No more double lines when clicking and holding

### Files Modified
- `js/spectrogram-playhead.js` - Opacity changes, simplified scrub preview logic
- `js/spectrogram-renderer.js` - Commented out event listeners
- `js/waveform-renderer.js` - Preview line opacity
- `backend/collector_loop.py` - Version bump

### Version
v1.99 - Commit: "v1.99 UI: Spectrogram scan line - changed to grey at 60% opacity, disabled spectrogram click handlers, reduced waveform/spectrogram preview line opacity to 60%, fixed double line issue during scrubbing"

---

## 🔐 Security & Code Organization: Credential Management & Gap Padding (v2.00)

### Security Improvements
Removed all hardcoded R2 credentials from the entire codebase (40+ Python files):
- **Backend scripts**: 9 files updated
- **Backend tests**: 16 files updated  
- **Backend archive**: 7 files updated
- **Root-level tests**: 4 files updated
- **Archive scripts**: 1 file updated

All files now:
- Use `load_dotenv()` to load environment variables
- Use `os.getenv()` without hardcoded defaults
- Validate that all required credentials are present
- Raise clear errors if credentials are missing

### Code Organization
- Created `backend/utilities/` folder for utility scripts
- Moved `check_station_data.py`, `cdn_backfill.py`, `nuke_dates.py` to utilities
- Removed duplicate files from backend root (kept scripts folder versions)
- Cleaned up duplicate audit files

### Data Processing Enhancement
Added intelligent beginning gap padding:
- When IRIS data starts late (e.g., 00:31:51 instead of 00:30:00), now pads beginning with zeros
- Uses correct sample rate to calculate padding (same approach as end padding)
- Tracks beginning gaps in metadata (`gap_samples_filled`)
- Ensures chunks always have exact expected sample counts

### Files Modified
- `backend/collector_loop.py` - Beginning gap padding logic in `fetch_and_process_waveform()` and `process_station_window()`
- `backend/utilities/` - New folder with organized utility scripts
- 40+ Python files - Removed hardcoded credentials

### Version
v2.00 - Commit: "v2.00 Refactor: Removed all hardcoded R2 credentials, moved files to utilities folder, added beginning gap padding for late-starting data"

---

## 🎨 UI: Participant ID Display & Modal Updates (v2.01)

### Changes
1. **Participant ID Display in Header:**
   - Added participant ID display inline with main title, aligned right
   - Shows "Participant ID: [ID]" when participant ID exists (from URL or localStorage)
   - Clickable to open participant setup modal
   - Styled with subtle colors (#aaa/#bbb) for dark red background
   - Bottom-aligned to sit at top of panel below

2. **Participant Setup Modal Improvements:**
   - Made modal narrower (max-width: 600px, min-width: 400px)
   - Changed button text from "Start Session" to "Confirm"
   - Made instruction text bold ("Enter your participant ID number to begin:")
   - Added help text below button: "Not look right? Email: leif@uoregon.edu"
   - Centered help text with appropriate styling

3. **JavaScript Updates:**
   - Added `updateParticipantIdDisplay()` function to show/hide and update display
   - Display updates automatically on page load and after participant setup submission
   - Added click handler to open modal when participant ID is clicked
   - Added subtle hover effect (semi-transparent white overlay)

### Files Modified
- `index.html` - Added participant ID display in header
- `js/main.js` - Added display update function and event handlers
- `js/ui-controls.js` - Updated submit function to refresh display
- `js/modal-templates.js` - Updated participant modal template
- `styles.css` - Added participant modal width styling

### Version
v2.01 - Commit: "v2.01 UI: Added participant ID display in header, updated participant setup modal with improved styling and Confirm button"

---

## 🎯 Feature: Time Tracking & Selection UI Improvements (v2.01)

### Changes
1. **Feature Time Tracking:**
   - Added `startTime` and `endTime` fields to features (UTC ISO format)
   - Tracks time range when user selects features on spectrogram
   - Converts X pixel positions to UTC timestamps using data start/end times
   - Stores full UTC timestamps with dates (handles midnight boundaries)

2. **Feature Selection Button Updates:**
   - Changed button text from "select frequency range" to "Select feature"
   - Button now displays: "HH:MM:SS - HH:MM:SS • X.X - X.X Hz"
   - Uses bullet point (•) separator with non-breaking spaces for spacing
   - Hours below 10 display without leading zero (e.g., "9:23:45" not "09:23:45")
   - Button width reduced from 290px to 240px for better fit

3. **Backend Submission Preparation:**
   - Added `formatRegionsForSubmission()` function to format regions/features for backend
   - Includes region start/end times and feature start/end times in UTC ISO format
   - Includes region/feature numbers (1-indexed, reflects final order after deletions)
   - Data structure ready for backend endpoint (when available)

4. **Spectrogram Selection Enhancement:**
   - Now tracks both X (time) and Y (frequency) positions during selection
   - Converts X positions to timestamps for feature time tracking
   - Passes both time and frequency data to feature handler

### Files Modified
- `js/region-tracker.js` - Added time tracking, updated button format, added formatting functions
- `js/spectrogram-renderer.js` - Track X positions for time conversion
- `js/ui-controls.js` - Added regions/features to submission data
- `styles.css` - Reduced button width from 290px to 240px

### Version
v2.01 - Commit: "v2.01 Feature: Added feature time tracking and improved feature selection UI with time/frequency display"

---

## 🎭 Bug Fix: Double Fade Prevention & Fade Time Optimization (v2.02)

### Problem
When seeking near the end of audio, two fades were happening simultaneously:
1. **Seek fade-in** (from crossfade teleport)
2. **Loop fade-out** (triggered by boundary check)

This caused a collision where the seek fade wanted to fade IN while the loop fade wanted to fade OUT, resulting in clicks.

### Root Cause
The boundary check was running immediately after a seek teleport, before the seek fade-in completed. The worklet didn't know it had just teleported, so it panicked and started a loop fade-out while the seek fade-in was still running.

### Solution
Added `justTeleported` flag to give the worklet self-knowledge:
- Set to `true` when completing a seek teleport (after fade-out, before fade-in)
- Prevents boundary checks while flag is `true`
- Cleared to `false` when fade-in completes
- One flag, self-knowledge, no external grace periods

### Fade Time Optimization
- Hard-coded fade time to 5ms (works beautifully for all conditions!)
- Removed fade time slider from UI
- Exception: Very short loops (<200ms) still use 2ms to avoid fade artifacts
- Kept the logic that skips fade entirely for audio-rate loops (<50ms)

### Files Modified
- `workers/audio-worklet.js` - Added justTeleported flag, hard-coded fade time to 5ms, removed set-fade-time handler
- `index.html` - Removed fade time slider
- `js/audio-player.js` - Removed changeFadeTime() and resetFadeTimeTo20() functions
- `js/main.js` - Removed fade time imports and event listeners
- `backend/collector_loop.py` - Version bump

### Version
v2.02 - Commit: "v2.02 Fix: Prevented double fade collision with justTeleported flag, hard-coded fade time to 5ms and removed fade time slider"

---

## 🌊 Feature: Infinite Spectrogram Viewport with GPU-Accelerated Stretching (v2.03)

### Concept
Implemented infinite spectrogram space architecture: render once at neutral (1x) scale, then GPU-stretch on demand when playback rate changes. This allows smooth scaling from 0.5x to 15x without re-rendering.

### Architecture
1. **Neutral Render (One-Time):**
   - Removed playback rate scaling from `getYPosition()` during rendering
   - Renders spectrogram at 450px height (neutral 1x scale)
   - FFT computation unchanged - only rendering logic modified

2. **Infinite Canvas:**
   - Creates 6750px tall canvas (450px × 15 max playback rate)
   - Places neutral 450px render at bottom of infinite canvas
   - Rest of canvas filled with black (represents frequencies above viewport)

3. **GPU-Accelerated Viewport Updates:**
   - When playback rate changes, GPU-stretches the 450px render vertically
   - At 1x: stretch to 450px (no change) → extract bottom 450px → see everything (0-50Hz)
   - At 15x: stretch to 6750px → extract bottom 450px → see bottom 1/15th (0-3.3Hz), rest pushed up
   - Uses `drawImage()` for GPU-accelerated stretching (near-zero CPU hit)

### Implementation Details
- **`js/spectrogram-complete-renderer.js`:**
  - Removed playback rate from `getYPosition()` - renders at neutral 1x
  - Creates infinite canvas (6750px) and places neutral render at bottom
  - Added `updateSpectrogramViewport(playbackRate)` function for GPU-stretching
  - Updated cleanup to clear infinite canvas

- **`js/audio-player.js`:**
  - Calls `updateSpectrogramViewport()` when playback speed changes
  - Uses dynamic import to avoid circular dependencies

- **`tests/spectrogram_infinite_viewport.html`:**
  - Created proof-of-concept demo showing the infinite canvas architecture
  - Demonstrates GPU-accelerated stretching with CPU metrics
  - Includes logarithmic slider matching production playback slider

### Benefits
- **Performance:** One-time render cost, then GPU-accelerated viewport updates (near-zero CPU)
- **Smooth Scaling:** Instant viewport updates when playback rate changes
- **Memory Efficient:** Only stores one neutral render + infinite canvas (same memory footprint)
- **Future-Proof:** Can extend to higher playback rates without hitting browser canvas limits

### Files Modified
- `js/spectrogram-complete-renderer.js` - Neutral rendering, infinite canvas, GPU-stretching
- `js/audio-player.js` - Hook up viewport updates to playback speed changes
- `backend/collector_loop.py` - Version bump
- `tests/spectrogram_infinite_viewport.html` - Proof-of-concept demo

### Version
v2.03 - Commit: "v2.03 Feature: Infinite spectrogram viewport with GPU-accelerated stretching - render once at neutral 1x, GPU-stretch on playback rate change"

---

## 🎨 Feature: Frequency-Scale-Aware Stretching & Scale Change Re-Rendering (v2.04)

### Frequency-Scale-Aware Stretching
Implemented correct stretch factors for each frequency scale type. Different scales compress frequency ranges differently, so we need different stretch amounts:

1. **Linear Scale:**
   - Stretch factor = `playbackRate` (direct proportion)
   - At 15x: stretch 15x → top edge represents 1/15th of frequency range linearly

2. **Square Root Scale:**
   - Stretch factor = `sqrt(playbackRate)`
   - At 15x: stretch ~3.87x (sqrt(15)) → top edge represents 1/15th of frequency range in sqrt space
   - Because `sqrt(1/15) ≈ 0.258` of canvas needs to become full canvas = `1/0.258 ≈ sqrt(15)`

3. **Logarithmic Scale:**
   - Stretch factor = `1 / fraction` where fraction is the portion of log range being shown
   - Calculates what fraction of the log range we're displaying at current playback rate
   - Stretches that fraction to fill the viewport

### Scale Change Re-Rendering
When user changes frequency scale (Linear/Sqrt/Log), the spectrogram now automatically re-renders:
- Clears existing render and infinite canvas
- Re-renders with new frequency scale
- Updates axis to match new scale
- Applies current playback rate with correct stretch factor

### Why This Works
The spectrogram pixels are already in the correct frequency-scaled space (rendered with sqrt/log/linear transforms). We just need to stretch by the amount that matches the scale's compression:
- Linear compresses evenly → stretch evenly
- Sqrt compresses by sqrt → stretch by sqrt  
- Log compresses logarithmically → stretch by inverse log fraction

The axis and spectrogram stay perfectly aligned because the stretch matches the scale's compression!

### Files Modified
- `js/spectrogram-complete-renderer.js` - Added `calculateStretchFactor()` function with scale-aware math, updated `updateSpectrogramViewport()` to use it
- `js/spectrogram-renderer.js` - Updated `changeFrequencyScale()` to trigger re-render when scale changes
- `backend/collector_loop.py` - Version bump

### Version
v2.04 - Commit: "v2.04 Feature: Frequency-scale-aware spectrogram stretching and scale change re-rendering"

---

## 🐛 Bug Fix: Slow Playback Rate Shrinking Case (v2.05)

### Problem
When playback rate was less than 1.0 (slowing down), the `stretchedHeight` became smaller than the viewport height (450px). For example, at 0.1x playback rate with linear scale:
- `stretchFactor = 0.1`
- `stretchedHeight = 450 * 0.1 = 45px`

The code then tried to extract the bottom 450px from a 45px image, which didn't work correctly!

### Solution
Added handling for two distinct cases:

1. **STRETCHING case (playbackRate >= 1.0):**
   - Stretch the neutral render vertically
   - Extract bottom 450px slice to show higher frequencies pushed up

2. **SHRINKING case (playbackRate < 1.0):**
   - Fill viewport with dark red "silence" color (matching spectrogram background)
   - Shrink the neutral render to smaller `stretchedHeight`
   - Place shrunken render at BOTTOM of viewport
   - Top portion shows silence (representing frequencies above what's visible at slower speeds)

### Example at 0.1x Playback Rate
- `stretchFactor = 0.1` (linear scale)
- `stretchedHeight = 45px` (450 × 0.1)
- Viewport fills with dark red silence color
- 45px shrunken spectrogram placed at bottom
- Top 405px shows silence (frequencies above visible range)

### Files Modified
- `js/spectrogram-complete-renderer.js` - Added shrinking case handling in `updateSpectrogramViewport()`
- `backend/collector_loop.py` - Version bump

### Version
v2.05 - Commit: "v2.05 Fix: Handle shrinking case for slow playback rates (<1.0x) in spectrogram viewport"

---

## 🧹 Memory Leak Fixes: RAF Callbacks, Module Closures & ArrayBuffer Cleanup (v2.03)

### Problem
Memory profiler showed massive accumulation of:
- **1,046,352 Function instances** (~4.7GB) - RAF callbacks accumulating
- **Detached ScriptedAnimationController** - RAF loops retaining detached documents
- **Float32Array/ArrayBuffer** - Module closures retaining large data arrays
- **Worklet warning spam** - Console flooded when playback ends

### Root Causes

1. **RAF Callback Accumulation:**
   - Multiple `requestAnimationFrame()` calls creating parallel loops
   - RAF IDs not cleared immediately before early returns
   - No duplicate prevention when scheduling new RAF callbacks

2. **Module Closure Leaks:**
   - Functions in same ES6 module capturing State module scope
   - `updateCurrentPositionFromSamples()` called from worklet handler closure
   - Module scope retaining all Float32Arrays and ArrayBuffers

3. **Detached Document Leaks:**
   - RAF callbacks executing after document detached
   - Closures retaining references to detached DOM nodes
   - No checks for `document.body.isConnected` before DOM access

4. **Worklet Warning Spam:**
   - Warning logged with 1% random chance every process() call
   - Process() called ~344 times/second, causing spam

### Solutions

1. **RAF Callback Fixes:**
   - Clear RAF ID immediately at start of `updatePlaybackIndicator()` and `drawSpectrogram()`
   - Prevent duplicate RAF loops in `startPlaybackIndicator()` (return if already scheduled)
   - Check `State.playbackIndicatorRAF === null` before scheduling new RAF
   - Added document connection checks before all RAF scheduling

2. **Module Closure Fixes:**
   - Added `document.body.isConnected` checks in `updateCurrentPositionFromSamples()`
   - Copy State values to local variables instead of repeated State access
   - Check element connection before DOM updates

3. **Detached Document Fixes:**
   - Added `document.body.isConnected` checks in all RAF loops
   - Stop RAF loops when document becomes detached
   - Guard DOM access in `resetRegionPlayButton()` and `updatePlaybackIndicator()`

4. **Worklet Warning Fix:**
   - Added `stoppedWarningLogged` flag to log warning only once
   - Reset flag when playback resumes
   - Removed random chance logging

5. **Memory Monitoring:**
   - Changed interval from 10 seconds to 5 seconds
   - Updated comment to reflect new interval

### Files Modified
- `js/waveform-renderer.js` - RAF cleanup, duplicate prevention, document checks
- `js/spectrogram-renderer.js` - RAF cleanup, duplicate prevention, document checks
- `js/main.js` - Module closure fixes, document checks
- `js/region-tracker.js` - Document connection check
- `js/spectrogram-complete-renderer.js` - Memory monitoring interval change
- `workers/audio-worklet.js` - Warning spam fix

### Version
v2.03 - Commit: "v2.03 Fix: Memory leak fixes - RAF callback accumulation, module closure leaks, ArrayBuffer retention, worklet warning spam, memory monitoring every 5s"

---

## 🎨 UI Improvements: Axis Styling & Frequency Tick Enhancements (v2.04)

### Changes

1. **X-Axis Font Size:**
   - Reduced tick label font size from 15px to 14px for cleaner appearance
   - Updated CSS variable `--axis-label-font-size` in `index.html`

2. **X-Axis Day Crossing Detection:**
   - Fixed day crossing detection to properly show MM/DD format at midnight
   - Added check for ticks at 00:00 to always display date (not just "24:00")
   - Date labels at day crossings now properly display in bold MM/DD format

3. **Square Root Scale Frequency Ticks:**
   - Added 6, 8, and 9 Hz ticks when playback speed >= 1.6x
   - Added 0.5 Hz increments (0.5, 1.0, 1.5, ... up to 9.0 Hz) when speed >= 9.0x
   - Provides finer granularity for frequency axis at higher playback speeds

4. **Worklet Console Noise Reduction:**
   - Commented out worklet message logging to reduce console spam
   - Keeps console cleaner during normal operation

### Files Modified
- `index.html` - Reduced x-axis font size from 15px to 14px
- `js/waveform-x-axis-renderer.js` - Fixed day crossing detection for midnight ticks
- `js/spectrogram-axis-renderer.js` - Added conditional frequency ticks for square root scale
- `workers/audio-worklet.js` - Commented out message logging

### Version
v2.04 - Commit: "v2.04 UI: Reduced x-axis font size, fixed day crossing detection, added frequency ticks for square root scale at high speeds, commented out worklet message logging"

---

