# Audification Pipeline - Audio Streaming Endpoint

## Overview

Simple end-to-end pipeline for streaming seismic data as audio to the browser.

**Completely separate from the data collection pipeline** (`cron_loop.py` / `cron_job.py`) - this endpoint exists purely for on-demand browser audio playback.

## Architecture

**Backend:** Railway (`audio_stream.py` endpoint)  
**Frontend:** `index.html`  
**Processing:** Server applies high-pass filter, browser applies normalization

## Why Server + Browser Processing?

The JavaScript miniSEED parser struggles with STEIM2 compression. Instead of fighting with complex differential encoding in the browser:

1. **Server handles data acquisition** - Fetches from IRIS, ObsPy decodes (STEIM2, STEIM1, etc.)
2. **Server handles gaps** - Merge, dedupe, linear interpolation for missing samples
3. **Server applies high-pass filter** - Butterworth filter at original sample rate
4. **Server sends float32** - Compressed with zstd
5. **Browser normalizes** - Allows user to adjust normalization on-the-fly
6. **Browser plays** - Web Audio API with AudioWorklet

## Complete Pipeline Flow

```
Browser (index.html)
    ↓
POST /api/stream-audio
{
  network, station, location, channel,
  starttime, duration,
  highpass_hz: 0.5,      // Server applies this
  normalize: false        // Browser does this
}
    ↓
Railway Backend (audio_stream.py)
    ↓
STEP 1: Fetch miniSEED from IRIS
    ↓
STEP 2: ObsPy decode + merge + gap fill
  - Merge overlapping traces (dedupe)
  - Detect gaps via timestamps
  - Fill gaps with linear interpolation
  - Result: continuous int32 array
    ↓
STEP 3: Apply high-pass Butterworth filter (optional)
  - 4th order Butterworth filter
  - Cutoff at requested frequency (e.g., 0.5 Hz)
  - Uses scipy.signal.filtfilt
  - Converts to float32
    ↓
STEP 4: Create response blob
  - [4 bytes: metadata_length (uint32)]
  - [metadata_json (includes sample_rate, npts, etc.)]
  - [float32 samples array]
    ↓
STEP 5: Compress with zstd level 3
    ↓
Send to browser
    ↓
Browser (index.html)
    ↓
STEP 6: Decompress with fzstd
    ↓
STEP 7: Parse blob
  - Read metadata_length (4 bytes)
  - Parse metadata JSON
  - Extract float32 samples
    ↓
STEP 8: Normalize (browser-side)
  - Find max absolute value
  - Scale to [-1, 1]
    ↓
STEP 9: Send to AudioWorklet
  - Chunks of 1024 samples
  - Prevents audio thread blocking
    ↓
STEP 10: Play via Web Audio API
```

## API Endpoint

### `POST /api/stream-audio`

**Purpose:** Fetch seismic data, process on server, stream to browser for audio playback

**Request:**
```json
{
  "network": "HV",
  "station": "NPOC",
  "location": "",
  "channel": "HHZ",
  "starttime": "2025-10-31T12:00:00Z",
  "duration": 3600,
  "speedup": 200,
  "highpass_hz": 0.5,
  "normalize": false,
  "send_raw": false
}
```

**Request Fields:**
- `network`, `station`, `location`, `channel`: SEED identifier
- `starttime`: ISO 8601 timestamp (UTC)
- `duration`: Duration in seconds
- `speedup`: Metadata only (for display)
- `highpass_hz`: Cutoff frequency (0 or false to disable)
- `normalize`: Server-side normalization (false = browser normalizes)
- `send_raw`: Send int32 instead of float32 (false = float32)

**Response:**
- Content-Type: `application/octet-stream`
- Headers: `X-Compression: zstd`, `X-Sample-Rate`, `X-Sample-Count`
- Body: zstd-compressed blob

**Blob Format (after decompression):**
```
[4 bytes: metadata_length (uint32 little-endian)]
[metadata_length bytes: JSON metadata]
[remaining bytes: float32 samples]
```

**Metadata JSON:**
```json
{
  "network": "HV",
  "station": "NPOC",
  "location": "",
  "channel": "HHZ",
  "starttime": "2025-10-31T12:00:00.000000Z",
  "endtime": "2025-10-31T13:00:00.000000Z",
  "original_sample_rate": 100.0,
  "npts": 360000,
  "duration_seconds": 3600,
  "speedup": 200,
  "highpass_hz": 0.5,
  "normalized": false,
  "format": "float32",
  "compressed": "zstd",
  "obspy_decoder": true
}
```

## Data Processing Details

### Gap Filling with Linear Interpolation

When IRIS returns seismic data with gaps (missing samples), the server fills them using linear interpolation:

**Detection:**
- ObsPy detects gaps by comparing trace end times with next trace start times
- Gap detected when: `trace[i].endtime < trace[i+1].starttime`

**Interpolation:**
```python
# ObsPy's merge method handles this automatically
st.merge(method=1, fill_value='interpolate')

# How it works:
# 1. Calculate missing samples: round((gap_end - gap_start) * sample_rate)
# 2. Get last value before gap: trace[i].data[-1]
# 3. Get first value after gap: trace[i+1].data[0]
# 4. Linear interpolation between these two values
# 5. Fill exactly the calculated number of missing samples
```

**Result:** Continuous int32 array with no gaps, ready for filtering

### High-Pass Filtering

**Algorithm:** 4th-order Butterworth filter (zero-phase)  
**Implementation:** `scipy.signal.butter()` + `scipy.signal.filtfilt()`  
**Applied:** After gap filling, before normalization  
**Cutoff:** User-specified (typically 0.02 Hz for volcanic signals)

```python
def highpass_filter(data, sample_rate, cutoff_hz=0.5, order=4):
    nyquist = sample_rate / 2
    normalized_cutoff = cutoff_hz / nyquist
    b, a = signal.butter(order, normalized_cutoff, btype='high', analog=False)
    filtered = signal.filtfilt(b, a, data)  # Zero-phase filtering
    return filtered
```

**Why zero-phase?** `filtfilt()` runs the filter forwards then backwards, eliminating phase distortion.

### Browser-Side Normalization

**Why browser instead of server?**
- Allows user to see raw filtered data range
- Enables future features (adjustable normalization on-the-fly)
- Server sends float32 after filtering (preserves full dynamic range)

**Algorithm:**
```javascript
function normalize(data) {
    let max = 0;
    for (let i = 0; i < data.length; i++) {
        const absVal = Math.abs(data[i]);
        if (absVal > max) max = absVal;
    }
    
    if (max === 0) return data;
    
    const normalized = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
        normalized[i] = data[i] / max;
    }
    
    return normalized;
}
```

## Testing

1. **Start backend:**
   ```bash
   cd backend
   ./start_local_server.sh  # Port 5001
   ```

2. **Open:**
   ```
   index.html
   ```

3. **Select volcano, station, duration**

4. **Click "📡 Fetch Data"**

## Dependencies

### Backend
- `obspy` - miniSEED decoding
- `scipy` - high-pass filtering
- `zstandard` - compression
- `numpy` - array processing

### Browser
- `fflate` - zstd decompression (loaded from CDN)
- Web Audio API (built-in)

## Processing Division: Server vs Browser

### Server (audio_stream.py)
✅ **IRIS data fetching** - Handles miniSEED download  
✅ **ObsPy decoding** - STEIM2, STEIM1, etc.  
✅ **Gap filling** - Linear interpolation for missing samples  
✅ **High-pass filtering** - Butterworth filter at original sample rate  
✅ **Data conversion** - int32 → float32  
✅ **Compression** - Zstd level 3  

### Browser (index.html)
✅ **Decompression** - fzstd.js  
✅ **Normalization** - Scale to [-1, 1]  
✅ **Playback** - AudioWorklet + Web Audio API  
✅ **Visualization** - Real-time waveform + spectrogram  

## Benefits

✅ **No STEIM2 parsing in JavaScript** - ObsPy handles it perfectly  
✅ **Automatic gap filling** - Linear interpolation for seamless playback  
✅ **Flexible normalization** - Browser-side allows future adjustability  
✅ **Better compression** - Zstd level 3 (2-3x better than gzip)  
✅ **Simple browser code** - Just decompress, normalize, play  
✅ **Separate from data collector** - Doesn't interfere with cron pipeline  

## Notes

- This does NOT touch the data collection pipeline (`cron_loop.py` / `cron_job.py`)
- This does NOT create or modify R2 cached files
- This is purely for **on-demand audio streaming**
- Server applies high-pass filter, browser applies normalization
- Gap filling uses ObsPy's `merge(fill_value='interpolate')`



