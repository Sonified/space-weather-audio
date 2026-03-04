# Waveform vs Spectrogram Mouse Handler Differences

## 🖱️ Mousedown Handler Comparison

### Waveform Mousedown

```javascript
canvas.addEventListener('mousedown', (e) => {
    // CHECK 1: Has audio data?
    if (!State.completeSamplesArray || State.totalAudioDuration === 0) return;
    
    // Tutorial handling
    if (State._waveformClickResolve) { /* resolve promise */ }
    if (!State.waveformHasBeenClicked) { /* remove pulse */ }
    
    // CHECK 2: Clicks disabled?
    if (canvas.style.pointerEvents === 'none') return;
    
    // CHECK 3: Clicked on button?
    if (clickedZoomRegionIndex !== null || clickedPlayRegionIndex !== null) {
        return; // Handle button click, don't start drag
    }
    
    // ✅ START DRAG - No region/zoom requirements!
    State.setSelectionStartX(startX);
    State.setIsDragging(true);
    canvas.style.cursor = 'grabbing';
    updateScrubPreview(e);
});
```

### Spectrogram Mousedown

```javascript
canvas.addEventListener('mousedown', (e) => {
    // CHECK 1: Already selecting?
    if (spectrogramSelectionActive || spectrogramSelectionBox) {
        cancelSpectrogramSelection();
        return;
    }
    
    // CHECK 2: Must be zoomed into a region
    if (!zoomState.isInRegion()) {
        return; // ❌ BLOCKED
    }
    
    // CHECK 3: Must have an active region
    const activeRegionIndex = getActiveRegionIndex();
    if (activeRegionIndex === null) {
        return; // ❌ BLOCKED
    }
    
    // CHECK 4: Region must have features
    if (!region.features || region.features.length === 0) {
        return; // ❌ BLOCKED
    }
    
    // ✅ START SELECTION - Only after all checks pass!
    currentSelectionTarget = { regionIndex, featureIndex };
    spectrogramStartX = e.clientX - canvasRect.left;
    spectrogramSelectionActive = true;
});
```

---

## 📊 Side-by-Side Comparison

| Aspect | Waveform | Spectrogram |
|--------|----------|-------------|
| **Required Checks** | 1. Has audio data<br>2. Not disabled<br>3. Not clicking button | 1. Not already selecting<br>2. **Must be zoomed in**<br>3. **Must have active region**<br>4. **Region must have features** |
| **Zoom Requirement** | ❌ None - works anywhere | ✅ **Must be zoomed into region** |
| **Region Requirement** | ❌ None - works without regions | ✅ **Must have active region** |
| **Feature Requirement** | ❌ None | ✅ **Region must have features** |
| **What It Does** | Starts drag/selection (time-based) | Starts feature selection (frequency + time) |
| **Immediate Action** | Shows scrub preview (red line) | Stores start position (no visual yet) |
| **Cursor Change** | `grabbing` | None (no cursor change) |

---

## 🎯 Key Differences

### 1. **Prerequisites**

**Waveform:**
- ✅ Just needs audio data loaded
- ✅ Works immediately, no setup required
- ✅ Works whether zoomed in or out
- ✅ Works with or without regions

**Spectrogram:**
- ❌ **Requires zoomed into region** (`zoomState.isInRegion()`)
- ❌ **Requires active region** (`getActiveRegionIndex()`)
- ❌ **Requires region has features** (`region.features.length > 0`)

### 2. **What Happens on Click**

**Waveform:**
```javascript
// Immediately shows visual feedback
State.setSelectionStartX(startX);
State.setIsDragging(true);
canvas.style.cursor = 'grabbing';
updateScrubPreview(e);  // ← Draws red line immediately!
```

**Spectrogram:**
```javascript
// Just stores state, no visual yet
currentSelectionTarget = { regionIndex, featureIndex };
spectrogramStartX = e.clientX - canvasRect.left;
spectrogramSelectionActive = true;
// ← No visual until mousemove detects drag > 5px
```

### 3. **Visual Feedback**

**Waveform:**
- ✅ **Immediate**: Red scrub preview line appears on mousedown
- ✅ **During drag**: Line follows mouse OR yellow selection box appears
- ✅ **Cursor changes**: `pointer` → `grabbing` → `col-resize`

**Spectrogram:**
- ❌ **Delayed**: No visual until drag > 5px detected
- ✅ **During drag**: Red DOM box appears after 5px movement
- ❌ **No cursor change**: Stays default/crosshair

---

## 🖱️ Mousemove Handler Comparison

### Waveform Mousemove

```javascript
canvas.addEventListener('mousemove', (e) => {
    if (State.isDragging && State.selectionStartX !== null) {
        const dragDistance = Math.abs(currentX - State.selectionStartX);
        
        // Detect drag > 3px
        if (dragDistance > 3 && !State.isSelecting) {
            State.setIsSelecting(true);
            canvas.style.cursor = 'col-resize';
            console.log('📏 Selection drag detected');
        }
        
        if (State.isSelecting) {
            // Update selection bounds
            State.setSelectionStart(...);
            State.setSelectionEnd(...);
            
            // ✅ REDRAWS CANVAS EVERY MOVE
            drawWaveformWithSelection();  // ← Canvas redraw!
        } else {
            // Update scrub preview
            updateScrubPreview(e);  // ← Canvas redraw!
        }
    }
});
```

### Spectrogram Mousemove

```javascript
canvas.addEventListener('mousemove', (e) => {
    if (!spectrogramSelectionActive) return;
    
    // Detect drag > 5px
    if (!spectrogramSelectionBox && dragDistance < 5) {
        return; // Wait for more movement
    }
    
    if (!spectrogramSelectionBox && dragDistance >= 5) {
        // Create DOM box element
        spectrogramSelectionBox = document.createElement('div');
        container.appendChild(spectrogramSelectionBox);
    }
    
    // Update DOM box position/size
    spectrogramSelectionBox.style.left = ...;
    spectrogramSelectionBox.style.width = ...;
    // ❌ NO CANVAS REDRAW - just DOM manipulation
});
```

---

## 📊 Mousemove Differences

| Aspect | Waveform | Spectrogram |
|--------|----------|-------------|
| **Minimum Drag** | 3px | 5px |
| **Visual Creation** | Immediate on mousedown (scrub preview) | Delayed until drag > 5px |
| **Rendering Method** | ✅ **Canvas redraw** (`drawWaveformWithSelection()`) | ❌ **DOM manipulation** (no canvas redraw) |
| **Redraw Frequency** | Every mousemove (~60-120Hz) | Never (DOM updates are instant) |
| **What Gets Drawn** | Scrub preview line OR selection box | DOM element (not canvas) |
| **Performance Impact** | Medium (canvas operations) | Low (DOM style updates) |

---

## 🖱️ Mouseup Handler Comparison

### Waveform Mouseup

```javascript
canvas.addEventListener('mouseup', (e) => {
    if (State.isDragging) {
        State.setIsDragging(false);
        
        if (State.isSelecting) {
            // Complete selection
            // Update worklet, seek, etc.
        } else {
            // Simple click - perform seek
            performSeek();
        }
        
        drawWaveformWithSelection();  // Final redraw
    }
});
```

### Spectrogram Mouseup

```javascript
canvas.addEventListener('mouseup', async (e) => {
    if (!spectrogramSelectionActive) return;
    
    if (!spectrogramSelectionBox) {
        // No box = just clicked, didn't drag
        cancelSpectrogramSelection();
        return;
    }
    
    // Complete selection
    await handleSpectrogramSelection(
        ..., currentSelectionTarget.regionIndex, currentSelectionTarget.featureIndex
    );
    
    // Convert DOM box to persistent feature box
    // (Box stays, just changes color/style)
});
```

---

## 🎯 Mouseleave Handler Comparison

### Waveform Mouseleave

```javascript
canvas.addEventListener('mouseleave', () => {
    if (State.isDragging) {
        const wasSelecting = State.isSelecting;
        
        if (wasSelecting && hasSelection) {
            // ✅ COMPLETE selection
            // Seek to start, update worklet, etc.
        } else {
            // Complete seek
            performSeek();
        }
        
        drawWaveformWithSelection();
    }
});
```

### Spectrogram Mouseleave

```javascript
canvas.addEventListener('mouseleave', async (e) => {
    if (!spectrogramSelectionActive) return;
    
    if (spectrogramSelectionBox) {
        // ✅ COMPLETE selection (like waveform)
        await handleSpectrogramSelection(...);
    } else {
        // Cancel (no box = just clicked)
        cancelSpectrogramSelection();
    }
});
```

**Both now complete selection on mouseleave!** ✅

---

## 🔍 Summary: Why Waveform Works But Spectrogram Doesn't

### Waveform - Simple & Direct

```
User clicks → Check audio data → START DRAG
                                    ↓
                            Show scrub preview immediately
                                    ↓
                            Works anywhere, anytime
```

**Requirements:**
- ✅ Audio data loaded
- ❌ No zoom requirement
- ❌ No region requirement
- ❌ No feature requirement

### Spectrogram - Complex & Restricted

```
User clicks → Check 1: Zoomed in? ❌ → BLOCKED
           → Check 2: Active region? ❌ → BLOCKED  
           → Check 3: Has features? ❌ → BLOCKED
           → All pass? → START SELECTION
```

**Requirements:**
- ✅ Audio data loaded
- ✅ **Must be zoomed into region**
- ✅ **Must have active region**
- ✅ **Region must have features**

---

## 💡 The Solution

To make spectrogram work like waveform, we need to **remove or relax the requirements**:

### Option A: Remove All Requirements (Like Waveform)
```javascript
// Just check audio data, start selection
if (!State.completeSamplesArray) return;
// Start selection - figure out region/feature later
```

### Option B: Auto-Create Missing Pieces
```javascript
// If no active region, create one from current view
// If region has no features, create one
// Then proceed with selection
```

### Option C: Keep Requirements But Make Them Clearer
```javascript
// Keep current checks but add better UX
// Show helpful messages, auto-zoom if needed, etc.
```

---

## 🎯 Current State

**Waveform**: ✅ Works immediately, no setup needed

**Spectrogram**: ❌ Requires 3-step setup:
1. Create region on waveform
2. Zoom into region  
3. Ensure region has features
4. Then click/drag works

The difference is **waveform is permissive, spectrogram is restrictive**.

