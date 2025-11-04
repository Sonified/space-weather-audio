# Captain's Log - November 3, 2025

## Panel Background Color Fix

### Changes Made:

1. **Fixed Swapped Panel Background Colors**
   - Fixed background color swap between Fetch Data panel and Data Visualization panel
   - Issue was caused by incorrect nth-child selector - the `<h1>` tag is the first child, shifting all panel counts
   - Fetch Data panel (nth-child(3)) now has light background as intended
   - Data Visualization panel (nth-child(5)) now has dark background as intended
   - Dark background properly matches the light-colored labels (`#ffe8e8`) in the visualization panel

### Problem:
- Two pushes ago, panel background colors got swapped accidentally
- Fetch Data panel was showing dark background when it should be light
- Data Visualization panel was showing light background when it should be dark
- Root cause: nth-child selectors were off by one due to `<h1>` being first child of container

### Solution:
- Corrected nth-child selector from nth-child(4) to nth-child(5) for Data Visualization panel
- Dark background moved from nth-child(4) to nth-child(5)
- Light background restored to nth-child(3) (Fetch Data panel)

### Key Learnings:

- **nth-child Counting**: nth-child counts ALL children, not just elements with the same class - the `<h1>` tag counts as child 1, shifting all panel numbers
- **CSS Debugging**: When styles don't apply as expected, check if other elements between selectors are affecting nth-child counting

### Version
v1.40 - Commit: "v1.40 Fix: Fixed swapped panel background colors - corrected nth-child selectors accounting for h1 tag in container"

---

## Default Station Selection Update

### Changes Made:

1. **Volcano-Specific Default Station Selection**
   - Updated `updateStationList()` function to check the selected volcano
   - For Kilauea: defaults to the 4th station in the list (index 3)
   - For all other volcanoes: defaults to the first station (index 0)
   - This provides a better default experience for Kilauea while keeping standard behavior for others

### Problem:
- User wanted the 4th station selected by default, but only for Kilauea volcano
- Needed to make the default selection conditional based on volcano selection

### Solution:
- Added volcano check in `updateStationList()` function
- Conditional default index: `const defaultIndex = (volcano === 'kilauea') ? 3 : 0;`
- Maintains existing behavior for non-Kilauea volcanoes

### Version
v1.41 - Commit: "v1.41 Feature: Default station selection - 4th station for Kilauea, first station for others"

---

## Waveform Scrubbing Implementation

### Changes Made:

1. **Interactive Waveform Scrubbing**
   - Added click-and-drag scrubbing functionality to waveform canvas
   - Click and drag to preview seek position (grey line)
   - Release mouse to seek to previewed position
   - Red playback indicator line shows current position during playback
   - Cached waveform canvas for performance (avoids redrawing waveform on every frame)

2. **Seek Functionality**
   - Added `seekToPosition()` function that sends seek message to AudioWorklet
   - AudioWorklet now supports `seek` message type to jump to specific sample position
   - Seeking automatically resumes playback if paused
   - Position tracking updates correctly after seeking

3. **Playback Indicator**
   - Added `updatePlaybackIndicator()` function that draws red vertical line showing current playback position
   - Indicator updates smoothly based on playback speed
   - Indicator pauses during scrubbing to show preview line instead

### Implementation Details:

- **Scrubbing**: Mirrored from `test_streaming.html` but adapted for AudioWorklet (no A/B buffer system needed)
- **Full scrubbing implementation reference**: `test_streaming.html` contains the complete scrubbing implementation with A/B buffer crossfading
- **Variables added**: `isDragging`, `scrubTargetPosition`, `cachedWaveformCanvas`, `totalAudioDuration`, `currentAudioPosition`, `lastUpdateTime`
- **Functions added**: `setupWaveformInteraction()`, `seekToPosition()`, `updatePlaybackIndicator()`
- **AudioWorklet changes**: Added `seek` message handler that sets `readIndex` to target sample position

### Key Differences from test_streaming.html:

- No A/B buffer system - AudioWorklet handles seeking by repositioning read pointer
- Simpler implementation - no crossfading needed since AudioWorklet manages buffer internally
- Uses cached waveform canvas for better performance

---

## Waveform Scrubbing Fixes and UI Improvements

### Changes Made:

1. **Click Prevention on Seeking**
   - Added 10ms crossfade (fade-out before seek, fade-in after) to prevent audio clicks/pops
   - Only applies fade when audio is actively playing (skips fade if paused)
   - Uses `audioContext.currentTime` for precise audio timeline coordination
   - Based on Web Audio API best practices for preventing discontinuities

2. **Playback Indicator Fixes**
   - Fixed playback indicator not restarting after seeking when playback had finished
   - Fixed playback indicator not restarting after spacebar resume
   - Indicator now properly restarts in all resume scenarios (pause/resume, seek after finish, etc.)

3. **UI Improvements**
   - Changed seeking status emoji from mixer (🔀) to green checkmark (✅)
   - Removed "Local Server" checkbox from lower left - always uses Railway backend now
   - Simplified UI by removing unused local server option

### Problems Fixed:

- **Audio clicks on seek**: Clicking sounds when releasing mouse after scrubbing
- **Playback indicator not updating**: Scan line stopped drawing after seeking when playback had finished
- **Playback indicator not restarting**: Spacebar pause/resume didn't restart the indicator animation

### Solutions:

- **Click prevention**: Brief crossfade (10ms) masks the discontinuity when jumping to new position
- **Indicator restart**: Added explicit `requestAnimationFrame(updatePlaybackIndicator)` calls in resume logic
- **Seek state handling**: Improved condition checking for when to restart indicators (handles both `isPaused` and `!isPlaying` states)

### Version
v1.42 - Commit: "v1.42 Fix: Waveform scrubbing improvements - click prevention, playback indicator fixes, removed local server checkbox"

---

## Loop Playback Indicator Bug Fix

### Changes Made:

1. **Fixed Loop Transition Interference**
   - Added early return in `finished` event timeout handler to ignore stale events during loop transition
   - Prevents `finished` event from setting `isPlaying = false` when loop is in progress
   - Added check for `loopTransitionInProgress` flag before handling finished state

2. **Improved Loop Indicator Restart**
   - Enhanced loop-soon timeout handler to use nested setTimeout for indicator restart
   - Refreshes `lastUpdateTime` right before starting animation frame
   - Ensures clean state when restarting playback indicator after loop

### Problem:
- Playback indicator would stop moving after loop completed
- Console logs showed: indicator started updating (0.01s, 0.02s...) then suddenly stopped
- Root cause: `finished` event's 50ms timeout was firing AFTER loop completed
- When `finished` timeout checked `if (isLooping && !loopTransitionInProgress)`, condition was FALSE (flag was true)
- Fell through to `else` block which set `isPlaying = false`, killing the indicator

### Solution:
- Added early return if `loopTransitionInProgress` is true in finished timeout handler
- Prevents stale `finished` events from interfering with active loop transitions
- Loop transition handler already sets state correctly, so finished handler should exit early

### Key Learnings:
- **Race Conditions**: Timeout handlers can fire in unexpected order - always check transition flags
- **State Flags**: Use flags like `loopTransitionInProgress` to prevent stale events from interfering
- **Event Timing**: Finished events can arrive after transitions complete - need defensive checks

### Version
v1.43 - Commit: "v1.43 Fix: Loop playback indicator bug - prevent finished event from stopping indicator during loop transition"

---

## Worklet-Driven Selection & Looping Architecture Refactor

### Changes Made:

1. **Worklet-Driven Boundary Detection**
   - Moved selection boundary logic entirely into AudioWorklet
   - Worklet checks sample position every frame (128 samples = ~2.9ms)
   - Warns 15ms before selection end (reduced from 100ms for tighter loops)
   - Worklet owns selection state (`selectionStart`, `selectionEnd`, `isLooping`)
   - Main thread only reacts to worklet events - no time-based predictions

2. **Removed Time-Based Predictions**
   - Deleted `checkFadePrediction()` function (was causing race conditions)
   - Removed `loopTransitionInProgress` and `selectionEndFadeStarted` flags
   - Eliminated competing loop handlers - single source of truth now

3. **Selection Loop Fixes**
   - Fixed "Play Again" after selection end - now replays from selection start (not global 0)
   - Removed minimum selection size restriction (can loop tiny 0.01s selections)
   - Worklet clamps seeks to selection bounds automatically

4. **Intelligent Audio-Rate Fade Bypass**
   - Loops <50ms (>20Hz) bypass ALL fade logic - no volume dip
   - Loops 50-200ms use minimal 2ms crossfade
   - Loops >200ms use standard 5ms crossfade
   - Audio-rate loops now create pure tones without artifacts

### Problems Fixed:

- **Race conditions**: Time-based predictions vs sample-based reality caused failures
- **Short loops failing**: Prediction timing was off, worklet already passed boundary
- **Selection end jump**: "Play Again" jumped to 0 instead of selection start
- **Silent dropouts**: Tiny loops were fading to near-zero, killing the tone
- **Artificial limits**: Minimum selection size prevented tiny loops

### Solution:

- **Single source of truth**: Worklet owns position and boundaries
- **Sample-accurate**: Checks every audio frame, not time estimates
- **Event-driven**: Main thread only reacts to worklet warnings
- **Smart fades**: Auto-detects audio-rate loops and bypasses fades
- **No limits**: Any selection size works perfectly

### Key Learnings:

- **DAW Architecture**: Professional audio apps work exactly like this - playback engine owns timing
- **Audio Rate**: Loops <50ms are periodic waveforms - fading creates artifacts
- **Sample Accuracy**: Time-based estimates fail at high speeds - worklet position is reality
- **Event Coordination**: Multiple handlers fighting each other = bugs. Single handler = clean

### Version
v1.44 - Commit: "v1.44 Refactor: Worklet-driven selection/looping architecture - sample-accurate boundaries, audio-rate fade bypass, removed selection size limits"

---

## High-Pass Filter Update: Added 0.02 Hz Option

### Changes Made:

1. **Added 0.02 Hz High-Pass Filter Option**
   - Added 0.02 Hz as a new option in the high-pass filter dropdown
   - Positioned between 0.01 Hz and 0.045 Hz options
   - Set as the new default selection (replacing 0.01 Hz)

2. **Updated Frequency Calculation Math**
   - Added `freq002Hz` calculation to match existing pattern
   - Formula verified: `audio_freq = original_freq × (base_rate / original_rate)`
   - Display correctly shows calculated audio frequency for 0.02 Hz based on selected base sampling rate

### Problem:
- User wanted 0.02 Hz as a filter option between 0.01 and 0.045 Hz
- Needed to verify the math was correct for calculating audio frequencies

### Solution:
- Added 0.02 Hz option to dropdown HTML
- Updated `updateHighPassFilterDisplay()` to calculate and display 0.02 Hz audio frequency
- Set as default selection
- Math verified: At 44.1 kHz with 100 Hz original rate, 0.02 Hz becomes 8.82 Hz audio frequency

### Key Learnings:
- Frequency calculation accounts for both base sampling rate speedup and any multiplier
- Backend already supports any highpass_hz value, so no backend changes needed

### Version
v1.45 - Commit: "v1.45 Feature: Added 0.02 Hz high-pass filter option, set as default, verified frequency calculation math"

---

## Worklet Recreation Bug Fix

### Changes Made:

1. **Removed Unnecessary Worklet Recreation**
   - Fixed `togglePlayPause()` function to stop destroying/recreating worklet when replaying after playback finishes
   - Reduced replay logic from 70+ lines to ~20 lines
   - Now uses existing `seekToPosition()` mechanism instead of reinitializing entire worklet
   - Worklet stays alive during all normal playback operations

### Problem:
- When playback finished and user clicked "Play" again, code was destroying and recreating the entire AudioWorklet
- This caused unnecessary complexity, potential race conditions, and flash of playhead at position 0
- Worklet recreation was completely unnecessary - `seekToPosition()` already handles replay perfectly

### Solution:
- Removed all worklet destruction/recreation logic from replay handler
- Simplified to just call `seekToPosition(replayPosition)` 
- `seekToPosition()` already handles: fade-out, seek, fade-in, resume, UI updates
- Worklet now only recreated when fetching new data (which is necessary)

### Key Learnings:
- **Don't recreate what already works**: `seekToPosition()` is proven and handles all edge cases
- **Simplify aggressively**: 70 lines → 20 lines is a massive improvement
- **Worklet lifecycle**: Should only be destroyed when truly necessary (new data fetch), not for simple replay

### Version
v1.46 - Commit: "v1.46 Fix: Removed unnecessary worklet recreation on replay - simplified togglePlayPause to use seekToPosition instead of destroying/recreating worklet"

---

