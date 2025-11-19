# Testing Session Timeout Locally

## How It Works

The timeout system ties the session to your **participant ID**:
- When session starts → Sets `CURRENT_SESSION_START` timestamp + `TIMEOUT_SESSION_ID` (your participant ID)
- On page refresh → Checks if stored participant ID matches current participant ID
- If mismatch → Ignores old timeout (not your session!)
- If match → Checks if 20+ minutes elapsed

## Testing Instructions

### To Test Timeout:

1. **Start a session normally** (complete pre-survey, click Begin Analysis)
2. **Open browser console**
3. **Set an old timestamp** (but keep the session ID matching):
   ```javascript
   // Set session start to 25 minutes ago
   const twentyFiveMinutesAgo = new Date(Date.now() - 25 * 60 * 1000);
   localStorage.setItem('study_current_session_start', twentyFiveMinutesAgo.toISOString());
   
   // Session ID should already match your participant ID (verify):
   console.log('Session ID:', localStorage.getItem('study_timeout_session_id'));
   console.log('Participant ID:', localStorage.getItem('participantId'));
   // Should be the same!
   ```

4. **Refresh the page** → You should see:
   ```
   ✅ Timeout session match: [your ID] - checking elapsed time
   ⏰ Session timeout detected: 25.0 minutes elapsed
   ```

### Why This Works:

- Uses the **real** timeout system (no test flags!)
- Your localStorage = your browser only
- Production users = their own localStorage
- No fake variables, one clean system!

### To Clear Timeout (Reset):

```javascript
// Start fresh session
localStorage.setItem('study_current_session_start', new Date().toISOString());
```

### To Test Session ID Mismatch:

```javascript
// Simulate someone else's old session
localStorage.setItem('study_timeout_session_id', 'different_user_123');
// Refresh → You should see:
// 🔒 Timeout session mismatch: stored="different_user_123", current="[your ID]" - ignoring old timeout
```

## How It Works in Production

1. User completes pre-survey → `startSession()` called
2. System sets:
   - `CURRENT_SESSION_START` = now
   - `TIMEOUT_SESSION_ID` = participant ID
3. User clicks "Begin Analysis" → Session active
4. Every page refresh checks:
   - Does `TIMEOUT_SESSION_ID` match current participant? 
   - If NO → Ignore timeout (someone else's session)
   - If YES → Check elapsed time
   - If > 20 minutes → Show timeout modal

### Console Output (Working Correctly):

```
🔐 Timeout session tied to participant: R_abc123
✅ Timeout session match: R_abc123 - checking elapsed time
⏰ Session timeout detected: 25.0 minutes elapsed
```

### Key Benefit:

**Multi-user safety!** If you test with participant "23123" and push code, production user "R_xyz789" won't trigger your old timeout. Each user's localStorage is isolated by browser + participant ID. 🎯

