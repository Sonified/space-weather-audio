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

**Why no compression locally:**
- Browser CPU overhead for compression/decompression is non-trivial for storage
- IndexedDB storage is cheap and async; disk I/O is faster than recompression
- Raw binary allows zero-copy decoding for playback
- Faster seeking, merging, and visualization — no waiting on decompression threads

**Note on in-memory caching:**
- We do NOT maintain an explicit in-memory cache layer (gains are negligible)
- IndexedDB reads are fast enough (10-50ms per chunk)
- AudioWorklet holds current playback buffer naturally
- JavaScript garbage collection handles memory cleanup automatically

⸻

## Browser IndexedDB Cache: Complete Architecture

This section details the browser's local cache layer, which is the **first stop** for all data requests.

### IndexedDB Schema & Implementation

**Database:** `volcano-seismic-cache`  
**Object Store:** `chunks` (keyPath: `key`)

**Complete IndexedDB API:**

```javascript
// cache-manager.js
class SeismicCacheManager {
  constructor() {
    this.dbName = 'volcano-seismic-cache';
    this.storeName = 'chunks';
    this.db = null;
    this.version = 1;
  }
  
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'key' });
          
          // Indexes for efficient querying
          store.createIndex('start', 'meta.start', { unique: false });
          store.createIndex('end', 'meta.end', { unique: false });
          store.createIndex('network_station', ['meta.network', 'meta.station'], { unique: false });
          store.createIndex('createdAt', 'meta.createdAt', { unique: false });
        }
      };
    });
  }
  
  constructKey(meta) {
    // Self-describing filename serves as the key
    const { network, station, location, channel, sampleRate, start, end } = meta;
    const startStr = start.replace(/[:.]/g, '-').replace('Z', '');
    const endStr = end.replace(/[:.]/g, '-').replace('Z', '');
    return `${network}_${station}_${location}_${channel}_${sampleRate}Hz_${startStr}_to_${endStr}.bin`;
  }
  
  async put(chunk) {
    const key = this.constructKey(chunk.meta);
    const record = {
      key,
      meta: chunk.meta,
      data: chunk.data  // ArrayBuffer (uncompressed int32)
    };
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.storeName], 'readwrite');
      const store = tx.objectStore(this.storeName);
      const request = store.put(record);
      
      request.onsuccess = () => resolve(key);
      request.onerror = () => reject(request.error);
    });
  }
  
  async get(key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.storeName], 'readonly');
      const store = tx.objectStore(this.storeName);
      const request = store.get(key);
      
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  
  async getCoverageForRange(network, station, channel, startTime, endTime) {
    /**
     * Find all cached chunks that overlap [startTime, endTime]
     * Returns: { chunks: [...], coveragePercent: 0-100, missing: [...], canStartPlayback: bool }
     */
    
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.storeName], 'readonly');
      const store = tx.objectStore(this.storeName);
      const results = [];
      
      // Iterate all records (can be optimized with indexes for production)
      const request = store.openCursor();
      
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          const record = cursor.value;
          const { meta } = record;
          
          // Filter by network/station/channel
          if (meta.network === network && 
              meta.station === station && 
              meta.channel === channel) {
            
            // Check if chunk overlaps requested time range
            const chunkStart = new Date(meta.start);
            const chunkEnd = new Date(meta.end);
            const reqStart = new Date(startTime);
            const reqEnd = new Date(endTime);
            
            if (chunkStart < reqEnd && chunkEnd > reqStart) {
              results.push(record);
            }
          }
          
          cursor.continue();
        } else {
          // Cursor exhausted - analyze coverage
          const analysis = this.analyzeCoverage(results, startTime, endTime);
          resolve(analysis);
        }
      };
      
      request.onerror = () => reject(request.error);
    });
  }
  
  analyzeCoverage(chunks, startTime, endTime) {
    /**
     * Determine coverage percentage and missing gaps
     */
    
    if (chunks.length === 0) {
      return {
        chunks: [],
        coveragePercent: 0,
        missing: [{ start: startTime, end: endTime }],
        canStartPlayback: false
      };
    }
    
    // Sort chunks by start time
    chunks.sort((a, b) => new Date(a.meta.start) - new Date(b.meta.start));
    
    const reqStart = new Date(startTime);
    const reqEnd = new Date(endTime);
    const totalDuration = reqEnd - reqStart;
    
    // Calculate covered time ranges
    const covered = [];
    for (const chunk of chunks) {
      const chunkStart = new Date(chunk.meta.start);
      const chunkEnd = new Date(chunk.meta.end);
      
      // Clip to requested range
      const overlapStart = new Date(Math.max(reqStart, chunkStart));
      const overlapEnd = new Date(Math.min(reqEnd, chunkEnd));
      
      if (overlapStart < overlapEnd) {
        covered.push({ start: overlapStart, end: overlapEnd });
      }
    }
    
    // Merge overlapping/adjacent covered ranges
    const merged = this.mergeRanges(covered);
    
    // Calculate coverage percentage
    const coveredDuration = merged.reduce((sum, range) => {
      return sum + (range.end - range.start);
    }, 0);
    const coveragePercent = (coveredDuration / totalDuration) * 100;
    
    // Find missing gaps
    const missing = [];
    let currentTime = reqStart;
    
    for (const range of merged) {
      if (currentTime < range.start) {
        missing.push({
          start: currentTime.toISOString(),
          end: range.start.toISOString()
        });
      }
      currentTime = new Date(Math.max(currentTime, range.end));
    }
    
    if (currentTime < reqEnd) {
      missing.push({
        start: currentTime.toISOString(),
        end: reqEnd.toISOString()
      });
    }
    
    // Playback decision: Can start if we have first 10+ seconds OR >80% coverage
    const hasStart = merged.length > 0 && merged[0].start <= reqStart;
    const hasSufficientBuffer = merged.length > 0 && 
      (merged[0].end - reqStart) >= 10000; // 10 seconds
    const canStartPlayback = hasStart && (hasSufficientBuffer || coveragePercent > 80);
    
    return {
      chunks,
      coveragePercent,
      missing,
      canStartPlayback,
      coveredRanges: merged.map(r => ({
        start: r.start.toISOString(),
        end: r.end.toISOString()
      }))
    };
  }
  
  mergeRanges(ranges) {
    if (ranges.length === 0) return [];
    
    const sorted = ranges.slice().sort((a, b) => a.start - b.start);
    const merged = [sorted[0]];
    
    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i];
      const last = merged[merged.length - 1];
      
      if (current.start <= last.end) {
        // Overlapping or adjacent - merge
        last.end = new Date(Math.max(last.end, current.end));
      } else {
        merged.push(current);
      }
    }
    
    return merged;
  }
  
  async getCacheSize() {
    /**
     * Calculate total cache size by iterating all records and summing byteLength
     * This is called:
     * 1. Once on app initialization (for UI display)
     * 2. After each successful data pull completes (to update UI)
     * 
     * Performance: ~10-50ms for 500 chunks, scales linearly with chunk count
     */
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([this.storeName], 'readonly');
      const store = tx.objectStore(this.storeName);
      const request = store.openCursor();
      
      let totalBytes = 0;
      let chunkCount = 0;
      
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          totalBytes += cursor.value.meta.byteLength;
          chunkCount++;
          cursor.continue();
        } else {
          console.log(`[Cache] Size: ${(totalBytes / 1024 / 1024).toFixed(1)}MB (${chunkCount} chunks)`);
          resolve({ totalBytes, chunkCount });
        }
      };
      
      request.onerror = () => reject(request.error);
    });
  }
}
```

**Note on Cache Eviction:**
For initial implementation, we let the browser handle IndexedDB quota management automatically (LRU eviction). We only calculate cache size for UI display purposes (on app load and after each data pull). This approach is simple and avoids over-engineering. We'll revisit active eviction strategies later if users encounter quota issues in practice.

### Complete Request Flow: From User Click to Playback

```javascript
// playback-controller.js
class PlaybackController {
  constructor() {
    this.cache = new SeismicCacheManager();
    this.audioContext = new AudioContext();
    this.workletNode = null;
  }
  
  async init() {
    await this.cache.init();
    await this.audioContext.audioWorklet.addModule('seismic-audio-processor.js');
    this.workletNode = new AudioWorkletNode(this.audioContext, 'seismic-audio-processor');
    this.workletNode.connect(this.audioContext.destination);
  }
  
  async play(network, station, channel, startTime, durationSeconds) {
    console.log(`[Play] Requesting: ${startTime} + ${durationSeconds}s`);
    
    const endTime = new Date(new Date(startTime).getTime() + durationSeconds * 1000).toISOString();
    
    // STEP 1: Check IndexedDB cache
    console.log('[Cache] Checking IndexedDB...');
    const coverage = await this.cache.getCoverageForRange(
      network, station, channel, startTime, endTime
    );
    
    console.log(`[Cache] Coverage: ${coverage.coveragePercent.toFixed(1)}%`);
    console.log(`[Cache] Can start playback: ${coverage.canStartPlayback}`);
    
    // STEP 2: Decide playback strategy
    if (coverage.coveragePercent === 100) {
      // Full cache hit - instant playback
      console.log('[Cache] ✅ Full cache hit! Playing from IndexedDB...');
      await this.playFromCache(coverage.chunks);
      
    } else if (coverage.canStartPlayback) {
      // Partial cache - start playing cached, request missing in background
      console.log('[Cache] ⚠️ Partial cache. Starting playback with cached data...');
      this.playFromCache(coverage.chunks, { progressive: true });
      
      // Request missing chunks from R2 in background
      console.log('[R2] Requesting missing chunks...');
      await this.requestMissingFromR2(network, station, channel, coverage.missing);
      
    } else {
      // Cache miss or insufficient buffer - must wait for R2
      console.log('[Cache] ❌ Cache miss. Requesting from R2...');
      await this.requestAllFromR2(network, station, channel, startTime, endTime);
    }
  }
  
  async playFromCache(chunks, options = {}) {
    // Assemble chunks into continuous audio buffer
    const audioData = this.assembleChunks(chunks);
    
    // Send to AudioWorklet for playback
    this.workletNode.port.postMessage({
      type: 'loadAudio',
      data: audioData,
      progressive: options.progressive || false
    });
  }
  
  assembleChunks(chunks) {
    /**
     * Stitch multiple chunks into continuous audio buffer
     * Handles gaps, overlaps, and filter warm-up
     */
    
    // Sort by start time
    chunks.sort((a, b) => new Date(a.meta.start) - new Date(b.meta.start));
    
    // Calculate total samples needed
    const totalSamples = chunks.reduce((sum, c) => sum + (c.meta.byteLength / 4), 0);
    const assembled = new Int32Array(totalSamples);
    
    let writeOffset = 0;
    
    for (const chunk of chunks) {
      const chunkData = new Int32Array(chunk.data);
      assembled.set(chunkData, writeOffset);
      writeOffset += chunkData.length;
    }
    
    return assembled.buffer;
  }
  
  async requestMissingFromR2(network, station, channel, missingRanges) {
    /**
     * Request only missing chunks from R2
     * Progressive: As each chunk arrives, add to cache and extend playback
     */
    
    for (const range of missingRanges) {
      const duration = (new Date(range.end) - new Date(range.start)) / 1000;
      
      // Connect to R2 Worker SSE endpoint
      const response = await fetch(`${R2_WORKER_URL}/request-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          network, station, channel,
          starttime: range.start,
          duration
        })
      });
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      
      // Process SSE events
      await this.processSSEStream(reader, decoder);
    }
  }
  
  async processSSEStream(reader, decoder) {
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('event:')) {
          const eventType = line.slice(7).trim();
          // Next line should have data
        } else if (line.startsWith('data:')) {
          const data = JSON.parse(line.slice(5));
          await this.handleSSEEvent(eventType, data);
        }
      }
    }
  }
  
  async handleSSEEvent(type, data) {
    switch(type) {
      case 'metadata_calculated':
        // Update normalization range
        this.workletNode.port.postMessage({
          type: 'updateNormalizationRange',
          min: data.min,
          max: data.max
        });
        break;
        
      case 'chunk_data':
        // Cached chunk from R2 (inline data)
        await this.processChunk(data);
        break;
        
      case 'chunk_uploaded':
        // New chunk (fetch from presigned URL)
        const compressed = await fetch(data.url).then(r => r.arrayBuffer());
        const decompressed = await this.decompressZstd(compressed);
        await this.processChunk({ ...data, data: decompressed });
        break;
        
      case 'range_update':
        // Dynamic normalization update
        this.workletNode.port.postMessage({
          type: 'updateNormalizationRange',
          min: data.min,
          max: data.max
        });
        break;
    }
  }
  
  async processChunk(chunkData) {
    // 1. Write to IndexedDB cache
    await this.cache.put({
      meta: {
        network: chunkData.network,
        station: chunkData.station,
        channel: chunkData.channel,
        start: chunkData.start,
        end: chunkData.end,
        byteLength: chunkData.data.byteLength,
        format: 'int32',
        sampleRate: chunkData.sampleRate,
        createdAt: Date.now()
      },
      data: chunkData.data
    });
    
    // 2. If progressive playback, extend audio buffer
    if (this.progressivePlayback) {
      this.workletNode.port.postMessage({
        type: 'appendAudio',
        data: chunkData.data
      });
    }
  }
  
  async decompressZstd(compressed) {
    // Use fzstd.js or browser-native zstd decompression
    const decompressor = new ZstdDecompressor();
    return await decompressor.decompress(compressed);
  }
}
```

### Cache Size Tracking (For UI Display)

**How Cache Size is Calculated:**
- Iterate through all IndexedDB records with a cursor
- Sum up `meta.byteLength` from each chunk
- Performance: ~10-50ms for 500 chunks (scales linearly)

**When to Update:**
```javascript
// On app initialization
async function initApp() {
  await cache.init();
  
  const { totalBytes, chunkCount } = await cache.getCacheSize();
  updateUI(`Cache: ${(totalBytes / 1024 / 1024).toFixed(1)} MB (${chunkCount} chunks)`);
}

// After each data pull completes
async function handleDataPullComplete() {
  const { totalBytes, chunkCount } = await cache.getCacheSize();
  updateUI(`Cache: ${(totalBytes / 1024 / 1024).toFixed(1)} MB (${chunkCount} chunks)`);
}
```

**Eviction Strategy (Current):**
- Browser automatically manages IndexedDB quota (LRU eviction)
- No active eviction logic needed for initial implementation
- Simple approach avoids over-engineering
- **Future:** Revisit if users encounter quota issues in practice

### Playback Start Decision Logic

**Rules:**
1. ✅ **Full cache hit** (100% coverage) → Start immediately
2. ✅ **Sufficient buffer** (first 10+ seconds cached) → Start with partial cache
3. ✅ **High coverage** (>80% cached) → Start with partial cache
4. ❌ **Insufficient data** → Wait for R2 chunks

**Benefits:**
- ✅ Instant playback for cached data
- ✅ Progressive streaming for partial cache
- ✅ Predictable buffer requirements (10s minimum)
- ✅ No waiting when >80% cached
- ✅ Only requests missing time ranges from R2 (no redundant fetches)

⸻

File Hierarchy Structure

All data on R2 follows this hierarchy with **self-describing filenames**:

```
/data/
  └─ {YEAR}/              # e.g., 2025
      └─ {MONTH}/         # e.g., 10 (zero-padded)
          └─ {NETWORK}/   # e.g., HV (Hawaii Volcano Observatory)
              └─ {VOLCANO}/       # e.g., kilauea, maunaloa
                  └─ {STATION}/   # e.g., NPOC, MLX
                      └─ {LOCATION}/  # e.g., 01, --, 00
                          └─ {CHANNEL}/   # e.g., HHZ, BDF, EHZ
                              ├─ HV_NPOC_01_HHZ_100Hz_2025-10-24-00-00-00_to_2025-10-24-01-00-00.bin.zst
                              ├─ HV_NPOC_01_HHZ_100Hz_2025-10-24-01-00-00_to_2025-10-24-02-00-00.bin.zst
                              ├─ HV_NPOC_01_HHZ_100Hz_2025-10-24-02-00-00_to_2025-10-24-03-00-00.bin.zst
                              ├─ HV_NPOC_01_HHZ_100Hz_2025-10-24.json  # Metadata for entire day
                              └─ ...
```

**Filename Format:**
`{NETWORK}_{STATION}_{LOCATION}_{CHANNEL}_{SAMPLE_RATE}Hz_{START}_to_{END}.bin.zst`

**Examples:**
- Integer sample rate: `HV_NPOC_01_HHZ_100Hz_2025-10-24-00-00-00_to_2025-10-24-01-00-00.bin.zst`
- Fractional sample rate: `AV_PS4A_--_BHZ_40.96Hz_2025-10-24-00-00-00_to_2025-10-24-01-00-00.bin.zst`

**Rationale:**
- **100% unambiguous identification** - Filename contains ALL metadata needed (network, station, location, channel, sample rate, time range)
- **Perfect for IndexedDB keys** - Filename alone is the unique identifier
- **Easier debugging** - Logs show exactly what station/channel/sample rate is being processed
- **Handles edge cases** - Same channel can theoretically have different sample rates (rare but possible)
- **Natural filtering** - Easy to query "give me all 100Hz files" without loading metadata
- **Mirrors SEED identifier structure** (Network.Station.Location.Channel + sample rate)
- **Network → Volcano ordering** (networks monitor multiple volcanoes)
- **Each level is easily queryable**
- **No arbitrary groupings** - clean, scalable hierarchy
- **Directory structure provides organization** while filename provides complete context
- **Flatter storage possible** if needed (could store all chunks in /data/chunks/ if hierarchy becomes complex)
- **Still well under filename limits** (~70 characters vs 255 limit)

⸻

## Updated Architecture Flow (Oct 30, 2025)

```
User requests time range
  ↓
Browser checks IndexedDB
  ↓ (partial/miss)
Browser → R2 Worker (SSE stream request)
  ↓
R2 Worker checks R2 Storage for metadata
  ↓ (cache miss)
R2 Worker → Render (forwards request, maintains SSE connection)
  ↓
Render:
  1. Fetch from IRIS (24h chunks, retry with half duration on fail)
  2. Dedupe, gap-fill, int32 conversion
  3. **IMMEDIATELY generate metadata** (global min/max)
  4. **SEND metadata_calculated SSE event** ← FAST START!
     (Browser receives via R2 Worker SSE proxy)
     (Browser now has normalization range, can prepare UI)
  5. Break into multi-size chunks and compress with Zstd level 3:
     - **10-minute chunks**: 144 per day (for very recent data, fastest first-byte)
     - **1-hour chunks**: 24 per day (hours 0-5, fast playback start)
     - **6-hour chunks**: 4 per day (hours 6-23, efficiency)
     - **24-hour chunks**: 1 per day (long-term storage)
     ✅ All sizes created and uploaded to R2, Worker selects optimal size based on request duration
  6. For each chunk as it's ready:
     - Upload compressed chunk to R2 Storage
     - Generate presigned URL (1-hour expiry)
     - Send chunk_uploaded SSE event with presigned URL
  7. Upload metadata to R2 (one .json per day)
  ↓
Browser receives SSE events progressively:
  - CACHED chunks: Receives chunk_data events with inline binary data (instant, no extra fetch)
  - MISSING chunks: Receives chunk_uploaded events with presigned URLs → fetches from R2
  - Progressive streaming (not waiting for all chunks to finish)
  - Cached chunks arrive instantly, missing chunks arrive as created
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
- ✅ Multi-size chunks: 10min (recent data), 1h (fast start), 6h (efficiency), 24h (long-term)
- ✅ Worker selects optimal chunk size based on request duration (10min for ≤600s, 1h for ≤3600s, etc.)
- ✅ Browser decompresses locally (Workers don't decompress - just storage/routing)
- ✅ Zstd compression saves 56% on storage + egress
- ✅ **Hybrid chunk delivery:** Cached chunks sent as inline data (instant), missing chunks via presigned URLs (progressive)
- ✅ Request routing: Browser→R2 Worker(SSE)→Render, optimized for partial cache scenarios
- ✅ **Dynamic normalization SOLVED:** Worker calculates range from overlapping chunks, AudioWorklet smoothly transitions
- ✅ **Gap metadata SOLVED:** Stored once per day, per-chunk quick stats for instant quality checks
- ⚠️ Outstanding: Logic for beginning playback when some data is missing (how much buffer is needed?)
- ⚠️ Outstanding: Test progressive streaming of decompressed data
- ⚠️ Outstanding: Test filter warm-up for seamless stitching
- 💡 **OPTIMIZATION: IRIS MUSTANG API** - Pre-calculated min/max for historical data (>2 days old) in 500ms vs 2000ms

⸻

Request Routing: Browser ↔ R2 Worker ↔ Render ↔ R2 Storage

The routing layer coordinates between browser, R2 Worker (Cloudflare Worker), Render processing, and R2 Storage.

**Architecture:**
```
BROWSER          R2 WORKER              RENDER              R2 STORAGE
   |                  |                     |                     |
   | SSE Request      |                     |                     |
   |---------------> |                     |                     |
   |                  | Check cache         |                     |
   |                  |-----------------------------------> |
   |                  |                     | (cache MISS)        |
   |                  | Forward via SSE     |                     |
   |                  |-----------------> |                     |
   |                  |                     |                     |
   |                  | SSE: metadata       |                     |
   |<-----------------|<------------------|                     |
   |                  |                     | Upload chunk        |
   |                  |                     |-------------------> |
   |                  | SSE: chunk_ready    |                     |
   |<-----------------|<------------------|                     |
   |                  |                     |                     |
   | HTTP GET chunk (presigned URL)                              |
   |-------------------------------------------------------------> |
   | Chunk data                                                   |
   |<------------------------------------------------------------|
```

Flow:
	1.	Browser initiates SSE stream request to R2 Worker:

POST /request-stream
{
  "network": "HV",
  "station": "NPOC",
  "location": "",
  "channel": "HHZ",
  "starttime": "2025-10-24T00:00:00Z",
  "duration": 86400
}

	2.	R2 Worker checks R2 Storage for cached chunks:
	•	Full cache HIT → streams all chunks inline via SSE (instant)
	•	Full cache MISS → forwards request to Render
	•	Partial cache → hybrid: streams cached chunks inline, forwards request for missing chunks

	3.	For CACHED chunks (R2 Worker):
	•	Fetches from R2 Storage immediately
	•	Sends chunk_data SSE event with inline binary data
	•	Browser receives data instantly (no extra HTTP request)

	4.	For MISSING chunks (Render):
	•	Fetches from IRIS
	•	Calculates metadata → sends metadata_calculated SSE event (proxied via R2 Worker)
	•	Creates chunks progressively
	•	For each chunk: Upload to R2 → Generate presigned URL → Send chunk_uploaded event (proxied via R2 Worker)

	5.	Browser receives progressive SSE events (hybrid):
	•	metadata_calculated → {min: -1523, max: 1891, npts: 8640000}
	•	chunk_data → {type: '1h', index: 0, data: <binary>, cached: true} (instant - no extra fetch)
	•	chunk_uploaded → {type: '1h', index: 3, url: 'presigned_url', cached: false} (fetches from URL)
	•	Cached chunks: 0 extra latency
	•	Missing chunks: Fetched as they become available

	6.	Browser decompresses locally and processes

**Key Implementation Details:**
- ✅ **Hybrid chunk delivery** - Optimized for partial cache scenarios
  - Cached chunks: R2 Worker sends inline data via SSE (0 extra latency)
  - Missing chunks: Render generates presigned URLs, browser fetches separately
- ✅ **R2 Worker handles cached data** - Fetches from R2 Storage and streams inline
- ✅ **Render generates presigned URLs** - Only for newly created chunks
- ✅ **Progressive streaming** - Cached chunks instant, missing chunks arrive as created
- ✅ **Presigned URLs** - Secure, time-limited access (1-hour expiry, generated by Render)
- ✅ **SSE enables real-time progress** - Dashboard updates as pipeline progresses
- ✅ **Partial cache optimization** - Most common scenario (some data cached, some fresh)
- ⚠️ **Dynamic normalization needed** - Partial cache requires handling metadata that arrives after cached chunks
- 💡 **MUSTANG optimization** - Query IRIS MUSTANG API first for historical data (500ms vs 2s)

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

**One metadata file per day** containing information for all multi-size chunks.

## Phase 1 Implementation (Current)

**Single metadata file:** `2025-10-24.json` (~8-15 KB)

```json
{
  "date": "2025-10-24",
  "network": "HV",
  "volcano": "kilauea",
  "station": "NPOC",
  "location": "01",
  "channel": "HHZ",
  "instrument_type": "STS-2",
  "sample_rate": 100.0,
  "latitude": 19.123,
  "longitude": -155.456,
  "elevation_m": 1200,
  "created_at": "2025-10-24T02:15:33.123456Z",
  "complete_day": true,
  
  "chunks": {
    "10min": [
      {
        "start": "00:00:00",
        "end": "00:10:00",
        "min": -100,
        "max": 200,
        "samples": 60000,
        "gap_count": 0,
        "gap_duration_seconds": 0,
        "gap_samples_filled": 0
      },
      {
        "start": "01:20:00",
        "end": "01:30:00",
        "min": -150,
        "max": 250,
        "samples": 60000,
        "gap_count": 2,
        "gap_duration_seconds": 4.656,
        "gap_samples_filled": 466
      }
      // ... 142 more 10-min chunks
    ],
    
    "1h": [
      {
        "start": "00:00:00",
        "end": "01:00:00",
        "min": -200,
        "max": 300,
        "samples": 360000,
        "gap_count": 0,
        "gap_duration_seconds": 0,
        "gap_samples_filled": 0
      },
      {
        "start": "01:00:00",
        "end": "02:00:00",
        "min": -250,
        "max": 350,
        "samples": 360000,
        "gap_count": 2,
        "gap_duration_seconds": 4.656,
        "gap_samples_filled": 466
      }
      // ... 22 more hourly chunks
    ],
    
    "6h": [
      {
        "start": "00:00:00",
        "end": "06:00:00",
        "min": -300,
        "max": 400,
        "samples": 2160000,
        "gap_count": 3,
        "gap_duration_seconds": 10.101,
        "gap_samples_filled": 1010
      }
      // ... 3 more 6-hour chunks
    ],
    
    "24h": [
      {
        "start": "00:00:00",
        "end": "24:00:00",
        "min": -500,
        "max": 600,
        "samples": 8640000,
        "gap_count": 5,
        "gap_duration_seconds": 18.789,
        "gap_samples_filled": 1879
      }
    ]
  }
  
  // NO detailed gaps array in Phase 1
  // See Phase 2 below for future detailed gap tracking
}
```

**Key Fields:**

**Global metadata:**
- `complete_day`: `true` if all 24 hours available (false for partial/live data)
- `instrument_type`, `latitude`, `longitude`, `elevation_m`: Station metadata from IRIS
- File URLs are **derived** from hierarchy, not stored in metadata

**Multi-size chunks structure:**
- `chunks.10min[]`: 144 chunks (for recent data, fast first-byte)
- `chunks.1h[]`: 24 chunks (hours 0-5, fast playback start)
- `chunks.6h[]`: 4 chunks (hours 6-23, efficiency)
- `chunks.24h[]`: 1 chunk (long-term storage)

**Per-chunk fields:**
- `start`/`end`: Time boundaries (HH:MM:SS format, used to construct URL)
- `min`/`max`: **Critical for fast normalization** without loading data
- `samples`: Expected sample count (for validation)
- `gap_count`: Quick quality check (0 = pristine data)
- `gap_duration_seconds`: Total interpolated time in this chunk
- `gap_samples_filled`: Total interpolated samples in this chunk

**Phase 1 Benefits:**
- ✅ Single file to manage (~8-15 KB stays small)
- ✅ Fast quality checks via gap_count (0 = pristine data)
- ✅ Total interpolated time visible per chunk
- ✅ Covers 95% of use cases
- ✅ Simple to implement

**Metadata size (Phase 1):** ~8-15 KB per day (173 chunk objects with gap summaries)

## Phase 2 Implementation (Future - Not Yet Implemented)

**When detailed gap audit trail is needed**, split into two files:

**Main metadata:** `2025-10-24.json` (unchanged from Phase 1, ~8-15 KB)

**Gap details (lazy-loaded):** `2025-10-24_gaps.json` (~2-100 KB, only loaded when user clicks "Show Data Quality")

```json
{
  "date": "2025-10-24",
  "network": "HV",
  "station": "NPOC",
  "location": "01",
  "channel": "HHZ",
  "gaps": [
    {
      "start": "2025-10-24T01:23:45.678Z",
      "end": "2025-10-24T01:23:46.789Z",
      "duration_seconds": 1.111,
      "samples_filled": 111
    },
    {
      "start": "2025-10-24T01:27:12.345Z",
      "end": "2025-10-24T01:27:15.890Z",
      "duration_seconds": 3.545,
      "samples_filled": 355
    }
    // ... all gaps with precise timestamps
  ]
}
```

**Phase 2 Benefits (when implemented):**
- ✅ Main metadata stays tiny (always 8-15 KB)
- ✅ Gap details lazy-loaded (only when user needs quality analysis)
- ✅ Complete audit trail of all interpolated data
- ✅ 99% of requests never load gap details
- ✅ Full ISO 8601 timestamps for precision

**Implementation trigger:** Only add Phase 2 when users actually need detailed gap analysis for quality control or scientific validation.

⸻

Worker: Chunk Selection & Dynamic Normalization

**R2 Worker responsibilities:**
1. Read metadata from R2 Storage (single read, ~10ms)
2. Select optimal chunk size based on request duration
3. Calculate normalization range from overlapping chunks only
4. Check which chunks are cached vs missing
5. Stream cached chunks inline, forward missing chunks to Render

**Complete Worker Logic:**

```javascript
async function handleRequest(request) {
  const { network, station, channel, starttime, duration } = request;
  
  // 1. Fetch metadata from R2 (single read)
  const date = starttime.split('T')[0]; // "2025-10-24"
  const metadataKey = constructMetadataPath(network, station, channel, date);
  const metadata = await r2.get(metadataKey).json();
  
  // 2. Select optimal chunk size based on duration
  const chunkSize = selectChunkSize(duration);
  // duration <= 600s → "10min"
  // duration <= 3600s → "1h"
  // duration <= 21600s → "6h"
  // duration > 21600s → "24h"
  
  // 3. Filter chunks overlapping requested time range
  const overlapping = metadata.chunks[chunkSize].filter(
    c => overlaps(c, starttime, duration)
  );
  
  // 4. Calculate normalization range from ONLY the overlapping chunks
  const range = {
    min: Math.min(...overlapping.map(c => c.min)),
    max: Math.max(...overlapping.map(c => c.max))
  };
  
  // 5. Check which chunks are cached vs missing
  const cached = [];
  const missing = [];
  for (const chunk of overlapping) {
    const chunkKey = constructChunkPath(metadata, chunk);
    const exists = await r2.head(chunkKey);
    if (exists) {
      cached.push({ chunk, key: chunkKey });
    } else {
      missing.push(chunk);
    }
  }
  
  // 6. Send immediate metadata response
  await sendSSE('metadata_calculated', {
    min: range.min,
    max: range.max,
    partial: missing.length > 0,
    cached_count: cached.length,
    missing_count: missing.length
  });
  
  // 7. Stream cached chunks inline immediately (0 extra latency)
  for (const { chunk, key } of cached) {
    const compressed = await r2.get(key).arrayBuffer();
    await sendSSE('chunk_data', {
      type: chunkSize,
      start: chunk.start,
      end: chunk.end,
      data: compressed,
      cached: true
    });
  }
  
  // 8. Forward missing chunks to Render (if any)
  if (missing.length > 0) {
    await forwardToRender({
      network, station, channel,
      starttime, duration,
      missing_chunks: missing
    });
  }
}

function selectChunkSize(duration) {
  if (duration <= 600) return '10min';
  if (duration <= 3600) return '1h';
  if (duration <= 21600) return '6h';
  return '24h';
}

function overlaps(chunk, starttime, duration) {
  const chunkStart = new Date(`${metadata.date}T${chunk.start}Z`);
  const chunkEnd = new Date(`${metadata.date}T${chunk.end}Z`);
  const reqStart = new Date(starttime);
  const reqEnd = new Date(reqStart.getTime() + duration * 1000);
  
  return chunkStart < reqEnd && chunkEnd > reqStart;
}

function constructChunkPath(metadata, chunk) {
  // URLs derived from hierarchy, not stored in metadata
  // Filename is self-describing: NETWORK_STATION_LOCATION_CHANNEL_SAMPLERATEHz_START_to_END.bin.zst
  const { network, volcano, station, location, channel, sample_rate, date } = metadata;
  const [year, month, day] = date.split('-');
  const startISO = `${date}-${chunk.start.replace(/:/g, '-')}`;
  const endISO = `${date}-${chunk.end.replace(/:/g, '-')}`;
  const filename = `${network}_${station}_${location}_${channel}_${sample_rate}Hz_${startISO}_to_${endISO}.bin.zst`;
  
  return `/data/${year}/${month}/${network}/${volcano}/${station}/${location}/${channel}/${filename}`;
}
```

**Dynamic Normalization: The Dance**

**Scenario A: Full cache hit (instant playback)**
```
1. Browser requests hours 0-2
2. Worker fetches metadata (10ms)
3. Worker finds all chunks cached
4. Worker calculates range from chunks 0-2:
   min = min(-200, -250, -180) = -250
   max = max(300, 350, 280) = 350
5. Worker streams all chunks inline via SSE with range
6. Browser receives first chunk + range → playback starts immediately
```

**Scenario B: Partial cache (dynamic range adjustment)**
```
1. Browser requests hours 0-6
2. Worker finds hours 0-2 cached, 3-5 missing
3. Worker calculates PARTIAL range from cached chunks only:
   range = {min: -250, max: 350, partial: true}
4. Worker streams cached chunks inline + sends partial range
5. Browser starts playback with partial range
6. Worker forwards request to Render for missing chunks
7. Render processes hours 3-5, finds wider range:
   - Hour 3: min=-300, max=420
   - Hour 4: min=-280, max=400  
   - Hour 5: min=-290, max=410
8. Render sends SSE: range_update → {min: -300, max: 420}
9. Browser AudioWorklet smoothly transitions normalization range
```

⸻

AudioWorklet: Dynamic Normalization with Smooth Transitions

When the normalization range changes mid-playback (partial cache scenario), the AudioWorklet must transition smoothly to prevent audible clicks/pops.

```javascript
// seismic-audio-processor.js (AudioWorklet)
class SeismicAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.currentMin = 0;
    this.currentMax = 1;
    this.targetMin = 0;
    this.targetMax = 1;
    this.transitionSamples = 1024; // ~21ms at 48kHz
    this.transitionProgress = 0;
    this.inTransition = false;
    
    this.port.onmessage = (e) => {
      if (e.data.type === 'updateNormalizationRange') {
        this.updateNormalizationRange(e.data.min, e.data.max);
      }
    };
  }
  
  updateNormalizationRange(newMin, newMax) {
    console.log(`[AudioWorklet] Updating normalization: [${newMin}, ${newMax}]`);
    
    // If first time (currentMin/Max are defaults), set immediately
    if (this.currentMin === 0 && this.currentMax === 1) {
      this.currentMin = newMin;
      this.currentMax = newMax;
      this.targetMin = newMin;
      this.targetMax = newMax;
      return;
    }
    
    // Otherwise, transition smoothly
    this.targetMin = newMin;
    this.targetMax = newMax;
    this.transitionProgress = 0;
    this.inTransition = true;
  }
  
  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const channel = output[0];
    
    for (let i = 0; i < channel.length; i++) {
      // Smooth transition if in progress
      if (this.inTransition && this.transitionProgress < this.transitionSamples) {
        const alpha = this.transitionProgress / this.transitionSamples;
        // Ease-in-out cubic for smooth transition
        const t = alpha < 0.5 
          ? 4 * alpha * alpha * alpha 
          : 1 - Math.pow(-2 * alpha + 2, 3) / 2;
        
        this.currentMin = lerp(this.currentMin, this.targetMin, t);
        this.currentMax = lerp(this.currentMax, this.targetMax, t);
        this.transitionProgress++;
        
        if (this.transitionProgress >= this.transitionSamples) {
          this.inTransition = false;
          this.currentMin = this.targetMin;
          this.currentMax = this.targetMax;
        }
      }
      
      // Normalize using current range (which is smoothly transitioning)
      const sample = this.sampleBuffer[this.bufferIndex++];
      const normalized = (sample - this.currentMin) / (this.currentMax - this.currentMin);
      const clipped = Math.max(-1, Math.min(1, (normalized * 2) - 1)); // Map [0,1] → [-1,1]
      channel[i] = clipped;
    }
    
    return true;
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

registerProcessor('seismic-audio-processor', SeismicAudioProcessor);
```

**Browser Integration:**
```javascript
// When receiving range_update event from Render
eventSource.addEventListener('range_update', (e) => {
  const { min, max } = JSON.parse(e.data);
  console.log(`[Browser] Normalization range updated: [${min}, ${max}]`);
  
  // Send to AudioWorklet for smooth transition
  audioWorkletNode.port.postMessage({
    type: 'updateNormalizationRange',
    min, max
  });
});
```

**Benefits:**
- ✅ Smooth 1024-sample transition (~21ms at 48kHz) prevents clicks/pops
- ✅ Ease-in-out cubic curve for natural volume adjustment
- ✅ Inaudible to listener (gradual normalization change)
- ✅ Handles partial cache elegantly (start with partial range, widen when data arrives)

⸻

Complete End-to-End Flow

### Scenario 1: Cache Hit (R2 Already Has Data)

```
User clicks "Play 3 hours from 2025-10-24 00:00" in browser
  ↓
Browser checks IndexedDB for time range
  ↓ (miss)
Browser → R2 Worker (SSE stream request):
  POST /request-stream
  {network: HV, station: NPOC, channel: HHZ, starttime: 2025-10-24T00:00:00Z, duration: 10800}
  ↓
R2 Worker checks R2 Storage for cached metadata:
  - Metadata: /data/2025/10/HV/kilauea/NPOC/01/HHZ/2025-10-24.json
  - Hour 0: 2025-10-24-00-00-00_to_2025-10-24-01-00-00.bin.zst
  - Hour 1: 2025-10-24-01-00-00_to_2025-10-24-02-00-00.bin.zst
  - Hour 2: 2025-10-24-02-00-00_to_2025-10-24-03-00-00.bin.zst
  ↓ (cache hit!)
R2 Worker sends SSE event with metadata:
  SSE: r2_cache_hit → {global_min: -1523, global_max: 1891, total_samples: 1080000, sample_rate: 100}
  ↓
Browser receives metadata (instant) → Prepares for playback
  ↓
R2 Worker fetches chunks from R2 Storage and streams inline:
  SSE: chunk_data → {type: '1h', index: 0, data: <binary compressed chunk>, cached: true}
  SSE: chunk_data → {type: '1h', index: 1, data: <binary compressed chunk>, cached: true}
  SSE: chunk_data → {type: '1h', index: 2, data: <binary compressed chunk>, cached: true}
  ↓
Browser receives first chunk immediately (inline in SSE):
  No extra HTTP request needed - data already in event
  ↓
Browser processes first chunk:
  1. Decompress .zst locally (2-36ms)
  2. High-pass filter (0.1 Hz)
  3. Normalize using metadata range
  4. Schedule playback → **PLAYBACK STARTS** (50-100ms total)
  ↓
Browser continues receiving remaining chunks inline while hour 0 plays:
  Receives hour 1 chunk inline via SSE
  Receives hour 2 chunk inline via SSE
  ↓
Browser processes each chunk as it arrives:
  - Decompress .zst locally
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
- 0-20ms: Request → R2 Worker → Metadata SSE event sent
- 20-30ms: Browser receives metadata
- 30-50ms: R2 Worker fetches hour 0 from R2 Storage, sends inline via SSE
- 50-70ms: Browser receives first chunk (inline, no extra fetch) → Decompresses → Filters → **AUDIO STARTS**
- 70ms-1h: Hour 0 plays (3600s) while browser receives hours 1-2 inline via SSE
- 1h-3h: Hours 1-2 play (7200s) while browser receives remaining chunks
- Progressive: Chunks streamed inline as browser plays earlier chunks
- All chunks cached in IndexedDB for instant future playback

### Scenario 2: Partial Cache (Hybrid - Most Common!)

```
User clicks "Play 6 hours from 2025-10-24 00:00" in browser
  ↓
Browser → R2 Worker (SSE stream request):
  POST /request-stream
  {network: HV, station: NPOC, channel: HHZ, starttime: 2025-10-24T00:00:00Z, duration: 21600}
  ↓
R2 Worker checks R2 Storage for cached metadata:
  - Hours 0-2: EXIST ✅ (cached from previous request)
  - Hours 3-5: MISSING ❌ (need to fetch from IRIS)
  ↓ (partial cache!)
R2 Worker sends SSE event with metadata:
  SSE: r2_partial_cache → {global_min: -1523, global_max: 1891, cached_hours: [0,1,2], missing_hours: [3,4,5]}
  ↓
R2 Worker immediately streams CACHED chunks inline:
  SSE: chunk_data → {type: '1h', index: 0, data: <binary>, cached: true}
  SSE: chunk_data → {type: '1h', index: 1, data: <binary>, cached: true}
  SSE: chunk_data → {type: '1h', index: 2, data: <binary>, cached: true}
  (Browser receives these instantly - 0 extra latency)
  ↓
SIMULTANEOUSLY, R2 Worker → Render for missing hours:
  Forwards request for hours 3-5 to Render
  ↓
Render processes missing hours:
  1. Fetch from IRIS
  2. Process data
  3. For each missing chunk:
     - Upload to R2 Storage
     - Generate presigned URL
     - Send chunk_uploaded SSE event
  ↓
Browser receives MISSING chunks via presigned URLs:
  SSE: chunk_uploaded → {type: '1h', index: 3, url: 'presigned_url', cached: false}
  Browser fetches hour 3 from R2 Storage
  SSE: chunk_uploaded → {type: '1h', index: 4, url: 'presigned_url', cached: false}
  Browser fetches hour 4 from R2 Storage
  SSE: chunk_uploaded → {type: '1h', index: 5, url: 'presigned_url', cached: false}
  Browser fetches hour 5 from R2 Storage
  ↓
Browser processes all chunks:
  - Cached chunks: Already have data, decompress immediately
  - Missing chunks: Fetch as they arrive, then decompress
  - All chunks stitched seamlessly with filter warm-up
  - **PLAYBACK STARTS** as soon as first chunk (hour 0) is ready
```

**Timeline:**
- 0-20ms: Request → R2 Worker → Metadata SSE event sent
- 20-40ms: Browser receives metadata + hours 0-2 inline (instant!)
- 40-60ms: Browser decompresses hour 0 → Filters → **AUDIO STARTS**
- 60ms-1h: Hour 0 plays while browser processes hours 1-2 (already received)
- Meanwhile: Render processing hours 3-5 (IRIS fetch, compress, upload)
- 2h+: Hours 3-5 arrive via presigned URLs as they finish processing
- Result: Playback starts immediately using cached data, seamlessly transitions to new data

**Why this is optimal:**
- ✅ Cached data: 0 extra latency (inline streaming)
- ✅ Missing data: Generated in parallel while cached data plays
- ✅ Playback starts immediately (doesn't wait for missing chunks)
- ✅ Seamless experience (user doesn't know some data was cached, some was fresh)

⚠️ **Outstanding: Dynamic normalization handling** - Cached chunks arrive instantly but global min/max calculation requires ALL data (including missing chunks that take 1-3 seconds to fetch from IRIS). Need to implement intelligent solution, e.g. progressive normalization strategy.

**💡 SOLUTION for HISTORICAL DATA: IRIS MUSTANG for Fast Metadata**

IRIS maintains a **MUSTANG (Modular Utility for STAtistical kNowledge Gathering)** system that pre-calculates quality metrics on all archived seismic data, including daily min/max amplitude values!

**Key Metrics:**
- `sample_min`: Smallest amplitude value in counts (24-hour window)
- `sample_max`: Largest amplitude value in counts (24-hour window)

**API Example:**
```bash
GET https://service.iris.edu/mustang/measurements/1/query?
  metric=sample_min,sample_max&
  net=HV&sta=NPOC&loc=--&cha=HHZ&
  start=2025-10-22&end=2025-10-23&
  format=json
```

**Performance (Tested):**
- ✅ Historical data (>2 days old): **500-1000ms** (vs 1800-2200ms for full download)
- ✅ Returns full 24-hour ranges (wider is safer for normalization)
- ❌ Very recent data (<2 days): **404** (metrics not calculated yet)

**Architecture Integration:**
```
For HISTORICAL data (>2 days old):
  1. Query MUSTANG first (~500ms)
  2. If available → send metadata immediately
  3. Continue with chunk processing

For RECENT data (<2 days old):
  1. MUSTANG returns 404
  2. Use first chunk for provisional min/max
  3. Send provisional metadata to browser
  4. Calculate final min/max from all chunks
  5. Send updated metadata (browser adjusts normalization smoothly)
```

**Benefits:**
- ✅ 99% of volcano monitoring queries are historical analysis
- ✅ Metadata in 500ms instead of 2+ seconds
- ✅ Solves partial cache normalization problem for most use cases
- ✅ Free API, already calculated by IRIS for quality control

### Scenario 3: Full Cache Miss (R2 Needs to Generate from IRIS)

```
User clicks "Play 3 hours from 2025-10-29 00:00" (recent data, not yet cached)
  ↓
Browser → R2 Worker (SSE stream request)
  POST /request-stream
  {network: HV, station: NPOC, channel: HHZ, starttime: 2025-10-29T00:00:00Z, duration: 10800}
  ↓
R2 Worker checks R2 Storage for cached metadata
  ↓ (cache miss!)
R2 Worker → Render (forwards request via SSE):
  Maintains open SSE connection to proxy events
  ↓
Render Backend:
  1. Fetch MiniSEED files from IRIS (1-3 seconds)
  2. Load with ObsPy → Merge/deduplicate → Fill gaps (100-200ms)
  3. Convert to int32 (10ms)
  4. Round to second boundaries (1ms)
  5. Calculate global min/max for normalization (10ms)
  ↓
  6. **SEND METADATA SSE EVENT IMMEDIATELY** (fast path!)
     SSE: metadata_calculated → {min: -1523, max: 1891, npts: 1080000, sample_rate: 100}
     Browser receives via R2 Worker proxy
     Browser now knows normalization range and can prepare for playback!
  ↓
  7. Break into 3 hourly chunks (50ms)
  8. Compress each chunk with Zstd level 3 (parallel: ~50ms each)
  9. For each chunk as it finishes:
     - Upload compressed chunk to R2 Storage (200-500ms)
     - Generate presigned URL (1-hour expiry) [Render does this]
     - Send chunk_uploaded SSE event with URL (proxied via R2 Worker to browser)
  10. Upload metadata .json to R2 (10ms)
  ↓
Browser receives progressive SSE events:
  SSE: chunk_uploaded → {type: '1h', index: 0, url: 'https://...hour0.zst?presigned', cached: false}
  (Render generated the presigned URL, R2 Worker proxies the event)
  ↓
Browser fetches first NEW chunk from R2 Storage:
  HTTP GET to presigned URL → receives compressed .zst chunk
  ↓
Browser processes first chunk:
  1. Decompress .zst locally (2-36ms)
  2. High-pass filter (0.1 Hz cutoff)
  3. Normalize using metadata range
  4. Schedule playback → **AUDIO STARTS!**
  ↓
Browser continues receiving SSE events and fetching NEW chunks while hour 0 plays:
  SSE: chunk_uploaded → {type: '1h', index: 1, url: '...hour1.zst?presigned'}
  Browser fetches hour 1 from R2 Storage via presigned URL
  SSE: chunk_uploaded → {type: '1h', index: 2, url: '...hour2.zst?presigned'}
  Browser fetches hour 2 from R2 Storage via presigned URL
  ↓
Browser processes each chunk as it arrives:
  - Decompress .zst locally
  - "Warm up" filter (last 1024 samples from previous chunk)
  - Filter current chunk
  - Stitch seamlessly to previous audio
  - Continue seamless playback
  ↓
Browser caches all chunks in IndexedDB (uncompressed int32)
R2 Storage now has cached chunks for future requests
```

**Timeline:**
- 0-1.5s: IRIS fetch + processing
- **1.5s: Metadata SSE event sent to browser** → Browser ready!
- 1.5-2.0s: First chunk compressed + uploaded to R2, chunk_uploaded SSE event sent
- 2.0-2.2s: Browser fetches first chunk from R2 Storage (via presigned URL)
- 2.2-2.5s: Browser decompresses → Filters → **PLAYBACK STARTS**
- 2.5s-1h: Hour 0 plays (3600s) while:
  - Render continues compressing/uploading remaining chunks
  - Browser receives chunk_uploaded SSE events
  - Browser progressively fetches chunks from R2 Storage
- Progressive: Chunks processed and fetched as they become available
- All chunks cached in R2 Storage and IndexedDB

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
   - Multi-size chunks: 10min (recent), 1h (hours 0-5), 6h (hours 6-23), 24h (beyond)
   - No Worker decompression needed - browsers handle zstd efficiently

2. **Stitching chunks with high-pass filtering:**
   - Need to test if stitching creates clicks at chunk boundaries
   - Solution: "Warm up" filter using last 1024 samples from previous chunk
   - Prepend to current chunk, filter combined data, discard first 1024 samples
   - **CRITICAL: Must test this approach before implementation**

3. **Dynamic normalization for partial cache:**
   - ✅ **SOLVED:** Worker calculates range from overlapping chunks only
   - ✅ Partial cache: Worker sends partial range, Render sends range_update when final range calculated
   - ✅ AudioWorklet smoothly transitions normalization over 1024 samples (~21ms at 48kHz)
   - ✅ Ease-in-out cubic curve prevents audible clicks/pops
   - See "AudioWorklet: Dynamic Normalization with Smooth Transitions" section above

4. **Gap metadata architecture:**
   - ✅ **DECIDED:** Gaps stored once at day level, per-chunk quick stats only
   - ✅ 75% reduction in metadata size vs duplicating gaps across chunk sizes
   - ✅ Fast quality checks via gap_count without filtering
   - ✅ Lazy loading of gap details when UI needs them (rare)
   - See "Metadata JSON Format" section above

⸻

Summary

This architecture provides:
- **Fast playback start** via early metadata delivery + per-chunk min/max normalization
- **Multi-size chunking** (10min/1h/6h/24h) optimizes for different playback scenarios
- **Dynamic normalization** with smooth AudioWorklet transitions (partial cache support)
- **Browser-side decompression** (2-36ms) + filtering for maximum flexibility
- **Parallel fetches** from R2 (no sequential bottleneck)
- **56% cost savings** via Zstd compression (storage + egress)
- **Instant replay** via IndexedDB caching (uncompressed for speed)
- **Lossless int32 fidelity** preserved throughout pipeline
- **Sample-accurate reconstruction** via time-to-index calculation
- **Second-boundary alignment** for seamless chunk concatenation
- **Automatic gap filling** via linear interpolation with full metadata tracking
- **Efficient gap metadata** stored once per day (75% size reduction vs duplication)
- **Fast quality checks** via per-chunk gap_count (no filtering needed)
- **Worker-calculated normalization** from overlapping chunks only (instant range calculation)
- **Scalable hierarchy** mirroring SEED identifier structure
- **Low R2 costs** ($0.039/year uploads, ~$0.16/month storage per volcano with multi-size chunks)
- **Self-describing filenames** with sample rate enable 100% unambiguous identification, simpler IndexedDB keys, and easier debugging

The system is fully deterministic by time range, structured for interactive audio streaming, and keeps browser cache lightweight and synchronized with R2. Metadata-first delivery enables fast UI response while chunks process in parallel. Dynamic normalization handles partial cache scenarios elegantly with smooth transitions.

⸻

## Next Implementation Steps

### Priority 1: Update Render Backend to Write Correct Metadata Format

The current Render backend likely does not write metadata in the format specified in this document. The next implementation task is to update the Render backend (`backend/main.py`) to:

**Metadata Writing:**
1. Generate metadata in the Phase 1 format (lines 1151-1281):
   - Per-chunk min/max values for fast normalization
   - Per-chunk gap statistics (gap_count, gap_duration_seconds, gap_samples_filled)
   - Complete station metadata from IRIS
   - Multi-size chunk listings (10min, 1h, 6h, 24h) - or start with single size for simplicity

2. Handle metadata updates for partial day requests:
   - R2 Worker should send existing metadata file to Render (if it exists)
   - Render should UPDATE the existing metadata, not recreate from scratch
   - Append new chunks to the appropriate arrays
   - Update `complete_day` flag when all 24 hours available

3. Use self-describing filenames:
   - Format: `{NETWORK}_{STATION}_{LOCATION}_{CHANNEL}_{SAMPLE_RATE}Hz_{START}_to_{END}.bin.zst`
   - Example: `HV_NPOC_01_HHZ_100Hz_2025-10-24-00-00-00_to_2025-10-24-01-00-00.bin.zst`
   - Fractional example: `AV_PS4A_--_BHZ_40.96Hz_2025-10-24-00-00-00_to_2025-10-24-01-00-00.bin.zst`
   - Metadata file: `HV_NPOC_01_HHZ_100Hz_2025-10-24.json`

**R2 Storage Path:**
```
/data/{YEAR}/{MONTH}/{NETWORK}/{VOLCANO}/{STATION}/{LOCATION}/{CHANNEL}/
  ├─ HV_NPOC_01_HHZ_100Hz_2025-10-24-00-00-00_to_2025-10-24-01-00-00.bin.zst
  ├─ HV_NPOC_01_HHZ_100Hz_2025-10-24-01-00-00_to_2025-10-24-02-00-00.bin.zst
  └─ HV_NPOC_01_HHZ_100Hz_2025-10-24.json
```

**Testing:**
- Verify metadata format matches specification
- Test partial day updates (hours 0-12 exist, request hours 13-18)
- Verify self-describing filenames are correctly generated
- Test R2 Worker can parse metadata and construct chunk paths

### Priority 2: Implement Metadata Flow Through System ("Metadata in Motion")

Once Render is writing correct metadata, implement the complete metadata flow through R2 Worker and Browser.

**TO TEST LATER: Should R2 Worker proactively stream chunks, or just send metadata and let Browser request chunks explicitly?**
- Option A: R2 streams chunks immediately (saves round-trip, ~70ms)
- Option B: R2 only sends metadata, Browser requests chunks (simpler Worker, better for future IndexedDB)
- Need to test both approaches to see which is actually faster

### Priority 3: Implement IndexedDB Local Cache Layer

Add browser-side IndexedDB caching so repeated playback requests are instant (no network needed).

### Priority 4: Add System Intelligence for Progressive Playback

Enable audio playback to begin while some files are still being retrieved. System should intelligently determine minimum buffer needed and start playback as soon as sufficient data is available.

### Priority 5: Add Adaptive Normalization

Implement dynamic normalization that adjusts smoothly as new data arrives, preventing volume jumps when transitioning between cached and newly-generated chunks.

### Priority 6: Deploy to Render Production Server

Switch from local Flask development server to actual Render production deployment. Configure environment variables, scale resources, and monitor performance.

### Priority 6: Implement cron job for automated file creation.

**Future Enhancements:**
- Split gap details into separate `*_gaps.json` file (lazy-loaded)
- Implement MUSTANG API for fast historical metadata