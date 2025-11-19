# R2 User Data Backup System

## Overview

All user data is automatically backed up to Cloudflare R2 storage in addition to being submitted to Qualtrics. This provides:

1. **Redundant data storage** - Even if Qualtrics submission fails, we have a backup
2. **Session tracking metadata** - We store data that doesn't go into Qualtrics
3. **User progress recovery** - We can reconstruct user state from R2 if needed
4. **Retroactive data collection** - Existing users will have their data backed up on next submission

## File Structure

```
hearts-data-cache/volcano-audio-anonymized-data/participants/
├── P001ABC/
│   ├── user-status/
│   │   └── status.json (overwritten each time - current state)
│   └── submissions/
│       ├── P001ABC_Complete_2025-11-19_14-30-45.json
│       ├── P001ABC_Complete_2025-11-20_09-15-22.json
│       └── P001ABC_Complete_2025-11-21_16-42-10.json (append-only)
├── P002XYZ/
│   ├── user-status/
│   └── submissions/
...
```

### Folder Details

#### `user-status/status.json`
- **Purpose**: Current state of the user
- **Update Strategy**: Overwritten on each submission
- **Contents**:
  - Study progress flags (hasSeenWelcome, tutorialCompleted, etc.)
  - Session tracking stats (totalSessionsStarted, totalSessionsCompleted, totalSessionTime)
  - Preferences (selectedVolcano, selectedMode)

#### `submissions/`
- **Purpose**: Historical record of all submissions
- **Update Strategy**: Append-only (never overwritten)
- **Filename Format**: `{participantId}_Complete_{YYYY-MM-DD_HH-MM-SS}.json`
- **Contents**:
  - Full jsonDump from Qualtrics submission
  - Regions and features
  - Survey responses
  - Session timing and completion status

## Implementation

### Backend (Python)

**File**: `backend/collector_loop.py`

**Endpoint**: `POST /api/upload-user-data`

**Request Body**:
```json
{
  "participantId": "P001ABC",
  "timestamp": "2025-11-19T14:30:45.123Z",
  "uploadType": "submission",
  "submissionData": { /* jsonDump */ },
  
  // Study progress
  "hasSeenParticipantSetup": true,
  "hasSeenWelcome": true,
  "hasSeenTutorial": true,
  "tutorialCompleted": true,
  
  // Session tracking
  "weeklySessionCount": 2,
  "weekStartDate": "2025-11-17",
  "totalSessionsStarted": 5,
  "totalSessionsCompleted": 4,
  "totalSessionTime": 7200000,
  "totalSessionTimeHours": 2.0,
  
  // Session history
  "sessionHistory": [ /* array of session records */ ],
  
  // Preferences
  "selectedVolcano": "Okmok",
  "selectedMode": "study"
}
```

**Response**:
```json
{
  "status": "success",
  "participantId": "P001ABC",
  "timestamp": "2025-11-19T14:30:45.123Z",
  "filesUploaded": [
    "volcano-audio-anonymized-data/participants/P001ABC/user-status/status.json",
    "volcano-audio-anonymized-data/participants/P001ABC/submissions/P001ABC_Complete_2025-11-19_14-30-45.json"
  ]
}
```

### Frontend (JavaScript)

**File**: `js/data-uploader.js`

**Functions**:

1. **`uploadUserStatus(participantId)`**
   - Uploads current user state to `user-status/status.json`
   - Call periodically or when key flags change
   - Returns: `{ status: 'success', ... }`

2. **`uploadSubmissionData(participantId, submissionData)`**
   - Uploads submission to `submissions/{id}_Complete_{timestamp}.json`
   - Also updates `user-status/status.json`
   - Call after successful Qualtrics submission or timeout
   - Returns: `{ status: 'success', ... }`

**Integration Points**:

- **`js/ui-controls.js`** (line ~2871):
  - After successful Qualtrics submission
  - Calls `uploadSubmissionData(participantId, jsonDump)`

- **`js/session-management.js`** (line ~294):
  - After timeout submission to Qualtrics
  - Calls `uploadSubmissionData(participantId, jsonDump)`

## Data Gathering

The system automatically collects all localStorage data:

**Study Progress**:
- `study_has_seen_participant_setup`
- `study_has_seen_welcome`
- `study_has_seen_tutorial`
- `study_tutorial_completed`

**Session Tracking**:
- `study_weekly_session_count`
- `study_week_start_date`
- `study_last_awesf_date`
- `study_total_sessions_started`
- `study_total_sessions_completed`
- `study_total_session_time`
- `study_session_history` (array of all session records)
- `study_current_session_start`

**Preferences**:
- `selectedVolcano`
- `selectedMode`

**Response Data**:
- `participant_response_{participantId}` (all survey responses)

## Error Handling

- All upload calls are wrapped in `try-catch` blocks
- Failed uploads log warnings but **don't block** Qualtrics submission
- Data remains in localStorage even if upload fails
- Next successful upload will include latest data

## Retroactive Data Collection

**For existing users**:
- Data is backed up on their **next submission**
- We capture their full localStorage state at that moment
- Historical submissions won't be in R2 (only in Qualtrics)
- Future submissions will create timestamped files in R2

## Testing

### Local Testing

1. Start local collector:
```bash
cd backend
./start_local_collector.sh
```

2. Test upload:
```bash
curl -X POST http://localhost:5005/api/upload-user-data \
  -H "Content-Type: application/json" \
  -d '{
    "participantId": "TEST123",
    "uploadType": "submission",
    "submissionData": {"test": "data"}
  }'
```

### Production Testing

Use the frontend console:
```javascript
import('./js/data-uploader.js').then(module => {
  module.uploadSubmissionData('TEST123', { test: 'data' })
    .then(result => console.log('✅ Upload result:', result));
});
```

## Monitoring

**Backend Logs** (Railway dashboard):
```
✅ Uploaded user data for P001ABC: [
  'volcano-audio-anonymized-data/participants/P001ABC/user-status/status.json',
  'volcano-audio-anonymized-data/participants/P001ABC/submissions/P001ABC_Complete_2025-11-19_14-30-45.json'
]
```

**Frontend Console**:
```
✅ Submission data uploaded to R2: {
  status: 'success',
  participantId: 'P001ABC',
  filesUploaded: [...]
}
```

**R2 Browser** (Cloudflare dashboard):
- Navigate to R2 bucket
- Browse to `volcano-audio-anonymized-data/participants/`
- Verify participant folders and files

## Privacy & Security

- All data is **anonymized** (participant IDs only, no PII)
- Stored in private R2 bucket (not publicly accessible)
- Same data that goes to Qualtrics (no additional sensitive data)
- Follows existing study IRB protocols

## Future Enhancements

- [ ] Batch upload multiple sessions (offline support)
- [ ] Automatic retry with exponential backoff
- [ ] Periodic status uploads (not just on submission)
- [ ] Admin dashboard to view/download participant data
- [ ] Data export tool for research team

