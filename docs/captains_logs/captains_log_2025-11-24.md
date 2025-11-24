# Captain's Log - 2025-11-24

## v1.0 - Solar Portal Mode & UI Updates

### New Features
**Solar Portal Mode**
- Created new "Solar Portal" mode (☀️) with unique configuration:
  - Shows participant setup modal on first visit only
  - Permanently hides Begin Analysis button
  - Hides simulate panel at bottom
  - Enables all features (like personal mode)
  - No other study modals appear
- Added Solar Portal to mode selector dropdown
- Updated `updateCompleteButtonState()` to respect Solar Portal mode (keeps Begin Analysis hidden)
- Updated simulate panel visibility logic to hide in Solar Portal mode

### UI Improvements
- Changed "Participant ID" label to "User ID" in upper right corner
- Set simulate panel to `display: none` by default to prevent flash on load

### Default Mode Changes
- Changed default mode from DEV to PERSONAL
- Updated HTML dropdown to default to Personal mode
- Updated `DEFAULT_MODE` in `master-modes.js` to `AppMode.PERSONAL`
- Production environment now defaults to PERSONAL mode (was PRODUCTION)

### Files Modified
- `js/master-modes.js` - Added SOLAR_PORTAL mode, updated defaults
- `js/main.js` - Added `initializeSolarPortalMode()` function, updated mode initialization
- `js/region-tracker.js` - Updated `updateCompleteButtonState()` to respect Solar Portal mode
- `index.html` - Added Solar Portal to dropdown, changed Participant ID to User ID, set simulate panel default hidden

---

## v1.01 - Spacecraft Data Download in Main Interface

### Major UI Update
**Spacecraft Selection Interface**
- Replaced volcanic data selectors with spacecraft data selectors:
  - **Spacecraft dropdown**: Parker Solar Probe (PSP), Wind, MMS
  - **Data Type dropdown**: Magnetometer datasets (PSP_FLD_L2_MAG_RTN, PSP_FLD_L2_MAG_RTN_4_SA_PER_CYC)
  - **Start Date** input field
  - **Start Time** input field (HH:MM:SS.mmm format)
  - **End Date** input field
  - **End Time** input field (HH:MM:SS.mmm format)
  - **Fetch Data** button
- Hidden Auto Play checkbox to save space
- Old volcanic controls (station, duration) moved to hidden section

### Code Changes
- Updated all `getElementById('volcano')` references to `getElementById('spacecraft')` in main.js (7 locations)
- Updated event listeners and DOM references for spacecraft selector
- Prepared interface for CDASWS API integration (backend connection pending)

### Files Modified
- `index.html` - Rebuilt top selection panel with spacecraft controls
- `js/main.js` - Updated all DOM references from volcano to spacecraft

### Git Info
- **Version**: v1.01
- **Commit**: "v1.01 Spacecraft data download in main interface"

---

## v1.02 - Refactor: main.js loading fixes

### Code Refactoring
**main.js Loading Improvements**
- Refactored main.js to ensure proper loading and initialization
- Fixed module loading order and import structure
- Improved error handling during initialization

### Files Modified
- `js/main.js` - Refactored loading and initialization logic
- `js/audio-state.js` - Updated state management
- `js/data-fetcher.js` - Updated data fetching logic
- `js/spectrogram-axis-renderer.js` - Updated axis rendering
- `index.html` - Updated HTML structure
- `js/cdaweb-cache.js` - New file for CDASWS caching

### Git Info
- **Version**: v1.02
- **Commit**: "v1.02 Refactor: main.js loading fixes"

---

## v1.03 - Fix: CDAWeb waveform rendering and audio playback

### Critical Fixes
**CDAWeb Data Pipeline**
- Fixed waveform not rendering for CDAWeb data:
  - Added sending samples to waveform worker via `add-samples` message
  - Fixed missing `State.currentMetadata` setting (needed by waveform renderer)
  - Added dynamic calculation and storage of `originalSamplingRate` from time span and sample count
- Fixed audio playback not working:
  - Added `initAudioWorklet()` call before CDAWeb data fetch
  - Added sending samples to AudioWorklet in 1024-sample chunks
  - Added `data-complete` message with correct original sample rate
  - Added zoom state initialization for proper seeking
- Fixed region tracker looking for old "volcano" element:
  - Updated all `volcano` references to `spacecraft` in `region-tracker.js`
  - Renamed `getCurrentVolcano()` to `getCurrentSpacecraft()`
  - Updated all internal variables: `currentVolcano` → `currentSpacecraft`, `regionsByVolcano` → `regionsBySpacecraft`

### Debugging Improvements
- Added comprehensive logging throughout data pipeline:
  - Pipeline logging: `🔍 [PIPELINE]` prefix for main thread operations
  - Worker logging: `🔍 [WORKER]` prefix for waveform worker operations
  - Tracks: data loading, state setting, worker communication, rendering

### Files Modified
- `js/data-fetcher.js` - Added metadata setting, sample sending to workers, audio worklet initialization
- `js/main.js` - Added `initAudioWorklet()` call for CDAWeb path
- `js/region-tracker.js` - Updated all volcano references to spacecraft
- `js/waveform-renderer.js` - Added pipeline logging
- `workers/waveform-worker.js` - Added worker logging

### Git Info
- **Version**: v1.03
- **Commit**: "v1.03 Fix: CDAWeb waveform rendering and audio playback"

---

## v1.04 - Fix: Download audio with correct 44.1kHz sample rate

### Critical Audio Download Fix
**WAV File Sample Rate**
- Fixed downloaded WAV files using incorrect sample rate
- Problem: Was using calculated spacecraft data rate (587 Hz) instead of audio sample rate
- Solution: Hardcoded WAV file creation to use 44100 Hz (standard audio rate)
- This matches the sample rate that AudioContext decodes CDAWeb files to
- Affects both download buttons:
  - `downloadBtn` (volcano/seismic data) - uses `audio-player.js`
  - `downloadAudioBtn` (CDAWeb spacecraft data) - uses `main.js`

### Code Cleanup
**Download Function Consolidation**
- Attempted to store original WAV blob from CDAWeb for direct download
- Added `originalAudioBlob` to audio state
- Modified `data-fetcher.js` to pass through original blob
- Ultimately kept separate download implementations for different data sources

### Files Modified
- `js/main.js` - Updated CDAWeb download to use 44100 Hz, incremented version to 1.04
- `js/audio-player.js` - Updated fallback download to use 44100 Hz
- `js/audio-state.js` - Added `originalAudioBlob` state variable
- `js/data-fetcher.js` - Added originalBlob to return object

### Git Info
- **Version**: v1.04
- **Commit Hash**: f28be4d
- **Commit**: "v1.04 Fix: Download audio with correct 44.1kHz sample rate"

