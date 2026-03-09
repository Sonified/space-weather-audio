# Study Page → D1 Wiring Guide

## Architecture

```
┌──────────────────┐     PUT /api/study/:slug/config     ┌──────────────┐
│  Study Builder    │ ──────────────────────────────────→ │              │
│  (researcher)     │                                     │  Cloudflare  │
└──────────────────┘                                      │  Worker      │
                                                          │  + D1        │
┌──────────────────┐     GET /api/study/:slug/config      │              │
│  emic-pilot.html  │ ←────────────────────────────────── │              │
│  (participant)    │                                     │              │
│                   │     POST /api/study/:slug/responses  │              │
│                   │ ──────────────────────────────────→ │              │
│                   │     POST /api/study/:slug/participants              │
│                   │ ──────────────────────────────────→ │              │
└──────────────────┘                                      └──────────────┘
```

Each study gets its own HTML file (e.g., `emic-pilot.html`). The study builder generates it.
The HTML file loads config from D1, runs the study, and saves every participant action back to D1.

## Data Flow — Every Touchpoint

### 1. Page Load
```js
import { initStudy } from './js/d1-sync.js';

// Fetch study config from D1
const config = await fetch('/api/study/emic-pilot/config').then(r => r.json());
// config.steps[] drives the entire UI flow
```

### 2. Registration (Step 1)
```js
import { initParticipant } from './js/d1-sync.js';

// Participant enters/gets ID → register in D1
const participantId = generateOrInputId(config.steps[0]);
localStorage.setItem('participantId', participantId);
initParticipant(participantId, 'emic-pilot');
// → POST /api/study/emic-pilot/participants { id: "P042" }
```

### 3. Survey Questions (Pre or Post)
```js
import { saveSurveyAnswer } from './js/d1-sync.js';

// On EACH answer (not waiting for "submit all")
questionInput.addEventListener('change', (e) => {
    saveSurveyAnswer('q1', e.target.value, 'pre');
    // → POST /api/study/emic-pilot/responses
    //   { type: "pre_survey", data: { questionId: "q1", answer: "agree" } }
});
```

### 4. Feature Drawing (Analysis Step)
```js
import { saveFeature } from './js/d1-sync.js';

// When participant CLOSES the feature editor modal (not during drag)
featureEditor.onClose = (featureData) => {
    saveFeature(featureData);
    // → POST /api/study/emic-pilot/responses
    //   { type: "feature", data: { startTime, endTime, lowFreq, highFreq, type, notes } }
};
```

### 5. Feature Update (Resize/Edit)
```js
import { saveResponse } from './js/d1-sync.js';

// When participant finishes resizing (mouseup on edge)
featureBox.onResizeEnd = (updatedFeature) => {
    saveResponse('feature_update', {
        featureId: updatedFeature.id,
        ...updatedFeature.coords,
    });
};
```

### 6. Playback Events
```js
import { saveResponse } from './js/d1-sync.js';

// Log when they actually listen
audioPlayer.onPlay = () => {
    saveResponse('playback_event', {
        event: 'play',
        position: audioPlayer.currentTime,
        speed: audioPlayer.playbackRate,
    });
};
```

### 7. Study Completion
```js
import { markComplete } from './js/d1-sync.js';

// Final step — mark done
markComplete();
// → POST /api/study/emic-pilot/responses
//   { type: "milestone", data: { event: "completed", completedAt: "..." } }
```

## Integration Points in Existing Code

These are the files that need hooks added to wire into D1:

| File | What to Hook | D1 Call |
|------|-------------|---------|
| `js/mode-initializers.js` | Study mode init, page load | Fetch config from D1, `initParticipant()` |
| `js/modal-templates.js` | Survey question change events | `saveSurveyAnswer()` |
| `js/feature-tracker.js` | Feature save/close, resize end | `saveFeature()`, `saveResponse('feature_update')` |
| `js/audio-player.js` | Play/pause/seek events | `saveResponse('playback_event')` |
| `js/ui-modals.js` or `js/ui-controls.js` | "Complete" button, step transitions | `markComplete()`, `saveResponse('milestone')` |

## What d1-sync.js Already Handles

- **Fire-and-forget** — callers don't await, UI never blocks
- **Offline queue** — failed saves queue in localStorage, flush on next success
- **Auto participant ID** — reads from localStorage, callers don't pass it
- **UUID generation** — each response gets `crypto.randomUUID()`
- **Console logging** — emoji-prefixed logs for debugging

## Study HTML Template

Each generated study page will:
1. Import `d1-sync.js` as an ES module
2. Fetch its config from D1 on load (`/api/study/{slug}/config`)
3. Walk through `config.steps[]` sequentially
4. Fire D1 saves at each touchpoint above
5. Use the existing spaceweather.now.audio components (spectrogram, audio player, feature tracker) for analysis steps

The study builder writes the HTML file with the slug hardcoded and the D1 imports wired in.
The config (questions, analysis params, step order) all comes from D1 at runtime — so the researcher can update without regenerating the HTML.

## What's Ready vs What Needs Wiring

| Layer | Status |
|-------|--------|
| D1 schema (3 tables) | ✅ Ready |
| Worker routes (7 endpoints) | ✅ Ready |
| `d1-sync.js` (progressive saves) | ✅ Ready |
| Test harness | ✅ Ready |
| `wrangler.toml` D1 binding | ⚠️ Needs real database ID |
| Hooks in feature-tracker.js | 🔲 Not yet |
| Hooks in modal-templates.js | 🔲 Not yet |
| Hooks in audio-player.js | 🔲 Not yet |
| Hooks in mode-initializers.js | 🔲 Not yet |
| Study page template generator | 🔲 Not yet |
