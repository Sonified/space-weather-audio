# Captain's Log - 2025-11-12

## v1.76 Fix: Midnight-Crossing Chunk Filename Generation

### Problem
Chunks that cross midnight (e.g., 23:00-00:00) were being saved with incorrect filenames:
- **Wrong**: `HV_OBL_--_HHZ_1h_2025-11-11-23-00-00_to_2025-11-11-23-59-59.bin.zst`
- **Correct**: `HV_OBL_--_HHZ_1h_2025-11-11-23-00-00_to_2025-11-12-00-00-00.bin.zst`

The backend was using `trace.stats.endtime` (which IRIS might return as 23:59:59.999) instead of the requested `end_time` parameter (which is correctly 00:00:00 the next day).

### Root Cause
In `backend/collector_loop.py`, the filename generation used:
```python
end_str = trace.stats.endtime.datetime.strftime("%Y-%m-%d-%H-%M-%S")
```

But `trace.stats.endtime` can be slightly off due to how IRIS returns data, especially for chunks ending exactly at midnight.

### Solution
Changed to use the requested `end_time` parameter instead:
```python
end_str = end_time.strftime("%Y-%m-%d-%H-%M-%S")
```

This ensures filenames match the actual requested time window, correctly handling midnight crossings.

### Frontend Fixes
1. **Midnight-crossing detection**: Frontend now checks both start date and end date folders when a chunk crosses midnight
2. **Correct end time calculation**: Uses calculated `endDateTime` instead of metadata `chunk.end` for filename generation
3. **Path checking**: Tries both `/2025/11/11/` and `/2025/11/12/` paths for midnight-crossing chunks

### Files Changed
- `backend/collector_loop.py`: Fixed filename generation to use `end_time` instead of `trace.stats.endtime`
- `js/data-fetcher.js`: Fixed end time calculation and added dual-path checking for midnight chunks
- `js/waveform-renderer.js`: Commented out debug logging statements

### Scripts Created
- `backend/scripts/fix_midnight_chunk_filename.py`: One-off script to rename the incorrectly named file
- `backend/scripts/fix_all_chunks.py`: Comprehensive scanner to find and fix all incorrectly named chunks (midnight-crossing and regular chunks with :59 endings) across all active volcanoes
- `backend/scripts/verify_file_exists.py`: Verification script to check file existence on R2

### Commit
**v1.76 Fix: Fixed midnight-crossing chunk filename generation and frontend path checking**

This ensures all future chunks crossing midnight will be named correctly, and the frontend can find them in either the start date or end date folder.

---

## v1.78 Fix: Backward Compatibility and UI Improvements

### Changes
1. **Hybrid Format Support**: Frontend now tries 3 filename formats in order:
   - NEW format with `:00` ending (correct)
   - NEW format with `:59` ending (hybrid - what Spurr uses)
   - OLD format with sample rate (legacy)
   This ensures backward compatibility with all historical incorrectly named files.

2. **Default Duration**: Changed from 30 minutes to 24 hours for better default experience.

3. **Custom Y-Axis Ticks**: 
   - Square root scale: Added ticks at 3, 4, 5, 7, 10, 12, 15, 17, 20, 25, 30, 35, 40, 45, 50 Hz
   - Logarithmic scale: Added ticks at 0.3, 0.4, 0.7, 1.5, 3, 4, 7, 15, 30, 40 Hz

4. **Script Updates**: Renamed `fix_all_midnight_chunks.py` to `fix_all_chunks.py` to reflect that it fixes all incorrectly named chunks, not just midnight-crossing ones.

### Files Changed
- `js/data-fetcher.js`: Added hybrid format fallback support
- `index.html`: Changed default duration to 24 hours
- `js/spectrogram-axis-renderer.js`: Added custom tick frequencies
- `backend/scripts/fix_all_midnight_chunks.py`: Renamed to `fix_all_chunks.py`
- `backend/scripts/fix_all_chunks.py`: Updated to handle all `:59` endings

### Commit
**v1.78 Fix: Added hybrid format support, custom y-axis ticks, and 24h default duration**

This ensures the frontend can read all historical file formats while the backend creates correct formats going forward.

---

## v1.79 Fix: UI Spacing Improvements

### Changes
1. **Fixed Button Height**: Added fixed height (44px), line-height, and flexbox layout to prevent buttons from jumping when text changes (e.g., "⏸️ Pause" vs "▶️ Resume" in Safari).

2. **Improved Bottom Controls Spacing**: 
   - Increased spacing between label and control (8px) for Frequency Scale and Scroll Speed
   - Increased spacing between control groups (30px) for better visual separation

### Files Changed
- `styles.css`: Added fixed height and flexbox layout to buttons
- `index.html`: Improved spacing for bottom control groups

### Commit
**v1.79 Fix: Fixed button height jumping and improved bottom controls spacing**

This improves UI stability and visual hierarchy in the bottom control panel.

---

## v1.80 UI: Duration Dropdown and Data Type Selector

### Changes
1. **Duration Dropdown Order**: Moved "24 hours" option to the bottom of the dropdown list while keeping it as the default selected option, as requested by user.

2. **Data Type Selector**: Hid the data type selector (Seismic/Infrasound) from the UI for now.

### Files Changed
- `index.html`: Moved 24h option to bottom of duration dropdown and hid data type selector

### Commit
**v1.80 UI: Moved 24h duration to bottom of dropdown and hid data type selector**

This improves the UI by keeping the most common option (24h) as default while maintaining logical ordering, and simplifies the interface by hiding the data type selector.

---

## v1.81 UI: Incremental Download Size and Button Repositioning

### Changes
1. **Incremental Download Size Updates**: Download size metric now updates in real-time as each chunk arrives, starting at "0.00 MB" and growing incrementally throughout the download process.

2. **Download Button Repositioning**: 
   - Changed button text from "💾 Download" to "💾 Download Audio File"
   - Moved button from top control panel to lower "Simulate Row" panel, positioned to the right of "Bypass CDN Cache" checkbox

### Files Changed
- `js/data-fetcher.js`: Added incremental download size update after each chunk is downloaded
- `js/main.js`: Initialize download size to "0.00 MB" at start of streaming
- `index.html`: Moved Download button to lower menu and updated button text

### Commit
**v1.81 UI: Incremental download size updates and Download button moved to lower menu**

This provides better user feedback during downloads and improves UI organization by grouping the download button with other utility controls.

---

## v1.80 Feature: Waveform Y-Axis Ticks and Axis Rendering Fixes

### Implementation
Added amplitude axis ticks to the waveform, matching the spectrogram axis design.

**Features**:
- Y-axis displays amplitude values: "0.5" (top), "0" (middle), "-0.5" (bottom)
- Positioned absolutely to the right of the waveform canvas
- Uses same styling and positioning approach as spectrogram axis
- Optimized resize handling using `requestAnimationFrame`

**Fixes**:
1. **Vertical Compression Fix**: Fixed waveform axis labels appearing compressed by using `offsetHeight` (display height) instead of internal `canvas.height` (which may be scaled by `devicePixelRatio`)
2. **Hz Label Clarity**: Fixed blurry "Hz" label on spectrogram axis by matching font size (16px), color (#ddd), and baseline (middle) to frequency labels
3. **Zero Label**: Changed "-0" to "0" on waveform axis since the tick mark already provides visual connection

**Files Created**:
- `js/waveform-axis-renderer.js` - Complete waveform axis rendering module

**Files Modified**:
- `index.html` - Added waveform axis canvas element
- `styles.css` - Combined waveform and spectrogram axis styling
- `js/waveform-renderer.js` - Integrated axis drawing after waveform is drawn
- `js/main.js` - Added resize handler for waveform axis, fixed dimension tracking
- `js/data-fetcher.js` - Imported waveform axis functions
- `js/spectrogram-axis-renderer.js` - Fixed Hz label styling for clarity

### Version: v1.80
**Commit**: `v1.80 Feature: Added waveform y-axis ticks and fixed axis rendering issues`

---

## v1.82 Feature: Dynamic Y-Axis Tick Filtering Based on Playback Speed

### Implementation
Added intelligent tick filtering for spectrogram y-axis that adapts based on playback speed to reduce clutter at slower speeds.

**Features**:
- **All Scales**: 50 Hz appears when speed drops below 0.95x (even if it's the Nyquist frequency)
- **Square Root Scale**:
  - At 0.6x speed or slower: Remove 2, 4, 12, 17 Hz
  - At 0.4x speed or slower: Also remove 45 Hz
  - At 0.35x speed or slower: Also remove 7 Hz
  - At 0.3x speed or slower: Also remove 35 Hz and 25 Hz
- **Linear Scale**:
  - At 0.4x speed or slower: Remove 5, 15, 25, 35, 45 Hz

**Fixes**:
- Fixed 50 Hz not appearing by allowing it to bypass the Nyquist skip condition when speed < 0.95x
- Adjusted logarithmic scale bottom threshold from 5% to 6% to prevent label overlap with "Hz"

**Files Modified**:
- `js/spectrogram-axis-renderer.js` - Added speed-based filtering logic for all scale types

### Version: v1.82
**Commit**: `v1.82 Feature: Dynamic y-axis tick filtering based on playback speed`

