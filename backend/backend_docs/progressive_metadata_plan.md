# Progressive Streaming Metadata Endpoint - Implementation Plan

## Problem Statement

The current browser code has a critical bug: it calculates normalization range from ALL chunks in a metadata file (full day), but only fetches the first 3 chunks (30 minutes). This causes incorrect audio normalization.

Additionally, we need intelligent chunk selection based on requested duration.

## Requirements

### 1. Smart Chunk Selection
```
Duration     | Strategy
-------------|----------------------------------------------------------
0-60 min     | All 10m chunks
1-6 hours    | First hour: 10m chunks, Rest: 1h chunks
6-12 hours   | First hour: 10m, Middle: 1h, Last 6h: 6h chunk
12-24 hours  | First hour: 10m, Rest: 6h chunks
24+ hours    | All 6h chunks (no 10m/1h - too many files)
```

### 2. Accurate Min/Max Calculation
- Calculate from ONLY the chunks being returned
- Handle cross-day boundaries (scan multiple metadata files)
- Return correct range for the specific time window requested

### 3. Cross-Day Support
- Request can span midnight (e.g., 23:00 Nov 5 to 01:00 Nov 6)
- Need to load metadata from multiple dates
- Stitch chunk lists from multiple files

## Proposed Endpoint

### `/progressive-metadata`

**Parameters:**
- `network`, `station`, `location`, `channel`: Station identifier
- `start_time`: ISO timestamp (e.g., "2025-11-06T05:30:00Z")
- `duration_minutes`: How many minutes to fetch (e.g., 30, 60, 360, 1440)

**Returns:**
```json
{
  "station": "HV.OBL.--.HHZ",
  "start_time": "2025-11-06T05:30:00Z",
  "end_time": "2025-11-06T06:00:00Z",
  "duration_minutes": 30,
  "sample_rate": 100.0,
  "normalization": {
    "min": -12500,
    "max": -8000,
    "range": 4500
  },
  "chunks": [
    {
      "type": "10m",
      "date": "2025-11-06",
      "start": "05:30:00",
      "end": "05:39:59",
      "url": "https://r2-worker.../chunk?...",
      "samples": 60000,
      "min": -12500,
      "max": -9000
    },
    {
      "type": "10m",
      "date": "2025-11-06",
      "start": "05:40:00",
      "end": "05:49:59",
      "url": "https://r2-worker.../chunk?...",
      "samples": 60000,
      "min": -11000,
      "max": -8500
    },
    {
      "type": "10m",
      "date": "2025-11-06",
      "start": "05:50:00",
      "end": "05:59:59",
      "url": "https://r2-worker.../chunk?...",
      "samples": 60000,
      "min": -10500,
      "max": -8000
    }
  ],
  "total_samples": 180000,
  "strategy": "all_10m"
}
```

## Implementation Steps

1. ✅ Fix browser to use chunksToFetch (DONE)
2. ⏳ Create `/progressive-metadata` endpoint in collector_loop.py
3. ⏳ Implement chunk selection logic
4. ⏳ Handle cross-day boundaries
5. ⏳ Update browser to use new endpoint
6. ⏳ Fix station activation timestamps (separate issue)

## Station Activation Bug

The `/per-station-files` endpoint shows all stations have 0 actual files but the status shows 252 files exist. This is a separate bug in the file counting logic that needs investigation.

