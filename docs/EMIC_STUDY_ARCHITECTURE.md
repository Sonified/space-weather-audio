# EMIC Study Interface — Architecture Plan

## Overview

Lauren Blum's team needs a custom research interface for EMIC wave analysis. Rather than forking the codebase, we leverage the existing **mode system** (`master-modes.js`) to create a new `EMIC_STUDY` mode that toggles all the new features on/off via config flags.

**URL:** `spaceweather.now.audio/emic_study.html`

---

## How Modes Work (Quick Recap)

The app already has a mode system in `js/master-modes.js`:
- `AppMode` enum defines available modes (PERSONAL, PRODUCTION, SOLAR_PORTAL, etc.)
- `MODE_CONFIG` object defines feature flags per mode
- `getModeConfig()` returns the active config
- Any code can check `if (getModeConfig().someFlag) { ... }`
- Production forces `SOLAR_PORTAL` mode; locally you can switch via dropdown

**The pattern:** Add features behind flags. Toggle flags per mode. Zero risk to existing pages.

---

## New Mode: `EMIC_STUDY`

Add to `AppMode` and `MODE_CONFIG` in `js/master-modes.js`:

```js
[AppMode.EMIC_STUDY]: {
    name: 'EMIC Study',
    description: 'Lauren Blum EMIC wave research interface',
    skipTutorial: true,
    showPreSurveys: false,       // Lauren's team handles pre/post separately
    showPostSurveys: false,
    enableAdminFeatures: false,   // Admin mode via URL param instead
    showSubmitButton: true,
    autoStartPlayback: false,

    // === NEW EMIC-SPECIFIC FLAGS ===
    scrollView: true,             // Horizontal scrolling playhead (continuous, not "book page")
    miniMap: true,                // Navigation mini-map at top showing current scroll position
    dayMarkers: true,             // Visual markers at day crossings on the timeline
    stretchSelector: true,        // Show algorithm selector (paulstretch, wavelet, granular, resample)
    speedSelector: true,          // Show playback speed options (0.5x, 0.75x, 1x or as configured)
    directAnnotation: true,       // Draw feature boxes directly on waveform (no sub-region step)
    adminExport: true,            // Admin mode for viewing/exporting all participant annotations
    fixedTimeWindow: true,        // Lock to a specific time period (configured below)
    participantIds: true,         // Support pre-populated participant IDs via URL param

    // Data config
    defaultSpacecraft: 'THEMIS',
    defaultDataset: 'THA_L2_SCM',
    // fixedStartTime: '2022-01-21T00:00:00Z',  // Lucy to confirm exact week
    // fixedEndTime: '2022-01-28T00:00:00Z',
}
```

---

## New HTML File: `emic_study.html`

Thin wrapper that forces the mode. Mostly a copy of `index.html` with:

1. Mode forced on load:
```html
<script>
    localStorage.setItem('selectedMode', 'emic_study');
</script>
```

2. Simplified UI (no spacecraft selector, no date picker if using fixed window)
3. Participant ID input or auto-populated from URL param (`?pid=PARTICIPANT_01`)
4. Stretch algorithm selector (4 buttons or dropdown)
5. Playback speed selector (0.5x, 0.75x, 1x)

---

## Feature Implementation Checklist

Each feature gets built once, gated by its mode flag, usable by any mode.

### 1. Scrolling Playhead (`scrollView: true`)
- **Current:** Waveform is static, playhead moves across it
- **New:** Waveform scrolls horizontally, playhead stays centered
- **Key files:** `js/waveform-renderer.js`, `js/spectrogram-renderer.js`
- **Check:** `if (getModeConfig().scrollView) { ... }`
- Continuous scroll with no "page turn" breaks
- Click and drag to navigate

### 2. Mini-Map (`miniMap: true`)
- Small overview bar at top showing full time range
- Highlighted box shows current scroll viewport
- Clickable for quick navigation
- **Key files:** New `js/mini-map-renderer.js`

### 3. Day Markers (`dayMarkers: true`)
- Vertical lines at UTC day boundaries
- Labels showing date
- "Waves don't know what time it is" — continuous scroll, markers are just reference points
- **Key files:** `js/waveform-renderer.js`, `js/spectrogram-renderer.js`

### 4. Stretch Algorithm Selector (`stretchSelector: true`)
- 4 options: Resample, Granular, Wavelet, Paulstretch
- All visible for now; Lauren's team decides final set for study
- Each algorithm processes the same source data differently
- **Key files:** New `js/stretch-engine.js` or extend existing audio pipeline

### 5. Playback Speed (`speedSelector: true`)
- Discrete options (0.5x, 0.75x, 1x — or as Lucy decides)
- Simple playbackRate adjustment on AudioContext
- **Key files:** `js/audio-player.js` or worklet

### 6. Direct Annotation (`directAnnotation: true`)
- **Current:** Create sub-region first, then annotate
- **New:** Draw feature boxes directly on waveform/spectrogram
- Each box stores: time range, user notes, participant ID, timestamp
- **Key files:** `js/region-tracker.js`, `js/spectrogram-feature-boxes.js`

### 7. Admin Export (`adminExport: true`)
- Admin mode activated via URL param (`?admin=true`) or toggle
- View all participant annotations overlaid
- Export complete dataset as JSON/CSV
- Annotations organized by participant
- **Key files:** `js/admin-mode.js` (extend existing)

### 8. Participant IDs (`participantIds: true`)
- Pre-populated via URL: `emic_study.html?pid=P001`
- Stored with all annotations
- Ensures experimental conditions properly assigned
- **Key files:** New `js/participant-manager.js`

### 9. Fixed Time Window (`fixedTimeWindow: true`)
- Lock spacecraft, dataset, and time range
- No date picker shown (or shown but disabled)
- Everyone analyzes the same data
- Week TBD by Lucy (around Jan 24, 2022)

---

## Migration Path

Once EMIC features are stable and Robert likes them:

1. Enable individual flags on `SOLAR_PORTAL` mode (e.g., `scrollView: true`)
2. Main spaceweather.now.audio page gets the features
3. No code changes needed — just flip the flags
4. Can enable features one at a time to test

---

## Team Action Items

- [ ] **Lucy:** Confirm exact 7-day time window
- [ ] **Lucy:** Confirm stretch factors (0.5x, 0.75x, 1x?)
- [ ] **Lucy:** Provide pre/post test questions
- [ ] **Lauren's team:** Decide on participant ID scheme
- [ ] **Lauren's team:** Decide which stretch algorithms to include in final study
- [ ] **Robert:** Scaffold `emic_study.html` + `EMIC_STUDY` mode config
- [ ] **Robert:** Implement scrolling playhead
- [ ] **Robert:** Implement direct annotation
- [ ] **Robert:** Implement stretch algorithm selector
- [ ] **Robert:** Implement admin export

---

## Rate

$100/hr, bi-weekly meetings, async communication between meetings.

---

*Created 2026-02-12. See also: Apple Note "EMIC spaceweather.now.audio — Feature Requests (v1 Beta)"*
