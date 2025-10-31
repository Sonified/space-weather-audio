# Captain's Log - October 30, 2025

## Architecture Documentation Updates

Updated `docs/FULL_cache_architecture_w_LOCAL_DB.md` with key architectural decisions:

### Changes Made:

1. **Self-Describing Filenames with Sample Rate**
   - Format: `{NETWORK}_{STATION}_{LOCATION}_{CHANNEL}_{SAMPLE_RATE}Hz_{START}_to_{END}.bin.zst`
   - Example: `HV_NPOC_01_HHZ_100Hz_2025-10-24-00-00-00_to_2025-10-24-01-00-00.bin.zst`
   - Supports fractional sample rates (e.g., `40.96Hz`)
   - Filenames now contain ALL metadata needed for identification
   - Perfect for IndexedDB keys (no need for full path)

2. **Phased Metadata Format**
   - **Phase 1 (Current)**: Single metadata file with per-chunk gap summaries (~8-15 KB)
   - **Phase 2 (Future)**: Split gap details into separate `*_gaps.json` file (lazy-loaded)
   - Keeps main metadata small while preserving detailed gap audit trail option

3. **Implementation Priorities**
   - **Priority 1**: Update Render backend to write correct metadata format
   - **Priority 2**: Implement metadata flow through R2 Worker and Browser
   - **Priority 3**: Implement IndexedDB local cache layer
   - Pins for future testing/decisions kept minimal (no premature architecture decisions)

### Version
v1.20 - Commit: "v1.20 Docs: Updated cache architecture with self-describing filenames (includes sample rate), phased metadata format, and implementation priorities"

---

## Backend V2 Implementation Complete

Created complete metadata-aware backend with intelligent caching system:

### Backend V2 (`backend/main_v2.py`) - Runs on Port 5002:

1. **Metadata-Aware Request Flow**
   - Accepts `existing_metadata` from R2 Worker
   - Parses cached chunks to avoid redundant IRIS fetches
   - Only fetches missing time ranges (smart gap detection)
   - Intelligently merges new chunks into existing metadata

2. **Self-Describing Filenames**
   - Format: `NETWORK_STATION_LOCATION_CHANNEL_RATEHz_START_to_END.bin.zst`
   - All metadata embedded in filename for unambiguous identification
   - Supports fractional sample rates (e.g., `40.96Hz`)

3. **Advanced Data Processing**
   - Gap detection BEFORE merging (tracks per-chunk gap statistics)
   - Second-boundary rounding for clean concatenation
   - Linear interpolation for gap filling
   - Per-chunk metadata: `min`, `max`, `samples`, `gap_count`, `gap_duration_seconds`, `gap_samples_filled`

4. **Partial Chunk Detection**
   - `partial` flag for incomplete chunks (common at leading edge of live data)
   - Compares actual samples vs expected samples (99% threshold)
   - Critical for client-side handling of live data

5. **Progressive Chunking Strategy** (1min/6min/30min for testing)
   - Priority 1: 6 × 1-minute chunks (0-6 min) - Fastest playback start
   - Priority 2: 4 × 6-minute chunks (6-30 min)
   - Priority 3: 1 × 30-minute chunk (remaining)
   - Each chunk uploaded immediately with presigned URL via SSE

6. **Metadata Management**
   - Chronological sorting of all chunks
   - Deduplication (no duplicate start times)
   - Complete metadata rewrite to R2 after all chunks processed

7. **SSE Events** for Dashboard Integration:
   - `metadata_parsed` - Shows existing chunks and missing ranges
   - `gap_detection` - Reports gap count before merging
   - `rounding` - Confirms second-boundary alignment
   - `metadata_cleanup` - Sorting/deduplication step
   - `metadata_uploaded` - Final save to R2

8. **All V1 Features Migrated**:
   - `load_volcano_stations()` - Station filtering with MAX_RADIUS_KM
   - `/api/stations/<volcano>` - Returns available stations
   - `/api/test/<volcano>` - Quick data availability check
   - Configuration constants (MAX_RADIUS_KM, LOCATION_FALLBACKS)

### Dashboard Updates (`pipeline_dashboard.html`):

1. **Backend Version Selector**
   - Dropdown defaulting to v2 ⭐
   - v1 → `http://localhost:5001/api/request-stream`
   - v2 → `http://localhost:5002/api/request-stream-v2`
   - Automatic port/endpoint switching

2. **New V2-Specific Events**:
   - R2: "📋 Existing metadata sent to Render"
   - Render: "📋 Cache metadata parsed" (logs missing ranges)
   - Render: "🔍 MiniSEED metadata parsed" (clarified from generic "metadata")
   - Render: "🔍 Gaps detected before merging"
   - Render: "⏱️ Rounded to second boundaries"
   - Render: "🔗 Chunk URLs sent to Browser" (clarified from "sent to R2")
   - Render: "🧹 Metadata sorted & deduplicated"
   - Render: "📊 Metadata updated and saved to R2"

3. **Layout Update**:
   - Time Log moved to left side (under Browser and R2)
   - Render box now spans full height for all new steps
   - Improved visual organization

### Architecture Documentation:
- Updated `docs/FULL_cache_architecture_w_LOCAL_DB.md` with complete metadata format spec

### Version
v1.21 - Commit: "v1.21 Feature: Backend v2 with metadata-aware architecture, progressive chunking, gap detection, partial chunk flags, and dashboard v2 selector"

---

## EXPLORATORY: SeedLink Dashboard

Created experimental real-time SeedLink audification dashboard and backend:

### New Dashboard (`SeedLink/dashboard.html`):

1. **Update Interval Tracking**
   - Renamed "Packet Timing" → "Data Update Intervals" (measures actual user experience)
   - Tracks intervals between data arrivals (client-side timing)
   - Skips initial page-load-to-first-packet time (doesn't count as interval)
   - Shows average, min/max, and last 5 intervals
   - More accurate than backend packet-level tracking

2. **Dashboard Controls**
   - **Reset Stats Button** (lower left of Connection Status card)
     - Clears all statistics: packet counts, buffers, timing data
     - Keeps streaming active, just resets counters
   - **Stop Backend Button** (lower left of Signal Processing card)
     - Shuts down audio stream and SeedLink connection
     - Exits the Flask server process cleanly
     - Server must be restarted manually after stopping

3. **UI Improvements**
   - Renamed "Total Samples RX" → "Total Samples Received" (clearer)
   - Better visual feedback for button actions
   - Improved status indicators

### New Backend (`SeedLink/live_audifier.py`):

1. **New API Endpoints**
   - `/api/reset` (POST) - Resets all statistics and buffers
   - `/api/stop` (POST) - Stops audio stream and exits process

2. **Reset Functionality**
   - Clears packet counts, buffers, timing data
   - Resets playback position to 0
   - Keeps streaming connection active

3. **Stop Functionality**
   - Stops audio stream cleanly
   - Closes SeedLink connection
   - Exits process after short delay (allows response to be sent)

### Launch Script (`SeedLink/launch.sh`):

Created launch script matching `boot_local_mode.sh` pattern:
- Cleans up existing processes first
- Starts backend in background
- Polls port with `lsof` (no blind sleeping)
- Confirms service is actually running
- Shows troubleshooting info if it fails
- Logs to `/tmp/seedlink_audifier.log`

### Documentation (`SeedLink/README.md`):

- Updated with launch script instructions
- Documented all dashboard features and controls
- Added log viewing section
- Enhanced troubleshooting guide

### Version
v1.22 - Commit: "v1.22 Feature: Experimental SeedLink real-time audification dashboard with update interval tracking, reset/stop controls, and launch script"

