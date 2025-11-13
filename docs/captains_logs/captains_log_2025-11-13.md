# Captain's Log - 2025-11-13

## 🎉 MAJOR SUCCESS: CDN Backfill Implementation

### Problem
The CDN cache was missing 24+ hours of historical seismic data. Users couldn't access recent data through the web interface, and the collector was only creating 10-minute chunks going forward but not backfilling older gaps.

### Solution: 6-Hour Backfill Strategy
Created `backend/cdn_backfill.py` - a comprehensive backfill script that efficiently fills data gaps using a smart chunking strategy:

**Algorithm**:
1. **Fetch run history** from CDN to determine most recent collector run
2. **Fill the gap** from most recent 6h boundary to collector run (1 IRIS fetch)
3. **Fill 4 complete 6h blocks** going backwards (4 IRIS fetches)

**Efficiency**: 
- Total: 5 IRIS fetches for 25+ hours of data
- Creates: 4× 6h + 25× 1h + 150× 10m chunks = **179 files from 5 requests**
- **35.8 files per IRIS fetch!**

**Chunk Derivation**:
- Each 6h fetch creates 1× 6h chunk + 6× 1h sub-chunks + 36× 10m sub-chunks
- All derived from the same data without additional IRIS requests
- Ensures perfect consistency across all chunk sizes

### Implementation Details

**Key Features**:
- Checks existing metadata before fetching to avoid duplicate work
- Validates chunk completeness (end time + sample count)
- Handles metadata filtering to skip corrupted entries
- Detailed logging shows every operation (audit, fetch, create, upload)
- Follows exact same logic as `collector_loop.py` for consistency

**Files Created**:
- `backend/cdn_backfill.py` - Main backfill script (1377 lines)
- `backend/test_6h_backfill_logic.py` - Dry-run test to validate logic before execution

**Audit Logic**:
```python
# Checks BOTH 1h and 10m chunks for completeness
if hour_end <= most_recent_run:
    # Check 1h chunk exists
    exists_1h = check_if_chunk_exists(...)
    # ALSO check all 6× 10m sub-chunks exist
    for each 10m chunk:
        exists_10m = check_if_chunk_exists(...)
```

This ensures the backfill detects missing sub-chunks even when parent chunks exist.

### Test Run Results
```
🌐 IRIS Fetches: 5
📁 Files Created:
   ├─ 6h chunks:  4
   ├─ 1h chunks:  25
   └─ 10m chunks: 150
   TOTAL: 179 files
📊 Efficiency: 35.8 files per IRIS fetch
```

**Time Range Filled**: 
- Nov 12, 06:00 UTC → Nov 13, 07:10 UTC (25+ hours)
- Zero gaps, all chunks complete

### Learning: CDN Cache vs R2 Storage

**Critical Discovery**: Files exist in R2 immediately but take time to propagate to CDN cache. This caused confusion when:
- Files showed as existing in R2 (✅ correct)
- Frontend couldn't fetch from CDN (❌ cache not updated yet)
- Solution: Either wait for CDN propagation or use cache bypass

### Known Issue: File Deletion
The `force_recreate` flag that's supposed to delete existing chunks before backfilling didn't work properly. The deletion logic built filenames correctly but failed to actually remove files from R2. This needs further investigation but wasn't critical for this success.

---

## Force IRIS Fetch Feature

### Implementation
Added UI button to force fetching directly from IRIS for audio comparison testing.

**Features**:
- Toggle button in top controls (right-aligned): "🌐 Force IRIS Fetch: OFF"
- When ON: Turns red, bypasses ALL CDN caching, fetches live from IRIS via Railway
- When OFF: Uses normal CDN-first logic

**Technical Changes**:
```javascript
// Skips realistic chunk fetch entirely when force mode enabled
if (forceIrisFetch) {
    console.log('Force IRIS Fetch ENABLED - Skipping CDN chunk fetches');
} else if (isActiveStation) {
    // Normal realistic chunk fetch
}

// Routes to Railway backend directly
if (forceIrisFetch) {
    await fetchFromRailway(...); // Direct IRIS
} else if (isActiveStation) {
    await fetchFromR2Worker(...); // CDN cached
}
```

**Status Message**:
- Normal: "Fetching data from R2 via progressive streaming"
- Force IRIS: "Force IRIS Fetch: Fetching live from IRIS via Railway backend"

**Files Modified**:
- `index.html` - Added Force IRIS button with right alignment
- `js/main.js` - Toggle function, state variable, routing logic, status message

**Use Case**: Compare CDN-cached audio vs live IRIS audio to verify processing pipeline produces identical results.

---

## UI Refinements: Axis Styling System (v1.84)

### Problem
Axis tick labels and visualization borders needed refinement for better readability and cleaner appearance.

### Solution: CSS Meta-Variables for Global Control
Created centralized styling system in `index.html` with CSS custom properties:

```css
:root {
    --axis-label-font-size: 15px;      /* Size of tick labels */
    --axis-label-color: #bbb;          /* Brightness/color of tick label text */
    --axis-tick-color: #666;           /* Color of tick marks (lines) */
}
```

### Implementation Details

**Files Modified**:
- `index.html` - Added CSS meta-variables in style block
- `js/waveform-axis-renderer.js` - Read CSS variables via `getComputedStyle()`
- `js/waveform-x-axis-renderer.js` - Read CSS variables, fixed color reset bug
- `js/spectrogram-axis-renderer.js` - Read CSS variables for consistent styling
- `styles.css` - Updated borders, spacing, shadows

**Visual Changes**:
- Tick labels: 14px to 15px font size, slightly brighter (#aaa → #bbb)
- Waveform/spectrogram: 2px dark borders, removed glow shadows
- Spectrogram: 30px → 40px top margin (more room for ticks)
- Panel: 20px → 50px right padding (more room for y-axis)
- X-axis labels: Moved 2px closer to tick marks

**Bug Fix**: 
X-axis renderer had hardcoded `ctx.fillStyle = '#ddd'` that overrode CSS variable, causing inconsistent brightness. Fixed to use `labelColor` variable.

### Benefits
1. **Single Source of Truth**: Change one CSS variable, updates all axes instantly
2. **Consistent Styling**: All axes (waveform y/x, spectrogram y) use same values
3. **Easy Tweaking**: No need to hunt through multiple JS files
4. **Cleaner Look**: Dark borders without glows, better spacing

---

## Next Steps

1. **CDN Cache Management**: 
   - Investigate why file deletion didn't work in `force_recreate` mode
   - May need to fix deletion logic or manually purge old corrupt chunks

2. **Backfill Automation**:
   - Consider scheduling backfill to run periodically for all active stations
   - Add backfill status endpoint to collector dashboard

3. **Validation**:
   - Test backfilled audio in web interface once CDN cache updates
   - Compare Force IRIS vs CDN audio to confirm identical processing

---

## Qualtrics API Integration (v1.82)

### Implementation
Built complete Qualtrics API integration to automatically capture participant ResponseIDs and submit survey responses.

**Key Features**:
- **Automatic ResponseID Capture**: Parses `ResponseID` parameter from URL when users are redirected from Qualtrics
- **Survey Submission**: All survey responses (Pre-Survey, Post-Survey, AWE-SF) automatically submit to Qualtrics API
- **Participant ID Management**: Stores ResponseID in localStorage, pre-populates participant setup modal
- **Embedded Data**: Includes ResponseID as embedded data field in all API submissions

**Files Created**:
- `js/qualtrics-api.js` - Qualtrics API client with ResponseID parsing and survey submission
- `Qualtrics/REDIRECT_URL.md` - Documentation for Qualtrics redirect URL setup

**Files Modified**:
- `js/ui-controls.js` - Updated survey submission functions to call Qualtrics API
- `js/main.js` - Added URL parameter parsing on page load, updated version to v1.82
- `Qualtrics/fetch_survey_structure.py` - Updated to use new survey ID `SV_bNni117IsBWNZWu`
- `Qualtrics/README.md` - Updated survey ID
- `Qualtrics/survey_structure.json` - Fetched new survey structure with 10 questions

**How It Works**:
1. Qualtrics redirects users with: `https://volcano.now.audio/?ResponseID=${e://Field/ResponseID}`
2. Page automatically detects and stores ResponseID
3. All survey submissions include ResponseID as embedded data
4. Participant setup modal pre-populates with ResponseID from URL

**Question ID Mappings**:
- Pre-session PANAS: QID5 (6 sub-questions)
- Post-session PANAS: QID12 (6 sub-questions)  
- AWE-SF Scale: QID13 (12 items)
- JSON dump: QID11 (for event data)

**Next Steps**:
- Configure `ParticipantID` embedded data field in Qualtrics Survey Flow
- Test end-to-end flow: Qualtrics redirect → site → survey submission

---

## UI Improvements (v1.83)

### Spectrogram Scroll Speed Persistence
Added localStorage persistence for spectrogram scroll speed preference.

**Features**:
- Scroll speed preference saved automatically when changed
- Restored immediately on page load (no visual jump)
- Display text updated synchronously to avoid showing default value first

**Implementation**:
- `loadSpectrogramScrollSpeed()` function loads saved value early in initialization
- Updates slider value and display text immediately before any rendering
- Falls back to default (1.0x) if no saved preference exists

**Files Modified**:
- `js/spectrogram-renderer.js` - Added localStorage save/load with immediate display update
- `js/main.js` - Call `loadSpectrogramScrollSpeed()` early in initialization

### Metrics Panel Repositioning
Moved metrics panel (Time to First Audio, Download Size, Sample Count, Current Position, Playback Duration) to bottom of page.

**Files Modified**:
- `index.html` - Moved metrics panel after Cache Row panel

---

## Qualtrics Embedded Data Migration (v1.84)

### Problem
Text entry fields (like QID11) are NOT reliably returned by the Qualtrics API:
- GET `/surveys/{surveyId}/responses/{responseId}` endpoint doesn't return text entry fields
- JSON exports also don't include text entry fields
- CSV exports may include them, but unreliable

This meant timing/tracking data was being sent successfully but couldn't be retrieved via API.

### Solution: Migrate to Embedded Data Fields
Switched from using QID11 (text entry field) to embedded data fields, which ARE reliably returned by the API.

**New Embedded Data Fields**:
1. **`SessionTracking`** - Timing data for participant sessions (survey start/end, time spent, volcano selection, data fetch events, etc.)
2. **`json_data`** - Future use for all other JSON data (interface interactions, playback controls, etc.)

### Implementation Details

**Code Changes**:
- `js/qualtrics-api.js` - Now sends timing data as `SessionTracking` embedded data field (still sends QID11 for backwards compatibility)
- `Qualtrics/response-viewer.html` - Added Export API support (JSON and CSV formats) with ZIP extraction, parses and displays `SessionTracking` from embedded data
- Added JSZip library for extracting ZIP files from Qualtrics exports

**Documentation Created**:
- `Qualtrics/EMBEDDED_DATA_SETUP.md` - Complete guide for setting up embedded data fields in Qualtrics Survey Flow
- Updated `Qualtrics/README.md` - Added reference to embedded data setup

**Export API Features**:
- JSON export button - Creates export job, polls for completion, extracts ZIP, finds specific response
- CSV export button - Same process but with CSV format (supports `useLabels: true`)
- Both handle Qualtrics' ZIP file format and parse responses correctly

### Status
**Pending**: Leif needs to add both embedded data fields (`SessionTracking` and `json_data`) to Qualtrics Survey Flow.

**Files Modified**:
- `js/qualtrics-api.js` - Embedded data submission logic
- `Qualtrics/response-viewer.html` - Export API support, embedded data parsing
- `Qualtrics/EMBEDDED_DATA_SETUP.md` - New documentation
- `Qualtrics/README.md` - Updated with embedded data info
- `js/main.js` - Version updated to v1.84

**Next Steps**:
1. Leif adds `SessionTracking` and `json_data` embedded data fields to Survey Flow
2. Test new submissions to verify embedded data appears in API responses
3. Remove QID11 dependency once embedded data is confirmed working

---

## Region Tracker Interface (v1.85)

### Implementation
Built `test_interfaces/region_tracker.html` - A waveform region tracker for annotating seismic events with smooth UI animations.

**Key Features**:
- **Waveform time bar** with region selection and highlighting
- **Spectrogram panel** for frequency range selection (box selection)
- **Region cards** with expandable/collapsible feature lists
- **Smooth animations** when expanding/collapsing regions or adding features
- **Multiple simultaneous regions** - each toggles independently

**Technical Highlights**:
- **No DOM destruction** - Toggling one region doesn't re-render others (fixed flash bug)
- **Smooth expansion** - Adding features slides down smoothly without flashing
- **Feature removal** - Instantly removes features (no animation needed)
- **CSS class manipulation** - Direct header/details class updates instead of full re-renders

**Files Created**:
- `test_interfaces/region_tracker.html` (2048 lines) - Complete standalone region tracking interface

**UI Design**:
- Red volcanic gradient background
- Collapsible region cards with play/pause buttons
- Feature rows with type, repetition, frequency selection, and notes
- Visual feedback with highlighted regions on waveform during playback
- Compact design with adjustable feature counts (1-10)

**Commit**: v1.85 Feature: Built region_tracker.html - smooth region toggle/expansion without DOM destruction


