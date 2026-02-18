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
