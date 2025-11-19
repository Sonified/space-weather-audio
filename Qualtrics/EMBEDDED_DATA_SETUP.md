# Qualtrics Embedded Data Fields Setup

## Overview

We use **embedded data fields** (not text entry fields) to store JSON data in Qualtrics responses because:

- ✅ Embedded data fields are reliably returned by the Qualtrics API
- ✅ They appear in API responses and exports
- ❌ Text entry fields (like QID11) are NOT consistently returned by the API
- ❌ Text entry fields often don't appear in JSON exports

## Required Embedded Data Fields

### 1. `SessionTracking` - Timing Data

**Purpose:** Track timing information for participant sessions (survey start/end times, time spent on each survey, etc.)

**Setup in Qualtrics:**
1. Go to **Survey Flow** in Qualtrics
2. Add an **Embedded Data** element
3. Name it: `SessionTracking`
4. Leave value blank (will be populated via API)
5. Save

**Data Format:** JSON string containing:
```json
{
  "sessionId": "session_1234567890_abc123",
  "participantId": "R_5xRUHrX8m8iB6m5",
  "sessionStarted": "2025-11-13T18:44:29.809Z",
  "tracking": {
    "sessionStarted": "2025-11-13T18:44:29.809Z",
    "events": [
      {
        "type": "survey_completed",
        "surveyType": "pre",
        "timestamp": "2025-11-13T18:44:29.809Z"
      },
      {
        "type": "volcano_selected",
        "data": { "volcano": "kilauea" },
        "timestamp": "2025-11-13T18:44:42.153Z"
      },
      {
        "type": "fetch_data",
        "data": {
          "volcano": "kilauea",
          "station": "HV.OBL.--.HHZ",
          "duration": 24
        },
        "timestamp": "2025-11-13T18:44:42.409Z"
      }
    ]
  },
  "submissionTimestamp": "2025-11-13T18:44:50.270Z"
}
```

### 2. `JSON_data` - Interface Interaction Data

**Purpose:** Store all other JSON data about participant interactions with the interface (playback controls, waveform interactions, spectrogram interactions, etc.)

**Setup in Qualtrics:**
1. Go to **Survey Flow** in Qualtrics
2. Add an **Embedded Data** element
3. Name it: `JSON_data` (underscore, lowercase 'd')
4. Leave value blank (will be populated via API)
5. Save

**Data Format:** JSON string containing interface interaction data (to be defined as we add more tracking)

**IMPORTANT:** This field name MUST match exactly: `JSON_data` (not `JSON_Data` or `json_data`)

## Current Status

**Requested:** November 13, 2025

**Status:** ✅ Both fields confirmed in Survey Flow (verified Nov 19, 2025)

**Field Names (EXACT):**
- `SessionTracking` (capital S, capital T, no spaces)
- `JSON_data` (capital J, capital S, capital O, capital N, underscore, lowercase d, a, t, a)

## Implementation Status

1. **Submission code** (`js/qualtrics-api.js`):
   - ✅ Sends `SessionTracking` as embedded data field
   - ✅ Ready to send `JSON_data` when interface interaction tracking is added
   - ✅ **NO LONGER sends to QID11** - embedded data only (as of Nov 19, 2025)

2. **Response viewer** (`Qualtrics/response-viewer.html`):
   - ✅ Parses and displays `SessionTracking` from embedded data
   - ✅ Ready to parse and display `JSON_data` when available

3. **QID11 Text Field:**
   - ❌ **DEPRECATED** - Do not rely on QID11, it's unreliable
   - ✅ All data now goes through embedded data fields only

## Testing

After Leif sets up the embedded data fields:

1. Submit a new test response
2. Fetch the response via API (regular GET endpoint)
3. Verify `SessionTracking` appears in `result.embeddedData.SessionTracking`
4. Verify `JSON_data` appears in `result.embeddedData.JSON_data` (when implemented)

## Notes

- **Old responses won't have these fields** - only responses submitted after the fields are added to Survey Flow will include them
- **Text entry fields (QID11) are unreliable** - we're moving away from using QID11 for JSON dumps
- **Embedded data is the way forward** - all JSON data should go into embedded data fields, not text entry fields

