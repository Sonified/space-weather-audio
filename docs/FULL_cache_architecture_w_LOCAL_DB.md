System Architecture — Local Cache + R2 + Render (Browser-Side Filtering + Zstd Storage)

Local Cache: IndexedDB Mirroring with Temporal Keys

Each file is uniquely identified by its temporal coverage, not just date.
No compression is used locally — the data remains raw Int16 or Int32 for instant read and low CPU overhead.

/data/{YEAR}/{MONTH}/{NETWORK}/{VOLCANO}/{STATION}/{LOCATION}/{CHANNEL}/{START}_to_{END}.bin

Example (1-hour chunk):

/data/2025/10/HV/kilauea/NPOC/01/HHZ/2025-10-24-00-00-00_to_2025-10-24-01-00-00.bin

Key (in IndexedDB):
A string of the full path above — deterministic, human-readable, range-aware.

Value object stored:

{
  meta: {
    start: "2025-10-24T00:00:00Z",
    end: "2025-10-24T00:10:00Z",
    year: 2025,
    month: 10,
    network: "HV",
    volcano: "kilauea",
    station: "NPOC",
    location: "01",
    channel: "HHZ",
    byteLength: 1440000,
    format: "int16",
    sampleRate: 100,
    createdAt: Date.now()
  },
  data: ArrayBuffer
}

Behavior:
	1.	On user request, browser queries IndexedDB for overlapping time ranges.
	•	If [requestedStart, requestedEnd] fully covered → assemble locally.
	•	If partial → play what exists, request missing segments from R2.
	•	Stitch contiguous segments in memory by sorting on meta.start.
	2.	New data from R2 gets written into IndexedDB immediately with its {START}_to_{END} key.
	3.	Eviction or missing spans are handled naturally — filenames are self-describing and sortable.

Why no compression locally:
	•	Browser CPU overhead for gzip inflate/deflate is non-trivial on large files.
	•	IndexedDB storage is cheap and async; disk I/O is faster than recompression.
	•	Raw binary allows zero-copy decoding for playback.
	•	Faster seeking, merging, and visualization — no waiting on decompression threads.

⸻

File Hierarchy Structure

All data on R2 follows this hierarchy:

```
/data/
  └─ {YEAR}/              # e.g., 2025
      └─ {MONTH}/         # e.g., 10 (zero-padded)
          └─ {NETWORK}/   # e.g., HV (Hawaii Volcano Observatory)
              └─ {VOLCANO}/       # e.g., kilauea, maunaloa
                  └─ {STATION}/   # e.g., NPOC, MLX
                      └─ {LOCATION}/  # e.g., 01, --, 00
                          └─ {CHANNEL}/   # e.g., HHZ, BDF, EHZ
                              ├─ 2025-10-24-00-00-00_to_2025-10-24-01-00-00.bin.zst
                              ├─ 2025-10-24-01-00-00_to_2025-10-24-02-00-00.bin.zst
                              ├─ 2025-10-24-02-00-00_to_2025-10-24-03-00-00.bin.zst
                              ├─ 2025-10-24.json  # Metadata for entire day
                              └─ ...
```

**Rationale:**
- Mirrors SEED identifier structure (Network.Station.Location.Channel)
- Network → Volcano ordering (networks monitor multiple volcanoes)
- Each level is easily queryable
- No arbitrary groupings - clean, scalable hierarchy
- All files use time-range-based names (not just date)

⸻

## Updated Architecture Flow (Oct 30, 2025)

```
User requests time range
  ↓
Browser checks IndexedDB
  ↓ (partial/miss)
Browser requests from Render
  ↓
Render checks R2 storage
  ↓ (miss)
Render:
  1. Fetch from IRIS (24h chunks, retry with half duration on fail)
  2. Dedupe, gap-fill, int32 conversion
  3. **IMMEDIATELY generate metadata** (global min/max)
  4. **SEND metadata directly to browser** ← FAST START!
     (Browser now has normalization range, can prepare UI)
  5. Break into chunks and compress with Zstd level 3:
     - First 6 hours → 6 × 1-hour .zst chunks (PRIORITY - upload to R2 ASAP)
     - Next 18 hours → 3 × 6-hour .zst chunks (upload to R2)
     - Beyond 24h → daily .zst chunks (upload to R2)
  6. Upload metadata to R2 (one .json per day)
  ↓
Browser fetches .zst chunks directly from R2:
  - Fetches 1-hour chunks for hours 0-6 (fast start)
  - Fetches 6-hour chunks for hours 7-24
  - Fetches daily chunks for multi-day requests
  ↓
Browser processes each chunk:
  1. Decompresses .zst locally (2-36ms per chunk)
  2. High-pass filters (0.1 Hz) ← BROWSER DOES FILTERING
  3. Normalizes (using metadata range)
  4. Stitches chunks (with filter "warm-up" for seamless transitions)
  5. Plays audio
  6. Caches in IndexedDB (uncompressed)
```

**Key architectural decisions:**
- ✅ Metadata sent to browser BEFORE chunking/compression finishes
- ✅ Browser does high-pass filtering (NOT Render)
- ✅ Multi-size chunks: 1h (fast start), 6h (efficiency), 24h (long-term)
- ✅ Render prioritizes first 6 hours in 1h chunks for fast playback
- ✅ Browser decompresses locally (Workers don't decompress - just storage/routing)
- ✅ Zstd compression saves 56% on storage + egress
- ⚠️ Outstanding: Request routing - browser→R2 direct or browser→Render→R2?
- ⚠️ Outstanding: Logic for beginning playback when some data is missing (how much buffer is needed?)
- ⚠️ Outstanding: Test progressive streaming of decompressed data
- ⚠️ Outstanding: Test filter warm-up for seamless stitching

⸻

Request Routing: Browser ↔ Render ↔ R2

The routing layer coordinates between browser, R2 storage, and Render processing.

Flow:
	1.	Browser requests time range:

/data?network=HV&volcano=kilauea&station=NPOC&channel=HHZ&start=2025-10-24T00:00:00Z&end=2025-10-24T03:00:00Z

	2.	Render checks R2 for existing chunks:
	•	If found → return manifest + signed URLs for browser to fetch .zst directly from R2
	•	If not found → generate chunks (see Render section below)

	3.	Browser receives response with headers:

X-Data-Start: 2025-10-24T00:00:00Z
X-Data-End: 2025-10-24T03:00:00Z
X-Channel: HHZ
X-Format: int32
X-Sample-Rate: 100
X-Chunks-Manifest: [list of .zst file URLs]

	4.	Browser fetches .zst chunks directly from R2 (parallel fetches)
	5.	Browser decompresses locally and processes

**⚠️ Outstanding Decision:** 
- Option A: Browser fetches .zst directly from R2 (signed URLs, parallel, fast)
- Option B: Proxy through Render/Worker (simpler auth, single endpoint)
- Likely: Option A for performance (parallel fetches, no proxy bottleneck)

⸻

Render: Heavy Processing Layer

Render is called only on cache misses.
Handles all pre-processing and stores final data on R2.

Responsibilities:
	1.	Fetch raw SEED data from IRIS (24h chunks, retry with half duration(s) on fail(s))
	2.	Load with ObsPy → Merge/deduplicate → Fill gaps with linear interpolation
	3.	Convert to int32 for full fidelity
	4.	**Round to second boundaries** — discard partial-second samples (see Step 3 in Data Processing)
	5.	Calculate global min/max for normalization range
	6.	**IMMEDIATELY send metadata to browser** (for fast playback start)
	7.	Break into multi-size chunks (on second boundaries):
		- **PRIORITY:** First 6 hours → 6 × 1-hour chunks
		- Hours 7-24 → 3 × 6-hour chunks  
		- Beyond 24h → daily chunks
	8.	Compress each chunk with Zstd level 3 (parallel compression)
	9.	Upload compressed chunks to R2 in priority order (.bin.zst files)
		- Upload 1-hour chunks FIRST (enables fast playback start)
		- Then 6-hour and daily chunks
	10.	Upload metadata to R2 (one .json per day)

**Key architectural decision:** Browser does high-pass filtering, NOT Render.
- Stored data is raw int32 (no filtering applied on server)
- Browser filters after decompression for maximum flexibility
- Enables A/B testing different filter settings

All local and remote filenames share the same structure, ensuring direct mirroring.
**All time boundaries are guaranteed to be at full second boundaries** (e.g., `00:00:00`, `01:00:00`).


⸻

Progressive Chunking and Streaming

**Goal:** Start audio playback within 50-100ms, not after downloading entire file.

### How Progressive Chunking Works

We store multiple chunk sizes on R2 (1h, 6h, 24h) to optimize for different playback scenarios. Browser fetches the appropriate chunk size based on requested duration, prioritizing smaller chunks for fast start.

**Browser Fetch Strategy:**

```javascript
// Browser requests: ?start=2024-10-29T00:00:00Z&duration=24h

// Determine which chunk sizes to fetch based on duration
function determineChunksToFetch(startTime, duration) {
  const chunks = [];
  let currentHour = 0;
  
  // Hours 0-6: Fetch 1-hour chunks (fast start)
  while (currentHour < Math.min(duration, 6)) {
    chunks.push({
      url: `/2024-10-29/${currentHour.toString().padStart(2, '0')}.bin.zst`,
      type: '1h',
      hours: [currentHour]
    });
    currentHour++;
  }
  
  // Hours 6-24: Fetch 6-hour chunks (efficiency)
  while (currentHour < Math.min(duration, 24)) {
    const chunkStart = Math.floor(currentHour / 6) * 6;
    chunks.push({
      url: `/2024-10-29/6h_${chunkStart}.bin.zst`,
      type: '6h',
      hours: [chunkStart, chunkStart+1, chunkStart+2, chunkStart+3, chunkStart+4, chunkStart+5]
    });
    currentHour += 6;
  }
  
  // Beyond 24h: Fetch daily chunks
  while (currentHour < duration) {
    const day = Math.floor(currentHour / 24);
    chunks.push({
      url: `/2024-10-29/day_${day}.bin.zst`,
      type: '24h',
      hours: Array.from({length: 24}, (_, i) => day * 24 + i)
    });
    currentHour += 24;
  }
  
  return chunks;
}

// Fetch in parallel for speed
const chunkFiles = determineChunksToFetch(startTime, duration);
const compressed = await Promise.all(
  chunkFiles.map(chunk => fetch(chunk.url).then(r => r.arrayBuffer()))
  );
  
// Decompress each chunk locally
const decompressed = await Promise.all(
  compressed.map(data => decompressZstd(data))  // Browser-side decompression
);
```

**Why Multi-Size Chunks?**
- **1-hour chunks (hours 0-6)**: Fast start, playback begins in ~100ms
- **6-hour chunks (hours 7-24)**: Fewer requests, efficient for typical playback
- **Daily chunks (beyond)**: Minimal overhead for long-term storage/playback
- **Parallel fetches**: All chunks download simultaneously (not sequential)
- **Progressive storage**: R2 stores ALL sizes, browser picks optimal

**Browser Processing:**
1. Fetches compressed .zst chunks from R2 (parallel)
2. Decompresses Zstd locally (2-36ms per chunk)
3. High-pass filters each chunk (0.1 Hz cutoff)
4. Normalizes using metadata range
5. Stitches chunks (with filter "warm-up" for seamless transitions)
6. Sends to AudioWorklet in fixed 1024-sample messages (prevents clicking)
7. Caches uncompressed in IndexedDB

**Storage Cost:**
- 1-hour chunks: 6 files × 640KB = 3.84MB
- 6-hour chunks: 3 files × 3.84MB = 11.52MB  
- Daily chunk: 1 file × 15.4MB = 15.4MB
- **Total per day**: ~30.76MB (vs ~15.4MB single-size) = 2x storage
- **Cost**: ~$0.16/month per volcano (vs $0.08) = negligible

⸻

Storage and Compression Strategy

### R2 Storage (Zstd Compressed)
- **Format:** Zstd level 3 compressed int32
- **File extension:** `.bin.zst`
- **Chunk size:** 1 hour (3,600 seconds)
- **Compression ratio:** ~44.5% (int32 compresses to 44.5% of original size)
- **Rationale:**
  - 56% reduction in storage costs vs uncompressed
  - 56% reduction in Render egress costs (upload to R2)
  - Sub-millisecond decompression in R2 Worker (proven in testing)
  - Smaller files = faster R2 → Worker → Browser transfer
  - Granular 1-hour chunks enable efficient caching

**File size examples (int32, 100 Hz, Zstd-compressed):**
- 1 hour raw: 1.44 MB → compressed: ~640 KB (44.5%)
- 24 hours raw: 34.56 MB → compressed: ~15.4 MB (44.5%)

**Cost analysis (per volcano, 1 year) - Multi-Size Chunking:**
- Uploads per day:
  - 6 × 1-hour chunks = 6 files
  - 3 × 6-hour chunks = 3 files  
  - 1 × 24-hour chunk = 1 file
  - Total: 10 files/day (vs 24 for single-size)
- R2 upload cost: 3,650 uploads/year / 1,000,000 × $4.50 = **$0.016/year**
- Storage: ~30.76 MB/day × 365 = ~11 GB × $0.015/month = **$0.16/month**
- Egress from R2: **FREE** (R2's killer feature)
- **Trade-off**: 2x storage cost (~$0.08/month extra) for significantly faster playback start

### IndexedDB (Browser, Uncompressed)
- **Format:** Raw int32 (no compression)
- **Rationale:**
  - Browser CPU overhead for compression/decompression is non-trivial for storage
  - IndexedDB storage is cheap and async
  - Raw binary allows zero-copy decoding for playback
  - Faster seeking, merging, and visualization
  - Instant playback with no decompression step
  - Browser already decompressed once from R2, no need to re-compress for local storage

⸻

Data Processing: Linear Interpolation and Sample-Accurate Reconstruction

When Render fetches data from IRIS, MiniSEED files may contain gaps or overlapping segments.
Our processing pipeline ensures continuous, sample-accurate arrays.

Step 1: Load and Deduplicate

from obspy import read, Stream

# Load all MiniSEED files for the time range
combined_stream = Stream()
for file_path in fetched_files:
    combined_stream += read(file_path)

# ObsPy detects gaps and overlaps automatically:
# - Gaps appear as separate traces with different start/end times
# - Gap detection: trace[i].endtime < trace[i+1].starttime
# - Gaps stored at trace level, not per-sample
# - Overlaps: trace[i].endtime > trace[i+1].starttime

**IRIS Data Issues:**
- IRIS sometimes returns duplicate/overlapping data segments
- **Solution:** Deduplicate using ObsPy's `merge()` method before caching
- All gaps and overlaps are documented in metadata JSON

Step 2: Merge with Linear Interpolation

# Merge overlapping traces and fill gaps
# method=1: Merge overlapping traces (deduplication)
# fill_value='interpolate': Fill gaps with linear interpolation
# interpolation_samples=0: Use calculated gap size (not manual override)
combined_stream.merge(method=1, fill_value='interpolate', interpolation_samples=0)

# Result: Single continuous trace with all gaps filled
trace = combined_stream[0]
data = trace.data.astype(np.int32)

How Interpolation Works:
- Detects gaps using trace-level timestamps (comparing endtime with next starttime)
- Calculates missing samples: `missing_samples = round((gap_end - gap_start) * sample_rate)`
  - Uses `round()` to ensure perfect timestamp alignment
- Takes last value before gap: trace[i].data[-1]
- Takes first value after gap: trace[i+1].data[0]
- Linearly interpolates between these two values
- Fills exactly the calculated number of missing samples

Gap Metadata:
All gaps are documented in the JSON metadata file:
```json
{
  "gaps": [
    {
      "start": "2025-10-24T00:05:23.456Z",
      "end": "2025-10-24T00:05:25.123Z",
      "duration_seconds": 1.667,
      "samples_filled": 167
    }
  ]
}
```

Step 3: Round to Second Boundaries

CRITICAL: All data brought in at the leading edge of what is available on the server must be rounded down to the nearest full second boundary!

This ensures clean time boundaries for seamless chunk concatenation and prevents partial-second samples from causing gaps or misalignment.

Implementation:
```python
from obspy import UTCDateTime

# After merging/interpolation, round end time down to nearest second
original_end = trace.stats.endtime
rounded_end = UTCDateTime(int(original_end.timestamp))  # Truncate to second boundary

# Calculate how many full seconds we have
duration_seconds = int(rounded_end.timestamp - trace.stats.starttime.timestamp)

# Calculate exact number of samples for full seconds
samples_per_second = int(trace.stats.sampling_rate)
full_second_samples = duration_seconds * samples_per_second

# Trim data to full seconds only (discard partial-second samples)
data = data[:full_second_samples]

# Update trace stats
trace.stats.endtime = rounded_end
trace.data = data
```

Example:
- If we fetched data ending at `2025-10-24T00:10:00.987654Z` with 100 Hz sample rate
- We have 987 partial-second samples (9.87 ms × 100 Hz ≈ 987 samples)
- Round down to `2025-10-24T00:10:00.000000Z`
- Discard the last 987 samples
- Next pull will start from `2025-10-24T00:10:00.000000Z` when full second is available

Benefits:
- ✅ Clean second boundaries for all files
- ✅ Seamless concatenation (no partial-second gaps)
- ✅ Predictable file boundaries (always ends at `:00` seconds)
- ✅ Easier chunking and merging logic

Step 4: Store Continuous Array (No Timestamps Needed!)

Key Insight: Once gaps are interpolated and rounded to second boundaries, index = time offset in samples.
We only need to store start_time metadata, not per-sample timestamps.

metadata = {
    'start_time': str(trace.stats.starttime),  # Absolute start time (rounded to second)
    'end_time': str(trace.stats.endtime),  # Absolute end time (rounded to second boundary)
    'sample_rate': float(trace.stats.sampling_rate),  # e.g., 100.0 Hz
    'samples': len(data),  # Exact number of samples (always full seconds × sample_rate)
    'duration_seconds': int(trace.stats.endtime.timestamp - trace.stats.starttime.timestamp),  # Integer seconds only
    'gaps_filled': len(gaps_detected),  # Track how many gaps were interpolated
    'gaps_info': [...],  # Optional: document where gaps were
}

# Store raw data array (no timestamp array needed!)
# Index calculation: timestamp[i] = start_time + (i / sample_rate)
# All samples are guaranteed to be within full-second boundaries

Step 5: Sample-Accurate Extraction

CRITICAL: Use round(), not truncation, for sample index calculation!

def extract_samples(data, start_time, target_time, num_samples, sample_rate):
    """Extract samples using time-to-index calculation"""
    time_offset = target_time - start_time
    time_offset_seconds = float(time_offset)
    
    # WRONG: int(time_offset_seconds * sample_rate)  # Truncation causes off-by-one errors!
    # CORRECT: Round to nearest sample to match ObsPy's selection
    start_index = int(round(time_offset_seconds * sample_rate))
    
    return data[start_index:start_index + num_samples]

Why Rounding Matters:
- ObsPy's trim() selects the sample CLOSEST to target time (uses rounding/nearest-neighbor)
- Truncation can select wrong sample: int(230129.7) = 230129, but closest is 230130
- Rounding matches ObsPy: int(round(230129.7)) = 230130 ✓

Verification:
- Test: tests/test_sample_accurate_reconstruction.py
- Results: 23/23 random hourly extractions match ObsPy exactly
- Continuous array: 8,640,000 samples (24h × 100 Hz)
- 100% match rate when using round()

Chunking Strategy: Options and Tradeoffs

**The Problem:** If we store full 24-hour files, we'd fetch/process way more than needed for typical requests (1-6 hours). Also, with progressive IRIS updates throughout the day, full-day files would need constant reprocessing or defeat real-time updates.

**TODO: Decide on chunk size (1h, 2h, 3h, 4h, 6h, or 12h)**

Benefits (applies to all chunking strategies):
- ✅ No timestamp storage needed (saves massive space)
- ✅ Matches MiniSEED philosophy (timestamps calculated, not stored)
- ✅ Sample-accurate extraction (matches ObsPy exactly)
- ✅ Simple implementation (just start_time + sample_rate)
- ✅ Perfect for daily files (index = milliseconds from start of day)

⸻

⸻

Local–Remote Coordination Logic

When the user scrubs or requests new time ranges:
	1.	Browser checks IndexedDB for overlapping segments.
	2.	If full coverage → assemble and play immediately.
	3.	If partial → begin playback with local data, request missing segments from R2.
	4.	As R2 responses arrive:
	•	Append each segment to IndexedDB with full path key.
	•	Merge segments in memory.
	•	Continue playback seamlessly.

Each file’s meta.start and meta.end define continuity — no extra manifest needed.

⸻

Playback Start Logic
	•	Begin playback once ≥ 1 second of continuous audio is available locally or from R2.
	•	Worker ensures chunks stream progressively so playback can begin within ~200–300 ms.
	•	If R2 must call Render, playback still starts early with first returned bytes, filling gaps as chunks arrive.

⸻

Rationale for Time-Based Keys (No Compression)
	•	Each file represents a precise time span — unique by definition.
	•	Sorting by key == sorting by time — trivial to merge sequences.
	•	Readable paths simplify debugging and visualization.
	•	Avoiding compression eliminates CPU and I/O overhead in the browser.
	•	IndexedDB read/write of raw ArrayBuffer is fast enough for real-time use.

⸻

Summary Table

| Layer | Role | Key | Compression | Strengths |
|-------|------|-----|-------------|-----------|
| IndexedDB (Browser) | Local cache for user-accessed chunks | `/.../{START}_to_{END}.bin` | None | Immediate access, low CPU, full fidelity |
| R2 Storage | Persistent cloud cache | same | **Zstd level 3** | 56% smaller, fast browser decompress (2-36ms), multi-size chunks (1h/6h/24h) |
| Browser | Fetches, decompresses, processes | same | Decompresses locally | Parallel fetches, fast zstd decompress, flexible filtering |
| Render | IRIS fetcher + preprocessor | same | Compresses for upload | Dedupe, gaps, multi-size chunking, sends metadata early to browser |


⸻

End-to-End Flow

Browser
  → IndexedDB lookup
      → hit → play
      → partial → play + request missing segments
          → R2 Worker
              → hit → stream from R2
              → miss → request from Render
                     → fetch from IRIS
                     → preprocess, upload to R2
                     → R2 streams to browser + stores


⸻

Metadata JSON Format

**One metadata file per day** containing information for all hourly chunks.

**Example:** `2025-10-24.json`

```json
{
  "date": "2025-10-24",
  "network": "HV",
  "volcano": "kilauea",
  "station": "NPOC",
  "location": "01",
  "channel": "HHZ",
  "sample_rate": 100.0,
  "format": "int32",
  "total_samples": 8640000,
  "total_duration_seconds": 86400,
  "normalization": {
    "global_min": -1523,
    "global_max": 1891,
    "scale_factor": 17.32
  },
  "chunks": [
    {
      "hour": 0,
      "start_time": "2025-10-24T00:00:00Z",
      "end_time": "2025-10-24T01:00:00Z",
      "samples": 360000,
      "duration_seconds": 3600,
      "file": "2025-10-24-00-00-00_to_2025-10-24-01-00-00.bin.zst",
      "compressed_size_bytes": 640000,
      "uncompressed_size_bytes": 1440000,
      "gaps_filled": 0
    },
    {
      "hour": 1,
      "start_time": "2025-10-24T01:00:00Z",
      "end_time": "2025-10-24T02:00:00Z",
      "samples": 360000,
      "duration_seconds": 3600,
      "file": "2025-10-24-01-00-00_to_2025-10-24-02-00-00.bin.zst",
      "compressed_size_bytes": 638000,
      "uncompressed_size_bytes": 1440000,
      "gaps_filled": 1,
      "gaps": [
        {
          "start": "2025-10-24T01:23:45.678Z",
          "end": "2025-10-24T01:23:46.789Z",
          "duration_seconds": 1.111,
          "samples_filled": 111
        }
      ]
    }
    // ... 22 more hours
  ],
  "created_at": "2025-10-24T02:15:33.123456Z"
}
```

**Key Fields:**
- `normalization`: **Critical for fast playback start** - sent to browser immediately
  - `global_min` / `global_max`: Range across all 24 hours (for normalization)
  - `scale_factor`: Pre-calculated normalization factor
- `chunks[]`: Array of 24 hourly chunks
  - Each chunk has its own metadata (start/end time, samples, file path)
  - Gaps documented per-chunk (if any)
- `total_samples`: Always `86400 × sample_rate` (full day)

**Metadata size:** ~5-10 KB per day (negligible compared to audio data)

⸻

Complete End-to-End Flow

### Scenario 1: Cache Hit (R2 Already Has Data)

```
User clicks "Play 3 hours from 2025-10-24 00:00" in browser
  ↓
Browser checks IndexedDB for time range
  ↓ (miss)
Browser requests from R2 Worker:
  /data?network=HV&volcano=kilauea&station=NPOC&channel=HHZ
       &start=2025-10-24T00:00:00Z&end=2025-10-24T03:00:00Z
  ↓
R2 Worker checks R2 for files:
  - Metadata: /data/2025/10/HV/kilauea/NPOC/01/HHZ/2025-10-24.json
  - Hour 0: 2025-10-24-00-00-00_to_2025-10-24-01-00-00.bin.zst
  - Hour 1: 2025-10-24-01-00-00_to_2025-10-24-02-00-00.bin.zst
  - Hour 2: 2025-10-24-02-00-00_to_2025-10-24-03-00-00.bin.zst
  ↓ (hit!)
R2 Worker sends metadata first:
  Response: {global_min: -1523, global_max: 1891, total_samples: 1080000, sample_rate: 100}
  ↓
Browser receives metadata (instant) → Prepares for playback
  ↓
R2 Worker fetches and combines hourly chunks using progressive pattern:
  Chunk 1: Hours [0] (1 hour) → Decompress → Stream → Browser receives
  ↓
Browser processes first chunk:
  1. Deframe (remove length prefixes)
  2. High-pass filter (0.1 Hz)
  3. Normalize using metadata range
  4. Schedule playback → **PLAYBACK STARTS** (50-100ms total)
  ↓
R2 Worker continues streaming while hour 0 plays:
  Chunk 2: Hours [1, 2] (2 hours) → Decompress → Combine → Stream
  Chunk 3: Hours [3, 4, 5] (3 hours) → Decompress → Combine → Stream
  Chunk 4: Hours [6-11] (6 hours) → Decompress → Combine → Stream
  Chunk 5: Hours [12-23] (12 hours) → Decompress → Combine → Stream
  ↓
Browser processes each chunk:
  - Deframe to extract audio data
  - "Warm up" filter (last 1024 samples from previous chunk)
  - Filter current chunk
  - Stitch seamlessly to previous audio
  - Continue playback
  ↓
Browser stores all chunks in IndexedDB (uncompressed)
  ↓
Future requests for this time range = instant playback from IndexedDB
```

**Timeline:**
- 0-20ms: Request → R2 Worker → Metadata sent
- 20-50ms: Fetch hour-0 chunk → Decompress with Zstd → Combine → Stream
- 50-100ms: First chunk arrives → Browser deframes → Filters → **AUDIO STARTS**
- 100ms-1h: Hour 0 plays (3600s) while hours 1-2 download and combine
- 1h-3h: Hours 1-2 play (7200s) while hours 3-5 download and combine
- Pattern continues exponentially until all 24 hours streamed
- All chunks cached in IndexedDB for instant future playback

### Scenario 2: Cache Miss (R2 Needs to Generate from IRIS)

```
User clicks "Play 3 hours from 2025-10-29 00:00" (recent data, not yet cached)
  ↓
Browser requests from R2 Worker
  ↓
R2 Worker checks R2 for file
  ↓ (miss!)
R2 Worker forwards request to Render:
  GET /generate?network=HV&volcano=kilauea&station=NPOC&channel=HHZ
                &start=2025-10-29T00:00:00Z&end=2025-10-29T03:00:00Z
  ↓
Render Backend:
  1. Fetch MiniSEED files from IRIS (1-3 seconds)
  2. Load with ObsPy → Merge/deduplicate → Fill gaps (100-200ms)
  3. Convert to int32 (10ms)
  4. Round to second boundaries (1ms)
  5. Calculate global min/max for normalization (10ms)
  ↓
  6. **SEND METADATA TO BROWSER IMMEDIATELY** (fast path!)
     Response: {global_min: -1523, global_max: 1891, total_samples: 1080000, sample_rate: 100}
     Browser now knows normalization range and can prepare for playback!
  ↓
  7. Break into 3 hourly chunks (50ms)
  8. Compress each chunk with Zstd level 3 (parallel: ~50ms each)
  9. Upload compressed chunks to R2 in parallel (200-500ms)
  10. Upload metadata .json to R2 (10ms)
  ↓
R2 Worker streams hourly chunks using progressive combination pattern:
  Chunk 1: Hours [0] (1 hour) → Fetch → Decompress → Stream
  ↓
Browser receives first chunk:
  1. Deframe (remove length prefixes)
  2. High-pass filter (0.1 Hz cutoff)
  3. Normalize using metadata range
  4. Schedule playback → **AUDIO STARTS!**
  ↓
R2 Worker continues streaming while hour 0 plays:
  Chunk 2: Hours [1, 2] (2 hours) → Fetch → Decompress → Combine → Stream
  ↓
Browser processes each chunk:
  - Deframe to extract audio data
  - "Warm up" filter (last 1024 samples from previous chunk)
  - Filter current chunk
  - Stitch seamlessly to previous audio
  - Continue seamless playback
  ↓
Browser caches all chunks in IndexedDB (uncompressed int32)
R2 now has cached chunks for future requests
```

**Timeline:**
- 0-1.5s: IRIS fetch + processing
- **1.5s: Metadata sent to browser** → Browser ready!
- 1.5-2.5s: Chunking + compression + R2 upload
- 2.5s: First audio chunk (hour 0) arrives → Browser deframes → Filters → **PLAYBACK STARTS**
- 2.5s-1h: Hour 0 plays (3600s) while hours 1-2 download and combine
- 1h-3h: Hours 1-2 play (7200s) while hours 3-5 download and combine
- Pattern continues exponentially until all hours streamed
- All chunks cached in R2 and IndexedDB

**Key improvements:**
1. Metadata sent early (before chunking finishes) → faster UI response
2. Browser does filtering → flexibility to A/B test filter settings
3. Hourly chunks → granular caching

### Scenario 3: Partial Cache Hit (IndexedDB Has Some Data)

```
User scrubs to 2025-10-24 02:00 (middle of 3-hour chunk)
  ↓
Browser checks IndexedDB:
  - Has: 00:00-03:00 ✓
  - Missing: None
  ↓ (full hit!)
Browser loads from IndexedDB (instant, no network request)
  ↓
Extract samples starting at 02:00:00 using time offset calculation:
  start_index = round((target_time - start_time) * sample_rate)
  start_index = round((02:00:00 - 00:00:00) * 100) = 720,000
  ↓
Schedule playback immediately (0ms latency)
```

**Timeline:**
- 0-10ms: IndexedDB query → Extract samples → Schedule playback
- Instant playback (no network request needed)

⸻

Future Enhancements
	•	Manifest endpoint on R2 for chunk existence checks
	•	Local continuity checker for combining partial files
	•	Optional garbage collection in IndexedDB based on `createdAt`
	•	Progressive waveform rendering using available chunks for instant visuals
	•	Optional local "warm" cache limit (e.g., last 48 hours) before pruning
	•	Multi-station mixing (combine multiple stations into stereo/surround)

⸻

Outstanding Questions

1. **Progressive chunking of Zstd files from R2 to browser:**
   - ✅ **DECIDED:** Browser fetches .zst chunks directly from R2 (parallel fetches)
   - Browser decompresses locally (2-36ms per chunk - fast!)
   - Multi-size chunks: 1h (hours 0-6), 6h (hours 7-24), 24h (beyond)
   - No Worker decompression needed - browsers handle zstd efficiently

2. **Stitching chunks with high-pass filtering:**
   - Need to test if stitching creates clicks at chunk boundaries
   - Solution: "Warm up" filter using last 1024 samples from previous chunk
   - Prepend to current chunk, filter combined data, discard first 1024 samples
   - **CRITICAL: Must test this approach before implementation**

⸻

Summary

This architecture provides:
- **Fast playback start** via early metadata delivery + prioritized 1-hour chunks
- **Multi-size chunking** (1h/6h/24h) optimizes for different playback scenarios
- **Browser-side decompression** (2-36ms) + filtering for maximum flexibility
- **Parallel fetches** from R2 (no sequential bottleneck)
- **56% cost savings** via Zstd compression (storage + egress)
- **Instant replay** via IndexedDB caching (uncompressed for speed)
- **Lossless int32 fidelity** preserved throughout pipeline
- **Sample-accurate reconstruction** via time-to-index calculation
- **Second-boundary alignment** for seamless chunk concatenation
- **Automatic gap filling** via linear interpolation with full metadata tracking
- **Scalable hierarchy** mirroring SEED identifier structure
- **Low R2 costs** ($0.039/year uploads, ~$0.16/month storage per volcano with multi-size chunks)

The system is fully deterministic by time range, structured for interactive audio streaming, and keeps browser cache lightweight and synchronized with R2. Metadata-first delivery enables fast UI response while chunks process in parallel.