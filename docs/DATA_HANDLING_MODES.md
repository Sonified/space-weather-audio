# Study Data Handling Modes

## Three Modes

| Mode | URL Param | Saves to D1? | Participant ID | Banner |
|------|-----------|-------------|----------------|--------|
| **Preview** | `?preview=true` | No | `Preview_XXXXXX` | 🔍 Preview Mode |
| **Test** | `?test=true` | Yes | `TEST_XXXXX` | 🧪 Test Mode |
| **Live** | (none) | Yes | User-entered or auto-generated | (none) |

## What Gets Saved (Live & Test)

| Event | D1 Response Type | When |
|-------|-----------------|------|
| Registration | `initParticipant()` → `participants` table | User enters ID |
| Feature drawn | `'feature'` | User clicks Complete |
| Pre-analysis question | `'pre_survey'` | Each answer submitted |
| Post-analysis question | `'post_survey'` | Each answer submitted |
| Study finished | `'milestone'` | All steps done |

## Preview Mode Behavior

- `window.__PREVIEW_MODE = true`
- `saveResponse()` returns early — nothing hits D1
- Progress not persisted to localStorage
- Participant ID cleared on load (won't collide with real data)

## Test Mode Behavior

- `window.__TEST_MODE = true`
- Data IS saved to D1 (full pipeline verification)
- `TEST_` prefix on participant ID allows filtering in analysis
- Progress persists normally

## D1 Tables

- **`studies`** — study configs (id, name, config JSON)
- **`participants`** — registered participants (id, study_id)
- **`responses`** — all response data (id, participant_id, study_id, day, type, data JSON)
  - Foreign keys: `participant_id → participants(id)`, `study_id → studies(id)`

## Known Issue

`initParticipant()` is NOT guarded by preview mode — preview participants still get registered in D1 even though their responses are blocked.
