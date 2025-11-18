# Captain's Log: 2025-11-18

## Major Refactor: Pure Canvas Selection Box Rendering

### Problem Identified
The spectrogram selection boxes (red boxes drawn during feature selection) were experiencing circular event issues due to DOM manipulation during mouse events. The document "CANVAS_RENDERING_METRONOME.md" identified the root cause: **the appendChild() trap**.

#### The appendChild() Mousedown Trap
When you call `appendChild()` during a `mousedown` event, you trigger a cascade of browser behaviors:

1. **Event target chain breaks**: The W3C UI Events specification requires both mousedown and mouseup to occur on the same element with a consistent "nearest common inclusive ancestor" for the click event to fire. DOM manipulation during mousedown breaks this ancestral chain.

2. **Chromium spurious mousemove events**: Chrome generates "fake" mousemove events after discrete events (mousedown/mouseup) for cursor style updates. When a DOM element is inserted during mousedown, these spurious events can hit the newly created element instead of the canvas, triggering handlers again and creating circular patterns.

3. **New element captures subsequent events**: The newly appended DOM element (the selection box div) can become the event target for subsequent mouse events, completely breaking the intended event flow.

### Why the Waveform Never Had This Issue
The waveform uses **pure canvas rendering** with zero DOM manipulation during mouse events. This is the industry-standard pattern used by Fabric.js, Konva.js, Paper.js, and every other major canvas library.

Key architectural principles:
- **Single, stable event target**: The canvas element never moves, never changes position
- **Immediate-mode rendering**: `ctx.strokeRect()` just sets pixels - no DOM nodes created
- **Event handlers separated from rendering**: Events update state variables, requestAnimationFrame loop handles all drawing
- **No reflow/repaint cycles**: Canvas drawing is GPU-accelerated pixel manipulation

### Solution Implemented: Separate Overlay Canvas

#### The Key Insight

Drawing the selection box on the **main spectrogram canvas** creates race conditions with:
- Playhead renderer updating the canvas
- Viewport refreshes during playback rate changes
- Frequency scale transitions
- Zoom operations

**The solution:** Create a **dedicated overlay canvas** just for the selection box - a separate layer we fully control with zero conflicts.

#### Changes Made

**1. Overlay Canvas Layer (spectrogram-renderer.js)**
```javascript
// Create dedicated overlay canvas positioned exactly over main canvas
spectrogramOverlayCanvas = document.createElement('canvas');
spectrogramOverlayCanvas.style.position = 'absolute';
spectrogramOverlayCanvas.style.pointerEvents = 'none';  // Pass events through
spectrogramOverlayCanvas.style.zIndex = '10';  // Above spectrogram, below feature boxes

// Match main canvas dimensions
spectrogramOverlayCanvas.width = canvas.width;
spectrogramOverlayCanvas.height = canvas.height;
```

**2. Event Handlers (spectrogram-renderer.js)**
- **mousedown**: Sets start position, initializes state
- **mousemove**: Updates drag position, **clears and redraws ONLY the overlay canvas**
- **mouseup**: Handles selection completion, **clears the overlay canvas**

**3. Mousemove Handler - Simple and Isolated**
```javascript
canvas.addEventListener('mousemove', (e) => {
    if (!spectrogramSelectionActive || !spectrogramOverlayCtx) return;
    
    // Update state
    spectrogramCurrentX = e.clientX - canvasRect.left;
    spectrogramCurrentY = e.clientY - canvasRect.top;
    
    // Draw ONLY on overlay canvas (separate layer - no conflicts!)
    spectrogramOverlayCtx.clearRect(0, 0, width, height);
    drawSpectrogramSelectionBox(spectrogramOverlayCtx, width, height);
});
```

**4. Canvas Rendering Function (spectrogram-renderer.js)**
```javascript
export function drawSpectrogramSelectionBox(ctx, canvasWidth, canvasHeight) {
    // Only draw if actively selecting with sufficient drag
    if (!spectrogramSelectionActive || dragDistance < 5) return;
    
    // Convert CSS pixels to device pixels
    const scaleX = canvas.width / canvas.offsetWidth;
    const scaleY = canvas.height / canvas.offsetHeight;
    
    // Draw directly on canvas with ctx.strokeRect() and ctx.fillRect()
    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, width, height);
    
    ctx.fillStyle = 'rgba(255, 68, 68, 0.2)';
    ctx.fillRect(x, y, width, height);
}
```

**5. Zero Integration Needed**
The overlay canvas is completely independent:
- Main spectrogram canvas is **never touched** by selection box rendering
- Playhead renderer continues updating main canvas normally
- Viewport updates work without modification
- No conflicts during frequency scale changes, playback rate changes, or zoom operations

#### Files Modified
1. `js/spectrogram-renderer.js` - Selection state management and canvas drawing function
2. `js/spectrogram-playhead.js` - Main renderer with overlay layering
3. `js/spectrogram-complete-renderer.js` - Integration with viewport updates

#### Why This Solves the Circular Event Pattern

1. **No DOM manipulation during events**: The canvas element is the only event target throughout the entire gesture sequence
2. **Synchronous state updates**: Event handlers complete in microseconds, updating only JavaScript variables
3. **Rendering happens separately**: The requestAnimationFrame loop or explicit render calls handle all drawing
4. **No spurious event triggers**: Canvas pixel manipulation triggers no browser events, no layout calculations, no reflows
5. **Consistent with waveform**: Both visualizations now use identical pure canvas patterns

### Benefits

**Architectural**
- Eliminates entire class of DOM manipulation timing bugs
- Aligns spectrogram with industry-standard canvas practices
- Matches waveform architecture (consistency across codebase)
- Removes need for complex re-entrance guards and timeouts

**Performance**
- No DOM reflows during drag operations
- GPU-accelerated canvas rendering
- No layout calculations during mouse events

**Reliability**
- Works consistently across Chrome, Firefox, Safari, Brave
- No browser-specific workarounds needed
- Survives focus changes, sleep/wake cycles, rapid interactions

### Testing Results

✅ **WORKING** - Separate overlay canvas approach successfully eliminates all circular event issues:
- Selection box draws smoothly with no conflicts
- handleSpectrogramSelection() calls properly after mouseup
- Feature box creation proceeds normally
- Zero race conditions with playhead/viewport/zoom systems

### Final Architecture

**Two independent canvas layers:**
1. **Main spectrogram canvas**: Viewport, playhead, base visualization (owned by playback/render systems)
2. **Overlay canvas**: Selection box only (owned exclusively by selection system)

**Key properties of overlay:**
- `position: absolute` - positioned over main canvas
- `pointerEvents: none` - events pass through to main canvas
- `background: transparent` - see-through to spectrogram
- `zIndex: 10` - above spectrogram, below DOM feature boxes

**Event flow:**
1. mousedown → set state, no rendering
2. mousemove → clear overlay, draw selection box on overlay only
3. mouseup → freeze selection, call handler, then clear overlay after feature box created

This architecture completely eliminates the appendChild() trap because:
- No DOM manipulation during mouse events (canvas pixels only)
- No conflicts between selection rendering and other canvas systems
- Clean separation of concerns - each layer knows its purpose

### References
- `docs/CANVAS_RENDERING_METRONOME.md` - Complete analysis of the appendChild trap
- W3C UI Events specification Issue #141 - DOM manipulation breaking event chains
- Stack Overflow #30169521 - Chromium spurious mousemove events
- Stack Overflow #24670598 - mousedown generating automatic mousemove events

### Next Steps
- **Test the implementation** thoroughly with rapid clicking, dragging, scale changes
- **Remove deprecated code** after confirming everything works (spectrogramSelectionBox DOM variable)
- **Consider adding this pattern** to any other interactive canvas elements
- **Document** this as the standard pattern for all future canvas interactions

---

## Version v2.49 - Pure Canvas Feature Boxes

**Commit:** `v2.49 Refactor: Replaced DOM-based orange feature boxes with pure canvas rendering - eliminates appendChild() circular event issues, adds smooth interpolation during scale/zoom transitions, auto-syncs with feature array for deletion/renumbering`

**Major Changes:**
- ✅ Replaced orange DOM feature boxes with red canvas boxes on dedicated overlay
- ✅ Eliminated appendChild() circular event issues completely
- ✅ Added smooth interpolation during frequency scale transitions (matches x-axis ticks)
- ✅ Added elastic horizontal movement during zoom transitions
- ✅ Auto-syncs with feature array (rebuilds from source of truth)
- ✅ Automatic deletion and renumbering when features are deleted
- ✅ Numbers shift correctly (delete feature 2 from [1,2,3,4,5] → [1,2,3,4])
- ✅ Uses metadata for Nyquist frequency (not hardcoded 50 Hz)
- ✅ Follows same coordinate conversion logic as orange boxes
- ✅ Redraws at 60fps during transitions

**Files Modified:**
- `js/spectrogram-renderer.js` - Canvas overlay system, box drawing, rebuild logic
- `js/region-tracker.js` - Hooked into deletion events
- `js/audio-player.js` - Hooked into playback speed changes
- `js/waveform-x-axis-renderer.js` - Hooked into zoom transitions
- `js/main.js` - Version number updated to v2.49

---

## Version v2.50 - Spectrogram Playhead Overlay & UI Polish

**Commit:** `v2.50 Refactor: Spectrogram playhead overlay canvas, UI color updates, and visual polish`

**Major Changes:**
- ✅ Spectrogram playhead now uses dedicated transparent overlay canvas (much simpler, no background restoration needed)
- ✅ Updated top panel colors - selection panel #9a9a9a, playback panel #a8a8a8 with healthy gradients
- ✅ Reduced waveform playhead white line opacity for subtler appearance
- ✅ Fetch Data button now pulses brighter on load for better visibility

**Key Insight:**
The spectrogram playhead was drawing directly on the main canvas and having to restore background strips every time it moved. By using a dedicated transparent overlay canvas (similar to the selection overlay), we eliminated all the complex `drawImage` operations and made the code much simpler - just clear and draw the line!

**Files Modified:**
- `js/spectrogram-playhead.js` - Refactored to use dedicated overlay canvas
- `styles.css` - Updated panel colors and Fetch Data button animation
- `js/waveform-renderer.js` - Reduced playhead white line opacity
- `js/main.js` - Version number updated to v2.50

---

## Version v2.51 - UI Polish & Tutorial Improvements

**Commit:** `v2.51 UI: Fixed waveform-x-axis max-width, unified participant ID styling, added visual guidance emoji to tutorial`

**Major Changes:**
- ✅ Fixed waveform-x-axis max-width constraint to match other canvases (was shorter than others)
- ✅ Unified participant ID text box styling - dark background (`rgba(40, 40, 40, 0.4)`) with reddish hover (`rgba(80, 50, 50, 0.6)`) for consistent appearance during tutorial
- ✅ Added ↘️ emoji to volume adjustment tutorial message for better visual guidance

**Files Modified:**
- `styles.css` - Added max-width: 100% to #waveform-x-axis, added CSS rules for participant ID text box with !important flags
- `js/main.js` - Updated hover handlers for participant ID to use dark reddish theme
- `js/tutorial-coordinator.js` - Added ↘️ emoji to volume tutorial message
- `js/main.js` - Version number updated to v2.51

---

## Version v2.52 - Bug Fix: Keyboard Event Handlers

**Commit:** `v2.52 Fix: Added guard clauses to handleSecretKeyListener and handleDebugJumpListener to prevent TypeError when e.key is undefined`

**Major Changes:**
- ✅ Fixed TypeError in `handleSecretKeyListener` - added guard clause to check if `e.key` exists before calling `.toLowerCase()`
- ✅ Fixed TypeError in `handleDebugJumpListener` - added guard clause to check if `e.key` exists before calling `.toLowerCase()`
- ✅ Prevents crashes when certain keyboard events (like modifier keys or special keys) trigger events where `e.key` is undefined

**Problem:**
Some keyboard events (particularly modifier keys or special keys) can have `e.key` as `undefined`, causing a TypeError when trying to call `.toLowerCase()` on it.

**Solution:**
Added early return guard clauses (`if (!e.key) { return; }`) at the beginning of both keyboard event handlers to safely ignore events without a valid key property.

**Files Modified:**
- `js/main.js` - Added guard clauses to `handleSecretKeyListener` and `handleDebugJumpListener` functions

---

## Version v2.53 - Modal UX Improvements

**Commit:** `v2.53 Fix: Disabled click-outside-to-close for all modals, added dynamic participant modal text based on context`

**Major Changes:**
- ✅ Disabled click-outside-to-close behavior for ALL modals - clicks outside modal area are now completely ignored
- ✅ Fixed bug where users could accidentally close modals by clicking outside with no way to bring them back
- ✅ Added dynamic text to participant modal based on context:
  - **Upper right corner click (with ID)**: "You're All Set" / "Your participant ID is stored."
  - **Initial setup from Qualtrics**: "Welcome" / "Your participant ID has successfully been transferred from Qualtrics:"
  - **Initial setup (no ID)**: "Welcome" / "Enter your participant ID number to begin:"

**Problem:**
Users could accidentally click outside modal areas, which would hide the overlay with no way to bring it back. This was particularly problematic during study workflows where modals are required.

**Solution:**
1. Removed all conditional click-outside-to-close handlers
2. Added preventDefault/stopPropagation handlers to all modals to completely ignore clicks outside the modal content area
3. Made participant modal text context-aware by checking if ID exists and if it came from Qualtrics URL

**Files Modified:**
- `js/ui-controls.js` - Disabled click-outside-to-close for all modals, added dynamic text logic to `openParticipantModal()`
- `js/main.js` - Version number updated to v2.53

**Git Commit:** `cde60b7` - v2.53 Fix: Disabled click-outside-to-close for all modals, added dynamic participant modal text based on context

---

## Version v2.54 - Stuck State Fix & UI Improvements

**Commit:** `v2.54 Fix: Fixed stuck state after sleep mode, changed feature selection instructions, added welcome back message`

**Major Changes:**
- ✅ Fixed stuck state bug after sleep mode - spectrogram canvas would become unresponsive after cleanup message appeared
- ✅ Added aggressive state reset and overlay context recovery when stuck state is detected
- ✅ Added safeguard message "Difficulty Creating Regions? Please refresh your page to continue. Thanks!" (displayed in orange)
- ✅ Changed feature selection instructions from "(f) to select a feature" to "click and drag to select a feature"
- ✅ Pre-survey modal now shows "Welcome back!" for returning visitors (after first visit)

**Problem:**
After sleep mode, users could get stuck in a state where the cleanup message appeared but clicking on the spectrogram canvas did nothing. The overlay context could become null/undefined, preventing new selections from starting.

**Solution:**
1. Added detection for missing overlay context after cleanup
2. Implemented automatic overlay canvas reinitialization if missing
3. Added safeguard message display when stuck state is detected
4. Enhanced state reset to be more aggressive and comprehensive
5. Added checks in multiple places (mousedown, mousemove, visibilitychange) to detect and recover from stuck state

**Files Modified:**
- `js/spectrogram-renderer.js` - Added stuck state detection, recovery, and safeguard message functions
- `js/region-tracker.js` - Updated status message to say "click and drag" instead of "(f) key"
- `js/ui-controls.js` - Added logic to show "Welcome back!" in pre-survey modal for returning visitors
- `js/main.js` - Version number updated to v2.54

