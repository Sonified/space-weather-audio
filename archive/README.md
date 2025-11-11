# Archive

This folder contains outdated code, documentation, and prototypes that are no longer used but preserved for historical reference.

## Structure

- `documentation/` - Outdated documentation files
- `notebooks/` - Old Jupyter notebooks used during development
- `html/` - Old HTML test files and prototypes
- `scripts/` - Old utility scripts and test generators

## Contents

### Documentation

- `PROGRESSIVE_STREAMING_IMPLEMENTATION_ARCHIVED.md` - Describes an R2 Worker routing layer that was planned but replaced with direct CDN access (archived 2025-11-10)

- `WAVEFORM_OPTIMIZATION.md` - Documentation of waveform rendering optimization (170x speedup using min/max worker). Describes the problem, solution, and implementation. Updated to reflect that progressive rendering is now implemented (archived 2025-11-10).

### Notebooks

- `Spurr_Audification.ipynb` - Early notebook for processing Spurr seismic data, creating audio files, and generating marker files. Superseded by the modular `python_code/main.py` system.

- `dynamic_audification_test.ipynb` - Early notebook for testing multiple volcano stations with preset configurations. Used during initial development phase (Sept-Oct 2025).

### HTML

- `test_streaming.html` - Early streaming test interface. Superseded by `index.html` which uses AudioWorklet and progressive streaming.

- `make_audio.html` - Simple test file for playing mock Zarr data. Early prototype for audio playback testing.

- `dashboard.html` - Project management dashboard with task tracking and quick links. Last synced Oct 25, 2025. Superseded by current `docs/TODO.md` and `docs/captains_logs/`.

- `Simple_IRIS_Data_Audification.html` - Early test interface for streaming IRIS data with AudioWorklet. Used Railway backend directly (no CDN). Superseded by `index.html` with progressive CDN streaming (archived 2025-11-10).

- `view_log.html` - Captain's log viewer/editor using File System Access API. Used with archived `dashboard.html`. Logs are now edited directly in `docs/captains_logs/` (archived 2025-11-10).

### Scripts

- `generate_linear_sweeps.py` - Utility script for generating linear sweep test files (-32768 to +32767 int16 values) for detecting audio buffering glitches. Used during AudioWorklet development.

- `upload_linear_sweeps.py` - Script for uploading linear sweep test files to R2 storage. Used during AudioWorklet debugging phase.

- `analyze_audio_jumps.py` - Analysis tool for comparing raw downloaded audio vs actual playback to detect buffering issues. Used during AudioWorklet development.

- `debug_steim2.py` - Debug script for manually decoding STEIM2 MiniSEED frames frame-by-frame. Used during early data processing development.

- `generate_embedded_stations.py` - Script to generate embedded station data JavaScript constant from `volcano_station_availability.json`. Used to populate station dropdowns in early test interfaces.

- `seismic-processor.js` - Standalone AudioWorklet processor file. Superseded by inline AudioWorklet code embedded directly in `index.html` (archived 2025-11-10).

### Python Code

- `python_code/` - Original Python utilities and standalone tools from early development. Contains:
  - `main.py` - Standalone "Spurr Seismic Audification Tool" for fetching data, creating audio files, plots, and marker files
  - `audit_station_availability.py` - IRIS station query utility (superseded by manual maintenance)
  - `derive_active_stations.py` - Active station filtering utility (superseded by `backend/stations_config.json`)
  - Various utility modules (seismic_utils, audio_utils, plot_utils, marker_utils, etc.)
  - Superseded by `backend/collector_loop.py` and the web-based streaming system (archived 2025-11-10)

### Projects

- `SeedLink/` - Real-time SeedLink streaming and audification project. Experimental live streaming system that connects to IRIS SeedLink servers for real-time seismic data. Includes `live_audifier.py` backend, `dashboard.html` interface, and launch scripts. **Note**: This project has been developed further in a separate repository. Archived here for reference (archived 2025-11-10).

- `worker/` - Cloudflare Workers infrastructure code. Contains R2 worker for progressive streaming and cache purge worker. Includes `boot_local_mode.sh` for local development setup. Superseded by direct CDN access (`cdn.now.audio`) which provides better performance without requiring Workers. The purge functionality is still deployed but the R2 worker routing layer was never fully implemented (archived 2025-11-10).

- `render.yaml` - Render.com deployment configuration. Superseded by Railway.app deployment. Service now deploys from Railway using `collector_loop.py` (archived 2025-11-10).

### Other

- `static/js/blosc.js` - C header file (blosc.h) incorrectly named as .js. From old Blosc compression experiments. Blosc was removed from the project in favor of Zstd compression (archived 2025-11-10).

---

**For current documentation, see:**
- `/README.md` - Current system architecture
- `/docs/TODO.md` - Development priorities
- `/docs/captains_logs/` - Version history and daily progress

**For active code, see:**
- `/index.html` - Main streaming interface
- `/backend/` - Collector service
