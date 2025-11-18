# Waveform Yellow Highlight vs Spectrogram Orange Boxes - Exhaustive Comparison

## 🔥 CRITICAL BUG FIX - November 2025

### The Bug: Focus Loss Corrupted Drawing State

**Symptoms:**
- Drawing feature selection boxes worked perfectly... until you tabbed away mid-drag
- After CMD+Tab to another window and back, clicking to draw would fail
- Sometimes required clicking twice, sometimes waiting 5 seconds, sometimes just broken
- Spectrogram drawing became unreliable while waveform "drew beautiful regions all day"

**Root Cause:**
The spectrogram had **blur/focus/visibility/mouseleave handlers** that tried to be "helpful" by cleaning up state when the browser lost focus. These handlers were **over-protective** and actually **corrupted the drawing state**:

```javascript
// ❌ THE PROBLEM (lines 658-693 in spectrogram-renderer.js)
spectrogramFocusBlurHandler = () => {
    if (!hasFocus || !isVisible) {
        if (spectrogramSelectionActive || spectrogramSelectionBox) {
            cancelSpectrogramSelection();  // ← MURDERED THE STATE!
        }
    }
};

window.addEventListener('blur', spectrogramFocusBlurHandler);
canvas.addEventListener('mouseleave', cancelSpectrogramSelection);
```

**Why It Failed:**
1. User clicks mousedown → `spectrogramSelectionActive = true`
2. User tabs away mid-drag → blur handler fires
3. Blur handler calls `cancelSpectrogramSelection()`
4. BUT the mousedown handler also checked for stale state (line 509):
   ```javascript
   if (spectrogramSelectionActive || spectrogramSelectionBox) {
       cancelSpectrogramSelection();
       return; // ← STOPPED HERE! Couldn't start new selection!
   }
   ```
5. User returns and clicks → mousedown sees "stale" state from previous canceled drag
6. Cancels and returns early → **NO NEW SELECTION STARTS**
7. State becomes corrupted: `spectrogramSelectionActive` could be stuck, coordinates mismatched

**The Revelation:**
The waveform renderer has **ZERO blur/focus handlers** and works perfectly!

```bash
$ grep -n "blur\|focus\|visibility" js/waveform-renderer.js
# (no results) ← NONE! And it works flawlessly!
```

**The Fix:**
Copied the waveform's "Zen pattern" - **removed ALL defensive handlers**:

```javascript
// ✅ THE FIX: Remove blur/focus paranoia, trust the mousedown cleanup

// REMOVED:
// - window.addEventListener('blur', spectrogramFocusBlurHandler)
// - window.addEventListener('focus', spectrogramFocusBlurHandler)
// - document.addEventListener('visibilitychange', spectrogramFocusBlurHandler)
// - canvas.addEventListener('mouseleave', cancelSpectrogramSelection)

// KEPT:
// ✅ mousedown auto-cleanup (line 509) - silently cleans stale state before starting new selection
// ✅ 5-second safety timeout (line 544) - prevents infinite stuck states
// ✅ Escape key cancel (line 662) - manual user override
```

**New Flow:**
1. User clicks mousedown mid-way through stale drag
2. Mousedown handler detects stale state (line 509)
3. **Silently cleans up** instead of canceling and returning:
   ```javascript
   if (spectrogramSelectionActive || spectrogramSelectionBox) {
       console.log('🧹 Cleaning up stale selection state before starting new one');
       // Clear timeout, delete box, reset state
       // DON'T return - continue to start new selection below!
   }
   ```
4. **Immediately starts fresh selection** - works first try, every time!

**Results:**
- ✅ Tab away mid-drag → come back → click works IMMEDIATELY
- ✅ No more waiting 5 seconds
- ✅ No more double-clicking
- ✅ No more corrupted state
- ✅ As reliable as the waveform!

**The Lesson:**
**LESS IS MORE.** The blur handlers were like antibodies attacking your own code. Sometimes the best fix is to **delete code, not add it**. Trust the natural cleanup flow instead of forcing it.

**Files Changed:**
- `js/spectrogram-renderer.js` (lines 507-531, 610-611, 658-672, 718)

---

## Executive Summary

**Waveform**: Draws yellow selection box DIRECTLY on main waveform canvas, no separate layers, no DOM elements, no blur/focus handlers.

**Spectrogram**: Uses TWO separate systems:
1. Yellow selection box during drag → separate `spectrogram-selection` overlay canvas
2. Orange persistent feature boxes → actual DOM `<div>` elements positioned absolutely with extensive focus/blur management

---

## 1. CANVAS ARCHITECTURE

### Waveform Yellow Highlight
```javascript
// SINGLE CANVAS SYSTEM
Canvas ID: 'waveform'
- Main waveform rendering
- Selection box overlay
- Playhead indicator
- Region highlights
ALL drawn on the same canvas context
```

**Canvas Structure:**
- **Main Canvas**: `<canvas id="waveform">` - Everything drawn here
- **No overlay canvas** - Selection box drawn directly on top of waveform
- **No DOM elements** - Pure canvas rendering

**Drawing Target:**
```javascript
// Lines 335-481 in waveform-renderer.js
const canvas = document.getElementById('waveform');
const ctx = canvas.getContext('2d');
ctx.clearRect(0, 0, width, height);
ctx.drawImage(State.cachedWaveformCanvas, 0, 0);  // Base waveform

// Draw selection box DIRECTLY on same canvas
ctx.fillStyle = 'rgba(255, 255, 0, 0.2)';
ctx.fillRect(startX, 0, selectionWidth, height);
```

---

### Spectrogram Orange Boxes
```javascript
// THREE-LAYER SYSTEM
Canvas 1: 'spectrogram' (main spectrogram)
Canvas 2: 'spectrogram-selection' (yellow selection box during drag)
DOM Layer: Absolute positioned <div> elements (orange persistent boxes)
```

**Canvas Structure:**
- **Main Canvas**: `<canvas id="spectrogram">` - Base spectrogram rendering
- **Overlay Canvas**: `<canvas id="spectrogram-selection">` - Yellow selection box during drag
- **DOM Layer**: `<div>` elements with `position: absolute` for persistent orange boxes

**Drawing Targets:**
```javascript
// Yellow Selection Box (during drag) - Lines 37-145 in spectrogram-renderer.js
const selectionCanvas = document.getElementById('spectrogram-selection');
const ctx = selectionCanvas.getContext('2d');
ctx.clearRect(0, 0, width, height);  // Only clear overlay, not main spectrogram
ctx.fillStyle = 'rgba(255, 255, 0, 0.2)';
ctx.fillRect(left, top, boxWidth, boxHeight);

// Orange Persistent Boxes - Lines 42-88 in spectrogram-feature-boxes.js
const box = document.createElement('div');
box.style.position = 'absolute';
box.style.border = '2px solid rgba(255, 140, 0, 0.8)';
box.style.background = 'rgba(255, 140, 0, 0.15)';
box.style.pointerEvents = 'none';
container.appendChild(box);  // Add to DOM
```

---

## 2. DRAWING METHODS

### Waveform Yellow Highlight

**Primary Drawing Function:** `drawWaveformWithSelection()` (lines 335-481)

**Drawing Steps:**
1. Clear entire canvas
2. Redraw cached waveform base
3. Draw region highlights
4. Draw yellow selection box (if active)
5. Draw playhead

**Selection Box Rendering:**
```javascript
// Lines 433-443 in waveform-renderer.js
ctx.fillStyle = 'rgba(255, 255, 0, 0.2)';  // Yellow fill, 20% opacity
ctx.fillRect(startX, 0, selectionWidth, height);  // Single fillRect call

ctx.strokeStyle = 'rgba(255, 200, 0, 0.8)';  // Yellow-orange border, 80% opacity
ctx.lineWidth = 2;
ctx.beginPath();
ctx.moveTo(startX, 0);  // Left edge
ctx.lineTo(startX, height);
ctx.moveTo(endX, 0);  // Right edge
ctx.lineTo(endX, height);
ctx.stroke();
```

**Visual Properties:**
- **Fill**: `rgba(255, 255, 0, 0.2)` - Pure yellow, 20% opacity
- **Border**: `rgba(255, 200, 0, 0.8)` - Yellow-orange, 80% opacity, 2px wide
- **Shape**: Full-height vertical bars at start/end, filled rectangle
- **Blur**: None - hard edges

---

### Spectrogram Orange Boxes

#### A) Yellow Selection Box (Transient - During Drag)

**Primary Drawing Function:** `drawSpectrogramWithSelection()` (lines 37-145)

**Drawing Steps:**
1. Match spectrogram canvas dimensions
2. Clear overlay canvas ONLY (main spectrogram untouched)
3. Draw yellow selection box (if active)

**Selection Box Rendering:**
```javascript
// Lines 113-132 in spectrogram-renderer.js
// EXACTLY SAME AS WAVEFORM (copied pattern)
ctx.fillStyle = 'rgba(255, 255, 0, 0.2)';  // Yellow fill, 20% opacity
ctx.fillRect(left, top, boxWidth, boxHeight);

ctx.strokeStyle = 'rgba(255, 200, 0, 0.8)';  // Yellow-orange border, 80% opacity
ctx.lineWidth = 2;
ctx.beginPath();
ctx.moveTo(left, top);  // Left edge
ctx.lineTo(left, bottom);
ctx.moveTo(right, top);  // Right edge
ctx.lineTo(right, bottom);
ctx.moveTo(left, top);  // Top edge
ctx.lineTo(right, top);
ctx.moveTo(left, bottom);  // Bottom edge
ctx.lineTo(right, bottom);
ctx.stroke();
```

**Visual Properties:**
- **Fill**: `rgba(255, 255, 0, 0.2)` - Pure yellow, 20% opacity (SAME AS WAVEFORM)
- **Border**: `rgba(255, 200, 0, 0.8)` - Yellow-orange, 80% opacity, 2px wide (SAME AS WAVEFORM)
- **Shape**: Rectangle with all 4 edges drawn
- **Blur**: None - hard edges

#### B) Orange Persistent Boxes (After Selection Complete)

**Primary Function:** `addFeatureBox()` + `updateAllFeatureBoxPositions()` (spectrogram-feature-boxes.js)

**Box Creation:**
```javascript
// Lines 42-88 in spectrogram-feature-boxes.js
const box = document.createElement('div');
box.style.position = 'absolute';
box.style.border = '2px solid rgba(255, 140, 0, 0.8)';  // ORANGE border
box.style.background = 'rgba(255, 140, 0, 0.15)';  // ORANGE fill (darker than yellow)
box.style.pointerEvents = 'none';  // Click-through
box.style.zIndex = '100';

// Add number label
const label = document.createElement('div');
label.className = 'feature-number-label';
label.textContent = featureIndex + 1;
label.style.position = 'absolute';
label.style.top = '2px';
label.style.left = '4px';
label.style.color = '#ff4444';  // Red text
label.style.fontSize = '12px';
label.style.fontWeight = 'bold';
label.style.fontFamily = 'monospace';
label.style.backgroundColor = 'rgba(255, 255, 255, 0.8)';  // White background
label.style.padding = '1px 4px';
label.style.borderRadius = '2px';
label.style.pointerEvents = 'none';
label.style.zIndex = '101';
box.appendChild(label);
```

**Visual Properties:**
- **Fill**: `rgba(255, 140, 0, 0.15)` - Dark orange, 15% opacity (DARKER than yellow)
- **Border**: `rgba(255, 140, 0, 0.8)` - Dark orange, 80% opacity, 2px solid
- **Shape**: Full rectangle (4 edges)
- **Blur**: CSS blur possible via browser rendering
- **Label**: White background with red number in upper-left corner
- **Click-through**: `pointerEvents: 'none'` - doesn't block mouse events

---

## 3. COORDINATE SYSTEMS

### Waveform Yellow Highlight

**Coordinate Storage:**
```javascript
// Lines 398-412 in waveform-renderer.js
// Stored in STATE (TIME coordinates only)
State.selectionStart  // Audio time in seconds (e.g., 45.2)
State.selectionEnd    // Audio time in seconds (e.g., 48.7)
```

**Coordinate Conversion:**
```javascript
// Lines 400-412 - Zoom-aware conversion
if (zoomState.isInitialized()) {
    const startSample = zoomState.timeToSample(State.selectionStart);
    const endSample = zoomState.timeToSample(State.selectionEnd);
    startX = zoomState.sampleToPixel(startSample, width);  // Device pixels
    endX = zoomState.sampleToPixel(endSample, width);
} else {
    // Fallback
    const startProgress = State.selectionStart / State.totalAudioDuration;
    const endProgress = State.selectionEnd / State.totalAudioDuration;
    startX = startProgress * width;  // Device pixels
    endX = endProgress * width;
}
```

**Pixel Space:**
- **Input**: CSS pixels from mouse events (e.g., `e.clientX - rect.left`)
- **Storage**: Audio time in seconds
- **Rendering**: Device pixels (canvas.width/height)
- **DPR Handling**: Automatic via canvas.width/height

---

### Spectrogram Orange Boxes

**Coordinate Storage (Dual System):**

**A) Yellow Selection Box (Transient):**
```javascript
// Lines 17-22 in spectrogram-renderer.js
// Stored in MODULE VARIABLES (CSS pixels)
let spectrogramStartX = null;  // CSS pixels
let spectrogramStartY = null;  // CSS pixels
let spectrogramEndX = null;    // CSS pixels
let spectrogramEndY = null;    // CSS pixels
```

**B) Orange Persistent Boxes:**
```javascript
// Stored in REGION DATA (ETERNAL coordinates - frequencies + timestamps)
region.features[i] = {
    lowFreq: 12.5,      // Hz (eternal)
    highFreq: 18.3,     // Hz (eternal)
    startTime: "2023-05-15T10:30:45.000Z",  // ISO timestamp (eternal)
    endTime: "2023-05-15T10:31:12.000Z"     // ISO timestamp (eternal)
};
```

**Coordinate Conversion (Orange Boxes):**
```javascript
// Lines 155-214 in spectrogram-feature-boxes.js
// Y (Frequency) → CSS Pixels
const lowFreqY = getYFromFrequency(lowFreq, MAX_FREQUENCY, canvas.offsetHeight, State.frequencyScale);
const highFreqY = getYFromFrequency(highFreq, MAX_FREQUENCY, canvas.offsetHeight, State.frequencyScale);

// X (Time) → CSS Pixels
const startTimestamp = new Date(feature.startTime);
const endTimestamp = new Date(feature.endTime);

// Zoom-aware calculation
if (zoomState.isInRegion()) {
    const regionRange = zoomState.getRegionRange();
    displayStartMs = zoomState.sampleToRealTimestamp(regionRange.startSample).getTime();
    displayEndMs = zoomState.sampleToRealTimestamp(regionRange.endSample).getTime();
} else {
    displayStartMs = State.dataStartTime.getTime();
    displayEndMs = State.dataEndTime.getTime();
}

const startProgress = (startMs - displayStartMs) / displaySpanMs;
const endProgress = (endMs - displayStartMs) / displaySpanMs;

startX = startProgress * canvas.offsetWidth;  // CSS pixels
endX = endProgress * canvas.offsetWidth;      // CSS pixels
```

**Pixel Space:**
- **Input**: CSS pixels from mouse events
- **Storage (Selection)**: CSS pixels (temporary)
- **Storage (Feature)**: Eternal coordinates (frequencies in Hz + ISO timestamps)
- **Rendering**: CSS pixels (DOM positioning)
- **DPR Handling**: Manual conversion when drawing on overlay canvas

---

## 4. PERSISTENCE & STATE MANAGEMENT

### Waveform Yellow Highlight

**State Variables:**
```javascript
// In audio-state.js
State.selectionStart = null;  // Audio time (seconds)
State.selectionEnd = null;    // Audio time (seconds)
State.isSelecting = false;    // Boolean - currently dragging?
State.isDragging = false;     // Boolean - mouse button down?
State.selectionStartX = null; // CSS pixels - drag start position
```

**Persistence Strategy:**
- Selection box **redraws on every frame** from time coordinates
- No separate "completed selection" flag
- Cleared by setting `selectionStart/End = null`
- Survives zoom changes (recalculated from time coordinates)
- **Does NOT persist** after creating a region (selection cleared)

**Cleanup:**
```javascript
// Lines 941-946 - Simple null assignment
State.setSelectionStart(null);
State.setSelectionEnd(null);
State.setSelectionStartX(null);
updateWorkletSelection();
hideAddRegionButton();
```

---

### Spectrogram Orange Boxes

**State Variables (TWO separate systems):**

**A) Yellow Selection Box (Transient):**
```javascript
// Lines 15-22 in spectrogram-renderer.js
let spectrogramSelectionActive = false;      // Currently dragging?
let spectrogramSelectionComplete = false;    // Drag finished but box still visible?
let spectrogramStartX = null;                // CSS pixels
let spectrogramStartY = null;                // CSS pixels
let spectrogramEndX = null;                  // CSS pixels
let spectrogramEndY = null;                  // CSS pixels
let currentSelectionTarget = null;           // Which region/feature?
```

**B) Orange Persistent Boxes:**
```javascript
// Lines 12 in spectrogram-feature-boxes.js
const featureBoxes = new Map();  // Map<"regionIndex-featureIndex", HTMLElement>
```

**Persistence Strategy:**

**Yellow Selection Box:**
- **PERSISTS** after mouseup via `spectrogramSelectionComplete = true` flag
- Stays visible until next selection starts
- Cleared on browser focus loss via blur handlers
- Does NOT survive zoom changes (cleared)

**Orange Persistent Boxes:**
- **PERMANENTLY STORED** as DOM elements in `featureBoxes` Map
- Survives zoom changes (repositioned via `updateAllFeatureBoxPositions()`)
- Survives frequency scale changes (repositioned)
- Only removed when feature deleted or region deleted
- **Stored with eternal coordinates** in region data structure

**Cleanup (Yellow Selection):**
```javascript
// Lines 948-987 in spectrogram-renderer.js
function cancelSpectrogramSelection() {
    if (spectrogramSelectionTimeout) {
        clearTimeout(spectrogramSelectionTimeout);
        spectrogramSelectionTimeout = null;
    }
    
    spectrogramSelectionActive = false;
    spectrogramSelectionComplete = false;  // Clear persistence flag
    spectrogramStartX = null;
    spectrogramStartY = null;
    spectrogramEndX = null;
    spectrogramEndY = null;
    currentSelectionTarget = null;
    
    // Clear overlay canvas
    const selectionCanvas = document.getElementById('spectrogram-selection');
    if (selectionCanvas) {
        const ctx = selectionCanvas.getContext('2d');
        ctx.clearRect(0, 0, selectionCanvas.width, selectionCanvas.height);
    }
}
```

**Cleanup (Orange Boxes):**
```javascript
// Lines 347-357 in spectrogram-feature-boxes.js
export function clearAllFeatureBoxes() {
    featureBoxes.forEach(box => {
        if (box.parentNode) {
            box.remove();  // Remove from DOM
        }
    });
    featureBoxes.clear();  // Clear Map
}
```

---

## 5. BLUR / FOCUS BEHAVIOR

### Waveform Yellow Highlight

**Blur/Focus Handlers:** ❌ **NONE**

**Behavior:**
- No special handling for browser focus loss
- Selection box persists if browser loses focus
- No visibility change handlers
- Mouse events handled normally regardless of focus state
- **Relies on mouse events completing naturally**

**Code:** No blur/focus handlers found in waveform-renderer.js

---

### Spectrogram Orange Boxes

**Blur/Focus Handlers:** ❌ **REMOVED (November 2025)**

**Previous Behavior (BUGGY):**
Previously had extensive blur/focus/visibility handlers that attempted to clean up state on focus loss. These were **removed** because they corrupted the drawing state and made selections unreliable.

**Old Code (REMOVED):**

**Handler Setup:**
```javascript
// Lines 877-936 in spectrogram-renderer.js
spectrogramFocusBlurHandler = () => {
    const hasFocus = document.hasFocus();
    const isVisible = document.visibilityState === 'visible';
    
    console.log('👁️ Focus/visibility change:', {
        hasFocus,
        isVisible,
        spectrogramSelectionActive,
        spectrogramSelectionComplete,
        startX: spectrogramStartX,
        startY: spectrogramStartY,
        endX: spectrogramEndX,
        endY: spectrogramEndY
    });
    
    // FORCE CLEANUP when browser loses focus
    if (!hasFocus || !isVisible) {
        if (spectrogramSelectionActive) {
            console.log('⚠️ Losing focus - canceling active selection');
            cancelSpectrogramSelection();
        }
        // Also clear completed selections on blur
        if (spectrogramSelectionComplete) {
            console.log('⚠️ Losing focus - clearing completed selection');
            spectrogramSelectionComplete = false;
            spectrogramStartX = null;
            spectrogramStartY = null;
            spectrogramEndX = null;
            spectrogramEndY = null;
            // Clear overlay canvas
            const selectionCanvas = document.getElementById('spectrogram-selection');
            if (selectionCanvas) {
                const ctx = selectionCanvas.getContext('2d');
                ctx.clearRect(0, 0, selectionCanvas.width, selectionCanvas.height);
            }
        }
    } else {
        // When focus returns, reset stale coordinates
        if (!spectrogramSelectionActive && !spectrogramSelectionComplete && 
            (spectrogramStartX !== null || spectrogramEndX !== null)) {
            console.log('⚠️ Stale coordinates detected - resetting');
            spectrogramStartX = null;
            spectrogramStartY = null;
            spectrogramEndX = null;
            spectrogramEndY = null;
            currentSelectionTarget = null;
        }
    }
};

// Register handlers
window.addEventListener('focus', spectrogramFocusBlurHandler);
window.addEventListener('blur', spectrogramFocusBlurHandler);
document.addEventListener('visibilitychange', spectrogramFocusBlurHandler);
```

**Behavior:**
- **On Blur**: Immediately cancels active selections and clears completed selections
- **On Focus Return**: Resets stale coordinates if selection not active
- **Visibility Change**: Also triggers same cleanup
- **Safety Timeout**: 5-second timeout to auto-cancel if mouseup never fires (lines 720-729)

**Why This Exists:**
- Comment on line 897: "FORCE CLEANUP when browser loses focus - This prevents stuck state when mouseup events are lost"
- Prevents yellow selection boxes from getting stuck on screen
- Orange persistent boxes (DOM elements) are NOT affected by blur handlers - they stay visible

---

## 6. MOUSE EVENT HANDLING

### Waveform Yellow Highlight

**Event Listeners:**
```javascript
// Lines 562-1025 in waveform-renderer.js
canvas.addEventListener('mousedown', (e) => { ... });
canvas.addEventListener('mousemove', (e) => { ... });
canvas.addEventListener('mouseup', (e) => { ... });
canvas.addEventListener('mouseleave', () => { ... });
canvas.addEventListener('mouseenter', () => { ... });
```

**All listeners attached to canvas element directly**

**Mousedown Flow:**
1. Check if waveform clicks disabled (tutorial mode)
2. Check if clicked on region button
3. If not a button, start selection/drag
4. Set `isDragging = true`, `selectionStartX = startX`
5. Show scrub preview immediately

**Mousemove Flow:**
1. Check if `isDragging` and `selectionStartX !== null`
2. If dragged > 3 pixels, set `isSelecting = true`
3. Calculate selection start/end from pixels → time
4. Call `drawWaveformWithSelection()`

**Mouseup Flow:**
1. Check if clicked on region button (early return if yes)
2. If `isSelecting`, finalize selection (show "Add Region" button)
3. If simple click, perform seek
4. Reset `isDragging = false`, `isSelecting = false`

**Mouseleave Flow:**
- Complete selection if drag was in progress
- Perform seek if simple click

---

### Spectrogram Orange Boxes

**Event Listeners:**
```javascript
// Lines 618-937 in spectrogram-renderer.js
canvas.addEventListener('mousedown', (e) => { ... });
canvas.addEventListener('mousemove', (e) => { ... });
canvas.addEventListener('mouseup', spectrogramMouseUpHandler);  // Stored reference
canvas.addEventListener('mouseleave', async (e) => { ... });
document.addEventListener('keydown', spectrogramKeyDownHandler);  // Stored reference
window.addEventListener('focus', spectrogramFocusBlurHandler);  // Stored reference
window.addEventListener('blur', spectrogramFocusBlurHandler);   // Stored reference
document.addEventListener('visibilitychange', spectrogramFocusBlurHandler);  // Stored reference
```

**Mixed targets: canvas + document + window**

**Mousedown Flow:**
1. Check if already dragging (return if yes - prevent duplicate starts)
2. Check if zoomed into region (block if not)
3. Check if active region exists (block if not)
4. Check if region has features (block if not)
5. Find target feature index
6. Clear previous completed selection
7. Set `spectrogramSelectionActive = true`
8. **Start 5-second safety timeout** (auto-cancel if mouseup never fires)
9. **DON'T create box yet** - wait for drag

**Mousemove Flow:**
1. Check if `spectrogramSelectionActive`
2. **Require minimum drag distance (5 pixels)** before showing box
3. Log "Selection drag detected" on first drag
4. Update `spectrogramEndX/Y`
5. Call `drawSpectrogramWithSelection()`

**Mouseup Flow:**
1. Check if `spectrogramSelectionActive`
2. If no drag happened (endX/Y null), cancel and return
3. Call `handleSpectrogramSelection()` to create feature
4. Clear safety timeout
5. Set `spectrogramSelectionActive = false`, `spectrogramSelectionComplete = true`
6. **KEEP coordinates** (don't null them out)

**Mouseleave Flow:**
1. Check if `spectrogramSelectionActive`
2. If drag happened (endX/Y not null), **complete selection** (like mouseup)
3. If no drag, cancel selection
4. Async handler (calls `await handleSpectrogramSelection()`)

**Escape Key:**
- Cancels selection if active

---

## 7. REDRAW / UPDATE TRIGGERS

### Waveform Yellow Highlight

**When is `drawWaveformWithSelection()` called?**

1. **Worker message** - When waveform data ready (line 1134)
2. **Playback indicator loop** - Every animation frame during playback (line 1094)
3. **Selection drag** - During mousemove when dragging (line 675)
4. **Selection complete** - On mouseup after drag (line 927)
5. **Zoom to region** - After zoom change (in region-tracker.js)
6. **Frequency scale change** - After scale transition (in spectrogram-renderer.js line 934)

**Frequency:** Very high - potentially 60+ times per second during playback

**Optimization:**
- Uses cached canvas (`State.cachedWaveformCanvas`)
- Only redraws selection overlay, not full waveform
- Selection coordinates recalculated from time each frame

---

### Spectrogram Orange Boxes

**When is `drawSpectrogramWithSelection()` called?** (Yellow selection box)

1. **Selection drag** - During mousemove when dragging (line 765)
2. **Selection complete** - On mouseup after drag (line 860)
3. **Mouseleave** - If drag happened (line 812)

**Frequency:** Low - only during active selection drag

**When is `updateAllFeatureBoxPositions()` called?** (Orange persistent boxes)

1. **Zoom change** - After zoom transition (in zoom-state.js)
2. **Frequency scale change** - After scale transition (in spectrogram-renderer.js)
3. **Window resize** - After canvas resize (in main.js)
4. **Feature added** - After selection complete (in region-tracker.js)
5. **Region restored** - When loading saved regions (in region-tracker.js)

**Frequency:** Very low - only on major view changes

**Optimization:**
- Orange boxes are DOM elements - browser handles rendering
- Only repositioned when view changes (zoom/scale/resize)
- No per-frame updates needed
- Eternal coordinate system means boxes always know their position

---

## 8. VISUAL STYLING COMPARISON

### Waveform Yellow Highlight

| Property | Value | Notes |
|----------|-------|-------|
| Fill Color | `rgba(255, 255, 0, 0.2)` | Pure yellow, 20% opacity |
| Border Color | `rgba(255, 200, 0, 0.8)` | Yellow-orange, 80% opacity |
| Border Width | `2px` | Canvas lineWidth |
| Border Style | Vertical lines at edges | Only left/right edges drawn |
| Shape | Full-height rectangle | Top to bottom of canvas |
| Label | None | No numbering |
| Click-through | N/A | Canvas handles clicks |
| Z-index | N/A | Canvas layer order |
| Blur/Shadow | None | Hard edges |

---

### Spectrogram Yellow Selection (During Drag)

| Property | Value | Notes |
|----------|-------|-------|
| Fill Color | `rgba(255, 255, 0, 0.2)` | **SAME AS WAVEFORM** |
| Border Color | `rgba(255, 200, 0, 0.8)` | **SAME AS WAVEFORM** |
| Border Width | `2px` | Canvas lineWidth |
| Border Style | All 4 edges | Full rectangle |
| Shape | Bounded rectangle | Top/bottom match frequency range |
| Label | None | No numbering (yet) |
| Click-through | N/A | Overlay canvas, events pass to main |
| Z-index | Overlay canvas | Above spectrogram, below controls |
| Blur/Shadow | None | Hard edges |

---

### Spectrogram Orange Persistent Boxes

| Property | Value | Notes |
|----------|-------|-------|
| Fill Color | `rgba(255, 140, 0, 0.15)` | **DARK ORANGE, 15% opacity** |
| Border Color | `rgba(255, 140, 0, 0.8)` | **DARK ORANGE, 80% opacity** |
| Border Width | `2px` | CSS border |
| Border Style | `solid` | All 4 edges |
| Shape | Bounded rectangle | Top/bottom match frequency range |
| Label | **Red number on white** | `#ff4444` text, white background |
| Click-through | **Yes** | `pointerEvents: 'none'` |
| Z-index | `100` | Above spectrogram |
| Blur/Shadow | **Possible** | CSS can add blur/shadow |
| Label Z-index | `101` | Above box |

**Label Styling:**
```css
.feature-number-label {
    position: absolute;
    top: 2px;
    left: 4px;
    color: #ff4444;               /* Red text */
    font-size: 12px;
    font-weight: bold;
    font-family: monospace;
    background-color: rgba(255, 255, 255, 0.8);  /* White semi-transparent */
    padding: 1px 4px;
    border-radius: 2px;
    pointer-events: none;
    z-index: 101;
}
```

---

## 9. BEHAVIOR WHEN LOSING/REGAINING FOCUS

### Waveform Yellow Highlight

**On Blur (Browser Loses Focus):**
- ❌ No special handling
- Selection box stays visible (if canvas is still rendering)
- Mouse events may be missed if user clicks outside browser
- **Risk:** If user drags outside browser and releases, `mouseup` may be missed
  - But: `mouseleave` handler will complete the selection (lines 983-1018)
  - Fallback: Selection will persist in inconsistent state

**On Focus (Browser Gains Focus):**
- ❌ No special handling
- Selection box remains as-is
- No state validation or cleanup

**Overall Risk:** Low - `mouseleave` handler provides fallback

---

### Spectrogram Orange Boxes

**On Blur (Browser Loses Focus):**

**Yellow Selection Box:**
```javascript
// Lines 897-916 in spectrogram-renderer.js
if (!hasFocus || !isVisible) {
    if (spectrogramSelectionActive) {
        console.log('⚠️ Losing focus - canceling active selection');
        cancelSpectrogramSelection();  // ← Immediately cancel
    }
    if (spectrogramSelectionComplete) {
        console.log('⚠️ Losing focus - clearing completed selection');
        spectrogramSelectionComplete = false;
        spectrogramStartX = null;
        spectrogramStartY = null;
        spectrogramEndX = null;
        spectrogramEndY = null;
        // Clear overlay canvas
        const selectionCanvas = document.getElementById('spectrogram-selection');
        if (selectionCanvas) {
            const ctx = selectionCanvas.getContext('2d');
            ctx.clearRect(0, 0, selectionCanvas.width, selectionCanvas.height);
        }
    }
}
```

**Current Behavior (FIXED):**
Now matches waveform pattern - **NO blur/focus handlers**!

**On Blur (Browser Loses Focus):**
- ❌ No special handling (like waveform)
- Selection box may persist visually but state is handled on next click
- **Stale state cleaned up automatically on next mousedown**

**On Focus (Browser Gains Focus):**
- ❌ No special handling (like waveform)
- Next click will clean up any stale state and start fresh immediately

**Orange Persistent Boxes:**
- ✅ **Unaffected** - Stay visible (DOM elements don't care about blur)
- ✅ **Remain interactive** (if click-through disabled)

**Safety Mechanisms:**
1. **Mousedown auto-cleanup** (line 509) - Silently cleans stale state before starting new selection
2. **5-second timeout** (line 544) - Auto-cancels if mouseup never fires
3. **Escape key cancel** (line 662) - Manual user override
4. **Minimum drag distance** (5 pixels) - Prevents accidental boxes

**Overall Risk:** Very low - Simple, reliable, proven pattern copied from waveform

---

## 10. KEY DIFFERENCES SUMMARY

| Aspect | Waveform Yellow | Spectrogram Orange |
|--------|----------------|-------------------|
| **Canvas System** | Single canvas | Triple layer (main + overlay + DOM) |
| **Drawing Method** | Direct canvas draw | Canvas overlay + DOM elements |
| **Coordinate Storage** | Time (seconds) | Eternal (Hz + timestamps) |
| **Persistence** | Redraws every frame | DOM elements stay until deleted |
| **Blur Handlers** | ❌ None | ❌ None (FIXED Nov 2025) |
| **Safety Timeouts** | ❌ None | ✅ 5-second auto-cancel |
| **Minimum Drag** | 3 pixels | 5 pixels |
| **Click-through** | N/A (canvas) | Yes (`pointerEvents: none`) |
| **Labels** | None | Red numbers on white background |
| **Color (Active)** | Yellow | Yellow (during drag) |
| **Color (Persistent)** | N/A | Orange |
| **Opacity (Fill)** | 20% | 15% (darker) |
| **Border Edges** | Left + Right only | All 4 edges |
| **Redraw Frequency** | High (60+ FPS) | Low (only on view changes) |
| **Zoom Survival** | Yes (recalculated) | Yes (repositioned) |
| **Memory Model** | State variables | Map + DOM tree |

---

## 11. IMPLICATIONS FOR BLUR BEHAVIOR

### Why Neither System Needs Blur Handlers (UPDATED Nov 2025)

**Both waveform AND spectrogram now use the same pattern: NO blur handlers!**

**The Zen Philosophy:**
1. **Trust the next click** - Mousedown handler cleans up stale state automatically
2. **Simple is reliable** - Fewer event listeners = fewer bugs
3. **No forced cleanup** - Let the natural flow handle it
4. **Safety net exists** - 5-second timeout prevents infinite stuck states (spectrogram only)

**Why This Works:**

**Waveform:**
1. **Single canvas** - No separate overlay to get out of sync
2. **Time-based coordinates** - Always recalculated from source of truth
3. **Mouseleave fallback** - Completes selection if drag exits canvas
4. **Simple state** - Only 2-3 variables to track
5. **Full redraw** - Every frame redraws from scratch, no stale state

**Spectrogram:**
1. **Mousedown auto-cleanup** - Detects and cleans stale state before starting new selection
2. **Silent recovery** - User doesn't notice cleanup happening
3. **Works first try** - No waiting, no double-clicking
4. **Safety timeout** - 5-second fallback if something goes really wrong
5. **Escape key** - Manual override if user wants to cancel

**What Changed:**
Previously, the spectrogram had blur handlers that **corrupted state** by:
- Canceling selections on focus loss
- Leaving variables in inconsistent states
- Preventing new selections from starting
- Requiring users to click twice or wait 5 seconds

**The Fix:**
Removed all blur/focus/visibility handlers and copied the waveform's proven pattern. Now the mousedown handler:
```javascript
// Clean up silently, then continue (don't return!)
if (spectrogramSelectionActive || spectrogramSelectionBox) {
    // Clear stale state
    // DON'T return - start new selection immediately!
}
```

**Result:** Both systems now "just work" regardless of focus changes! 🎉

---

## 12. CODE LOCATION REFERENCE

### Waveform Yellow Highlight
- **Main File**: `js/waveform-renderer.js`
- **Drawing Function**: `drawWaveformWithSelection()` (lines 335-481)
- **Mouse Handlers**: `setupWaveformInteraction()` (lines 483-1025)
- **State Variables**: `js/audio-state.js`
- **No blur handlers**

### Spectrogram Yellow Selection
- **Main File**: `js/spectrogram-renderer.js`
- **Drawing Function**: `drawSpectrogramWithSelection()` (lines 37-145)
- **Mouse Handlers**: `setupSpectrogramSelection()` (lines 599-942)
- **Cancel Function**: `cancelSpectrogramSelection()` (lines 948-987)
- **Blur Handler**: `spectrogramFocusBlurHandler` (lines 877-936)
- **Cleanup Function**: `cleanupSpectrogramSelection()` (lines 994-1014)

### Spectrogram Orange Boxes
- **Main File**: `js/spectrogram-feature-boxes.js`
- **Add Function**: `addFeatureBox()` (lines 42-88)
- **Update Function**: `updateAllFeatureBoxPositions()` (lines 110-274)
- **Remove Functions**: `removeFeatureBox()`, `clearAllFeatureBoxes()` (lines 93-357)
- **Storage**: `featureBoxes` Map (line 12)

---

## 13. RECOMMENDATIONS

### If Applying Waveform Pattern to Spectrogram:

**Pros:**
- Simpler state management
- No blur handlers needed
- Unified rendering path
- Automatic DPR handling
- Time-based coordinates more robust

**Cons:**
- Lose DOM flexibility (labels, click-through, CSS effects)
- Must redraw boxes every frame during playback
- Harder to manage multiple features independently
- No eternal coordinate persistence (must recalculate every zoom)

### If Applying Spectrogram Pattern to Waveform:

**Pros:**
- Persistent visual elements (DOM boxes)
- Flexible styling (CSS, labels, numbers)
- Efficient (no per-frame redraws)
- Better for complex multi-element overlays

**Cons:**
- Complex state management
- Need blur handlers
- Need safety timeouts
- Dual coordinate systems to maintain
- More potential for bugs and stale state

---

## CONCLUSION

The waveform uses a **simple, stateless, canvas-native approach** with minimal state and no blur handling. It redraws from source of truth every frame.

The spectrogram uses a **complex, stateful, hybrid approach** with multiple layers, eternal coordinates, and extensive blur handling. It optimizes for persistence and flexibility at the cost of complexity.

**The blur handler difference exists because:**
- Waveform has no persistent visual state to get out of sync
- Spectrogram has persistent overlay canvas + DOM elements that can show stale selections
- Waveform's mouseleave is sufficient fallback
- Spectrogram's document-level mouseup can be missed during focus changes

