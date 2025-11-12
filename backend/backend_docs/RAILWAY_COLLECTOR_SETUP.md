# Railway Data Collector Setup Guide

## Overview

This service runs continuously on Railway as a data collector that fetches seismic data from IRIS every 10 minutes at :02, :12, :22, :32, :42, :52 past each hour.

The collector also provides HTTP endpoints for health monitoring, status checks, data validation, gap detection, and backfilling missing data.

## Files

- **`collector_loop.py`** - Main collector service (scheduler + HTTP API)
- **`cron_job.py`** - Data collection logic (fetches from IRIS, processes, uploads to R2)
- **`stations_config.json`** - Active stations configuration

## Railway Setup Steps

### 1. Create New Service

1. Go to your Railway project
2. Click **"+ New"** → **"Empty Service"**
3. Name it: **`volcano-data-collector`**

### 2. Connect to GitHub

1. In service settings → **Source** → **Connect Repo**
2. Select your `volcano-audio` repository
3. Railway will auto-detect it's a Python project

### 3. Configure Start Command

In **Settings** → **Deploy**:

**Start Command:**
```bash
python backend/collector_loop.py
```

**Root Directory:** (leave empty or set to `/`)

**Port:** Railway will auto-assign (defaults to 5000 in production)

### 4. Environment Variables (Optional)

**Not required!** R2 credentials are already hardcoded in `cron_job.py` with defaults.

If you want to override them, add these in **Variables** tab:
```
R2_ACCOUNT_ID=<your-account-id>
R2_ACCESS_KEY_ID=<your-access-key>
R2_SECRET_ACCESS_KEY=<your-secret-key>
R2_BUCKET_NAME=<your-bucket-name>
```

### 5. Deploy

Click **Deploy** (or push to GitHub to trigger auto-deploy)

### 6. Monitor Logs

Watch the logs to verify:
- ✅ "🚀 Collector service started"
- ✅ "Next run in X seconds"
- ✅ Collection executes every 10 minutes
- ✅ "💾 Uploaded to R2: ..." messages
- ✅ "✅ Collection completed successfully"

## HTTP API Endpoints

The collector service provides several HTTP endpoints for monitoring and management:

### Health & Status

**`GET /health`** - Simple health check
```json
{"status": "healthy", "uptime_seconds": 1234.5}
```

**`GET /status`** - Detailed system status
- Current collection status
- File counts by type (10m, 1h, 6h)
- R2 storage info
- Coverage depth
- Recent failures (if any)

**`GET /stations`** - List active stations being collected

### Data Validation

**`GET /validate/24h`** - Validate last 24 hours of data
- Checks for missing files
- Detects orphaned files
- Finds duplicate metadata entries

**`GET /deduplicate/24h`** - Remove duplicate metadata entries

### Gap Detection & Backfill

**`GET /gaps/24h`** - Detect missing data windows in last 24 hours
**`GET /gaps/4h`** - Detect missing data windows in last 4 hours
**`GET /gaps/complete`** - Detect gaps from first file to now
**`GET /gaps/custom?start=ISO&end=ISO`** - Detect gaps in custom time range

Returns JSON report with all missing time windows, saved to R2 at `collector_logs/gap_report_*.json`

**`POST /backfill`** - *(Coming soon)* Fill detected gaps by fetching from IRIS

### Production URL

Once deployed, access endpoints at:
```
https://your-app-name.up.railway.app/health
https://your-app-name.up.railway.app/status
https://your-app-name.up.railway.app/gaps/24h
```

## Expected Behavior

### First Run
```
[2025-11-05 02:50:00 UTC] 🚀 Collector service started
[2025-11-05 02:50:00 UTC] Schedule: Every 10 minutes at :02, :12, :22, :32, :42, :52
[2025-11-05 02:50:00 UTC] Starting health API on port 5000
[2025-11-05 02:50:00 UTC] Next run in 720 seconds
```

### At :02 past the hour
```
[2025-11-05 03:02:00 UTC] ========== Starting data collection ==========
[2025-11-05 03:02:00 UTC] Active stations: 5
[2025-11-05 03:02:00 UTC] Windows to fetch: 2
[2025-11-05 03:02:00 UTC]   10m: 2025-11-05 02:50:00 to 03:00:00
[2025-11-05 03:02:00 UTC]   1h: 2025-11-05 02:00:00 to 03:00:00
... (fetching and uploading)
[2025-11-05 03:03:30 UTC] ✅ Collection completed successfully
[2025-11-05 03:03:30 UTC] Next run in 510 seconds
```

### At :12 past the hour (regular 10-min)
```
[2025-11-05 03:12:00 UTC] ========== Starting data collection ==========
[2025-11-05 03:12:00 UTC] Windows to fetch: 1
[2025-11-05 03:12:00 UTC]   10m: 2025-11-05 03:00:00 to 03:10:00
... (fetching and uploading)
[2025-11-05 03:13:00 UTC] ✅ Collection completed successfully
```

## Active Stations

Currently collecting from **5 stations**:

**Kilauea (HV Network):**
- OBL (100 Hz, HHZ)
- UWB (100 Hz, HHZ)
- SBL (100 Hz, HHZ)
- WRM (100 Hz, HHZ)

**Mount Spurr (AV Network):**
- SPCP (50 Hz, BHZ)

To add more stations, edit `backend/stations_config.json` and set `"active": true`.

## Data Output

Files are uploaded to R2 at:
```
data/{YEAR}/{MONTH}/{NETWORK}/{VOLCANO}/{STATION}/{LOCATION}/{CHANNEL}/
```

Example:
```
data/2025/11/HV/kilauea/OBL/--/HHZ/
  ├─ HV_OBL_--_HHZ_100Hz_10m_2025-11-05-03-00-00_to_2025-11-05-03-09-59.bin.zst
  ├─ HV_OBL_--_HHZ_100Hz_1h_2025-11-05-02-00-00_to_2025-11-05-02-59-59.bin.zst
  └─ HV_OBL_--_HHZ_100Hz_6h_2025-11-05-00-00-00_to_2025-11-05-05-59-59.bin.zst
```

## Chunk Schedule

- **10-minute chunks**: Created every 10 minutes (144/day per station)
- **1-hour chunks**: Created at top of each hour (24/day per station)
- **6-hour chunks**: Created at 00:02, 06:02, 12:02, 18:02 UTC (4/day per station)

## Troubleshooting

### Service keeps restarting
- Check logs for Python errors
- Verify R2 credentials are correct
- Check `requirements.txt` has all dependencies

### No data being uploaded
- Check R2 credentials
- Verify stations are marked `"active": true` in config
- Check IRIS is responding (might have rate limits)

### "Module not found" errors
Make sure `backend/requirements.txt` includes:
```
obspy
numpy
zstandard
boto3
```

## Cost Estimate

**Railway:**
- ~$5/month for always-on service

**R2 Storage:**
- 5 stations × 172 chunks/day = 860 files/day
- ~30 MB/day per station × 5 = 150 MB/day
- ~4.5 GB/month × $0.015/GB = **$0.07/month**

**Total: ~$5.07/month**

## Monitoring

### Via HTTP API (Recommended)
```bash
# Check health
curl https://your-app.up.railway.app/health

# Get detailed status
curl https://your-app.up.railway.app/status

# Check for gaps in last 24 hours
curl https://your-app.up.railway.app/gaps/24h

# Validate data integrity
curl https://your-app.up.railway.app/validate/24h
```

### Via Railway Logs
Check logs daily for:
- ✅ Successful collection runs every 10 minutes
- ❌ Any failed uploads or IRIS errors
- ⚠️ Gap detection results (run `/gaps/24h` endpoint)

## Stopping the Service

To pause data collection:
1. Go to Railway service
2. Click **Settings** → **Sleep** or **Delete**
3. Data collection will stop but R2 data remains

## Next Steps

After deployment:
1. ✅ Monitor for 24 hours to verify stability (use `/status` endpoint)
2. ✅ Metadata JSON files are automatically generated
3. ✅ Status API is live at `/health` and `/status`
4. ✅ Gap detection available at `/gaps/<mode>`
5. 🚧 Backfill endpoint coming soon at `/backfill`
6. Expand to more stations as needed (edit `stations_config.json`)
7. Set up automated daily gap checks and repairs

