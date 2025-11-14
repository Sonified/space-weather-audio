# Selection Diagnostics Test Guide

## Overview
The selection diagnostics system validates that all coordinate systems (pixels, percentages, samples, and timestamps) remain synchronized when selecting regions on the waveform.

## Features

### Automatic Diagnostics
Every time you make a selection on the waveform (click and drag), comprehensive diagnostics will automatically print to the console showing:

1. **Canvas & Pixels (Window Units)**
   - Canvas width
   - Start/end pixel positions
   - Selection width in pixels

2. **Progress (Percentage through waveform)**
   - Start/end percentages (0-100%)
   - Duration as percentage

3. **Audio Time (Playback seconds)**
   - Total audio duration
   - Start/end times in seconds
   - Selection duration
   - Start/end as percentages

4. **Samples (Audio buffer indices @ 44100 Hz)**
   - Total samples in buffer
   - Start/end sample indices
   - Number of samples in selection
   - Start/end as percentages

5. **Real Timestamps (UTC)**
   - Dataset start/end times
   - Selection start/end timestamps
   - Selection duration in real time
   - Start/end as percentages

6. **Validation**
   - Confirms all three percentage systems match
   - Reports any mismatches with details

### Console Commands

Two functions are available from the browser console:

#### `window.printCurrentSelection()`
Prints diagnostics for the currently active selection (the yellow highlighted region).

Example:
```javascript
window.printCurrentSelection()
```

#### `window.testAtPercentage(percent)`
Tests the coordinate system at a specific percentage through the audio.

Examples:
```javascript
window.testAtPercentage(0)    // Test at start
window.testAtPercentage(50)   // Test at midpoint
window.testAtPercentage(100)  // Test at end
window.testAtPercentage(33.5) // Test at 33.5%
```

## Testing Workflow

### 1. Load Audio Data
- Select a volcano/station/duration
- Click "Fetch Audio"
- Wait for data to load completely

### 2. Make a Selection
- Click and drag on the waveform to create a selection
- Watch console - diagnostics will print automatically
- Check that all percentages match (should show ✅)

### 3. Test Specific Points
```javascript
// Test start
window.testAtPercentage(0)

// Test middle
window.testAtPercentage(50)

// Test end
window.testAtPercentage(100)

// Test arbitrary point
window.testAtPercentage(27.3)
```

### 4. Verify Current Selection
```javascript
// Print full diagnostics for active selection
window.printCurrentSelection()
```

## Expected Output Example

```
================================================================================
🔍 SELECTION DIAGNOSTICS
================================================================================

📐 CANVAS & PIXELS (Window Units)
   Canvas Width:    1200.00 px
   Start Pixel:     300.00 px
   End Pixel:       900.00 px
   Selection Width: 600.00 px

📊 PROGRESS (Percentage through waveform)
   Start:    25.0000%
   End:      75.0000%
   Duration: 50.0000%

⏱️  AUDIO TIME (Playback seconds)
   Total Duration:      120.0000 s
   Start Time:          30.0000 s
   End Time:            90.0000 s
   Selection Duration:  60.0000 s
   Start %:             25.0000%
   End %:               75.0000%

🎵 SAMPLES (Audio buffer indices @ 44100 Hz)
   Total Samples:       5,292,000 samples
   Start Sample:        1,323,000
   End Sample:          3,969,000
   Selection Samples:   2,646,000
   Start %:             25.0000%
   End %:               75.0000%

🌐 REAL TIMESTAMPS (UTC)
   Dataset Start:       2024-01-01T00:00:00.000Z
   Dataset End:         2024-01-01T00:02:00.000Z
   Dataset Duration:    120.00 s
   Selection Start:     2024-01-01T00:00:30.000Z
   Selection End:       2024-01-01T00:01:30.000Z
   Selection Duration:  60.0000 s
   Start %:             25.0000%
   End %:               75.0000%

✅ VALIDATION (All percentages should match)
   Progress %:    25.0000% → 75.0000%
   Sample %:      25.0000% → 75.0000%
   Real Time %:   25.0000% → 75.0000%
   ✅ ALL COORDINATE SYSTEMS MATCH!
================================================================================
```

## What to Look For

### ✅ Good Signs
- All percentages match within 0.01%
- "ALL COORDINATE SYSTEMS MATCH!" message
- Sample indices are whole numbers
- Timestamps are valid ISO 8601 format
- Durations are consistent across all systems

### ❌ Warning Signs
- "MISMATCH DETECTED!" message
- Percentage differences > 0.01%
- Sample indices outside valid range
- Invalid timestamps
- Negative durations

## Use Cases for Zoom Feature

This diagnostic system will be crucial for:

1. **Zoom to Region** - Verify that zooming maintains correct sample/time mappings
2. **Zoom to Full** - Verify that returning to full view preserves accuracy
3. **Nested Operations** - Test zoom → select → zoom again
4. **Edge Cases** - Test selections at very start, very end, or very small regions

## Future Extensions

When implementing zoom:
- Add `window.printZoomState()` to show current zoom level and bounds
- Add `window.validateZoomCoordinates()` to check zoom transform math
- Log zoom transitions to verify smooth state changes

