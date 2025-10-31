# Audio Streaming Endpoint

## Overview

**Completely separate from the chunk creation pipeline** - this endpoint exists purely for browser-based audio playback.

## Why This Exists

The JavaScript miniSEED parser was struggling with STEIM2 compression. Instead of fighting with complex differential encoding in the browser, we:

1. **Let ObsPy handle it** - Server decodes miniSEED (including STEIM2) perfectly
2. **Pre-process on server** - High-pass filter and normalize before sending
3. **Compress with zstd** - Much better compression than gzip for audio
4. **Simple browser** - Just decompress float32 samples and play

## Flow

```
Browser Request
    ↓
Server fetches miniSEED from IRIS
    ↓
ObsPy decodes (handles STEIM2, STEIM1, etc.)
    ↓
Apply high-pass Butterworth filter
    ↓
Normalize to [-0.95, 0.95]
    ↓
Convert to float32
    ↓
Create blob: [metadata_length][metadata_json][samples]
    ↓
Compress with zstd
    ↓
Send to browser
    ↓
Browser decompresses with fflate
    ↓
Play with Web Audio API
```

## API Endpoint

### `POST /api/stream-audio`

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
  "highpass_hz": 0.5
}
```

**Response:**
- Content-Type: `application/octet-stream`
- Content-Encoding: `zstd`
- Headers: `X-Sample-Rate`, `X-Sample-Count`, etc.
- Body: zstd-compressed blob

**Blob Format (after decompression):**
```
[4 bytes: metadata_length (uint32 little-endian)]
[metadata_length bytes: JSON metadata]
[remaining bytes: float32 samples]
```

## Testing

1. **Start backend:**
   ```bash
   cd backend
   python main.py
   ```

2. **Open test page:**
   ```
   test_audio_stream.html
   ```

3. **Select station and click "Start Stream"**

## Dependencies

### Backend
- `obspy` - miniSEED decoding
- `scipy` - high-pass filtering
- `zstandard` - compression
- `numpy` - array processing

### Browser
- `fflate` - zstd decompression (loaded from CDN)
- Web Audio API (built-in)

## Benefits

✅ **No STEIM2 parsing in JavaScript**  
✅ **Server does all the heavy lifting**  
✅ **Better compression (zstd > gzip)**  
✅ **Pre-filtered and normalized**  
✅ **Simple browser code**  
✅ **Doesn't interfere with chunk pipeline**  

## Notes

- This does NOT touch the existing `/api/request` or `/api/request-stream-v2` endpoints
- This does NOT create or modify R2 cache
- This is purely for on-demand audio streaming
- Server applies high-pass filter and normalization before sending
- Browser just decompresses and plays


