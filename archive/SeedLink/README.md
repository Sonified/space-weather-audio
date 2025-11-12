# SeedLink Real-Time Audification

Real-time streaming and audification of live seismic data from IRIS SeedLink servers.

## What This Does

1. **Connects** to IRIS SeedLink for live seismic data
2. **Receives** 100 Hz seismic samples every ~5 seconds
3. **Processes** with high-pass filter and adaptive normalization
4. **Resamples** to 44.1 kHz for audio output
5. **Plays** through speakers/headphones in real-time
6. **Monitors** with visual diagnostic dashboard

## Quick Start

### Installation

```bash
cd SeedLink
pip install -r requirements.txt
```

### Run

```bash
./launch.sh
```

The script will:
- Clean up any existing processes
- Start the backend server
- Wait for dependencies to load
- Confirm the service is running
- Show you the dashboard URL

**Dashboard**: http://localhost:8888

### Stop

Two ways to stop:
1. **From Dashboard**: Click the "⏹ Stop Backend" button (lower left of Signal Processing card)
2. **From Terminal**: `pkill -f 'live_audifier.py'`

## Visual Diagnostics

The dashboard shows:
- **Connection Status**: Network, station, channel info
  - 🔄 Reset button to clear all statistics
- **Data Flow**: Packets received, buffer status, underruns, sample counts
- **Signal Processing**: Current amplitude, adaptive normalization, signal level meter
  - ⏹ Stop Backend button to shut down server
- **Data Update Intervals**: Real-time tracking of how often new data arrives
- **Live Amplitude Monitor**: Real-time amplitude value and visual indicator
- **Real-Time Waveform**: Live 100-second scrolling display at 10 Hz

### Dashboard Controls

- **Reset Stats**: Clears packet counts, buffers, and timing data (keeps streaming active)
- **Stop Backend**: Shuts down the audio stream and server completely

## Test Stations

Modify the last line of `live_audifier.py` to test different stations:

### Hawaiian Volcano Observatory
```python
audifier.run_audification('HV', 'NPOC', 'HHZ')  # Kīlauea caldera
audifier.run_audification('HV', 'DEVL', 'HHZ')  # Mauna Loa
```

### Other Test Stations
```python
audifier.run_audification('IU', 'ANMO', 'BHZ')  # Albuquerque (quieter)
audifier.run_audification('AV', 'SPNW', 'BHZ')  # Mt. Spurr, Alaska
```

## Signal Processing Pipeline

1. **High-pass filter** (0.1 Hz cutoff) - Removes DC drift and low-frequency noise
2. **Adaptive normalization** - Auto-adjusts to current activity level
3. **Resampling** - 100 Hz → 44.1 kHz
4. **Gain control** - 3x amplification (adjustable)
5. **Clipping protection** - Hard limit at ±1.0

## Adjusting for Haptics

To use with bass shaker/transducer instead of audio:

1. Replace `sounddevice` output with direct signal to haptic device
2. Adjust gain multiplier in line: `amplified = np.clip(resampled * 3.0, -1.0, 1.0)`
3. May want to add band-pass filter for optimal haptic response (e.g., 5-50 Hz)

## Architecture

```
IRIS SeedLink → ObsPy Client → High-Pass Filter → Normalize → Resample → Audio Buffer → Output
                      ↓
                 Flask Server → HTML Dashboard
```

## Viewing Logs

Backend logs are saved to `/tmp/seedlink_audifier.log`

```bash
# View live logs
tail -f /tmp/seedlink_audifier.log

# View recent logs
tail -50 /tmp/seedlink_audifier.log
```

## Troubleshooting

**No audio?**
- Check volume levels
- Increase gain multiplier (default is 3.0)
- Try a more active station (e.g., Kīlauea)
- Check logs: `tail -f /tmp/seedlink_audifier.log`

**Buffer underruns?**
- Check network connection
- SeedLink may have brief gaps
- Dashboard shows underrun count
- Monitor "Data Update Intervals" card for timing issues

**Connection fails?**
- Verify station is online (check IRIS Wilber3)
- Try different station code
- Check firewall settings
- View logs for detailed error messages

**Launch script fails?**
- Check conda environment exists: `conda env list`
- Verify dependencies: `pip install -r requirements.txt`
- Check port 8888 isn't already in use: `lsof -i :8888`

## Next Steps

1. ✅ Run proof-of-concept with audio
2. Test with different stations and activity levels
3. Tune filter parameters for haptic device
4. Add station switching UI controls
5. Add recording/export functionality
6. Integration with R2 storage for playback

