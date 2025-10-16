# Captain's Log - 2025-10-16

## Key Findings from 2025-10-15 Session

### 1. **Hourly Chunks vs Full Request Test - DEBUNKED**
We ran a head-to-head test comparing:
- **Full request** (1 big API call for 24 hours)
- **Hourly chunks** (24 separate 1-hour API calls)

**Result:** The "difference" was FAKE - just timing artifacts from running the tests at different times. Both approaches get the SAME data from IRIS. No real advantage to hourly chunks for normal 24-hour requests.

**Files created (and since removed):**
- `tests/test_full_vs_hourly.py` - The comparison test
- `tests/investigate_data_difference.py` - Deep dive investigation
- `docs/captains_logs/captains_log_2025-10-15.md` - The previous day's log with now-debunked findings.

### 2. **Project Renamed**
- GitHub repo: `Sonified/Mt_Spurr` → `Sonified/volcano-audio`
- Local folder: `spurr-audification` → `volcano-audio`
- Git remote URL updated in `.git/config`

### 3. **New Vision: Multi-Volcano System**
The project will now focus on building a system that:
- Has a **watch list** of currently active volcanoes (from USGS API)
- Shows all monitored volcanoes in a dropdown
- Allows a user to click a volcano to fetch data and audify it.
- Uses the USGS API: `https://volcanoes.usgs.gov/hans-public/api/volcano/getMonitoredVolcanoes`

### 4. **Data Structure Planning**
We are about to create the following data structure:
```
data/
  ├── usgs_monitored_volcanoes.json
  └── volcano_station_mappings.json
```

### 5. **Current Version**
- v1.03 in `python_code/__init__.py`
- Timezone detection is working.
- Multi-volcano support for Spurr and Kilauea has been tested.

### 6. **Updates on 2025-10-16**
- Implemented full IRIS station audit capturing per-channel metadata (lat/lon/elev, azimuth/dip, start/end, sample_rate, distance_km) for all monitored volcanoes.
- Created `data/reference/volcano_station_availability.json` and `volcano_station_summary.csv`.
- Added `derive_active_stations` to generate `data/reference/active_volcano_stations.json` with active channels (empty or future end_time).
- Built an interactive Jupyter UI to select volcano, type (seismic/infrasound), last N hours, and channel, then fetch and audify data.
- Fixed robustness issues (module reloads, default selections, no-data guard).

### Commit
- Version Tag: v1.03
- Message: Add active-station filtering, full audit outputs, and interactive audify UI
