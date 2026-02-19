# Captain's Log - 2026-02-18

## Mode Dropdown Relocated to Gear Popover + Memory Monitoring + UI Polish

Quick session moving UI controls into better locations and fixing several interaction polish items.

---

## Viewing Mode Moved into Navigation Bar Gear

The viewing mode dropdown (`#viewingMode`) was sitting in the bottom navigation bar alongside the "Scroll to zoom" checkbox. Moved it into the Navigation Bar gear popover as the first row (above Click and Show), labeled "Mode:". This groups all navigation behavior settings in one place — the gear icon is the single entry point for all minimap/nav configuration.

Removed the old standalone Mode dropdown from `#viewOptionsPanel`.

### Option reordering

Reordered viewing mode options to: Region Creation, Windowed Page Turn, Windowed Scroll, Windowed Static. Page Turn is the most common windowed mode so it comes first after Region Creation.

### Gear popover width

Bumped `.gear-popover` min-width from 170px to 220px to accommodate the longer option labels (especially "Windowed Page Turn").

---

## Uniform Dropdown Widths in Gear Popovers

All `.gear-select` dropdowns now have `flex: 1`, making them fill the available row width uniformly. Previously each dropdown was only as wide as its longest option text, so Mode, Click, and Show dropdowns had different widths. Now they're all flush on both sides.

---

## Dropdown Focus Highlight Suppression

After selecting an option (or re-selecting the same option), the browser's native focus ring lingered on the select element — visible as a blue/white highlight that looked like the dropdown was still "active."

### CSS approach

Added `:focus` and `:focus-visible` rules on `.gear-select` that force the focused appearance to match the unfocused state exactly:

```css
.gear-select:focus,
.gear-select:focus-visible {
    outline: none !important;
    border-color: #555 !important;
    box-shadow: none !important;
    background: #3c3c3c;
    color: #ddd;
    -webkit-focus-ring-color: transparent;
}
```

Combined with the existing `change → blur()` handler (which covers normal value changes), this handles the re-select-same-option case where `change` doesn't fire and focus lingers.

### Earlier attempts

- `click → setTimeout(blur, 50)` closed the dropdown before the user could pick an option (native select popup hadn't opened yet when blur fired)
- CSS `outline: none` alone wasn't sufficient — `color-scheme: dark` causes additional focus rendering that requires background/color/border overrides

---

## Memory Health Monitoring Improvements

### Interval schedule: 30s → 60s

Changed from a flat 10s interval to 30s for the first 5 minutes, then 60s thereafter. Reduces console noise during long sessions while still catching early memory issues.

### Print on load

Moved `startMemoryMonitoring()` from early in `initializeMainApp()` to after the recent-searches cache loads. The first health check now prints right after "Loaded N recent searches from cache", giving an immediate baseline reading.

### Enabled in EMIC study mode

Removed all four `!isStudyMode()` guards that were suppressing memory monitoring output in the EMIC study interface. Memory health data is useful regardless of which interface is active.

---

## Per-Panel Scroll-to-Zoom

Replaced the single "Scroll to zoom" checkbox in the bottom navigation bar with per-panel "Scroll:" dropdowns in each gear popover. Each panel can independently enable or disable scroll-zoom.

### Two new dropdowns

- **Navigation Bar gear** → `#navBarScroll`: Controls scroll-zoom on the waveform/minimap canvas
- **Main Window gear** → `#mainWindowScroll`: Controls scroll-zoom on the spectrogram canvas

Both default to "Zoom" with a "No action" alternative. Persisted to localStorage via `emic_navbar_scroll` and `emic_main_scroll`.

### Per-canvas gating in scroll-zoom.js

`onWheel()` now checks `e.currentTarget.id` to determine which canvas received the wheel event, then reads the corresponding dropdown. If `canvas.id === 'waveform'` it checks `#navBarScroll`; otherwise it checks `#mainWindowScroll`. This means you can have zoom enabled on the spectrogram but disabled on the minimap (or vice versa).

The old single `#scrollBehavior` checkbox and its `emic_scroll_behavior` localStorage key are removed.

### Files Changed (Session 10 — Per-Panel Scroll + Earlier Polish)

- `emic_study.html` — Viewing mode dropdown moved into nav bar gear popover, old standalone dropdown removed, option order: Region Creation → Page Turn → Scroll → Static; "Scroll:" dropdown added to both gear popovers; old "Scroll to zoom" checkbox removed from nav bar
- `js/main.js` — `startMemoryMonitoring()` moved to after cache load; `navControls` updated: replaced `scrollBehavior` checkbox with `navBarScroll` + `mainWindowScroll` select entries
- `js/scroll-zoom.js` — Per-canvas scroll gating via `#navBarScroll`/`#mainWindowScroll` dropdowns instead of single checkbox; removed duplicate `const canvas` declaration
- `js/spectrogram-three-renderer.js` — Removed `isStudyMode()` guards from memory monitoring, 30s→60s interval schedule
- `styles.css` — `.gear-popover` min-width 220px, `.gear-select` flex: 1, `:focus`/`:focus-visible` suppression rules

---

## Per-Panel Day Markers

Replaced the single "Day Markers" checkbox in the bottom navigation bar with per-panel "Markers:" dropdowns in each gear popover. Each panel can independently show or hide day markers.

### Two new dropdowns

- **Navigation Bar gear** → `#navBarMarkers`: Controls day markers on the waveform/minimap canvas
- **Main Window gear** → `#mainWindowMarkers`: Controls day markers on the spectrogram canvas

Both default to "Daily" with a "None" alternative. Persisted to localStorage via `emic_navbar_markers` and `emic_main_markers`.

### Per-panel gating in day-markers.js

Replaced `shouldDrawDayMarkers()` (single global check) with `shouldDrawMarkersForPanel(panel)`. `drawDayMarkers()` now evaluates each panel independently — spectrogram drawing is gated by `#mainWindowMarkers`, waveform drawing by `#navBarMarkers`. You can show markers on the spectrogram but hide them on the minimap (or vice versa).

The old single `#showDayMarkers` checkbox and its `emic_show_day_markers` localStorage key are removed.

---

## Gear Popover Layout Polish

### Z-index stacking fix

The nav bar gear popover was being hidden behind the main window gear icon below it — both `.panel-gear` containers had `z-index: 30`. Fixed by dynamically boosting the active popover's parent to `z-index: 35` when opened, resetting to `30` on close.

### Label width and alignment

Increased `.gear-label` min-width from 42px to 62px so labels like "Markers:" and "Scroll:" have room. Added `text-align: right` so all labels flush against their dropdowns. Adjusted `.gear-popover` min-width to 240px — wide enough for the new rows without excess whitespace.

### Files Changed (Session 11 — Per-Panel Markers + Layout Polish)

- `emic_study.html` — "Markers:" dropdown added to both gear popovers; old "Day Markers" checkbox removed from nav bar
- `js/main.js` — `navControls` updated: replaced `showDayMarkers` checkbox with `navBarMarkers` + `mainWindowMarkers` select entries; marker dropdown change listeners; z-index stacking on popover open/close
- `js/day-markers.js` — `shouldDrawMarkersForPanel(panel)` replaces `shouldDrawDayMarkers()`, per-panel gating in `drawDayMarkers()`
- `styles.css` — `.gear-label` min-width 62px + text-align right, `.gear-popover` min-width 240px

---

## DOM Feature Box System Confirmed Dead Code

Investigated `spectrogram-feature-boxes.js` — the entire DOM overlay feature box system (orange boxes) is vestigial. `addFeatureBox()` is exported but never called anywhere. `updateAllFeatureBoxPositions` is imported by 6 files but operates on an empty Map. `removeFeatureBox` and `renumberFeatureBoxes` are called from region-tracker.js but are no-ops since the Map is always empty.

Commented out all internal logic in every function while preserving the export signatures as empty shells, so the 6 importing files don't break. All original code is preserved as comments inside each function for reference.

---

## Feature Box Numbers Settings Section

### Numbers section in Main Window gear popover

Added a new "Numbers" section header to the main window gear popover with two dropdowns:

- **Color:** Hide / White / Red (default: Red) — controls whether feature box numbers are drawn, and in what color
- **Location:** Above box / Inside box (default: Above box) — positions the number label either above or inside the top of the box

Both persisted to localStorage via `emic_main_numbers` and `emic_main_numbers_loc`.

### Gear popover sub-section styling

- Centered `.gear-popover-title` text over the dropdown rows
- Added visual separator for sub-sections: `.gear-popover-row + .gear-popover-title` gets `margin-top: 12px`, `padding-top: 10px`, and a subtle `border-top` — so "Numbers" reads as a distinct section below the main dropdowns

---

## Frequency Scale Dropdown Polish (Windowed Modes)

### Hotkeys disabled in windowed modes

The C/V/B keyboard shortcuts for switching frequency scale (Linear/Square Root/Logarithmic) are now suppressed in windowed modes (`scroll`, `pageTurn`, `static`). These shortcuts were confusing when the frequency scale dropdown is hidden behind a gear popover.

### Hotkey labels removed from dropdown

Removed the "(C)", "(V)", "(B)" suffixes from the frequency scale dropdown option labels — they cluttered the UI and the hotkeys are now mode-gated anyway.

### Option reordering

Reordered frequency scale options: Logarithmic (selected/default, top), Square Root (middle), Linear (bottom). Since the default is at the top, the dropdown naturally "opens downward" from the selected item.

---

## Component & De-trend Controls Hidden in Windowed Modes

In windowed modes, the Component selector and De-trend checkbox in the top bar are not relevant — they're Region Creation tools. Hidden them to reduce visual clutter.

### `visibility: hidden` preserves layout

Used `visibility: hidden` instead of `display: none` so the controls still occupy their space in the flexbox layout. This keeps the status bar in its original position and size — it doesn't shift left or expand to fill the bar.

### Advanced mode override

The Advanced checkbox (`#advancedMode`) overrides the hiding: when Advanced is checked, Component and De-trend controls become visible again even in windowed modes. Toggling Advanced calls `updateRegionsPanelVisibility()` to re-evaluate immediately.

### Files Changed (Session 12 — Feature Numbers, Freq Scale Polish, Top Bar Declutter)

- `js/spectrogram-feature-boxes.js` — All internal logic commented out, export signatures preserved as empty shells
- `emic_study.html` — "Numbers" section with Color/Location dropdowns in main window gear popover; frequency scale options reordered (Logarithmic first), hotkey labels removed; `id="detrendContainer"` added to de-trend div
- `js/main.js` — `navControls` entries for `mainWindowNumbers` + `mainWindowNumbersLoc`; change listeners calling `redrawAllCanvasFeatureBoxes()`; `updateRegionsPanelVisibility()` hides Component/De-trend via `visibility:hidden` in windowed modes (gated by Advanced checkbox); Advanced change listener calls `updateRegionsPanelVisibility()`
- `js/spectrogram-renderer.js` — `drawSavedBox()` reads Numbers Color/Location dropdowns; red mode colors all numbers (no `flatNum <= 10` gate); location mode positions text above or inside box
- `js/keyboard-shortcuts.js` — C/V/B frequency scale shortcuts gated by windowed mode check
- `styles.css` — `.gear-popover-title` centered; `.gear-popover-row + .gear-popover-title` sub-section separator styling

---

## Settings Drawer (Hamburger Menu)

Replaced the standalone "Skip Login & Welcome" checkbox (which lived in the bottom-right corner, gated by Advanced mode) with a hamburger menu that opens a settings drawer from the left side.

### Push layout, not overlay

The drawer slides in from the left and **pushes** the entire `.container` to the right by 290px via `margin-left` transition. No dark overlay, no covering content — the main interface stays fully visible alongside the drawer. The hamburger button (☰) also slides right with the content so it remains accessible as a toggle.

### Hamburger button

Fixed-position ☰ in the top-left corner (`top: 10px, left: 12px`). Only visible when Advanced mode is checked — `applyAdvancedMode()` toggles its `display`. Clicking toggles the drawer open/closed.

### Drawer contents

- "Settings" header with ✕ close button
- "Session" section containing the "Skip Login & Welcome" checkbox (same `#skipLoginWelcome` id, so existing localStorage persistence via `navControls` just works)
- `<!-- Additional settings sections will be added here -->` placeholder for future expansion

### CSS approach

- `.settings-drawer` uses `transform: translateX(-100%)` → `translateX(0)` with 0.25s ease transition
- `body.drawer-open .container` gets `margin-left: 290px` with matching transition
- `body.drawer-open .hamburger-btn` shifts `left` from 12px to 302px
- All transitions are 0.25s ease for a smooth synchronized slide

### Advanced mode gating

`applyAdvancedMode()` shows/hides the hamburger button. If Advanced is turned off while the drawer is open, `closeSettingsDrawer()` is called to close it and remove the `body.drawer-open` class.

### Iteration: overlay → push

First implementation used a fixed overlay with a dark backdrop (`drawer-overlay`). User feedback: "I want it to push everything to the side and not overlay." Changed to push layout — removed the overlay div entirely, added `body.drawer-open` class to shift `.container` margin, and made the hamburger button a toggle (open/close) instead of open-only.

### Files Changed (Session 13 — Settings Drawer)

- `emic_study.html` — Old `#skipLoginRow` div removed; hamburger button (`#hamburgerBtn`), settings drawer (`#settingsDrawer`) with Session section and Skip Login checkbox; CSS for `.hamburger-btn`, `.settings-drawer`, push layout via `body.drawer-open`, drawer interior styles (`.drawer-header`, `.drawer-section`, `.drawer-row`, etc.)
- `js/main.js` — `applyAdvancedMode()` toggles hamburger visibility instead of `skipLoginRow`; `openSettingsDrawer()`/`closeSettingsDrawer()` manage `.open` class on drawer + `drawer-open` on body; hamburger click toggles drawer; close button wiring

---

## Welcome Modal Polish

- Added missing period after the email address in the EMIC welcome modal (`lewilliams@smith.edu` → `lewilliams@smith.edu.`)
- Widened the welcome modal content box from `max-width: 520px` → `720px` and `width: 85%` → `90%` so the instructional text has more breathing room

---

## EMIC About Modal (Info Button)

The (i) info button in the upper right wasn't connected to a modal in EMIC study mode. Created a new `emicAboutModal` separate from the main site's `aboutModal`:

- **`createEmicAboutModal()`** in `modal-templates.js` — task-oriented instructions ("Your task is to listen to magnetometer data..."), headphone guidance, "Complete" button instruction, and contact info for study coordinator Lucy Williams
- **Modal routing** in `main.js` — `aboutInfoBtn` click handler checks `window.__EMIC_STUDY_MODE` to open either `emicAboutModal` or `aboutModal`
- **Close wiring** — close button calls `modalManager.closeModal('emicAboutModal')`, which handles overlay fade-out
- **`closeAllModals()`** in `modal-manager.js` — added `'emicAboutModal'` to the hardcoded list
- **CSS override** in `emic_study.html` — `#emicAboutModal .modal-content` shares the same wide layout as `#welcomeModal` (720px max-width) to override the generic `.modal-content` `!important` rule

---

## Modal Visibility Fix (`modal-visible` class)

The EMIC about modal (and potentially any modal opened via `modalManager.openModal()`) showed the black overlay but the content box was invisible. Root cause: `.modal-window` starts at `opacity: 0` and requires `.modal-visible` class for `opacity: 1` with CSS transition. The old `showModal()` in `ui-controls.js` correctly triggered a reflow and added the class, but `modal-manager.js` never did.

### Fix

- **`openModal()`** — added `modal.offsetHeight; modal.classList.add('modal-visible');` after setting `display: flex` (reflow trigger ensures the transition animates)
- **`closeModal()`** — added `modal.classList.remove('modal-visible')` before hiding
- **`closeAllModals()`** — added `modal.classList.remove('modal-visible')` in the cleanup loop

---

## Minimap Feature Box Number Labels Removed

Removed number labels from minimap feature boxes in `waveform-renderer.js`. At minimap scale, 10px text is unreadable and just adds visual noise. The `getFlatFeatureNumber` import is also removed since it's no longer needed.

### Files Changed (Session 14 — Welcome Polish, About Modal, Modal Fix, Minimap Labels)

- `js/ui-controls.js` — Added period after email in welcome modal text
- `emic_study.html` — Widened welcome modal content box (520px → 720px, 85% → 90%), CSS override for EMIC about modal width
- `js/modal-templates.js` — New `createEmicAboutModal()` function, added to `initializeModals()`
- `js/modal-manager.js` — `modal-visible` class add/remove in `openModal()`/`closeModal()`/`closeAllModals()`; added `'emicAboutModal'` to `closeAllModals()` list
- `js/main.js` — Info button routes to `emicAboutModal` in EMIC mode; close button wiring for EMIC about modal
- `js/waveform-renderer.js` — Removed minimap feature box number labels and `getFlatFeatureNumber` import
