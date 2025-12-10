# Captain's Log - 2025-12-10

## Comprehensive Mobile Support

Major update adding full mobile/touch support to the Space Weather Audification Portal. The app is now fully functional on phones and tablets.

---

## Mobile CSS Responsive Styles

### Media Query Strategy

Added comprehensive mobile styles using dual media query:
```css
@media (max-width: 768px), (max-height: 500px)
```
- Portrait phones: `max-width: 768px`
- Landscape phones: `max-height: 500px` (catches phones turned sideways)

### Layout Changes (Mobile Only)

1. **Header wrapping** - Top header content wraps vertically instead of horizontal bar
2. **Controls wrapping** - Playback controls wrap with `flex-wrap: wrap`
3. **Reduced padding** - Body padding reduced from 10px to 4px at top
4. **Edge-to-edge display** - Uses `viewport-fit=cover` and `env(safe-area-inset-*)` for notched devices
5. **Region labels** - "Region 1" shortened to "Reg 1" on mobile screens

### iOS Safari Fixes

- All inputs/selects/textareas set to `font-size: 16px` minimum to prevent auto-zoom on focus
- Added `viewport-fit=cover` meta tag for iPhone X+ notch handling

### Files Modified

- `styles.css` - Added ~250 lines of mobile-specific styles at end of file
- `index.html` - Added `viewport-fit=cover` to meta viewport tag

---

## Touch Event Handlers for Waveform

### New Touch Interactions

Added complete touch support to the waveform canvas:

1. **Tap to seek** - Single tap seeks playback to that position
2. **Drag to select** - Touch and drag creates a time selection (for region creation)
3. **Button taps** - Zoom (🔍) and play (▶) buttons work on touch

### Implementation Details

Added four touch event listeners to waveform canvas in `waveform-renderer.js`:
- `touchstart` - Detects button taps vs drag start
- `touchmove` - Handles selection dragging
- `touchend` - Completes button action or selection
- `touchcancel` - Cleanup on interruption (e.g., incoming call)

### Key Design Decisions

1. **Button check before preventDefault** - Buttons are checked first, then `e.preventDefault()` is called only for drag interactions. This ensures button taps work properly.

2. **isTouchDevice guard** - All handlers check `if (!isTouchDevice) return;` at start to prevent interference with desktop trackpad gestures.

3. **Higher drag threshold** - Touch uses 10px threshold (vs 3px for mouse) to distinguish tap from drag.

### Touch-Action CSS

```css
#waveform {
    touch-action: none; /* JS handles all touch */
}
#spectrogram {
    touch-action: pan-y; /* Allow vertical scroll */
}
#spectrogram.touch-draw {
    touch-action: none; /* When zoomed into region */
}
```

### Files Modified

- `js/waveform-renderer.js` - Added ~120 lines of touch handlers
- `js/audio-state.js` - Added `isTouchDevice` and `isMobileScreen()` exports
- `js/region-tracker.js` - Dynamic spectrogram touch mode toggling

---

## Mobile Tap Hint Overlay

### Feature

Shows "👆 Tap here to play" hint on waveform for first-time mobile users.

### Behavior

- Only shows on touch devices
- Disappears after first tap
- Remembered via `localStorage.userHasTappedWaveformMobile`
- Positioned directly over waveform canvas (not spectrogram)
- Has gentle pulse animation

### Implementation

```javascript
export function showMobileTapHint() {
    if (!isTouchDevice) return;
    if (localStorage.getItem('userHasTappedWaveformMobile') === 'true') return;
    // Create and position overlay...
}
```

Called after waveform draws (both crossfade and direct paths).

---

## UI Simplification: Hidden Dropdowns

### Change

Removed the repetition (Unique/Repeated) and type (Impulsive/Continuous) dropdowns from feature rows. Now only the comment/description text box is shown.

### CSS

```css
.feature-row select[id^="repetition-"],
.feature-row select[id^="type-"] {
    display: none !important;
}

.feature-row {
    grid-template-columns: 240px 1fr; /* Button + textarea only */
}
```

### Rationale

Simplifies the interface - users can describe features in free-form text rather than categorizing with dropdowns.

---

## Bug Fixes During Mobile Implementation

### 1. Desktop Trackpad Scroll Broken

**Problem:** Two-finger scroll stopped working on desktop when cursor was over waveform.

**Cause:** Touch handlers with `e.preventDefault()` were intercepting trackpad gestures on some browsers.

**Fix:** Added `if (!isTouchDevice) return;` guard to all touch handlers.

### 2. Region Zoom Buttons Not Working on Mobile

**Problem:** Tapping zoom (🔍) buttons showed "Cannot zoom: region not found".

**Cause:** `zoomToRegion(region)` was passing the region object instead of `zoomToRegion(zoomIndex)` (the index).

**Fix:** Changed to pass `zoomIndex` instead of `region` object.

### 3. Add Region Button Positioned Wrong on Mobile

**Problem:** "Add Region" button appeared at left edge instead of centered on selection.

**Cause:** Touch handler called `showAddRegionButton(rect)` instead of `showAddRegionButton(State.selectionStart, State.selectionEnd)`.

**Fix:** Pass correct time arguments instead of canvas rect.

### 4. Tap Hint on Wrong Canvas

**Problem:** "Tap here to play" overlay appeared over spectrogram instead of waveform.

**Cause:** Both canvases share the same parent container, and overlay was centered in parent.

**Fix:** Calculate waveform's position within parent and position overlay there specifically.

---

## Orientation Change Handling

### Feature

App redraws correctly when phone is rotated between portrait and landscape.

### Implementation

```javascript
window.addEventListener('orientationchange', () => {
    setTimeout(() => window.dispatchEvent(new Event('resize')), 100);
});
```

The 100ms delay ensures the browser has updated dimensions before triggering resize handlers.

---

## Cache Busting

Added version query strings to ensure mobile browsers load fresh code:

```html
<link rel="stylesheet" href="styles.css?v=20251210c">
<script type="module" src="js/main.js?v=20251210g"></script>
```

Also in ES module imports:
```javascript
import { ... } from './waveform-renderer.js?v=20251210g';
```

---

## Summary of Mobile Features

| Feature | Status |
|---------|--------|
| Header/controls wrapping | ✅ |
| Touch to seek | ✅ |
| Touch drag to select | ✅ |
| Region button taps | ✅ |
| Add Region button positioning | ✅ |
| iOS auto-zoom prevention | ✅ |
| Landscape mode | ✅ |
| Orientation change | ✅ |
| Mobile tap hint | ✅ |
| Edge-to-edge display | ✅ |
| Shortened "Reg" labels | ✅ |

---

## Files Modified

- `index.html` - viewport meta, cache busting
- `styles.css` - ~250 lines of mobile styles, hidden dropdowns
- `js/waveform-renderer.js` - Touch handlers, tap hint overlay
- `js/audio-state.js` - `isTouchDevice`, `isMobileScreen()`
- `js/region-tracker.js` - Mobile region labels, touch mode toggling
- `js/main.js` - Orientation handler, cache busting imports
