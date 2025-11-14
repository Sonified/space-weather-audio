# Zoom Architecture

## Overview
This document outlines the architecture for implementing zoom functionality in the volcano-audio platform, including the unified coordinate system, zoom state management, region/feature storage, and future considerations for windowed and scrolling playback.

---

## Core Principle: Sample-Based Coordinate System

### The Single Source of Truth: **Sample Indices**

All positions, regions, and features are stored as **absolute sample indices** in the complete audio buffer. This provides:

- ✅ **Zero floating-point drift** - Integer arithmetic only
- ✅ **Perfect round-trips** - Zoom in/out/in/out = exact same positions
- ✅ **Direct buffer access** - Maps 1:1 to `completeSamplesArray[index]`
- ✅ **Trivial conversion** - One division converts to any other coordinate system

### Coordinate System Hierarchy

```
Sample Index (STORED)
    ↓
├─→ Pixel Position (DERIVED for rendering)
├─→ Audio Time (DERIVED for playback)
├─→ Real Timestamp (DERIVED for labels)
└─→ Percentage (DERIVED for UI)
```

**Key Rule**: Store samples, derive everything else at render time.

---

## Zoom State Manager

### Data Structure

```javascript
class ZoomState {
  constructor() {
    this.mode = 'full';  // 'full' | 'region'
    
    // Current viewport bounds (in samples)
    this.currentViewStartSample = 0;
    this.currentViewEndSample = totalSamples;
    
    // Reference to full dataset
    this.totalSamples = completeSamplesArray.length;  // e.g., 4,320,000
    this.sampleRate = 44100;  // Hz
    
    // Optional: which region we're viewing (if mode='region')
    this.activeRegionId = null;
  }
}
```

### Core Conversion Functions

```javascript
// Sample → Pixel for current view
sampleToPixel(sampleIndex, canvasWidth) {
  const viewRange = this.currentViewEndSample - this.currentViewStartSample;
  const relativePosition = sampleIndex - this.currentViewStartSample;
  return (relativePosition / viewRange) * canvasWidth;
}

// Pixel → Sample for current view
pixelToSample(pixelX, canvasWidth) {
  const viewRange = this.currentViewEndSample - this.currentViewStartSample;
  const progress = pixelX / canvasWidth;
  return Math.floor(this.currentViewStartSample + (progress * viewRange));
}

// Sample → Audio Time (seconds)
sampleToTime(sampleIndex) {
  return sampleIndex / this.sampleRate;
}

// Sample → Real Timestamp
sampleToRealTimestamp(sampleIndex) {
  const progress = sampleIndex / this.totalSamples;
  const totalDurationMs = dataEndTime.getTime() - dataStartTime.getTime();
  return new Date(dataStartTime.getTime() + (progress * totalDurationMs));
}
```

---

## Region & Feature Storage

### Region Data Structure

```javascript
const region = {
  id: 1,
  
  // Absolute positions in complete audio (STORED)
  startSample: 2334349,
  endSample: 2595874,
  
  // Metadata
  label: 'Harmonic Tremor Event',
  color: '#ff6b6b',
  
  // Features within this region
  features: [
    {
      id: 'f1',
      type: 'unique',
      
      // Absolute positions (NOT relative to region!)
      startSample: 2400000,
      endSample: 2450000,
      
      // Frequency bounds (Hz)
      freqMin: 2,
      freqMax: 8,
      
      // User annotation
      note: 'Cool harmonic tremor with clear overtones'
    },
    {
      id: 'f2',
      type: 'unique',
      startSample: 2500000,
      endSample: 2550000,
      freqMin: 10,
      freqMax: 15,
      note: 'Secondary peak'
    }
  ]
};
```

### Why Absolute Samples for Features?

**Problem with relative storage:**
```javascript
// BAD: Feature stored relative to region
feature.startSampleRelative = 65651;  // Offset from region start
// If region bounds change, all features break!
```

**Solution with absolute storage:**
```javascript
// GOOD: Feature stored as absolute sample
feature.startSample = 2400000;  // Absolute position in full audio
// Regions can change, features stay correct
```

---

## Zoom Operations

### Zoom to Region

```javascript
function zoomToRegion(region) {
  // 1. Update zoom state
  zoomState.mode = 'region';
  zoomState.currentViewStartSample = region.startSample;
  zoomState.currentViewEndSample = region.endSample;
  zoomState.activeRegionId = region.id;
  
  // 2. Extract audio slice for this region
  const audioSlice = completeSamplesArray.slice(
    region.startSample,
    region.endSample
  );
  
  // 3. Re-render everything
  await renderWaveformForRange(audioSlice, region.startSample, region.endSample);
  await renderSpectrogramForRange(audioSlice, region.startSample, region.endSample);
  renderFeatures();  // Features automatically positioned correctly
  
  // 4. Update playback context
  setPlaybackRange(region.startSample, region.endSample);
  
  // 5. Update UI
  updateZoomButton('↩️ Full View');
  updateTimeAxis();  // Shows subsecond precision when zoomed
}
```

### Zoom to Full View

```javascript
function zoomToFull() {
  // 1. Update zoom state
  zoomState.mode = 'full';
  zoomState.currentViewStartSample = 0;
  zoomState.currentViewEndSample = zoomState.totalSamples;
  zoomState.activeRegionId = null;
  
  // 2. Re-render everything for full view
  await renderWaveformFull();
  await renderSpectrogramFull();
  renderFeatures();  // Features still positioned correctly
  
  // 3. Update playback context
  clearPlaybackRange();
  
  // 4. Update UI
  updateZoomButton('🔍 Zoom');
  updateTimeAxis();  // Shows full time range
}
```

### Creating Features in Zoomed View

```javascript
function onUserDrawsFeatureBox(startPixelX, endPixelX) {
  // Convert pixels to absolute samples using current zoom state
  const startSample = zoomState.pixelToSample(startPixelX, canvas.width);
  const endSample = zoomState.pixelToSample(endPixelX, canvas.width);
  
  // Store feature with absolute samples
  const feature = {
    id: generateId(),
    type: 'unique',
    startSample: startSample,  // Absolute position
    endSample: endSample,      // Absolute position
    freqMin: selectedFreqMin,
    freqMax: selectedFreqMax,
    note: userNote
  };
  
  // Add to active region
  activeRegion.features.push(feature);
  
  // Re-render to show new feature
  renderFeatures();
}
```

### Rendering Features at Any Zoom Level

```javascript
function renderFeatures() {
  const canvas = document.getElementById('waveform');
  const ctx = canvas.getContext('2d');
  
  regions.forEach(region => {
    region.features.forEach(feature => {
      // Convert absolute samples to current view pixels
      const startX = zoomState.sampleToPixel(feature.startSample, canvas.width);
      const endX = zoomState.sampleToPixel(feature.endSample, canvas.width);
      
      // Only draw if visible in current viewport
      if (endX >= 0 && startX <= canvas.width) {
        drawFeatureBox(startX, endX, feature);
      }
    });
  });
}
```

---

## Windowed Playback (Future Feature)

### Overview
Play through data in fixed-size windows that automatically advance. Useful for systematic review of long datasets.

### Architecture

```javascript
class WindowedPlayback {
  constructor(windowSizeSeconds = 10) {
    this.windowSizeSamples = windowSizeSeconds * 44100;
    this.currentWindowStart = 0;
    this.totalSamples = completeSamplesArray.length;
  }
  
  getCurrentWindow() {
    return {
      startSample: this.currentWindowStart,
      endSample: Math.min(
        this.currentWindowStart + this.windowSizeSamples,
        this.totalSamples
      )
    };
  }
  
  jumpToNextWindow() {
    const nextStart = this.currentWindowStart + this.windowSizeSamples;
    
    if (nextStart >= this.totalSamples) {
      this.currentWindowStart = 0;  // Loop back to start
    } else {
      this.currentWindowStart = nextStart;
    }
    
    return this.getCurrentWindow();
  }
  
  jumpToWindow(windowNumber) {
    this.currentWindowStart = windowNumber * this.windowSizeSamples;
    return this.getCurrentWindow();
  }
  
  getTotalWindows() {
    return Math.ceil(this.totalSamples / this.windowSizeSamples);
  }
}
```

### Integration with Zoom

```javascript
// When window ends, jump to next and update zoom view
workletNode.port.onmessage = (e) => {
  if (e.data.type === 'window-end-reached') {
    const nextWindow = windowedPlayback.jumpToNextWindow();
    
    // Update zoom state to show next window
    zoomState.currentViewStartSample = nextWindow.startSample;
    zoomState.currentViewEndSample = nextWindow.endSample;
    
    // Seek and re-render
    seekToPosition(nextWindow.startSample / 44100, true);
    renderWaveformForRange(...);
    renderSpectrogramForRange(...);
  }
};
```

### Use Cases

1. **Scan Mode**: Rapidly review dataset by playing 3 seconds of each 10-second window
2. **Feature Hunt**: Auto-advance to next window containing annotated features
3. **Comparison Mode**: Loop between two specific windows for A/B comparison
4. **Overlapping Windows**: Advance by 5 seconds for 10-second windows (50% overlap)

---

## Scrolling Playback (Future Feature)

### Overview
Playhead stays centered on screen while waveform/spectrogram scroll past. Similar to a DAW's scrolling timeline.

### Approach 1: Full Re-render (Simplest)

```javascript
function updateScrollingView(currentSample) {
  const halfViewSamples = (viewWidthSeconds * 44100) / 2;
  const startSample = currentSample - halfViewSamples;
  const endSample = currentSample + halfViewSamples;
  
  // Re-render visible range every frame
  renderWaveformRange(startSample, endSample);
  renderSpectrogramRange(startSample, endSample);
  
  // Draw static playhead at center
  drawPlayheadLine(canvas.width / 2);
}
```

### Approach 2: Pre-render + Blit (Optimized)

```javascript
class ScrollingRenderer {
  constructor() {
    // Offscreen canvas 3x viewport width
    this.offscreenCanvas = document.createElement('canvas');
    this.offscreenCanvas.width = canvas.width * 3;
    this.offscreenCanvas.height = canvas.height;
    
    // Pre-render 3 viewports worth
    this.renderOffscreen(startSample, endSample);
  }
  
  updatePosition(currentSample) {
    // Copy appropriate section from offscreen to visible canvas
    const pixelOffset = calculatePixelOffset(currentSample);
    mainCtx.drawImage(
      this.offscreenCanvas,
      pixelOffset, 0,
      canvas.width, canvas.height,
      0, 0,
      canvas.width, canvas.height
    );
    
    // Re-render offscreen when scrolled past threshold
    if (needsRefresh(pixelOffset)) {
      this.renderOffscreen(newStartSample, newEndSample);
    }
  }
}
```

### Approach 3: Ring Buffer (Most Efficient)

```javascript
class ScrollingRingBuffer {
  constructor() {
    // 5 chunks, each 2 seconds (240 pixels)
    this.chunkCount = 5;
    this.chunkWidthSamples = 2 * 44100;
    this.chunkWidthPixels = 240;
    
    // Pre-rendered chunk canvases
    this.chunks = new Array(this.chunkCount);
    // ... initialize chunks
  }
  
  getChunkForSample(sample) {
    const chunkNumber = Math.floor(sample / this.chunkWidthSamples);
    const chunkIndex = chunkNumber % this.chunkCount;
    
    // Render chunk if not cached or invalidated
    if (this.chunks[chunkIndex].needsUpdate(chunkNumber)) {
      this.renderChunk(chunkIndex, chunkNumber);
    }
    
    return this.chunks[chunkIndex];
  }
  
  updatePosition(currentSample) {
    // Composite visible chunks onto main canvas
    // Only render new chunks as they come into view
  }
}
```

### Performance: Pre-compute Spectrogram FFT

```javascript
// On data load, compute ALL FFT slices once
const allFFTSlices = computeCompleteSpectrogram(completeSamplesArray);

// When rendering scrolling chunk for samples 88200 → 176400
function renderSpectrogramChunk(startSample, endSample) {
  const startSliceIndex = Math.floor(startSample / hopSize);
  const endSliceIndex = Math.floor(endSample / hopSize);
  
  // Just copy pre-computed slices (fast)
  for (let i = startSliceIndex; i < endSliceIndex; i++) {
    drawSlice(allFFTSlices[i], xPosition);
    xPosition += pixelsPerSlice;
  }
}
```

---

## UI/UX Considerations

### Zoom Button Behavior

**Option A: Toggle**
- Full view: Button shows "🔍 Zoom to Region"
- Zoomed view: Button shows "↩️ Full View"
- Single button changes based on state

**Option B: Always Visible**
- Region bar always shows both options
- Active option highlighted
- More explicit, less cognitive load

**Recommendation**: Option A (cleaner, less clutter)

### Time Axis Behavior

**Full View**:
- Show hours/minutes (e.g., "14:00", "15:00", "16:00")
- Show date if dataset spans multiple days

**Zoomed View**:
- Show seconds (e.g., "0s", "5s", "10s")
- Show subseconds if window < 10 seconds (e.g., "0.0s", "0.5s", "1.0s")

### Playback Context

**Full View**:
- Clicking plays from that position through end
- Loop button loops entire dataset

**Zoomed View**:
- Clicking plays from that position within region
- Loop button loops the zoomed region only
- Master play/pause still works globally

### Region Visibility

**Full View**:
- All regions visible as colored bars
- Features not shown (too small)

**Zoomed View**:
- Only features from active region shown
- Feature detail fully visible
- Other regions hidden (outside viewport)

---

## Implementation Order

### Phase 1: Core Zoom (MVP)
1. Create `zoom-state.js` with sample/pixel conversion functions
2. Build `ZoomManager.zoomToRegion()` - waveform only
3. Add spectrogram zoom using existing complete renderer
4. Wire up UI buttons and test edge cases
5. Polish: time axis labels, playback sync, animations

### Phase 2: Feature Management
1. Enable feature creation in zoomed view
2. Ensure features render correctly at all zoom levels
3. Add feature editing in zoomed view
4. Test zoom → draw feature → zoom out → zoom back in

### Phase 3: Windowed Playback (Optional)
1. Build `WindowedPlayback` class
2. Add auto-advance on window end
3. Add UI controls (window size, next/prev buttons)
4. Add progress indicator

### Phase 4: Scrolling Playback (Optional)
1. Start with Approach 2 (pre-render + blit)
2. Test performance with real data
3. Upgrade to Approach 3 (ring buffer) if needed
4. Add smooth interpolation between frames

---

## Testing Strategy

### Coordinate System Validation

Use the selection diagnostics system to verify:
```javascript
window.printCurrentSelection()  // Verify percentages match
window.testAtPercentage(50)     // Test midpoint
window.testAtPercentage(99.9)   // Test edge cases
```

### Zoom Testing

1. **Basic zoom**: Region → zoom in → verify waveform/spectrogram match
2. **Round-trip**: Full → zoom → full → verify positions unchanged
3. **Nested operations**: Zoom → select → create feature → zoom out → zoom back
4. **Edge cases**: Very small regions (< 1 second), very large regions
5. **Feature persistence**: Create feature → zoom out → zoom in → verify position

### Performance Testing

1. **Zoom speed**: Measure time to zoom in/out
2. **Re-render speed**: Time for waveform + spectrogram render
3. **Memory usage**: Monitor before/after zoom operations
4. **Interaction latency**: Click-to-render delay when zoomed

---

## Key Advantages of Sample-Based Architecture

1. **Zero Accumulation Error**: Integer arithmetic prevents drift
2. **Reversible Operations**: Zoom in/out/in = exact same position
3. **Speed Independent**: Works at any playback speed
4. **Viewport Independent**: Render any sample range to any pixel range
5. **Future-Proof**: Scrolling, windowing, multi-zoom all compatible
6. **Easy Debugging**: Sample indices are concrete and traceable

---

## Notes

- All conversion functions must use `Math.floor()` for sample indices to avoid sub-sample errors
- Features should have minimum size (e.g., 100 samples) to prevent degenerate cases
- Consider caching rendered chunks for frequently visited zoom levels
- Time axis should automatically adjust precision based on zoom level
- Playback loop logic must respect current zoom state

