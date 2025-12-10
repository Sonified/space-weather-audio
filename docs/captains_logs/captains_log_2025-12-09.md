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
