# Gaps Detection and Backfill System

## Overview

System for detecting missing data windows in the seismic data collection pipeline and automatically backfilling them from IRIS.

---

## Endpoints

### 1. Gap Detection: `GET /gaps/<mode>`

**Purpose:** Analyze collected data to find missing time windows across all chunk types.

**Modes:**
- `/gaps/complete` - From first file ever collected to now
- `/gaps/24h` - Last 24 hours
- `/gaps/4h` - Last 4 hours
- `/gaps/1h` - Last 1 hour
- `/gaps/custom?start=<ISO>&end=<ISO>` - Specific time range

**What it checks:**
- Generates expected time windows for each chunk type (10m, 1h, 6h)
- Compares against metadata to find what's missing
- Checks ALL active stations from `stations_config.json`

**Output:**
1. Returns JSON response with gap analysis
2. Saves report to R2: `collector_logs/gap_report_<timestamp>.json`
3. Saves copy as: `collector_logs/gap_report_latest.json` (for easy automation)

**Response format:**
```json
{
  "report_id": "gap_report_2025-11-04T22-45-00Z",
  "generated_at": "2025-11-04T22:45:00Z",
  "mode": "24h",
  "time_range": {
    "start": "2025-11-04T00:00:00Z",
    "end": "2025-11-04T22:45:00Z",
    "hours": 22.75
  },
  "collector_status": {
    "currently_running": false,
    "last_run": "2025-11-04T22:32:01Z"
  },
  "stations": [
    {
      "network": "HV",
      "station": "OBL",
      "location": "--",
      "channel": "HHZ",
      "volcano": "kilauea",
      "gaps": {
        "10m": [
          {
            "start": "2025-11-04T20:30:00Z",
            "end": "2025-11-04T20:40:00Z",
            "duration_minutes": 10
          },
          {
            "start": "2025-11-04T21:10:00Z",
            "end": "2025-11-04T21:20:00Z",
            "duration_minutes": 10
          }
        ],
        "1h": [
          {
            "start": "2025-11-04T21:00:00Z",
            "end": "2025-11-04T22:00:00Z",
            "duration_minutes": 60
          }
        ],
        "6h": []
      },
      "gaps_count": {
        "10m": 2,
        "1h": 1,
        "6h": 0,
        "total": 3
      }
    }
  ],
  "summary": {
    "total_stations": 5,
    "stations_with_gaps": 2,
    "total_gaps": 8,
    "gaps_by_type": {
      "10m": 5,
      "1h": 2,
      "6h": 1
    },
    "total_missing_minutes": 230,
    "recent_windows_excluded": 2
  },
  "saved_to": "collector_logs/gap_report_2025-11-04T22-45-00Z.json"
}
```

**Note:** All timestamps are in UTC using ISO 8601 format. Recent windows (within 3-5 minutes) are excluded from gap detection to account for IRIS delay and active collection.

---

### 2. Backfill: `POST /backfill`

**Purpose:** Fetch missing data from IRIS and fill gaps identified by gap reports.

**Request options:**

#### Option 1: Use latest gap report (ALL stations, ALL gaps)
```json
{
  "use_latest_report": true
}
```

#### Option 2: Use specific gap report
```json
{
  "report_file": "gap_report_2025-11-04-22-45-00.json"
}
```

#### Option 3: Filter by station
```json
{
  "use_latest_report": true,
  "station": "HV.OBL.--.HHZ"
}
```

#### Option 4: Filter by chunk types
```json
{
  "use_latest_report": true,
  "chunk_types": ["10m", "1h"]
}
```

#### Option 5: Combine filters
```json
{
  "use_latest_report": true,
  "station": "HV.OBL.--.HHZ",
  "chunk_types": ["10m"]
}
```

#### Option 6: Manual windows (explicit override)
```json
{
  "station": "HV.OBL.--.HHZ",
  "windows": {
    "10m": [
      {
        "start": "2025-11-04T20:30:00Z",
        "end": "2025-11-04T20:40:00Z"
      }
    ]
  }
}
```

**Default behavior:** `{"use_latest_report": true}` with no filters = backfill EVERYTHING

**Response format:**
```json
{
  "backfill_id": "backfill_2025-11-04T22-50-00Z",
  "started_at": "2025-11-04T22:50:00Z",
  "source": "gap_report_latest.json",
  "filters": {
    "station": null,
    "chunk_types": ["10m", "1h", "6h"]
  },
  "total_windows": 15,
  "progress": {
    "successful": 13,
    "failed": 2,
    "skipped": 0
  },
  "details": [
    {
      "station": "HV.OBL.--.HHZ",
      "chunk_type": "10m",
      "window": {
        "start": "2025-11-04T20:30:00Z",
        "end": "2025-11-04T20:40:00Z"
      },
      "status": "success",
      "samples": 60000,
      "file_size_kb": 234.5,
      "elapsed_seconds": 2.3
    },
    {
      "station": "HV.OBL.--.HHZ",
      "chunk_type": "10m",
      "window": {
        "start": "2025-11-04T21:10:00Z",
        "end": "2025-11-04T21:20:00Z"
      },
      "status": "failed",
      "error": "IRIS timeout after 30s"
    }
  ],
  "summary": {
    "duration_seconds": 45.6,
    "data_fetched_mb": 3.2,
    "files_created": 13,
    "metadata_updated": 5
  }
}
```

---

## Implementation Details

### Gap Detection Algorithm

**For each station:**
1. Get list of dates in time range using `get_dates_in_period(start, end)` helper
   - This automatically handles month/year boundaries
2. For each date, load metadata JSON from R2
   - Path: `data/YYYY/MM/NETWORK/VOLCANO/STATION/LOCATION/CHANNEL/metadata.json`
3. Generate expected windows based on chunk type:
   - **10m chunks**: Every 10 minutes (e.g., 00:00, 00:10, 00:20...)
   - **1h chunks**: Top of every hour (e.g., 00:00, 01:00, 02:00...)
   - **6h chunks**: Every 6 hours (e.g., 00:00, 06:00, 12:00, 18:00)
4. For each expected window:
   - Convert to time-only string: `window.strftime("%H:%M:%S")`
   - Check if exists in `metadata['chunks'][chunk_type]` array (by matching `start` field)
   - If missing AND not too recent (see below), mark as gap
5. Return structured report with full ISO 8601 timestamps

**Time Format Handling:**
- **External API (gap reports):** Full ISO 8601 UTC timestamps (`"2025-11-04T20:30:00Z"`)
- **Internal comparison:** Time-only strings (`"20:30:00"`) to match metadata format
- **Metadata storage:** Time-only (`"start": "20:30:00"`) since metadata is per-day

**Recent Window Exclusion:**
```python
def is_too_recent(window_end, status):
    """
    Exclude recent windows from gap detection.
    Accounts for IRIS delay + processing time + active collection.
    """
    now = datetime.now(timezone.utc)
    
    # If collector is currently running, be more conservative
    if status['currently_running']:
        buffer_minutes = 5
    else:
        buffer_minutes = 3  # IRIS 2-min delay + 1-min processing
    
    return window_end > (now - timedelta(minutes=buffer_minutes))
```

**Edge cases:**
- If no metadata exists for a date, all windows for that date are gaps (except recent ones)
- If station was added mid-period, start from first expected collection time
- Month/year boundaries handled automatically by `get_dates_in_period()`
- Skip windows that are too recent (IRIS delay + active collection)
- Skip future time windows (can't be missing if not scheduled yet)

### Backfill Process

**For each gap window:**
1. Call `process_station_window()` from `cron_job.py` (reuse existing logic!)
   - This function already handles:
     - Duplicate detection (checks metadata before fetching)
     - IRIS fetch with proper error handling
     - Data processing (merge, interpolate gaps, convert to int32)
     - Zstd compression
     - R2 upload with proper folder structure (10m/, 1h/, 6h/)
     - Metadata creation/update with sorted chunks
   - Returns: `('success'|'skipped'|'failed', error_info)`
2. Track status for each window
3. Return comprehensive report

**Deduplication (Built-in):**
- `process_station_window()` checks metadata BEFORE fetching from IRIS
- If chunk with same start time already exists → returns `'skipped'`
- This prevents re-fetching data that's already been backfilled
- Skipped windows are tracked separately in backfill report

**Execution Strategy:**
- Process stations sequentially (simpler, safer)
- Each station processes windows sequentially to avoid metadata conflicts
- Since metadata files are per-day per-station, sequential processing ensures no race conditions
- Future optimization: Parallel stations (but still sequential per-station)

**Error handling:**
- `process_station_window()` already handles exceptions
- On failure, continue to next window (don't abort entire backfill)
- Track detailed error info: step, station, chunk_type, error message
- Return comprehensive report with successes/failures/skips

### File Storage

**Gap reports saved to R2:**
```
collector_logs/
  ├─ gap_report_2025-11-04T22-45-00Z.json
  ├─ gap_report_2025-11-04T23-15-00Z.json
  ├─ gap_report_latest.json  (copy of most recent)
  └─ failures.json  (existing failure log)
```

**Filename format:** `gap_report_{ISO8601_timestamp}.json` where timestamp uses `-` instead of `:` for filesystem compatibility

**Benefits:**
- Audit trail of all gap analyses
- Can compare gap reports over time
- `gap_report_latest.json` enables automation
- Survives Railway deployments

---

## Usage Examples

### Check for gaps in last 24 hours
```bash
curl https://railway.app/gaps/24h
```

### Check complete history
```bash
curl https://railway.app/gaps/complete
```

### Custom time range
```bash
curl "https://railway.app/gaps/custom?start=2025-11-04T00:00:00Z&end=2025-11-04T12:00:00Z"
```

### Backfill all gaps from latest report
```bash
curl -X POST https://railway.app/backfill \
  -H "Content-Type: application/json" \
  -d '{"use_latest_report": true}'
```

### Backfill only 10m chunks for one station
```bash
curl -X POST https://railway.app/backfill \
  -H "Content-Type: application/json" \
  -d '{
    "use_latest_report": true,
    "station": "HV.OBL.--.HHZ",
    "chunk_types": ["10m"]
  }'
```

### Backfill specific windows manually
```bash
curl -X POST https://railway.app/backfill \
  -H "Content-Type: application/json" \
  -d '{
    "station": "HV.OBL.--.HHZ",
    "windows": {
      "10m": [
        {"start": "2025-11-04T20:30:00Z", "end": "2025-11-04T20:40:00Z"}
      ]
    }
  }'
```

---

## Automation Workflow

### Daily gap check and repair
```bash
# 1. Generate gap report for last 24h
curl https://railway.app/gaps/24h

# 2. Review report (optional)
# Download collector_logs/gap_report_latest.json from R2

# 3. Backfill all gaps
curl -X POST https://railway.app/backfill \
  -d '{"use_latest_report": true}'
```

### Scheduled cron job
```bash
# Add to crontab to run daily at 2 AM
0 2 * * * curl -X POST https://railway.app/backfill -d '{"use_latest_report": true}'
```

---

## Integration with Existing System

**Uses existing functions from `collector_loop.py` and `cron_job.py`:**
- ✅ `process_station_window()` - Complete fetch/process/upload pipeline (in `cron_job.py`)
- ✅ `load_active_stations()` - Load station config (in `cron_job.py`)
- ✅ `get_dates_in_period(start, end)` - Date iteration with automatic boundary handling (in `collector_loop.py`)
- ✅ `get_s3_client()` - R2 client creation (in `collector_loop.py`)
- ✅ R2 upload and metadata logic (built into `process_station_window()`)

**New helper functions needed in `collector_loop.py`:**
- `generate_expected_windows(date, chunk_type)` - Create expected time windows for a date
- `load_gap_report(report_file)` - Load gap report from R2
- `save_gap_report(report_data)` - Save gap report to R2 (with latest.json copy)
- `filter_gaps(report, station, chunk_types)` - Apply filters to gaps from report
- `is_too_recent(window_end, status)` - Check if window should be excluded

**No breaking changes** - All existing endpoints continue to work.

---

## Testing Plan

1. **Unit tests:**
   - Test window generation for each chunk type (10m, 1h, 6h)
   - Test gap detection with known missing windows
   - Test filter logic for backfill options
   - Test `is_too_recent()` with various buffer times
   - Test time format conversion (full ISO ↔ time-only)

2. **Integration tests:**
   - Generate gap report for test period
   - Verify report saved to R2 with correct timestamps
   - Verify `gap_report_latest.json` is updated
   - Backfill gaps and verify data uploaded
   - Verify metadata updated correctly with sorted chunks
   - Test deduplication (backfill same gap twice → skipped second time)

3. **Edge case tests:**
   - **Month boundaries:** Gap detection across Nov/Dec
   - **Year boundaries:** Gap detection across 2025/2026
   - **Recent windows:** Gaps within 3-5 minutes of "now" (should be excluded)
   - **Currently running:** Detection while `status['currently_running'] == True`
   - **No metadata:** Station with no metadata file (all windows are gaps)
   - **Concurrent backfill:** Same-day windows backfilled sequentially

4. **End-to-end test:**
   - Delete some test files from R2 (mix of 10m, 1h, 6h)
   - Run `/gaps/24h` - should detect missing files
   - Verify recent windows NOT flagged as gaps
   - Run `/backfill` - should re-fetch from IRIS
   - Verify data restored correctly
   - Run `/gaps/24h` again - should show no gaps (or only skipped ones)

---

## Future Enhancements

- **Automatic gap detection**: Cron job runs `/gaps/24h` daily
- **Automatic backfill**: If gaps < 10, auto-backfill
- **Gap alerts**: Send notification if gaps exceed threshold
- **Gap trends**: Track gap count over time
- **Priority backfill**: Fill recent gaps first
- **Partial window handling**: Handle gaps smaller than full chunks

---

## Implementation Notes

### Key Technical Details

1. **Time Format Handling:**
   - API accepts/returns: Full ISO 8601 UTC (`"2025-11-04T20:30:00Z"`)
   - Metadata stores: Time-only strings (`"20:30:00"`)
   - Comparison: Extract time component for matching against metadata
   
2. **IRIS Delay Buffer:**
   - Standard: 3 minutes (2-min IRIS delay + 1-min processing)
   - During collection: 5 minutes (extra buffer for active run)
   - Check `status['currently_running']` to adjust buffer

3. **Metadata File Structure:**
   - One JSON file per station per day
   - Path: `data/YYYY/MM/NETWORK/VOLCANO/STATION/LOCATION/CHANNEL/{metadata}.json`
   - Sequential writes within same file prevent race conditions

4. **Deduplication Strategy:**
   - Gap detection: Compare expected vs actual from metadata
   - Backfill: `process_station_window()` checks before fetching
   - Result: Safe to run backfill multiple times (idempotent)

5. **Date Boundary Handling:**
   - Use existing `get_dates_in_period()` helper
   - Automatically handles month/year transitions
   - Each date gets separate metadata file load

---

## Status

**Implementation:** Not yet implemented  
**Next step:** Build `/gaps/<mode>` endpoint first, then `/backfill`  
**Estimated effort:** 
- Gap detection endpoint: 3-4 hours
- Backfill endpoint: 2-3 hours  
- Testing & edge cases: 2-3 hours
- **Total:** 7-10 hours

