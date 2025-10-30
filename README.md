# Volcano Audio Streaming System

A real-time web-based system for streaming and audifying seismic data from active volcanoes worldwide.

## Overview

This project provides a complete pipeline for converting seismic data into audio streams. It fetches real-time data from IRIS FDSN, processes and compresses it with multi-size Zstd chunks, stores it on Cloudflare R2, and streams it progressively to web browsers for immediate playback and visualization.

## 🎯 Quick Links

- **[🔧 Pipeline Dashboard](pipeline_dashboard.html)** - Real-time visual tracker for the full data pipeline
- **[📊 Project Dashboard](dashboard.html)** - Visual status, interactive task manager, one-click test launching
- **[🛠️ Developer Guide](docs/DEV_GUIDE.md)** - Backend setup, R2 uploads, testing, debugging
- **[📖 Architecture Docs](docs/FULL_cache_architecture_w_LOCAL_DB.md)** - Complete technical overview (source of truth)
- **[📝 Captain's Logs](docs/captains_logs/)** - Daily progress notes

## Architecture

### Data Pipeline Flow
```
Browser → R2 Worker (Cloudflare) → Render Backend → IRIS → R2 Storage
   ↓                                                              ↓
   ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ←
        (Browser fetches .zst chunks directly from R2)
```

1. **Browser Request**: User requests time range, browser checks local IndexedDB cache
2. **R2 Worker Check**: If cache miss, browser requests from R2 Worker (checks R2 metadata)
3. **Render Processing**: On R2 cache miss, R2 Worker forwards to Render backend
4. **IRIS Fetch**: Render fetches raw seismic data from IRIS (with retry logic for half duration on failure)
5. **Data Processing**: Dedupe, gap-fill, calculate min/max metadata for normalization
6. **Multi-Size Chunking**: Creates optimized chunks for different use cases:
   - **1-minute chunks** (first 6 minutes) - fastest playback start
   - **6-minute chunks** (minutes 6-30) - balanced efficiency
   - **30-minute chunks** (remainder) - maximum compression
7. **Zstd Compression**: Level 3 compression for fast decompression (10-30 MB/s in browser)
8. **R2 Upload**: All chunks uploaded to Cloudflare R2 for global edge distribution
9. **Direct Browser Fetch**: Browser fetches `.zst` files directly from R2, decompresses locally
10. **Local Cache**: Decompressed data stored in IndexedDB for instant replay

### Supported Volcanoes
- **Kīlauea** (Hawaii) - HV network
- **Mauna Loa** (Hawaii) - HV network
- **Great Sitkin** (Alaska) - AV network
- **Shishaldin** (Alaska) - AV network
- **Mount Spurr** (Alaska) - AV network

### Station Selection Criteria
- **Radius**: 13 miles (21 km) from volcano coordinates
- **Component**: Z-component only (vertical seismometers)
- **Status**: Active channels only (no end_time)
- **Data Source**: Parsed from `volcano_station_availability.json`

## Features

- ✅ **Global Edge Distribution**: Cloudflare R2 + Workers for low-latency worldwide access
- ✅ **Multi-Size Chunking**: 1-min, 6-min, 30-min chunks for optimized streaming
- ✅ **Fast Decompression**: Zstd level 3 (~10-30 MB/s in browser)
- ✅ **Smart Caching**: R2 cache check → Render processing → IRIS fetch with retry logic
- ✅ **Local Browser Cache**: IndexedDB stores uncompressed data for instant replay
- ✅ **Real-Time Pipeline Visualization**: `pipeline_dashboard.html` tracks every step
- ✅ **One-Command Local Testing**: `./boot_local_mode.sh` starts everything
- ✅ **Automatic Metadata**: Min/max calculated for consistent normalization
- ✅ **Sample-Accurate Playback**: Zero clicks/pops between chunks
- ✅ **Live Spectrogram**: Real-time frequency visualization (in test interfaces)

## Local Development Setup

### Quick Start - Boot Local Mode
```bash
# Start both R2 Worker and Flask Backend at once
./boot_local_mode.sh
```

This script will:
- 🧹 Clean up any existing processes on ports 8787 and 5001
- 📡 Start R2 Worker on `http://localhost:8787`
- 🐍 Start Flask Backend on `http://localhost:5001`
- ✅ Show you the status of both services
- 📋 Tell you where to find the logs

**Logs:**
- Worker: `tail -f /tmp/wrangler.log`
- Flask: `tail -f /tmp/flask.log`

**To stop all services:**
```bash
pkill -9 -f 'wrangler dev'
pkill -9 -f 'backend/main.py'
```

### Manual Setup (if needed)

#### Backend (Render/Flask)
```bash
cd backend
pip install -r requirements.txt
python3 main.py  # Runs on http://localhost:5001
```

#### R2 Worker (Cloudflare)
```bash
cd worker
npx wrangler dev --port 8787
```

**Need more help?** See **[Developer Guide](docs/DEV_GUIDE.md)** for detailed setup, R2 configuration, and troubleshooting.

### Testing the Pipeline
1. Start local services: `./boot_local_mode.sh`
2. Open `pipeline_dashboard.html` in your browser
3. Ensure "🖥️ Local Mode" checkbox is checked
4. Click "Start Pipeline Test"
5. Watch the real-time visual feedback as data flows through the system!

## Usage

### Web Streaming Interface
1. Open `test_streaming.html`
2. Select volcano, duration (1-24 hours), and compression format
3. Click "Start Streaming"
4. Audio begins playing as soon as first chunk arrives
5. View real-time waveform and spectrogram

### API Endpoints

#### R2 Worker: `GET /request`
Primary entry point for data requests
- **Query params**: `network`, `station`, `location`, `channel`, `starttime` (ISO format), `duration` (seconds)
- **Response**: Cache status (`cache_hit` or `processing`) with metadata
- **Example**: `/request?network=HV&station=NPOC&location=&channel=HHZ&starttime=2025-10-28T00:00:00Z&duration=3600`

#### Render Backend: `POST /api/request`
Processing endpoint (called by R2 Worker on cache miss)
- **Body**: JSON with network, station, location, channel, starttime, duration
- **Response**: Processing status with chunk metadata
- **Actions**: Fetches from IRIS, processes, chunks, compresses with Zstd, uploads to R2

#### Legacy Endpoints
- `GET /api/stream/<volcano>/<hours>` - Progressive streaming (may be deprecated)
- `GET /api/zarr/<volcano>/<hours>` - Zarr archive download
- `GET /api/audio/<volcano>/<hours>` - WAV file generation

## Data Management

### Station Availability Database
The system uses `data/reference/volcano_station_availability.json` which contains:
- Volcano coordinates (lat/lon)
- All available seismic and infrasound stations within 50km
- Channel metadata (network, station, location, channel codes)
- Sample rates, instrument details, active date ranges
- Distance from volcano summit

### Updating Station Data
```bash
python python_code/audit_station_availability.py
```
This queries IRIS for all monitored volcanoes and updates the availability database.

### Deriving Active Stations
```bash
python python_code/derive_active_stations.py
```
Filters to only currently-active channels (empty `end_time`).

## Performance Metrics

### Compression Efficiency (1-hour window, 100 Hz data)
| Format | Size | Compression Time (Render) | Decompression Time (Browser) | Ratio |
|--------|------|---------------------------|----------------------------|-------|
| Raw int32 | 1.44 MB | - | - | 1.0:1 |
| **Zstd-3** | **~400-600 KB** | **~30-50ms** | **~20-40ms** | **~2.4-3.6:1** |

### Multi-Size Chunking Strategy
- **1-minute chunks** (×6): First 6 minutes for fastest playback start
- **6-minute chunks** (×4): Minutes 6-30 for balanced efficiency  
- **30-minute chunks** (×1): Remainder for maximum compression
- **Total overhead**: ~11 chunks for 1 hour vs. 1 monolithic file

### Streaming Performance
- **Time to First Audio**: Target <100ms (depends on R2 cache status)
- **Browser decompression**: 10-30 MB/s with fzstd library
- **Network bandwidth**: ~400-600 KB/hour per station (compressed)
- **IndexedDB storage**: Uncompressed int32 for instant replay

## Project Structure

```
volcano-audio/
├── boot_local_mode.sh       # 🚀 One-command local testing setup
├── pipeline_dashboard.html  # 🔧 Real-time pipeline visualization
├── backend/
│   ├── main.py              # Flask API server (Render backend)
│   └── requirements.txt     # Python dependencies (ObsPy, boto3, zstandard, etc.)
├── worker/
│   ├── src/index.js         # Cloudflare R2 Worker (routing/caching)
│   └── wrangler.toml        # Worker configuration
├── python_code/
│   ├── data_management.py   # Station filtering utilities
│   ├── audit_station_availability.py  # IRIS station queries
│   └── derive_active_stations.py      # Active channel filtering
├── data/reference/
│   ├── volcano_station_availability.json  # Complete station database
│   └── monitored_volcanoes.json          # Volcano list from USGS
├── docs/
│   ├── FULL_cache_architecture_w_LOCAL_DB.md  # ⭐ Architecture source of truth
│   ├── captains_logs/       # Development progress logs
│   └── planning/            # Architecture documentation
├── tests/                   # Compression benchmarks and test logs
├── test_streaming.html      # Legacy streaming interface
├── test_audioworklet.html   # AudioWorklet-based player
└── dashboard.html           # Project management dashboard
```

## Technical Details

### Data Storage Format
- **R2 Storage**: Zstd-compressed `.zst` files (level 3)
- **Data type**: int32 (32-bit signed integers for full dynamic range)
- **Metadata**: Per-day JSON files with min/max, sample rate, timestamps, channel info
- **Hierarchy**: `/data/{YEAR}/{MONTH}/{NETWORK}/{VOLCANO}/{STATION}/{LOCATION}/{CHANNEL}/`

### Audio Processing Pipeline
- **Input**: Seismic data sampled at 20-100 Hz (typically 100 Hz for HV network)
- **Processing**: Merge traces, deduplicate, gap-fill with interpolation
- **Normalization**: Global min/max sent to browser for consistent playback levels
- **Speedup**: 50-400x (configurable in browser)
- **Output sample rate**: Original × speedup (e.g., 100 Hz × 200 = 20 kHz)

### Compression Strategy
- **Format**: Zstandard (Zstd) level 3
- **Rationale**: 
  - Fast browser decompression (10-30 MB/s with fzstd.js)
  - Better compression than gzip (~2.4-3.6:1 ratio)
  - No Worker CPU overhead (browser decompresses locally)
- **Multi-size chunks**: 1-min, 6-min, 30-min for optimized streaming

### Browser Technologies
- **Web Audio API**: Chrome, Firefox, Safari, Edge (92%+ browsers)
- **IndexedDB**: Local uncompressed cache for instant replay
- **Zstd Decompression**: fzstd.js library
- **Fetch API**: Direct R2 chunk fetching

### Cloudflare Infrastructure
- **R2 Storage**: Object storage with zero egress fees
- **Workers**: Lightweight routing layer (checks cache, forwards to Render)
- **Edge Distribution**: Global CDN for low-latency chunk delivery 