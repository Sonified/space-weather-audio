# Feature Selection Process & Region Drawing on Spectrogram

## Overview

This document explains how the feature selection process works and how regions are drawn on the spectrogram canvas. It also explains why regions aren't currently persisting and what code is needed to make them stay drawn.

---

## Part 1: Feature Selection Process Flow

### Step 1: Starting Feature Selection

**File**: `js/region-tracker.js`  
**Function**: `startFrequencySelection(regionIndex, featureIndex)` (line 964)

```javascript
export function startFrequencySelection(regionIndex, featureIndex) {
    isSelectingFrequency = true;
    currentFrequencySelection = { regionIndex, featureIndex };
    
    // Enable selection cursor on spectrogram
    const canvas = document.getElementById('spectrogram');
    if (canvas) {
        canvas.classList.add('selecting');
        canvas.style.cursor = 'crosshair';
    }
}
```

**What happens:**
- Sets `isSelectingFrequency = true` flag
- Stores which region/feature is being selected
- Changes spectrogram cursor to crosshair
- Adds 'selecting' class to canvas

**Triggered by:**
- Clicking the "select frequency range" button for a feature
- Auto-activated when zooming into a region with incomplete features (line 2124)

---

### Step 2: Drawing Selection Box (During Selection)

**File**: `js/spectrogram-renderer.js`  
**Function**: `setupSpectrogramSelection()` (line 440)

**Mouse Down** (line 448):
- Creates a temporary DOM `<div>` element (`spectrogramSelectionBox`)
- Positions it absolutely over the canvas
- Red border (`#ff4444`) with semi-transparent red background
- Starts at mouse position with 0 width/height

**Mouse Move** (line 476):
- Updates the selection box size as you drag
- Calculates min/max X and Y to handle dragging in any direction
- Updates the DOM element's position and size in real-time

**Mouse Up** (line 496):
- Calls `handleSpectrogramSelection()` with the final coordinates
- Removes the temporary DOM selection box
- Cleans up state variables

**Key Point**: The selection box during dragging is a **DOM element**, not drawn on the canvas. This is why it disappears after selection completes.

---

### Step 3: Processing Selection

**File**: `js/region-tracker.js`  
**Function**: `handleSpectrogramSelection(startY, endY, canvasHeight, startX, endX, canvasWidth)` (line 989)

**What it does:**
1. **Converts Y positions → frequencies** (line 997-998):
   - Uses `getFrequencyFromY()` to convert pixel Y to frequency (Hz)
   - Handles linear vs logarithmic frequency scales

2. **Converts X positions → timestamps** (line 1004-1041):
   - Uses zoom-aware conversion via `zoomState.pixelToSample()` and `zoomState.sampleToRealTimestamp()`
   - Falls back to simple progress calculation if zoom state not initialized
   - Ensures start < end

3. **Saves to feature data** (line 1043-1054):
   ```javascript
   regions[regionIndex].features[featureIndex].lowFreq = lowFreq.toFixed(2);
   regions[regionIndex].features[featureIndex].highFreq = highFreq.toFixed(2);
   regions[regionIndex].features[featureIndex].startTime = startTime;
   regions[regionIndex].features[featureIndex].endTime = endTime;
   setCurrentRegions(regions); // Persists to localStorage
   ```

4. **Clears selection state** (line 1080-1090):
   - Sets `isSelectingFrequency = false`
   - Removes 'selecting' class from canvas
   - Resets cursor

**Key Point**: The feature data is saved to `regions` array and persisted via `setCurrentRegions()`, but **nothing is drawn on the canvas** to show the selected area.

---

## Part 2: Region Drawing Functions (Currently Commented Out)

### Function 1: Draw Region Highlights

**File**: `js/region-tracker.js`  
**Function**: `drawSpectrogramRegionHighlights(ctx, canvasWidth, canvasHeight)` (line 576)

**What it does:**
- Draws blue rectangles for each region on the spectrogram
- Active region: 15% opacity fill, 30% opacity stroke
- Inactive regions: 8% opacity fill, 20% opacity stroke
- Fades out when zooming into a region (opacity → 0%)
- Full-height rectangles spanning the spectrogram

**Current Status**: ✅ **Function exists and works**, but **NOT CALLED** anywhere

---

### Function 2: Draw Selection Box

**File**: `js/region-tracker.js`  
**Function**: `drawSpectrogramSelection(ctx, canvasWidth, canvasHeight)` (line 677)

**What it does:**
- Draws yellow selection box (from `State.selectionStart` / `State.selectionEnd`)
- Only draws if NOT playing an active region
- Lighter styling: 8% fill, 35% stroke (vs waveform's 20%/80%)
- Full-height rectangle

**Current Status**: ✅ **Function exists and works**, but **NOT CALLED** anywhere

---

## Part 3: Why Regions Aren't Staying Drawn

### The Problem

The drawing functions exist but are **commented out** in the spectrogram renderer:

**File**: `js/spectrogram-complete-renderer.js`

**Line 816-817** (in `drawInterpolatedSpectrogram()`):
```javascript
//     drawSpectrogramRegionHighlights(ctx, width, height);
//     drawSpectrogramSelection(ctx, width, height);
```

**Line 1040-1041** (in `updateSpectrogramViewport()`):
```javascript
// COMMENTED OUT: Don't draw bars or yellow background when in zoomed region mode
// if (!zoomState.isInRegion()) {
//     drawSpectrogramRegionHighlights(ctx, width, height);
//     drawSpectrogramSelection(ctx, width, height);
// }
```

**Why they're commented out:**
- The comment says "Don't draw bars or yellow background when in zoomed region mode"
- This suggests they were disabled to avoid visual clutter when zoomed into a region
- But this means regions **never** show on the spectrogram, even in full view

---

## Part 4: How to Make Regions Stay Drawn

### Solution: Uncomment and Call the Drawing Functions

You need to call `drawSpectrogramRegionHighlights()` and `drawSpectrogramSelection()` in the spectrogram rendering functions.

### Option 1: Draw in Full View Only (Recommended)

**File**: `js/spectrogram-complete-renderer.js`

**In `updateSpectrogramViewport()`** (around line 1037):
```javascript
// Draw regions and selection on top (only in full view)
if (!zoomState.isInRegion()) {
    drawSpectrogramRegionHighlights(ctx, width, height);
    drawSpectrogramSelection(ctx, width, height);
}
```

**In `drawInterpolatedSpectrogram()`** (around line 816):
```javascript
// Draw regions and selection on top (only in full view)
if (!zoomState.isInRegion()) {
    drawSpectrogramRegionHighlights(ctx, width, height);
    drawSpectrogramSelection(ctx, width, height);
}
```

**Result**: Regions show in full view, fade out when zooming in (via opacity logic in `drawSpectrogramRegionHighlights`)

---

### Option 2: Always Draw (Even When Zoomed)

**File**: `js/spectrogram-complete-renderer.js`

**In `updateSpectrogramViewport()`** (around line 1037):
```javascript
// Draw regions and selection on top
drawSpectrogramRegionHighlights(ctx, width, height);
drawSpectrogramSelection(ctx, width, height);
```

**In `drawInterpolatedSpectrogram()`** (around line 816):
```javascript
// Draw regions and selection on top
drawSpectrogramRegionHighlights(ctx, width, height);
drawSpectrogramSelection(ctx, width, height);
```

**Result**: Regions always show, but will fade to 0% opacity when zoomed into a region (handled by `getRegionOpacityProgress()`)

---

### Option 3: Draw Feature Selections (New Feature)

If you want to draw the **feature selections** (frequency/time boxes) that users select:

**New Function Needed** in `js/region-tracker.js`:
```javascript
export function drawFeatureSelections(ctx, canvasWidth, canvasHeight) {
    if (!State.dataStartTime || !State.dataEndTime) return;
    
    const regions = getCurrentRegions();
    
    regions.forEach((region, regionIndex) => {
        region.features.forEach((feature, featureIndex) => {
            // Only draw if feature has both frequency and time data
            if (!feature.lowFreq || !feature.highFreq || !feature.startTime || !feature.endTime) {
                return;
            }
            
            // Convert frequency to Y positions
            const lowFreqY = getYFromFrequency(parseFloat(feature.lowFreq), maxFrequency, canvasHeight, State.frequencyScale);
            const highFreqY = getYFromFrequency(parseFloat(feature.highFreq), maxFrequency, canvasHeight, State.frequencyScale);
            
            // Convert time to X positions
            const startTimeMs = new Date(feature.startTime).getTime();
            const endTimeMs = new Date(feature.endTime).getTime();
            // ... use zoomState to convert to pixels ...
            
            // Draw feature box (different color/style than region highlights)
            ctx.fillStyle = 'rgba(255, 100, 100, 0.1)'; // Light red
            ctx.strokeStyle = 'rgba(255, 100, 100, 0.5)';
            ctx.lineWidth = 1;
            ctx.fillRect(startX, lowFreqY, endX - startX, highFreqY - lowFreqY);
            ctx.strokeRect(startX, lowFreqY, endX - startX, highFreqY - lowFreqY);
        });
    });
}
```

Then call it in the spectrogram renderer:
```javascript
drawSpectrogramRegionHighlights(ctx, width, height);
drawSpectrogramSelection(ctx, width, height);
drawFeatureSelections(ctx, width, height); // NEW
```

---

## Part 5: Key Files Summary

### Files That Handle Feature Selection:

1. **`js/region-tracker.js`**:
   - `startFrequencySelection()` - Starts selection mode
   - `handleSpectrogramSelection()` - Processes completed selection
   - `drawSpectrogramRegionHighlights()` - Draws region rectangles (exists, not called)
   - `drawSpectrogramSelection()` - Draws yellow selection box (exists, not called)

2. **`js/spectrogram-renderer.js`**:
   - `setupSpectrogramSelection()` - Sets up mouse event handlers
   - Creates temporary DOM selection box during dragging

3. **`js/spectrogram-complete-renderer.js`**:
   - `updateSpectrogramViewport()` - Main rendering function (needs drawing calls)
   - `drawInterpolatedSpectrogram()` - Interpolated rendering (needs drawing calls)

### Files That Store Feature Data:

- **`js/region-tracker.js`**: `getCurrentRegions()`, `setCurrentRegions()` - Manages regions array
- **`js/audio-state.js`**: `State.selectionStart`, `State.selectionEnd` - Current selection state

---

## Part 6: Quick Fix Checklist

To make regions stay drawn on the spectrogram:

- [ ] **Uncomment** the drawing calls in `spectrogram-complete-renderer.js`
- [ ] **Import** the functions at the top: `import { drawSpectrogramRegionHighlights, drawSpectrogramSelection } from './region-tracker.js';` (already imported on line 18)
- [ ] **Add calls** in `updateSpectrogramViewport()` after spectrogram is drawn
- [ ] **Add calls** in `drawInterpolatedSpectrogram()` after interpolated spectrogram is drawn
- [ ] **Test** that regions appear in full view
- [ ] **Test** that regions fade out when zooming into a region
- [ ] **Optional**: Add feature selection drawing if you want to see individual feature boxes

---

## Part 7: Current State vs Desired State

### Current State:
- ✅ Feature selection works (saves frequency/time data)
- ✅ Selection box appears during dragging (DOM element)
- ❌ Regions don't persist on canvas after selection
- ❌ No visual indication of selected features
- ❌ Region highlights commented out

### Desired State:
- ✅ Feature selection works (saves frequency/time data)
- ✅ Selection box appears during dragging (DOM element)
- ✅ Regions persist on canvas (blue highlights)
- ✅ Yellow selection box shows current selection
- ✅ Optional: Feature boxes show individual selections

---

## Summary

The feature selection process works correctly and saves data, but **regions aren't visually persistent** because the drawing functions are commented out. To fix this:

1. **Uncomment** `drawSpectrogramRegionHighlights()` and `drawSpectrogramSelection()` calls in `spectrogram-complete-renderer.js`
2. **Add conditional** to only draw in full view (or always draw and let opacity handle fading)
3. **Test** that regions appear and fade correctly during zoom transitions

The functions already exist and work - they just need to be called!

