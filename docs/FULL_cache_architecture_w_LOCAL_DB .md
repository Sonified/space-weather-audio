System Architecture — Local Cache + R2 + Render (Final Integration, No Compression)

Local Cache: IndexedDB Mirroring with Temporal Keys

Each file is uniquely identified by its temporal coverage, not just date.
No compression is used locally — the data remains raw Int16 or Int32 for instant read and low CPU overhead.

/data/{YEAR}/{MONTH}/{NETWORK}/{VOLCANO}/{STATION}/{LOCATION}/{CHANNEL}/{START}_to_{END}.bin

Example (3-hour chunk):

/data/2025/10/HV/kilauea/NPOC/01/HHZ/2025-10-24-00-00-00_to_2025-10-24-03-00-00.bin

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
                              ├─ 2025-10-24-00-00-00_to_2025-10-24-03-00-00.bin
                              ├─ 2025-10-24-00-00-00_to_2025-10-24-03-00-00.json
                              ├─ 2025-10-24-03-00-00_to_2025-10-24-06-00-00.bin
                              └─ ...
```

**Rationale:**
- Mirrors SEED identifier structure (Network.Station.Location.Channel)
- Network → Volcano ordering (networks monitor multiple volcanoes)
- Each level is easily queryable
- No arbitrary groupings - clean, scalable hierarchy
- All files use time-range-based names (not just date)

⸻

R2 Worker: The Orchestrator

R2 Worker remains the single routing layer between browser and backend.

Flow:
	1.	Browser requests time range:

/data?network=HV&volcano=kilauea&station=NPOC&channel=HHZ&start=2025-10-24T00:00:00Z&end=2025-10-24T03:00:00Z


	2.	Worker checks R2 for existing file.
	•	If found → stream to client directly with progressive chunking.
	•	If not → forward to Render for generation.
	3.	Worker sets headers describing what's being sent:

X-Data-Start: 2025-10-24T00:00:00Z
X-Data-End: 2025-10-24T03:00:00Z
X-Channel: HHZ
X-Format: int32
X-Sample-Rate: 100

Browser uses these to label its local cache entry.

	4.	Worker stores completed file back to R2 for future reuse.

⸻

Render: Heavy Processing Layer

Render is called only on cache misses.
Handles all pre-processing and stores final data on R2.

Responsibilities:
	•	Fetch raw SEED data from IRIS.
	•	Convert to int32 for full fidelity.
	•	Apply:
	•	High-pass filter (~20 Hz)
	•	Instrument correction (IR convolution)
	•	Normalization
	•	**Round to second boundaries** — discard partial-second samples (see Step 3 in Data Processing)
	•	Quantize to int16 for serving if dynamic range allows.
	•	Upload uncompressed .bin file to R2 with canonical temporal filename.

All local and remote filenames share the same structure, ensuring direct mirroring.
**All time boundaries are guaranteed to be at full second boundaries** (e.g., `00:00:00`, `00:10:00`).


⸻

Progressive Chunking and Streaming

**Goal:** Start audio playback within 50-100ms, not after downloading entire file.

### How Progressive Chunking Works

**R2 Worker Streaming Strategy:**
```javascript
// Progressive chunk sizes (in KB)
const CHUNK_SIZES = [16, 32, 64, 128];  // Ramp up
const FINAL_CHUNK_SIZE = 512;           // Steady state

// Stream pattern:
// Chunk 1: 16 KB  (→ 50-100ms TTFA - Time to First Audio)
// Chunk 2: 32 KB  (ramp up)
// Chunk 3: 64 KB  (ramp up)
// Chunk 4: 128 KB (ramp up)
// Chunks 5+: 512 KB each (steady state)
```

**Why This Pattern?**
- **Small first chunk (16 KB)**: Minimizes Time to First Audio (TTFA ~50-100ms)
- **Ramp up**: Balances responsiveness with efficiency
- **Large steady-state (512 KB)**: Efficient bandwidth use after initial playback starts

### Browser Reception and Playback

**Step 1: Receive First Chunk**
```javascript
// Browser receives 16 KB → ~0.4 seconds of audio at 100 Hz (uncompressed int32)
// Convert to audio buffer and schedule for playback immediately
// TTFA: ~50-100ms total
```

**Step 2: Continue Playback While Streaming**
```javascript
// As each chunk arrives:
//   1. Append to playback buffer
//   2. Schedule next audio segment
// User hears continuous audio while download continues
```

**Step 3: Cache Locally**
```javascript
// Once complete chunk received:
//   1. Store in IndexedDB with full time range key
//   2. Future requests for this time range = instant playback
```

### Length-Prefixed Framing

Worker sends data with explicit chunk boundaries:
```
[4-byte length][chunk data][4-byte length][chunk data]...
```

This ensures browser receives exactly the chunks Worker intended (not merged/fragmented by network).

⸻

Storage and Compression Strategy

### R2 Hot Storage (Uncompressed)
- **Format:** Raw int32 (uncompressed)
- **File extension:** `.bin`
- **Rationale:**
  - Fast access for R2 Worker streaming (no decompression overhead)
  - Recently accessed data (last 7-30 days)
  - Full int32 fidelity preserved
  - Worker can stream directly without decompression step

**File size examples (int32, 100 Hz):**
- 1 hour: 1.44 MB
- 3 hours: 4.32 MB
- 6 hours: 8.64 MB

### R2 Cold Storage (Compressed) - Future Implementation
- **Format:** Gzip compressed int32
- **File extension:** `.bin.gz`
- **When:** Files older than 30 days (configurable threshold)
- **Compression ratio:** ~50% (int32 compresses to ~50% of original size)
- **Rationale:**
  - Reduce storage costs for old/rarely-accessed data
  - Gzip decompression works in all environments (Python, JS, Workers)
  - Acceptable decompression overhead for cold data access
  
**Compression happens:**
- Via scheduled job on Render (not in Worker)
- After file hasn't been accessed for N days
- One-time compression, then re-upload to R2 cold tier

**Access pattern:**
- If Worker needs cold file → fetch from R2 → decompress → stream
- Slightly higher latency (~50-100ms extra) but acceptable for old data

### IndexedDB (Browser, Uncompressed)
- **Format:** Raw int32 (no compression)
- **Rationale:**
  - Browser CPU overhead for compression/decompression is non-trivial
  - IndexedDB storage is cheap and async
  - Raw binary allows zero-copy decoding for playback
  - Faster seeking, merging, and visualization
  - Instant playback with no decompression step

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

Layer	Role	Key	Compression	Strengths
IndexedDB (Browser)	Local cache for user-accessed chunks	/.../{START}_to_{END}.bin	None	Immediate access, low CPU load, full fidelity
R2 Worker	Edge orchestrator + cache	same	Optional (gzip/zstd)	Manages fetch, stream, and storage decisions
Render	Preprocessor + IRIS integration	same	Optional (gzip/zstd)	Heavy compute and preprocessing tasks


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

Each data file (.bin) has a corresponding JSON metadata file with identical base name.

**Example:** `2025-10-24-00-00-00_to_2025-10-24-03-00-00.json`

```json
{
  "network": "HV",
  "station": "NPOC",
  "location": "01",
  "channel": "HHZ",
  "volcano": "kilauea",
  "start_time": "2025-10-24T00:00:00.000000Z",
  "end_time": "2025-10-24T03:00:00.000000Z",
  "sample_rate": 100.0,
  "samples": 1080000,
  "duration_seconds": 10800,
  "format": "int32",
  "file_size_bytes": 4320000,
  "storage_tier": "hot",
  "gaps_filled": 2,
  "gaps": [
    {
      "start": "2025-10-24T00:05:23.456Z",
      "end": "2025-10-24T00:05:25.123Z",
      "duration_seconds": 1.667,
      "samples_filled": 167
    },
    {
      "start": "2025-10-24T01:23:45.678Z",
      "end": "2025-10-24T01:23:46.789Z",
      "duration_seconds": 1.111,
      "samples_filled": 111
    }
  ],
  "processing": {
    "detrended": true,
    "high_pass_filter_hz": 20,
    "instrument_corrected": true,
    "normalized": true
  },
  "created_at": "2025-10-24T02:15:33.123456Z"
}
```

**Key Fields:**
- `start_time` / `end_time`: Exact time boundaries (always at second boundaries)
- `sample_rate`: Samples per second (e.g., 100.0 Hz)
- `samples`: Total sample count (always `duration_seconds × sample_rate`)
- `format`: Data format (int32 for full fidelity)
- `file_size_bytes`: Size of uncompressed .bin file
- `storage_tier`: "hot" (uncompressed) or "cold" (gzip compressed)
- `gaps`: Array of all gaps that were filled with linear interpolation
- `processing`: What processing was applied on Render
- `created_at`: When this file was generated

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
R2 Worker checks R2 for file:
  /data/2025/10/HV/kilauea/NPOC/01/HHZ/2025-10-24-00-00-00_to_2025-10-24-03-00-00.bin
  ↓ (hit!)
R2 Worker streams file with progressive chunking (uncompressed int32):
  Chunk 1: 16 KB  → Browser receives → Schedule playback immediately
  ↓ PLAYBACK STARTS (50-100ms total)
  Chunk 2: 32 KB  → Append to playback buffer
  Chunk 3: 64 KB  → Append to playback buffer
  Chunk 4: 128 KB → Append to playback buffer
  Chunks 5+: 512 KB each → Continuous playback
  ↓
Browser stores complete file in IndexedDB
  ↓
Future requests for this time range = instant playback from IndexedDB
```

**Timeline:**
- 0-50ms: Request → R2 Worker → R2 fetch → First chunk sent
- 50-100ms: First chunk arrives → Decompress → Audio starts playing
- 100ms-5s: Remaining chunks stream while audio plays
- 5s+: File cached in IndexedDB for instant future playback

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
  4. Apply high-pass filter (50ms)
  5. Apply instrument correction (100ms)
  6. Normalize (10ms)
  7. Round to second boundaries (1ms)
  8. Upload uncompressed int32 to R2 hot storage (200-500ms)
  ↓
R2 Worker streams newly-created file to browser (progressive chunking)
  ↓
Browser receives → Plays → Caches in IndexedDB
  ↓
R2 now has cached file for future requests
```

**Timeline:**
- 0-3s: IRIS fetch + processing + R2 upload
- 3-3.1s: First chunk arrives → Audio starts playing
- 3.1-8s: Remaining chunks stream while audio plays
- 8s+: File cached in R2 and IndexedDB

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

Summary

This architecture provides:
- **Sub-100ms Time to First Audio** via progressive chunking
- **Instant replay** via IndexedDB caching
- **Lossless int32 fidelity** preserved throughout pipeline
- **Fast streaming** via uncompressed hot storage (no decompression overhead)
- **Cost-effective cold storage** (future) via gzip compression for old files
- **Zero-compression overhead** in browser and worker for hot data
- **Sample-accurate reconstruction** via time-to-index calculation (no timestamp arrays)
- **Second-boundary alignment** for seamless chunk concatenation
- **Automatic gap filling** via linear interpolation with full metadata tracking
- **Scalable hierarchy** mirroring SEED identifier structure

The system is fully deterministic by time range, structured for interactive audio streaming, and keeps browser cache lightweight and synchronized with R2. Hot storage provides instant access to recent data, while future cold storage implementation will reduce costs for historical data.