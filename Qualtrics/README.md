# Qualtrics API Integration

This folder contains scripts for integrating with the Qualtrics API to collect PANAS survey responses.

## Files

- `fetch_survey_structure.py` - Proof of concept script to fetch and list all questions in the survey

## Usage

### Fetch Survey Structure

Run the proof of concept script to see all questions currently on the survey:

```bash
python Qualtrics/fetch_survey_structure.py
```

This will:
1. Connect to the Qualtrics API
2. Fetch the survey structure for survey `SV_bNni117IsBWNZWu`
3. Display all questions with their Question IDs (QID1, QID2, etc.)
4. Save the full response to `survey_structure.json`

## API Configuration

- **Base URL:** `https://oregon.yul1.qualtrics.com/API/v3/`
- **Survey ID:** `SV_bNni117IsBWNZWu`
- **Data Center ID:** `oregon.yul1`

## Next Steps

1. Ensure Leif has created all 6 PANAS questions + Participant ID field in Qualtrics
2. Run `fetch_survey_structure.py` to get the actual Question IDs
3. Use those Question IDs to submit responses via the API

## Embedded Data Fields

**IMPORTANT:** See [EMBEDDED_DATA_SETUP.md](./EMBEDDED_DATA_SETUP.md) for information about required embedded data fields.

We use embedded data fields (not text entry fields) to store JSON data because:
- ✅ Embedded data fields are reliably returned by the Qualtrics API
- ❌ Text entry fields (like QID11) are NOT consistently returned by the API

**Required Fields:**
- `SessionTracking` - Timing data for participant sessions
- `json_data` - Interface interaction data (future)

**Status:** Pending setup in Qualtrics Survey Flow (requested Nov 13, 2025)

