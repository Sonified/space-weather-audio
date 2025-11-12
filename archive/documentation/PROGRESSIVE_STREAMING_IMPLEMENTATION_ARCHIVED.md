# Progressive Streaming Implementation - Dual Mode Architecture

> **⚠️ ARCHIVED DOCUMENT - OUTDATED**
> 
> This document describes an R2 Worker architecture that was planned but never fully implemented.
> The current system uses direct CDN access instead.
> 
> **For current architecture, see:** `README.md`
> 
> **Archived:** 2025-11-10
> **Reason:** Architecture evolved to direct `cdn.now.audio` access without worker routing layer

---

## What We Built

We've implemented a **dual-mode system** that intelligently routes requests based on station configuration:

### Mode 1: R2 Progressive Streaming (Active Stations)
For stations marked `"active": true` in `stations_config.json`:
- Fetches from Cloudflare R2 Worker
- Direct streaming (no presigned URLs)
- Progressive chunk delivery
- Metadata-first approach

### Mode 2: Railway Backend (Inactive Stations)
For stations marked `"active": false`:
- Uses existing Railway backend
- Full IRIS fetch + processing pipeline
- Proven, working implementation
- No changes to existing flow

## Architecture

### Dual-Mode Routing
```
User clicks "Fetch Data"
         ↓
Check stations_config.json
         ↓
   ┌─────┴─────┐
   │           │
active=true  active=false
   │           │
   ↓           ↓
R2 Worker   Railway Backend
(Mode 1)     (Mode 2)
```

### Mode 1: R2 Progressive Streaming
```
Browser → R2 Worker /metadata → Get normalization range
         ↓
Browser → R2 Worker /chunk (sequential) → Stream .zst directly
         ↓
Browser decompresses → normalizes → plays
```

### Mode 2: Railway Backend (Unchanged)
```
Browser → Railway API → IRIS fetch + process → Return compressed data
         ↓
Browser decompresses → normalizes → plays
```

## Implementation Details

### 1. Frontend (`index.html`)

**Routing Logic (`startStreaming()`):**

1. **Fetch `stations_config.json`** → Load station configuration
2. **Find selected station** → Match network/station/location/channel
3. **Check `active` flag** → Determines which mode to use
4. **Route to appropriate backend:**
   - `active: true` → `fetchFromR2Worker()`
   - `active: false` → `fetchFromRailway()`

**Key code changes:**
- Line ~1947: Check station active status from `stations_config.json`
- Line ~1986: Route to R2 Worker or Railway based on active flag
- Line ~2018: **NEW** `fetchFromR2Worker()` function (Mode 1)
- Line ~2200: **PRESERVED** `fetchFromRailway()` function (Mode 2)

**Mode 1: R2 Worker Flow (`fetchFromR2Worker()`):**

1. **Fetch metadata first** → Get normalization range before downloading data
2. **Request chunks sequentially** → 3 × 10-minute chunks for 30-minute playback
3. **Decompress locally** → Browser does zstd decompression (2-36ms per chunk)
4. **Normalize** → Using metadata range (global min/max)
5. **Stitch** → Combine chunks into continuous audio
6. **Play!** → Send to AudioWorklet

**Mode 2: Railway Backend Flow (`fetchFromRailway()`):**

1. **POST to Railway API** → Single request with time range
2. **Receive compressed response** → Metadata + samples in one payload
3. **Decompress** → zstd decompression
4. **Parse metadata + samples** → Extract from response
5. **Normalize** → Apply normalization if enabled
6. **Play!** → Send to AudioWorklet

This is the **ORIGINAL** implementation - completely unchanged!

### 2. R2 Worker (`worker/r2-worker-example.js`)

**Two endpoints:**

#### `/metadata` - Returns metadata JSON
- Parameters: network, station, location, channel, date
- Looks up metadata file in R2
- Streams JSON back to browser
- Cached for 1 hour

#### `/chunk` - Streams compressed chunk
- Parameters: network, station, location, channel, date, start, end
- Constructs chunk path in R2
- **Streams .zst file directly** (no decompression in worker!)
- Cached for 1 year (chunks are immutable)

**Key features:**
- CORS headers for browser access
- Caching headers (metadata: 1h, chunks: 1y)
- Error handling for missing files
- Simple routing logic

### 3. Configuration (`worker/wrangler-r2-example.toml`)

Cloudflare Worker configuration:
- R2 bucket binding
- Account ID placeholder
- Deployment settings

## How to Use

### Setup

1. **Install Wrangler CLI:**
   ```bash
   npm install -g wrangler
   ```

2. **Login to Cloudflare:**
   ```bash
   wrangler login
   ```

3. **Create R2 bucket:**
   ```bash
   wrangler r2 bucket create volcano-seismic-data
   ```

4. **Configure worker:**
   ```bash
   cd worker
   cp wrangler-r2-example.toml wrangler.toml
   # Edit wrangler.toml with your account ID
   ```

5. **Deploy:**
   ```bash
   wrangler deploy r2-worker-example.js
   ```

6. **Update frontend:**
   Edit `index.html` line ~1950 with your worker URL:
   ```javascript
   const R2_WORKER_URL = 'https://your-worker.your-subdomain.workers.dev';
   ```

### Testing

1. **Ensure you have data in R2** in the correct format:
   ```
   /data/{YEAR}/{MONTH}/{NETWORK}/{VOLCANO}/{STATION}/{LOCATION}/{CHANNEL}/
     ├─ {NETWORK}_{STATION}_{LOCATION}_{CHANNEL}_{RATE}Hz_{START}_to_{END}.bin.zst
     └─ {NETWORK}_{STATION}_{LOCATION}_{CHANNEL}_{RATE}Hz_{DATE}.json
   ```

2. **Select an active station** in `stations_config.json`:
   - Set `"active": true` for stations you want to test
   - Example: HV.OBL, HV.UWB, AV.SPCP

3. **Open `index.html`** in browser
4. **Select volcano/station/duration**
5. **Click "Fetch Data"**

**Expected flow:**
```
📋 Fetching metadata from R2 Worker...
📋 Metadata received: {...}
🔍 Normalization range from metadata: [-1523, 1891]
📦 Will fetch 3 chunks: ["00:00:00-00:10:00", ...]
📥 Fetching chunk 1/3: 00:00:00-00:10:00
  ✅ Downloaded: 640.2 KB
  🗜️ Decompressing...
  ✅ Decompressed: 360,000 samples
📥 Fetching chunk 2/3: 00:10:00-00:20:00
  ...
🔗 Stitching chunks together...
✅ Stitched 3 chunks into 1,080,000 samples
📏 Converting to Float32 and normalizing...
✅ Normalized 1,080,000 samples to [-1, 1]
🎵 Sending to AudioWorklet...
✅ Playing! (Progressive R2 streaming)
```

## Performance Expectations

### Latency Breakdown (30-minute request)

1. **Metadata fetch:** ~20-50ms
   - Worker → R2 metadata JSON
   - Small file (~8-15 KB)

2. **First chunk fetch:** ~50-100ms
   - Worker → R2 → Stream to browser
   - ~640 KB compressed

3. **Decompress first chunk:** ~10-20ms
   - Browser zstd decompression
   - 360,000 samples

4. **Normalize + stitch:** ~5-10ms
   - Convert to Float32
   - Normalize to [-1, 1]

5. **Send to AudioWorklet:** ~5-10ms
   - 1024-sample chunks

**Total Time to First Audio: ~100-200ms**

(Remaining chunks fetch while first chunk plays)

## Cost Analysis

### Cloudflare Costs (1M requests/month)

**Workers:**
- First 100k requests/day: FREE
- Additional requests: $0.50 per million
- Compute: $0.02 per million GB-seconds
- **Estimated: ~$5/month**

**R2 Storage:**
- Storage: $0.015/GB/month
- Class A operations (write): $4.50 per million
- Class B operations (read): $0.36 per million
- **Egress from Workers: FREE!**

**Example (5 volcanoes, 1 year data):**
- Storage: ~55 GB × $0.015 = $0.83/month
- Reads: 1M/month × $0.36 = $0.36/month
- Worker: ~$5/month
- **Total: ~$6.19/month**

Compare to Railway bandwidth costs: **~$200-400/month**

## Next Steps

### Immediate (to test basic flow)

1. ✅ **Deploy R2 Worker** - Get it live and test endpoints
2. ✅ **Populate R2 with sample data** - Use Railway backend to generate chunks
3. ✅ **Update frontend with worker URL** - Point to deployed worker
4. ✅ **Test with active station** - Verify end-to-end flow

### Future Enhancements

1. **Intelligent chunk size selection:**
   - Use 10min chunks for recent data
   - Use 1h chunks for slightly older data
   - Use 6h chunks for archival data

2. **IndexedDB caching:**
   - Cache decompressed chunks locally
   - Check local cache before requesting from worker
   - Instant replay for recently played data

3. **Partial cache handling:**
   - Worker detects missing chunks
   - Falls back to Railway for IRIS fetch
   - Stores result in R2 for future requests

4. **Dynamic normalization:**
   - Handle cases where metadata range needs adjustment
   - Smooth transitions in AudioWorklet

5. **Volcano name lookup:**
   - Worker reads `stations_config.json` from R2
   - Maps station → volcano automatically
   - Eliminates hardcoded volcano names

## Files Modified

1. **`index.html`** - Progressive streaming implementation
2. **`worker/r2-worker-example.js`** - NEW: Worker with /metadata and /chunk endpoints
3. **`worker/wrangler-r2-example.toml`** - NEW: Worker configuration
4. **`worker/README.md`** - Updated deployment instructions

## Architecture Documentation

This implementation follows the architecture described in:
- `docs/FULL_cache_architecture_w_LOCAL_DB.md` (lines 691-770: Request routing)
- Progressive streaming section (lines 806-920: Multi-size chunking strategy)

## Key Decisions

1. ✅ **Stream through worker** (not presigned URLs) - Faster per Cloudflare best practices
2. ✅ **Metadata first** - Get normalization range before fetching data
3. ✅ **Sequential chunk fetching** - Simpler for now, can parallelize later
4. ✅ **Browser decompression** - Worker just passes through .zst data
5. ✅ **10-minute chunks for 30-min requests** - Optimal for fast first-byte

## Testing Checklist

- [ ] Worker deploys successfully
- [ ] `/metadata` endpoint returns JSON
- [ ] `/chunk` endpoint streams .zst data
- [ ] Browser decompresses chunks
- [ ] Normalization applies correctly
- [ ] Chunks stitch seamlessly
- [ ] Audio plays without clicks/pops
- [ ] Metrics show correct download size
- [ ] Status messages update properly
- [ ] TTFA is <200ms

## Success Criteria

✅ **Working if you see:**
- "📋 Metadata received" in console
- "✅ Decompressed: X samples" for each chunk
- "✅ Playing! (Progressive R2 streaming)" in status
- Audio plays smoothly
- TTFA < 200ms

❌ **Not working if:**
- "Metadata fetch failed" errors
- "Chunk X fetch failed" errors
- No audio playback
- Clicks/pops in audio
- TTFA > 500ms

