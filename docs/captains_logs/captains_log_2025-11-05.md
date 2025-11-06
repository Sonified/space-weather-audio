# Captain's Log - November 5, 2025

## Added Adaptive Anti-Aliasing Filter (v1.59)

**Version:** v1.59  
**Commit:** v1.59 Feature: Added adaptive anti-aliasing filter for smooth slow-motion playback

### Feature:
Implemented adaptive anti-aliasing low-pass filter in the AudioWorklet to prevent harsh artifacts when slowing down playback.

### How It Works:
- **Filter cutoff automatically adjusts** based on playback speed
- Formula: `cutoff = 22050 Hz × playback_speed`
- At 1.0x speed: 22,050 Hz cutoff (no filtering - above human hearing)
- At 0.5x speed: 11,025 Hz cutoff (filters out half the frequencies)
- At 0.1x speed: 2,205 Hz cutoff (aggressive filtering for very slow playback)

### Implementation:
- **Biquad Butterworth 2nd-order low-pass filter** in AudioWorklet
- Only activates when `speed < 1.0` (no overhead at normal/fast speeds)
- Updates filter coefficients dynamically as speed changes
- Very efficient: 6 multiply-adds per sample

### UI Changes:
- Hidden anti-aliasing toggle button (enabled by default)
- Hidden high-pass filter dropdown (still works in background)
- Cleaner interface focused on essential controls

### Impact:
- ✅ Smooth, clean audio when slowing down playback
- ✅ Eliminates harsh "digital" artifacts from linear interpolation
- ✅ Automatic - no user configuration needed
- ✅ Minimal CPU overhead (only runs when slowing down)

### Files Modified:
- `index.html` - Added biquad filter to AudioWorklet, hidden controls

---

## Fixed boto3 Import Issue in Status Endpoint (v1.58)

**Version:** v1.58  
**Commit:** v1.58 Fix: Move boto3 import to top level to fix /status endpoint crash

### Problem:
The `/status` endpoint was returning 500 Internal Server Error because boto3 was imported inside the function instead of at the module level. When the endpoint tried to import boto3, it hit a permission error with botocore's CRT (Common Runtime) extensions in the sandbox environment, causing the entire endpoint to crash.

### Solution:
- Moved `import boto3` from inside functions to the top of `collector_loop.py` (line 14)
- Removed duplicate `import boto3` statements from inside functions:
  - `get_s3_client()` (line 41)
  - `/status` endpoint (line 1408)
  - `/nuke` endpoint (line 3021)
- boto3 now imports once at module load time, avoiding repeated import attempts

### Additional Improvements:
- **Improved `start_local_collector.sh`:**
  - Added proper wait loop with 10-second timeout for port to be released
  - Shows progress: "Still waiting... (Xs)"
  - Verifies port is actually free before starting
  - Prevents race conditions where port wasn't released yet

- **Added workspace rule:** `script-running-with-permissions.mdc`
  - Documents that boto3 scripts need `required_permissions: ['all']`
  - Prevents future sandbox permission issues

### Files Modified:
- `backend/collector_loop.py` - Moved boto3 import to top level
- `backend/start_local_collector.sh` - Added port wait loop with timeout
- `.cursor/rules/script-running-with-permissions.mdc` - New rule for boto3 permissions

### Impact:
- ✅ `/status` endpoint now works correctly
- ✅ Can monitor collection progress and R2 storage stats
- ✅ No more 500 errors when querying status
- ✅ Better process cleanup prevents zombie collectors

### Debugging Journey:
- Discovered 14 zombie collector processes running simultaneously (oops!)
- Found that clicking too fast in R2 dashboard triggers rate limits (not our code!)
- Created diagnostic script to test boto3 components
- Identified that boto3 import fails in sandbox but works with full permissions

---

## Critical Bug Fixes: Day-Level Folders + Deduplication (v1.57)

**Version:** v1.57  
**Commit:** v1.57 Fix: Added day-level folder structure and fixed deduplication race condition

### Problems Discovered:

**Bug #1: Deduplication Race Condition**
- The deduplication check happened BEFORE uploading the binary file (line 156-164)
- Then metadata was loaded AGAIN from R2 (line 257)
- Then blindly appended without re-checking (line 291)
- Result: Multiple processes could pass the first check, then both append duplicates
- Evidence: Metadata files had 2-4x duplicate entries for the same timestamps

**Bug #2: No Day-Level Folder Structure**
- All files for a month went into same folder: `data/2025/11/HV/...`
- After 30 days: 30+ metadata files in one folder
- Hard to browse by day, inefficient R2 listings
- No logical day-level organization

**Bug #3 (False Alarm):** 
- Initially thought chunks spanning midnight were assigned to wrong day
- Actually CORRECT behavior: chunk from 18:00-00:00 belongs to the START day
- No fix needed - the original analysis in CRITICAL_BUGS.md was wrong

### Solutions Applied:

**Fix #1: Deduplication Check After Metadata Load**
- Added second deduplication check AFTER loading fresh metadata (line 293-300)
- Prevents race conditions where multiple processes pass the first check
- Now checks again right before appending to metadata
- Logs "race condition detected" if duplicate found at append time

**Fix #2: Day-Level Folder Structure**
- Changed from: `data/{year}/{month}/{network}/...`
- Changed to: `data/{year}/{month}/{day}/{network}/...`
- Example: `data/2025/11/05/HV/kilauea/OBL/--/HHZ/`
- Each day gets its own folder with its own metadata file
- Clean separation of data by day

### Files Modified:
- `backend/cron_job.py` - Added day folder to paths (lines 148, 235, 244)
- `backend/cron_job.py` - Added deduplication check after metadata load (lines 293-300)
- `backend/collector_loop.py` - Updated 4 locations with day-level paths (lines 660, 2396, 2654, 2943)
- `backend/CRITICAL_BUGS.md` - Updated with correct analysis

### Data Reset:
- Nuked all existing R2 data (757 objects deleted)
- Started fresh with correct folder structure
- No more duplicates, clean day-level organization

### Impact:
- ✅ No more duplicate metadata entries
- ✅ Clean day-level folder organization
- ✅ Easier to browse data by specific date
- ✅ More efficient R2 listings
- ✅ Proper handling of concurrent collection processes

---

## Fixed Status Calculation for New Stations (v1.55)

**Version:** v1.55  
**Commit:** v1.55 Fix: Status calculation now uses per-station earliest timestamps instead of global start time

### Problem:
After adding new Shishaldin stations (SSLS, SSLN), the status endpoint was calculating expected files based on when the FIRST station started collecting, not when each individual station started. This caused it to think the new stations should have files going back to the beginning of time.

### Solution:
- Modified `/status` endpoint to track earliest file timestamp **per station**
- Expected file counts are now calculated **per station** based on each station's individual start time
- New stations that just started collecting won't be expected to have historical files
- Status calculation properly handles stations added at different times

### Changes:
- Added `station_earliest_timestamps` dictionary to track when each station first started collecting
- Changed expected file calculation from global (total files / total stations) to per-station (sum of each station's expected files based on its start time)
- Each station's expected files = cycles since that station's first file × files per cycle

### Impact:
- Status endpoint now correctly reports expected vs actual files when stations are added dynamically
- No more false "MISSING" alerts for new stations that just started collecting
- System properly adapts to adding/removing stations over time

---

## Added Shishaldin Stations to Collection (v1.54)

**Version:** v1.54  
**Commit:** v1.54 Feature: Added closest 2 Shishaldin stations (SSLS, SSLN) to active collection set

### Changes:
- Activated SSLS station (5.4 km from Shishaldin) in `backend/stations_config.json`
- Activated SSLN station (6.5 km from Shishaldin) in `backend/stations_config.json`
- These are the two closest stations to Shishaldin volcano

### Impact:
- Collector will now start collecting data from these two Shishaldin stations
- Data will be available for audio generation and analysis

---

## Package Cleanup and Function Audit (v1.53)

**Version:** v1.53  
**Commit:** v1.53 Refactor: Removed deprecated packages (xarray, zarr, numcodecs, s3fs) and broken imports, created function audit

### Major Cleanup:

**Packages Removed from `backend/requirements.txt`:**
- ❌ `xarray>=2023.10.0` - Only used by deprecated `/api/zarr` endpoint
- ❌ `zarr>=2.16.0` - Only used by deprecated zarr endpoints
- ❌ `numcodecs>=0.11.0` - Only used by deprecated compression experiments
- ❌ `s3fs>=2023.10.0` - Not used anywhere in production

**Broken Imports Removed from `backend/main.py`:**
- Removed `import xarray as xr`
- Removed `import zarr`
- Removed `from numcodecs import Blosc, Zstd, Zlib`

### Function Audit Created:

**File:** `backend/FUNCTION_AUDIT.md`

Comprehensive audit of all functions and endpoints in `backend/main.py`:
- **13 items to DELETE** (850+ lines of dead code)
  - 5 helper functions (old cache system, zarr-specific)
  - 8 unused endpoints (including broken `/api/zarr`)
- **7 items to KEEP**
  - 2 core functions (CORS, config loading)
  - 1 health check
  - 2 production endpoints used by R2 Worker
  - Audio streaming blueprint

### Production Verification:

✅ **Confirmed working paths:**
- `index.html` → `/api/stream-audio` (in `audio_stream.py`)
- R2 Worker → `/api/request` and `/api/request-stream` (in `main.py`)
- Collector → R2 via boto3 (in `collector_loop.py`)

All use **only** the packages we kept: flask, numpy, scipy, obspy, zstandard, boto3, requests, pytz

### Discovery:

While auditing, discovered architectural questions about R2 Worker necessity:
- Collector already uploads everything to R2 with perfect metadata
- R2 authentication prevents direct browser access
- Options: Make R2 public, use presigned URLs, or keep Worker proxy
- **Deferred for future architectural review**

### Next Steps:
1. Push cleanup changes (this commit)
2. After breakfast: Decide on R2 access architecture
3. Delete 13 unused functions/endpoints (~850 lines, 59% reduction)

---

## Version Unification and Railway Crash Fix (v1.52)

**Version:** v1.52  
**Commit:** v1.52 Fix: Removed test endpoint import causing Railway crash, unified all versions to v1.52

### Problem:
Railway backend (`volcano-audio-production.up.railway.app`) was crash-looping with:
```
ModuleNotFoundError: No module named 'progressive_test_endpoint'
```

### Root Cause:
- `backend/main.py` line 844-845 was importing a test endpoint from `backend/tests/`
- Railway couldn't find it because test files aren't in the production Python path
- This broke the main backend that powers `index.html`

### Fix Applied:
1. **Removed Test Import from Production Code**
   - Removed `from progressive_test_endpoint import create_progressive_test_endpoint`
   - Removed `app = create_progressive_test_endpoint(app)`
   - Added comment explaining test endpoint is in `backend/tests/` folder

2. **Version Number Unification**
   - Found inconsistent versions across codebase:
     - `python_code/__init__.py`: v1.51 ✓ (highest)
     - `backend/collector_loop.py`: v1.14 (outdated)
     - Various docs: mixed versions
   - Unified all to v1.52 (incremented from v1.51)

### Files Modified:
- `backend/main.py` - Removed test endpoint import
- `python_code/__init__.py` - Updated to v1.52
- `backend/collector_loop.py` - Updated to v1.52
- `backend/README_MACHINE_READABLE.md` - Updated example version, added comment

### Testing Note:
- `/api/progressive-test` endpoint was test-only, not used by production
- `index.html` uses `/api/stream-audio` (unaffected)
- Test endpoint still available by running `backend/tests/progressive_test_endpoint.py` separately

---

## Smart Gap Detection Testing (v1.51)

### Accomplishments:

1. **Created Comprehensive Test Suite**
   - File: `backend/tests/test_smart_gap_detection.py`
   - 7 test cases covering all edge cases
   - All tests passed ✅

2. **Test Coverage:**
   - Window before completion (should check)
   - Window after completion (should exclude)
   - Exact boundary case
   - First run with no completion yet
   - Realistic collection cycle
   - Parse error handling
   - Multi-day scenarios

3. **Documentation Created**
   - File: `backend/backend_docs/smart_gap_detection_analysis.md`
   - Explains why timestamp-based approach is smarter than arbitrary buffers
   - Provides real-world examples
   - Documents all edge cases

### Key Insight:
The new `is_window_being_collected()` function uses **actual collection completion timestamps** instead of arbitrary time buffers. This makes gap detection:
- More accurate (uses real system state)
- More reliable (no guessing)
- More maintainable (clearer logic)
- More flexible (adapts automatically to collection duration)

**Old approach:** "Exclude windows within 3-5 minutes" (arbitrary guessing)  
**New approach:** "Exclude windows ending after last_run_completed" (precise timing)

### Status:
✅ All tests passing  
✅ Production-ready  
✅ Documentation complete

---

## Next Steps:
1. Monitor Railway backend recovery after push
2. Confirm `index.html` works correctly with fixed backend
3. Continue monitoring data collector health

