# Waveform Sync Test Harness

## Purpose

This test harness isolates the audio playback and waveform visualization system to debug synchronization issues. It uses precisely-timed audio files with full-amplitude clicks every second, making it easy to verify that:

1. Audio playback position matches visual waveform position
2. Seeking/scrubbing maintains accuracy
3. No drift accumulates over time

## Files

- **`generate_test_files.py`** - Generates test audio files with timing markers
- **`test_player.html`** - Simplified player that mimics the main app's playback system
- **`test-audio-worklet.js`** - Stripped-down AudioWorklet (circular buffer only)
- **`test-waveform-worker.js`** - Simplified waveform worker
- **`test_files/`** - Generated binary audio files (.bin format)
  - `test_30s.bin` - 30 seconds
  - `test_1m.bin` - 1 minute  
  - `test_2m.bin` - 2 minutes

## Setup

1. Generate test files (if not already done):
   ```bash
   python3 generate_test_files.py
   ```

2. Serve the directory with a local web server:
   ```bash
   # From the volcano-audio root directory:
   python3 dev_server.py
   ```

3. Open in browser:
   ```
   http://localhost:8080/tests/waveform_sync/test_player.html
   ```

## How to Test

1. **Select a test file** (30s, 1m, or 2m) and click "Load File"
2. **Play the audio** - you should hear loud clicks every second
3. **Watch the red playhead** - verify it lines up with where you hear the clicks
4. **Scrub through the waveform** - click anywhere to seek
5. **Check the diagnostics** - look for:
   - Position percentage matching visual percentage
   - Any drift warnings
   - Buffer health reports

## What to Look For

### ✅ Good Behavior
- Clicks are heard exactly when the red line crosses visible spikes
- Position % and Visual % stay synchronized (within 0.1%)
- No drift warnings in the diagnostics log
- Seeking is instant and accurate

### ⚠️ Problem Indicators
- Red line lags behind or ahead of where clicks are heard
- Position % drifts away from Visual % over time
- Drift gets worse as the file plays longer
- Seeking causes jumps or inaccurate positioning

## Architecture

This test uses the **same core architecture** as the main app:

- **Circular buffer in AudioWorklet** - 60 seconds, just like production
- **Separate waveform worker** - builds visualization off-thread
- **Position updates** - every 100ms from worklet to main thread
- **Seeking** - updates consumed sample count

**Differences from main app:**
- No CDN fetching
- No chunk decompression
- No high-pass filtering
- No DC offset removal
- Direct .bin file loading
- Single file playback (no day-spanning)

## Regenerating Test Files

To change the test files (different durations, sample rates, etc.), edit `generate_test_files.py` and run:

```bash
python3 generate_test_files.py
```

The generator creates Float32 binary files with:
- Sample rate: 44100 Hz
- Full positive spike (1.0) at every second boundary
- Full negative spike (-1.0) one sample later (creates the "click")



