# Railway Data Collector Setup Guide

## Overview

This service runs continuously on Railway and fetches seismic data from IRIS every 10 minutes at :02, :12, :22, :32, :42, :52 past each hour.

## Files

- **`cron_loop.py`** - Main scheduler daemon (runs forever)
- **`cron_job.py`** - Data collection logic (called every 10 min)
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
python backend/cron_loop.py
```

**Root Directory:** (leave empty or set to `/`)

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
- ✅ "🚀 Cron loop started"
- ✅ "Next run in X seconds"
- ✅ Cron job executes every 10 minutes
- ✅ "💾 Uploaded to R2: ..." messages
- ✅ "✅ Cron job completed successfully"

## Expected Behavior

### First Run
```
[2025-11-05 02:50:00 UTC] 🚀 Cron loop started
[2025-11-05 02:50:00 UTC] Schedule: Every 10 minutes at :02, :12, :22, :32, :42, :52
[2025-11-05 02:50:00 UTC] Next run in 720 seconds
```

### At :02 past the hour
```
[2025-11-05 03:02:00 UTC] ========== Starting cron job ==========
[2025-11-05 03:02:00 UTC] CRON JOB START
[2025-11-05 03:02:00 UTC] Active stations: 5
[2025-11-05 03:02:00 UTC] Windows to fetch: 2
[2025-11-05 03:02:00 UTC]   10m: 2025-11-05 02:50:00 to 03:00:00
[2025-11-05 03:02:00 UTC]   1h: 2025-11-05 02:00:00 to 03:00:00
... (fetching and uploading)
[2025-11-05 03:03:30 UTC] ✅ Cron job completed successfully
[2025-11-05 03:03:30 UTC] Next run in 510 seconds
```

### At :12 past the hour (regular 10-min)
```
[2025-11-05 03:12:00 UTC] ========== Starting cron job ==========
[2025-11-05 03:12:00 UTC] Windows to fetch: 1
[2025-11-05 03:12:00 UTC]   10m: 2025-11-05 03:00:00 to 03:10:00
... (fetching and uploading)
[2025-11-05 03:13:00 UTC] ✅ Cron job completed successfully
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

Check Railway logs daily for:
- ✅ Successful runs every 10 minutes
- ❌ Any failed uploads
- ⚠️ Gap warnings (normal, just informational)

## Stopping the Service

To pause data collection:
1. Go to Railway service
2. Click **Settings** → **Sleep** or **Delete**
3. Data collection will stop but R2 data remains

## Next Steps

After deployment:
1. Monitor for 24 hours to verify stability
2. Add metadata JSON generation (currently only .bin.zst files)
3. Expand to more stations as needed
4. Build status API to query cached data

