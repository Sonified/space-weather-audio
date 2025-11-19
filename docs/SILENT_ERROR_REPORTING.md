# Silent Error Reporting System

**Created:** November 19, 2025  
**Purpose:** Automatically detect and report metadata mismatches without disrupting user experience

---

## Overview

The silent error reporting system quietly collects and submits metadata mismatches and other non-critical errors to the backend for analysis. Unlike the main error reporter (which shows UI to users), this system works completely in the background.

## Architecture

### Frontend Components

1. **`js/silent-error-reporter.js`** (NEW)
   - Core silent reporting module
   - Captures console logs for context
   - Throttles reports (max 1 per error type per session)
   - Provides specialized functions for different error types

2. **Integration Points:**
   - `Qualtrics/participant-response-manager.js` - Reports session ID mismatches and localStorage parse errors
   - `js/session-management.js` - Reports timeout-related inconsistencies
   - `js/main.js` - Initializes system on app startup

### Backend Component

**Endpoint:** `POST /api/report-error`  
**Handler:** `collector_loop.py:report_error()`  
**Storage:** R2 bucket at `hearts-data-cache/interface_overheating_reports/`

**Filename Format:** `YYYY_MM_DD_ParticipantID_R_123456-1.json`  
(Counter auto-increments for multiple reports from same user on same day)

---

## Report Types

### 1. Session ID Mismatch
**Function:** `reportSessionIdMismatch(storedSessionId, currentSessionId, context)`

**Triggered When:**
- Stored responses have different session ID than current session state
- Occurs in `getSessionResponses()` and `saveSurveyResponse()`

**Example:**
```javascript
reportSessionIdMismatch('session_123', 'session_456', {
    context: 'getSessionResponses',
    hasPre: true,
    hasPost: false,
    participantId: 'R_1234567890'
});
```

### 2. localStorage Parse Error
**Function:** `reportLocalStorageParseError(key, rawValue, error)`

**Triggered When:**
- JSON.parse() fails on localStorage data
- Occurs when reading corrupted session responses

**Example:**
```javascript
reportLocalStorageParseError(
    'participant_response_R_123',
    '{corrupt json...',
    new SyntaxError('Unexpected token')
);
```

### 3. Session State Inconsistency
**Function:** `reportSessionStateInconsistency(issue, sessionState, responses)`

**Triggered When:**
- Session timeout occurs but no pre-survey exists
- Session IDs don't match during timeout submission

**Example:**
```javascript
reportSessionStateInconsistency(
    'timeout_submission_session_id_mismatch',
    sessionState,
    responses
);
```

### 4. Generic Metadata Mismatch
**Function:** `reportMetadataMismatch(errorType, details)`

**Use For:** Any other metadata inconsistency not covered by specialized functions

---

## Report Structure

```json
{
    "participantId": "R_1234567890123456",
    "timestamp": "2025-11-19T12:34:56.789Z",
    "errorType": "session_id_mismatch",
    "errorMessage": "Metadata Mismatch: session_id_mismatch",
    "errorDetails": {
        "type": "metadata_mismatch",
        "category": "session_id_mismatch",
        "details": {
            "storedSessionId": "session_123",
            "currentSessionId": "session_456",
            "context": "getSessionResponses",
            "hasPre": true,
            "hasPost": false
        },
        "handled": true,
        "severity": "warning"
    },
    "consoleLogs": [
        {
            "timestamp": "2025-11-19T12:34:50.000Z",
            "level": "warn",
            "message": "Session ID mismatch detected"
        }
    ],
    "userAgent": "Mozilla/5.0...",
    "url": "https://example.com/",
    "viewport": {
        "width": 1920,
        "height": 1080
    },
    "source": "silent-error-reporter",
    "sessionInfo": {
        "mode": "study",
        "volcano": "kilauea"
    }
}
```

---

## Key Features

### 1. Throttling
- **One report per error type per session**
- Prevents spam if error occurs repeatedly
- Tracked in `reportedErrors` Set

### 2. Silent Operation
- **No UI shown to user**
- No alerts, modals, or interruptions
- Console logs only (prefixed with 🔕)

### 3. Context Capture
- **Last 50 console logs** included with each report
- User agent, URL, viewport dimensions
- Current mode and volcano selection

### 4. Fail-Safe
- **Non-blocking:** If report fails, app continues
- Errors in reporter are caught and logged
- Uses `.catch()` to prevent unhandled rejections

---

## Console Output Examples

### Successful Report
```
🔕 Silent error report: session_id_mismatch { storedSessionId: 'session_123', ... }
✅ Silent report submitted: session_id_mismatch (report #1)
```

### Throttled (Already Reported)
```
🔕 Silent report skipped: session_id_mismatch (already reported this session)
```

### Failed Submission
```
⚠️ Silent report failed (status 500): session_id_mismatch
```

---

## Integration Examples

### Example 1: participant-response-manager.js
```javascript
// Session ID mismatch detected
if (responses.sessionId !== sessionState?.sessionId) {
    console.warn('⚠️ Session ID mismatch detected!');
    
    // 🔕 Silent report
    reportSessionIdMismatch(responses.sessionId, sessionState?.sessionId, {
        context: 'getSessionResponses',
        hasPre: !!responses.pre,
        participantId: participantId
    }).catch(e => console.warn('Silent report failed:', e));
}
```

### Example 2: session-management.js
```javascript
// Check for inconsistencies during timeout
const sessionState = getSessionState(participantId);

if (sessionState && responses.sessionId !== sessionState.sessionId) {
    reportSessionStateInconsistency(
        'timeout_submission_session_id_mismatch',
        sessionState,
        responses
    ).catch(e => console.warn('Silent report failed:', e));
}
```

---

## Testing

### Manual Testing
```javascript
// In browser console:
import { reportMetadataMismatch } from './js/silent-error-reporter.js';

// Test report
reportMetadataMismatch('test_error', {
    testField: 'test value',
    timestamp: new Date().toISOString()
});

// Check R2 bucket for report file
```

### Verify Report Saved
1. Open backend logs
2. Look for: `✅ Error report saved: hearts-data-cache/interface_overheating_reports/...`
3. Check R2 bucket for file

---

## Future Enhancements

### Potential Additions
1. **Survey response mismatches** - Track when survey data structure is unexpected
2. **Region/feature data corruption** - Detect invalid region data
3. **Tracking event inconsistencies** - Report missing or duplicate tracking events
4. **Performance anomalies** - Flag unusually slow operations
5. **Qualtrics submission failures** - Track failed API submissions with full context

### Analytics Dashboard
Could create dashboard showing:
- Most common error types
- Affected participants
- Temporal patterns (time of day, day of week)
- Correlation with specific modes or volcanoes

---

## Monitoring

### What to Watch For
1. **High frequency of same error type** - May indicate systemic issue
2. **Participant-specific errors** - May indicate client-side issue
3. **New error types** - May indicate recent code changes introduced bugs
4. **Parse errors** - May indicate localStorage corruption

### Response Actions
- **Single occurrence:** Note and monitor
- **Multiple from same user:** Consider reaching out or checking their data
- **Widespread pattern:** Investigate and fix root cause
- **After code changes:** Ensure no new error types introduced

---

## Benefits

✅ **Passive Monitoring** - Catch issues without user reports  
✅ **Rich Context** - Full console logs and system state  
✅ **Non-Intrusive** - User experience unaffected  
✅ **Actionable Data** - Participant ID + specific mismatch details  
✅ **Early Warning** - Detect emerging issues before they become critical  

---

## Related Documentation
- `js/error-reporter.js` - Main error reporter (shows UI for critical errors)
- `backend/collector_loop.py:report_error()` - Backend handler
- `SESSION_TRACKING_CHANGELOG.md` - Session tracking system details

