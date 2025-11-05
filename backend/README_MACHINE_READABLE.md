# Backend API Reference - Machine Readable

**Service:** Volcano Audio Data Collector & API  
**Deployment:** Railway (auto-deploy from `main`)  
**Production URL:** https://volcano-audio-collector-production.up.railway.app

---

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

cd backend

# Start local Flask API server (main.py)
./start_local_server.sh  # Port 5001

# Start data collector with status endpoint (collector_loop.py)
./start_local_collector.sh  # Port 5005

# Run tests
python test_cron_simulation.py
python test_audio_stream_local.py
```

**Note:** Port 5000 is blocked by macOS AirPlay, so collector runs on 5005 locally (production uses 5000)

---

## API Endpoints

### Health & Status

#### GET /health
**Purpose:** Simple health check  
**Response:**
```json
{
  "status": "healthy",
  "uptime_seconds": 1234.5
}
```

#### GET /status
**Purpose:** Detailed system status with collection metrics  
**Response:**
```json
{
  "version": "2025_11_05_v1.51",  // Example only - do not update
  "currently_running": false,
  "deployed_at": "2025-11-05T04:54:44.726511+00:00",
  "failed_runs": 0,
  "last_failure": null,
  "recent_failures": [],
  "last_run": "2025-11-05T05:32:01.116769+00:00",
  "next_run": "2025-11-05T05:42:00.116789+00:00",
  "collection_stats": {
    "active_stations": 5,
    "stations_with_files": 5,
    "missing_stations": null,
    "collection_cycles": 10,
    "coverage_depth": {
      "full_coverage": "0h (need 6h files)",
      "by_type": {
        "10m": "1h 40m",
        "1h": "2h",
        "6h": "0h"
      }
    },
    "files_per_station": {
      "10m": {
        "avg": 10.0,
        "is_uniform": true
      },
      "1h": {
        "avg": 2.0,
        "is_uniform": true
      },
      "6h": {
        "avg": 0.0,
        "is_uniform": true
      }
    },
    "expected_vs_actual": {
      "10m": {
        "actual": 50,
        "expected": 50,
        "status": "PERFECT"
      },
      "1h": {
        "actual": 10,
        "expected": 5,
        "status": "OK"
      },
      "6h": {
        "actual": 0,
        "expected": 0,
        "status": "PERFECT"
      },
      "overall": "PERFECT"
    }
  },
  "r2_storage": {
    "total_files": 60,
    "file_counts": {
      "10m": 50,
      "1h": 10,
      "6h": 0,
      "metadata": 5,
      "other": 0
    },
    "total_size_mb": 9.51,
    "total_size_gb": 0.009,
    "latest_file": "2025-11-05T05:32:11.738000+00:00"
  },
  "started_at": "2025-11-05T04:54:44.729596+00:00",
  "total_runs": 10,
  "successful_runs": 9
}
```

**Status Values:**
- `PERFECT`: Exact match, uniform distribution, all stations
- `RUNNING`: Collection in progress, files being created
- `OK`: Count matches or exceeds expected
- `MISSING`: Files missing or non-uniform
- `INCOMPLETE`: Below expected count

**Failure Tracking:**
- `last_failure`: Most recent failure info (null if no failures)
  - `timestamp`: ISO 8601 timestamp of failure
  - `error`: Error message (up to 500 chars)
  - `exit_code`: Process exit code (null for exceptions)
  - `type`: `"subprocess_failure"` or `"exception"`
- `recent_failures`: Array of last 10 failures (most recent last), same structure as `last_failure`
- **Persistence**: Failures are saved to R2 at `collector_logs/failures.json` (survives deployments, keeps all failures forever)

#### GET /stations
**Purpose:** List active stations being collected  
**Response:**
```json
{
  "total": 5,
  "stations": [
    {
      "network": "HV",
      "volcano": "kilauea",
      "station": "OBL",
      "location": "",
      "channel": "HHZ",
      "sample_rate": 100.0
    }
  ]
}
```

#### GET /test/failure
**Purpose:** Simulate a failure to test tracking system  
**Response:**
```json
{
  "success": true,
  "message": "Test failure recorded",
  "failure": {
    "timestamp": "2025-11-05T06:00:00Z",
    "error": "TEST FAILURE: Simulated error for testing (random=1234)",
    "exit_code": 99,
    "type": "test_simulation"
  },
  "note": "Check /status to see the failure appear, or download collector_logs/failures.json from R2"
}
```
**Usage:** Call this endpoint to inject a test failure and verify the tracking/persistence system works

---

### Data Validation

#### GET /validate/<period>
**Purpose:** Validate data integrity for a time period  
**Parameters:**
- `period`: `24h`, `2d`, `1h`, etc.  

**Response:**
```json
{
  "period_hours": 24,
  "days_checked": 1,
  "validation_time": "2025-11-05T05:00:00Z",
  "health": {
    "status": "HEALTHY",
    "icon": "✅",
    "message": "All stations validated successfully - no missing files, orphans, or duplicates",
    "stations_checked": 5,
    "stations_ok": 5,
    "stations_with_issues": 0
  },
  "summary": {
    "missing_files": 0,
    "orphaned_files": 0,
    "total_missing": 0,
    "total_orphaned": 0,
    "total_duplicates": 0
  },
  "stations": [{
    "duplicates_found": {
      "10m": 0,
      "1h": 0,
      "6h": 0
    }
  }]
}
```

**New in v1.10:** Now detects duplicate metadata entries (same start time appearing multiple times)

#### GET /validate/<period>/report
**Purpose:** Human-readable text report  
**Response:** Plain text summary including duplicate count

#### GET /deduplicate/<period>
**Purpose:** Remove duplicate metadata entries  
**Parameters:**
- `period`: `24h`, `2d`, `1h`, etc.

**Response:**
```json
{
  "period_hours": 24,
  "deduplicate_time": "2025-11-05T06:00:00Z",
  "total_duplicates_removed": 0,
  "stations_cleaned": 0,
  "message": "✅ No duplicates found - metadata is clean!",
  "details": []
}
```

**Usage:** Cleans up duplicate entries in metadata (keeps first occurrence, removes rest)

---

### Data Repair

**⚠️ NOTE: Repair functionality is not currently functional. Under development.**

#### GET /repair/<period>
**Purpose:** Adopt orphaned files into metadata  
**Parameters:**
- `period`: `24h`, `2d`, etc.

**Response:**
```json
{
  "period_hours": 24,
  "repair_time": "2025-11-05T05:00:00Z",
  "files_adopted": 5,
  "files_rejected": 0,
  "health": {
    "status": "✅ REPAIRED",
    "files_fixed": 5
  },
  "stations": [...]
}
```

#### GET /repair/<period>/report
**Purpose:** Human-readable repair report  
**Response:** Plain text summary

---

## R2 Storage Structure

### Hierarchy
```
/data/
  └─ {YEAR}/              # e.g., 2025
      └─ {MONTH}/         # e.g., 11 (zero-padded)
          └─ {NETWORK}/   # e.g., HV
              └─ {VOLCANO}/       # e.g., kilauea
                  └─ {STATION}/   # e.g., OBL
                      └─ {LOCATION}/  # e.g., -- (empty)
                          └─ {CHANNEL}/   # e.g., HHZ
                              ├─ 10m/
                              │   └─ HV_OBL_--_HHZ_100Hz_2025-11-04-11-50-00_to_2025-11-04-11-59-59.bin.zst
                              ├─ 1h/
                              │   └─ HV_OBL_--_HHZ_100Hz_2025-11-04-11-00-00_to_2025-11-04-11-59-59.bin.zst
                              ├─ 6h/
                              │   └─ HV_OBL_--_HHZ_100Hz_2025-11-04-06-00-00_to_2025-11-04-11-59-59.bin.zst
                              └─ HV_OBL_--_HHZ_100Hz_2025-11-04.json

/collector_logs/
  └─ failures.json        # Complete failure history with timestamps (all failures)
```

### Filename Format
**Pattern:** `{NETWORK}_{STATION}_{LOCATION}_{CHANNEL}_{RATE}Hz_{START}_to_{END}.bin.zst`

**Example:** `HV_OBL_--_HHZ_100Hz_2025-11-04-11-50-00_to_2025-11-04-11-59-59.bin.zst`

**Components:**
- `NETWORK`: Network code (HV, AV)
- `STATION`: Station code (OBL, UWE)
- `LOCATION`: Location code (`--` for empty)
- `CHANNEL`: Channel code (HHZ, BHZ)
- `RATE`: Sample rate (100Hz, 40.96Hz)
- `START`: Start time (YYYY-MM-DD-HH-MM-SS)
- `END`: End time (YYYY-MM-DD-HH-MM-SS)

### Metadata Format
**Filename:** `{NETWORK}_{STATION}_{LOCATION}_{CHANNEL}_{RATE}Hz_{DATE}.json`

**Example:**
```json
{
  "date": "2025-11-04",
  "network": "HV",
  "volcano": "kilauea",
  "station": "OBL",
  "location": "",
  "channel": "HHZ",
  "sample_rate": 100.0,
  "created_at": "2025-11-05T02:26:32.572100Z",
  "complete_day": false,
  "chunks": {
    "10m": [
      {
        "start": "11:50:00",
        "end": "11:59:59",
        "min": -547,
        "max": 6083,
        "samples": 60000,
        "gap_count": 0,
        "gap_samples_filled": 0
      }
    ],
    "1h": [...],
    "6h": [...]
  }
}
```

---

## Data Collection Schedule

**Frequency:** Every 10 minutes at :02, :12, :22, :32, :42, :52  
**Windows Created:**
- **10m:** Every run (most frequent)
- **1h:** Every 6 runs (hourly at :02)
- **6h:** Every 36 runs (at 00:02, 06:02, 12:02, 18:02)

**IRIS Delay:** 2 minutes (fetches data ending 2 minutes ago)

**Deduplication:** Checks metadata before fetching - skips if chunk already exists (prevents duplicate files and metadata entries)

---

## Configuration

### Active Stations (`stations_config.json`)
```json
{
  "networks": {
    "HV": {
      "kilauea": [
        {
          "station": "OBL",
          "location": "",
          "channel": "HHZ",
          "sample_rate": 100.0,
          "active": true
        }
      ]
    }
  }
}
```

### Environment Variables
```bash
# R2 Storage (Cloudflare)
R2_ACCOUNT_ID=66f906f29f28b08ae9c80d4f36e25c7a
R2_ACCESS_KEY_ID=9e1cf6c395172f108c2150c52878859f
R2_SECRET_ACCESS_KEY=93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec
R2_BUCKET_NAME=hearts-data-cache

# Server Port (default: 5000)
PORT=5000
```

---

## Local Testing

### Start Local Servers

#### `start_local_server.sh`
**Purpose:** Start Flask API server (main.py)  
**Port:** 5001  
**Usage:**
```bash
cd backend
./start_local_server.sh
```
**Features:**
- Cleans up any existing processes on port 5001
- Sets Flask environment variables
- Enables debug mode
- Provides clear startup messages
- Runs on http://localhost:5001

**Endpoints:** Audio streaming, IRIS data fetching

#### `start_local_collector.sh`
**Purpose:** Start data collector with status endpoint (cron_loop.py)  
**Port:** 5005 (local), 5000 (production)  
**Usage:**
```bash
cd backend
./start_local_collector.sh
```
**Features:**
- Cleans up any existing processes on port 5005
- Runs collector loop (fetches data every 10 min)
- Runs on http://localhost:5005

**Endpoints:** `/health`, `/status`, `/stations`, `/validate`, `/repair`

**Note:** Uses port 5005 locally because macOS AirPlay blocks port 5000

### Test Scripts

#### `test_cron_simulation.py`
**Purpose:** Simulate cron job locally without Railway  
**Usage:**
```bash
python test_cron_simulation.py
```
**Output:** Creates files in `cron_output/`

#### `test_cron_pipeline_local.py`
**Purpose:** Test full pipeline (fetch → process → compress → upload)  
**Usage:**
```bash
python test_cron_pipeline_local.py
```
**Validates:** IRIS fetch, ObsPy processing, Zstd compression, R2 upload

#### `test_audio_stream_local.py`
**Purpose:** Test audio streaming endpoint  
**Usage:**
```bash
# Terminal 1: Start server
python main.py

# Terminal 2: Run test
python test_audio_stream_local.py
```

#### `test_iris_latency.py`
**Purpose:** Measure IRIS response times  
**Usage:**
```bash
python test_iris_latency.py
```

---

## Best Practices

### API Access
1. **Check /health first** before heavy operations
2. **Use /status** for monitoring and metrics
3. **Poll /status** max once per minute (avoid rate limiting)
4. **Parse status values** programmatically:
   - `PERFECT` = no action needed
   - `RUNNING` = wait for completion
   - `MISSING`/`INCOMPLETE` = investigate

### Data Validation
1. **Run /validate/24h daily** to catch issues early
2. **Use /repair/<period>** to fix orphaned files
3. **Check coverage_depth** to know historical availability
4. **Monitor files_per_station.is_uniform** for distribution issues

### File Operations
1. **Always check metadata first** before direct R2 access
2. **Use self-describing filenames** when creating files
3. **Maintain subfolder structure** (10m/, 1h/, 6h/)
4. **Update metadata** when adding/removing files

### Performance
1. **Cache /status responses** for up to 60 seconds
2. **Batch file operations** when possible
3. **Use paginated R2 listings** for large datasets
4. **Filter by prefix** when querying specific stations

---

## Data Format Specifications

### Binary Files (.bin.zst)
**Compression:** Zstandard level 3  
**Data Type:** int32 little-endian  
**Units:** Raw counts (no physical units)  
**Order:** Sequential samples, time-series

**Decompression:**
```python
import zstandard as zstd
import numpy as np

# Decompress
dctx = zstd.ZstdDecompressor()
decompressed = dctx.decompress(compressed_bytes)

# Convert to int32 array
samples = np.frombuffer(decompressed, dtype=np.int32)
```

### Sample Rates
- **HV Network:** 100 Hz (most stations)
- **AV Network:** 40.96 Hz or 100 Hz (varies)

### Time Alignment
- All timestamps in UTC
- ISO 8601 format: `YYYY-MM-DDTHH:MM:SS.SSSSSSZ`
- Filenames use: `YYYY-MM-DD-HH-MM-SS` (no colons for filesystem compatibility)

---

## Error Handling

### HTTP Status Codes
- `200`: Success
- `404`: Resource not found
- `500`: Server error (check logs)

### Common Issues

**Issue:** `coverage_depth.full_coverage_hours_back` is 0  
**Cause:** No 6h files created yet  
**Solution:** Wait for 6 hours of collection (36 cycles)

**Issue:** `files_per_station.is_uniform` is false  
**Cause:** Some stations missing files  
**Solution:** Check `/validate/<period>` for details

**Issue:** `status` shows `RUNNING` for extended period  
**Cause:** Collection job stuck or very slow  
**Solution:** Check `currently_running` and `last_run` timestamps

**Issue:** Orphaned files in `/repair` report  
**Cause:** Files created outside normal workflow  
**Solution:** Run `/repair/<period>` to adopt them

**Issue:** `failed_runs` > 0  
**Cause:** Collection job failed (check `last_failure` for details)  
**Solution:** Check `last_failure.error` and `last_failure.exit_code` to diagnose. Review `recent_failures` array for patterns.

**Example failure in status:**
```json
"last_failure": {
  "timestamp": "2025-11-05T05:52:01.312695+00:00",
  "error": "Exit code 1: Traceback (most recent call last): ...",
  "exit_code": 1,
  "type": "subprocess_failure"
},
"recent_failures": [
  {
    "timestamp": "2025-11-05T05:52:01.312695+00:00",
    "error": "Exit code 1: ...",
    "exit_code": 1,
    "type": "subprocess_failure"
  }
]
```

---

## Version History

**v1.10** - Duplicate detection & deduplication (prevents and fixes duplicate metadata entries, adds /deduplicate endpoint, skipped counter in cron summary)  
**v1.07** - Failure tracking (timestamp, error messages, exit codes, recent failures history)  
**v1.06** - Coverage depth metrics (hours/days back tracking)  
**v1.05** - Status endpoint improvements (runtime fields, per-station tracking)  
**v1.04** - Expected vs actual validation for all file types  
**v1.03** - Multi-resolution data collection (10m, 1h, 6h)  
**v1.02** - R2 integration and metadata tracking  
**v1.01** - Initial cron loop implementation  
**v1.00** - Basic data collection

---

## Support & Documentation

**Setup Guide:** `RAILWAY_COLLECTOR_SETUP.md`  
**Planning Doc:** `../docs/cron_job_planning.md`  
**Architecture:** `../docs/cache_architecture.md`  
**Captain's Logs:** `../docs/captains_logs/`

---

## Machine-Readable Summary

```yaml
service:
  name: volcano-audio-collector
  version: v1.06
  deployment: Railway
  url: https://volcano-audio-collector-production.up.railway.app

endpoints:
  health: GET /health
  status: GET /status
  stations: GET /stations
  validate: GET /validate/<period>
  validate_report: GET /validate/<period>/report
  repair: GET /repair/<period>
  repair_report: GET /repair/<period>/report

collection:
  frequency_minutes: 10
  schedule: "02,12,22,32,42,52 * * * *"
  windows:
    10m: every_run
    1h: every_6_runs
    6h: every_36_runs

storage:
  provider: Cloudflare R2
  bucket: hearts-data-cache
  compression: zstd-level-3
  format: int32-little-endian

monitoring:
  poll_interval_seconds: 60
  status_values:
    - PERFECT
    - RUNNING
    - OK
    - MISSING
    - INCOMPLETE

active_stations: 5
networks:
  - HV
volcanoes:
  - kilauea
```

