# Captain's Log - October 31, 2025

## AudioWorklet Fade Improvements & Loop Fixes

Major improvements to `Simple_IRIS_Data_Audification.html` audio playback system:

### Changes Made:

1. **Exponential Ramps for Natural Fades**
   - Switched from linear to exponential ramps for pause/resume/start/stop
   - Exponential ramps match human loudness perception (logarithmic)
   - Use near-zero (0.0001) instead of exact zero (exponential can't hit 0)
   - Linear ramps kept for volume slider (direct user control)

2. **Proper Worklet Lifecycle Management**
   - Worklet now NEVER returns `false` (stays alive for looping)
   - Added `finishSent` flag to prevent duplicate 'finished' messages
   - Added `hasStarted` check before sending 'finished' (prevents premature finish on fresh worklet)
   - Reset handler properly restores state for looping

3. **Speed Preservation**
   - Playback speed now preserved on loop restart
   - Speed restored after reset command during loops
   - Speed restored after manual replay

4. **Hybrid Pause/Resume Approach**
   - Gain node handles smooth fades (keeps audio thread alive)
   - Worklet pause/resume stops/starts consuming samples
   - AudioContext never suspended (avoids clicks from thread restart)

5. **Early Loop Detection**
   - Worklet warns main thread ~100ms before end
   - Enables future gapless loop optimization

### Key Learnings:

- **Best Practice**: Never return `false` from AudioWorklet if you want looping capability
- **Best Practice**: Use exponential ramps for perceived loudness changes, linear for direct control
- **Best Practice**: Keep AudioContext running, use gain nodes for fades
- **Bug**: Calling `reset` on fresh worklet sets `hasStarted=true` causing immediate finish

### Version
v1.23 - Commit: "v1.23 Fix: AudioWorklet fade improvements - exponential ramps for pause/resume, proper worklet lifecycle management for looping, speed preservation on restart"

---

## Backend Selection & Cleanup Improvements

### Changes Made:

1. **Local Server Checkbox**
   - Added checkbox to switch between localhost:5005 and Render.com backend
   - Default unchecked (uses Render.com production backend)
   - Status message shows which backend is being used
   - Console logs backend URL for debugging

2. **Cleanup on New Data Fetch**
   - When fetching new data while old data is playing, properly stops old playback
   - Fades out current audio smoothly (50ms exponential ramp)
   - Disconnects old worklet and gain nodes
   - Clears old data buffer
   - Resets playback state for fresh start
   - Prevents audio overlap/corruption

3. **UI Improvements**
   - Removed "Visualizations" header for cleaner layout
   - Improved status messages to show backend type

### Key Learnings:

- **Best Practice**: Always clean up old audio nodes before creating new ones
- **Best Practice**: Fade out before disconnecting to prevent clicks
- **User Experience**: Clear status messages help debug backend connectivity issues

### Version
v1.24 - Commit: "v1.24 Feature: Added Local Server checkbox for backend selection, improved cleanup on new data fetch, removed Visualizations header"

---

## Duration & Error Handling Improvements

### Changes Made:

1. **24-Hour Duration Option**
   - Added 24-hour option to duration dropdown
   - Users can now fetch up to 24 hours of seismic/infrasound data

2. **Improved Error Handling for Inactive Stations**
   - Backend now returns 404 (Not Found) instead of 500 for stations with no data
   - Properly handles IRIS HTTP 204 responses (No data available)
   - Returns detailed error messages including station/channel info
   - Tracks last error message for better debugging

3. **Better Frontend Error Display**
   - Frontend now parses JSON error responses from backend
   - Displays specific error messages instead of generic HTTP status codes
   - Shows helpful messages like "station may be inactive or no data for requested time range"

4. **Debug Logging**
   - Added console logging for station filtering to help debug infrasound station issues
   - Identified that Kilauea infrasound stations (MENE1-5) are inactive in IRIS

### Key Learnings:

- **IRIS HTTP 204**: ObsPy raises exceptions when IRIS returns HTTP 204 (No data available)
- **Station Status**: Some stations in EMBEDDED_STATIONS may be inactive/decommissioned
- **Error Codes**: Use 404 for "resource not found" (inactive station) vs 500 for server errors
- **User Experience**: Specific error messages help users understand why data fetch failed

### Version
v1.25 - Commit: "v1.25 Feature: Added 24-hour duration option, improved error handling for inactive stations (404 instead of 500), better frontend error messages"

---

## CORS Fix for Render.com Backend

### Changes Made:

1. **Fixed CORS Headers on Error Responses**
   - All error responses (400, 404, 500) now include `Access-Control-Allow-Origin: *` header
   - Used `make_response()` to explicitly add CORS headers to error JSON responses
   - Prevents CORS errors when frontend fetches from Render.com backend

2. **Explicit Flask-CORS Configuration**
   - Updated `main.py` to explicitly set `origins='*'` for Flask-CORS
   - Added all custom headers to `expose_headers` list
   - Explicitly allowed `POST` and `OPTIONS` methods
   - Added `Content-Type` to allowed headers

### Problem:
- Frontend getting CORS errors when fetching 24-hour data from Render.com
- Error: "No 'Access-Control-Allow-Origin' header is present on the requested resource"
- Error responses (404, 500) weren't including CORS headers
- Flask-CORS config might not have been explicit enough

### Solution:
- All error responses now use `make_response()` with explicit CORS headers
- Main Flask app CORS config now explicitly allows all origins and methods
- Both success and error responses now properly handle CORS

### Key Learnings:

- **Error Responses Need CORS Too**: Even error responses must include CORS headers for browsers to read them
- **Explicit Configuration**: When using Flask-CORS, explicitly set `origins='*'` to ensure all origins are allowed
- **make_response()**: Use `make_response()` instead of returning tuples when you need to add custom headers

### Version
v1.26 - Commit: "v1.26 Fix: Added CORS headers to all error responses and explicitly configured Flask-CORS for Render.com backend"

---

## Memory Optimizations & Bug Fixes

### Changes Made:

1. **Memory Optimizations for 24-Hour Files**
   - Changed from float64 to float32 for intermediate arrays (50% memory savings)
   - Added explicit `del` statements to free arrays immediately after use
   - Optimized `normalize_audio()` to work with float32 input (no conversion to float64)
   - Frees `samples`, `filtered`, `processed`, `samples_bytes`, and `uncompressed_blob` immediately after use
   - Should keep 24-hour files under Render.com's 512MB limit

2. **Dynamic Buffer Expansion**
   - AudioWorklet buffer now expands dynamically instead of capping at 60 seconds
   - Buffer grows as needed (doubles when full) to handle hours of audio
   - Handles circular buffer wrap-around when copying during expansion
   - Added `dataLoadingComplete` flag to track when all data has been sent
   - Only reports "finished" when buffer is empty AND all data has been loaded

3. **Fixed Stale "Finished" Messages**
   - Added `isFetchingNewData` flag to ignore "finished" messages from old worklets
   - Clears old worklet's `onmessage` handler before disconnecting
   - Prevents "playback finished" message appearing after switching stations

4. **Removed Conflicting OPTIONS Handler**
   - Deleted manual OPTIONS handler from `audio_stream.py`
   - Flask-CORS now handles OPTIONS preflight automatically
   - Removes conflict between manual handler and Flask-CORS

5. **Fixed Template Literal Syntax Error**
   - Fixed template literal inside template literal in AudioWorklet code
   - Changed to string concatenation to avoid syntax conflict

### Problem:
- 24-hour files causing "Ran out of memory (used over 512MB)" on Render.com
- Long audio files getting truncated at 60 seconds (buffer overflow)
- False "playback finished" messages when switching stations
- CORS issues with conflicting OPTIONS handlers

### Solution:
- Use float32 instead of float64 (sufficient precision for audio, halves memory)
- Explicitly free arrays after use to reduce peak memory
- Dynamic buffer expansion to handle any length audio
- Flag-based message filtering to ignore stale worklet messages
- Let Flask-CORS handle OPTIONS automatically

### Key Learnings:

- **Memory Management**: Explicit `del` statements help Python free memory sooner
- **Float32 vs Float64**: Float32 is sufficient for audio processing, saves 50% memory
- **Dynamic Buffers**: Expanding buffers is better than fixed-size limits
- **Message Queuing**: Old AudioWorklet messages can be queued, need to clear handlers
- **Flask-CORS**: Manual OPTIONS handlers conflict with Flask-CORS's automatic handling

### Version
v1.27 - Commit: "v1.27 Fix: Memory optimizations for 24-hour files (float32, explicit cleanup), dynamic buffer expansion, fixed stale finished messages, removed conflicting OPTIONS handler"

---

## Test Streaming Integration with ObsPy Audio Stream

Major integration of server-side ObsPy audio processing into `test_streaming.html`:

### Changes Made:

1. **Zstd Decompression Fix**
   - Fixed "invalid length/literal" error from incorrect fflate usage
   - Changed from `fflate.decompressSync()` (gzip) to `fzstd.decompress()` (zstd)
   - Matches the proven decompression method already tested in `worker/src/index.js`
   - Added CDN import for fzstd library (v0.1.1)

2. **Server-Side Processing Controls**
   - Added collapsible "Server Processing Controls" section to UI
   - Only visible when "Render Audio Stream (ObsPy processed)" pipeline is selected
   - Checkboxes for:
     - Enable High-Pass Filter (0.5 Hz)
     - Enable Normalization
     - Send Raw (int32 instead of float32)
     - Bypass Zstd Compression (debug mode)
   - Controls properly hidden for other pipeline modes

3. **Backend Enhancements (audio_stream.py)**
   - **24-Hour Request Splitting**: Splits 24-hour requests into two 12-hour requests to handle IRIS limitations
   - **Memory Optimizations**: 
     - Uses float32 instead of float64 throughout (50% memory savings)
     - Explicit `del` statements to free arrays immediately after use
     - Should keep large files under Render.com's 512MB limit
   - **Smart Normalization**: 
     - `normalize_audio()` now accepts `output_format` parameter ('int16', 'int32', 'float32')
     - Normalizes to appropriate range for each format
     - float32 normalized to [-1.0, 1.0] for Web Audio API
   - **Better Error Handling**:
     - 404 responses with detailed error messages for inactive stations
     - Handles empty streams after merge
     - Returns network/station/channel info in error responses
     - All error responses include CORS headers
   - **Bypass Compression Mode**: Optional debug mode to skip zstd compression for troubleshooting
   - **Optimized OPTIONS Handler**: Simplified to return 204 status, letting Flask-CORS handle headers

4. **Frontend Debugging Improvements**
   - Added extensive logging for decompression process
   - Logs metadata preview (first 100 and last 50 chars)
   - Logs sample statistics (min, max, mean)
   - Logs first/last 10 samples for validation
   - Properly handles `byteOffset` when decompressed data is a view into larger buffer

5. **DataView Buffer Handling**
   - Fixed potential bug with `DataView` by explicitly passing `byteOffset` and `byteLength`
   - Handles cases where `decompressed` is a view into a larger `ArrayBuffer`
   - Matches pattern used in successful test scripts

### Problem:

- Initial attempt used wrong fflate function (`decompressSync` for gzip instead of zstd)
- Simple streaming mode needed integration with new `/api/stream-audio` endpoint
- Need user controls for server-side processing options
- 24-hour requests failing due to IRIS limitations and memory constraints

### Solution:

- Use `fzstd.decompress()` which was already proven working in our R2 Worker code
- Add UI controls for all server-side processing options
- Split large requests into smaller chunks
- Optimize memory usage with float32 and explicit cleanup
- Add bypass compression mode for easier debugging

### Key Learnings:

- **Decompression Libraries**: `fflate.decompressSync()` is for gzip, `fflate.unzstdSync()` is for zstd, but **`fzstd.decompress()`** is the proven working solution from our worker code
- **IRIS Limitations**: Very long duration requests (24+ hours) may need to be split into multiple requests
- **Memory Efficiency**: float32 is sufficient for audio processing and saves 50% memory compared to float64
- **Explicit Cleanup**: Python's `del` statement helps free memory sooner for large arrays
- **DataView Views**: When working with Uint8Array views, must pass `byteOffset` and `byteLength` to DataView constructor
- **UI/UX**: Collapsible control sections keep interface clean while providing advanced options

### Version
v1.28 - Commit: "v1.28 Feature: Integrated ObsPy audio stream into test_streaming.html with fzstd decompression, server-side processing controls, 24-hour request splitting, and memory optimizations"

---

## UI Improvements & Layout Refinements

### Changes Made:

1. **Enhanced Loading Animations**
   - Added shimmer gradient background animation for loading state
   - Added subtle white shimmer sweep (faint, doesn't cover text)
   - Added diagonal stripes that slide horizontally to the right
   - Added pulsing background effect
   - Text stays visible above all animations with proper z-index stacking

2. **Improved Text Visibility**
   - Fixed text being covered by loading animations
   - Removed blurry text shadows
   - Dark, high-contrast text color (#331100) for loading state
   - Text positioned above all animation layers

3. **Layout Improvements**
   - Removed "Volcano & Station Selection" header for cleaner look
   - Removed "Metrics" header (just showing boxes now)
   - Increased label font size to 18px in top panel (was 14px)
   - Increased select/input font size to 16px in top panel
   - Made waveform 10% smaller (150px → 135px)
   - Made spectrogram taller (350px → 450px)
   - Moved local server checkbox down (partially hidden off-screen)
   - Removed 24-hour duration option from dropdown

4. **Button Styling**
   - Added text glow effect to "Fetch Data" button when pulsing
   - Brightened button text colors

5. **Status Bar Enhancements**
   - Loading state immediately switches to "fetching" (no fade delay)
   - Multiple animated effects make loading state more obvious
   - Stripe animation slides horizontally for clearer progress indication

### Key Learnings:

- **CSS z-index**: Requires `isolation: isolate` to create proper stacking context
- **Pseudo-elements**: `::before` and `::after` need lower z-index than content
- **Text shadows**: Blurry shadows can make text look fuzzy - remove for crisp text
- **Loading feedback**: Multiple subtle animations create better sense of progress than single effect
- **UI simplification**: Removing unnecessary headers creates cleaner, more focused interface

### Version
v1.29 - Commit: "v1.29 UI: Enhanced loading animations, improved text visibility, removed headers, adjusted layout (larger labels, taller spectrogram, smaller waveform), moved local server checkbox down"

---

## Playback Speed Fix

### Changes Made:

1. **Speed Setting Preserved on New Data**
   - When new data is downloaded, playback speed now respects the current speed slider setting
   - Speed is set to `currentPlaybackRate` immediately after data is sent to AudioWorklet
   - Prevents new data from playing at default 1.0x speed when user has changed speed

### Problem:
- When fetching new data while playing at a custom speed (e.g., 2.0x), the new data would play at default 1.0x speed
- User had to manually adjust speed slider again after each new data fetch

### Solution:
- Set playback speed immediately after data is loaded using `workletNode.port.postMessage({ type: 'set-speed', speed: currentPlaybackRate })`
- Ensures new data plays at the user's selected speed without requiring manual adjustment

### Key Learnings:

- **State Preservation**: Always restore user preferences (speed, volume) when loading new data
- **Timing**: Set speed after data is sent but before playback starts for seamless experience

### Version
v1.30 - Commit: "v1.30 Fix: New data playback now respects current speed setting"

---

## UI Refinements & Spacebar Control Improvements

### Changes Made:

1. **Darker Background**
   - Darkened body background gradient from `#4a0e0e → #5a1a1a` to `#2a0606 → #3a0f0f`
   - Provides better contrast with panels

2. **Bold Text for Processing Options**
   - Made "High Pass (20Hz)" and "Normalization" labels bold (font-weight: 700)
   - Improves visibility and emphasis

3. **Improved Slider Styling**
   - Speed and volume sliders now take full width (flex: 1)
   - Added 20px padding on left and right of both sliders for breathing room
   - Made slider bars thinner (track height reduced from 8px to 4px)
   - Reduced border-radius to match thinner bars

4. **Spacebar Control Enhancements**
   - Spacebar now works with range inputs (sliders) - they don't block spacebar
   - All form elements (dropdowns, checkboxes, sliders) auto-blur after interaction
   - Ensures spacebar always controls play/pause immediately after using any form control
   - Dropdowns blur on change event
   - Checkboxes blur on change and click events
   - Sliders blur on mouseup and change events

### Key Learnings:

- **Form Element Focus**: Auto-blurring form elements after interaction improves keyboard control UX
- **Slider Styling**: Thinner tracks (4px) provide cleaner look while maintaining usability
- **Keyboard Shortcuts**: Explicitly allowing range inputs in spacebar handler ensures consistent behavior

### Version
v1.31 - Commit: "v1.31 UI: Darker background, bold High Pass/Normalization labels, improved slider styling with padding, thinner slider bars, spacebar control works with all form elements"

---

## High-Pass Filter Dropdown & Base Sampling Rate Multiplier

### Changes Made:

1. **High-Pass Filter Dropdown**
   - Replaced checkbox with dropdown showing original data frequencies
   - Options: None, 0.01 Hz (~4.4 Hz @ 44.1k), 0.045 Hz (~19.8 Hz @ 44.1k)
   - Default set to 0.01 Hz
   - Filtering now done by backend (more efficient than browser-side)
   - Frontend sends `highpass_hz` parameter to backend

2. **Base Sampling Rate Multiplier**
   - Added dropdown for emulating different audio sample rates
   - Options: 44.1 kHz (1x), 48 kHz (1.09x), 96 kHz (2.18x), 192 kHz (4.35x), 200 kHz (4.54x), 441 kHz (10x), 1 MHz (22.7x)
   - Multiplier applied ON TOP of speed slider (slider display unaffected)
   - Changes playback speed immediately without refetching data
   - Speed slider shows base value, actual playback speed = slider × multiplier

3. **Backend Filtering Integration**
   - Frontend now sends selected high-pass frequency to backend
   - Backend applies Butterworth filter before compression
   - More efficient than browser-side filtering (processes once on server)
   - Browser-side filtering code removed

4. **Optimized Loop Reset**
   - Changed from full worklet reset (clears buffer, reloads data) to simple read pointer reset
   - Loop now just resets `readIndex` to 0 and restores `samplesInBuffer`
   - Buffer stays intact, no data reloading needed
   - Fixed variable loop timing issue (was caused by buffer clearing/reloading)

5. **Comprehensive Fade/Loop Logging**
   - Added detailed console logs for fade timing
   - Logs approaching end (~100ms remaining), buffer empty, fade-out start/complete, fade-in start
   - Logs worklet loop reset with read index and buffer state
   - Helps diagnose timing issues and fade behavior

6. **Hidden Normalization Checkbox**
   - Normalization checkbox hidden from UI (still functional, defaults to checked)
   - Cleaner interface

### Key Learnings:

- **Backend vs Browser Processing**: Backend filtering is more efficient - processes once on server vs browser processing on every playback
- **Loop Optimization**: Simple read pointer reset is much faster than full buffer reset - avoids data reloading overhead
- **State Management**: Speed multiplier should not affect slider display - users expect slider to show base value
- **Logging**: Comprehensive logging helps diagnose timing issues, especially with high-speed playback
- **Worklet Lifecycle**: Keeping buffer intact between loops is more efficient than clearing and reloading

### Version
v1.32 - Commit: "v1.32 Feature: High-pass filter dropdown (None/0.01Hz/0.045Hz), base sampling rate multiplier (44.1k-1MHz), backend filtering, optimized loop reset (read pointer only), comprehensive fade/loop logging"

---

## Sample-Based Position Tracking & Dynamic High-Pass Filter Display

### Changes Made:

1. **Sample-Based Position Tracking**
   - Replaced time-based position calculation with sample-based calculation
   - Position now calculated as: `(samplesConsumed / totalSamples) × playbackDuration`
   - Worklet sends `samplesConsumed` and `totalSamples` in metrics messages
   - Fixes incorrect position display when playback speed changes
   - Position now accurately reflects actual sample being played, regardless of speed

2. **Dynamic High-Pass Filter Display**
   - High-pass filter label now dynamically shows selected base sampling rate (e.g., "@ 44.1k", "@ 1M")
   - Dropdown options dynamically calculate and display audio frequencies based on selected base rate
   - Formula: `audio_frequency = original_frequency × (base_rate / original_rate)`
   - Updates automatically when base sampling rate changes or when metadata is received
   - Shows both original frequency (0.01 Hz) and calculated audio frequency (e.g., "100 Hz")

3. **Fixed Audio Frequency Calculation**
   - Corrected calculation to account for total speedup from original sample rate to base sampling rate
   - Now properly accounts for both speedup to 44.1k AND multiplier to selected base rate
   - Matches the table showing frequency conversions at different playback rates

4. **UI Cleanup**
   - Removed volcano emoji 🌋 from page title and h1 heading
   - Title now reads "IRIS Data Audification (Beta)"

### Key Learnings:

- **Position Tracking**: Sample-based tracking is more accurate than time-based when speed can change dynamically
- **Frequency Calculation**: Must account for total speedup (base_rate / original_rate), not just multiplier
- **Dynamic UI**: Updating UI elements based on other control selections improves user understanding

### Version
v1.34 - Commit: "v1.34 Feature: Dynamic high-pass filter display based on base sampling rate, fixed audio frequency calculation (base_rate/original_rate), removed volcano emoji from title, sample-based position tracking"

---

## UI Layout Improvements & Slider Overflow Fix

### Changes Made:

1. **Control Ordering**
   - Moved "Base Sampling Rate" dropdown to the left of "High Pass" filter dropdown
   - More logical flow: base rate first, then filter that depends on it

2. **Slider Size Constraints**
   - Added `max-width: min(400px, 100%)` to speed and volume slider containers
   - Prevents sliders from extending beyond panel boundaries
   - Maintains consistent size when wrapping to new rows

3. **Overflow Prevention**
   - Added `width: 100%` and `box-sizing: border-box` to flex container
   - Added `min-width: 0` to range inputs to allow proper shrinking
   - Set labels to `flex-shrink: 0` to prevent label compression
   - Sliders now properly respect panel boundaries on small screens

### Key Learnings:

- **Flexbox Overflow**: Flex items with `flex: 1` can overflow containers; need `max-width: min(value, 100%)` to constrain
- **Box-sizing**: Essential for accurate width calculations when padding is involved
- **Min-width: 0**: Required on flex children to allow shrinking below content size

### Version
v1.35 - Commit: "v1.35 UI: Moved base sampling rate before high-pass filter, added max-width constraints to sliders, fixed slider overflow beyond panel boundaries"

---

## Click-to-Reset Controls & Spectrogram Scroll Speed

### Changes Made:

1. **Click-to-Reset Speed and Volume**
   - Entire label ("Speed: 1.0x" and "Volume: 1.0") is now clickable
   - Single click resets to 1.0x speed or 1.0 volume
   - Removed leading zeros from display (.5x instead of 0.5x)

2. **Spectrogram Scroll Speed Control**
   - Added scroll speed slider below spectrogram (lower right)
   - Discrete speed steps: 0, .125, .25, .5, 1, 2, 3x
   - Logarithmic slider mapping for finer control in slower speeds
   - Display shows clean format (removes unnecessary zeros)
   - Default speed set to 1.0x (which actually scrolls at 0.5x - half the original speed)

3. **GPU-Accelerated Scrolling**
   - Uses `ctx.drawImage(canvas, -1, 0)` for scrolling (GPU-accelerated)
   - More efficient than `getImageData`/`putImageData` (CPU-bound)
   - Frame skipping for speeds < 1.0x
   - Multiple pixel scrolling for speeds > 1.0x

4. **UI Enhancements**
   - Scroll speed slider has fixed width (150px) and fixed value display width (45px)
   - Text styling with white color and shadow for visibility on dark background
   - Enhanced slider thumb styling (brighter, larger, with shadows)

### Key Learnings:

- **GPU vs CPU**: `drawImage` is GPU-accelerated and much faster than `getImageData`/`putImageData`
- **Frame Skipping**: For speeds < 1.0x, skip drawing frames rather than fractional pixel scrolling
- **Display Formatting**: Removing leading zeros (.5x vs 0.5x) improves readability

### Version
v1.36 - Commit: "v1.36 Feature: Click-to-reset speed/volume labels, scroll speed control for spectrogram with discrete steps (.125, .25, .5, 1, 2, 3x), GPU-accelerated scrolling using drawImage"

---

## UI Polish & Layout Refinements

### Changes Made:

1. **Spectrogram Scroll Speed Enhancement**
   - Increased maximum scroll speed from 3x to 5x
   - Added 4.0x and 5.0x to discrete speed steps
   - Adjusted multiplier from 2.0x to 4.0x (0.5x display = 2.0x actual, making it twice as fast overall)

2. **Panel Padding Adjustments**
   - Reduced vertical padding on top two panels (from 20px to 12px)
   - Reduced vertical padding on bottom metrics panel (from 20px to 12px)
   - Creates more compact, efficient use of screen space

3. **Button Depth Enhancement**
   - Added consistent shadow (`0 3px 6px rgba(0, 0, 0, 0.3)`) to all button states
   - Provides subtle depth/extrusion effect
   - Fixed animation conflicts that were removing shadows from Fetch Data button

4. **Scroll Speed Control Positioning**
   - Fixed slider and value text positioning with absolute positioning
   - Slider fixed at 150px width, value text anchored at fixed offset
   - Prevents layout shifts when value text length changes
   - Adjusted spacing and alignment for better visual consistency
   - Slightly red-tinted text color (`#ffe8e8`) for better blending with dark background

5. **UI Details**
   - Added construction emoji (🚧) to title and h1 heading
   - Matching scroll speed slider style with other sliders on page

### Key Learnings:

- **Fixed Positioning**: Absolute positioning prevents layout shifts when text content varies
- **Consistent Shadows**: All button states should maintain base shadow, animations need to include shadow in keyframes
- **UI Polish**: Small adjustments to padding, shadows, and positioning create more polished, professional appearance

### Version
v1.37 - Commit: "v1.37 UI: Increased spectrogram scroll speed max to 5x, adjusted panel padding, added button shadows for depth, fixed scroll speed control positioning, added construction emoji to title"

---

## Base Sampling Rate Improvements

### Changes Made:

1. **Added 50 kHz Option**
   - Added 50 kHz (500x) as a base sampling rate option
   - Positioned between 48 kHz and 96 kHz options
   - Provides another intermediate speedup option

2. **Multiplier Display Update**
   - Changed multiplier display from relative to 44.1 kHz to relative to original 100 Hz rate
   - Now shows: 44.1 kHz (441x), 48 kHz (480x), 50 kHz (500x), etc.
   - Makes it clearer how much faster playback is compared to original seismic data rate

### Key Learnings:

- **User Clarity**: Showing multipliers relative to original data rate (100 Hz) is more intuitive than relative to 44.1 kHz
- **More Options**: Additional intermediate speeds (50 kHz) give users more granular control

### Version
v1.38 - Commit: "v1.38 UI: Added 50 kHz base sampling rate option, changed multiplier display to show relative to original 100 Hz rate (441x, 480x, 500x, etc.)"

---

## Spectrogram Scroll Speed Fixes

### Changes Made:

1. **Minimum Scroll Speed**
   - Changed minimum scroll speed from 0x to 0.125x
   - Spectrogram now always scrolls at least 0.125x (0.5x actual with 4x multiplier)
   - Never stops completely, preventing static display

2. **Fixed Spectrogram Continuing After Playback**
   - Spectrogram now stops scrolling when playback finishes
   - Added `!isPlaying` check to both `drawWaveform()` and `drawSpectrogram()`
   - Visualization pauses properly when `isPlaying = false`

3. **Fixed 2x Scroll Speed Bug on Replay**
   - Root cause: `startVisualization()` was being called multiple times, creating duplicate animation loops
   - Added `visualizationStarted` flag to prevent multiple visualization loops
   - Each call was starting new `drawSpectrogram()` loops that all ran simultaneously
   - With 2 loops running, spectrogram scrolled twice per frame = 2x speed appearance
   - Now visualization starts only once, loops self-perpetuate via `requestAnimationFrame`

### Key Learnings:

- **Animation Loop Management**: Multiple `requestAnimationFrame` loops will all execute, causing double/triple rendering
- **State Checks**: Visualizations should check both `isPaused` AND `isPlaying` to properly stop
- **Initialization Guards**: Functions that start persistent loops should have guards against multiple calls

### Version
v1.39 - Commit: "v1.39 Fix: Set minimum spectrogram scroll speed to 0.125x (never 0), fixed spectrogram continuing to scroll after playback finishes, fixed 2x scroll speed bug on replay (prevented multiple visualization loops)"

---

