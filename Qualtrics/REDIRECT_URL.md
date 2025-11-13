# Qualtrics Redirect URL Configuration

## Site URL
**Production Site:** `https://volcano.now.audio/`

## Qualtrics Redirect URL Setup

When configuring the redirect in Qualtrics Survey Flow, use this URL:

```
https://volcano.now.audio/?ResponseID=${e://Field/ResponseID}
```

## How It Works

1. **User completes survey in Qualtrics**
   - Qualtrics generates a unique ResponseID (e.g., `R_5xRUHrX8m8iB6m5`)

2. **Qualtrics redirects user**
   - URL becomes: `https://volcano.now.audio/?ResponseID=R_5xRUHrX8m8iB6m5`
   - The `${e://Field/ResponseID}` is automatically replaced by Qualtrics with the actual ResponseID

3. **Site automatically captures ResponseID**
   - On page load, the site detects the `ResponseID` parameter
   - Stores it in localStorage for persistence
   - Includes it in all survey submissions as embedded data

## Qualtrics Setup Steps

1. Go to **Survey Flow** in your Qualtrics survey
2. Add an **End of Survey** element (or modify existing)
3. Enable **Override Survey Options**
4. Set **Redirect to a URL** to:
   ```
   https://volcano.now.audio/?ResponseID=${e://Field/ResponseID}
   ```
5. Save the survey flow

## Testing

To test the redirect locally, you can manually visit:
```
https://volcano.now.audio/?ResponseID=TEST_RESPONSE_ID_12345
```

The console should log:
```
🔗 ResponseID detected from Qualtrics redirect: TEST_RESPONSE_ID_12345
💾 Stored ResponseID for use in survey submissions
```

## Supported Parameter Names

The code supports multiple parameter names (in order of priority):
- `ResponseID` (Qualtrics standard - **recommended**)
- `responseId` (case variation)
- `ParticipantID` (alternative)
- `participantId` (case variation)
- `participant_id` (snake_case)
- `id` (generic)
- `pid` (short form)

