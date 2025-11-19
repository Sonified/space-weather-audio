# Captain's Log - 2025-11-19

## v2.57 - Corrupted State Detection: Pre-Survey Completion Edge Case

### Bug Fixed

**Corrupted State: Pre-Survey Completed But Tutorial Not Started**
- **Problem**: Users who completed pre-survey but closed the page before starting tutorial would end up in a corrupted state where they had `study_pre_survey_completion_date` set but `study_tutorial_completed` null and `study_tutorial_in_progress` null. System didn't know how to handle this edge case.
- **Root Cause**: Only checked for participant setup + no tutorial completion, but didn't account for pre-survey completion without tutorial.
- **Solution**: Added two corrupted state checks in `study-workflow.js`:
  - **Case 1**: Seen participant setup BUT no tutorial completion AND not in tutorial → Reset
  - **Case 2**: Has pre-survey date BUT no tutorial completion AND not in tutorial → Reset
  - Both trigger complete flag reset to brand new participant state

### Architecture Notes

**Corrupted State Detection Logic**
- Checks run at very top of `startStudyWorkflow()` before any modal logic
- Uses `!isTutorialInProgress()` to allow users actively in tutorial to continue
- Clears ALL `STORAGE_KEYS` entries to ensure clean restart
- Prevents users from getting stuck in impossible states

### Git Commit
**Version**: v2.57  
**Commit Message**: v2.57 Corrupted State Detection: Added pre-survey completion edge case handling

---

## v2.56 - Canvas Redrawing: Aggressive Destroy/Recreate on Visibility Change

### Bug Fixed

**Canvas Feature Boxes Disappearing After Tab Switch/Sleep**
- **Problem**: Feature boxes disappeared when switching tabs or waking computer from sleep, and would never redraw automatically. Error logs showed "rebuildCanvasBoxesFromRegions is not a function" indicating the redraw attempt was failing.
- **Root Cause**: Visibility change handler was calling `cleanupOnUnload()` which destroyed the overlay canvas to save memory, but when page became visible again it wasn't recreating the canvas or redrawing features. Additionally, we were calling the wrong function name (`rebuildCanvasBoxesFromRegions` instead of `redrawAllCanvasFeatureBoxes`).
- **Solution**: Implemented aggressive destroy/recreate strategy:
  - When `document.hidden` is true: Call `cleanupSpectrogramSelection()` to destroy overlay canvas
  - When `document.hidden` is false: Call `setupSpectrogramSelection()` to recreate canvas, then `redrawAllCanvasFeatureBoxes()` to restore all features
  - Audio continues playing in background (cancelAllRAFLoops only stops visual animations)

### Architecture Notes

**cancelAllRAFLoops() Does NOT Stop Audio**
- Only cancels RequestAnimationFrame loops for visual elements:
  - `playbackIndicatorRAF` - Red playback line animation
  - `spectrogramRAF` - Scrolling spectrogram visualization
  - `resizeRAF` - Resize handler animation
  - `crossfadeAnimation` - Volume crossfade animation
- Actual audio continues playing in Web Audio worklet (separate audio thread)
- Perfect behavior: Save CPU when hidden, restore visuals when visible, audio uninterrupted

### Git Commit
**Version**: v2.56  
**Commit Message**: v2.56 Canvas Redrawing: Aggressive destroy/recreate strategy for overlay canvas on visibility change

---

## v2.55 - Critical Bug Fixes: Region Persistence & Button States

### Major Bugs Fixed

**CRITICAL: Region/Feature Persistence Bug**
- **Problem**: Regions and features were being saved to localStorage correctly, but were NEVER loaded back after page refresh. Users would lose all their work.
- **Root Cause**: `initRegionTracker()` initialized regions as empty array with comment saying "will be loaded after fetchData", but no code actually did this!
- **Solution**: Created `loadRegionsAfterDataFetch()` function that's called after data fetch completes and time range is known. Regions now properly restore after refresh.

**CRITICAL: Timestamp Filtering Bug**
- **Problem**: Regions were being filtered out incorrectly when fetching data for different time ranges, even on the same day.
- **Root Cause**: Filter logic checked for `startSample` FIRST and tried to convert samples to time using the CURRENT data start time. But sample indices are relative to data start! When you fetch 11:30-11:30 after creating regions during 00:00-00:00 fetch, the sample-to-time conversion gave wrong absolute times.
- **Solution**: Reordered filter logic to prioritize `startTime`/`stopTime` (absolute timestamps) over `startSample`/`endSample`. Absolute timestamps don't change between fetches.

**Button Click Handler Bug**
- **Problem**: Returning users who had clicked "Begin Analysis" would see green "Complete" button, but clicking it opened the wrong modal ("Are you ready to begin?" instead of "All Done?").
- **Root Cause**: When restoring button state for returning users, we only changed visual appearance (text, color) but didn't replace the click handler.
- **Solution**: Added button cloning and proper click handler attachment in `study-workflow.js` when restoring Complete button state.

### Refactors

**Unified Button State Function**
- Merged `updateCompleteButtonState()` and `updateCmpltButtonState()` into ONE function
- Single source of truth handles both "Begin Analysis" and "Complete" modes
- Checks button text to determine mode and applies appropriate logic
- `updateCmpltButtonState()` deprecated but kept for backward compatibility

### New Features

**Enhanced Error Logging**
- All critical errors now logged to console with full details BEFORE being reported
- Shows error message, location, stack trace, and full error object
- Helps debugging by making errors visible instead of silently reporting them
- Added to both `window.onerror` and `unhandledrejection` handlers

**Tutorial State Management**
- Added `study_tutorial_in_progress` flag set when user clicks "Begin Tutorial"
- Cleared when tutorial completes (when `study_tutorial_completed` is set)
- Used by `updateCompleteButtonState()` to prevent button state overrides during tutorial
- Added to user metadata config page for debugging

**Tutorial Improvements**
- Added "This is a spectrogram of the seismometer data" message at start of spectrogram explanation
- Removed "Skip" option from Tutorial Introduction modal - all users must complete tutorial
- Changed production mode console log from "🔒 Overlay shown immediately" to "🌋 Volcano Audio - LIVE Production"

**Emergency Canvas Recovery**
- Added automatic overlay canvas recovery when stuck state detected
- Attempts to recreate canvas with proper dimensions and positioning
- Only shows "please refresh" message if recovery fails

### Architecture Notes

**Canvas Box Drawing**
- Discovered multiple systems automatically call `redrawAllCanvasFeatureBoxes()`: x-axis renderer (during zoom animations), speed changes, frequency scale changes
- Each call clears `completedSelectionBoxes` array before rebuilding, so no duplicates even if called multiple times
- Decided NOT to explicitly call in `loadRegionsAfterDataFetch()` since `updatePlaybackSpeed()` calls it ~100ms later anyway

### Git Commit
**Version**: v2.55  
**Commit Message**: v2.55 Critical Bug Fixes: Region persistence, timestamp filtering, button states, enhanced error logging

