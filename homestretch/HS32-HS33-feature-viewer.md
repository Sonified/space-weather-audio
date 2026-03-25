# HS32 & HS33 — Feature Viewer Investigation

## Architecture Overview

### File Structure
- **`feature-viewer.html`** — Monolithic HTML page, similar to study.html but stripped down for review
- **`js/feature-viewer.js`** — Lightweight controller (~200 lines): loads study config, applies analysis step settings, triggers data fetch, handles session switching
- **`js/main.js`** — Still loaded (application layer) but feature-viewer.js overrides the flow

### URL Parameters
```
feature-viewer.html?s=<study-slug>&pid=<participant-id>&session=<1|2>
```
- `s` / `study` — study slug (e.g., `emic-pilot`)
- `pid` — participant ID (e.g., `P_20260315_1422_ABCDE`)
- `session` — initial analysis session number (default: 1)

### Initialization Flow (`feature-viewer.js → init()`)
1. Parse URL params → set `window.__REVIEW_MODE`, `__REVIEW_PID`, `__REVIEW_SESSION`
2. `setStudyId(slug)` — configure d1-sync module
3. `fetchStudyConfig(slug)` — fetch study config from D1 (`/api/study/:id/config`)
4. Set page title, show participant ID
5. Apply `studyConfig.appSettings` to DOM elements (if settings drawer exists)
6. **Force `dataRendering` to `progressive`** (override appSettings which may set `triggered`)
7. `applyAnalysisConfig(step)` — set `window.__STUDY_CONFIG` with spacecraft/dataset/times
8. `await startStreaming(null, window.__STUDY_CONFIG)` — fetch data from CDAWeb, render spectrogram
9. Register `review-session-change` event listener

### Session Switching Flow
The session buttons (1/2) in the `#sessionGroup` are wired via inline `<script>`:
```
Button click → update __REVIEW_SESSION → dispatch CustomEvent('review-session-change')
```

The handler in `feature-viewer.js`:
```js
window.addEventListener('review-session-change', async (e) => {
    const newSession = e.detail.session;
    window.__REVIEW_SESSION = newSession;
    const step = findAnalysisStep(studyConfig.steps, newSession);
    applyAnalysisConfig(step);        // Updates window.__STUDY_CONFIG
    await startStreaming(null, window.__STUDY_CONFIG);  // Re-fetches data
});
```

### Feature Loading
Features load automatically after data fetch completes:
- `data-fetcher.js` → `fetchAndLoadCDAWebData()` → at end calls `loadRegionsAfterDataFetch()`
- In review mode, `loadRegionsAfterDataFetch()` calls `loadReviewFeatures()` which:
  - Fetches all features via `fetchFeatures(pid)` → `GET /api/study/:id/participants/:pid/features`
  - Filters by `analysis_session == __REVIEW_SESSION`
  - Maps D1 format → internal format and stores in `standaloneFeatures`

### API Endpoints Used
| Endpoint | Purpose |
|---|---|
| `GET /api/study/:slug/config` | Fetch study config (via `fetchStudyConfig` in d1-sync.js) |
| `GET /api/study/:slug/participants/:pid/features` | Fetch participant's features |
| `GET /api/study/:slug/participants` | List all participants with feature counts (**for HS33**) |
| CDAWeb API (via data-fetcher.js) | Fetch magnetometer data |

---

## HS32: Session Switching Bug

### Symptoms
- Going 1 → 2 works fine
- Going 2 → 1 shows "loading" and hangs (spectrogram never renders)

### Root Cause Analysis

The `review-session-change` handler calls `startStreaming()` which does a full data fetch + render cycle. The `startStreaming()` function in `streaming.js` performs cleanup (lines 50-100):

```js
clearCompleteSpectrogram();  // Disposes Three.js scene, resets flags
clearWaveformRenderer();
clearAllCanvasFeatureBoxes();
// Close AudioContext
if (State.audioContext) { State.audioContext.close(); State.setAudioContext(null); }
// Reset zoom state
// ...
await initAudioWorklet();    // Creates new AudioContext + worklet
```

**Identified issues (in order of likelihood):**

#### Issue 1: Missing `dataSource` element → wrong data source
The `feature-viewer.html` does NOT include a `#dataSource` select element. In `streaming.js` line 153-154:
```js
const dataSourceEl = document.getElementById('dataSource');
const dataSource = dataSourceEl ? dataSourceEl.value : 'cdaweb';
```
This defaults to `'cdaweb'` for ALL sessions, even though the study config specifies `"dataSource": "cloudflare_r2"`. The first load works because CDAWeb still serves the data, but **this means all data fetches go through CDAWeb instead of the intended Cloudflare R2 path**. While not directly the bug, this may cause slower loads and potential CDAWeb API failures.

#### Issue 2: No error handling on session switch
The `review-session-change` handler has NO try-catch:
```js
window.addEventListener('review-session-change', async (e) => {
    // ...
    await startStreaming(null, window.__STUDY_CONFIG);  // If this throws → unhandled rejection
});
```
If `startStreaming` throws (e.g., CDAWeb API error, AudioContext issue), the status bar stays at "Fetching GOES..." with the loading animation, and the error is silently swallowed.

#### Issue 3: `dataRendering` not re-forced to `progressive`
In `init()`, `dataRendering` is explicitly set to `'progressive'` BEFORE the first `startStreaming`. But in the `review-session-change` handler, this is NOT done. If anything resets `dataRendering` to `'triggered'` (e.g., the `advanced-controls.js` restoring from localStorage after `appSettings` set it), the CDAWeb fetch path wouldn't be affected (it doesn't check `dataRendering`). **This is probably NOT the bug for CDAWeb path but would be for Cloudflare R2 path.**

#### Issue 4: Race condition with concurrent `startStreaming` calls  
There's no guard preventing a second `startStreaming` from running while the first is still in progress. If the user clicks buttons rapidly, two fetches could compete. However, `clearCompleteSpectrogram()` properly resets `renderingInProgress`.

#### Issue 5: AudioContext user gesture requirement
The session button click dispatches a `CustomEvent`. While this originates from a click, the async chain (`applyAnalysisConfig` → `startStreaming` → `initAudioWorklet`) may lose the user gesture context. If `new AudioContext()` is created in a context where the browser doesn't recognize a user gesture, the context is created in `suspended` state. **This wouldn't cause a hang** in data loading but would prevent audio playback.

### Most Likely Bug Mechanism

After investigation, the most probable cause is **a silent error during the second `startStreaming` call** that goes unhandled. The error could come from:

1. **CDAWeb API returning an error** for the same time range on the second fetch (unlikely if cached)
2. **WebGPU device loss** when Three.js renderer is reused after scene disposal — the renderer persists across `clearCompleteSpectrogram()` calls but the scene/camera/material are recreated. If the GPU device was lost (common in WebGPU), `initThreeScene()` would fail silently.
3. **IndexedDB cache returning corrupt/stale data** on the second fetch of session 1's time range

### Proposed Fix

**File: `js/feature-viewer.js`**, session change handler (line ~170):

```js
window.addEventListener('review-session-change', async (e) => {
    const newSession = e.detail.session;
    window.__REVIEW_SESSION = newSession;
    const step = findAnalysisStep(studyConfig.steps, newSession);
    if (!step) {
        console.warn(`🔎 [Review] No analysis step for session ${newSession}`);
        return;
    }
    applyAnalysisConfig(step);
    
    // ADD: Re-force progressive rendering (same as init)
    const renderSelect = document.getElementById('dataRendering');
    if (renderSelect) {
        renderSelect.value = 'progressive';
        renderSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    
    // ADD: Error handling
    try {
        console.log(`🔎 [Review] Switching to session ${newSession}`);
        await startStreaming(null, window.__STUDY_CONFIG);
    } catch (err) {
        console.error(`🔎 [Review] Failed to load session ${newSession}:`, err);
        const statusDiv = document.getElementById('status');
        if (statusDiv) {
            statusDiv.textContent = `Error loading session ${newSession}: ${err.message}`;
            statusDiv.className = 'status error';
        }
    }
});
```

**Additionally**, add a `#dataSource` hidden element to `feature-viewer.html` to ensure correct data source:

```html
<!-- Add inside the hidden selection panel -->
<select id="dataSource" style="display:none;">
    <option value="cloudflare">Cloudflare</option>
    <option value="cdaweb">CDAWeb</option>
</select>
```

This lets `applyAnalysisConfig` properly set the data source from the study config.

### Debugging Strategy
Add `console.log` checkpoints in the session switch handler to identify exactly where it hangs:
1. Before `applyAnalysisConfig` ✓
2. After `applyAnalysisConfig`, before `startStreaming` 
3. Inside `startStreaming` — after cleanup, before `initAudioWorklet`
4. After `initAudioWorklet`, before data fetch
5. After data fetch, before spectrogram render
6. After spectrogram render

---

## HS33: Participant Dropdown

### API Available
`GET /api/study/:studyId/participants` returns:
```json
{
  "success": true,
  "participants": [
    {
      "participant_id": "P_20260315_1422_ABCDE",
      "current_step": 8,
      "registered_at": "2026-03-15T22:22:00Z",
      "completed_at": "2026-03-15T23:45:00Z",
      "feature_count": 12,
      "is_active": 0,
      "updated_at": "...",
      "responses": "...",
      "flags": "...",
      "group_id": "...",
      "assigned_condition": "...",
      "assignment_mode": "...",
      "assigned_block": "...",
      "assigned_at": "..."
    }
  ]
}
```
Supports `?filter=all|test|live` and `?timeout=10` (active threshold in minutes).

### Proposed UI Design

**Placement:** Upper right of the header bar, between the study title and participant ID display. Add a `<select>` dropdown:

```html
<select id="participantSelector" style="font-size: 13px; padding: 4px 8px;">
    <option value="">Loading participants...</option>
</select>
```

**Location in `feature-viewer.html`:** Inside the `top-header-bar` div, in the right-side flex container (line ~87), before `#participantIdDisplay`:

```html
<div style="flex: 1; display: flex; justify-content: flex-end; align-items: flex-end; gap: 8px;">
    <!-- NEW: Participant selector -->
    <select id="participantSelector" style="..."></select>
    
    <div id="participantIdDisplay" style="margin-bottom: 0;">
        ...
    </div>
</div>
```

### Implementation Plan (`js/feature-viewer.js`)

1. **After study config loads**, fetch participant list:
```js
const resp = await fetch(`/api/study/${slug}/participants?filter=live`);
const data = await resp.json();
const participants = data.participants || [];
```

2. **Populate dropdown**, sorted by `registered_at`:
```js
const selector = document.getElementById('participantSelector');
participants.sort((a, b) => a.registered_at.localeCompare(b.registered_at));
selector.innerHTML = participants.map((p, i) => {
    const shortId = p.participant_id.split('_').pop();
    const featureInfo = p.feature_count > 0 ? ` (${p.feature_count} features)` : '';
    return `<option value="${p.participant_id}" ${p.participant_id === pid ? 'selected' : ''}>
        ${i + 1}. ${shortId}${featureInfo}
    </option>`;
}).join('');
```

3. **Handle selection change:**
```js
selector.addEventListener('change', () => {
    const newPid = selector.value;
    if (!newPid || newPid === window.__REVIEW_PID) return;
    // Update URL and reload (simplest approach — avoids complex state reset)
    const url = new URL(window.location);
    url.searchParams.set('pid', newPid);
    url.searchParams.set('session', '1'); // Reset to session 1
    window.location.href = url.toString();
});
```

**Alternative (no page reload):** Update `window.__REVIEW_PID` and re-trigger the full init sequence. This is more complex because all state (features, audio data if different session configs) needs resetting. The page reload approach is simpler and more reliable.

### Filter Options
Consider adding a filter toggle (test vs live participants):
- Default: show only live participants (`?filter=live`)
- Admin/localhost: show all or add a toggle

---

## Complexity Estimates

| Task | Estimate | Notes |
|---|---|---|
| **HS32**: Add error handling + dataSource fix | 30 min | Straightforward code changes in feature-viewer.js |
| **HS32**: Debug actual root cause | 1-2 hrs | Need to reproduce in browser with console open |
| **HS33**: Participant dropdown | 1-2 hrs | API exists, UI is simple, page-reload approach |
| **HS33**: No-reload approach | 3-4 hrs | More complex state management |

### Key Files to Modify
- `feature-viewer.html` — Add `#dataSource` element, add `#participantSelector` dropdown
- `js/feature-viewer.js` — Error handling on session switch, participant list loading, dropdown wiring
