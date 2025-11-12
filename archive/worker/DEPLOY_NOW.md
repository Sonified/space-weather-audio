# Deploy R2 Worker - Quick Guide

## What's Ready

✅ **Worker code updated** with new endpoints:
- `/metadata` - Returns metadata JSON (with day folder path, dynamic volcano lookup)
- `/chunk` - Streams compressed chunks (with chunk_type subfolder support)

✅ **Frontend updated** to use dual-mode routing:
- Checks `stations_config.json` for active status
- Routes to R2 Worker for `active: true` stations
- Routes to Railway for `active: false` stations

✅ **Configuration ready:**
- `wrangler.toml` already configured
- R2 bucket: `hearts-data-cache`
- All dependencies installed

## Deploy Steps

### 1. Check you're logged in to Cloudflare

```bash
cd worker
wrangler whoami
```

If not logged in:
```bash
wrangler login
```

### 2. Deploy the worker

```bash
wrangler deploy
```

This will show output like:
```
Published volcano-audio-test
  https://volcano-audio-test.YOUR-SUBDOMAIN.workers.dev
```

### 3. Copy the worker URL and update `index.html`

Edit `index.html` line ~2025:

```javascript
const R2_WORKER_URL = 'https://volcano-audio-test.YOUR-SUBDOMAIN.workers.dev';
```

Replace with your actual URL from step 2.

### 4. Test with an active station

Edit `backend/stations_config.json` and set a station to `active: true`:

```json
{
  "station": "OBL",
  "location": "--",
  "channel": "HHZ",
  "active": true  ← Change this to true
}
```

### 5. Open `index.html` and test

1. Select the volcano/station you activated
2. Choose "30 minutes" duration
3. Click "Fetch Data"

**Expected console output:**
```
🔍 Checking station active status...
📋 Station HV.OBL: active=true
🌐 Using R2 Worker (active station)
📋 Step 1: Fetching metadata from R2 Worker...
📋 Metadata received: {...}
🔍 Normalization range from metadata: [-1523, 1891]
📦 Will fetch 3 chunks: ["00:00:00-00:10:00", ...]
📥 Fetching chunk 1/3: 00:00:00-00:10:00
  ✅ Downloaded: 640.2 KB
  🗜️ Decompressing...
  ✅ Decompressed: 60,000 samples
...
✅ Playing! (Progressive R2 streaming)
```

## Worker Improvements

The worker now:

✅ **Uses correct path format:**
```
data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location}/{channel}/{chunk_type}/{filename}
```

✅ **Finds volcano dynamically:**
- Tries common volcanoes first (fast path)
- Falls back to scanning R2 if needed
- No hardcoded volcano names!

✅ **Gets sample rate from metadata:**
- Loads metadata JSON
- Extracts `sample_rate` field
- Constructs correct filename

✅ **Supports chunk type subfolders:**
- `10m/` - 10-minute chunks
- `1h/` - 1-hour chunks  
- `6h/` - 6-hour chunks

✅ **Handles multi-day requests:**
- Frontend can request multiple dates
- Each metadata request is for a single date
- Browser stitches across days

## Testing Checklist

- [ ] Deploy worker successfully
- [ ] Get worker URL
- [ ] Update `index.html` with URL
- [ ] Set a station to `active: true`
- [ ] Verify R2 has data for that station
- [ ] Test in browser
- [ ] Check console for "Progressive R2 streaming" message
- [ ] Verify audio plays
- [ ] Test Railway mode (set station to `active: false`)

## Troubleshooting

**"Metadata not found" error:**
- Check R2 bucket has data in correct format
- Verify path matches: `data/2025/11/06/HV/kilauea/OBL/--/HHZ/HV_OBL_--_HHZ_100Hz_2025-11-06.json`
- Use Railway backend to generate test data first

**"Could not find volcano" error:**
- Worker couldn't find the station in R2
- Either no data exists, or path format is different
- Check actual R2 paths with: `wrangler r2 object list hearts-data-cache --prefix data/`

**Worker deploys but endpoints return 404:**
- Check worker URL is correct in `index.html`
- Try visiting: `https://your-worker.workers.dev/` (should show service info)
- Check CORS headers if browser console shows CORS error

## What Happens When You Deploy

```bash
wrangler deploy
```

This command:
1. Bundles `src/index.js` with dependencies
2. Uploads to Cloudflare
3. Binds R2 bucket (`hearts-data-cache`)
4. Makes worker live at edge locations globally
5. Returns worker URL

**No downtime** - instant deployment!

## Next: Generate Test Data

If you don't have R2 data yet, use Railway backend to populate it:

1. Keep all stations `active: false` initially
2. Use Railway backend to fetch & process data
3. Railway will save to R2 in correct format
4. Once R2 has data, set stations to `active: true`
5. Future requests use R2 Worker (fast!)

This way Railway backend **populates** R2, and R2 Worker **serves** the data!

