# Progressive Chunk Size Test Plan

**Date:** October 22, 2025  
**Purpose:** Test different storage formats and compression methods for streaming seismic data  
**Scope:** Simple 4-hour test, NOT full production infrastructure

---

## Test Objective

Download 4 hours of Kilauea seismic data from 12 hours ago and measure:
- File size for each storage/compression variant
- Time to first chunk (TTFA)
- Decompression time per chunk
- Total transfer time

---

## Data Flow (This Test Only)

```
1. IRIS FDSN → Fetch 4h of raw seismic data (mseed format)
2. Extract raw samples (NO detrend/normalize - keep raw!)
3. Save to R2 in 6 variants:
   - int16/raw: raw int16 bytes
   - int16/zarr: zarr container, no compression codec
   - gzip/raw: gzipped int16 bytes (level 1)
   - gzip/zarr: zarr with gzip codec (level 1)
   - blosc/raw: blosc-compressed int16 bytes (zstd-5)
   - blosc/zarr: zarr with blosc codec (zstd-5)
4. Stream requested variant with progressive chunks:
   - 8 KB → 16 KB → 32 KB → 64 KB → 128 KB → 256 KB → 512 KB (remaining)
5. Client measures download + decompression time
```

---

## What Gets Saved to R2

**RAW DATA ONLY - NO PROCESSING**

All 6 variants store the SAME raw int16 samples from IRIS:
- No detrend
- No normalize
- Just raw seismic counts converted to int16

Processing (detrend/normalize) happens ONLY in-memory for audio playback, NEVER persisted.

---

## R2 Storage Structure (For This Test)

Using hash keys for simplicity in test:

```
cache/
├── int16/
│   ├── raw/{cache_key}.bin
│   └── zarr/{cache_key}/data.zarr/...
├── gzip/
│   ├── raw/{cache_key}.bin.gz
│   └── zarr/{cache_key}/data.zarr/...
├── blosc/
│   ├── raw/{cache_key}.blosc
│   └── zarr/{cache_key}/data.zarr/...
└── metadata/
    ├── {cache_key}.json
    └── {cache_key}_profiles.json
```

cache_key = MD5 hash of: `{volcano}_{hours_ago}h_ago_{duration_hours}h_duration`

---

## Test Endpoint

`GET /api/stream/<volcano>/<hours>?storage=<raw|zarr>&compression=<int16|gzip|blosc>`

**Example:**
```
GET /api/stream/kilauea/4?storage=raw&compression=gzip&hours_ago=12
```

**Response Headers (Profiling):**
- X-IRIS-Fetch-MS: Time to fetch from IRIS
- X-Preprocess-MS: Time to convert to int16
- X-Compress-MS: Time to compress this variant
- X-Original-Bytes: Uncompressed size
- X-Compressed-Bytes: Compressed size
- X-TTFA-MS: Time to first chunk sent
- X-Transfer-MS: Total transfer time

---

## Test Script

`tests/test_progressive_chunks.py`

Calls `/api/stream` for each of 6 variants and measures:
- File size (from headers)
- TTFA (time to first chunk)
- Per-chunk decompression time
- Average decompression time
- Total time (transfer + decompression)

Prints comparison table.

---

## What This Test Does NOT Do

- ❌ Daily file management
- ❌ Mseed file writing
- ❌ Pre-caching strategies
- ❌ Alert-level logic
- ❌ 10-minute update loops
- ❌ Production architecture

This is JUST a test to measure compression/streaming performance for 4 hours of data.

---

## Expected Results

We want to know:
1. Which variant has smallest file size?
2. Which variant has fastest TTFA?
3. Which variant has fastest compression and decompression?
4. What's the total user-facing latency for each?

Then we pick the winner for production.

---

## Current Status

- ✅ Backend `/api/stream` endpoint implemented
- ✅ R2 integration complete
- ✅ Progressive streaming (8→16→32→64→128→256→512 KB) working
- ✅ Profiling headers implemented
- ⏳ Test script needs to be run

**Next Step:** Run `python3 tests/test_progressive_chunks.py` and analyze results.

