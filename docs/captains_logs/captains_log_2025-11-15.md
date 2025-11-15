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

