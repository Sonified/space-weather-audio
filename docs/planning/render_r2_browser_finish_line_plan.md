# Render → R2 → Browser: Finish Line Architecture

**Goal:** Get chunk data from R2 Storage to Browser with minimal latency after Render finishes processing.

## Architecture Overview

```
BROWSER                R2 WORKER              RENDER                R2 STORAGE
   |                       |                     |                       |
   | 1. Initial Request    |                     |                       |
   |--------------------> |                     |                       |
   |                       | 2. Check cache      |                       |
   |                       |---------------------|--------------------> |
   |                       |                     |  (cache MISS)         |
   |                       | 3. Forward request  |                       |
   |                       |------------------> |                       |
   |                       |                     |                       |
   |                       |   SSE: metadata     |                       |
   |<----------------------|<-------------------|                       |
   |                       |                     |                       |
   |                       |                     | 4. Upload chunk       |
   |                       |                     |--------------------> |
   |                       |                     |                       |
   |                       |   SSE: chunk_ready  |                       |
   |<----------------------|<-------------------|                       |
   |                       |                     |                       |
   | 5. HTTP GET chunk     |                     |                       |
   |-------------------------------------------------------------> |
   |                       |                     |                       |
   | 6. Chunk data         |                     |                       |
   |<--------------------------------------------------------------|
   |                       |                     |                       |
```

## Key Principles

1. **R2 Worker is NOT a data proxy** - Only for routing and SSE notifications
2. **Chunks flow directly** - R2 Storage → Browser (cheapest, fastest)
3. **SSE for notifications** - Tell browser "chunk ready at URL X"
4. **Browser initiates fetches** - Gets chunks from public R2 URLs

## Data Flow Details

### Phase 1: Initial Request & Metadata
```
Browser → R2 Worker → Render
Render fetches from IRIS, calculates min/max
Render → SSE event: metadata_calculated {min: -19375, max: -8367}
Browser receives metadata (needed for normalization)
```

### Phase 2: Chunk Upload & Notification (Sequential)
```
Render processes 1-minute chunk #1
Render uploads to R2 Storage: data/2025/10/HV/.../chunk1.zst
Render → SSE event: chunk_uploaded {
  type: '1min',
  index: 1,
  url: 'https://pub-xxx.r2.dev/data/2025/10/HV/.../chunk1.zst'
}

Browser receives event
Browser → HTTP GET to R2 Storage URL
Browser receives chunk, decompresses, processes

(Repeat for all chunks sequentially)
```

### Phase 3: Complete
```
Render → SSE event: complete {chunks: 11}
Browser knows all chunks processed
```

## Timing Optimization

### Current Latency Sources:
1. **Upload time:** Render → R2 Storage (~50-200ms per chunk)
2. **Event propagation:** Render → SSE → Browser (~10-30ms)
3. **Browser fetch initiation:** Browser receives event → starts GET (~5-20ms)
4. **R2 response:** R2 Storage → Browser (CDN, very fast ~20-100ms)

**Total per chunk: ~85-350ms between "Render done" and "Browser has data"**

### Cannot Eliminate:
- Upload time (must write to R2)
- Network propagation (physics)

### Can Optimize:
- **Render sends event IMMEDIATELY after upload completes**
- **Browser pre-warms connection to R2 domain** (DNS/TLS already done)
- **Browser fires fetch() immediately on event** (no processing delay)

## R2 Storage Setup

### Public Bucket Access
```javascript
// R2 bucket must have public access enabled for direct browser fetches
// OR use presigned URLs (more secure, slightly slower)
```

### URL Format Options

**Option A: Public R2 URL (fastest)**
```
https://pub-YOUR_ACCOUNT.r2.dev/data/2025/10/HV/kilauea/NPOC/--/HHZ/chunk1.zst
```
- ✅ Fastest (direct CDN)
- ❌ Publicly accessible

**Option B: Presigned URL (more secure)**
```
https://YOUR_ACCOUNT.r2.cloudflarestorage.com/hearts-data-cache/data/.../chunk1.zst?X-Amz-Signature=...
```
- ✅ Expires after set time
- ✅ Only browser with URL can access
- ❌ Slightly slower (extra validation)

**Recommendation:** Start with public URLs for testing, add presigned later if needed.

## Implementation Steps

### 1. Render: Add URL to chunk_uploaded event
```python
# backend/main.py
chunk_url = f"https://pub-{account_id}.r2.dev/{r2_key}"
yield f"event: chunk_uploaded\ndata: {json.dumps({
    'type': '1min',
    'index': 1,
    'url': chunk_url,
    'compressed_size': len(compressed)
})}\n\n"
```

### 2. Browser: Fetch on notification
```javascript
// pipeline_dashboard.html
case 'chunk_uploaded':
    const chunkUrl = data.url;
    
    // Immediately fetch from R2
    fetch(chunkUrl)
        .then(response => response.arrayBuffer())
        .then(compressed => {
            checkStep('browser-first-file', 'Browser: First file received');
            // Decompress with fzstd
            const decompressed = decompressZstd(compressed);
            checkStep('browser-decompressed', 'Browser: Decompressed');
            // Process chunk...
        });
    break;
```

### 3. R2 Worker: Pass-through (no changes needed)
R2 Worker just proxies SSE events, doesn't touch data transfer.

## Testing Plan

### Test 1: Measure end-to-end latency
```javascript
// Add timestamps at each step
Render: chunk_uploaded_time = Date.now()
Browser: event_received_time = Date.now()
Browser: fetch_started_time = Date.now()
Browser: data_received_time = Date.now()

// Calculate:
event_latency = event_received_time - chunk_uploaded_time
fetch_init_latency = fetch_started_time - event_received_time
download_latency = data_received_time - fetch_started_time
total_latency = data_received_time - chunk_uploaded_time
```

### Test 2: Compare chunk sizes
- 1-minute chunks: ~11KB compressed
- 6-minute chunks: ~69KB compressed
- 30-minute chunks: ~293KB compressed

Verify download times scale linearly.

### Test 3: Sequential ordering
Verify chunks arrive in order (1, 2, 3...) not (1, 3, 2...).

### Test 4: Connection reuse
Verify browser reuses TCP/TLS connection to R2 domain (faster after first chunk).

## Dashboard Updates Needed

### New Steps to Track:
```
R2 Worker:
  ✅ Cache miss
  ✅ Forward to Render

Render:
  ✅ Chunks created
  ✅ Chunks uploaded to R2
  ✅ URLs sent to browser

Browser:
  [ ] First chunk URL received
  [ ] First chunk fetched from R2  ← NEW
  [ ] First chunk decompressed      ← NEW
  [ ] Normalized                    ← NEW
  [ ] Playback started              ← NEW
```

## Success Metrics

**Target:** Browser receives first chunk data within **200ms** of Render finishing upload.

**Breakdown:**
- Upload: 50-100ms (Render → R2)
- Event: 10-30ms (SSE propagation)
- Fetch init: 5-20ms (Browser reaction)
- Download: 20-50ms (R2 → Browser, small chunk)

**Stretch goal:** <150ms total latency

## Future Optimizations (Later)

1. **Parallel chunk fetching** (after first few arrive)
2. **Adaptive chunk sizes** based on network speed
3. **Prefetch metadata** for common requests
4. **WebSocket instead of SSE** (bidirectional, slightly faster)

## Notes

- **No R2 Worker involvement in data transfer** = Cheaper + Faster
- **Direct R2 → Browser** = Leverages Cloudflare CDN edge caching
- **Sequential notifications** = Browser knows when each chunk ready
- **Public URLs** = Simplest, fastest (add auth later if needed)

