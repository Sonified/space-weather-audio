# 🎵 Testing the New Audio Streaming Endpoint

## Quick Start

### 1. Start the backend (if not already running)
```bash
cd backend
python main.py
```

### 2. Open the test page
Open `test_audio_stream.html` in your browser

### 3. Configure and stream
- Select a volcano/station
- Choose duration (start with 5-10 minutes for testing)
- Set hours ago (1 = 1 hour ago)
- Click "Start Stream"

### 4. Watch the magic happen!
The console will show:
```
🚀 Starting audio stream...
📤 Requesting from server...
✅ Received 2.45 MB (12.3 MB uncompressed)
🗜️  Decompressing with zstd...
✅ Decompressed: 12.3 MB
📋 Metadata parsed
✅ Extracted 360,000 float32 samples
🎵 Creating audio buffer...
✅ Audio buffer ready!
🎉 Ready to play!
```

### 5. Play the audio
Click the "▶️ Play" button and listen!

## What's Different?

### ❌ Old Way (BROKEN)
```
Browser fetches miniSEED → 
JavaScript tries to parse STEIM2 → 
FAILS with wrong sample values → 
Hours of debugging
```

### ✅ New Way (WORKS)
```
Server fetches miniSEED → 
ObsPy decodes perfectly → 
Server filters & normalizes → 
Compress with zstd → 
Browser decompresses → 
PLAYS CORRECTLY!
```

## Key Features

1. **No miniSEED parsing in browser** - ObsPy handles it on server
2. **Pre-filtered** - High-pass filter applied server-side
3. **Pre-normalized** - Audio ready to play, no client-side processing
4. **Better compression** - zstd compresses float32 samples efficiently
5. **Simple browser code** - Just decompress and play
6. **Separate pipeline** - Doesn't touch your existing chunk system

## Troubleshooting

### "CORS error"
Make sure Flask server has CORS enabled (it does in `audio_stream.py`)

### "404 Not Found"
Check that `main.py` successfully imported `audio_stream_bp`:
```python
from audio_stream import audio_stream_bp
app.register_blueprint(audio_stream_bp)
```

### "fflate is not defined"
The CDN script should load automatically. Check browser console for network errors.

### "Server error 500"
Check backend logs - usually means:
- IRIS has no data for that time/station
- Invalid time format
- Missing dependencies (scipy, zstandard)

## Next Steps

Once this works:
1. Integrate into `test_streaming.html` as an alternative mode
2. Add station picker that auto-updates from your volcano station list
3. Add time range picker with visual timeline
4. Maybe add spectrogram visualization?

## Why This Is Better

| Approach | Pros | Cons |
|----------|------|------|
| **Client-side miniSEED parsing** | No server needed for parsing | STEIM2 is complex, error-prone |
| **Server-side (this approach)** | ObsPy handles all encodings perfectly | Requires server, more bandwidth |

For your use case (volcano audio streaming), **server-side is the way to go** because:
- ✅ You already have a Render server
- ✅ ObsPy is battle-tested for seismic data
- ✅ Pre-filtering on server means consistent audio quality
- ✅ zstd compression minimizes bandwidth impact
- ✅ Browser code is simple and maintainable

Enjoy! 🌋🎵


