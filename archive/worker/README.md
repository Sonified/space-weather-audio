# Volcano Audio - Cloudflare R2 Worker

Progressive streaming of seismic audio chunks from R2 storage directly to browser.

## Why Cloudflare Worker + R2?

**Performance:**
- Co-located with R2 (sub-millisecond latency, same datacenter)
- Global edge network (fast for all users)
- **Direct streaming** (no presigned URLs = no extra round trip)
- Expected TTFA: ~50-80ms total

**Cost:**
- **FREE R2 egress** when accessed from Workers
- 100k requests/day FREE on Workers
- ~$5/month even at scale (1M requests)

**Architecture Benefits:**
- Single request per chunk = minimal latency
- Worker runs at edge closest to user
- R2 data cached at edge (or pulled there on first access)
- Connection stays hot for sequential chunks

## New Architecture (Progressive Streaming)

```
Client → Worker /metadata → R2 Metadata JSON
         ↓
         Get normalization range from metadata
         ↓
Client → Worker /chunk (sequential) → R2 .zst chunk → Stream to browser
         ↓
Browser decompresses locally (2-36ms per chunk)
         ↓
Browser normalizes & stitches chunks
         ↓
Audio playback starts!
```

**Key insight:** Streaming through worker is **faster** than presigned URLs because:
1. No DNS lookup for R2 domain
2. No redirect overhead
3. Worker can add caching headers
4. Connection stays hot for sequential chunks

## Setup

### 1. Install Wrangler CLI

```bash
npm install -g wrangler
```

### 2. Login to Cloudflare

```bash
wrangler login
```

### 3. Create R2 Bucket

```bash
wrangler r2 bucket create volcano-seismic-data
```

### 4. Configure Worker

Edit `wrangler-r2-example.toml`:
- Add your Cloudflare account ID (find at dash.cloudflare.com)
- Update bucket name if different
- Rename to `wrangler.toml`

### 5. Deploy Worker

```bash
cd worker
cp wrangler-r2-example.toml wrangler.toml
# Edit wrangler.toml with your account ID
wrangler deploy r2-worker-example.js
```

### 6. Update Frontend

In `index.html`, update the R2 Worker URL:

```javascript
// Line ~1950
const R2_WORKER_URL = 'https://your-worker.your-subdomain.workers.dev';
```

Replace with your actual worker URL (shown after `wrangler deploy`).

## API Endpoints

### 1. GET /metadata

Fetches metadata JSON for a station/date (includes normalization ranges).

**Parameters:**
- `network`: Network code (e.g., HV, AV)
- `station`: Station code (e.g., NPOC, SPCP)
- `location`: Location code (e.g., --, 01)
- `channel`: Channel code (e.g., HHZ, BHZ)
- `date`: Date in YYYY-MM-DD format

**Example:**
```bash
curl "https://your-worker.workers.dev/metadata?network=HV&station=NPOC&location=--&channel=HHZ&date=2025-11-06"
```

**Response:**
```json
{
  "date": "2025-11-06",
  "network": "HV",
  "station": "NPOC",
  "channel": "HHZ",
  "sample_rate": 100.0,
  "chunks": {
    "10min": [
      {"start": "00:00:00", "end": "00:10:00", "min": -1523, "max": 1891, ...},
      {"start": "00:10:00", "end": "00:20:00", "min": -1432, "max": 1765, ...}
    ]
  }
}
```

### 2. GET /chunk

Streams compressed .zst chunk directly from R2.

**Parameters:**
- `network`: Network code
- `station`: Station code  
- `location`: Location code
- `channel`: Channel code
- `date`: Date in YYYY-MM-DD format
- `start`: Start time (HH:MM:SS)
- `end`: End time (HH:MM:SS)

**Example:**
```bash
curl "https://your-worker.workers.dev/chunk?network=HV&station=NPOC&location=--&channel=HHZ&date=2025-11-06&start=00:00:00&end=00:10:00" \
  --output chunk.bin.zst
```

**Response:**
- Binary zstd-compressed int32 data
- Headers: `Content-Type: application/octet-stream`
- Cached for 1 year (immutable chunks)

## How It Works

### Progressive Streaming Flow

1. **Browser requests metadata** → Worker fetches JSON from R2 → Browser gets normalization range
2. **Browser requests 3 chunks sequentially** (for 30-minute request):
   - Chunk 1: 00:00:00 - 00:10:00
   - Chunk 2: 00:10:00 - 00:20:00  
   - Chunk 3: 00:20:00 - 00:30:00
3. **Worker streams each chunk directly** (no decompression!)
4. **Browser receives .zst data** → decompresses locally → normalizes → stitches → plays!

**Key advantages:**
- ✅ Metadata first = browser knows normalization range before downloading chunks
- ✅ Sequential streaming = first chunk starts playing while others download
- ✅ Worker just passes through data = minimal compute/latency
- ✅ Browser controls decompression timing = no worker memory pressure

## Cache Key Format

Cache keys match the Python backend format:
```
MD5("{volcano}_{hours_ago}h_ago_{duration_hours}h_duration")[:16]
```

Example: `kilauea_12h_ago_4h_duration` → `53f1fa20d8eec968`

## Cost Estimate

**At 1M requests/month:**
- Workers: ~$5/month (1M requests + compute)
- R2 Storage: ~$1/month (43 GB historical data)
- R2 Egress: $0 (FREE from Workers!)
- **Total: ~$6/month**

Compare to Railway: ~$200-400/month bandwidth costs!

## Development

### Local Testing

```bash
wrangler dev
```

### View Logs

```bash
wrangler tail
```

### Environment Variables

R2 credentials are automatically injected by Cloudflare (no need to manage secrets).

## Next Steps

1. Deploy worker
2. Update frontend to use worker URL instead of Railway
3. Keep Railway for IRIS fetching & cache population
4. Monitor costs & performance in Cloudflare dashboard



