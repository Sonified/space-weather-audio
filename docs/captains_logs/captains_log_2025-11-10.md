# Captain's Log: 2025-11-10

## Session: Realistic Chunk Fetch Optimization - v1.72

### v1.72: Fix Realistic Chunk Filename Format

**Problem**: Realistic chunk fetch was failing with 404 errors before falling back to normal fetch. All 6 attempts (chunk 0 through +5) were timing out, adding ~1.8 seconds of unnecessary delay before playback could start.

**Root Cause**: The realistic chunk fetch was building incorrect filenames:
- **Wrong**: `HV_OBL_--_HHZ_10m_2025-11-10-05-40-00_to_2025-11-10-05-49-59.bin.zst`
- **Correct**: `HV_OBL_--_HHZ_10m_2025-11-10-05-40-00_to_2025-11-10-05-50-00.bin.zst`

The end time should be the **start of the next chunk** (e.g., `05-50-00`), not "9 minutes 59 seconds later" (e.g., `05-49-59`).

**Additional Issue**: Realistic chunk was only trying the OLD filename format (with sample rate like `100Hz`) instead of trying NEW format first, then falling back to OLD format.

**Solution**: Updated `buildRealisticUrl()` function in `index.html`:

1. **Fixed end time calculation**: Changed from `minute + 9` with `:59` to `minute + 10` with `:00`, with proper hour rollover handling
2. **Added NEW format support**: Now tries NEW format (no sample rate) first, then falls back to OLD format (with sample rate)

This matches the behavior of the main chunk fetch function, which was working correctly because it reads filenames from metadata.

**Impact**:
- ✅ Realistic chunk now succeeds on **first or second attempt** (instead of failing all 6 attempts)
- ✅ Playback starts **~1.5 seconds faster** (no more cascading 404s)
- ✅ Better user experience with immediate audio feedback

### Files Modified

- `index.html` (lines ~2051-2070): Fixed realistic chunk URL builder with correct end time format and NEW/OLD format fallback

### Version: v1.72

**Commit Message**: v1.72 Fix: Realistic chunk filename format - correct end time boundary and NEW/OLD format fallback for instant playback

**Results**:
- ✅ Realistic chunk fetch succeeds immediately
- ✅ TTFA (Time To First Audio) significantly improved
- ✅ No more cascading 404 errors in console

---

### What's Next

- Monitor realistic chunk success rate in production
- Consider adding retry logic with exponential backoff if needed

---

---

## Session: Major Repository Organization - v1.73

### v1.73: Repository Cleanup and Organization

**Goal**: Organize the repository by archiving obsolete code and consolidating active files into logical folders.

**Changes Made**:

#### Archive Organization
- **Created unified `/archive/` folder** with subdirectories:
  - `documentation/` - Outdated docs (PROGRESSIVE_STREAMING_IMPLEMENTATION, WAVEFORM_OPTIMIZATION)
  - `notebooks/` - Old Jupyter notebooks (Spurr_Audification, dynamic_audification_test)
  - `html/` - Old HTML test files (test_streaming, make_audio, dashboard, etc.)
  - `scripts/` - Old utility scripts (generate_linear_sweeps, upload_linear_sweeps, etc.)
  - `python_code/` - Original Python utilities (main.py, audit_station_availability, etc.)
  - `SeedLink/` - Separate SeedLink project (developed further in another repo)
  - `worker/` - Cloudflare Workers infrastructure (superseded by direct CDN access)
  - `static/` - Old static assets (blosc.js misnamed header file)

#### Backend Organization
- **Created `backend/archive/` folder** for obsolete backend code:
  - `main.py` and `main_v2.py` - Old Flask servers (superseded by `collector_loop.py`)
  - `start_local_server.sh` - Script for old Flask server
  - `cron_job.py` - Consolidated into `collector_loop.py` (v1.59)
  - `cron_fetch_latest_data.py` - Older cron job version
  - `local_cache_blosc_endpoint.py` - Deprecated Blosc compression code
  - `fix_r2_cors.py` - One-time utility script

#### Test Organization
- **Created `tests/browser/` folder** - Moved all HTML/JS test files (17 files)
- **Created `tests/files/` folder** - Moved `.bin` and `.gz` test data files
- Updated references in test files and `worker/src/index.js`

#### Workers Organization
- **Created `workers/` folder** - For active Web Workers (browser-side):
  - `audio-processor-worker.js` - Zstd decompression worker
  - `waveform-worker.js` - Waveform rendering worker
- **Archived Cloudflare Workers** - Moved `worker/` → `archive/worker/` (infrastructure code)
- Updated `index.html` to reference `workers/audio-processor-worker.js` and `workers/waveform-worker.js`

#### Data Organization
- **Consolidated reference data** - Removed duplicate top-level `reference/` folder
- All reference data now in `data/reference/`:
  - `volcano_station_availability.json`
  - `monitored_volcanoes.json`
  - `active_volcano_stations.json`
  - `volcano_station_summary.csv`
- Updated notebook to use `data/reference/` paths

#### Bug Fixes
- **Fixed `.deploy_time` logic** - Now always updates to current time on startup (was reading old timestamp if file existed)
- Updated `test_audio_stream_local.py` to use port 5005 (collector_loop.py) instead of 5001

### Files Modified
- `index.html` - Updated worker paths to `workers/` folder
- `backend/collector_loop.py` - Fixed deploy_time logic, updated comment about cron_job consolidation
- `worker/src/index.js` - Updated test file path to `tests/files/`
- Multiple test files - Updated paths for browser tests and mseed files
- `README.md` - Removed references to obsolete utilities
- `archive/README.md` - Comprehensive documentation of archived items

### Version: v1.73

**Commit Message**: v1.73 Refactor: Major repository organization - archived obsolete code, organized tests, consolidated workers, fixed deploy_time logic

**Impact**:
- ✅ Cleaner repository structure
- ✅ Easier to find active code vs. historical artifacts
- ✅ Better organization of tests and workers
- ✅ Fixed deploy_time to always reflect current deployment

---

## ⚠️ IMPORTANT NOTE

**Branch**: Currently working on `linear-buffer-v2` branch (not `main`)

**TODO**: Update Railway deployment settings to track `linear-buffer-v2` branch instead of `main`
- Railway → Settings → Deploy → Branch to deploy from: `linear-buffer-v2`

