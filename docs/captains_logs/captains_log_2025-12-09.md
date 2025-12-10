# Captain's Log - 2025-12-09

## Username Management API

### What Was Added

Admin endpoints for managing registered usernames in the Cloudflare Worker API.

### New API Endpoints

1. **GET /api/usernames** - List all registered usernames
   - Returns array of usernames with registration timestamps
   - Sorted by `registered_at` descending (newest first)

2. **DELETE /api/username/:username** - Delete a username from the pool
   - Removes username reservation from R2 storage
   - Returns success confirmation

### Usage Examples

```bash
# List all usernames
curl "https://spaceweather.now.audio/api/usernames"

# Delete a username
curl -X DELETE "https://spaceweather.now.audio/api/username/SomeUser"
```

### Response Format

List usernames:
```json
{
  "success": true,
  "usernames": [
    {
      "username": "Sonified",
      "registered_at": "2025-12-10T03:12:55.950Z",
      "last_active_at": "2025-12-10T03:12:55.950Z"
    }
  ],
  "count": 5
}
```

### Files Modified

- `worker/src/index.js` - Added `listUsernames()` handler and routes for listing and deleting usernames

### R2 Storage

Usernames stored at: `usernames/{username}.json` (lowercase)

### Deployment

```bash
cd worker && npx wrangler deploy
```

Worker must be redeployed after adding new endpoints - initial DELETE request returned 405 until worker was updated.

---

## User Preferences Persistence

### The Problem

User selections (spacecraft, data type, date/time) were not persisting across page refreshes. The original code had legacy "volcano" naming that didn't match the actual HTML element IDs.

### Root Causes Found

1. **Element ID mismatch**: Code used `getElementById('volcano')` but HTML had `id="spacecraft"`
2. **Wrong validation**: Validated against `EMBEDDED_STATIONS` (volcano data) instead of `SPACECRAFT_DATASETS`
3. **Missing save on change**: Spacecraft/dataType change events didn't save to localStorage
4. **Programmatic changes not saved**: Restoring from Recent Searches set values but didn't trigger save

### What Was Fixed

1. **Modernized legacy volcano code to spacecraft**:
   - `loadSavedVolcano()` → `loadSavedSpacecraft()`
   - `getElementById('volcano')` → `getElementById('spacecraft')`
   - `EMBEDDED_STATIONS` validation → `SPACECRAFT_DATASETS` validation
   - `State.volcanoWithData` → `State.spacecraftWithData`
   - `switchVolcanoRegions()` → `switchSpacecraftRegions()`

2. **Added localStorage persistence for**:
   - `selectedSpacecraft` - spacecraft dropdown
   - `selectedDataType` - data type dropdown
   - `selectedStartDate`, `selectedStartTime` - start date/time
   - `selectedEndDate`, `selectedEndTime` - end date/time

3. **Added migration for existing users**:
   - Auto-migrates `selectedVolcano` → `selectedSpacecraft` on load

4. **Fixed Recent Searches restore**:
   - Now saves all restored values to localStorage after populating form fields

### Files Modified

- `js/ui-controls.js` - Renamed functions, added `loadSavedDateTime()` and `saveDateTime()`
- `js/main.js` - Updated imports, added event listeners for saving, fixed `restoreRecentSearch()`
- `js/audio-state.js` - Renamed `volcanoWithData` → `spacecraftWithData`
- `js/region-tracker.js` - Renamed `switchVolcanoRegions` → `switchSpacecraftRegions`

### localStorage Keys

```
selectedSpacecraft    - e.g., "PSP", "Wind", "GOES"
selectedDataType      - e.g., "PSP_FLD_L2_MAG_RTN"
selectedStartDate     - e.g., "2021-04-29"
selectedStartTime     - e.g., "07:40:00.000"
selectedEndDate       - e.g., "2021-04-29"
selectedEndTime       - e.g., "08:20:00.000"
```

### Behavior

- Selections save immediately on change (both user interaction and programmatic)
- On page load, all saved values are restored
- Data type only restores if valid for the selected spacecraft
- Works with both direct UI changes and Recent Searches menu

---

## GOES-16/19 High-Resolution Magnetometer Support

Added GOES-R series fluxgate magnetometer data (10 Hz) from CDAWeb.

### New Datasets

| Dataset ID | Satellite | Availability |
|------------|-----------|--------------|
| `DN_MAGN-L2-HIRES_G16` | GOES-16 | Aug 2018 - Apr 2025 |
| `DN_MAGN-L2-HIRES_G19` | GOES-19 | Jun 2025 - present |

### Files Modified

- `index.html` - Added GOES option to spacecraft dropdown
- `js/ui-controls.js` - Added GOES datasets to `SPACECRAFT_DATASETS`
- `js/data-fetcher.js` - Added `b_gse` variable mapping to `DATASET_VARIABLES`
- `js/component-selector.js` - Added GOES component labels (Bx, By, Bz in GSE)

### CDAWeb Variable

Both datasets use `b_gse` (Geocentric Solar Ecliptic coordinates) - same as Wind, THEMIS, MMS.

### Notable Events to Try

- **May 10-11, 2024** - G5 "Gannon Storm" (strongest since 2003, Dst -412 nT)
- **April 23, 2023** - G4 storm
- **October 10, 2024** - Strong CME shock (~3000 nT)

---

## Logarithmic Frequency Scale Minimum Changed

Changed log scale minimum from 0.5 Hz to 0.1 Hz for better low-frequency visibility.

### Files Modified

- `js/spectrogram-complete-renderer.js` - 3 locations
- `js/spectrogram-axis-renderer.js` - 4 locations + tick generation

### Tick Marks Now Include

0.1, 0.2, 0.5, 0.7, 1, 1.5, 2, 3, 4, 5, 7, 10, 15, 20, 30, 40, 50 Hz

---

## Fixed Multiple Initialization Bugs

Investigated console showing "Oscilloscope initialized" printing 4 times. Found and fixed two initialization bugs causing duplicate work and orphaned animation loops.

### Oscilloscope: 4 Animation Loops Running Simultaneously

**The Problem:**
`initOscilloscope()` was being called from 3 different places with no guard:
1. `js/core/flame-engine.js:202` - during flame engine startup
2. `js/main.js:383` - during audio setup
3. `js/main.js:1287` - during UI load

Each call to `initOscilloscope()` called `startRendering()`, which creates a new `requestAnimationFrame` loop. The previous loop's ID was overwritten, so old loops became **orphaned and ran forever**. Result: 3-4 rendering loops consuming CPU in parallel.

**The Fix:**
Added guard at start of `initOscilloscope()` in `js/oscilloscope-renderer.js`:
```javascript
export function initOscilloscope() {
    if (isInitialized) {
        return true;
    }
    // ... rest of function
}
```

### Colormap LUT: Unnecessary Rebuild

**The Problem:**
`buildColorLUT()` was called at module load (default "inferno"), then again when `loadColormap()` calls `setColormap()` during init. Rebuilt unnecessarily when saved colormap matched default.

**The Fix:**
Added guard in `setColormap()` in `js/colormaps.js`:
```javascript
if (currentColormap === name && colorLUT !== null) {
    return true;
}
```

### Other Modules With Proper Guards (Reference)

- `js/keyboard-shortcuts.js` - `if (keyboardShortcutsInitialized) { return; }`
- `js/modal-templates.js` - `if (modalsInitialized) { ... }`
- `js/spectrogram-worker-pool.js` - `if (this.initialized) return;`
- `js/spectrogram-playhead.js` - `if (playheadOverlayCanvas) return;`

### Files Modified

- `js/oscilloscope-renderer.js` - Added initialization guard
- `js/colormaps.js` - Added same-colormap check to skip rebuild

### Result

Console now shows each initialization message once instead of multiple times.

---

## README Overhaul - Volcano to Spacecraft

### What Was Done

Complete README replacement to reflect the project's evolution from volcano seismic sonification to spacecraft magnetic field sonification.

1. **Archived Old README**
   - Renamed `README.md` to `README_deprecated.md`
   - Moved to `archive/README_deprecated.md`
   - Old README documented the volcano/seismic audio streaming system (IRIS FDSN, Zstd chunking, R2 storage)

2. **Created New README**
   - Fresh `README.md` accurately describing the Space Weather Audification Portal
   - Documents all 6 supported spacecraft: PSP, Wind, MMS, THEMIS, Solar Orbiter, GOES
   - Covers CDAWeb integration and sonification pipeline
   - Includes tech stack, project structure, and local dev instructions

### New README Highlights

- **Spacecraft table** with instruments, coordinate systems, and data rates
- **Architecture diagram** showing Browser → CDAWeb → Web Audio flow
- **Domain separation concept** (playback vs instrument vs time domains)
- **Magnetic field components** explanation (Br, Bt, Bn)
- **Feature overview** covering playback, visualization, and sharing

### Files Changed

- `README.md` - New spacecraft-focused documentation
- `archive/README_deprecated.md` - Preserved old volcano documentation
