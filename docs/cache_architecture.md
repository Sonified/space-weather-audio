# Cache Architecture

**Purpose:** Document decisions for the local/R2 cache system as we build it.

---

## File Structure

### Hierarchy Decision

**Structure:**
```
/data/
  └─ {YEAR}/              # e.g., 2025
      └─ {MONTH}/         # e.g., 10 (zero-padded)
          └─ {NETWORK}/   # e.g., HV (Hawaii Volcano Observatory)
              └─ {VOLCANO}/       # e.g., kilauea, maunaloa
                  └─ {STATION}/   # e.g., NPOC, MLX
                      └─ {LOCATION}/  # e.g., 01, --, 00
                          └─ {CHANNEL}/   # e.g., HHZ, BDF, EHZ
                              ├─ [data files]
                              └─ [metadata files]
```

**Example:**
```
/data/2025/10/HV/kilauea/NPOC/01/HHZ/2025-10-23.bin
/data/2025/10/HV/kilauea/NPOC/01/HHZ/2025-10-23.json
```

**Rationale:**
- All separate folders = most scalable and consistent
- Mirrors SEED identifier structure (Network.Station.Location.Channel)
- Network contains multiple volcanoes (e.g., HV monitors Kīlauea, Mauna Loa, etc.)
- Each level is easily queryable
- No arbitrary groupings - clean hierarchy

**Key Insight:** Network → Volcano (not Volcano → Network), because networks monitor multiple volcanoes.

---

## Decisions Log

### 2025-10-24
- ✅ Decided on fully separated hierarchy (Network/Volcano/Station/Location/Channel)
- ✅ Using underscores in folder names where needed (not periods) to avoid confusion with file extensions
- ✅ Confirmed Network → Volcano ordering (HV monitors multiple volcanoes)

---

## Data Handling

### Duplicate Data
- IRIS sometimes returns duplicate/overlapping data segments in MiniSEED files
- **Decision:** ✅ Deduplicate data upon fetching from IRIS before caching using ObsPy's `merge()` method

### Processing Options
- Cache processor will have configurable options: dedupe (default: on), linear gap interpolation (default: on)
- Gap interpolation: Calculate missing samples using `round((gap_end - gap_start) * sample_rate)` to ensure perfect timestamp alignment
- Gap metadata: All gaps (start time, end time, duration) will be documented in the metadata file

### Storage Format Testing Results

**Test:** `tests/test_int16_vs_int32_file_sizes.py` and `tests/test_zstd_levels_int32.py`  
**Baseline:** int16 normalized = 1.0x size, int32 raw = 2.0x size

**Zstd Compression (int32):**
- Level 1: 0.79x vs int16 (0.39x vs int32) | compress: ~61ms | decompress: ~22ms
- Level 2: 0.72x vs int16 (0.36x vs int32) | compress: ~80ms | decompress: ~23ms
- Level 3: 0.70x vs int16 (0.35x vs int32) | compress: ~88ms | decompress: ~22ms
- Level 4: 0.70x vs int16 (0.35x vs int32) | compress: ~97ms | decompress: ~22ms
- Level 5: 0.66x vs int16 (0.33x vs int32) | compress: ~152ms | decompress: ~21ms
- Level 6: 0.68x vs int16 (0.34x vs int32) | compress: ~214ms | decompress: ~22ms
- Level 7: 0.67x vs int16 (0.34x vs int32) | compress: ~289ms | decompress: ~21ms
- Level 8: 0.67x vs int16 (0.34x vs int32) | compress: ~365ms | decompress: ~20ms
- Level 9: 0.67x vs int16 (0.34x vs int32) | compress: ~383ms | decompress: ~21ms
- Level 10: 0.66x vs int16 (0.33x vs int32) | compress: ~559ms | decompress: ~21ms

**Gzip Compression (int32):**
- Level 1: 0.82x vs int16 (0.41x vs int32) | compress: ~330ms | decompress: ~145ms
- Level 2: 0.83x vs int16 (0.42x vs int32) | compress: ~400ms | decompress: ~82ms
- Level 3: 0.82x vs int16 (0.41x vs int32) | compress: ~460ms | decompress: ~36ms
- Level 4: 0.83x vs int16 (0.42x vs int32) | compress: ~455ms | decompress: ~40ms
- Level 5: 0.83x vs int16 (0.42x vs int32) | compress: ~907ms | decompress: ~70ms
- Level 6: 0.77x vs int16 (0.39x vs int32) | compress: ~1960ms | decompress: ~33ms
- Level 7: 0.75x vs int16 (0.38x vs int32) | compress: ~2400ms | decompress: ~32ms
- Level 8: 0.72x vs int16 (0.36x vs int32) | compress: ~6030ms | decompress: ~28ms
- Level 9: 0.71x vs int16 (0.36x vs int32) | compress: ~10500ms | decompress: ~27ms

**Blosc Compression (int32, zstd):**
- Level 1: 0.58x vs int16 (0.29x vs int32) | compress: ~9ms | decompress: ~6ms
- Level 3: 0.56x vs int16 (0.28x vs int32) | compress: ~11ms | decompress: ~6ms
- Level 5: 0.55x vs int16 (0.28x vs int32) | compress: ~30ms | decompress: ~5ms
- Level 7: 0.55x vs int16 (0.28x vs int32) | compress: ~53ms | decompress: ~4ms
- Level 9: 0.53x vs int16 (0.27x vs int32) | compress: ~338ms | decompress: ~4ms

**Key Finding:** Blosc level 5 achieves 45% smaller files than int16 with full int32 fidelity, 30ms compression, and 5ms decompression. Blosc is 20-66x faster than gzip while achieving better compression ratios. BUT, it is not possible to run Blosc with a cloudflare worker, and the majority of the benefit comes from multi-threading.

**Result:** ✅ **Zstd level 3 wins for production**
- 30% smaller than int16 baseline (0.70x ratio)
- 3.8x faster compression than gzip (88ms vs 330ms)
- 6.6x faster decompression than gzip (22ms vs 145ms)
- Works perfectly in Cloudflare Workers via `fzstd` library
- **Verified identical decompression:** Cloudflare Worker test confirmed Zstd3 and Gzip3 produce byte-for-byte identical int32 arrays on all test datasets (small/medium/large)

---

### Zstd vs Gzip for JavaScript Decompression (2025-10-24)

Tested REAL Kīlauea seismic data (int32) with browser decompression.

| Dataset          | Gzip Decompress | Zstd Decompress |       Winner        |
|------------------|----------------|----------------|--------------------|
| Small (0.34 MB)  |     5.0 ms     |     2.4 ms     | Zstd 2.1× faster   |
| Medium (2.06 MB) |    28.8 ms     |    13.0 ms     | Zstd 2.2× faster   |
| Large (5.49 MB)  |    74.5 ms     |    36.2 ms     | Zstd 2.1× faster   |

**Summary:**
- Zstd decompresses **52.4% faster** than gzip (17.2ms vs 36.1ms average)
- Zstd compresses **8% better** than gzip (44.5% vs 48.4% ratio)
- Zstd wins on **both** speed and size for all file sizes

**Recommendation:** ✅ **Use Zstd level 3 for Cloudflare Workers** (via `fzstd` library)

---

### Production Cloudflare Worker Results (2025-10-24)

**FINAL IN-PLACE TEST** - Real seismic data served from R2 → decompressed in production Worker → verified byte-for-byte identical.

| Size   | Format | Compressed | Ratio  | Worker Decompress | Worker Total | Data Verification                | Format Comparison |
|--------|--------|------------|--------|-------------------|--------------|----------------------------------|-------------------|
| small  | zstd3  | 157.6 KB   | 44.8%  | 0.0000 ms         | 161.0 ms     | 90,000 samples [199, 7,207]      | ✅ Identical      |
| small  | gzip3  | 175.8 KB   | 50.0%  | 0.0000 ms         | 145.0 ms     | 90,000 samples [199, 7,207]      | ✅ Identical      |
| medium | zstd3  | 935.9 KB   | 44.4%  | 0.0000 ms         | 182.0 ms     | 540,000 samples [-918, 8,216]    | ✅ Identical      |
| medium | gzip3  | 1,053.6 KB | 49.9%  | 0.0000 ms         | 146.0 ms     | 540,000 samples [-918, 8,216]    | ✅ Identical      |
| large  | zstd3  | 2,499.3 KB | 44.4%  | 0.0000 ms         | 204.0 ms     | 1,440,000 samples [-918, 8,216]  | ✅ Identical      |
| large  | gzip3  | 2,811.2 KB | 50.0%  | 0.0000 ms         | 293.0 ms     | 1,440,000 samples [-918, 8,216]  | ✅ Identical      |


**Key Findings:**
- **Decompression Time**: Both show 0.0000ms (sub-millisecond) - Cloudflare's 10ms CPU limit proves both are blazing fast
- **Worker Total Time**: Dominated by R2 fetch, NOT decompression
- **Compression Ratio**: Zstd **10-11% smaller** than Gzip consistently (44.5% vs 50.0%)
- **Data Integrity**: ✅ All samples, ranges, and values match perfectly
- **Cross-Format Verification**: ✅ Worker automatically fetched and compared BOTH formats - byte-for-byte identical decompression confirmed
- **Critical Bug Fixed**: Zstd's `fzstd` returns `Uint8Array` with non-zero `byteOffset` - must copy to aligned buffer before creating `Int32Array`

**Production Decision:** 🏆 **Zstd level 3 wins** - 10-11% smaller files, sub-millisecond decompression, proven identical output

---

## Open Questions

- **Data file format:** int16 vs int32 vs zarr? Native MiniSEED data is int32; ~18% of files exceed int16 range (±32,767), with worst case at 5.3x over (±175,191). Testing actual storage impact.
- What metadata goes in the JSON file?
- **Timestamps:** Do we send full time array or sparse timestamps (every 1s/10s/30s/60s on the nearest second)? What's the right sampling rate for visualization vs accuracy tradeoff?
- File naming convention for data files? (`2025-10-23.bin` vs something else?)
- File naming convention for metadata files? (same name with `.json` extension?)
- Do we need higher-level index files?

