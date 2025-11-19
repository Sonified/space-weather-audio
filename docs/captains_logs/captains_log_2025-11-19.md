# Captain's Log - 2025-11-19

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

