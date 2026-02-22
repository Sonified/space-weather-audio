# Captain's Log - 2026-02-21

## Feature Box Drag/Resize + Popup Overhaul + Sub-Second X-Axis Ticks

Major interaction upgrade: feature boxes can now be moved and resized by dragging, the popup got delete/pin/live-edit capabilities, and the x-axis ticks scale down to sub-second precision.

---

## Feature Box Drag & Resize

Feature boxes on the spectrogram are now fully interactive — drag to move, grab edges to resize, grab corners for diagonal resize.

### Interaction modes

| Mode | Trigger | Cursor |
|------|---------|--------|
| Move | Click and drag interior | `grab` / `grabbing` |
| Edge resize | Drag left/right/top/bottom edge (4px tolerance) | `ew-resize` / `ns-resize` |
| Corner resize | Drag any corner (5px tolerance) | `nwse-resize` / `nesw-resize` |

### Architecture

Self-contained drag system independent of the selection system. Three handler functions (`handleBoxDragDown`, `handleBoxDragMove`, `handleBoxDragUp`) that return `true` when they claim an event, preventing the selection system from starting a new box on top of an existing one.

Key functions:
- `getBoxDeviceRect(box)` — converts eternal time/freq coordinates to device-pixel rect, handling frequency scale transitions and zoom state
- `getBoxInteraction(cssX, cssY)` — hit-tests mouse against all boxes with edge/corner/interior priority logic
- `deviceXToTimestamp()` / `deviceYToFrequency()` — inverse coordinate transforms for converting pixel deltas back to data coordinates (includes full inverse of log/sqrt/linear frequency scales)

### 5px drag threshold

Mouse must move 5px before drag initiates. Below that threshold, mouseup opens the feature popup instead — so click-to-open still works naturally.

### Live updates during drag

- Canvas boxes redraw every mousemove via `redrawCanvasBoxes()`
- Open popup fields update in real-time via `syncPopupFieldsFromBox()` (skips focused inputs to avoid fighting user edits)
- On mouseup, coordinates are persisted to the feature data (standalone or region-based)

### Hover feedback

- Boxes get brighter fill (`rgba(255, 100, 100, 0.35)` vs `0.2`) when hovered
- Red resize handles (2.5px squares) appear at all 4 corners and 4 edge midpoints
- Hover state tracked by `hoveredBoxKey` to avoid unnecessary redraws

### Escape to cancel

Pressing Escape during a drag restores original coordinates via `cancelBoxDrag()`. Also fires on blur and mouseleave.

### Files Changed

- `js/spectrogram-renderer.js` — All drag/resize logic: state variables, `getBoxDeviceRect()`, `getBoxInteraction()`, `getCursorForMode()`, `deviceXToTimestamp()`, `deviceYToFrequency()`, three drag handlers, `cancelBoxDrag()`, hover tracking, resize handle drawing in `drawSavedBox()`

---

## Feature Popup Overhaul

The feature info popup got significant new capabilities: delete button, pin-to-feature mode, live field editing, and visual polish.

### Delete button

Trash can icon (SVG) in the popup header, between the gear and close buttons. Confirms via `window.confirm()`, then routes to `deleteStandaloneFeature()` or `deleteSpecificFeature()` depending on feature type. `closeFeaturePopup()` is now called during delete to prevent stale popup state.

### Pin-to-feature mode

New setting in popup gear panel: "Pin: Static | To Feature". When set to "To Feature":
- Popup follows its feature box as the user scrolls/zooms
- `updatePinnedPopupPosition()` runs per-frame from `updateCanvasAnnotations()` and on box redraws
- Drag offset is preserved — if you drag the popup away from the box, that relative offset persists as the box moves
- Popup hides with `.feature-popup--off-screen` class when the feature scrolls off-canvas

### Live field editing

Time and frequency input fields now update the feature box in real-time as you type. Uses `resolveInputValue()` to convert short time format ("3:15:00") back to full ISO strings via `parsePopupTimeToISO()`, preserving the original date portion.

### Popup positioning refactored

Extracted `positionPopupBesideRect()` — shared by initial placement and per-frame pin updates. Handles right/left preference based on available space, vertical centering on box, drag offset application, and viewport clamping.

### Click behavior in windowed mode

Popup now tracks which feature it belongs to via `popupFeatureBox`. Clicking a box toggles: if the popup is already open for that feature, it closes; if it's a different feature, it opens for the new one. Clicking outside on canvas won't close the popup if you're clicking another feature box.

### Wheel passthrough

Popup forwards wheel events to the spectrogram canvas so scroll-zoom momentum isn't killed by hovering over the popup.

### Visual polish (CSS)

- Close button: larger (24px), lighter color (`rgba(210, 210, 210, 0.75)`), white on hover
- Delete button: trash icon, red background on hover (`#d03030`)
- Save button: gradient background (`#667eea` → `#764ba2`), purple hover glow
- Gear icon: brighter default color to match close button
- All theme variants updated (dark-on-light, match-colormap, combined)

### Files Changed

- `js/spectrogram-renderer.js` — Popup state tracking (`popupFeatureBox`, `popupPinOffset`), `syncPopupFieldsFromBox()`, `parsePopupTimeToISO()`, `getScreenRectForBox()`, `positionPopupBesideRect()`, `updatePinnedPopupPosition()`, delete button wiring, live input handlers, pin mode transitions, wheel passthrough, click toggle logic, `closeFeaturePopup()` now exported
- `js/region-tracker.js` — `closeFeaturePopup()` calls in `deleteStandaloneFeature()` and `deleteSpecificFeature()`; `deleteSpecificFeature()` exported; standalone features now load before canvas box rebuild in `loadRegionsAfterDataFetch()`
- `styles.css` — New `.feature-popup-delete` styles, updated close/gear/save button styles across all theme variants

---

## Sub-Second X-Axis Ticks

When zoomed deep into a few seconds of data, the x-axis now shows sub-second tick marks instead of blank space.

### New tick intervals

| Interval | Label format | Example | Max time span |
|----------|-------------|---------|---------------|
| 100ms | `H:MM:SS.s` | `12:30:00.1` | 10.8s |
| 500ms | `H:MM:SS.s` | `12:30:00.5` | 54s |
| 1s | `H:MM:SS` | `12:30:05` | 1.8min |
| 5s | `H:MM:SS` | `12:30:05` | 6min |
| 10s | `H:MM:SS` | `12:30:10` | 12min |
| 30s | `H:MM:SS` | `12:30:30` | 30min |

### Implementation

- `calculateSubMinuteTicks(startUTC, endUTC, intervalMs)` — generic sub-minute calculator that quantizes to interval boundaries relative to the minute floor. Sets `showSeconds` and `showMilliseconds` flags on tick objects.
- `formatTickLabel(tick)` — extracted from both renderers into a shared function. Handles `H:MM`, `H:MM:SS`, `H:MM:SS.mmm` (trailing zeros dropped), and date crossings (`M/D`).
- `overrideMinPx` column added to the interval table in `chooseTicks()` — sub-second/second labels are wider and need 80–100px minimum spacing to avoid overlap.

### Spectrogram x-axis renderer simplified

Replaced the inline label formatting in `drawSpectrogramXAxis()` with a call to the shared `formatTickLabel()`, removing 13 lines of duplicated logic.

### Files Changed

- `js/waveform-x-axis-renderer.js` — `calculateSubMinuteTicks()`, `formatTickLabel()` (both exported), 6 new interval entries in `chooseTicks()`, `overrideMinPx` support in interval loop, replaced inline formatting with `formatTickLabel()`
- `js/spectrogram-x-axis-renderer.js` — Imported `formatTickLabel`, replaced 13-line inline formatter

---

## Frequency Precision: 2 → 3 Decimal Places

Feature coordinates now store and display frequency values to 3 decimal places (e.g. `0.125` Hz instead of `0.13` Hz). Affects `handleSpectrogramSelection()` logging, standalone feature creation, region feature storage, and popup display.

### Files Changed

- `js/region-tracker.js` — `.toFixed(2)` → `.toFixed(3)` in 6 locations across selection handling and feature creation

---

## Standalone Features Load Order Fix

Standalone features (used in windowed modes) were loaded AFTER `redrawAllCanvasFeatureBoxes()`, so they'd be invisible on first load. Moved `loadStandaloneFeatures()` and `renderStandaloneFeaturesList()` to run BEFORE the canvas box rebuild in both branches of `loadRegionsAfterDataFetch()`.

### Files Changed

- `js/region-tracker.js` — Reordered `loadStandaloneFeatures()` and `renderStandaloneFeaturesList()` before `redrawAllCanvasFeatureBoxes()` in both the "saved regions found" and "no saved regions" branches

---

## Scroll Zoom: FFT Size Guard

Added a safety check in `renderHiResViewport()` — if the viewport is so narrow that the estimated sample count is less than the FFT size, skip the hi-res render entirely. The existing on-screen texture IS the data at that zoom level; attempting FFT would produce garbage or errors.

### Files Changed

- `js/scroll-zoom.js` — Early return when `estimatedSamples <= fftSize`, with diagnostic log

---

## Region Zoom Hi-Res Render Disabled

Commented out the `renderCompleteSpectrogramForRegion()` call in `zoomToRegion()`, replaced with `Promise.resolve()`. The bottom pyramid level texture provides sufficient resolution; the hi-res re-render was adding latency without visible benefit.

### Files Changed

- `js/region-tracker.js` — `renderCompleteSpectrogramForRegion()` block commented out, replaced with `Promise.resolve()`

---

## Default Shader: Box → Linear

Changed the default spectrogram shader filter from "Box" to "Linear" in the gear popover dropdown.

### Files Changed

- `emic_study.html` — Swapped `selected` attribute from Box to Linear in `#mainWindowBoxFilter`

---

## Backend: 15-Minute Chunk Size

Added `"15m": 15 * 60` (900 seconds) to the R2 data pipeline chunk definitions, matching the pyramid L0 tile size.

### Files Changed

- `backend/goes_to_r2.py` — New `"15m"` entry in `CHUNK_DEFS`
