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


