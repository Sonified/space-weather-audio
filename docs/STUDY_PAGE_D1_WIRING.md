# Study Page → D1 Wiring Guide

## Architecture

```
┌─────────────────────┐     ┌──────────────────────┐     ┌─────────┐
│  study-builder.html  │────▶│  D1: studies table    │◀────│  Worker  │
│  (researcher)        │     │  (config JSON)        │     │  API     │
└─────────────────────┘     └──────────────────────┘     └────▲────┘
                                                               │
┌─────────────────────┐     ┌──────────────────────┐          │
│  emic-pilot.html     │────▶│  D1: responses table  │─────────┘
│  (participant)       │     │  D1: participants     │
│  imports d1-sync.js  │     └──────────────────────┘
└─────────────────────┘
```

**Study builder** writes config → D1 `studies` table.
**Study HTML page** reads config from D1 on load, sends participant data to D1 throughout.
Each study gets its own HTML file (e.g., `emic-pilot.html`).

---

## Study HTML Page — What Gets Wired

Every study HTML page imports `d1-sync.js` and calls its functions at specific interaction points. Here's the complete map:

### On Page Load
```js
import { initStudy } from './js/d1-sync.js';

// Reads study config from D1, returns it to drive the UI
const config = await initStudy('emic-pilot');
// config.steps[] drives which modals, surveys, analysis blocks to show
```

### Step: Registration
```js
import { initParticipant } from './js/d1-sync.js';

// When participant registers (auto or manual ID)
const participantId = generateOrReadId(); // P001, P002, etc.
localStorage.setItem('participantId', participantId);
initParticipant(participantId, 'emic-pilot');
// → INSERT into participants table
```

### Step: Survey Question Answered
```js
import { saveSurveyAnswer } from './js/d1-sync.js';

// Each question, as they answer it (not on form submit)
questionInput.addEventListener('change', (e) => {
    saveSurveyAnswer('q1', e.target.value, 'pre');
    // → INSERT into responses (type: 'pre_survey')
});
```

### Step: Analysis — Feature Drawn/Saved
```js
import { saveFeature } from './js/d1-sync.js';

// When feature editor modal is closed/saved
featureEditor.onSave = (featureData) => {
    saveFeature(featureData);
    // → INSERT into responses (type: 'feature')
    // featureData: { startTime, endTime, lowFreq, highFreq, type, notes, speedFactor }
};
```

### Step: Analysis — Feature Updated/Resized
```js
import { saveResponse } from './js/d1-sync.js';

// When user releases after dragging a feature edge
featureEditor.onResize = (featureData) => {
    saveResponse('feature_update', {
        featureId: featureData.id,
        startTime: featureData.startTime,
        endTime: featureData.endTime,
        lowFreq: featureData.lowFreq,
        highFreq: featureData.highFreq,
    });
    // → INSERT into responses (type: 'feature_update')
};
```

### Step: Analysis — Playback Event
```js
import { saveResponse } from './js/d1-sync.js';

// When user plays/pauses/seeks (throttled — not every frame)
saveResponse('playback_event', {
    action: 'play', // or 'pause', 'seek'
    position: currentTime,
    speed: playbackSpeed,
});
```

### Step: Post-Survey
```js
import { saveSurveyAnswer } from './js/d1-sync.js';

// Same pattern as pre-survey, just different type
postQuestionInput.addEventListener('change', (e) => {
    saveSurveyAnswer('post_q1', e.target.value, 'post');
    // → INSERT into responses (type: 'post_survey')
});
```

### Step: Study Complete
```js
import { markComplete } from './js/d1-sync.js';

// When participant finishes the last step
markComplete();
// → INSERT into responses (type: 'milestone', data: { event: 'completed' })
```

---

## d1-sync.js — Functions Needing Addition

The current `d1-sync.js` needs one new function to support config loading:

```js
/**
 * Fetch study config from D1. Called on page load.
 * @param {string} studyId - study slug
 * @returns {Promise<object|null>} - parsed study config
 */
export async function initStudy(studyId) {
    const url = `${getApiBase()}/api/study/${studyId}/config`;
    try {
        const resp = await fetch(url);
        if (resp.ok) {
            const data = await resp.json();
            // Store study ID for subsequent calls
            _activeStudyId = studyId;
            log('✅', `loaded study config: ${studyId}`);
            return JSON.parse(data.config);
        }
        log('❌', `study not found: ${studyId}`);
        return null;
    } catch (e) {
        log('❌', `failed to load study: ${e.message}`);
        return null;
    }
}
```

---

## Study HTML Template

Each generated study HTML page follows this skeleton:

```html
<!DOCTYPE html>
<html>
<head>
    <title>EMIC Pilot Study — spaceweather.now.audio</title>
    <meta name="study-id" content="emic-pilot">
    <!-- Same CSS/assets as main app -->
</head>
<body>
    <!-- The page is a shell — d1-sync loads the config, config drives the steps -->
    <script type="module">
        import { initStudy, initParticipant, saveSurveyAnswer, saveFeature, saveResponse, markComplete } from './js/d1-sync.js';

        const STUDY_ID = document.querySelector('meta[name="study-id"]').content;

        // 1. Load config from D1
        const config = await initStudy(STUDY_ID);
        if (!config) {
            document.body.innerHTML = '<h1>Study not found</h1>';
            throw new Error('Study config not found in D1');
        }

        // 2. Build the step sequence from config
        const steps = config.steps; // [{type:'registration',...}, {type:'modal',...}, ...]
        let currentStep = 0;

        function advanceStep() {
            currentStep++;
            if (currentStep >= steps.length) {
                markComplete();
                return;
            }
            renderStep(steps[currentStep]);
        }

        // 3. Render step based on type
        function renderStep(step) {
            switch (step.type) {
                case 'registration':
                    showRegistration(step);
                    break;
                case 'modal':
                    if (step.contentType === 'questions') {
                        showSurvey(step);
                    } else {
                        showInfoModal(step);
                    }
                    break;
                case 'analysis':
                    showAnalysis(step);
                    break;
            }
        }

        // 4. Each renderer wires D1 saves at the right moments
        function showRegistration(step) {
            // ... render registration UI ...
            onRegister = (participantId) => {
                localStorage.setItem('participantId', participantId);
                initParticipant(participantId, STUDY_ID);
                advanceStep();
            };
        }

        function showSurvey(step) {
            const surveyType = currentStep < steps.findIndex(s => s.type === 'analysis') ? 'pre' : 'post';
            step.questions.forEach(q => {
                // ... render question UI ...
                onAnswer = (answer) => {
                    saveSurveyAnswer(q.id, answer, surveyType);
                };
            });
            onSurveyComplete = () => advanceStep();
        }

        function showInfoModal(step) {
            // ... render info modal with step.title, step.bodyText ...
            onDismiss = () => advanceStep();
        }

        function showAnalysis(step) {
            // ... load the spaceweather audio player with step config ...
            // Wire feature saves:
            onFeatureSaved = (feat) => saveFeature(feat);
            onFeatureUpdated = (feat) => saveResponse('feature_update', feat);
            onAnalysisComplete = () => advanceStep();
        }

        // 5. Start
        renderStep(steps[0]);
    </script>
</body>
</html>
```

---

## Data Flow Summary

| Participant Action | d1-sync function | D1 Table | Type |
|---|---|---|---|
| Opens page | `initStudy()` | studies (READ) | — |
| Registers | `initParticipant()` | participants (INSERT) | — |
| Answers pre-survey Q | `saveSurveyAnswer()` | responses (INSERT) | `pre_survey` |
| Draws feature | `saveFeature()` | responses (INSERT) | `feature` |
| Resizes feature | `saveResponse()` | responses (INSERT) | `feature_update` |
| Plays/pauses audio | `saveResponse()` | responses (INSERT) | `playback_event` |
| Answers post-survey Q | `saveSurveyAnswer()` | responses (INSERT) | `post_survey` |
| Finishes study | `markComplete()` | responses (INSERT) | `milestone` |

Every write is an INSERT — append-only, no overwrites, no races. Full audit trail of everything the participant did.

---

## Manual Steps After D1 Is Live

1. Add `initStudy()` to `d1-sync.js`
2. Make `STUDY_ID` dynamic (not hardcoded) — read from `<meta>` tag or URL param
3. Wire each integration point into the existing EMIC study flow code
4. Generate study HTML pages from the builder (or start with one hand-crafted `emic-pilot.html`)
