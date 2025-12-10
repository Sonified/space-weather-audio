# Space Weather Audification Portal

A web-based platform for sonifying NASA spacecraft magnetic field data from CDAWeb. Transform space weather measurements into audible sound for scientific analysis and exploration.

**Live Demo**: [spaceweather.now.audio](https://spaceweather.now.audio)

## Overview

This project fetches real-time and historical magnetic field data from NASA's Coordinated Data Analysis Web (CDAWeb), converts it into audio through sonification, and provides interactive visualization and analysis tools. By listening to space weather data, researchers and enthusiasts can perceive patterns and phenomena that might be missed in traditional visual analysis.

## Supported Spacecraft

| Spacecraft | Instrument | Coordinates | Data Rates |
|------------|------------|-------------|------------|
| **Parker Solar Probe (PSP)** | FLasMag | RTN | Full Cadence, 4 SA/Cycle |
| **Wind** | MFI | GSE | Standard |
| **MMS** | FGM | GSE | Survey, Burst |
| **THEMIS** (A-E) | SCM | GSE | Fast Survey |
| **Solar Orbiter** | MAG | RTN | Normal, Burst |
| **GOES** (16/19) | Magnetometer | GSE | 10 Hz |

## Features

### Data & Playback
- Select spacecraft, dataset, and custom date/time ranges
- Play/pause with loop and crossfade support
- Adjustable playback speed and volume (0-200%)
- Component switching (Br, Bt, Bn - radial, tangential, normal)
- High-pass filtering (0.01, 0.02, 0.045 Hz)
- De-trend toggle for DC offset removal
- Download audio as WAV files

### Visualization
- Real-time waveform with color-mapped amplitude
- Full spectrogram with frequency analysis
- Multiple frequency scales (Linear, Square Root, Logarithmic)
- 7 colormap options (Inferno, Solar, Aurora, Jet, Plasma, Turbo, Viridis)
- Real-time oscilloscope display
- Region/feature annotation for scientific analysis

### Sharing & Collaboration
- Session sharing via unique URLs
- OG metadata for social media previews
- Recent searches dropdown
- Participant tracking for research studies

## Architecture

```
Browser → CDAWeb API → WAV Decoding → Web Audio API → Speakers
                              ↓
                    Canvas Visualization
```

### How Sonification Works

1. **Data Request**: Browser requests magnetic field data from CDAWeb with time range
2. **WAV Response**: CDAWeb returns pre-audified WAV at 22kHz intermediate rate
3. **Resampling**: AudioContext resamples to native 44.1kHz
4. **Playback**: Web Audio API handles playback with gain and analyser nodes
5. **Visualization**: Canvas renders waveforms and spectrograms in real-time

### Domain Separation

The application maintains three distinct domains:
- **Playback Domain**: 44.1kHz (audio output)
- **Instrument Domain**: Original spacecraft frequency (Y-axis labels)
- **Time Domain**: Real-world UTC timestamps

## Tech Stack

**Frontend**
- Vanilla ES6 JavaScript (no framework)
- Web Audio API for playback
- Canvas API for visualization
- Web Workers for parallel processing
- IndexedDB for local caching

**Backend/Infrastructure**
- Cloudflare Workers (serverless API)
- Cloudflare R2 (object storage)
- CDAWeb API (NASA data source)

## Project Structure

```
space-weather-audio/
├── index.html              # Main application entry
├── js/
│   ├── main.js             # Application orchestration
│   ├── audio-player.js     # Playback controls
│   ├── data-fetcher.js     # CDAWeb API integration
│   ├── spectrogram-renderer.js
│   ├── waveform-renderer.js
│   ├── region-tracker.js   # Feature annotation
│   ├── share-modal.js      # Session sharing
│   └── ...                 # 40+ specialized modules
├── worker/
│   └── src/index.js        # Cloudflare Worker API
└── docs/
    ├── TODO.md
    └── captains_logs/      # Development history
```

## Local Development

### Quick Start

1. Clone the repository
2. Open `index.html` in a browser
3. Select a spacecraft, dataset, and time range
4. Click Play

The frontend fetches data directly from CDAWeb - no local backend required for basic usage.

### Cloudflare Worker (Optional)

For session sharing and thumbnail generation:

```bash
cd worker
npm install
npx wrangler dev
```

## Data Source

All spacecraft data comes from NASA's CDAWeb:
- **API**: `https://cdaweb.gsfc.nasa.gov/WS/cdasr/1`
- **Dataview**: Space Physics (sp_phys)
- **Format**: Pre-audified WAV files

## Magnetic Field Components

- **Br** (Radial): Pointing away from the Sun/Earth
- **Bt** (Tangential): Along orbital direction
- **Bn** (Normal): Perpendicular to orbital plane

Coordinate systems vary by spacecraft (RTN for heliospheric, GSE for Earth-orbiting).

## License

MIT

## Acknowledgments

- NASA CDAWeb for providing spacecraft data access
- The space physics community for open data policies
