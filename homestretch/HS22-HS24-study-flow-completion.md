# HS22 & HS24 — Study Flow & Completion Logic Investigation

## HS22: Analysis Completion Flag Carries Over Between Sections

### Bug Mechanism

**Root cause:** In `js/data-fetcher.js` line 706, `updateCompleteButtonState()` is called during data processing — **before** `loadRegionsAfterDataFetch()` clears the old features at line 747. At line 706, `standaloneFeatures` still contains section 1's features, so `hasIdentifiedFeature()` returns `true`, and the Complete button gets the `.ready` class (enabled) immediately.

**Sequence when entering section 2:**

1. `runAnalysis()` calls `initCompleteButton(step)` → removes `.ready` class (`js/study-flow.js:43`)
2. Data fetch is triggered (async) via `triggerDataRender()` or `startBtn.click()` (`js/study-flow.js:2047-2057`)
3. Data processing runs in `js/data-fetcher.js` — line 706 calls `updateCompleteButtonState()`
4. This dispatches `featurechange` event with `hasFeature: hasIdentifiedFeature()` (`js/feature-tracker.js:802-803`)
5. `hasIdentifiedFeature()` checks the in-memory `standaloneFeatures` array (`js/feature-tracker.js:784-790`), which **still has section 1's features**
6. `updateCompleteButton()` in `js/study-flow.js:50-74` sees `hasFeature: true` and enables the button
7. Later, `loadRegionsAfterDataFetch()` at `js/data-fetcher.js:747` calls `loadStandaloneFeatures()` which clears the array (different storage key for section 2's dates), but by then the button is already enabled

**Why the storage key differs:** `getCurrentStorageKey()` (`js/feature-tracker.js:69-75`) is based on spacecraft + data type + start/end time. The two analysis sections use different date ranges (e.g., `2022-08-17` vs `2022-01-14` in `studies/emic-pilot.json`).

### Key File Locations

| What | File | Line(s) |
|------|------|---------|
| Complete button controller | `js/study-flow.js` | 35-85 |
| `initCompleteButton` (removes `.ready`) | `js/study-flow.js` | 38-46 |
| `updateCompleteButton` (re-enables on `hasFeature`) | `js/study-flow.js` | 50-74 |
| `featurechange` listener | `js/study-flow.js` | 85 |
| `runAnalysis` entry point | `js/study-flow.js` | 1971-2130 |
| `hasIdentifiedFeature` | `js/feature-tracker.js` | 784-790 |
| `notifyFeatureChange` / event dispatch | `js/feature-tracker.js` | 800-810 |
| `standaloneFeatures` array (in-memory) | `js/feature-tracker.js` | 23 |
| `loadStandaloneFeatures` (clears array) | `js/feature-tracker.js` | 140-158 |
| `loadRegionsAfterDataFetch` (calls load + notify) | `js/feature-tracker.js` | 270-292 |
| Premature `updateCompleteButtonState()` call | `js/data-fetcher.js` | 706 |
| Later `loadRegionsAfterDataFetch()` call | `js/data-fetcher.js` | 747 |
| Also in GOES fetcher | `js/goes-cloudflare-fetcher.js` | 585, 1083 |

### Proposed Fix

**Option A (simplest, recommended):** Clear `standaloneFeatures` at the start of `runAnalysis()`.

In `js/study-flow.js`, inside `runAnalysis(step)` (around line 1983, after setting `window.__currentAnalysisSession`), add:

```js
// Clear in-memory features from previous analysis session so the Complete
// button doesn't immediately re-enable from stale data
import('./feature-tracker.js').then(({ getStandaloneFeatures }) => {
    // Feature-tracker doesn't export a clear function, so we need one
});
```

Actually, the cleanest approach: **export a `clearStandaloneFeatures()` function from `feature-tracker.js`** and call it at the start of `runAnalysis`.

**In `js/feature-tracker.js`**, add a new export (after `getStandaloneFeatures` at ~line 120):

```js
/**
 * Clear all in-memory standalone features (used when transitioning between analysis sections)
 */
export function clearStandaloneFeatures() {
    standaloneFeatures = [];
    _lastFeatureCount = 0;
    notifyFeatureChange();
}
```

**In `js/study-flow.js`**, add import and call:

1. Update import at line 14:
```js
import { getStandaloneFeatures, clearStandaloneFeatures } from './feature-tracker.js';
```

2. In `runAnalysis()`, after `window.__currentAnalysisSession = analysisSession;` (line 1981), add:
```js
// Reset features from previous analysis session
clearStandaloneFeatures();
```

**Option B (alternative):** Remove the premature `updateCompleteButtonState()` call at `js/data-fetcher.js:706` since `loadRegionsAfterDataFetch()` at line 747 already calls it. This is riskier as it might break the portal (non-study) use case where features should re-enable after data reload.

**Recommendation:** Option A — explicit, safe, no side effects on other flows.

**Complexity:** ~15 minutes. 3 lines of new code + 1 import change.

---

## HS24: Free Response "Submit on Return" and "Can Close" Toggles

### Existing Toggle Pattern

**Study builder toggle HTML** (`study-builder.html:3318-3330`):

```html
<div class="settings-section-label">Behavior</div>
<div class="settings-rows">
  <div class="settings-row">
    <span class="toggle-label">Required</span>
    <div class="toggle toggle-required ${step.required !== false ? 'on' : ''}" onclick="this.classList.toggle('on')"></div>
    <span class="toggle-label">Enable back button</span>
    <div class="toggle toggle-can-go-back ${step.canGoBack !== false ? 'on' : ''}" onclick="this.classList.toggle('on')"></div>
    <span class="toggle-label">Show Question ID</span>
    <div class="toggle toggle-question-id ${step.id ? 'on' : ''}" onclick="..."></div>
    ...
  </div>
</div>
```

**Pattern:** `<span class="toggle-label">Label</span>` + `<div class="toggle toggle-{css-class} ${condition ? 'on' : ''}" onclick="this.classList.toggle('on')"></div>`

**Reading toggle state** (`study-builder.html:4374-4377`):
```js
const reqToggle = card.querySelector('.toggle-required');
step.required = reqToggle?.classList.contains('on') || false;
const goBackToggle = card.querySelector('.toggle-can-go-back');
step.canGoBack = goBackToggle?.classList.contains('on') ?? true;
```

### Key File Locations

| What | File | Line(s) |
|------|------|---------|
| Toggle HTML template | `study-builder.html` | 3318-3330 |
| Toggle state collection | `study-builder.html` | 4374-4377 |
| Question type detection (freetext) | `study-builder.html` | 4339 |
| `renderFreetextInput` | `js/survey-question-renderer.js` | 69-75 |
| `renderQuestionModal` (routes to freetext) | `js/survey-question-renderer.js` | 205-210 |
| Question modal event wiring (textarea input handler) | `js/study-flow.js` | 2338-2343 |
| Next button click handler | `js/study-flow.js` | 2345-2365 |
| `closable` property on info modals | `js/survey-question-renderer.js` | 134 |

### Proposed Implementation

#### A. "Submit on Return" Toggle

**1. Add toggle to study builder** (`study-builder.html`, after the existing toggles in the settings-row, ~line 3330):

Add a freetext-specific settings block (similar to the `likert-settings-block` at line 3331):

```html
<div class="freetext-settings-block" style="display:${isFreetext ? '' : 'none'};">
  <div class="settings-divider" style="margin-top:12px;"></div>
  <div class="settings-rows">
    <div class="settings-row">
      <span class="toggle-label">Submit on Return</span>
      <div class="toggle toggle-submit-on-return ${step.submitOnReturn !== false ? 'on' : ''}" onclick="this.classList.toggle('on')"></div>
      <span class="toggle-label">Can close</span>
      <div class="toggle toggle-can-close ${step.canClose !== false ? 'on' : ''}" onclick="this.classList.toggle('on')"></div>
    </div>
  </div>
</div>
```

Need to add `isFreetext` variable near `isLikert` (~line 3213):
```js
const isFreetext = qType === 'freetext';
```

**2. Read toggle state** (`study-builder.html`, in the collection logic after line 4377):

```js
if (step.questionType === 'freetext') {
    step.submitOnReturn = card.querySelector('.toggle-submit-on-return')?.classList.contains('on') ?? true;
    step.canClose = card.querySelector('.toggle-can-close')?.classList.contains('on') ?? true;
}
```

**3. Show/hide freetext settings on pill change** — follow the pattern of `.likert-settings-block` toggle. Find where `likert-settings-block` display is toggled on pill click and add the same for `.freetext-settings-block`.

**4. Wire Enter key in study-flow.js** (`js/study-flow.js`, in `showQuestionModal`, after the textarea input handler ~line 2343):

```js
if (qType === 'freetext' && question.submitOnReturn !== false) {
    const textarea = studyModalInner.querySelector('textarea');
    if (textarea) {
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!nextBtn.disabled) nextBtn.click();
            }
        });
    }
}
```

**5. Pass `submitOnReturn` through to the question object** (`js/study-flow.js`, in `runQuestionnaire` flat-question wrapping, ~line 2196):

Add to the question object:
```js
submitOnReturn: step.submitOnReturn,
canClose: step.canClose,
```

**6. "Can close" toggle** — add `closable` property to question modals. In `renderQuestionModal` (`js/survey-question-renderer.js:237`), add a close button if `question.canClose !== false` (for freetext type):

Actually, looking at the existing `closable` on info modals (line 134), this is about a ✕ button on the modal. For question modals, the close button would need a dismiss handler. Wire it in `showQuestionModal` similar to how `backBtn` works — resolve with a special value or treat as skip.

### Complexity & Implementation Order

| Task | Effort | Dependencies |
|------|--------|-------------|
| HS22 (reset completion flag) | ~15 min | None |
| HS24 toggles in builder | ~30 min | None |
| HS24 Submit on Return logic | ~20 min | Toggles |
| HS24 Can Close logic | ~30 min | Toggles |

**Suggested order:**
1. **HS22 first** — smallest, most impactful bug fix
2. **HS24 builder toggles** — UI groundwork
3. **HS24 Submit on Return** — straightforward keydown handler
4. **HS24 Can Close** — needs close button + dismiss handler wiring
