# Spectrogram Regions & Selections Implementation Guide

This document lists the files needed to duplicate the waveform region/selection drawing functionality onto the spectrogram canvas, with lighter styling.

## Core Files Required

### 1. **`js/region-tracker.js`** ⭐ PRIMARY FILE
   - **Function to duplicate**: `drawRegionHighlights(ctx, canvasWidth, canvasHeight)` (lines 423-739)
   - **What it does**: 
     - Draws blue region highlights (filled rectangles with borders)
     - Draws region numbers and zoom buttons
     - Handles zoom transitions with opacity interpolation
     - Uses interpolated time range for smooth transitions
   - **Key dependencies**:
     - `getCurrentRegions()` - Gets regions for current volcano
     - `zoomState` - For zoom-aware positioning
     - `getInterpolatedTimeRange()` - For smooth transitions
     - `getRegionOpacityProgress()` - For opacity interpolation
     - `isZoomTransitionInProgress()` - To check if in transition
   - **For spectrogram**: Create a lighter version (lower opacity, thinner borders, no numbers/buttons)

### 2. **`js/waveform-renderer.js`**
   - **Function to reference**: `drawWaveformWithSelection()` (lines 328-428)
   - **What it shows**:
     - How to draw yellow selection box (`rgba(255, 255, 0, 0.2)` fill, `rgba(255, 200, 0, 0.8)` stroke)
     - How to integrate `drawRegionHighlights()` call
     - How to handle zoom-aware positioning for selections
   - **Key pattern**: 
     ```javascript
     // Draw cached canvas first
     ctx.drawImage(State.cachedWaveformCanvas, 0, 0);
     // Then draw regions on top
     drawRegionHighlights(ctx, width, height);
     // Then draw selection box
     if (State.selectionStart !== null && State.selectionEnd !== null) {
       // Draw yellow selection box
     }
     ```

### 3. **`js/spectrogram-complete-renderer.js`**
   - **Where to add drawing**: 
     - `updateSpectrogramViewport()` function (around line 789-950)
     - `drawInterpolatedSpectrogram()` function (lines 671-787)
   - **What it does**: 
     - Renders the spectrogram canvas
     - Handles zoom transitions
     - Uses `getSpectrogramViewport()` to get the current viewport canvas
   - **Integration point**: After drawing the spectrogram, call region/selection drawing functions

### 4. **`js/zoom-state.js`**
   - **Purpose**: Provides zoom-aware coordinate conversion
   - **Key functions**:
     - `sampleToPixel(sampleIndex, canvasWidth)` - Convert sample to pixel position
     - `timeToSample(timeSeconds)` - Convert time to sample index
     - `sampleToRealTimestamp(sampleIndex)` - Convert sample to timestamp
     - `isInRegion()` - Check if zoomed into a region
     - `getRegionRange()` - Get current region bounds
   - **Why needed**: Regions use zoom-aware positioning to stay aligned during zoom transitions

### 5. **`js/waveform-x-axis-renderer.js`**
   - **Functions needed**:
     - `getInterpolatedTimeRange()` - Returns current interpolated time range during zoom transitions
     - `getRegionOpacityProgress()` - Returns opacity progress (0.0 = full view, 1.0 = zoomed in)
     - `isZoomTransitionInProgress()` - Checks if zoom transition is active
     - `getZoomTransitionProgress()` - Returns transition progress (0.0 to 1.0)
     - `getOldTimeRange()` - Returns old time range before transition
   - **Why needed**: These handle smooth transitions during zoom animations

### 6. **`js/audio-state.js`**
   - **State variables**:
     - `selectionStart` / `selectionEnd` - Current selection times (in seconds)
     - `isSelecting` - Whether user is currently selecting
     - `currentAudioPosition` - Current playback position
   - **Why needed**: Selection drawing needs these to know what to draw

## Implementation Pattern

### Step 1: Create Lightweight Region Drawing Function
Create `drawSpectrogramRegionHighlights(ctx, canvasWidth, canvasHeight)` in `region-tracker.js`:
- **Lighter styling**:
  - Active region: `rgba(68, 136, 255, 0.15)` fill (vs 0.5 on waveform)
  - Inactive region: `rgba(68, 136, 255, 0.08)` fill (vs 0.25 on waveform)
  - Border: `rgba(68, 136, 255, 0.3)` stroke, `lineWidth: 1` (vs 2 on waveform)
  - **No numbers or buttons** - just the highlight rectangles

### Step 2: Create Lightweight Selection Drawing Function
Create `drawSpectrogramSelection(ctx, canvasWidth, canvasHeight)` in `region-tracker.js`:
- **Lighter styling**:
  - Fill: `rgba(255, 255, 0, 0.1)` (vs 0.2 on waveform)
  - Stroke: `rgba(255, 200, 0, 0.4)` (vs 0.8 on waveform)
  - `lineWidth: 1` (vs 2 on waveform)

### Step 3: Integrate into Spectrogram Rendering
In `spectrogram-complete-renderer.js`:
- **In `updateSpectrogramViewport()`**: After drawing spectrogram, call:
  ```javascript
  drawSpectrogramRegionHighlights(ctx, width, height);
  drawSpectrogramSelection(ctx, width, height);
  ```
- **In `drawInterpolatedSpectrogram()`**: After drawing interpolated spectrogram, call the same functions

## Key Differences for Spectrogram Version

1. **No region numbers or buttons** - Keep it minimal
2. **Lower opacity** - Regions should be subtle (15% active, 8% inactive)
3. **Thinner borders** - 1px instead of 2px
4. **Simpler transitions** - Can skip the complex label positioning logic
5. **Full height** - Regions span the full spectrogram height (unlike waveform which has axis space)

## Files to Modify

1. **`js/region-tracker.js`** - Add new functions:
   - `drawSpectrogramRegionHighlights(ctx, canvasWidth, canvasHeight)`
   - `drawSpectrogramSelection(ctx, canvasWidth, canvasHeight)`

2. **`js/spectrogram-complete-renderer.js`** - Integrate drawing calls:
   - In `updateSpectrogramViewport()` after spectrogram is drawn
   - In `drawInterpolatedSpectrogram()` after interpolated spectrogram is drawn

## Example Code Structure

```javascript
// In region-tracker.js
export function drawSpectrogramRegionHighlights(ctx, canvasWidth, canvasHeight) {
    // Similar to drawRegionHighlights but:
    // - Lower opacity (0.15 active, 0.08 inactive)
    // - Thinner borders (1px)
    // - No numbers/buttons
    // - Full height (0 to canvasHeight)
}

export function drawSpectrogramSelection(ctx, canvasWidth, canvasHeight) {
    // Similar to waveform selection but:
    // - Lower opacity (0.1 fill, 0.4 stroke)
    // - Thinner borders (1px)
    // - Full height
}

// In spectrogram-complete-renderer.js
export function updateSpectrogramViewport(playbackRate) {
    // ... existing spectrogram drawing code ...
    
    // Draw regions and selection on top
    const ctx = canvas.getContext('2d');
    drawSpectrogramRegionHighlights(ctx, width, height);
    drawSpectrogramSelection(ctx, width, height);
}
```

## Testing Checklist

- [ ] Regions appear on spectrogram with lighter styling
- [ ] Selections appear on spectrogram with lighter styling
- [ ] Regions/selections stay aligned during zoom transitions
- [ ] Opacity transitions smoothly during zoom
- [ ] No performance impact (regions should be lightweight)
- [ ] Works with all frequency scales (linear, sqrt, logarithmic)
- [ ] Works with playback rate changes

