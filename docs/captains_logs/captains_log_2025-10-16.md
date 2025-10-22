# Captain's Log - 2025-10-16

## Key Findings from 2025-10-15 Session

### 1. **Hourly Chunks vs Full Request Test - DEBUNKED**
We ran a head-to-head test comparing:
- **Full request** (1 big API call for 24 hours)
- **Hourly chunks** (24 separate 1-hour API calls)

**Result:** The "difference" was FAKE - just timing artifacts from running the tests at different times. Both approaches get the SAME data from IRIS. No real advantage to hourly chunks for normal 24-hour requests.

**Files created (and since removed):**
- `tests/test_full_vs_hourly.py` - The comparison test
- `tests/investigate_data_difference.py` - Deep dive investigation
- `docs/captains_logs/captains_log_2025-10-15.md` - The previous day's log with now-debunked findings.

### 2. **Project Renamed**
- GitHub repo: `Sonified/Mt_Spurr` → `Sonified/volcano-audio`
- Local folder: `spurr-audification` → `volcano-audio`
- Git remote URL updated in `.git/config`

### 3. **New Vision: Multi-Volcano System**
The project will now focus on building a system that:
- Has a **watch list** of currently active volcanoes (from USGS API)
- Shows all monitored volcanoes in a dropdown
- Allows a user to click a volcano to fetch data and audify it.
- Uses the USGS API: `https://volcanoes.usgs.gov/hans-public/api/volcano/getMonitoredVolcanoes`

### 4. **Data Structure Planning**
We are about to create the following data structure:
```
data/
  ├── usgs_monitored_volcanoes.json
  └── volcano_station_mappings.json
```

### 5. **Current Version**
- v1.03 in `python_code/__init__.py`
- Timezone detection is working.
- Multi-volcano support for Spurr and Kilauea has been tested.

### 6. **Updates on 2025-10-16**
- Implemented full IRIS station audit capturing per-channel metadata (lat/lon/elev, azimuth/dip, start/end, sample_rate, distance_km) for all monitored volcanoes.
- Created `data/reference/volcano_station_availability.json` and `volcano_station_summary.csv`.
- Added `derive_active_stations` to generate `data/reference/active_volcano_stations.json` with active channels (empty or future end_time).
- Built an interactive Jupyter UI to select volcano, type (seismic/infrasound), last N hours, and channel, then fetch and audify data.
- Fixed robustness issues (module reloads, default selections, no-data guard).

### Commit
- Version Tag: v1.03
- Message: Add active-station filtering, full audit outputs, and interactive audify UI

### 7. **Performance Benchmarks (Later on 2025-10-16)**

#### Station Latency Test Results:
- Tested 49 Kilauea stations for real-time data availability
- Found 30 with recent data, 19 offline despite being "active"
- **Best station: HV.SBL.HHZ** (-0.5 min latency, essentially real-time)
- **Production choice: HV.HLPD.HHZ** (0.2 min latency, reliable)
- **Lesson: "Active" metadata ≠ actually transmitting data**

#### IRIS Fetch Performance:
- Tested chunk sizes from 5 min to 6 hours
- **Optimal: 360 minutes (6 hours)** at 0.912 sec/MB
- 4x more efficient than 5-minute chunks
- Larger chunks = less overhead, better throughput

#### Zarr Speed Benchmark (VALIDATED):
- **Average speedup: 67x faster than IRIS direct fetch**
- 6-hour window: 7,355ms (IRIS) vs 40ms (Zarr) = **183x faster**
- Read latency: 5ms consistently across all time windows
- Architecture validated with real data ✓

#### Compression Algorithm Shootout:
Tested 16 compression algorithms on 6h Kilauea data:
- **Winner: Blosc-zstd-5**
  - Compression: 3.42x (70.7% space saved)
  - Read: 5ms (blazing fast)
  - Write: 27ms (12x faster than level 9)
- Blosc wrappers >> standalone codecs
- Zstd beats gzip/bz2/lzma in all metrics
- Production cost: **$2.73/month for all 65 volcanoes**

#### Final Architecture Stack:
```
Storage: Zarr v3 with Blosc-zstd-5
Performance: 5ms reads, 67x faster than IRIS
Cost: $10/month total ($7 Render + $3 R2)
Scalability: 65 volcanoes, 1+ year history
Data freshness: 0.2-5 min latency
```

#### User-Facing Latency Benchmark (CRITICAL FINDING):
Compared two storage approaches for serving audio to users:
- **Approach A**: Zarr time-slicing (load from compressed Zarr → detrend → taper → normalize)
- **Approach B**: WAV chunk loading (load raw WAV chunks → concatenate → detrend → taper → normalize)

**Key insight: Both approaches do IDENTICAL processing (detrend + taper + normalize on full data). The ONLY difference is storage format.**

##### Results:
```
Duration    Zarr Slice    WAV Chunks    Speedup
────────────────────────────────────────────────
1 hour      283ms         5ms           61x faster
3 hours     77ms          11ms          7x faster
6 hours     96ms          25ms          4x faster
12 hours    94ms          32ms          3x faster
24 hours    84ms          27ms          3x faster

Average: 15.6x faster with WAV chunks
```

##### Analysis:
- **Zarr time-slicing overhead**: 80-90ms constant regardless of duration
- **WAV loading scales linearly**: More chunks = more time, but still fast
- **No pre-processing advantage**: Must detrend + taper + normalize on FULL concatenated data to preserve amplitude relationships
- **Complete data integrity**: ALL seismic samples preserved, no downsampling

##### Architecture Decision:
🎯 **Use WAV chunk storage, NOT Zarr**
- **Background**: Fetch 10-min chunks from IRIS → save as raw WAV files to R2
- **User request**: Load WAV chunks → concatenate → detrend + taper + normalize → serve
- **Response time**: 5-30ms (15x faster than Zarr)
- **Storage**: Slightly larger than compressed Zarr, but worth the speed gain

**Important note**: Initially tested "pre-audifying" chunks (detrending/tapering per-chunk) but this breaks amplitude relationships across chunk boundaries. Final test correctly applies all processing to the full concatenated result.

##### Storage Size Comparison (Single Sensor):

**10-Minute Chunk:**
- Raw data (int32): 234 KB
- WAV file: 234 KB (no compression, just container)
- Zarr (Blosc-zstd-5): ~97 KB (2.4x smaller)

**24 Hours of Data:**
- WAV chunks (144 files): 32.9 MB
- Zarr (single file): 14 MB
- Compression ratio: 2.4x

**Annual Storage Costs (Cloudflare R2 at $0.015/GB/month):**
```
Storage Strategy     Per Volcano      65 Volcanoes
─────────────────────────────────────────────────
WAV chunks:          $2.16/year       $140/year
Zarr:                $0.92/year       $60/year

Savings with Zarr: $80/year total
```

**Trade-off Analysis:**
- **WAV chunks**: 15x faster user response, but 2.4x more storage ($80/year more)
- **Zarr**: 2.4x better compression, but 80-90ms time-slicing overhead

**Decision: WAV chunks preferred** - User experience (15x speed) is worth the extra $80/year in storage costs. With 65 volcanoes, the total storage cost difference is minimal compared to the dramatic improvement in response time.

**All benchmarks completed. Architecture validated with WAV chunk storage. Ready for production implementation.**
