# Captain's Log - 2026-02-23

## Init Timing, Settings Drawer Polish, Visual Refinements

A mix of initialization fixes, settings drawer UX improvements, and visual polish across the spectrogram and minimap.

---

## Advanced Mode Init Timing

The advanced toggle state was being read way too late — inside a `setTimeout` callback after all UI setup had already completed. Any code checking `advancedMode.checked` during initialization (like `updateRegionsPanelVisibility`) was reading the wrong default value.

**Fix:** Moved the localStorage restore + `initializeAdvancedControls()` call to the very start of the UI Setup phase in `initializeMainApp()`, before mode selector init, tutorial, modals, keyboard shortcuts, and everything else. The mode-specific initializers (`initializeEmicStudyMode`, `initializeSolarPortalMode`) no longer call it — it's already done.

## Settings Drawer Polish

- **Width:** 240px → 260px for breathing room
- **Scrollbar:** Replaced chunky browser-default scrollbar with a thin (5px), translucent thumb on a transparent track. Brightens subtly on hover. Works cross-browser (Firefox `scrollbar-width`/`scrollbar-color` + WebKit `::-webkit-scrollbar`).
- **Push offset:** Container margin and hamburger button position now match the drawer width exactly (260px) — previously they were 290px/302px, creating a detached gap between the drawer edge and the hamburger icon.
- **Fade in/out curve selects:** Right-aligned with `justify-content: space-between` to match other drawer rows.
- **"At page edge" dropdown:** Narrowed from 130px to 105px so the label fits on one line.

## Viewing Mode Transition Fix

`applyViewingMode()` previously called `zoomState.setViewportToFull()` on every windowed mode change, resetting the view even when switching between windowed modes. Now tracks `lastViewingMode` and only resets viewport when transitioning *into* windowed mode from Region Creation.

## Spectrogram Sizing

- **EMIC study:** Spectrogram height changed from fixed `554px` to responsive `clamp(250px, 62vh, 600px)`.
- **`fitSpectrogram` script:** Removed unnecessary `DOMContentLoaded` check — the script is at the bottom of the body so DOM elements already exist. Running immediately prevents a first-paint jump.
- **Three.js renderer init:** Added canvas buffer sync to match CSS display size on init, so the first render frame is correctly sized.

## Visual Refinements

- **Minimap day markers:** Changed from `bottom` to `top` label position.
- **Minimap feature boxes:** Toned down from bright `#ff4444` to `rgba(200, 50, 50, 0.8)` stroke and `rgba(220, 60, 60, 0.15)` fill — less visually aggressive.
