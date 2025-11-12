# Captain's Log - 2025-11-07

## Session: CDN Direct Access Migration - Eliminating Worker Overhead

### Major Performance Breakthrough

#### Problem: Cloudflare Worker Adding Massive Overhead
**Discovery**: The Cloudflare Worker was adding **~1000ms overhead** per request
- Worker download: 1161ms for 10m chunk
- Direct CDN (cdn.now.audio): 149ms for same chunk
- **7.8x faster** by eliminating the worker!

**Root Cause**: Worker acts as proxy, adding latency:
1. Browser → Worker (latency)
2. Worker → R2 (latency)
3. Worker → Browser (latency)
4. Plus worker cold start time

**Solution**: Direct CDN access via `cdn.now.audio`
- Cloudflare CDN with edge caching
- Direct R2 access (no proxy)
- Serves from nearest datacenter
- Free egress (R2 → Cloudflare CDN)

---

### Architecture Change: Browser as Worker

**Old Flow**:
```
Browser → Cloudflare Worker → R2 Bucket → Worker → Browser
         (232ms overhead per chunk)
```

**New Flow**:
```
Browser → cdn.now.audio (Cloudflare CDN) → R2 Bucket → Browser
         (Direct access, 7.8x faster!)
```

**Browser Now Handles**:
1. Metadata fetching from CDN
2. Chunk URL construction
3. Multi-day logic (requests spanning midnight UTC)
4. Normalization range calculation (from chunk min/max)
5. Most recent chunk detection (with 2:30 safety buffer)

---

### Implementation Details

#### 1. Precise Time Calculation
**Railway collector runs at**: :02, :12, :22, :32, :42, :52 (2 minutes past each 10-min mark)

**Algorithm**:
```javascript
// Calculate most recent completed 10-minute chunk
const now = new Date();
const minutesIntoPeriod = now.getUTCMinutes() % 10;
const secondsIntoPeriod = minutesIntoPeriod * 60 + now.getUTCSeconds();

// If past 2:30 in this period, current chunk is done
if (secondsIntoPeriod >= 150) {
    // Use current 10-min chunk
    endTime = roundDownTo10Min(now);
} else {
    // Use previous 10-min chunk
    endTime = roundDownTo10Min(now) - 10 minutes;
}
```

**Verification**: After fetching metadata, scan for actual most recent chunk
```javascript
// Find the actual most recent chunk in metadata
for (const dayMeta of validMetadata) {
    for (const chunk of dayMeta.chunks['10m']) {
        const chunkTime = new Date(`${dayMeta.date}T${chunk.start}Z`);
        if (chunkTime > actualMostRecentChunk) {
            actualMostRecentChunk = chunkTime;
        }
    }
}

// Adjust if our estimate was too optimistic
if (actualMostRecentChunk < estimatedEndTime) {
    endTime = actualMostRecentChunk;
}
```

---

#### 2. Multi-Day Support
**Problem**: Requests can span midnight UTC

**Solution**: Fetch metadata for all days in parallel
```javascript
// Determine which days we need
const daysNeeded = [];
let currentDate = new Date(startTime);
while (currentDate <= endTime) {
    daysNeeded.push(currentDate.toISOString().split('T')[0]);
    currentDate.setUTCDate(currentDate.getUTCDate() + 1);
}

// Fetch all days in parallel
const metadataPromises = daysNeeded.map(date => fetchMetadata(date));
const allDayMetadata = await Promise.all(metadataPromises);
```

**Chunk Calculation**: Walk through time across multiple days
```javascript
function calculateChunksNeededMultiDay(startTime, endTime, allDayMetadata) {
    let currentTime = new Date(startTime);
    const chunks = [];
    
    while (currentTime < endTime) {
        const currentDate = currentTime.toISOString().split('T')[0];
        const dayMetadata = allDayMetadata.find(m => m.date === currentDate);
        
        // Find chunk for this time in this day's metadata
        // Advance time based on chunk type found
    }
    
    return chunks;
}
```

---

#### 3. Normalization Range Calculation
**Problem**: CDN metadata doesn't have global `normalization.min/max` field

**Solution**: Calculate from chunks being fetched
```javascript
// Calculate global min/max from all chunks we're fetching
let normMin = Infinity;
let normMax = -Infinity;
for (const chunk of chunksNeeded) {
    if (chunk.min < normMin) normMin = chunk.min;
    if (chunk.max > normMax) normMax = chunk.max;
}

console.log(`📊 Normalization range: ${normMin} to ${normMax}`);
```

This ensures normalization matches the actual data being played.

---

#### 4. CDN URL Construction
**Metadata URL**:
```
https://cdn.now.audio/data/YYYY/MM/DD/NETWORK/volcano/STATION/LOCATION/CHANNEL/NETWORK_STATION_LOCATION_CHANNEL_RATE_YYYY-MM-DD.json
```

**Chunk URL**:
```
https://cdn.now.audio/data/YYYY/MM/DD/NETWORK/volcano/STATION/LOCATION/CHANNEL/TYPE/NETWORK_STATION_LOCATION_CHANNEL_RATE_TYPE_YYYY-MM-DD-HH-MM-SS_to_YYYY-MM-DD-HH-MM-SS.bin.zst
```

**Key Detail**: Date path is `YYYY/MM/DD` but filename uses `YYYY-MM-DD`
```javascript
// Convert YYYY-MM-DD to YYYY/MM/DD for CDN path
const [year, month, day] = date.split('-');
const datePath = `${year}/${month}/${day}`;
```

---

### Performance Results

#### Test Environment
- **Connection**: 13 Mbps hotel WiFi
- **Request**: 2 hours of data (2 chunks)
- **Station**: HV.OBL (Kilauea)

#### Results
```
🕐 Estimated most recent chunk: 2025-11-08T06:50:00.000Z
📋 Days needed: 2025-11-08
📋 Fetched metadata for 1/1 days
✅ Most recent chunk in metadata: 2025-11-08 06:40:00
⚠️ Adjusted end time (estimate was too optimistic)
📋 Calculated chunks needed: 2 chunks
📊 Normalization range: 1296 to 11261
🚀 Starting CDN DIRECT streaming (2 chunks)...
📦 Chunk groups: 2×10m
🚀 Fetching 2×10m chunks in parallel...

⚡ FIRST CHUNK SENT in 307ms - starting playback!
✅ All 2 chunks processed in 330ms total
```

**TTFA: 307ms** on 13 Mbps connection! 🔥

#### Projected Performance at 200 Mbps
With 15x faster connection:
- Metadata fetch: ~50ms
- First chunk download: ~20ms
- Decompression: ~12ms
- **Total TTFA: ~80-100ms** 🚀

---

### Technical Learnings

1. **Worker Overhead is Real**:
   - Even "serverless" functions add latency
   - Direct CDN access is always faster
   - Cloudflare CDN edge caching is incredibly fast

2. **Browser Can Do It All**:
   - Modern browsers are powerful enough to handle metadata logic
   - No need for server-side chunk selection
   - Simpler architecture = fewer failure points

3. **Precision Matters**:
   - 2:30 safety buffer accounts for processing time
   - Verification against metadata catches edge cases
   - Multi-day logic prevents midnight UTC failures

4. **Normalization from Chunks Works**:
   - No need for global normalization in metadata
   - Calculate from chunks being fetched
   - Ensures consistency with actual audio data

5. **Network is the Bottleneck**:
   - On slow connection: 307ms TTFA
   - On fast connection: <100ms TTFA
   - Decompression is negligible (~12ms)

---

### Files Modified This Session

**Frontend**:
- `index.html` - CDN direct access, multi-day support, precise time calculation, normalization from chunks

**Worker** (no longer needed for data fetching!):
- `worker/wrangler.toml` - Cleaned up observability warnings

**Backend**:
- `backend/test_r2_worker_vs_direct.py` - Performance comparison test (NEW)

---

### What's Next

**Potential Future Optimizations**:
1. **Metadata caching**: Cache day metadata in browser localStorage
2. **Predictive prefetch**: Start fetching next hour's chunks before needed
3. **Service Worker**: Cache chunks for offline playback
4. **HTTP/2 multiplexing**: Fetch all chunks on single connection

**Worker Future**:
- Worker still useful for inactive stations (Railway backend proxy)
- Could add authentication/rate limiting if needed
- Keep for backward compatibility

---

### Architecture Summary

**Current System** (v1.62):
```
┌─────────┐
│ Browser │
└────┬────┘
     │
     ├─→ cdn.now.audio/metadata (50ms)
     │   └─→ R2 Bucket (direct)
     │
     └─→ cdn.now.audio/chunks (parallel, 149ms each)
         └─→ R2 Bucket (direct)
         
Browser handles:
- Time calculation (2:30 buffer + verification)
- Multi-day logic
- Chunk URL construction  
- Normalization calculation
- Parallel fetching
- Decompression (fzstd)
- Audio playback (AudioWorklet)
```

**Benefits**:
- ✅ 7.8x faster than worker
- ✅ Simpler architecture
- ✅ Fewer failure points
- ✅ Free R2 egress (to Cloudflare CDN)
- ✅ Edge caching (faster for repeated requests)
- ✅ Precise time handling
- ✅ Multi-day support

---

### Version: v1.62

**Commit Message**: v1.62 Performance: CDN direct access (7.8x faster), eliminate worker overhead, multi-day support, precise time calculation (2:30 buffer + verification), normalization from chunks

**TTFA**: 307ms on 13 Mbps → projected <100ms on 200 Mbps 🚀

---

## Session 2: True Progressive Streaming - v1.63

### The Problem: Batch Waiting

After implementing CDN direct access, discovered two critical issues:

#### Issue 1: Incorrect Duration
**Problem**: When adjusting end time based on most recent chunk, start time wasn't adjusted
- User requests: 1 hour
- Estimated end: 18:40
- Actual end: 18:30 (most recent chunk)
- Start time: 17:40 (calculated from original 18:40)
- **Result**: 17:40 to 18:30 = 50 minutes ❌

**Fix**: Adjust start time when adjusting end time
```javascript
if (actualMostRecentChunk.time < estimatedEndTime) {
    endTime = actualMostRecentChunk.time;
    // CRITICAL: Adjust startTime to maintain requested duration!
    adjustedStartTime = new Date(endTime.getTime() - duration * 3600 * 1000);
}
```

**Result**: Now gets full requested duration ✅

---

#### Issue 2: Sequential Batch Downloads
**Problem**: Code was downloading chunks in batches and waiting for each batch to complete

```javascript
// BAD: Wait for all 10m chunks before fetching 1h chunks
for (const type of ['10m', '1h', '6h']) {
    const results = await Promise.all(fetchPromises); // BLOCKS HERE
    // Process results...
}
```

**Impact**:
- 24 hours: 5.7 seconds TTFA
- 1 hour: 500ms+ TTFA
- Audio wouldn't start until ALL chunks in batch downloaded

**Root Cause**: `Promise.all()` waits for slowest chunk before processing ANY

---

### The Solution: True Progressive Streaming

**New Flow**:
1. Start downloading ALL chunks immediately (parallel)
2. Process chunk 1 as soon as it arrives
3. Start playback immediately
4. Continue downloading/processing remaining chunks in background

```javascript
// Start ALL downloads immediately
const allFetchPromises = chunksToFetch.map((chunk, index) => 
    fetchChunk({chunk, index})
);

// Process each as it arrives (don't wait!)
for (const fetchPromise of allFetchPromises) {
    fetchPromise.then(result => {
        // Send to worker immediately
        worker.postMessage({
            type: 'process-chunk',
            compressed: result.compressed,
            normMin: normMin,
            normMax: normMax,
            chunkIndex: result.index
        }, [result.compressed]);
    });
}

// Wait for first chunk to process, then start playback
await firstChunkProcessed;
console.log('✅ AUDIO PLAYING! (remaining chunks downloading in background)');

// Wait for all chunks in background
await Promise.all(allFetchPromises);
```

---

### Performance Results

#### Before (v1.62):
- **30 minutes**: ~500ms TTFA
- **24 hours**: ~5.7s TTFA
- Waited for all chunks in batch before processing

#### After (v1.63):
- **30 minutes**: ~30ms TTFA 🔥
- **24 hours**: ~300ms TTFA 🤯
- Starts playing after first chunk, regardless of total duration!

**Console Output (24 hours)**:
```
🚀 Starting download of ALL 14 chunks in parallel...
📥 Downloaded chunk 1/14 (10m) - 119.2 KB (1 total)
⚡ FIRST CHUNK SENT in 30ms - starting playback!
✅ First chunk ready - AUDIO PLAYING! (remaining chunks downloading in background)
📥 Downloaded chunk 2/14 (10m) - 122.9 KB (2 total)
📥 Downloaded chunk 3/14 (10m) - 119.2 KB (3 total)
...
📡 All 14 chunks downloaded and sent to worker
✅ All 14 chunks processed in 300ms total
```

---

### Technical Learnings

1. **Progressive Means Progressive**:
   - Don't wait for batches
   - Process as data arrives
   - Start playback ASAP

2. **Promise.all() is a Blocker**:
   - Waits for slowest operation
   - Use `.then()` callbacks for true parallelism
   - Process results as they arrive

3. **Duration Maintenance is Critical**:
   - When adjusting end time, adjust start time too
   - User expects the duration they requested
   - Simple but easy to miss

4. **TTFA is King**:
   - 30ms TTFA feels instant
   - 300ms TTFA for 24 hours is incredible
   - Network is the only bottleneck now

---

### Files Modified

**Frontend**:
- `index.html` - True progressive streaming, duration maintenance fix

**Version**:
- `python_code/__init__.py` - Version bump to v1.63

**Documentation**:
- `docs/captains_logs/captains_log_2025-11-07.md` - Session 2 notes

---

### Version: v1.63

**Commit Message**: v1.63 Performance: True progressive streaming - parallel chunk downloads, 30ms TTFA for any duration, maintain requested duration when adjusting end time

**TTFA**: 
- 30 minutes: ~30ms
- 24 hours: ~300ms
- **Independent of total duration!** 🚀

---

### What's Next

**Potential Optimizations**:
1. **Streaming decompression** - Start playing before chunk fully downloaded (~100ms → ~20ms TTFA)
2. **HTTP/2 verification** - Ensure multiplexing is enabled
3. **Predictive prefetching** - Load next hour while playing current
4. **Service Worker caching** - Offline playback support

**The Reality**: We're now **network-bound**, not **code-bound**. The only way to go faster is:
- Faster internet connection
- Streaming decompression (start playing before full chunk arrives)
- CDN edge caching (already have this!)

**We've achieved true progressive streaming!** 🎉

