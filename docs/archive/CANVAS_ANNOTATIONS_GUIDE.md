# Canvas-Based Feature Annotations - Implementation Guide

## Overview
This system renders annotation text **directly on canvas** above feature boxes with connecting lines. The text wraps, prevents collisions, and stays within viewport bounds.

## Key Architecture Decisions

### 1. **Rendering Approach: Canvas Overlay (NOT DOM)**
- Create a separate canvas overlay that sits on top of your main spectrogram canvas
- This overlay is a child of the same `.panel` container
- Position it with `position: absolute`, same dimensions as your spectrogram canvas
- **Why canvas?** DOM elements don't coordinate-match with canvas rendering and cause sync issues

### 2. **Critical: Two-Pass Rendering**
```javascript
// PASS 1: Draw all feature boxes WITHOUT annotations
for (const box of featureBoxes) {
    drawFeatureBox(ctx, box, false); // false = don't draw annotations yet
}

// PASS 2: Draw ALL annotations on top
const placedAnnotations = []; // For collision tracking
for (const box of featureBoxes) {
    drawAnnotation(ctx, box, true, placedAnnotations); // true = annotations only
}
```
**Why?** This ensures all annotations render ABOVE all boxes, preventing z-fighting.

### 3. **Coordinate System Hell - THE MOST IMPORTANT PART**

Your canvas has TWO coordinate systems:

**Device Pixels** (canvas.width, canvas.height):
- The actual pixel buffer size (e.g., 2400 x 900 on retina)
- Used for ALL canvas drawing operations (ctx.fillRect, ctx.fillText, etc.)

**CSS Pixels** (canvas.offsetWidth, canvas.offsetHeight):
- The displayed size in the browser (e.g., 1200 x 450)
- Used for DOM positioning

**CRITICAL CONVERSION:**
```javascript
const scaleX = canvas.offsetWidth / canvas.width;   // CSS to device ratio
const scaleY = canvas.offsetHeight / canvas.height;

// When you have a position in DEVICE pixels from your feature data:
const cssX = deviceX * scaleX;
const cssY = deviceY * scaleY;
```

**You MUST draw in device pixels, but calculate based on your feature coordinates!**

## Text Positioning System

### Step 1: Calculate Feature Box Position (Device Pixels)

Your feature has eternal coordinates (timestamps + frequencies). Convert these to canvas device pixels:

```javascript
// X position from timestamp
const displayStartMs = yourTimeRange.startTime.getTime();
const displayEndMs = yourTimeRange.endTime.getTime();
const displaySpanMs = displayEndMs - displayStartMs;

const featureStartMs = new Date(feature.startTime).getTime();
const startProgress = (featureStartMs - displayStartMs) / displaySpanMs;
const x_device = startProgress * canvas.width; // DEVICE pixels

// Y position from frequency
const y_device = getYPositionForFrequency(feature.lowFreq, canvas.height);

// Box dimensions
const width_device = /* calculate from time range */;
const height_device = /* calculate from frequency range */;
```

### Step 2: Position Text Above Box

```javascript
// Center X on the box (in device pixels)
let textX = x_device + (width_device / 2);

// Position ABOVE the box with 20px gap
const textY = y_device - 20 - totalTextHeight;
```

### Step 3: Text Wrapping

**CRITICAL: Must measure text AFTER setting font:**

```javascript
ctx.font = '600 13px Arial, sans-serif'; // Set font FIRST

const maxWidth = 325; // Device pixels
const lines = wrapText(ctx, feature.notes, maxWidth);

function wrapText(ctx, text, maxWidth) {
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';

    for (let i = 0; i < words.length; i++) {
        const testLine = currentLine ? currentLine + ' ' + words[i] : words[i];
        const metrics = ctx.measureText(testLine);

        if (metrics.width > maxWidth && currentLine) {
            lines.push(currentLine);
            currentLine = words[i];
        } else {
            currentLine = testLine;
        }
    }

    if (currentLine) {
        lines.push(currentLine);
    }

    return lines.length > 0 ? lines : [text];
}

const lineHeight = 16; // Device pixels
const totalTextHeight = lines.length * lineHeight;
```

### Step 4: Edge Detection (Keep Text On-Screen)

```javascript
// Measure actual rendered width
const textWidth = Math.max(...lines.map(line => ctx.measureText(line).width));
const halfWidth = textWidth / 2;

// Check left edge
if (textX - halfWidth < 10) {
    textX = 10 + halfWidth;
}

// Check right edge
if (textX + halfWidth > canvas.width - 10) {
    textX = canvas.width - 10 - halfWidth;
}
```

### Step 5: Collision Detection (Stack Vertically)

**This prevents annotations from overlapping:**

```javascript
const placedAnnotations = []; // Track all placed annotations this frame
const padding = 10;
let finalTextY = textY;
let collisionDetected = true;

while (collisionDetected && placedAnnotations.length > 0) {
    collisionDetected = false;

    for (const placed of placedAnnotations) {
        // Check X overlap (25% wider bounding area for breathing room)
        const xOverlap = Math.abs(textX - placed.x) <
            ((halfWidth + placed.halfWidth) * 1.25 + padding);

        // Check Y overlap
        const yOverlap = Math.abs(finalTextY - placed.y) <
            (totalTextHeight / 2 + placed.height / 2 + padding);

        if (xOverlap && yOverlap) {
            // Collision! Move this annotation UP
            finalTextY = placed.y - (placed.height / 2 + totalTextHeight / 2 + padding);
            collisionDetected = true;
            break;
        }
    }
}

// Record this annotation's position for future collision checks
placedAnnotations.push({
    x: textX,
    y: finalTextY,
    halfWidth: halfWidth,
    height: totalTextHeight
});
```

**CRITICAL:** Process annotations left-to-right or in a consistent order. Later annotations will stack above earlier ones if they collide.

### Step 6: Draw Connecting Line

```javascript
ctx.save();
ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)'; // Semi-transparent white
ctx.lineWidth = 2;
ctx.setLineDash([3, 3]); // Dotted line (3px dash, 3px gap)

ctx.beginPath();
ctx.moveTo(textX, finalTextY + totalTextHeight); // Bottom of text
ctx.lineTo(x_device + width_device / 2, y_device); // Top center of box
ctx.stroke();

ctx.setLineDash([]); // Reset dash pattern!
ctx.restore();
```

**Important:** Always reset `setLineDash([])` or it affects future drawing!

### Step 7: Draw Text

```javascript
ctx.save();
ctx.font = '600 13px Arial, sans-serif';
ctx.fillStyle = '#fff';
ctx.textAlign = 'center';
ctx.textBaseline = 'top';

// Shadow for readability
ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
ctx.shadowBlur = 4;
ctx.shadowOffsetX = 0;
ctx.shadowOffsetY = 0;

// Draw each line
for (let i = 0; i < lines.length; i++) {
    const lineY = finalTextY + (i * lineHeight);
    ctx.fillText(lines[i], textX, lineY);
}

ctx.restore();
```

### Step 8: Add Feature Number Label

```javascript
// Draw "1.2" style label in orange
ctx.save();
ctx.font = '700 13px Arial, sans-serif';
ctx.fillStyle = '#ffa050'; // Orange

const label = `${regionIndex + 1}.${featureIndex + 1}`;
const labelWidth = ctx.measureText(label).width;

// Draw label at start of first line
ctx.fillText(label, textX - halfWidth + labelWidth/2 + 4, finalTextY);

ctx.restore();
```

## Critical Details That Will Break Everything

### 1. **Font Must Be Set Before measureText()**
```javascript
// WRONG:
const width = ctx.measureText(text).width;
ctx.font = '13px Arial';

// RIGHT:
ctx.font = '13px Arial';
const width = ctx.measureText(text).width;
```

### 2. **Clear Canvas Every Frame**
```javascript
ctx.clearRect(0, 0, canvas.width, canvas.height);
// THEN draw everything
```

### 3. **Canvas Coordinate Order**
When drawing features, convert in this order:
1. Feature eternal coords → device pixels (for drawing)
2. Keep device pixel positions
3. Use device pixels for ALL canvas operations

### 4. **Text Baseline**
```javascript
ctx.textBaseline = 'top'; // Text draws DOWN from Y position
// NOT 'middle' or 'alphabetic' - these cause positioning issues
```

### 5. **Collision Detection Y-Coordinate**
The collision detection uses the CENTER of each text block:
```javascript
const yCenter = finalTextY + (totalTextHeight / 2); // For collision checks
```
But when recording for future checks, store the TOP Y and full height.

### 6. **Device Pixel Ratio**
On retina displays, `canvas.width` is often 2x `canvas.offsetWidth`. Always calculate the scale factor - never assume 1:1.

## What You DON'T Need (From Our Implementation)

Since you want static display (no playback timing):

**SKIP ALL OF THIS:**
- `annotationTimingState` map
- Fade in/out animations (`timing.state`, `opacity` calculations)
- Lead time calculations (`LEAD_TIME_MS`, `samplesToFeature`)
- Audio worklet timing logic
- `lockedY` positioning (used for preventing drops during fade-outs)
- Frame counter debugging

**Just render all annotations every frame when drawing your spectrogram.**

## Simplified Static Implementation

```javascript
function drawAllAnnotations(ctx, canvas, featureBoxes) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // PASS 1: Draw boxes
    for (const box of featureBoxes) {
        drawBox(ctx, box);
    }

    // PASS 2: Draw annotations
    const placedAnnotations = [];
    for (const box of featureBoxes) {
        if (box.notes) {
            drawAnnotation(ctx, canvas, box, placedAnnotations);
        }
    }
}
```

That's it! Call this whenever your spectrogram updates.

## Performance Optimization: Text Caching

If annotations are static (not changing during playback), cache the text wrapping:

```javascript
// In your timing/state object:
if (timing.cachedText !== box.notes) {
    // Text changed! Re-wrap
    const lines = wrapText(ctx, box.notes, maxWidth);
    const textWidth = Math.max(...lines.map(line => ctx.measureText(line).width));

    // Cache for next frame
    timing.cachedText = box.notes;
    timing.cachedLines = lines;
    timing.cachedHalfWidth = textWidth / 2;
    timing.cachedTotalHeight = lines.length * lineHeight;
} else {
    // Reuse cached values
    lines = timing.cachedLines;
    halfWidth = timing.cachedHalfWidth;
    totalHeight = timing.cachedTotalHeight;
}
```

This prevents re-wrapping text every frame when it hasn't changed.

## Testing Checklist

- [ ] Text appears centered above correct box
- [ ] Line connects text bottom to box top
- [ ] Text wraps at reasonable width
- [ ] Text stays on-screen (doesn't clip at edges)
- [ ] Multiple annotations don't overlap (stack vertically)
- [ ] Text is readable (has shadow/outline)
- [ ] Works on retina displays
- [ ] Feature numbers appear in orange
- [ ] Annotations update when feature notes change

## Reference Implementation

See `js/spectrogram-renderer.js` in this repository:
- Function `wrapText()` (lines 48-77)
- Function `drawSavedBox()` with `drawAnnotationsOnly` parameter (lines ~1600-1900)
- Two-pass rendering in `updateCanvasAnnotations()` (lines ~280-295)
