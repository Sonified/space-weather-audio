# Data Submission Enhancement

**Date:** November 21, 2025  
**Status:** ✅ Complete - Ready for Testing

## Overview

Enhanced the data submission system to include the 9 core workflow flags and survey answer backups in both Qualtrics embedded data and our R2 storage.

## What Was Added

### 1. The 9 Core Workflow Flags (from UX doc)

These flags drive the app's state machine and are now included in every submission:

**ONBOARDING (4 flags):**
- `study_has_seen_participant_setup` - Has user completed participant ID setup?
- `study_has_seen_welcome` - Has user seen welcome modal?
- `study_tutorial_in_progress` - User clicked "Begin Tutorial" but hasn't finished
- `study_tutorial_completed` - Tutorial fully completed

**CURRENT SESSION (3 flags):**
- `study_has_seen_welcome_back` - Has user seen "welcome back" this session?
- `study_pre_survey_completion_date` - Date when pre-survey was completed (YYYY-MM-DD)
- `study_begin_analysis_clicked_this_session` - User clicked "Begin Analysis" this session

**SESSION TIMEOUT (1 flag):**
- `study_session_timed_out` - Did this session end due to 20 minutes of inactivity?

**SESSION COMPLETION (1 flag - already existed):**
- `study_session_completion_tracker` - Which specific sessions are complete (week1/2/3, session1/2)

### 2. Survey Answers Backup in JSON_data

All pre/post/awesf/activityLevel survey answers are now included in the `JSON_data` embedded field as backup redundancy, in addition to being sent as standard Qualtrics response fields.

## Where the Data Goes

### Qualtrics (Two Embedded Data Fields)

**`SessionTracking` field** (existing, now enhanced):
```json
{
  "sessionId": "...",
  "participantId": "...",
  "sessionStarted": "...",
  "sessionEnded": "...",
  "workflowFlags": {
    "study_has_seen_participant_setup": true,
    "study_has_seen_welcome": true,
    "study_tutorial_in_progress": false,
    "study_tutorial_completed": true,
    "study_has_seen_welcome_back": true,
    "study_pre_survey_completion_date": "2025-11-21",
    "study_begin_analysis_clicked_this_session": true,
    "study_session_timed_out": false
  },
  "globalStats": { ... },
  "cumulativeStats": { ... },
  "sessionCompletionTracker": { ... },
  "tracking": { ... },
  "regions": [ ... ],
  "surveyResponses": { ... }
}
```

**`JSON_data` field** (existing, now enhanced):
```json
{
  "surveyAnswers": {
    "pre": { "calm": 5, "energized": 4, ... },
    "post": { "calm": 6, "energized": 5, ... },
    "awesf": { "slowDown": 5, "reducedSelf": 4, ... },
    "activityLevel": { "level": 3 }
  },
  "workflowState": {
    "study_has_seen_participant_setup": true,
    "study_has_seen_welcome": true,
    ...
  },
  "interactions": [ ... ],
  "timestamp": "2025-11-21T..."
}
```

### Our Server (R2 Storage)

**`user-status/status.json`** (overwritten each time):
```json
{
  "participantId": "P001ABC",
  "lastUpdated": "2025-11-21T...",
  "studyProgress": {
    "hasSeenParticipantSetup": true,
    "hasSeenWelcome": true,
    "tutorialInProgress": false,
    "tutorialCompleted": true,
    "hasSeenWelcomeBack": true,
    "preSurveyCompletionDate": "2025-11-21",
    "beginAnalysisClickedThisSession": true,
    "sessionTimedOut": false,
    "sessionCompletionTracker": { ... },
    "weeklySessionCount": 2,
    "weekStartDate": "2025-11-18",
    "lastAwesfDate": "2025-11-21"
  },
  "sessionTracking": {
    "totalSessionsStarted": 5,
    "totalSessionsCompleted": 4,
    "totalSessionTime": 3600000,
    "totalSessionTimeHours": 1.0,
    "sessionHistory": [ ... ],
    "currentSessionStart": "2025-11-21T..."
  },
  "preferences": {
    "selectedVolcano": "kilauea",
    "selectedMode": "study"
  },
  "responses": { ... }
}
```

**`submissions/{participantId}_Complete_{timestamp}.json`** (append-only):
- Full jsonDump from Qualtrics submission (includes everything above)
- Regions and features
- Survey responses
- Session timing and completion status

## Files Modified

### Frontend
1. **`js/ui-controls.js`** - Added workflow flags to `jsonDump` and created `jsonData` object
   - Protected with try-catch blocks for safety
   - Includes all 9 core workflow flags
   - Includes survey answer backups in JSON_data field

2. **`js/data-uploader.js`** - Updated `gatherUserData()` to collect all workflow flags
   - Added all 9 flags to data gathering
   - Sends to backend for R2 storage

### Backend
3. **`backend/collector_loop.py`** - Updated `/api/upload-user-data` endpoint
   - Saves all 9 workflow flags to `status.json`
   - Includes session history and current session data
   - Includes full response data backup

## Safety Features

- All localStorage reads are protected with try-catch blocks
- Safe defaults provided if data is missing or corrupted
- Backward compatible - won't crash if flags don't exist
- Console warnings if data gathering fails

## Testing Checklist

- [ ] Submit a test response and verify `SessionTracking` includes `workflowFlags`
- [ ] Verify `JSON_data` includes `surveyAnswers` and `workflowState`
- [ ] Check R2 `status.json` includes all 9 workflow flags
- [ ] Check R2 `submissions/` folder has complete data
- [ ] Verify no console errors during submission
- [ ] Test with missing localStorage flags (should use safe defaults)

## Next Steps

1. Test submission flow with new data fields
2. Verify data appears correctly in Qualtrics response viewer
3. Verify data appears correctly in R2 storage
4. Monitor console logs for any errors or warnings

## Notes

- The workflow flags are read from localStorage at submission time, so they represent the state at the moment of submission
- Survey answers are sent THREE ways for maximum redundancy:
  1. Standard Qualtrics response fields (QID1, QID2, etc.)
  2. SessionTracking embedded data (surveyResponses object)
  3. JSON_data embedded data (surveyAnswers object)
- All data is backward compatible - old submissions without these fields will still work

