# Volcano Audio Streaming System

A real-time web-based system for streaming and audifying seismic data from active volcanoes worldwide.

## Overview

This project provides a complete pipeline for converting seismic data into audio streams. It fetches real-time data from IRIS FDSN, processes and compresses it, and streams it progressively to web browsers for immediate playback and visualization.

## 🎯 Quick Links

- **[📊 Project Dashboard](dashboard.html)** - Visual status, interactive task manager, one-click test launching
- **[🛠️ Developer Guide](docs/DEV_GUIDE.md)** - Backend setup, R2 uploads, testing, debugging
- **[📖 Architecture Docs](docs/planning/streaming_architecture.md)** - Complete technical overview
- **[🗂️ Cache Design](docs/cache_architecture.md)** - File hierarchy, compression benchmarks
- **[📝 Captain's Logs](docs/captains_logs/)** - Daily progress notes

## Architecture

### Data Pipeline
1. **Station Discovery**: Automatically queries IRIS for seismic stations within configurable radius of each volcano
2. **Data Fetching**: Retrieves real-time seismic waveforms from IRIS FDSN Web Service
3. **Processing**: Detrends, normalizes, and converts to int16 for optimal compression
4. **Compression**: Uses Zarr+Blosc-5 for 16-22% better compression than raw gzip
5. **Streaming**: Progressive chunk delivery via Flask API
6. **Playback**: Browser-based Web Audio API with sample-accurate scheduling

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

- ✅ **Real-time streaming**: Hear audio as data arrives (Time to First Audio <100ms)
- ✅ **Progressive loading**: Start playback before full download completes
- ✅ **Optimized compression**: 13.2 MB per 24 hours using int16+Zarr+Blosc-5
- ✅ **Sample-accurate playback**: Zero clicks/pops between chunks
- ✅ **Multi-format support**: Gzip, Blosc, Zstd compression formats
- ✅ **Live spectrogram**: Real-time frequency visualization
- ✅ **Variable playback speed**: 0.1x to 10x with slider control
- ✅ **Configurable speedup**: 50x, 100x, 200x, 400x time compression

## Installation

### Quick Start
```bash
cd backend
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate
pip install -r requirements.txt
python main.py
```
Server runs on `http://localhost:5001`

**Need more help?** See **[Developer Guide](docs/DEV_GUIDE.md)** for detailed setup, R2 configuration, and troubleshooting.

### Frontend
Open `test_streaming.html` or `test_audioworklet.html` in any modern web browser (Chrome, Firefox, Safari, Edge)

Or use the **[Project Dashboard](dashboard.html)** to launch tests with one click!

## Usage

### Web Streaming Interface
1. Open `test_streaming.html`
2. Select volcano, duration (1-24 hours), and compression format
3. Click "Start Streaming"
4. Audio begins playing as soon as first chunk arrives
5. View real-time waveform and spectrogram

### API Endpoints

#### `GET /api/stream/<volcano>/<hours>`
Progressive streaming endpoint with chunked delivery
- **Query params**: `format` (gzip/blosc/zstd), `level` (1-9), `zarr` (true/false)
- **Response**: Progressive binary stream with JSON headers

#### `GET /api/zarr/<volcano>/<hours>`
Complete dataset as Zarr archive
- **Query params**: `format`, `gzip_level`, `blosc_level`, `zstd_level`
- **Response**: ZIP file containing Zarr store

#### `GET /api/audio/<volcano>/<hours>`
Legacy WAV file generation
- **Response**: WAV file with 200x speedup

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

### Compression Efficiency (4-hour window)
| Format | Size | Compression Time | Decompression Time | Ratio |
|--------|------|------------------|-------------------|-------|
| Raw int16 | 2.8 MB | - | - | 1.0:1 |
| Gzip-1 | 2.35 MB | 55ms | 8.6ms | 1.19:1 |
| **Zarr+Blosc-5** | **1.98 MB** | **64ms** | **6.6ms** | **1.42:1** |

### Streaming Performance
- **Time to First Audio**: 50-100ms
- **Chunk size**: 1-10 minutes (progressive scaling)
- **Network bandwidth**: ~3.3 MB/hour per volcano
- **Client decompression**: 1-7ms per chunk

## Project Structure

```
volcano-audio/
├── backend/
│   └── main.py              # Flask API server
├── python_code/
│   ├── data_management.py   # Station filtering utilities
│   ├── audit_station_availability.py  # IRIS station queries
│   └── derive_active_stations.py      # Active channel filtering
├── data/reference/
│   ├── volcano_station_availability.json  # Complete station database
│   └── monitored_volcanoes.json          # Volcano list from USGS
├── docs/
│   ├── captains_logs/       # Development progress logs
│   └── planning/            # Architecture documentation
├── tests/                   # Compression benchmarks
├── test_streaming.html      # Main web interface
└── jupyter_notebooks/       # Data exploration notebooks
```

## Technical Details

### Audio Processing
- **Input**: Seismic data sampled at 20-100 Hz
- **Speedup**: 50-400x (configurable)
- **Output sample rate**: Original × speedup (e.g., 40 Hz × 200 = 8 kHz)
- **Data type**: int16 (16-bit signed integers, -32768 to +32767)
- **Normalization**: Detrended and scaled to full int16 range

### Compression Strategy
- **Format**: Zarr with Blosc compressor (zstd codec, shuffle filter)
- **Level**: 5 (balanced speed/size)
- **Chunk size**: Variable (1min → 2min → 5min → 10min progression)
- **Metadata**: JSON headers with sample rate, timestamps, channel info

### Browser Compatibility
- **Web Audio API**: Chrome, Firefox, Safari, Edge (92%+ browsers)
- **Fetch Streams API**: All modern browsers
- **Compression**: Pako (gzip), numcodecs (Blosc/Zstd) 