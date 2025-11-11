# Volcano Audio Streaming System

A real-time web-based system for streaming and audifying seismic data from active volcanoes worldwide.

## Overview

This project provides a complete pipeline for converting seismic data into audio streams. It fetches real-time data from IRIS FDSN, processes and compresses it with multi-size Zstd chunks, stores it on Cloudflare R2, and streams it progressively to web browsers for immediate playback and visualization.

## 🎯 Quick Links

- **[🎵 Main Interface](index.html)** - AudioWorklet-based streaming player
- **[📝 TODO List](docs/TODO.md)** - Current development priorities
- **[📖 Captain's Logs](docs/captains_logs/)** - Daily progress notes and version history
- **[🛠️ Developer Guide](docs/DEV_GUIDE.md)** - Backend setup, R2 uploads, testing, debugging
- **[⚙️ Stations Config](backend/stations_config.json)** - Active/inactive station configuration

## Architecture

### Data Pipeline Flow

The system uses **two separate paths** depending on station activity:

#### Path 1: Active Stations (HV.OBL, HV.SBL, etc.)
```
Browser → cdn.now.audio/data (Direct CDN fetch)
```
- Browser fetches `.zst` chunks directly from Cloudflare R2 CDN
- Metadata JSON consulted to determine which chunks exist
- Realistic chunk fetch optimization: tries to grab first chunk immediately for instant playback
- No backend involved (fastest path)

#### Path 2: Inactive Stations (Mauna Loa, etc.)
```
Browser → Railway Backend → IRIS → Browser
```
- On-demand streaming via Railway `/api/stream-audio` endpoint
- Backend fetches from IRIS, processes, and streams to browser
- Used for stations not actively collected by scheduled collector

### Data Collection Pipeline (Backend)

1. **Scheduled Collection**: Railway collector runs every 10 minutes (:02, :12, :22, etc.)
2. **IRIS Fetch**: Downloads raw seismic data from IRIS FDSN web services
3. **Data Processing**: Detrend, deduplicate, gap-fill, calculate min/max for normalization
4. **Multi-Size Chunking**: Creates time-aligned chunks:
   - **10-minute chunks** - First 60 minutes (mandatory for instant playback)
   - **1-hour chunks** - After 60 minutes, at hour boundaries
   - **6-hour chunks** - At 6-hour boundaries (maximum efficiency)
5. **Zstd Compression**: Level 3 compression (~2.4-3.6:1 ratio, fast browser decompression)
6. **R2 Upload**: Chunks and metadata uploaded to Cloudflare R2 via `cdn.now.audio`
7. **Metadata Generation**: Per-day JSON files track all chunks with timestamps, sample counts, min/max

### Browser Playback System

1. **Station Check**: Browser determines if station is active (from `stations_config.json`)
2. **Metadata Fetch**: Downloads daily metadata JSON to know which chunks exist
3. **Realistic Chunk Fetch**: Tries to grab first 10m chunk immediately (with fallback +10, +20, +30 minutes)
4. **Progressive Streaming**: Fetches remaining chunks in batches while first chunk plays
5. **Web Worker Decompression**: Zstd decompression off main thread
6. **AudioWorklet Playback**: `SeismicProcessor` handles real-time audio in separate high-priority thread
7. **Progressive Waveform**: Waveform Worker builds visualization left-to-right as chunks arrive

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

- ✅ **Dual-Path Architecture**: Direct CDN for active stations, Railway backend for inactive
- ✅ **Realistic Chunk Optimization**: Instant playback start by fetching first chunk immediately
- ✅ **Multi-Size Chunking**: 10m/1h/6h chunks with smart boundary-aligned selection
- ✅ **AudioWorklet Playback**: Glitch-free, low-latency audio on separate high-priority thread
- ✅ **Progressive Waveform**: Left-to-right visualization builds as chunks arrive
- ✅ **Fast Decompression**: Zstd level 3 (~10-30 MB/s) in Web Worker
- ✅ **Global Edge Distribution**: Cloudflare R2 CDN (`cdn.now.audio`)
- ✅ **Scheduled Collection**: Automated 10-minute collection cycle for active stations
- ✅ **Automatic Metadata**: Per-day JSON with min/max for consistent normalization
- ✅ **Sample-Accurate Playback**: Zero clicks/pops between chunks

## Local Development Setup

### Quick Start - Local Collector

For testing the scheduled collector and on-demand streaming:

```bash
cd backend
# Start local collector (includes /api/stream-audio endpoint)
./start_local_collector.sh
```

This runs the collector on `http://localhost:5005` with:
- Scheduled 10-minute collection cycles
- `/api/stream-audio` endpoint for on-demand inactive station streaming
- `/health`, `/status`, `/trigger` monitoring endpoints

**To stop:**
```bash
pkill -f collector_loop.py
```

### Frontend Development

Simply open `index.html` in a browser:
- **Active stations**: Fetches directly from `cdn.now.audio` (no local setup needed)
- **Inactive stations**: Configure to use local collector at `http://localhost:5005`

### Testing

1. **Active Stations** (HV.OBL, etc.): Just open `index.html` - works immediately
2. **Inactive Stations** (Mauna Loa, etc.): Start local collector, then open `index.html`
3. **Collection Pipeline**: Run collector with `./start_local_collector.sh`, check logs

**Need more help?** See **[Developer Guide](docs/DEV_GUIDE.md)** for detailed setup, R2 configuration, and troubleshooting.

## Usage

### Web Streaming Interface
1. Open `index.html` in a web browser
2. Select volcano and station from dropdowns
3. Choose time range (0.5 to 24 hours)
4. Configure playback speed and filters
5. Click "▶️ Start Streaming"
6. Audio begins playing as soon as first chunk arrives
7. View real-time progressive waveform and playback indicator

### API Endpoints

#### Railway Collector Service

**Production**: `https://volcano-audio-collector-production.up.railway.app`

##### Primary Endpoints
- `GET /health` - Health check (returns status, version, uptime)
- `GET /status` - Detailed collector status with metrics (optional `?timezone=` param)
- `GET /stations` - List active stations from `stations_config.json`
- `GET /trigger` - Manually trigger collection cycle immediately
- `POST /api/stream-audio` - On-demand audio streaming for inactive stations
  - **Body**: `{network, station, location, channel, starttime, duration, highpass_hz, normalize, send_raw}`
  - **Used by**: Browser for inactive stations (Mauna Loa, etc.)
- `GET /gaps/<mode>` - Gap detection (`smart`, `simple`, or `all`)
- `POST /backfill` - Backfill missing data for specified time ranges

##### CDN Direct Access (Active Stations)
- `https://cdn.now.audio/data/{YYYY}/{MM}/{DD}/{NETWORK}/{VOLCANO}/{STATION}/{LOCATION}/{CHANNEL}/{TYPE}/{FILENAME}.bin.zst`
- **Types**: `10m`, `1h`, `6h`
- **Metadata**: `https://cdn.now.audio/data/{YYYY}/{MM}/{DD}/{NETWORK}/{VOLCANO}/{STATION}/{LOCATION}/{CHANNEL}/{NETWORK}_{STATION}_{LOCATION}_{CHANNEL}_{YYYY-MM-DD}.json`

## Data Management

### Station Availability Database
The system uses `data/reference/volcano_station_availability.json` which contains:
- Volcano coordinates (lat/lon)
- All available seismic and infrasound stations within 50km
- Channel metadata (network, station, location, channel codes)
- Sample rates, instrument details, active date ranges
- Distance from volcano summit

### Updating Station Data
The station availability database (`data/reference/volcano_station_availability.json`) is maintained manually. The collector service uses `backend/stations_config.json` for active station configuration.

## Performance Metrics

### Compression Efficiency (1-hour window, 100 Hz data)
| Format | Size | Compression Time (Render) | Decompression Time (Browser) | Ratio |
|--------|------|---------------------------|----------------------------|-------|
| Raw int32 | 1.44 MB | - | - | 1.0:1 |
| **Zstd-3** | **~400-600 KB** | **~30-50ms** | **~20-40ms** | **~2.4-3.6:1** |

### Multi-Size Chunking Strategy
- **10-minute chunks**: First 60 minutes (mandatory for instant playback, 6 chunks)
- **1-hour chunks**: After 60 minutes at hour boundaries (balanced efficiency)
- **6-hour chunks**: At 6-hour boundaries (maximum compression, fewest requests)
- **Smart Selection**: Browser picks largest available chunk at each time boundary
- **Example (6 hours)**: Six 10m chunks + five 1h chunks = 11 total requests

### Streaming Performance
- **Time to First Audio**: Target <100ms (depends on R2 cache status)
- **Browser decompression**: 10-30 MB/s with fzstd library
- **Network bandwidth**: ~400-600 KB/hour per station (compressed)
- **IndexedDB storage**: Uncompressed int32 for instant replay

## Project Structure

```
volcano-audio/
├── index.html               # 🎵 Main audio streaming interface (AudioWorklet-based)
├── backend/
│   ├── collector_loop.py    # 🔄 Scheduled collector + HTTP API (Railway)
│   ├── audio_stream.py      # 🎧 On-demand streaming endpoint (/api/stream-audio)
│   ├── stations_config.json # ⚙️ Active station configuration
│   ├── start_local_collector.sh  # 🚀 Start local collector for testing
│   └── requirements.txt     # Python dependencies (ObsPy, boto3, zstandard)
├── data/reference/
│   ├── volcano_station_availability.json  # Complete station database
│   └── monitored_volcanoes.json          # Volcano list from USGS
├── docs/
│   ├── TODO.md              # 📝 Current development priorities
│   ├── captains_logs/       # 📖 Daily progress logs
│   └── DEV_GUIDE.md         # 🛠️ Developer setup guide
├── waveform-worker.js       # 🎨 Web Worker for progressive waveform rendering
└── archive/                  # 📦 Archived old code, docs, and prototypes
```

## Technical Details

### Data Storage Format
- **R2 Storage**: Zstd-compressed `.zst` files (level 3)
- **Data type**: float32 (normalized to [-1.0, 1.0])
- **Metadata**: Per-day JSON files with min/max, sample rate, timestamps, all available chunks
- **Hierarchy**: `/data/{YYYY}/{MM}/{DD}/{NETWORK}/{VOLCANO}/{STATION}/{LOCATION}/{CHANNEL}/{TYPE}/`
  - `{TYPE}` = `10m`, `1h`, or `6h`

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
  - Decompression happens in Web Worker (non-blocking)
- **Multi-size chunks**: 10m/1h/6h aligned to time boundaries for efficient caching

### Browser Technologies
- **AudioWorklet API**: `SeismicProcessor` class runs audio on separate high-priority thread
- **Web Workers**: Separate threads for Zstd decompression and waveform rendering
- **Zstd Decompression**: fzstd.js library (~10-30 MB/s)
- **Fetch API**: Direct CDN chunk fetching from `cdn.now.audio`
- **Canvas API**: Real-time progressive waveform visualization

### Cloudflare Infrastructure
- **R2 Storage**: Object storage with zero egress fees
- **CDN Distribution**: `cdn.now.audio` for global edge delivery
- **Metadata + Chunks**: Per-day JSON manifests + Zstd-compressed binary chunks 