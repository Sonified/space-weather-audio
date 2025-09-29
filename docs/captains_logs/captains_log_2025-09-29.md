# Captain's Log - 2025-09-29

## Multi-Volcano Configuration Research: Timezone Detection

### Objective
Investigated how to make the Mt. Spurr audification system work with multiple volcanoes (specifically adding Kīlauea) and determine timezone information dynamically.

### Key Discovery: IRIS Station Metadata Analysis

**Question**: Does IRIS station metadata include timezone information?
**Answer**: ❌ No - IRIS station metadata does NOT include timezone or UTC offset information.

#### What IRIS Station Metadata DOES Include:
- **Latitude/Longitude coordinates** (precise location)
- **Elevation** (meters above sea level)
- **Site Name** (descriptive location name)
- **Network/Station/Channel codes**
- **Sensor details** (instrument type, sample rates, etc.)
- **Start/End times** (operational periods)

#### What's Missing:
- Timezone names
- UTC offsets
- Daylight saving time information

### Solution: Coordinate-Based Timezone Detection

**Implemented and tested** using `timezonefinder` + `pytz` libraries:

#### Test Results - Mt. Spurr (AV.SPCN):
- **Coordinates**: 61.223675°N, -152.184030°W
- **Site**: Chakachatna North, Mount Spurr, Alaska
- **Detected Timezone**: `America/Anchorage`
- **Current Offset**: UTC-8 (AKDT - Alaska Daylight Time)
- **Status**: ✅ Accurate detection

#### Test Results - Kīlauea (HV.OBL):
- **Coordinates**: 19.417662°N, -155.284097°W  
- **Site**: Observatory Bluff
- **Detected Timezone**: `Pacific/Honolulu`
- **Current Offset**: UTC-10 (HST - Hawaii Standard Time)
- **Status**: ✅ Accurate detection

### Technical Implementation

Created test functions that:
1. **Fetch station metadata** from IRIS FDSN station service
2. **Parse coordinates** from the response
3. **Determine timezone** using `timezonefinder.timezone_at(lat, lng)`
4. **Validate** against known timezone expectations

### Key Parameters for Multi-Volcano Configuration

Between Mt. Spurr and Kīlauea, only **4 parameters change**:

| Parameter | Mt. Spurr | Kīlauea |
|-----------|-----------|---------|
| Network   | `AV` (Alaska Volcano Observatory) | `HV` (Hawaiian Volcano Observatory) |
| Station   | `SPCN` (Spurr Creek) | `OBL` (Observatory Bluff) |
| Channel   | `BHZ` | `BHZ` (same) |
| Timezone  | `America/Anchorage` | `Pacific/Honolulu` |

### Next Steps for Multi-Volcano Implementation

**Option 1 - Static Configuration:**
```python
VOLCANO_CONFIGS = {
    "spurr": {
        "network": "AV", "station": "SPCN", "channel": "BHZ",
        "name": "Mt. Spurr", "timezone": "America/Anchorage"
    },
    "kilauea": {
        "network": "HV", "station": "OBL", "channel": "BHZ", 
        "name": "Kīlauea", "timezone": "Pacific/Honolulu"
    }
}
```

**Option 2 - Dynamic Detection:**
- Fetch station coordinates from IRIS at runtime
- Use `timezonefinder` to determine timezone automatically
- More robust for adding new stations

### Files Created
- `tests/test_timezone_detection.py` - Basic timezone detection test
- `tests/test_station_metadata_timezone.py` - Complete metadata + timezone workflow

### Dependencies Added
- `timezonefinder==8.1.0` - Geographic coordinate to timezone mapping
- `pytz` - Timezone handling (already installed)

### Major Learning
The seismic community uses **coordinate-based timezone determination** rather than embedding timezone data in station metadata. This makes sense because:
1. Timezone boundaries are political, not purely geographic
2. Daylight saving rules change over time
3. Station metadata focuses on geophysical properties

This approach will scale well for adding more volcano networks worldwide.

---

## Version v1.00 - Multi-Volcano Infrastructure Setup

### What's New in This Version:
1. **Station Preset System** - Created `dynamic_audification_test.ipynb` with 4 volcano/station configurations
2. **Timezone Detection** - Validated automatic timezone detection using coordinates
3. **Multi-Volcano Framework** - Infrastructure ready for Mt. Spurr, Kilauea seismic, and Kilauea infrasound
4. **Code Organization** - Structured python_code/ module with proper imports
5. **Testing Framework** - Enhanced test suite for station metadata and timezone detection

### Commit: "v1.00 Multi-volcano infrastructure with timezone detection and station presets"
