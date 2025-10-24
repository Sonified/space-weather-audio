# Volcano Audio - Cloudflare Worker

Streams seismic audio data from R2 with on-demand processing (detrend + normalize).

## Why Cloudflare Worker?

**Performance:**
- Co-located with R2 (1-5ms latency vs 100-150ms via Render)
- Global edge network (fast for all users)
- Expected TTFA: ~50-80ms (vs 355ms via Render)

**Cost:**
- FREE R2 egress (vs Render bandwidth costs)
- 100k requests/day FREE on Workers
- ~$5/month even if viral (1M requests)

## Architecture

```
Client → Cloudflare Worker (edge) → R2 (same datacenter)
         ↓
         Detrend + Normalize (on-demand)
         ↓
         Stream progressive chunks
```

## Setup

### 1. Install Wrangler CLI

```bash
npm install -g wrangler
```

### 2. Login to Cloudflare

```bash
wrangler login
```

### 3. Deploy Worker

```bash
cd worker
wrangler deploy
```

### 4. Test

```bash
# Your worker will be live at:
https://volcano-audio-worker.YOUR-SUBDOMAIN.workers.dev

# Test endpoint:
curl "https://volcano-audio-worker.YOUR-SUBDOMAIN.workers.dev/stream/kilauea/4?hours_ago=12"
```

## API

### Stream Endpoint

```
GET /stream/{volcano}/{duration_hours}?hours_ago={hours}
```

**Parameters:**
- `volcano`: Volcano name (kilauea, spurr, etc.)
- `duration_hours`: Duration in hours (1-24)
- `hours_ago`: How many hours ago to start (default: 12)

**Response:**
- Streams raw int16 audio data (detrended + normalized)
- Progressive chunks: 8→16→32→64→128→256→512 KB
- Headers include profiling info (X-Worker-*-MS)

**Example:**
```bash
curl "https://volcano-audio-worker.YOUR-SUBDOMAIN.workers.dev/stream/kilauea/4?hours_ago=12" \
  --output kilauea_4h.bin
```

## Processing

The worker performs on-demand processing:

1. **Fetch raw int16 from R2** (~50ms)
2. **Detrend**: Subtract mean (~1ms)
3. **Normalize**: Scale by max absolute value (~1ms)
4. **Stream**: Progressive chunks to client

**Total TTFA: ~50-80ms** (10x faster than Render!)

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

Compare to Render: ~$200-400/month bandwidth costs!

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
2. Update frontend to use worker URL instead of Render
3. Keep Render for IRIS fetching & cache population
4. Monitor costs & performance in Cloudflare dashboard



