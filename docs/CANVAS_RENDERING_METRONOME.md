# The Canvas Rendering Metronome: Waveform vs Spectrogram

## 🎯 Overview

Both canvases use **RequestAnimationFrame (RAF)** loops for rendering, but they operate at different frequencies and have different responsibilities. This document explains the "metronome" - the timing and rendering architecture.

---

## 📊 Waveform Canvas Rendering Loop

### Function: `updatePlaybackIndicator()`
**Location**: `js/waveform-renderer.js` (lines 1001-1060)

### Timing & Frequency

| Aspect | Details |
|--------|---------|
| **Update Rate** | ~60 FPS (browser refresh rate) |
| **When Active** | Only when `PlaybackState.PLAYING` |
| **When Inactive** | Stops completely when paused/stopped |
| **RAF Loop** | `requestAnimationFrame(updatePlaybackIndicator)` |

### Loop Behavior

```javascript
updatePlaybackIndicator() {
    // 1. Clear RAF ID immediately (prevents duplicates)
    State.setPlaybackIndicatorRAF(null);
    
    // 2. Early exit checks:
    if (isDragging) {
        // Schedule next frame but don't render (keeps loop alive)
        State.setPlaybackIndicatorRAF(requestAnimationFrame(updatePlaybackIndicator));
        return;
    }
    
    if (playbackState !== PLAYING) {
        // Stop loop completely
        return;
    }
    
    // 3. Render waveform + playhead
    drawWaveformWithSelection();  // Redraws entire waveform
    drawSpectrogramPlayhead();    // Updates spectrogram playhead
    
    // 4. Schedule next frame
    State.setPlaybackIndicatorRAF(requestAnimationFrame(updatePlaybackIndicator));
}
```

### What Gets Rendered Each Frame

1. **Cached Waveform Canvas** - Blitted from `State.cachedWaveformCanvas`
2. **Region Highlights** - Blue rectangles (via `drawRegionHighlights()`)
3. **Region Buttons** - Zoom/Play buttons overlay (via `drawRegionButtons()`)
4. **Yellow Selection Box** - If time selection exists
5. **Red Playhead** - Vertical line showing current playback position

### Performance Characteristics

- **Rendering Method**: Canvas blitting (fast) - draws cached waveform, then overlays
- **Redraw Frequency**: Every frame (~16.67ms at 60fps)
- **CPU Usage**: Low (mostly canvas operations, no heavy computation)
- **Memory**: Uses cached canvas (no recalculation per frame)

---

## 📊 Spectrogram Canvas Rendering Loop

### Function: `drawSpectrogram()`
**Location**: `js/spectrogram-renderer.js` (lines 33-136)

### Timing & Frequency

| Aspect | Details |
|--------|---------|
| **Update Rate** | ~60 FPS (browser refresh rate) |
| **When Active** | Only when `PlaybackState.PLAYING` |
| **When Inactive** | Keeps looping (checks for play state) |
| **RAF Loop** | `requestAnimationFrame(drawSpectrogram)` |

### Loop Behavior

```javascript
drawSpectrogram() {
    // 1. Clear RAF ID immediately (prevents duplicates)
    State.setSpectrogramRAF(null);
    
    // 2. Early exit checks:
    if (!analyserNode) return;  // Stop if no audio
    
    if (playbackState !== PLAYING) {
        // Keep looping to check for play state
        State.setSpectrogramRAF(requestAnimationFrame(drawSpectrogram));
        return;
    }
    
    // 3. Scroll existing spectrogram left by 1px
    ctx.drawImage(canvas, -1, 0);  // Shift left
    ctx.clearRect(width - 1, 0, 1, height);  // Clear right edge
    
    // 4. Draw new column from analyserNode
    analyserNode.getByteFrequencyData(dataArray);
    // Draw frequency bins as vertical bars
    
    // 5. Schedule next frame
    State.setSpectrogramRAF(requestAnimationFrame(drawSpectrogram));
}
```

### What Gets Rendered Each Frame

1. **Scroll Existing Content** - Shifts entire canvas 1px left
2. **New Frequency Column** - Draws new column from `analyserNode` on right edge
3. **Frequency Scale** - Handled by separate axis canvas (not in this loop)

### Performance Characteristics

- **Rendering Method**: Canvas scrolling + new column drawing
- **Redraw Frequency**: Every frame (~16.67ms at 60fps)
- **CPU Usage**: Medium (FFT data from analyserNode, canvas operations)
- **Memory**: Constant (no accumulation, just scrolling)

---

## 🖱️ Mouse Event Timing

### Event Handler Registration

Both canvases register event listeners **once** during setup:

| Canvas | Setup Function | When Called |
|--------|---------------|-------------|
| **Waveform** | `setupWaveformInteraction()` | Called from `main.js` after DOM ready |
| **Spectrogram** | `setupSpectrogramSelection()` | Called from `main.js` after DOM ready |

### Event Firing Frequency

| Event | Frequency | Notes |
|-------|-----------|-------|
| **mousedown** | On click | Immediate, synchronous |
| **mousemove** | ~60-120 events/sec | Browser-dependent, fires continuously during drag |
| **mouseup** | On release | Immediate, synchronous |
| **mouseleave** | On exit | Immediate, synchronous |

### Waveform Mouse Events

**mousedown**:
- Fires immediately on click
- Sets `State.isDragging = true`
- Stores `State.selectionStartX`
- Updates cursor to `grabbing`

**mousemove**:
- Fires continuously during drag (~60-120 Hz)
- Detects drag distance > 3px → sets `State.isSelecting = true`
- Updates scrub preview (red line) OR selection box
- Calls `drawWaveformWithSelection()` on every move (if selecting)

**mouseup**:
- Fires immediately on release
- Completes selection or performs seek
- Calls `drawWaveformWithSelection()` once
- Resets dragging state

### Spectrogram Mouse Events

**mousedown**:
- Fires immediately on click
- Sets `spectrogramSelectionActive = true`
- Stores `spectrogramStartX`, `spectrogramStartY`
- Determines target region/feature

**mousemove**:
- Fires continuously during drag (~60-120 Hz)
- Detects drag distance > 5px → creates selection box DOM element
- Updates box position/size on every move
- **No canvas redraw** - just DOM manipulation

**mouseup**:
- Fires immediately on release
- Completes selection via `handleSpectrogramSelection()`
- Converts box to persistent feature box
- Resets selection state

---

## 🔄 Interaction Between Loops

### During Playback

```
Time →
│
├─ Waveform RAF Loop (60fps)
│  ├─ Frame 1: drawWaveformWithSelection() + drawSpectrogramPlayhead()
│  ├─ Frame 2: drawWaveformWithSelection() + drawSpectrogramPlayhead()
│  └─ Frame 3: drawWaveformWithSelection() + drawSpectrogramPlayhead()
│
├─ Spectrogram RAF Loop (60fps)
│  ├─ Frame 1: Scroll + draw new column
│  ├─ Frame 2: Scroll + draw new column
│  └─ Frame 3: Scroll + draw new column
│
└─ Mouse Events (asynchronous)
   ├─ mousedown (immediate)
   ├─ mousemove (continuous, ~60-120Hz)
   └─ mouseup (immediate)
```

### Key Interactions

1. **Waveform RAF → Spectrogram Playhead**
   - `updatePlaybackIndicator()` calls `drawSpectrogramPlayhead()` every frame
   - Updates spectrogram playhead position without affecting spectrogram RAF loop

2. **Mouse Events → Canvas Redraws**
   - Waveform: `mousemove` calls `drawWaveformWithSelection()` directly (synchronous)
   - Spectrogram: `mousemove` updates DOM box (no canvas redraw needed)

3. **No Direct Coupling**
   - Loops are independent - waveform RAF doesn't trigger spectrogram RAF
   - Both check `State.playbackState` independently
   - Both can run simultaneously without interference

---

## ⏱️ Timing Breakdown

### Waveform Rendering Cycle

| Phase | Duration | What Happens |
|-------|----------|--------------|
| **RAF Callback** | ~16.67ms | Browser schedules next frame |
| **Early Exit Check** | <0.1ms | Check dragging/playback state |
| **Canvas Blit** | ~1-2ms | Draw cached waveform |
| **Overlay Drawing** | ~2-3ms | Regions, selection, playhead |
| **Total per Frame** | ~3-5ms | Leaves ~11ms idle time |

### Spectrogram Rendering Cycle

| Phase | Duration | What Happens |
|-------|----------|--------------|
| **RAF Callback** | ~16.67ms | Browser schedules next frame |
| **Early Exit Check** | <0.1ms | Check analyser/playback state |
| **Canvas Scroll** | ~0.5ms | Shift canvas 1px left |
| **FFT Data Read** | ~0.5ms | `analyserNode.getByteFrequencyData()` |
| **Column Drawing** | ~1-2ms | Draw frequency bins as bars |
| **Total per Frame** | ~2-3ms | Leaves ~13ms idle time |

### Mouse Event Timing

| Event | Latency | Blocking? |
|-------|---------|-----------|
| **mousedown** | <1ms | Synchronous, blocks briefly |
| **mousemove** | <1ms per event | Non-blocking, fires ~60-120Hz |
| **mouseup** | <1ms | Synchronous, blocks briefly |

---

## 🎨 Rendering Triggers

### Waveform Canvas Redraws When:

1. **RAF Loop** (60fps during playback)
   - `updatePlaybackIndicator()` → `drawWaveformWithSelection()`

2. **Mouse Move** (during drag, ~60-120Hz)
   - `mousemove` → `updateScrubPreview()` OR selection update
   - Calls `drawWaveformWithSelection()` directly

3. **Mouse Up** (on release)
   - `mouseup` → `drawWaveformWithSelection()` once

4. **Manual Calls** (various triggers)
   - Zoom transitions
   - Region changes
   - Selection changes
   - Filter changes

### Spectrogram Canvas Redraws When:

1. **RAF Loop** (60fps during playback)
   - `drawSpectrogram()` → scrolls + draws new column

2. **Viewport Updates** (on zoom/pan/playback rate change)
   - `updateSpectrogramViewport()` → stretches cached spectrogram

3. **Complete Render** (on data load/zoom change)
   - `renderCompleteSpectrogram()` → FFT computation + rendering

4. **Playhead Updates** (60fps during playback)
   - `drawSpectrogramPlayhead()` → draws red line (called from waveform RAF)

---

## 🔍 Key Differences

### Waveform

| Characteristic | Details |
|----------------|---------|
| **RAF Frequency** | 60fps (only when playing) |
| **Rendering Method** | Canvas blitting (cached) |
| **Mouse Redraws** | Yes - redraws on every mousemove during drag |
| **Playhead Updates** | Every frame (60fps) |
| **Stops When** | Paused or stopped (loop exits completely) |

### Spectrogram

| Characteristic | Details |
|----------------|---------|
| **RAF Frequency** | 60fps (checks even when paused) |
| **Rendering Method** | Canvas scrolling + new column |
| **Mouse Redraws** | No - uses DOM elements (no canvas redraw) |
| **Playhead Updates** | Every frame (60fps, called from waveform RAF) |
| **Stops When** | No analyserNode (but keeps checking) |

---

## 🎯 Summary: The Metronome

### Waveform Metronome
- **Tick Rate**: 60 BPM (beats per minute = frames per second)
- **Active**: Only during playback
- **Duty**: Render waveform + playhead + overlays
- **Mouse Response**: Immediate redraw on drag

### Spectrogram Metronome
- **Tick Rate**: 60 BPM (frames per second)
- **Active**: Always checking, rendering only during playback
- **Duty**: Scroll + draw new frequency column
- **Mouse Response**: DOM manipulation (no canvas redraw)

### Synchronization
- Both run at ~60fps but are **independent loops**
- Waveform RAF calls `drawSpectrogramPlayhead()` to sync playhead
- No direct coupling - both check `State.playbackState` independently
- Mouse events fire asynchronously and can interrupt either loop

---

## 🐛 Performance Considerations

### Waveform Optimizations

1. **Cached Canvas**: Blits pre-rendered waveform (fast)
2. **Early Exit**: Skips rendering when dragging (keeps loop alive)
3. **Single RAF**: Prevents duplicate loops with ID tracking

### Spectrogram Optimizations

1. **Canvas Scrolling**: Shifts existing content (fast)
2. **Single Column**: Only draws new column per frame (minimal work)
3. **AnalyserNode**: Uses Web Audio API FFT (hardware-accelerated)

### Memory Management

- **RAF IDs**: Tracked and cancelled to prevent leaks
- **Document Check**: Verifies document is connected before scheduling
- **Closure Prevention**: Copies State values to local variables immediately

---

## 📝 Event Flow Example

### User Clicks and Drags on Waveform

```
t=0ms:    mousedown fires
          → Sets isDragging = true
          → Stores selectionStartX
          
t=16ms:   mousemove fires (first move)
          → Detects drag > 3px
          → Sets isSelecting = true
          → Calls drawWaveformWithSelection()
          
t=33ms:   RAF callback (updatePlaybackIndicator)
          → Checks isDragging = true
          → Schedules next frame, returns early
          → (No rendering during drag)
          
t=50ms:   mousemove fires (continuing drag)
          → Updates selection
          → Calls drawWaveformWithSelection()
          
t=100ms:  mouseup fires
          → Completes selection
          → Calls drawWaveformWithSelection()
          → Sets isDragging = false
          
t=116ms:  RAF callback (updatePlaybackIndicator)
          → isDragging = false
          → Renders normally
```

### User Clicks and Drags on Spectrogram

```
t=0ms:    mousedown fires
          → Sets spectrogramSelectionActive = true
          → Determines target region/feature
          → Stores spectrogramStartX/Y
          
t=16ms:   mousemove fires (first move)
          → Detects drag > 5px
          → Creates DOM box element
          → Updates box position
          
t=33ms:   RAF callback (drawSpectrogram)
          → Continues scrolling spectrogram
          → (Selection box is DOM, not canvas)
          
t=50ms:   mousemove fires (continuing drag)
          → Updates DOM box position/size
          
t=100ms:  mouseup fires
          → Calls handleSpectrogramSelection()
          → Converts DOM box to persistent feature box
          → Resets selection state
```

---

## 🎼 The Complete Metronome

```
┌─────────────────────────────────────────────────────────┐
│                    BROWSER REFRESH (60Hz)                │
└─────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
    Frame 1              Frame 2              Frame 3
         │                    │                    │
    ┌────┴────┐          ┌────┴────┐          ┌────┴────┐
    │         │          │         │          │         │
    ▼         ▼          ▼         ▼          ▼         ▼
Waveform  Spectro    Waveform  Spectro    Waveform  Spectro
   RAF       RAF         RAF       RAF         RAF       RAF
    │         │          │         │          │         │
    │         │          │         │          │         │
    ▼         ▼          ▼         ▼          ▼         ▼
Render    Scroll +    Render    Scroll +    Render    Scroll +
Waveform   Draw       Waveform   Draw       Waveform   Draw
+ Playhead  Column     + Playhead  Column     + Playhead  Column
    │         │          │         │          │         │
    └─────────┴──────────┴─────────┴──────────┴─────────┘
              │
              ▼
        Mouse Events
    (asynchronous, ~60-120Hz)
              │
    ┌─────────┼─────────┐
    │         │         │
    ▼         ▼         ▼
 mousedown mousemove  mouseup
```

---

## 🔧 Key Takeaways

1. **Both use RAF**: ~60fps, browser-synchronized
2. **Independent loops**: No direct coupling between waveform and spectrogram RAF
3. **Different rendering**: Waveform blits cache, spectrogram scrolls + draws
4. **Mouse events**: Fire asynchronously, can interrupt rendering
5. **Waveform redraws on drag**: Spectrogram uses DOM (no canvas redraw)
6. **Playhead sync**: Waveform RAF updates spectrogram playhead
7. **Performance**: Both optimized for 60fps with minimal CPU usage




