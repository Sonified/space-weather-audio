/**
 * spectrogram-renderer.js
 * Spectrogram visualization
 */

import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { drawFrequencyAxis, positionAxisCanvas, resizeAxisCanvas, initializeAxisPlaybackRate, getYPositionForFrequencyScaled, getScaleTransitionState, getLogScaleMinFreq } from './spectrogram-axis-renderer.js';
import { handleSpectrogramSelection, isInFrequencySelectionMode, getCurrentRegions, getStandaloneFeatures, saveStandaloneFeatures, startFrequencySelection, zoomToRegion, getFlatFeatureNumber, deleteRegion, deleteStandaloneFeature, deleteSpecificFeature, renderStandaloneFeaturesList, updateFeature } from './region-tracker.js';
import { renderCompleteSpectrogram, clearCompleteSpectrogram, isCompleteSpectrogramRendered, renderCompleteSpectrogramForRegion, updateSpectrogramViewport, updateSpectrogramViewportFromZoom, resetSpectrogramState, updateElasticFriendInBackground, onColormapChanged, setScrollZoomHiRes } from './spectrogram-three-renderer.js';
import { zoomState } from './zoom-state.js';
import { isStudyMode } from './master-modes.js';
import { getInterpolatedTimeRange } from './waveform-x-axis-renderer.js';
import { updateAllFeatureBoxPositions } from './spectrogram-feature-boxes.js';
import { animateScaleTransition } from './spectrogram-axis-renderer.js';
import { startPlaybackIndicator, buildWaveformColorLUT, drawWaveformFromMinMax, rebuildWaveformColormapTexture } from './waveform-renderer.js';
import { setColormap, getCurrentColormap, updateAccentColors } from './colormaps.js';

// RAF loop to keep feature boxes in sync with the axis scale transition animation
let scaleTransitionBoxRAF = null;
function animateFeatureBoxesDuringScaleTransition() {
    if (scaleTransitionBoxRAF) cancelAnimationFrame(scaleTransitionBoxRAF);
    const tick = () => {
        const { inProgress } = getScaleTransitionState();
        updateAllFeatureBoxPositions();
        redrawAllCanvasFeatureBoxes();
        if (inProgress) {
            scaleTransitionBoxRAF = requestAnimationFrame(tick);
        } else {
            scaleTransitionBoxRAF = null;
        }
    };
    scaleTransitionBoxRAF = requestAnimationFrame(tick);
}

// Spectrogram selection state (pure canvas - separate overlay layer!)
let spectrogramSelectionActive = false;
let spectrogramWasDrag = false;  // True once drag exceeds 5px threshold
let spectrogramStartX = null;
let spectrogramStartY = null;
let spectrogramCurrentX = null;  // Current drag position (for canvas rendering)
let spectrogramCurrentY = null;  // Current drag position (for canvas rendering)
export let spectrogramSelectionBox = null;  // DEPRECATED - kept for compatibility during transition

// Overlay canvas for selection box (separate layer - no conflicts!)
let spectrogramOverlayCanvas = null;
let spectrogramOverlayCtx = null;

// Store completed boxes to redraw them all (replaces orange DOM boxes!)
// NOTE: We rebuild this from actual feature data, so it stays in sync!
let completedSelectionBoxes = [];

// ── Feature box drag/resize state ──
// Tracks in-progress move or edge/corner resize of an existing feature box.
// Set on mousedown over a box, cleared on mouseup.
let boxDragState = null;
// { boxIndex, mode, startMouseX, startMouseY, origBox: {startTime, endTime, lowFreq, highFreq} }
// mode: 'move' | 'edge-left' | 'edge-right' | 'edge-top' | 'edge-bottom'
//       | 'corner-tl' | 'corner-tr' | 'corner-bl' | 'corner-br'
let hoveredBoxInteraction = null; // current hover result for cursor + handle drawing
let hoveredBoxKey = null; // "regionIndex-featureIndex" of mouse-hovered box (all modes)

// Annotation fade timing (matches DOM approach)
const ANNOTATION_FADE_IN_MS = 400;
const ANNOTATION_FADE_OUT_MS = 600;
const ANNOTATION_MIN_DISPLAY_MS = 3000;
const ANNOTATION_LEAD_TIME_MS = 1500; // 1.5 seconds before feature box
const ANNOTATION_SLIDE_DISTANCE = 15; // pixels to slide up during fade-in

// Track annotation timing state: Map<"regionIndex-featureIndex", {showTime, hideTime, state}>
const annotationTimingState = new Map();

// Frame counter for debug logging
let debugFrameCounter = 0;

/**
 * Wrap text to fit within a maximum width
 * @param {CanvasRenderingContext2D} ctx - Canvas context with font already set
 * @param {string} text - Text to wrap
 * @param {number} maxWidth - Maximum width in pixels
 * @returns {string[]} Array of wrapped lines
 */
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

/**
 * Add a feature box to the canvas overlay
 * NOTE: Actually rebuilds from source - ensures sync with feature array!
 */
export function addCanvasFeatureBox(regionIndex, featureIndex, featureData) {
    // Rebuild from source to ensure sync (handles renumbering automatically!)
    rebuildCanvasBoxesFromFeatures();
}

/**
 * Remove a feature box from the canvas overlay
 * NOTE: Actually rebuilds from source - ensures sync with feature array!
 */
export function removeCanvasFeatureBox(regionIndex, featureIndex) {
    // Rebuild from source to ensure sync (handles renumbering automatically!)
    rebuildCanvasBoxesFromFeatures();
}

/**
 * Clear all feature boxes from the canvas overlay
 */
export function clearAllCanvasFeatureBoxes() {
    completedSelectionBoxes = [];
    annotationTimingState.clear();

    if (spectrogramOverlayCtx && spectrogramOverlayCanvas) {
        spectrogramOverlayCtx.clearRect(0, 0, spectrogramOverlayCanvas.width, spectrogramOverlayCanvas.height);
    }

    console.log('🧹 Cleared all canvas feature boxes');
}

/**
 * Show safeguard message when stuck state is detected
 */
function showStuckStateMessage() {
    const statusEl = document.getElementById('status');
    if (statusEl) {
        statusEl.textContent = 'Difficulty Creating Regions? Please refresh your page to continue. Thanks!';
        statusEl.style.color = '#ffa500'; // Orange color for warning (less alarming than red)
        statusEl.style.fontWeight = '600';
        console.warn('⚠️ [SAFEGUARD] Stuck state detected - showing safeguard message');
    }
}

/**
 * Hide safeguard message when state is restored
 */
function hideStuckStateMessage() {
    const statusEl = document.getElementById('status');
    if (statusEl) {
        // Only clear if it's our safeguard message (don't clear other status messages)
        if (statusEl.textContent.includes('Difficulty Creating Regions')) {
            statusEl.textContent = '';
            statusEl.style.color = ''; // Reset to default
            statusEl.style.fontWeight = '';
            console.log('✅ [SAFEGUARD] Stuck state resolved - hiding safeguard message');
        }
    }
}

/**
 * Check if a click point is within any canvas feature box
 * Returns {regionIndex, featureIndex} if clicked, null otherwise
 */
function getClickedBox(x, y) {
    if (!State.dataStartTime || !State.dataEndTime || !zoomState.isInitialized()) {
        return null;
    }
    
    const canvas = document.getElementById('spectrogram');
    if (!canvas) return null;
    
    // Convert click coordinates to device pixels
    const scaleX = canvas.width / canvas.offsetWidth;
    const scaleY = canvas.height / canvas.offsetHeight;
    const x_device = x * scaleX;
    const y_device = y * scaleY;
    
    // Check each box
    for (const box of completedSelectionBoxes) {
        // Convert box coordinates to device pixels (same logic as drawSavedBox)
        // 🔥 FIX: Use same source as drawSavedBox for consistent Y calculation
        const originalNyquist = State.originalDataFrequencyRange?.max || 50;
        const playbackRate = State.currentPlaybackRate || 1.0;
        
        // Get Y positions
        const scaleTransition = getScaleTransitionState();
        let lowFreqY_device, highFreqY_device;
        
        if (scaleTransition.inProgress && scaleTransition.oldScaleType) {
            const oldLowY = getYPositionForFrequencyScaled(box.lowFreq, originalNyquist, canvas.height, scaleTransition.oldScaleType, playbackRate);
            const newLowY = getYPositionForFrequencyScaled(box.lowFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
            const oldHighY = getYPositionForFrequencyScaled(box.highFreq, originalNyquist, canvas.height, scaleTransition.oldScaleType, playbackRate);
            const newHighY = getYPositionForFrequencyScaled(box.highFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
            
            lowFreqY_device = oldLowY + (newLowY - oldLowY) * scaleTransition.interpolationFactor;
            highFreqY_device = oldHighY + (newHighY - oldHighY) * scaleTransition.interpolationFactor;
        } else {
            lowFreqY_device = getYPositionForFrequencyScaled(box.lowFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
            highFreqY_device = getYPositionForFrequencyScaled(box.highFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
        }
        
        // Get X positions
        const interpolatedRange = getInterpolatedTimeRange();
        const displayStartMs = interpolatedRange.startTime.getTime();
        const displayEndMs = interpolatedRange.endTime.getTime();
        const displaySpanMs = displayEndMs - displayStartMs;
        
        const startTimestamp = new Date(box.startTime);
        const endTimestamp = new Date(box.endTime);
        const startMs = startTimestamp.getTime();
        const endMs = endTimestamp.getTime();
        
        const startProgress = (startMs - displayStartMs) / displaySpanMs;
        const endProgress = (endMs - displayStartMs) / displaySpanMs;
        
        const startX_device = startProgress * canvas.width;
        const endX_device = endProgress * canvas.width;
        
        // Check if click is within box bounds
        const boxX = Math.min(startX_device, endX_device);
        const boxY = Math.min(highFreqY_device, lowFreqY_device);
        const boxWidth = Math.abs(endX_device - startX_device);
        const boxHeight = Math.abs(lowFreqY_device - highFreqY_device);
        
        if (x_device >= boxX && x_device <= boxX + boxWidth &&
            y_device >= boxY && y_device <= boxY + boxHeight) {
            // Convert device-px box bounds back to CSS-px for screen positioning
            const canvasRect = canvas.getBoundingClientRect();
            return {
                regionIndex: box.regionIndex,
                featureIndex: box.featureIndex,
                screenRect: {
                    left:   canvasRect.left + boxX / scaleX,
                    right:  canvasRect.left + (boxX + boxWidth) / scaleX,
                    top:    canvasRect.top  + boxY / scaleY,
                    bottom: canvasRect.top  + (boxY + boxHeight) / scaleY
                }
            };
        }
    }
    
    return null;
}

/**
 * Check if a click (CSS px) hit the close button of any feature box.
 * Returns { regionIndex, featureIndex } or null.
 */
function getClickedCloseButton(x, y) {
    if (!State.dataStartTime || !State.dataEndTime || !zoomState.isInitialized()) return null;

    const canvas = document.getElementById('spectrogram');
    if (!canvas) return null;

    const scaleX = canvas.width / canvas.offsetWidth;
    const scaleY = canvas.height / canvas.offsetHeight;
    const x_device = x * scaleX;
    const y_device = y * scaleY;

    const closeSize = 12;
    const closePad = 6;
    const hitRadius = closeSize / 2 + 4; // generous hit target

    for (const box of completedSelectionBoxes) {
        const originalNyquist = State.originalDataFrequencyRange?.max || 50;
        const playbackRate = State.currentPlaybackRate || 1.0;

        const scaleTransition = getScaleTransitionState();
        let lowFreqY_device, highFreqY_device;

        if (scaleTransition.inProgress && scaleTransition.oldScaleType) {
            const oldLowY = getYPositionForFrequencyScaled(box.lowFreq, originalNyquist, canvas.height, scaleTransition.oldScaleType, playbackRate);
            const newLowY = getYPositionForFrequencyScaled(box.lowFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
            const oldHighY = getYPositionForFrequencyScaled(box.highFreq, originalNyquist, canvas.height, scaleTransition.oldScaleType, playbackRate);
            const newHighY = getYPositionForFrequencyScaled(box.highFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
            lowFreqY_device = oldLowY + (newLowY - oldLowY) * scaleTransition.interpolationFactor;
            highFreqY_device = oldHighY + (newHighY - oldHighY) * scaleTransition.interpolationFactor;
        } else {
            lowFreqY_device = getYPositionForFrequencyScaled(box.lowFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
            highFreqY_device = getYPositionForFrequencyScaled(box.highFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
        }

        const interpolatedRange = getInterpolatedTimeRange();
        const displayStartMs = interpolatedRange.startTime.getTime();
        const displayEndMs = interpolatedRange.endTime.getTime();
        const displaySpanMs = displayEndMs - displayStartMs;

        const startMs = new Date(box.startTime).getTime();
        const endMs = new Date(box.endTime).getTime();
        const startX_device = ((startMs - displayStartMs) / displaySpanMs) * canvas.width;
        const endX_device = ((endMs - displayStartMs) / displaySpanMs) * canvas.width;

        const bx = Math.min(startX_device, endX_device);
        const by = Math.min(highFreqY_device, lowFreqY_device);
        const bw = Math.abs(endX_device - startX_device);
        const bh = Math.abs(lowFreqY_device - highFreqY_device);

        // Skip if box too small for close button
        if (bw <= closeSize + closePad * 3 || bh <= closeSize + closePad * 3) continue;

        // Close button center
        const cx = bx + bw - closeSize / 2 - closePad;
        const cy = by + closePad + closeSize / 2;

        const dx = x_device - cx;
        const dy = y_device - cy;
        if (dx * dx + dy * dy <= hitRadius * hitRadius) {
            return { regionIndex: box.regionIndex, featureIndex: box.featureIndex };
        }
    }

    return null;
}

/**
 * Compute a box's device-pixel rect from its eternal coordinates.
 * Returns { x, y, w, h } in device pixels, or null if state not ready.
 */
function getBoxDeviceRect(box) {
    const canvas = document.getElementById('spectrogram');
    if (!canvas || !State.dataStartTime || !State.dataEndTime || !zoomState.isInitialized()) return null;

    const originalNyquist = State.originalDataFrequencyRange?.max || 50;
    const playbackRate = State.currentPlaybackRate || 1.0;
    const scaleTransition = getScaleTransitionState();
    let lowY, highY;

    if (scaleTransition.inProgress && scaleTransition.oldScaleType) {
        const oL = getYPositionForFrequencyScaled(box.lowFreq, originalNyquist, canvas.height, scaleTransition.oldScaleType, playbackRate);
        const nL = getYPositionForFrequencyScaled(box.lowFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
        const oH = getYPositionForFrequencyScaled(box.highFreq, originalNyquist, canvas.height, scaleTransition.oldScaleType, playbackRate);
        const nH = getYPositionForFrequencyScaled(box.highFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
        lowY = oL + (nL - oL) * scaleTransition.interpolationFactor;
        highY = oH + (nH - oH) * scaleTransition.interpolationFactor;
    } else {
        lowY = getYPositionForFrequencyScaled(box.lowFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
        highY = getYPositionForFrequencyScaled(box.highFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
    }

    const range = getInterpolatedTimeRange();
    const dStartMs = range.startTime.getTime();
    const dSpanMs = range.endTime.getTime() - dStartMs;
    const sMs = new Date(box.startTime).getTime();
    const eMs = new Date(box.endTime).getTime();
    const sX = ((sMs - dStartMs) / dSpanMs) * canvas.width;
    const eX = ((eMs - dStartMs) / dSpanMs) * canvas.width;

    return {
        x: Math.min(sX, eX),
        y: Math.min(highY, lowY),
        w: Math.abs(eX - sX),
        h: Math.abs(lowY - highY),
        canvasWidth: canvas.width,
        canvasHeight: canvas.height
    };
}

/**
 * Determine what interaction a mouse position (CSS px) implies on a feature box.
 * Returns { boxIndex, mode, screenRect } or null.
 * mode: 'move' | 'edge-left' | 'edge-right' | 'edge-top' | 'edge-bottom'
 *     | 'corner-tl' | 'corner-tr' | 'corner-bl' | 'corner-br'
 */
function getBoxInteraction(cssX, cssY) {
    const canvas = document.getElementById('spectrogram');
    if (!canvas) return null;

    const scaleX = canvas.width / canvas.offsetWidth;
    const scaleY = canvas.height / canvas.offsetHeight;
    const dx = cssX * scaleX;
    const dy = cssY * scaleY;

    const edgeTol = 4;
    const cornerTol = 5;

    for (let i = 0; i < completedSelectionBoxes.length; i++) {
        const rect = getBoxDeviceRect(completedSelectionBoxes[i]);
        if (!rect) continue;

        const { x, y, w, h } = rect;
        // Is mouse within the box (with edge tolerance extending outward)?
        if (dx < x - edgeTol || dx > x + w + edgeTol || dy < y - edgeTol || dy > y + h + edgeTol) continue;

        // Check corners first (higher priority)
        const nearLeft = Math.abs(dx - x) <= cornerTol;
        const nearRight = Math.abs(dx - (x + w)) <= cornerTol;
        const nearTop = Math.abs(dy - y) <= cornerTol;
        const nearBottom = Math.abs(dy - (y + h)) <= cornerTol;

        let mode;
        if (nearLeft && nearTop) mode = 'corner-tl';
        else if (nearRight && nearTop) mode = 'corner-tr';
        else if (nearLeft && nearBottom) mode = 'corner-bl';
        else if (nearRight && nearBottom) mode = 'corner-br';
        else if (nearLeft && dy > y && dy < y + h) mode = 'edge-left';
        else if (nearRight && dy > y && dy < y + h) mode = 'edge-right';
        else if (nearTop && dx > x && dx < x + w) mode = 'edge-top';
        else if (nearBottom && dx > x && dx < x + w) mode = 'edge-bottom';
        else if (dx >= x && dx <= x + w && dy >= y && dy <= y + h) mode = 'move';
        else continue;

        const canvasRect = canvas.getBoundingClientRect();
        return {
            boxIndex: i,
            mode,
            screenRect: {
                left: canvasRect.left + x / scaleX,
                right: canvasRect.left + (x + w) / scaleX,
                top: canvasRect.top + y / scaleY,
                bottom: canvasRect.top + (y + h) / scaleY
            }
        };
    }
    return null;
}

/**
 * Get the CSS cursor for a box interaction mode.
 */
function getCursorForMode(mode) {
    if (!mode) return null;
    switch (mode) {
        case 'move': return 'grab';
        case 'edge-left': case 'edge-right': return 'ew-resize';
        case 'edge-top': case 'edge-bottom': return 'ns-resize';
        case 'corner-tl': case 'corner-br': return 'nwse-resize';
        case 'corner-tr': case 'corner-bl': return 'nesw-resize';
        default: return null;
    }
}

/**
 * Convert a device-pixel X position to an ISO timestamp string.
 */
function deviceXToTimestamp(deviceX, canvasWidth) {
    const range = getInterpolatedTimeRange();
    const dStartMs = range.startTime.getTime();
    const dEndMs = range.endTime.getTime();
    const progress = deviceX / canvasWidth;
    return new Date(dStartMs + progress * (dEndMs - dStartMs)).toISOString();
}

/**
 * Convert a device-pixel Y position to a frequency (Hz).
 * Inverse of getYPositionForFrequencyScaled — inlined from region-tracker.js
 */
function deviceYToFrequency(deviceY, canvasHeight) {
    const originalNyquist = State.originalDataFrequencyRange?.max || 50;
    const playbackRate = State.currentPlaybackRate || 1.0;
    const scaleType = State.frequencyScale;
    const minFreq = getLogScaleMinFreq();

    if (scaleType === 'logarithmic') {
        // Exact inverse of getYPositionForFrequencyScaled log path:
        // forward: heightFromBottom_scaled = (normalizedLog * canvasHeight) * stretchFactor
        //          deviceY = canvasHeight - heightFromBottom_scaled
        const logMin = Math.log10(minFreq);
        const logMax = Math.log10(originalNyquist);
        const logRange = logMax - logMin;

        // Replicate calculateStretchFactorForLog inline (not exported)
        const targetMaxFreq = originalNyquist / playbackRate;
        const logTargetMax = Math.log10(Math.max(targetMaxFreq, minFreq));
        const targetLogRange = logTargetMax - logMin;
        const stretchFactor = 1 / (targetLogRange / logRange);

        const heightFromBottom_scaled = canvasHeight - deviceY;
        const heightFromBottom_1x = heightFromBottom_scaled / stretchFactor;
        const normalizedLog = heightFromBottom_1x / canvasHeight;
        const logFreq = logMin + normalizedLog * logRange;
        return Math.pow(10, logFreq);
    } else {
        // Exact inverse of linear/sqrt path:
        // forward: effectiveFreq = freq * playbackRate; normalized = (effectiveFreq - minFreq) / (nyquist - minFreq)
        const normalizedFromBottom = (canvasHeight - deviceY) / canvasHeight;
        if (scaleType === 'sqrt') {
            const normalized = normalizedFromBottom * normalizedFromBottom; // undo sqrt
            const effectiveFreq = normalized * (originalNyquist - minFreq) + minFreq;
            return effectiveFreq / playbackRate;
        } else {
            const effectiveFreq = normalizedFromBottom * (originalNyquist - minFreq) + minFreq;
            return effectiveFreq / playbackRate;
        }
    }
}

// ── Box Drag/Resize Handlers (self-contained, independent of selection system) ──

let boxDragWasDrag = false;
let boxDragStartX = null;
let boxDragStartY = null;

/**
 * Mousedown handler for box drag/resize. Returns true if event was claimed.
 */
function handleBoxDragDown(e, canvas) {
    const _mode = window.__EMIC_STUDY_MODE ? document.getElementById('viewingMode') : null;
    const isWindowed = _mode && (_mode.value === 'static' || _mode.value === 'scroll' || _mode.value === 'pageTurn');
    if (!isWindowed) return false;

    const canvasRect = canvas.getBoundingClientRect();
    const clickX = e.clientX - canvasRect.left;
    const clickY = e.clientY - canvasRect.top;

    // Check interaction (edges, corners, interior) — this has tolerance that extends outside box
    const interaction = getBoxInteraction(clickX, clickY);
    const clickedBox = getClickedBox(clickX, clickY);

    if (!interaction && !clickedBox) return false;

    if (interaction) {
        const box = completedSelectionBoxes[interaction.boxIndex];
        boxDragState = {
            boxIndex: interaction.boxIndex,
            mode: interaction.mode,
            startMouseX: clickX,
            startMouseY: clickY,
            origBox: { startTime: box.startTime, endTime: box.endTime, lowFreq: box.lowFreq, highFreq: box.highFreq },
            clickedBox: clickedBox || { regionIndex: box.regionIndex, featureIndex: box.featureIndex }
        };
        boxDragWasDrag = false;
        boxDragStartX = clickX;
        boxDragStartY = clickY;
    } else {
        // Inside box but no interaction mode — toggle popup
        if (featurePopupEl && popupFeatureBox &&
            popupFeatureBox.regionIndex === clickedBox.regionIndex &&
            popupFeatureBox.featureIndex === clickedBox.featureIndex) {
            closeFeaturePopup();
        } else {
            showFeaturePopup(clickedBox);
        }
    }
    return true; // claimed either way (don't start a selection on a box)
}

/**
 * Mousemove handler for box drag/resize. Returns true if event was claimed.
 * Also sets hover cursors for box edges/corners (even when not dragging).
 */
function handleBoxDragMove(e, canvas) {
    const canvasRect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - canvasRect.left;
    const mouseY = e.clientY - canvasRect.top;

    // Active drag — apply movement
    if (boxDragState) {
        if (!boxDragWasDrag) {
            const ddx = Math.abs(mouseX - boxDragStartX);
            const ddy = Math.abs(mouseY - boxDragStartY);
            if (Math.max(ddx, ddy) >= 5) {
                boxDragWasDrag = true;
            }
        }

        if (boxDragWasDrag) {
            canvas.style.cursor = boxDragState.mode === 'move' ? 'grabbing' : getCursorForMode(boxDragState.mode);

            const scaleX = canvas.width / canvas.offsetWidth;
            const scaleY = canvas.height / canvas.offsetHeight;
            const startDevX = boxDragState.startMouseX * scaleX;
            const startDevY = boxDragState.startMouseY * scaleY;
            const curDevX = mouseX * scaleX;
            const curDevY = mouseY * scaleY;

            const startTsMs = new Date(deviceXToTimestamp(startDevX, canvas.width)).getTime();
            const curTsMs = new Date(deviceXToTimestamp(curDevX, canvas.width)).getTime();
            const dtMs = curTsMs - startTsMs;

            const pixelDeltaY = curDevY - startDevY;
            const origNyquist = State.originalDataFrequencyRange?.max || 50;
            const pr = State.currentPlaybackRate || 1.0;
            const freqToPixY = (f) => getYPositionForFrequencyScaled(f, origNyquist, canvas.height, State.frequencyScale, pr);

            const orig = boxDragState.origBox;
            const box = completedSelectionBoxes[boxDragState.boxIndex];
            const mode = boxDragState.mode;

            if (mode === 'move') {
                box.startTime = new Date(new Date(orig.startTime).getTime() + dtMs).toISOString();
                box.endTime = new Date(new Date(orig.endTime).getTime() + dtMs).toISOString();
                box.lowFreq = deviceYToFrequency(freqToPixY(orig.lowFreq) + pixelDeltaY, canvas.height);
                box.highFreq = deviceYToFrequency(freqToPixY(orig.highFreq) + pixelDeltaY, canvas.height);
            } else {
                if (mode === 'edge-left' || mode === 'corner-tl' || mode === 'corner-bl')
                    box.startTime = new Date(new Date(orig.startTime).getTime() + dtMs).toISOString();
                if (mode === 'edge-right' || mode === 'corner-tr' || mode === 'corner-br')
                    box.endTime = new Date(new Date(orig.endTime).getTime() + dtMs).toISOString();
                if (mode === 'edge-top' || mode === 'corner-tl' || mode === 'corner-tr')
                    box.highFreq = deviceYToFrequency(freqToPixY(orig.highFreq) + pixelDeltaY, canvas.height);
                if (mode === 'edge-bottom' || mode === 'corner-bl' || mode === 'corner-br')
                    box.lowFreq = deviceYToFrequency(freqToPixY(orig.lowFreq) + pixelDeltaY, canvas.height);
            }

            redrawCanvasBoxes();
            syncPopupFieldsFromBox(box);
        }
        return true;
    }

    // Don't claim hover events during an active selection drag
    if (spectrogramSelectionActive) return false;

    // Not dragging — set hover cursor for box edges/corners (windowed mode only)
    const _modeHover = window.__EMIC_STUDY_MODE ? document.getElementById('viewingMode') : null;
    const isWindowed = _modeHover && (_modeHover.value === 'static' || _modeHover.value === 'scroll' || _modeHover.value === 'pageTurn');
    const interaction = isWindowed ? getBoxInteraction(mouseX, mouseY) : null;
    hoveredBoxInteraction = interaction;

    // Track hovered box for brightness highlight (windowed mode)
    if (interaction) {
        const box = completedSelectionBoxes[interaction.boxIndex];
        const newKey = box ? `${box.regionIndex}-${box.featureIndex}` : null;
        if (newKey !== hoveredBoxKey) {
            hoveredBoxKey = newKey;
            redrawCanvasBoxes();
        }
        canvas.style.cursor = interaction.mode === 'move' ? 'pointer' : getCursorForMode(interaction.mode);
        return true;
    }
    // Clear hover when mouse leaves all boxes
    if (hoveredBoxKey !== null) {
        hoveredBoxKey = null;
        redrawCanvasBoxes();
    }
    return false;
}

/**
 * Mouseup handler for box drag/resize. Returns true if event was claimed.
 */
function handleBoxDragUp(e, canvas) {
    if (!boxDragState) return false;

    const wasBoxDrag = boxDragWasDrag;
    const savedClickedBox = boxDragState.clickedBox;

    if (wasBoxDrag) {
        const box = completedSelectionBoxes[boxDragState.boxIndex];
        const isStandalone = box.regionIndex === -1;
        if (isStandalone) {
            const features = getStandaloneFeatures();
            const feature = features[box.featureIndex];
            if (feature) {
                feature.startTime = box.startTime;
                feature.endTime = box.endTime;
                feature.lowFreq = box.lowFreq;
                feature.highFreq = box.highFreq;
                saveStandaloneFeatures();
            }
        } else {
            const regions = getCurrentRegions();
            const feature = regions[box.regionIndex]?.features?.[box.featureIndex];
            if (feature) {
                feature.startTime = box.startTime;
                feature.endTime = box.endTime;
                feature.lowFreq = box.lowFreq;
                feature.highFreq = box.highFreq;
                updateFeature(box.regionIndex, box.featureIndex, feature);
            }
        }
        redrawAllCanvasFeatureBoxes();
    } else {
        // Toggle popup — close if same feature, open otherwise
        if (featurePopupEl && popupFeatureBox &&
            popupFeatureBox.regionIndex === savedClickedBox.regionIndex &&
            popupFeatureBox.featureIndex === savedClickedBox.featureIndex) {
            closeFeaturePopup();
        } else {
            showFeaturePopup(savedClickedBox);
        }
    }

    boxDragState = null;
    boxDragWasDrag = false;
    boxDragStartX = null;
    boxDragStartY = null;
    canvas.style.cursor = 'default';
    return true;
}

/** Cancel an in-progress box drag (restores original coordinates). */
function cancelBoxDrag() {
    if (!boxDragState) return;
    const box = completedSelectionBoxes[boxDragState.boxIndex];
    if (box) {
        box.startTime = boxDragState.origBox.startTime;
        box.endTime = boxDragState.origBox.endTime;
        box.lowFreq = boxDragState.origBox.lowFreq;
        box.highFreq = boxDragState.origBox.highFreq;
    }
    boxDragState = null;
    boxDragWasDrag = false;
    boxDragStartX = null;
    boxDragStartY = null;
    redrawCanvasBoxes();
}

// ── Feature Info Popup (windowed mode) ──────────────────────────
let featurePopupEl = null;
let featurePopupCleanup = null; // stores outside-click / keydown listeners for teardown
let popupFeatureBox = null;     // { regionIndex, featureIndex } of the popup's feature
let popupPinOffset = null;      // { dx, dy } drag offset from computed pinned position

/**
 * Update the popup's time/freq inputs to reflect the current box values (live drag).
 * Skips any input that has focus so we don't fight user edits.
 */
function syncPopupFieldsFromBox(box) {
    if (!featurePopupEl) return;
    const inputs = featurePopupEl.querySelectorAll('.feature-popup-field input');
    for (const input of inputs) {
        if (document.activeElement === input) continue;
        const key = input.dataset.key;
        if (key === 'startTime') {
            input.value = formatTimeForPopup(box.startTime);
            input.dataset.original = box.startTime || '';
        } else if (key === 'endTime') {
            input.value = formatTimeForPopup(box.endTime);
            input.dataset.original = box.endTime || '';
        } else if (key === 'lowFreq') {
            input.value = box.lowFreq ? parseFloat(box.lowFreq).toFixed(3) : '';
        } else if (key === 'highFreq') {
            input.value = box.highFreq ? parseFloat(box.highFreq).toFixed(3) : '';
        }
    }
}

function formatTimeForPopup(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    const h = d.getUTCHours();
    const m = String(d.getUTCMinutes()).padStart(2, '0');
    const s = String(d.getUTCSeconds()).padStart(2, '0');
    return `${h}:${m}:${s}`;
}

/**
 * Convert a short time string (e.g. "3:15:00") back to a full ISO string,
 * preserving the date from the original ISO value.
 */
function parsePopupTimeToISO(shortTime, originalISO) {
    if (!shortTime || !originalISO) return shortTime;
    const orig = new Date(originalISO);
    if (isNaN(orig.getTime())) return shortTime;
    const parts = shortTime.split(':').map(Number);
    if (parts.length < 2 || parts.some(isNaN)) return shortTime;
    orig.setUTCHours(parts[0], parts[1], parts[2] || 0, 0);
    return orig.toISOString();
}

export function closeFeaturePopup() {
    if (featurePopupEl) {
        featurePopupEl.remove();
        featurePopupEl = null;
    }
    if (featurePopupCleanup) {
        featurePopupCleanup();
        featurePopupCleanup = null;
    }
    popupFeatureBox = null;
    popupPinOffset = null;
}

/**
 * Compute the screen rect for a feature box (CSS pixels).
 * Returns { left, right, top, bottom } or null if off-screen / not ready.
 */
function getScreenRectForBox(box) {
    const rect = getBoxDeviceRect(box);
    if (!rect) return null;
    const canvas = document.getElementById('spectrogram');
    if (!canvas) return null;
    const canvasRect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / canvas.offsetWidth;
    const scaleY = canvas.height / canvas.offsetHeight;
    return {
        left:   canvasRect.left + rect.x / scaleX,
        right:  canvasRect.left + (rect.x + rect.w) / scaleX,
        top:    canvasRect.top  + rect.y / scaleY,
        bottom: canvasRect.top  + (rect.y + rect.h) / scaleY
    };
}

/**
 * Position a popup element beside a screen rect.
 * Returns { left, top } — the computed anchor position (before any drag offset).
 */
function positionPopupBesideRect(popup, sr, offset) {
    const gap = 20;
    const popupRect = popup.getBoundingClientRect();
    let left, top;

    if (sr) {
        const spaceRight = window.innerWidth - sr.right;
        const spaceLeft = sr.left;
        const boxCenterY = (sr.top + sr.bottom) / 2;

        if (spaceRight >= popupRect.width + gap || spaceRight >= spaceLeft) {
            left = sr.right + gap;
        } else {
            left = sr.left - popupRect.width - gap;
        }
        top = boxCenterY - popupRect.height / 2;
    } else {
        left = (window.innerWidth - popupRect.width) / 2;
        top = (window.innerHeight - popupRect.height) / 2;
    }

    // Store anchor position before offset
    const anchorLeft = left;
    const anchorTop = top;

    // Apply drag offset if any
    if (offset) {
        left += offset.dx;
        top += offset.dy;
    }

    // Clamp to viewport
    const pad = 8;
    left = Math.max(pad, Math.min(left, window.innerWidth - popupRect.width - pad));
    top = Math.max(pad, Math.min(top, window.innerHeight - popupRect.height - pad));
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;

    return { left: anchorLeft, top: anchorTop };
}

/**
 * Show a popup to view/edit feature info (for windowed/standalone features).
 * @param {{ regionIndex: number, featureIndex: number, screenRect?: {left,right,top,bottom} }} box
 */
function showFeaturePopup(box) {
    // Close any existing popup first
    closeFeaturePopup();

    // Track which feature this popup belongs to
    popupFeatureBox = { regionIndex: box.regionIndex, featureIndex: box.featureIndex };
    popupPinOffset = null;

    // Get feature data
    let feature;
    const isStandalone = box.regionIndex === -1;
    if (isStandalone) {
        const standalone = getStandaloneFeatures();
        feature = standalone[box.featureIndex];
    } else {
        const regions = getCurrentRegions();
        feature = regions[box.regionIndex]?.features?.[box.featureIndex];
    }
    if (!feature) return;

    // Build popup DOM
    const flatNum = getFlatFeatureNumber(box.regionIndex, box.featureIndex);
    const isAdvanced = document.getElementById('advancedMode')?.checked;
    const canDelete = isStandalone || (box.featureIndex > 0 && getCurrentRegions()[box.regionIndex]?.features?.length > 1);
    const popup = document.createElement('div');
    popup.className = 'feature-popup';
    popup.innerHTML = `
        <div class="feature-popup-header">
            <span class="feature-popup-title">Feature <strong>${flatNum}</strong></span>
            <div class="feature-popup-header-buttons">
                <span class="feature-popup-gear" role="button" aria-label="Feature settings" style="display:${isAdvanced ? 'inline-flex' : 'none'}">&#9881;</span>
                ${canDelete ? '<button class="feature-popup-delete" title="Delete this feature"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>' : ''}
                <button class="feature-popup-close" title="Close">&times;</button>
            </div>
        </div>
        <div class="feature-popup-settings">
            <div class="feature-popup-settings-row">
                <span class="feature-popup-settings-label">Color</span>
                <div class="feature-popup-settings-options" data-setting="feature_popup_color">
                    <button data-value="light-on-dark" class="active">Light on Dark</button>
                    <button data-value="dark-on-light">Dark on Light</button>
                </div>
            </div>
            <div class="feature-popup-settings-row">
                <span class="feature-popup-settings-label">Theme</span>
                <div class="feature-popup-settings-options" data-setting="feature_popup_theme">
                    <button data-value="standard" class="active">Standard</button>
                    <button data-value="match-colormap">Match Colormap</button>
                </div>
            </div>
            <div class="feature-popup-settings-row">
                <span class="feature-popup-settings-label">Pin</span>
                <div class="feature-popup-settings-options" data-setting="feature_popup_pin">
                    <button data-value="static" class="active">Static</button>
                    <button data-value="to-feature">To Feature</button>
                </div>
            </div>
        </div>
        <div class="feature-popup-row">
            <div class="feature-popup-field">
                <label>Start Time (UTC)</label>
                <input type="text" data-key="startTime" data-original="${feature.startTime || ''}" value="${formatTimeForPopup(feature.startTime)}" />
            </div>
            <div class="feature-popup-field">
                <label>End Time (UTC)</label>
                <input type="text" data-key="endTime" data-original="${feature.endTime || ''}" value="${formatTimeForPopup(feature.endTime)}" />
            </div>
        </div>
        <div class="feature-popup-row">
            <div class="feature-popup-field">
                <label>Low Freq (Hz)</label>
                <input type="text" data-key="lowFreq" value="${feature.lowFreq ? parseFloat(feature.lowFreq).toFixed(3) : ''}" />
            </div>
            <div class="feature-popup-field">
                <label>High Freq (Hz)</label>
                <input type="text" data-key="highFreq" value="${feature.highFreq ? parseFloat(feature.highFreq).toFixed(3) : ''}" />
            </div>
        </div>
        <textarea class="feature-popup-notes" placeholder="Describe this feature...">${feature.notes || ''}</textarea>
        <button class="feature-popup-save" disabled>Save</button>
    `;

    document.body.appendChild(popup);
    featurePopupEl = popup;

    // ── Gear settings logic ──
    const gearBtn = popup.querySelector('.feature-popup-gear');
    const settingsPanel = popup.querySelector('.feature-popup-settings');

    gearBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        settingsPanel.classList.toggle('open');
    });

    // Apply saved settings and wire up buttons
    function applyPopupSettings() {
        const colorMode = localStorage.getItem('feature_popup_color') || 'light-on-dark';
        const themeMode = localStorage.getItem('feature_popup_theme') || 'standard';

        popup.classList.toggle('feature-popup--dark-on-light', colorMode === 'dark-on-light');
        popup.classList.toggle('feature-popup--match-colormap', themeMode === 'match-colormap');

        // Update active button states
        settingsPanel.querySelectorAll('.feature-popup-settings-options').forEach(group => {
            const setting = group.dataset.setting;
            const currentVal = localStorage.getItem(setting) || group.querySelector('button').dataset.value;
            group.querySelectorAll('button').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.value === currentVal);
            });
        });
    }

    settingsPanel.querySelectorAll('.feature-popup-settings-options button').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const group = btn.closest('.feature-popup-settings-options');
            const setting = group.dataset.setting;
            localStorage.setItem(setting, btn.dataset.value);

            // Handle pin mode transitions
            if (setting === 'feature_popup_pin') {
                if (btn.dataset.value === 'to-feature') {
                    // Switching to pinned — reset offset and snap to feature
                    popupPinOffset = null;
                    updatePinnedPopupPosition();
                }
                // Switching to static — popup stays where it is, no action needed
            }

            applyPopupSettings();
        });
    });

    applyPopupSettings();

    // Position beside the feature box
    positionPopupBesideRect(popup, box.screenRect, null);

    // Forward wheel events to the spectrogram canvas so pan momentum isn't killed
    popup.addEventListener('wheel', (e) => {
        const canvas = document.getElementById('spectrogram');
        if (canvas) {
            canvas.dispatchEvent(new WheelEvent('wheel', e));
            e.preventDefault();
        }
    }, { passive: false });

    // Close button
    popup.querySelector('.feature-popup-close').addEventListener('click', closeFeaturePopup);

    // Delete button with confirmation
    popup.querySelector('.feature-popup-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        const isStandalone = box.regionIndex === -1;
        const label = `Feature ${getFlatFeatureNumber(box.regionIndex, box.featureIndex)}`;
        if (confirm(`Delete ${label}? This cannot be undone.`)) {
            if (isStandalone) {
                deleteStandaloneFeature(box.featureIndex);
                redrawAllCanvasFeatureBoxes();
                renderStandaloneFeaturesList();
            } else {
                deleteSpecificFeature(box.regionIndex, box.featureIndex);
            }
        }
    });

    // Draggable header
    const header = popup.querySelector('.feature-popup-header');
    let dragOffsetX = 0, dragOffsetY = 0, isDragging = false;
    let dragStartLeft = 0, dragStartTop = 0;
    header.addEventListener('mousedown', (ev) => {
        if (ev.target.closest('.feature-popup-close') || ev.target.closest('.feature-popup-gear') || ev.target.closest('.feature-popup-delete')) return;
        isDragging = true;
        dragOffsetX = ev.clientX - popup.offsetLeft;
        dragOffsetY = ev.clientY - popup.offsetTop;
        dragStartLeft = popup.offsetLeft;
        dragStartTop = popup.offsetTop;
        ev.preventDefault();
    });
    const onDragMove = (ev) => {
        if (!isDragging) return;
        const newLeft = ev.clientX - dragOffsetX;
        const newTop = ev.clientY - dragOffsetY;
        popup.style.left = `${newLeft}px`;
        popup.style.top = `${newTop}px`;
    };
    const onDragUp = () => {
        if (!isDragging) return;
        // In pinned mode, store cumulative drag offset
        const pinMode = localStorage.getItem('feature_popup_pin') || 'static';
        if (pinMode === 'to-feature') {
            const dx = (popupPinOffset?.dx || 0) + (popup.offsetLeft - dragStartLeft);
            const dy = (popupPinOffset?.dy || 0) + (popup.offsetTop - dragStartTop);
            popupPinOffset = { dx, dy };
        }
        isDragging = false;
    };
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragUp);

    // Store drag cleanup so closeFeaturePopup removes them
    const prevCleanup = featurePopupCleanup;
    featurePopupCleanup = () => {
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', onDragUp);
        if (prevCleanup) prevCleanup();
    };

    // Grab references
    const notesArea = popup.querySelector('.feature-popup-notes');
    const saveBtn = popup.querySelector('.feature-popup-save');

    // Auto-focus the notes textarea
    requestAnimationFrame(() => {
        notesArea.focus();
        // Place cursor at end of existing text
        notesArea.selectionStart = notesArea.selectionEnd = notesArea.value.length;
    });

    // Enable/disable save button based on notes content
    function updateSaveState() {
        const hasNotes = notesArea.value.trim().length > 0;
        saveBtn.disabled = !hasNotes;
    }
    notesArea.addEventListener('input', updateSaveState);
    updateSaveState();

    // Resolve input value — for time fields, reconstruct full ISO string from short format
    function resolveInputValue(input) {
        const key = input.dataset.key;
        const val = input.value.trim();
        if (!val) return val;
        if (key === 'startTime' || key === 'endTime') {
            return parsePopupTimeToISO(val, input.dataset.original);
        }
        return val;
    }

    // Live-update feature box as user edits time/frequency fields
    popup.querySelectorAll('input[data-key]').forEach(input => {
        input.addEventListener('input', () => {
            const key = input.dataset.key;
            const val = resolveInputValue(input);
            if (!val || !key) return;

            // Write directly to the feature object
            if (isStandalone) {
                const standalone = getStandaloneFeatures();
                const f = standalone[box.featureIndex];
                if (f) f[key] = val;
            } else {
                updateFeature(box.regionIndex, box.featureIndex, key, val);
            }

            // Redraw the canvas boxes to reflect the change
            redrawAllCanvasFeatureBoxes();
        });
    });

    // Save logic
    function saveAndClose() {
        if (isStandalone) {
            const standalone = getStandaloneFeatures();
            const f = standalone[box.featureIndex];
            if (f) {
                f.notes = notesArea.value.trim();
                // Update editable fields if changed
                popup.querySelectorAll('input[data-key]').forEach(input => {
                    const key = input.dataset.key;
                    const val = resolveInputValue(input);
                    if (val && key) f[key] = val;
                });
                saveStandaloneFeatures();
                renderStandaloneFeaturesList();
            }
        } else {
            updateFeature(box.regionIndex, box.featureIndex, 'notes', notesArea.value.trim());
            popup.querySelectorAll('input[data-key]').forEach(input => {
                const key = input.dataset.key;
                const val = resolveInputValue(input);
                if (val && key) updateFeature(box.regionIndex, box.featureIndex, key, val);
            });
        }
        rebuildCanvasBoxesFromFeatures();
        closeFeaturePopup();
    }

    // Enter in notes → save
    notesArea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            saveAndClose();
        }
    });

    saveBtn.addEventListener('click', saveAndClose);

    // Close on Escape or click outside
    function onKeyDown(e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            closeFeaturePopup();
        }
    }
    function onClickOutside(e) {
        if (featurePopupEl && !featurePopupEl.contains(e.target)) {
            // If clicking on the canvas, only keep popup open if clicking on a feature box
            const canvas = document.getElementById('spectrogram');
            if (canvas && canvas.contains(e.target)) {
                const rect = canvas.getBoundingClientRect();
                const scaleX = canvas.width / rect.width;
                const scaleY = canvas.height / rect.height;
                const clickX = (e.clientX - rect.left) * scaleX;
                const clickY = (e.clientY - rect.top) * scaleY;
                if (getClickedBox(clickX, clickY)) return; // Let box click handler toggle
            }
            closeFeaturePopup();
        }
    }
    // Delay attaching outside-click so the originating mousedown doesn't immediately close it
    setTimeout(() => {
        document.addEventListener('mousedown', onClickOutside, true);
    }, 0);
    document.addEventListener('keydown', onKeyDown, true);

    const dragCleanup = featurePopupCleanup;
    featurePopupCleanup = () => {
        document.removeEventListener('mousedown', onClickOutside, true);
        document.removeEventListener('keydown', onKeyDown, true);
        if (dragCleanup) dragCleanup();
    };
}

/**
 * Rebuild canvas boxes from actual feature data (keeps them in sync!)
 * Uses same logic as orange boxes - rebuilds from source of truth
 * This ensures boxes match the actual feature array (no orphans, numbers shift correctly)
 */
function rebuildCanvasBoxesFromFeatures() {
    const regions = getCurrentRegions();
    completedSelectionBoxes = [];

    // Rebuild boxes from region-based features
    if (regions) {
        regions.forEach((region, regionIndex) => {
            if (!region.features) return;

            region.features.forEach((feature, featureIndex) => {
                if (feature.lowFreq && feature.highFreq && feature.startTime && feature.endTime) {
                    completedSelectionBoxes.push({
                        regionIndex,
                        featureIndex,
                        startTime: feature.startTime,
                        endTime: feature.endTime,
                        lowFreq: parseFloat(feature.lowFreq),
                        highFreq: parseFloat(feature.highFreq),
                        notes: feature.notes
                    });
                }
            });
        });
    }

    // Rebuild boxes from standalone features (regionIndex = -1)
    const standalone = getStandaloneFeatures();
    standalone.forEach((feature, featureIndex) => {
        if (feature.lowFreq && feature.highFreq && feature.startTime && feature.endTime) {
            completedSelectionBoxes.push({
                regionIndex: -1,
                featureIndex,
                startTime: feature.startTime,
                endTime: feature.endTime,
                lowFreq: parseFloat(feature.lowFreq),
                highFreq: parseFloat(feature.highFreq),
                notes: feature.notes
            });
        }
    });

    // Redraw with rebuilt boxes
    redrawCanvasBoxes();
}

/**
 * Redraw canvas boxes (internal - clears and draws all boxes)
 */
function redrawCanvasBoxes() {
    if (spectrogramOverlayCtx && spectrogramOverlayCanvas) {
        spectrogramOverlayCtx.clearRect(0, 0, spectrogramOverlayCanvas.width, spectrogramOverlayCanvas.height);
        for (const savedBox of completedSelectionBoxes) {
            drawSavedBox(spectrogramOverlayCtx, savedBox);
        }
        // Preserve in-progress selection box if user is currently dragging
        if (spectrogramSelectionActive) {
            drawSpectrogramSelectionBox(spectrogramOverlayCtx, spectrogramOverlayCanvas.width, spectrogramOverlayCanvas.height);
        }
    }
    // Also update pinned popup position when boxes are redrawn
    updatePinnedPopupPosition();
}

/**
 * Redraw all canvas feature boxes (called after zoom, speed change, deletion, etc.)
 * Rebuilds from source of truth to stay in sync!
 */
export function redrawAllCanvasFeatureBoxes() {
    rebuildCanvasBoxesFromFeatures();
}

/**
 * Update canvas annotations every frame (handles timing/fade animations)
 * Called from animation loop - does NOT rebuild boxes, just redraws with current timing
 */
export function updateCanvasAnnotations() {
    debugFrameCounter++;

    // DEBUG: Print once to verify function is running
    if (debugFrameCounter === 1) {
        console.log(`🎬 updateCanvasAnnotations() IS RUNNING! First call.`);
    }


    if (spectrogramOverlayCtx && spectrogramOverlayCanvas) {
        spectrogramOverlayCtx.clearRect(0, 0, spectrogramOverlayCanvas.width, spectrogramOverlayCanvas.height);

        // PASS 1: Draw all boxes (without annotations)
        for (const savedBox of completedSelectionBoxes) {
            drawSavedBox(spectrogramOverlayCtx, savedBox, false); // false = don't draw annotations yet
        }

        // PASS 2: Draw all annotations on top (with collision detection)
        const placedAnnotations = []; // Track placed annotations for collision detection
        for (const savedBox of completedSelectionBoxes) {
            drawSavedBox(spectrogramOverlayCtx, savedBox, true, placedAnnotations); // true = only draw annotations
        }

        // PASS 3: Draw in-progress selection box (if user is currently dragging)
        if (spectrogramSelectionActive) {
            drawSpectrogramSelectionBox(spectrogramOverlayCtx, spectrogramOverlayCanvas.width, spectrogramOverlayCanvas.height);
        }

        // DEBUG: Show timing numbers on canvas
        if (completedSelectionBoxes.length > 0 && State.currentAudioPosition !== undefined && zoomState.isInitialized()) {
            const currentAudioSec = State.currentAudioPosition;

            // Find first feature box
            const firstBox = completedSelectionBoxes[0];
            if (firstBox && firstBox.startTime && State.dataStartTime && State.dataEndTime) {
                // Convert timestamp to sample index (progress through dataset)
                const timestampMs = new Date(firstBox.startTime).getTime();
                const dataStartMs = State.dataStartTime.getTime();
                const dataEndMs = State.dataEndTime.getTime();
                const progress = (timestampMs - dataStartMs) / (dataEndMs - dataStartMs);
                const totalSamples = zoomState.totalSamples;
                const featureStartSample = progress * totalSamples;

                // Convert current audio position to sample
                const currentSample = zoomState.timeToSample(currentAudioSec);

                // Simple subtraction
                const samplesToFeature = featureStartSample - currentSample;
                const playbackRate = State.currentPlaybackRate || 1.0;
                const timeUntilFeature = (samplesToFeature / (44.1 * playbackRate)) / 1000; // Wall-clock seconds
            }
        }
    }

    // PASS 4: Update pinned popup position
    updatePinnedPopupPosition();
}

/**
 * Reposition the feature popup if it's pinned to its feature box.
 * Called per-frame from updateCanvasAnnotations and also from redrawCanvasBoxes.
 */
function updatePinnedPopupPosition() {
    if (!featurePopupEl || !popupFeatureBox) return;
    const pinMode = localStorage.getItem('feature_popup_pin') || 'static';
    if (pinMode !== 'to-feature') return;

    // Find the matching box in completedSelectionBoxes
    const box = completedSelectionBoxes.find(b =>
        b.regionIndex === popupFeatureBox.regionIndex &&
        b.featureIndex === popupFeatureBox.featureIndex
    );
    if (!box) return;

    const sr = getScreenRectForBox(box);
    if (!sr) {
        // Feature is off-screen — hide popup
        featurePopupEl.classList.add('feature-popup--off-screen');
        return;
    }

    // Check if feature box is fully off the canvas viewport
    const canvas = document.getElementById('spectrogram');
    if (canvas) {
        const canvasRect = canvas.getBoundingClientRect();
        if (sr.right < canvasRect.left || sr.left > canvasRect.right ||
            sr.bottom < canvasRect.top || sr.top > canvasRect.bottom) {
            featurePopupEl.classList.add('feature-popup--off-screen');
            return;
        }
    }

    // Feature is on-screen — show and reposition
    featurePopupEl.classList.remove('feature-popup--off-screen');
    positionPopupBesideRect(featurePopupEl, sr, popupPinOffset);
}

// 🔥 FIX: Track event listeners for cleanup to prevent memory leaks
let spectrogramMouseUpHandler = null;
let spectrogramKeyDownHandler = null;
let spectrogramSelectionSetup = false;
let spectrogramFocusBlurHandler = null;
let spectrogramVisibilityHandler = null;
let spectrogramFocusHandler = null;
let spectrogramBlurHandler = null;
let spectrogramResizeObserver = null;
let spectrogramRepositionOnVisibility = null;

// 🔥 FIX: Safety timeout to auto-cancel if mouseup never fires
let spectrogramSelectionTimeout = null;

export function drawSpectrogram() {
    console.log(`📺 [spectrogram-renderer.js] drawSpectrogram CALLED`);
    console.trace('📍 Call stack:');
    
    // 🔥 FIX: Copy State values to local variables IMMEDIATELY to break closure chain
    // This prevents RAF callbacks from capturing the entire State module
    // Access State only once at the start, then use local variables throughout
    const currentRAF = State.spectrogramRAF;
    const analyserNode = State.analyserNode;
    const playbackState = State.playbackState;
    const frequencyScale = State.frequencyScale;
    const spectrogramInitialized = State.spectrogramInitialized;
    
    // Clear RAF ID immediately to prevent duplicate scheduling
    // This must happen FIRST before any early returns to prevent accumulation
    State.setSpectrogramRAF(null);
    if (currentRAF !== null) {
        cancelAnimationFrame(currentRAF);
    }
    
    // 🔥 FIX: Check if document is still connected (not detached) before proceeding
    // This prevents RAF callbacks from retaining references to detached documents
    if (!document.body || !document.body.isConnected) {
        return; // Document is detached, stop the loop
    }
    
    // Early exit: no analyser - stop the loop completely
    if (!analyserNode) return;
    
    // Early exit: not playing - schedule next frame to keep checking
    if (playbackState !== PlaybackState.PLAYING) {
        // 🔥 FIX: Only schedule RAF if document is still connected and not already scheduled
        if (document.body && document.body.isConnected && State.spectrogramRAF === null) {
        State.setSpectrogramRAF(requestAnimationFrame(drawSpectrogram));
        }
        return;
    }
    
    const canvas = document.getElementById('spectrogram');
    const ctx = canvas.getContext('2d');

    // If ctx is null, the canvas is owned by Three.js (WebGL) — skip real-time drawing
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    
    // Clear entire canvas only on first initialization
    if (!spectrogramInitialized) {
        ctx.clearRect(0, 0, width, height);
        State.setSpectrogramInitialized(true);
    }
    
    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyserNode.getByteFrequencyData(dataArray);
    
    // Helper function to calculate y position based on frequency scale
    const getYPosition = (binIndex, totalBins, canvasHeight) => {
        if (frequencyScale === 'logarithmic') {
            // Logarithmic scale: strong emphasis on lower frequencies
            // Map bin index to log scale (avoiding log(0))
            const minFreq = 1; // Minimum frequency bin (avoid log(0))
            const maxFreq = totalBins;
            const logMin = Math.log10(minFreq);
            const logMax = Math.log10(maxFreq);
            const logFreq = Math.log10(Math.max(binIndex + 1, minFreq));
            const normalizedLog = (logFreq - logMin) / (logMax - logMin);
            return canvasHeight - (normalizedLog * canvasHeight);
        } else if (frequencyScale === 'sqrt') {
            // Square root scale: gentle emphasis on lower frequencies (good middle ground)
            const normalized = binIndex / totalBins;
            const sqrtNormalized = Math.sqrt(normalized);
            return canvasHeight - (sqrtNormalized * canvasHeight);
        } else {
            // Linear scale (default) - even spacing
            return canvasHeight - (binIndex / totalBins) * canvasHeight;
        }
    };
    
    // Scroll 1 pixel per frame (standard scrolling behavior)
            ctx.drawImage(canvas, -1, 0);
            ctx.clearRect(width - 1, 0, 1, height);
            
            // Draw new column
            for (let i = 0; i < bufferLength; i++) {
                const value = dataArray[i];
                const percent = value / 255;
                const hue = percent * 60;
                const saturation = 100;
                const lightness = 10 + (percent * 60);
                const y = getYPosition(i, bufferLength, height);
                const nextY = getYPosition(i + 1, bufferLength, height);
                const barHeight = Math.max(1, Math.abs(y - nextY));
                ctx.fillStyle = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
                ctx.fillRect(width - 1, nextY, 1, barHeight);
    }
    
    // 🔥 FIX: Store RAF ID for proper cleanup
    // Only schedule if document is still connected and not already scheduled
    // This prevents creating multiple RAF callbacks that accumulate
    if (document.body && document.body.isConnected && State.spectrogramRAF === null) {
    State.setSpectrogramRAF(requestAnimationFrame(drawSpectrogram));
    } else {
        // Document is detached or already scheduled - stop the loop
        State.setSpectrogramRAF(null);
            }
}


/**
 * Load frequency scale from localStorage and apply it
 * Called on page load to restore user's preferred frequency scale
 */
export function loadFrequencyScale() {
    const select = document.getElementById('frequencyScale');
    if (!select) return;
    
    // Load saved value from localStorage (default: 'logarithmic' for CDAWeb space physics data)
    const savedValue = localStorage.getItem('frequencyScale');
    if (savedValue !== null) {
        // Validate value is one of the allowed options
        const validValues = ['linear', 'sqrt', 'logarithmic'];
        if (validValues.includes(savedValue)) {
            select.value = savedValue;
            State.setFrequencyScale(savedValue);
            console.log(`📊 Loaded saved frequency scale: ${savedValue}`);
        }
    } else {
        // No saved value, use default (logarithmic for space physics) and save it
        const defaultValue = 'logarithmic';
        select.value = defaultValue;
        State.setFrequencyScale(defaultValue);
        localStorage.setItem('frequencyScale', defaultValue);
    }
}

/**
 * Load saved colormap from localStorage
 */
export function loadColormap() {
    const select = document.getElementById('colormap');
    if (!select) return;

    const savedValue = localStorage.getItem('colormap');
    if (savedValue) {
        const validValues = ['solar', 'turbo', 'viridis', 'inferno', 'aurora', 'plasma', 'jet'];
        if (validValues.includes(savedValue)) {
            select.value = savedValue;
            setColormap(savedValue);
            updateAccentColors();
            console.log(`🎨 Loaded saved colormap: ${savedValue}`);
        }
    } else {
        // No saved value, use default (inferno) and save it
        const defaultValue = 'inferno';
        select.value = defaultValue;
        setColormap(defaultValue);
        updateAccentColors();
        localStorage.setItem('colormap', defaultValue);
    }
}

/**
 * Change colormap and re-render spectrogram
 */
export async function changeColormap() {
    const select = document.getElementById('colormap');
    const value = select.value;

    // If already on this colormap, don't process again
    if (getCurrentColormap() === value) {
        console.log(`🎨 Already using ${value} colormap - skipping change`);
        return;
    }

    // Save to localStorage for persistence
    localStorage.setItem('colormap', value);

    // Update the colormap (rebuilds spectrogram LUT)
    setColormap(value);

    // Rebuild the GPU colormap texture for Three.js renderer
    onColormapChanged();

    // Update UI accent colors to match colormap
    updateAccentColors();

    // Also rebuild the waveform color LUT (brighter version of colormap)
    buildWaveformColorLUT();

    // Rebuild waveform GPU colormap texture and re-render
    rebuildWaveformColormapTexture();
    drawWaveformFromMinMax();

    // Blur dropdown so spacebar can toggle play/pause
    select.blur();

    if (!isStudyMode()) {
        console.log(`🎨 Colormap changed to: ${value}`);
    }

    // Re-render the spectrogram if one is already rendered
    if (isCompleteSpectrogramRendered()) {
        // Clear cached spectrogram and re-render with new colormap
        clearCompleteSpectrogram();
        await renderCompleteSpectrogram();
    }
}

/**
 * Change FFT size for spectrogram rendering
 * Lower values = better time resolution, worse frequency resolution
 * Higher values = better frequency resolution, worse time resolution
 */
export async function changeFftSize() {
    const select = document.getElementById('fftSize');
    const value = parseInt(select.value, 10);

    // If already using this FFT size, don't process again
    if (State.fftSize === value) {
        console.log(`📐 Already using FFT size ${value} - skipping change`);
        return;
    }

    // Save to localStorage for persistence
    localStorage.setItem('fftSize', value.toString());

    // Update state
    State.setFftSize(value);

    // Blur dropdown so spacebar can toggle play/pause
    select.blur();

    console.log(`📐 FFT size changed to: ${value}`);

    // Re-render the spectrogram if one is already rendered
    if (isCompleteSpectrogramRendered()) {
        // Check if we're zoomed into a region
        if (zoomState.isInitialized() && zoomState.isInRegion()) {
            // Zoomed in: re-render both the region view AND the elastic friend
            const regionRange = zoomState.getRegionRange();
            console.log(`📐 Zoomed into region - re-rendering region view + elastic friend`);

            // Convert Date objects to seconds
            const dataStartMs = State.dataStartTime ? State.dataStartTime.getTime() : 0;
            const startSeconds = (regionRange.startTime.getTime() - dataStartMs) / 1000;
            const endSeconds = (regionRange.endTime.getTime() - dataStartMs) / 1000;

            // Clear and re-render the region view
            resetSpectrogramState();
            await renderCompleteSpectrogramForRegion(startSeconds, endSeconds, false);

            // Update feature box positions after re-render
            updateAllFeatureBoxPositions();
            redrawAllCanvasFeatureBoxes();

            // Update the elastic friend in background (for zoom-out)
            console.log(`🏠 Starting background render of full spectrogram for elastic friend...`);
            updateElasticFriendInBackground();
        } else if (zoomState.isInitialized()) {
            // Scroll-zoomed in (not in a region): render viewport first, full texture in background
            const dataStartMs = State.dataStartTime.getTime();
            const dataEndMs = State.dataEndTime.getTime();
            const dataDuration = (dataEndMs - dataStartMs) / 1000;

            const startMs = zoomState.currentViewStartTime.getTime();
            const endMs = zoomState.currentViewEndTime.getTime();
            const startSeconds = (startMs - dataStartMs) / 1000;
            const endSeconds = (endMs - dataStartMs) / 1000;
            const viewSpan = endSeconds - startSeconds;

            // 30% padding so minor scrolling stays within hi-res bounds
            const padding = viewSpan * 0.3;
            const expandedStart = Math.max(0, startSeconds - padding);
            const expandedEnd = Math.min(dataDuration, endSeconds + padding);

            console.log(`📐 Scroll-zoomed — hi-res viewport first (${viewSpan.toFixed(0)}s), full texture in background`);

            // Render just the viewport at hi-res (fast — small region)
            resetSpectrogramState();
            await renderCompleteSpectrogramForRegion(expandedStart, expandedEnd, false);
            setScrollZoomHiRes(expandedStart, expandedEnd);
            updateSpectrogramViewportFromZoom();

            // Update feature box positions after re-render
            updateAllFeatureBoxPositions();
            redrawAllCanvasFeatureBoxes();

            // Full texture in background (elastic friend for zoom-out)
            console.log(`🏠 Starting background render of full spectrogram for elastic friend...`);
            updateElasticFriendInBackground();
        } else {
            // Full view: clear and re-render
            clearCompleteSpectrogram();
            await renderCompleteSpectrogram();

            // Update feature box positions after re-render
            updateAllFeatureBoxPositions();
            redrawAllCanvasFeatureBoxes();
        }
    }
}

/**
 * Load saved FFT size from localStorage on page load
 */
export function loadFftSize() {
    const saved = localStorage.getItem('fftSize');
    if (saved) {
        const value = parseInt(saved, 10);
        // Validate the saved value is a valid option
        const validSizes = [512, 1024, 2048, 4096, 8192];
        if (validSizes.includes(value)) {
            State.setFftSize(value);
            const select = document.getElementById('fftSize');
            if (select) {
                select.value = value.toString();
            }
            console.log(`📐 Loaded saved FFT size: ${value}`);
        }
    }
}

export async function changeFrequencyScale() {
    const select = document.getElementById('frequencyScale');
    const value = select.value; // 'linear', 'sqrt', or 'logarithmic'

    // If already on this scale, don't process again
    if (State.frequencyScale === value) {
        console.log(`📊 Already on ${value} scale - skipping change`);
        return;
    }

    // Save to localStorage for persistence
    localStorage.setItem('frequencyScale', value);

    // Store old scale for animation
    const oldScale = State.frequencyScale;

    State.setFrequencyScale(value);

    // Use statically imported function (no dynamic import needed)
    
    // 🎓 Tutorial: Resolve promise if waiting for frequency scale change
    if (State.waitingForFrequencyScaleChange && State._frequencyScaleChangeResolve) {
        State.setWaitingForFrequencyScaleChange(false);
        const resolve = State._frequencyScaleChangeResolve;
        State.setFrequencyScaleChangeResolve(null);
        resolve();
    }
    
    // Blur dropdown so spacebar can toggle play/pause
    select.blur();
    
    if (!isStudyMode()) {
        console.log(`📊 Frequency scale changed to: ${value}`);
    }
    
    // 🔍 Diagnostic: Check state before animation decision
    if (!isStudyMode()) {
        console.log(`🎨 [changeFrequencyScale] Checking if we should animate:`, {
            hasComplete: isCompleteSpectrogramRendered(),
            oldScale: oldScale,
            newScale: value,
            inRegion: zoomState.isInRegion()
        });
    }
    
    // If complete spectrogram is rendered, animate transition
    if (isCompleteSpectrogramRendered()) {
        // console.log('✅ Animation path - have rendered spectrogram');
        if (!isStudyMode()) {
            console.log('🎨 Starting scale transition (axis + spectrogram in parallel)...');
        }
        
        // Start axis animation immediately (don't wait for it)
        // Use statically imported function
        const axisAnimationPromise = animateScaleTransition(oldScale);
        
        // Start spectrogram rendering immediately (in parallel with axis animation)
        if (!isStudyMode()) {
            console.log('🎨 Starting spectrogram re-render...');
        }
        
        // 🔥 PAUSE playhead updates during fade!
        const playbackWasActive = State.playbackState === State.PlaybackState.PLAYING;
        const originalRAF = State.playbackIndicatorRAF;
        if (originalRAF !== null) {
            cancelAnimationFrame(originalRAF);
            State.setPlaybackIndicatorRAF(null);
        }
        
        const canvas = document.getElementById('spectrogram');
        if (canvas) {
            // Check if we're zoomed into a region
            if (zoomState.isInitialized() && zoomState.isInRegion()) {
                const regionRange = zoomState.getRegionRange();

                const dataStartMs = State.dataStartTime ? State.dataStartTime.getTime() : 0;
                const startSeconds = (regionRange.startTime.getTime() - dataStartMs) / 1000;
                const endSeconds = (regionRange.endTime.getTime() - dataStartMs) / 1000;

                // Re-render region with new frequency scale (Three.js GPU render)
                resetSpectrogramState();
                await renderCompleteSpectrogramForRegion(startSeconds, endSeconds);

                const playbackRate = State.currentPlaybackRate || 1.0;
                updateSpectrogramViewport(playbackRate);
                updateAllFeatureBoxPositions();
                redrawAllCanvasFeatureBoxes();

                // Animate feature boxes in sync with the axis scale transition
                animateFeatureBoxesDuringScaleTransition();

                if (playbackWasActive) {
                    startPlaybackIndicator();
                }

                if (!isStudyMode()) console.log('Region scale transition complete');
                updateElasticFriendInBackground();
                return;
            }
            
            // Re-render full view with new frequency scale (Three.js GPU render)
            resetSpectrogramState();
            await renderCompleteSpectrogram();

            const playbackRate = State.currentPlaybackRate || 1.0;
            updateSpectrogramViewport(playbackRate);
            updateAllFeatureBoxPositions();
            redrawAllCanvasFeatureBoxes();

            // Animate feature boxes in sync with the axis scale transition
            animateFeatureBoxesDuringScaleTransition();

            if (playbackWasActive) {
                startPlaybackIndicator();
            }

            if (!isStudyMode()) console.log('Scale transition complete');
        }
    } else {
        console.log('⚠️ No animation - no rendered spectrogram');
        // No spectrogram yet, just update axis
        positionAxisCanvas();
        initializeAxisPlaybackRate();
        drawFrequencyAxis();

        // Update feature box positions for new frequency scale (even if no spectrogram yet)
        updateAllFeatureBoxPositions();
        redrawAllCanvasFeatureBoxes(); // Update canvas boxes too!
    }
}

export function startVisualization() {
    // Only start visualization once to prevent multiple animation loops
    if (State.visualizationStarted) {
        return;
    }
    State.setVisualizationStarted(true);
    
    // Initialize axis positioning and drawing
    positionAxisCanvas();
    // Draw initial axis (will use current playback rate)
    drawFrequencyAxis();
    
    drawSpectrogram();
}

/**
 * Setup spectrogram frequency selection
 * Called from main.js after DOM is ready
 */
export function setupSpectrogramSelection() {
    // 🔥 FIX: Only setup once to prevent duplicate event listeners
    if (spectrogramSelectionSetup) {
        console.warn('⚠️ [SETUP] setupSpectrogramSelection() called again but already setup - ignoring');
        return;
    }

    console.log('✅ [SETUP] Setting up spectrogram selection (first time)');

    const canvas = document.getElementById('spectrogram');
    if (!canvas) {
        console.warn('⚠️ [SETUP] Canvas not found - cannot setup selection');
        return;
    }

    // Use the panel as container (same as waveform selection)
    const container = canvas.closest('.panel');
    if (!container) return;
    
    // ✅ Create overlay canvas for selection box (separate layer - no conflicts!)
    spectrogramOverlayCanvas = document.createElement('canvas');
    spectrogramOverlayCanvas.id = 'spectrogram-selection-overlay';
    spectrogramOverlayCanvas.style.position = 'absolute';
    spectrogramOverlayCanvas.style.pointerEvents = 'none';  // Pass events through to main canvas
    spectrogramOverlayCanvas.style.zIndex = '20';  // Above spectrogram glow and other panels
    spectrogramOverlayCanvas.style.background = 'transparent';  // See through to spectrogram
    
    // Match main canvas size and position EXACTLY
    const canvasRect = canvas.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    spectrogramOverlayCanvas.style.left = (canvasRect.left - containerRect.left) + 'px';
    spectrogramOverlayCanvas.style.top = (canvasRect.top - containerRect.top) + 'px';
    
    // Use SAME dimensions as main canvas
    spectrogramOverlayCanvas.width = canvas.width;
    spectrogramOverlayCanvas.height = canvas.height;
    spectrogramOverlayCanvas.style.width = canvas.offsetWidth + 'px';
    spectrogramOverlayCanvas.style.height = canvas.offsetHeight + 'px';
    
    spectrogramOverlayCtx = spectrogramOverlayCanvas.getContext('2d');
    container.appendChild(spectrogramOverlayCanvas);
    
    // 🔥 SLEEP FIX: Update overlay position when canvas resizes or layout changes
    // After sleep, browser may recalculate layout causing misalignment
    // This ResizeObserver keeps overlay aligned with main canvas (like playhead overlay does)
    spectrogramResizeObserver = new ResizeObserver(() => {
        if (spectrogramOverlayCanvas && canvas) {
            const canvasRect = canvas.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            spectrogramOverlayCanvas.style.left = (canvasRect.left - containerRect.left) + 'px';
            spectrogramOverlayCanvas.style.top = (canvasRect.top - containerRect.top) + 'px';
            // Only resize if dimensions changed (resizing clears the canvas, causing flicker)
            if (spectrogramOverlayCanvas.width !== canvas.width || spectrogramOverlayCanvas.height !== canvas.height) {
                spectrogramOverlayCanvas.width = canvas.width;
                spectrogramOverlayCanvas.height = canvas.height;
            }
            spectrogramOverlayCanvas.style.width = canvas.offsetWidth + 'px';
            spectrogramOverlayCanvas.style.height = canvas.offsetHeight + 'px';

            // Redraw boxes after repositioning to ensure they're still visible
            if (spectrogramOverlayCtx) {
                redrawCanvasBoxes();
            }
        }
    });
    spectrogramResizeObserver.observe(canvas);

    // Also reposition on visibility change (catches sleep/wake)
    spectrogramRepositionOnVisibility = () => {
        if (document.visibilityState === 'visible' && spectrogramOverlayCanvas && canvas) {
            const canvasRect = canvas.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            spectrogramOverlayCanvas.style.left = (canvasRect.left - containerRect.left) + 'px';
            spectrogramOverlayCanvas.style.top = (canvasRect.top - containerRect.top) + 'px';
            // Only resize if dimensions changed (resizing clears the canvas, causing flicker)
            if (spectrogramOverlayCanvas.width !== canvas.width || spectrogramOverlayCanvas.height !== canvas.height) {
                spectrogramOverlayCanvas.width = canvas.width;
                spectrogramOverlayCanvas.height = canvas.height;
            }
            spectrogramOverlayCanvas.style.width = canvas.offsetWidth + 'px';
            spectrogramOverlayCanvas.style.height = canvas.offsetHeight + 'px';

            // Redraw boxes after repositioning
            if (spectrogramOverlayCtx) {
                redrawCanvasBoxes();
            }
        }
    };
    document.addEventListener('visibilitychange', spectrogramRepositionOnVisibility);
    
    console.log('✅ Created spectrogram selection overlay canvas:', {
        left: spectrogramOverlayCanvas.style.left,
        top: spectrogramOverlayCanvas.style.top,
        width: spectrogramOverlayCanvas.width,
        height: spectrogramOverlayCanvas.height,
        styleWidth: spectrogramOverlayCanvas.style.width,
        styleHeight: spectrogramOverlayCanvas.style.height,
        canvasWidth: canvas.width,
        canvasOffsetWidth: canvas.offsetWidth
    });

    // 🔥 SLEEP FIX: Clean up on visibility change (computer wake from sleep!)
    // This immediately cancels any stuck selection when page becomes visible again
    spectrogramVisibilityHandler = () => {
        if (document.visibilityState === 'visible') {
            // 🔍 DEBUG: Log zoom state after sleep/wake
            console.log('👁️ [SLEEP WAKE] Page visible again - checking zoom state:', {
                zoomStateInitialized: zoomState.isInitialized(),
                isInRegion: zoomState.isInitialized() ? zoomState.isInRegion() : 'N/A (not initialized)',
                zoomMode: zoomState.isInitialized() ? zoomState.mode : 'N/A',
                activeRegionId: zoomState.isInitialized() ? zoomState.activeRegionId : 'N/A',
                currentViewStartSample: zoomState.isInitialized() ? zoomState.currentViewStartSample : 'N/A'
            });
            
            // Just became visible (e.g., woke from sleep) - clean up immediately!
            if (spectrogramSelectionActive || spectrogramSelectionBox) {
                console.log('👁️ Page visible again - cleaning up any stuck selection state');
                cancelSpectrogramSelection();
            }
            // 🔥 SLEEP FIX: Also reset any stale mouse coordinates that might break tracking
            // After sleep, browser mouse events can be in a weird state
            if (!spectrogramSelectionActive && (spectrogramStartX !== null || spectrogramCurrentX !== null)) {
                console.log('👁️ Page visible again - resetting stale mouse coordinates after sleep');
                spectrogramStartX = null;
                spectrogramStartY = null;
                spectrogramCurrentX = null;
                spectrogramCurrentY = null;
            }
            // 🔥 FIX: Verify overlay context is ready after sleep - if not, show safeguard message
            if (!spectrogramOverlayCtx || !spectrogramOverlayCanvas) {
                console.warn('⚠️ [SLEEP WAKE] Overlay context missing after sleep - may need refresh');
                // Don't show message immediately - wait for user to try clicking first
                // The mousedown handler will detect and show the message if needed
            } else {
                // Overlay context is good - hide any existing safeguard message
                hideStuckStateMessage();
            }
        }
    };
    document.addEventListener('visibilitychange', spectrogramVisibilityHandler);

    // 🔥 SLEEP FIX: Also clean up on window focus (additional safety)
    spectrogramFocusHandler = () => {
        if (spectrogramSelectionActive || spectrogramSelectionBox) {
            console.log('🎯 Window focused - cleaning up any stuck selection state');
            cancelSpectrogramSelection();
        }
    };
    window.addEventListener('focus', spectrogramFocusHandler);

    // 🔥 BLUR FIX: Cancel active selections when window loses focus
    // This prevents stuck state when browser loses focus mid-drag (e.g., CMD+Tab)
    // Safe because it only cancels active drags, doesn't interfere with mousedown cleanup
    spectrogramBlurHandler = () => {
        cancelBoxDrag();
        if (spectrogramSelectionActive) {
            console.log('👋 Window blurred - canceling active selection to prevent stuck state');
            cancelSpectrogramSelection();
        }
    };
    window.addEventListener('blur', spectrogramBlurHandler);

    spectrogramSelectionSetup = true;

    canvas.addEventListener('mousedown', (e) => {
        // 🔍 DEBUG: Log zoom state when clicking on canvas
        console.log('🖱️ [MOUSEDOWN] Canvas clicked - checking zoom state:', {
            zoomStateInitialized: zoomState.isInitialized(),
            isInRegion: zoomState.isInitialized() ? zoomState.isInRegion() : 'N/A (not initialized)',
            zoomMode: zoomState.isInitialized() ? zoomState.mode : 'N/A',
            activeRegionId: zoomState.isInitialized() ? zoomState.activeRegionId : 'N/A'
        });
        
        // 🎯 Check if region creation is enabled (requires "Begin Analysis" to be pressed)
        if (!State.isRegionCreationEnabled()) {
            // User clicked spectrogram before Begin Analysis - show helpful message (only if not in tutorial)
            import('./tutorial-state.js').then(({ isTutorialActive }) => {
                if (!isTutorialActive()) {
                    import('./tutorial-effects.js').then(({ setStatusText }) => {
                        setStatusText('Click Begin Analysis to create a region and interact with the spectrogram.', 'status info');
                    });
                }
            });
            return; // Don't allow spectrogram selection
        }
        
        // ✅ Check if clicking on an existing canvas box FIRST (before zoom check)
        // This allows clicking features to zoom in when zoomed out
        const canvasRect = canvas.getBoundingClientRect();
        const clickX = e.clientX - canvasRect.left;
        const clickY = e.clientY - canvasRect.top;

        // Check close button (×) before anything else
        const closedBox = getClickedCloseButton(clickX, clickY);
        if (closedBox) {
            if (closedBox.regionIndex === -1) {
                // Standalone feature
                if (confirm('Delete this feature?')) {
                    deleteStandaloneFeature(closedBox.featureIndex);
                    redrawAllCanvasFeatureBoxes();
                    renderStandaloneFeaturesList();
                }
            } else {
                deleteRegion(closedBox.regionIndex);
            }
            return;
        }

        // Box drag/resize handler (self-contained — claims event if on a box)
        if (!spectrogramSelectionActive && handleBoxDragDown(e, canvas)) return;

        const clickedBox = getClickedBox(clickX, clickY);
        if (clickedBox && !spectrogramSelectionActive) {
            if (!zoomState.isInRegion()) {
                console.log(`🔍 Clicked feature box while zoomed out - zooming to region ${clickedBox.regionIndex + 1}`);
                zoomToRegion(clickedBox.regionIndex);
                return;
            }
            // Zoomed in - start frequency selection to re-draw the feature
            startFrequencySelection(clickedBox.regionIndex, clickedBox.featureIndex);
            console.log(`🎯 Clicked canvas box - starting reselection for region ${clickedBox.regionIndex + 1}, feature ${clickedBox.featureIndex + 1}`);
            return;
        }

        // Check main window Click dropdown (mousedown action)
        const mainClickMode = document.getElementById('mainWindowClick');
        if (mainClickMode && mainClickMode.value === 'playAudio' && !zoomState.isInRegion()) {
            // Click=Play audio: seek immediately on mousedown
            const modeSelect = window.__EMIC_STUDY_MODE ? document.getElementById('viewingMode') : null;
            const isWindowed = modeSelect && (modeSelect.value === 'static' || modeSelect.value === 'scroll' || modeSelect.value === 'pageTurn');
            if (isWindowed && State.getCompleteSamplesLength() > 0 && State.totalAudioDuration > 0 && zoomState.isInitialized() && State.dataStartTime && State.dataEndTime) {
                const timestamp = zoomState.pixelToTimestamp(clickX, canvasRect.width);
                const dataStartMs = State.dataStartTime.getTime();
                const dataSpanMs = State.dataEndTime.getTime() - dataStartMs;
                const fraction = (timestamp.getTime() - dataStartMs) / dataSpanMs;
                const targetPosition = fraction * State.totalAudioDuration;
                const clamped = Math.max(0, Math.min(targetPosition, State.totalAudioDuration));
                State.setCurrentAudioPosition(clamped);
                if (State.audioContext) {
                    State.setLastUpdateTime(State.audioContext.currentTime);
                }
                Promise.all([
                    import('./audio-player.js'),
                    import('./spectrogram-playhead.js'),
                    import('./waveform-renderer.js')
                ]).then(([audioPlayer, playhead, waveform]) => {
                    audioPlayer.seekToPosition(clamped, true);
                    playhead.drawSpectrogramPlayhead();
                    waveform.drawWaveformWithSelection();
                });
            }
            // Don't return — continue to start selection tracking for potential drag
        }

        // 🔥 FIX: ALWAYS force-reset state before starting new selection
        // Don't cancel and return - just clean up silently and start fresh
        let wasCleaningUp = false;
        if (spectrogramSelectionActive || spectrogramSelectionBox) {
            console.log('🧹 Cleaning up stale selection state before starting new one');
            wasCleaningUp = true;

            // Clear any existing timeout
            if (spectrogramSelectionTimeout) {
                clearTimeout(spectrogramSelectionTimeout);
                spectrogramSelectionTimeout = null;
            }

            // Delete any orphaned box (legacy DOM cleanup)
            if (spectrogramSelectionBox) {
                spectrogramSelectionBox.remove();
                spectrogramSelectionBox = null;
            }

            // 🔥 AGGRESSIVE RESET: Force reset ALL state variables to ensure clean slate
            spectrogramSelectionActive = false;
            spectrogramStartX = null;
            spectrogramStartY = null;
            spectrogramCurrentX = null;
            spectrogramCurrentY = null;
            
            // 🔥 FIX: Verify overlay context is ready - if not, we're in a stuck state!
            if (!spectrogramOverlayCtx || !spectrogramOverlayCanvas) {
                console.error('⚠️ [STUCK STATE DETECTED] Overlay context not ready after cleanup!');
                showStuckStateMessage();
                // Try to reinitialize overlay canvas
                const container = canvas.closest('.panel');
                if (container && !spectrogramOverlayCanvas) {
                    console.log('🔄 Attempting to reinitialize overlay canvas...');
                    // Recreate overlay canvas
                    spectrogramOverlayCanvas = document.createElement('canvas');
                    spectrogramOverlayCanvas.id = 'spectrogram-selection-overlay';
                    spectrogramOverlayCanvas.style.position = 'absolute';
                    spectrogramOverlayCanvas.style.pointerEvents = 'none';
                    spectrogramOverlayCanvas.style.zIndex = '20';  // Above spectrogram glow and other panels
                    spectrogramOverlayCanvas.style.background = 'transparent';
                    
                    const canvasRect = canvas.getBoundingClientRect();
                    const containerRect = container.getBoundingClientRect();
                    spectrogramOverlayCanvas.style.left = (canvasRect.left - containerRect.left) + 'px';
                    spectrogramOverlayCanvas.style.top = (canvasRect.top - containerRect.top) + 'px';
                    spectrogramOverlayCanvas.width = canvas.width;
                    spectrogramOverlayCanvas.height = canvas.height;
                    spectrogramOverlayCanvas.style.width = canvas.offsetWidth + 'px';
                    spectrogramOverlayCanvas.style.height = canvas.offsetHeight + 'px';
                    
                    container.appendChild(spectrogramOverlayCanvas);
                    spectrogramOverlayCtx = spectrogramOverlayCanvas.getContext('2d');
                    
                    if (spectrogramOverlayCtx) {
                        console.log('✅ Overlay canvas reinitialized successfully');
                        hideStuckStateMessage();
                    } else {
                        console.error('❌ Failed to reinitialize overlay canvas');
                        return; // Can't proceed without overlay context
                    }
                } else {
                    return; // Can't proceed without overlay context
                }
            }

            // DON'T return - continue to start new selection below!
        }
        
        // 🔥 VERIFY: After cleanup, ensure overlay context is still valid before proceeding
        if (!spectrogramOverlayCtx || !spectrogramOverlayCanvas) {
            console.error('⚠️ [STUCK STATE DETECTED] Overlay context missing before starting selection!');
            console.warn('🔄 Attempting emergency reinitialization of overlay canvas...');
            
            // EMERGENCY RECOVERY: Try to reinitialize the overlay canvas
            const canvas = document.getElementById('spectrogram-canvas');
            const container = document.getElementById('spectrogram-container');
            
            if (canvas && container) {
                // Remove any existing overlay canvas
                const existingOverlay = document.getElementById('spectrogram-selection-overlay');
                if (existingOverlay) {
                    existingOverlay.remove();
                }
                
                // Recreate overlay canvas
                spectrogramOverlayCanvas = document.createElement('canvas');
                spectrogramOverlayCanvas.id = 'spectrogram-selection-overlay';
                spectrogramOverlayCanvas.style.position = 'absolute';
                spectrogramOverlayCanvas.style.pointerEvents = 'none';
                spectrogramOverlayCanvas.style.zIndex = '20';
                spectrogramOverlayCanvas.style.background = 'transparent';
                
                const canvasRect = canvas.getBoundingClientRect();
                const containerRect = container.getBoundingClientRect();
                spectrogramOverlayCanvas.style.left = (canvasRect.left - containerRect.left) + 'px';
                spectrogramOverlayCanvas.style.top = (canvasRect.top - containerRect.top) + 'px';
                spectrogramOverlayCanvas.width = canvas.width;
                spectrogramOverlayCanvas.height = canvas.height;
                spectrogramOverlayCanvas.style.width = canvas.offsetWidth + 'px';
                spectrogramOverlayCanvas.style.height = canvas.offsetHeight + 'px';
                
                container.appendChild(spectrogramOverlayCanvas);
                spectrogramOverlayCtx = spectrogramOverlayCanvas.getContext('2d');
                
                if (spectrogramOverlayCtx) {
                    console.log('✅ Emergency overlay canvas reinitialization successful!');
                    hideStuckStateMessage();
                } else {
                    console.error('❌ Emergency reinitialization failed - showing safeguard message');
                    showStuckStateMessage();
                    return;
                }
            } else {
                console.error('❌ Cannot reinitialize - canvas or container not found');
                showStuckStateMessage();
                return;
            }
        }
        
        // Hide safeguard message if we got here successfully
        hideStuckStateMessage();
        
        spectrogramStartX = e.clientX - canvasRect.left;
        spectrogramStartY = e.clientY - canvasRect.top;
        spectrogramCurrentX = null;  // Reset - will be set on first mousemove
        spectrogramCurrentY = null;  // Reset - will be set on first mousemove
        spectrogramWasDrag = false;  // Reset - will be set when drag exceeds threshold
        spectrogramSelectionActive = true;

        // 🔥 FIX: Safety timeout - if mouseup never fires, auto-cancel after 5 seconds
        // This prevents stuck state when browser loses focus mid-drag
        if (spectrogramSelectionTimeout) {
            clearTimeout(spectrogramSelectionTimeout);
        }
        spectrogramSelectionTimeout = setTimeout(() => {
            if (spectrogramSelectionActive) {
                console.warn('⚠️ [SAFETY TIMEOUT] Mouseup never fired - auto-canceling selection');
                cancelSpectrogramSelection();
            }
        }, 5000); // 5 second safety timeout

        // 🔥 FIX: Don't create the box immediately - wait for drag to start
        // This prevents boxes from being created on every click when mouseup never fired
    });
    
    canvas.addEventListener('mousemove', (e) => {
        // Box drag/resize handler (self-contained — claims event if active or hovering a box)
        if (handleBoxDragMove(e, canvas)) {
            // If not actively dragging, also need to check close button cursor
            if (!boxDragState) {
                const canvasRect = canvas.getBoundingClientRect();
                const hoveredClose = getClickedCloseButton(e.clientX - canvasRect.left, e.clientY - canvasRect.top);
                if (hoveredClose) canvas.style.cursor = 'pointer';
            }
            return;
        }

        // Cursor hints for non-box areas
        const canvasRect = canvas.getBoundingClientRect();
        const hoverX = e.clientX - canvasRect.left;
        const hoverY = e.clientY - canvasRect.top;
        const hoveredBox = getClickedBox(hoverX, hoverY);
        const hoveredClose = getClickedCloseButton(hoverX, hoverY);

        // Track hovered box for brightness highlight
        const newHoveredKey = hoveredBox ? `${hoveredBox.regionIndex}-${hoveredBox.featureIndex}` : null;
        if (newHoveredKey !== hoveredBoxKey) {
            hoveredBoxKey = newHoveredKey;
            redrawCanvasBoxes();
        }

        if (hoveredClose && !spectrogramSelectionActive) {
            canvas.style.cursor = 'pointer';
        } else if (hoveredBox && !zoomState.isInRegion() && !spectrogramSelectionActive) {
            canvas.style.cursor = 'pointer';
        } else if (zoomState.isInRegion() && !spectrogramSelectionActive) {
            canvas.style.cursor = 'crosshair';
        } else if (!spectrogramSelectionActive) {
            canvas.style.cursor = 'default';
        }

        // 🔥 STUCK STATE DETECTION: If selection is active but overlay context is missing, we're stuck!
        if (spectrogramSelectionActive && !spectrogramOverlayCtx) {
            console.error('⚠️ [STUCK STATE DETECTED] Selection active but overlay context missing in mousemove!');
            showStuckStateMessage();
            spectrogramSelectionActive = false;
            spectrogramStartX = null;
            spectrogramStartY = null;
            spectrogramCurrentX = null;
            spectrogramCurrentY = null;
            return;
        }

        if (!spectrogramSelectionActive || !spectrogramOverlayCtx) return;

        // Reuse canvasRect from above (already declared at line 1248)
        const currentX = e.clientX - canvasRect.left;
        const currentY = e.clientY - canvasRect.top;

        // ✅ PURE CANVAS: Update state
        spectrogramCurrentX = currentX;
        spectrogramCurrentY = currentY;

        // Detect drag threshold crossing
        if (!spectrogramWasDrag && spectrogramStartX !== null) {
            const dx = Math.abs(currentX - spectrogramStartX);
            const dy = Math.abs(currentY - spectrogramStartY);
            if (Math.max(dx, dy) >= 5) {
                spectrogramWasDrag = true;
            }
        }

        // Only draw selection box if Drag is set to drawFeature
        const mainDragMode = document.getElementById('mainWindowDrag');
        const isDragDrawFeature = mainDragMode && mainDragMode.value === 'drawFeature';
        if (!isDragDrawFeature) return;

        // Draw ALL boxes (completed + current dragging)
        const width = spectrogramOverlayCanvas.width;
        const height = spectrogramOverlayCanvas.height;

        // Clear and redraw everything
        spectrogramOverlayCtx.clearRect(0, 0, width, height);

        // Redraw all completed boxes
        for (const box of completedSelectionBoxes) {
            drawSavedBox(spectrogramOverlayCtx, box);
        }

        // Draw current dragging box
        drawSpectrogramSelectionBox(spectrogramOverlayCtx, width, height);
    });
    
    // 🔥 FIX: Add mouseleave handler to cancel selection when mouse leaves canvas
    // This prevents stuck state when mouseup never fires (e.g., mouse leaves window)
    canvas.addEventListener('mouseleave', () => {
        cancelBoxDrag();
        if (hoveredBoxKey !== null) {
            hoveredBoxKey = null;
            redrawCanvasBoxes();
        }
        if (spectrogramSelectionActive) {
            console.log('🖱️ Mouse left spectrogram canvas during selection - canceling');
            cancelSpectrogramSelection();
        }
    });
    
    // 🔥 SLEEP FIX: Reset mouse tracking state when mouse enters canvas after wake
    // This ensures mouse events work properly after computer sleep
    canvas.addEventListener('mouseenter', () => {
        // If we have stale state (coordinates but not active), reset everything
        // This handles the case where sleep broke mouse tracking
        if (!spectrogramSelectionActive && (spectrogramStartX !== null || spectrogramCurrentX !== null)) {
            console.log('🖱️ Mouse entered spectrogram canvas - resetting stale mouse state after sleep');
            spectrogramStartX = null;
            spectrogramStartY = null;
            spectrogramCurrentX = null;
            spectrogramCurrentY = null;
        }
    });
    
    // 🔥 FIX: Store handler reference so it can be removed
    spectrogramMouseUpHandler = async (e) => {
        // Box drag/resize handler (self-contained)
        if (handleBoxDragUp(e, canvas)) return;

        if (!spectrogramSelectionActive) {
            return;
        }

        // Clear safety timeout since mouseup fired successfully
        if (spectrogramSelectionTimeout) {
            clearTimeout(spectrogramSelectionTimeout);
            spectrogramSelectionTimeout = null;
        }

        // Determine if this was a click (no drag) or a drag
        const wasDrag = spectrogramWasDrag;

        if (!wasDrag) {
            // --- CLICK (no significant drag) ---
            cancelSpectrogramSelection();

            // Check Release dropdown: seek-to-position on release
            const mainReleaseMode = document.getElementById('mainWindowRelease');
            if (mainReleaseMode && mainReleaseMode.value === 'playAudio' && !zoomState.isInRegion()) {
                const canvasRect = canvas.getBoundingClientRect();
                const releaseX = e.clientX - canvasRect.left;
                const modeSelect = window.__EMIC_STUDY_MODE ? document.getElementById('viewingMode') : null;
                const isWindowed = modeSelect && (modeSelect.value === 'static' || modeSelect.value === 'scroll' || modeSelect.value === 'pageTurn');
                if (isWindowed && State.getCompleteSamplesLength() > 0 && State.totalAudioDuration > 0 && zoomState.isInitialized() && State.dataStartTime && State.dataEndTime) {
                    const timestamp = zoomState.pixelToTimestamp(releaseX, canvasRect.width);
                    const dataStartMs = State.dataStartTime.getTime();
                    const dataSpanMs = State.dataEndTime.getTime() - dataStartMs;
                    const fraction = (timestamp.getTime() - dataStartMs) / dataSpanMs;
                    const targetPosition = fraction * State.totalAudioDuration;
                    const clamped = Math.max(0, Math.min(targetPosition, State.totalAudioDuration));
                    State.setCurrentAudioPosition(clamped);
                    if (State.audioContext) {
                        State.setLastUpdateTime(State.audioContext.currentTime);
                    }
                    Promise.all([
                        import('./audio-player.js'),
                        import('./spectrogram-playhead.js'),
                        import('./waveform-renderer.js')
                    ]).then(([audioPlayer, playhead, waveform]) => {
                        audioPlayer.seekToPosition(clamped, true);
                        playhead.drawSpectrogramPlayhead();
                        waveform.drawWaveformWithSelection();
                    });
                }
            }
            return;
        }

        // --- DRAG (exceeded 5px threshold) ---
        const mainDragMode = document.getElementById('mainWindowDrag');
        const isDragDrawFeature = mainDragMode && mainDragMode.value === 'drawFeature';

        if (!isDragDrawFeature) {
            // Drag=No action — cancel without creating feature
            cancelSpectrogramSelection();
            return;
        }

        // Drag=Draw feature — create the feature
        const endY_css = spectrogramCurrentY;
        const endX_css = spectrogramCurrentX;

        // Convert CSS pixels to DEVICE pixels (same coordinate system as axis!)
        const scaleX = canvas.width / canvas.offsetWidth;
        const scaleY = canvas.height / canvas.offsetHeight;
        const startY_device = spectrogramStartY * scaleY;
        const endY_device = endY_css * scaleY;
        const startX_device = spectrogramStartX * scaleX;
        const endX_device = endX_css * scaleX;

        // Stop accepting new mouse moves first
        spectrogramSelectionActive = false;

        // Call the handler (this creates the data for the feature and returns region/feature indices)
        const result = await handleSpectrogramSelection(
            startY_device, endY_device,
            canvas.height,  // ← DEVICE PIXELS (like axis)!
            startX_device, endX_device,
            canvas.width    // ← DEVICE PIXELS!
        );

        // Rebuild canvas boxes from feature data (ensures sync with array!)
        rebuildCanvasBoxesFromFeatures();

        // Reset coordinate state for next box
        spectrogramStartX = null;
        spectrogramStartY = null;
        spectrogramCurrentX = null;
        spectrogramCurrentY = null;
    };
    
    // 🔥 FIX: Use canvas instead of document for mouseup (like waveform does)
    // Canvas events survive browser focus changes better than document events
    canvas.addEventListener('mouseup', spectrogramMouseUpHandler);
    
    // 🔥 FIX: Store handler reference so it can be removed
    spectrogramKeyDownHandler = (e) => {
        if (e.key === 'Escape') {
            cancelBoxDrag();
            if (spectrogramSelectionActive) cancelSpectrogramSelection();
        }
    };
    
    document.addEventListener('keydown', spectrogramKeyDownHandler);

    // 🔥 REMOVED: All blur/focus handlers - waveform doesn't have them and works perfectly!
    // The mousedown handler now cleans up stale state automatically when user clicks
    // The 5-second safety timeout still prevents infinite stuck states
    // User can press Escape to manually cancel if needed
    
    spectrogramSelectionSetup = true;
    if (!isStudyMode()) {
        console.log('🎯 Spectrogram frequency selection enabled');
    }
}

/**
 * Cancel active spectrogram selection (reset state)
 * Called when user presses Escape or exits feature selection mode
 * NOTE: Does NOT clear completed boxes - only cancels the current drag!
 */
export function cancelSpectrogramSelection() {
    // 🔥 FIX: Clear safety timeout when canceling
    if (spectrogramSelectionTimeout) {
        clearTimeout(spectrogramSelectionTimeout);
        spectrogramSelectionTimeout = null;
    }
    
    // ✅ PURE CANVAS: Just reset state
    spectrogramSelectionActive = false;
    spectrogramStartX = null;
    spectrogramStartY = null;
    spectrogramCurrentX = null;
    spectrogramCurrentY = null;
    
    // 🔥 FIX: Hide safeguard message when canceling (state is being reset)
    hideStuckStateMessage();
    
    // DON'T clear the overlay - that would delete all completed boxes!
    // Just redraw without the current incomplete drag
    if (spectrogramOverlayCtx) {
        spectrogramOverlayCtx.clearRect(0, 0, spectrogramOverlayCanvas.width, spectrogramOverlayCanvas.height);
        // Redraw all completed boxes
        for (const box of completedSelectionBoxes) {
            drawSavedBox(spectrogramOverlayCtx, box);
        }
        console.log(`🧹 Canceled current drag, kept ${completedSelectionBoxes.length} completed boxes`);
    }
    
    // DEPRECATED: Legacy DOM box cleanup (kept for transition period)
    if (spectrogramSelectionBox) {
        spectrogramSelectionBox.remove();
        spectrogramSelectionBox = null;
    }
}

/**
 * Draw a saved box from eternal coordinates (time/frequency)
 * EXACT COPY of orange box coordinate conversion logic!
 * @param {boolean} drawAnnotationsOnly - If true, only draw annotations; if false, only draw box
 * @param {Array} placedAnnotations - Array of already-placed annotations for collision detection
 */
function drawSavedBox(ctx, box, drawAnnotationsOnly = false, placedAnnotations = []) {
    const canvas = document.getElementById('spectrogram');
    if (!canvas) return;
    
    // Need zoom state and data times
    if (!State.dataStartTime || !State.dataEndTime || !zoomState.isInitialized()) {
        return;
    }
    
    // Convert eternal coordinates (time/frequency) to pixel positions
    const lowFreq = box.lowFreq;
    const highFreq = box.highFreq;
    
    // Use same source as Y-axis for consistency
    const originalNyquist = State.originalDataFrequencyRange?.max || 50;
    
    // Get current playback rate (CRITICAL for stretching!)
    const playbackRate = State.currentPlaybackRate || 1.0;
    
    // Convert frequencies to Y positions (DEVICE PIXELS) - WITH SCALE INTERPOLATION! 🎯
    // Use exact same interpolation logic as Y-axis ticks during scale transitions
    const scaleTransition = getScaleTransitionState();
    
    let lowFreqY_device, highFreqY_device;
    
    if (scaleTransition.inProgress && scaleTransition.oldScaleType) {
        // Interpolate between old and new scale positions (like axis ticks!)
        const oldLowY = getYPositionForFrequencyScaled(lowFreq, originalNyquist, canvas.height, scaleTransition.oldScaleType, playbackRate);
        const newLowY = getYPositionForFrequencyScaled(lowFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
        const oldHighY = getYPositionForFrequencyScaled(highFreq, originalNyquist, canvas.height, scaleTransition.oldScaleType, playbackRate);
        const newHighY = getYPositionForFrequencyScaled(highFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
        
        lowFreqY_device = oldLowY + (newLowY - oldLowY) * scaleTransition.interpolationFactor;
        highFreqY_device = oldHighY + (newHighY - oldHighY) * scaleTransition.interpolationFactor;
    } else {
        // No transition - use current scale directly
        lowFreqY_device = getYPositionForFrequencyScaled(lowFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
        highFreqY_device = getYPositionForFrequencyScaled(highFreq, originalNyquist, canvas.height, State.frequencyScale, playbackRate);
    }
    
    // Convert times to X positions (DEVICE PIXELS) - EXACT COPY of orange box logic!
    const startTimestamp = new Date(box.startTime);
    const endTimestamp = new Date(box.endTime);
    
    // Use EXACT same interpolated time range as spectrogram elastic stretching!
    const interpolatedRange = getInterpolatedTimeRange();
    const displayStartMs = interpolatedRange.startTime.getTime();
    const displayEndMs = interpolatedRange.endTime.getTime();
    const displaySpanMs = displayEndMs - displayStartMs;
    
    const startMs = startTimestamp.getTime();
    const endMs = endTimestamp.getTime();
    
    const startProgress = (startMs - displayStartMs) / displaySpanMs;
    const endProgress = (endMs - displayStartMs) / displaySpanMs;
    
    // Convert to DEVICE pixels (orange boxes use CSS pixels with canvas.offsetWidth)
    const startX_device = startProgress * canvas.width;
    const endX_device = endProgress * canvas.width;
    
    // Check if completely off-screen horizontally (don't draw)
    if (endX_device < 0 || startX_device > canvas.width) {
        return;
    }
    
    // Check if completely off-screen vertically (don't draw)
    const topY = Math.min(highFreqY_device, lowFreqY_device);
    const bottomY = Math.max(highFreqY_device, lowFreqY_device);
    if (bottomY < 0 || topY > canvas.height) {
        return;
    }
    
    // Calculate box dimensions
    const x = Math.min(startX_device, endX_device);
    const y = Math.min(highFreqY_device, lowFreqY_device);
    const width = Math.abs(endX_device - startX_device);
    const height = Math.abs(lowFreqY_device - highFreqY_device);
    
    // PASS 1: Draw the box (if not in annotations-only mode)
    if (!drawAnnotationsOnly) {
        const boxKey = `${box.regionIndex}-${box.featureIndex}`;
        const isBoxHovered = hoveredBoxKey === boxKey;

        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, width, height);

        ctx.fillStyle = isBoxHovered ? 'rgba(255, 100, 100, 0.35)' : 'rgba(255, 68, 68, 0.2)';
        ctx.fillRect(x, y, width, height);

        // Draw close button (red ×) in top-right inside corner
        const closeSize = 12;
        const closePad = 6;
        const closeX = x + width - closeSize - closePad;
        const closeY = y + closePad;
        // Only draw if box is large enough to fit the button
        if (width > closeSize + closePad * 3 && height > closeSize + closePad * 3) {
            // Draw × lines (no background circle)
            const inset = 2;
            ctx.strokeStyle = '#ff4444';
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(closeX + inset, closeY + inset);
            ctx.lineTo(closeX + closeSize - inset, closeY + closeSize - inset);
            ctx.moveTo(closeX + closeSize - inset, closeY + inset);
            ctx.lineTo(closeX + inset, closeY + closeSize - inset);
            ctx.stroke();
            ctx.lineCap = 'butt';
        }

        // Add flat sequential feature number label (gated by Numbers dropdown)
        const numbersMode = document.getElementById('mainWindowNumbers')?.value || 'red';
        if (numbersMode !== 'hide') {
            const numbersLoc = document.getElementById('mainWindowNumbersLoc')?.value || 'above';
            const flatNum = getFlatFeatureNumber(box.regionIndex, box.featureIndex);
            const numberText = `${flatNum}`;
            const isRed = numbersMode === 'red';
            ctx.font = '15px Arial, sans-serif';
            ctx.fillStyle = isRed ? '#ff4444' : 'rgba(255, 255, 255, 0.8)';

            // Red labels get a light shadow for contrast, white labels get dark shadow
            if (isRed) {
                ctx.shadowBlur = 4;
                ctx.shadowColor = 'rgba(255, 255, 255, 0.3)';
            } else {
                ctx.shadowBlur = 3;
                ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
            }
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;

            // Smooth slide: centered when narrow, left-aligned when wide
            const textWidth = ctx.measureText(numberText).width;
            const centeredX = (width - textWidth) / 2;
            ctx.textAlign = 'left';

            if (numbersLoc === 'inside') {
                ctx.textBaseline = 'top';
                ctx.fillText(numberText, x + closePad, y + closePad);
            } else {
                ctx.textBaseline = 'bottom';
                ctx.fillText(numberText, x + Math.min(2, centeredX), y - 3);
            }

            // Reset shadow so it doesn't bleed into subsequent draws
            ctx.shadowBlur = 0;
            ctx.shadowColor = 'transparent';
        }

        // Draw resize handles when hovered or being dragged
        const isHovered = hoveredBoxInteraction && completedSelectionBoxes[hoveredBoxInteraction.boxIndex] === box;
        const isDragged = boxDragState && completedSelectionBoxes[boxDragState.boxIndex] === box;
        if (isHovered || isDragged) {
            const hs = 2.5; // handle half-size (device px)
            ctx.fillStyle = '#ff4444';
            // Corner handles
            const corners = [
                [x, y], [x + width, y],
                [x, y + height], [x + width, y + height]
            ];
            for (const [cx, cy] of corners) {
                ctx.fillRect(cx - hs, cy - hs, hs * 2, hs * 2);
            }
            // Edge midpoint handles
            const midpoints = [
                [x + width / 2, y], [x + width / 2, y + height],
                [x, y + height / 2], [x + width, y + height / 2]
            ];
            for (const [mx, my] of midpoints) {
                ctx.fillRect(mx - hs, my - hs, hs * 2, hs * 2);
            }
        }
    }

    // PASS 2: Draw annotation text above the box (if in annotations-only mode)
    if (drawAnnotationsOnly && box.notes && box.startTime && box.endTime) {
        // Check if live annotations are enabled
        const checkbox = document.getElementById('liveAnnotation');
        if (!checkbox || !checkbox.checked) {
            // Clear any existing timing state for this box
            const key = `${box.regionIndex}-${box.featureIndex}`;
            annotationTimingState.delete(key);
            return;
        }

        const key = `${box.regionIndex}-${box.featureIndex}`;
        const now = performance.now();

        // Calculate time until feature IN AUDIO TIME, not real-world time!
        if (State.totalAudioDuration && State.totalAudioDuration > 0 && zoomState.isInitialized() && State.dataStartTime && State.dataEndTime) {
            // Convert timestamps to sample indices (progress through dataset)
            const dataStartMs = State.dataStartTime.getTime();
            const dataEndMs = State.dataEndTime.getTime();
            const totalSamples = zoomState.totalSamples;

            const startTimestampMs = new Date(box.startTime).getTime();
            const endTimestampMs = new Date(box.endTime).getTime();

            const startProgress = (startTimestampMs - dataStartMs) / (dataEndMs - dataStartMs);
            const endProgress = (endTimestampMs - dataStartMs) / (dataEndMs - dataStartMs);

            const featureStartSample = startProgress * totalSamples;
            const featureEndSample = endProgress * totalSamples;

            // Convert current audio position to sample
            const currentSample = zoomState.timeToSample(State.currentAudioPosition);

            // WORKLET-STYLE LOGIC: Calculate samples until feature
            const samplesToFeature = featureStartSample - currentSample;
            const featureDurationSamples = featureEndSample - featureStartSample;

            // WORKLET-STYLE: Calculate lead time in SAMPLES (1 WALL-CLOCK second before feature)
            const playbackRate = State.currentPlaybackRate || 1.0;
            // EXACT worklet formula: fadeTime * 44.1 * speed
            const LEAD_SAMPLES_OUTPUT = Math.floor(ANNOTATION_LEAD_TIME_MS * 44.1);
            const leadTimeSamples = Math.floor(LEAD_SAMPLES_OUTPUT * playbackRate);

            // WORKLET-STYLE: Trigger when samplesToFeature <= leadTimeSamples
            const shouldShow = samplesToFeature <= leadTimeSamples && samplesToFeature > -featureDurationSamples;

            let timing = annotationTimingState.get(key);

            if (shouldShow && !timing) {
                // Start showing
                timing = { showTime: now, hideTime: null, state: 'fading-in' };
                annotationTimingState.set(key, timing);
            } else if (!shouldShow && timing && timing.state !== 'fading-out' && timing.state !== 'hidden') {
                // Start hiding (if past min display time)
                const timeSinceShow = now - timing.showTime;
                if (timeSinceShow > ANNOTATION_MIN_DISPLAY_MS) {
                    timing.state = 'fading-out';
                    timing.hideTime = now;
                }
            }

            if (timing) {
                let opacity = 0;

                if (timing.state === 'fading-in') {
                    const elapsed = now - timing.showTime;
                    const progress = Math.min(1, elapsed / ANNOTATION_FADE_IN_MS);
                    opacity = progress;

                    if (progress >= 1) timing.state = 'visible';
                } else if (timing.state === 'visible') {
                    opacity = 1;
                } else if (timing.state === 'fading-out') {
                    const elapsed = now - timing.hideTime;
                    const progress = Math.min(1, elapsed / ANNOTATION_FADE_OUT_MS);
                    opacity = 1 - progress;

                    if (progress >= 1) {
                        timing.state = 'hidden';
                        annotationTimingState.delete(key);
                    }
                }

                if (opacity > 0) {
                    const scaleX = canvas.offsetWidth / canvas.width;
                    const scaleY = canvas.offsetHeight / canvas.height;
                    const xStretchFactor = scaleX / scaleY;

                    ctx.save();

                    // Set font first for measurement
                    ctx.font = '600 13px Arial, sans-serif';

                    // Check if text has changed - only re-wrap if needed
                    const lineHeight = 16; // Define BEFORE if/else
                    let lines, textWidth, halfWidth, totalHeight;
                    if (timing.cachedText !== box.notes) {
                        // Text changed! Re-wrap and recalculate dimensions
                        const maxWidth = 325;
                        lines = wrapText(ctx, box.notes, maxWidth);
                        textWidth = Math.max(...lines.map(line => ctx.measureText(line).width));
                        halfWidth = textWidth / 2;
                        totalHeight = lines.length * lineHeight;

                        // Cache for next frame
                        timing.cachedText = box.notes;
                        timing.cachedLines = lines;
                        timing.cachedHalfWidth = halfWidth;
                        timing.cachedTotalHeight = totalHeight;
                    } else {
                        // Text unchanged - reuse cached values
                        lines = timing.cachedLines;
                        halfWidth = timing.cachedHalfWidth;
                        totalHeight = timing.cachedTotalHeight;
                    }

                    // Calculate text position (centered above box)
                    let textX = x + width / 2;
                    let textY = y - 20 - totalHeight;

                    // Check left edge
                    if (textX - halfWidth < 10) {
                        textX = 10 + halfWidth;
                    }
                    // Check right edge
                    if (textX + halfWidth > canvas.width - 10) {
                        textX = canvas.width - 10 - halfWidth;
                    }

                    // Collision detection: check against already-placed annotations
                    // ONLY run on first frame - then lock Y position to prevent dropping when others fade out
                    const padding = 10;
                    let finalTextY;

                    if (timing.lockedY !== undefined) {
                        // Use stored Y position (annotation stays at its height)
                        finalTextY = timing.lockedY;
                    } else {
                        // First frame: calculate collision-free Y position
                        finalTextY = textY;
                        let collisionDetected = true;

                        while (collisionDetected && placedAnnotations.length > 0) {
                            collisionDetected = false;

                            for (const placed of placedAnnotations) {
                                // Check X overlap (horizontal collision) - 25% wider bounding area
                                const xOverlap = Math.abs(textX - placed.x) < ((halfWidth + placed.halfWidth) * 1.25 + padding);

                                // Check Y overlap (vertical collision)
                                const yOverlap = Math.abs(finalTextY - placed.y) < (totalHeight / 2 + placed.height / 2 + padding);

                                if (xOverlap && yOverlap) {
                                    // Collision! Move up
                                    finalTextY = placed.y - (placed.height / 2 + totalHeight / 2 + padding);
                                    collisionDetected = true;
                                    break;
                                }
                            }
                        }

                        // Lock this Y position for all future frames
                        timing.lockedY = finalTextY;
                    }

                    // Record this annotation's position
                    placedAnnotations.push({
                        x: textX,
                        y: finalTextY,
                        halfWidth: halfWidth,
                        height: totalHeight
                    });

                    // Draw connecting line from text to box
                    ctx.save();
                    ctx.globalAlpha = opacity;
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
                    ctx.lineWidth = 2;
                    ctx.setLineDash([3, 3]);
                    ctx.beginPath();
                    ctx.moveTo(textX, finalTextY + totalHeight); // Bottom of text
                    ctx.lineTo(x + width / 2, y); // Top of box
                    ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.restore();

                    // Now draw the text at finalTextY
                    textY = finalTextY;

                    ctx.translate(textX, textY);
                    ctx.scale(1 / xStretchFactor, 1);
                    ctx.translate(-textX, -textY);

                    ctx.globalAlpha = opacity;
                    ctx.fillStyle = '#fff';
                    ctx.textAlign = 'center';
                    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
                    ctx.shadowBlur = 6;
                    ctx.shadowOffsetX = 1;
                    ctx.shadowOffsetY = 1;

                    // Draw each line
                    lines.forEach((line, i) => {
                        ctx.fillText(line, textX, textY + (i * lineHeight));
                    });

                    ctx.restore();
                }
            }
        }
    }

    // Reset shadow
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
}

/**
 * Draw active selection box on spectrogram canvas
 * ✅ PURE CANVAS: Renders directly with ctx.strokeRect() - no DOM manipulation!
 * Called from playhead rendering loop (spectrogram-playhead.js)
 */
export function drawSpectrogramSelectionBox(ctx, canvasWidth, canvasHeight) {
    // Only draw if actively selecting
    if (!spectrogramSelectionActive || spectrogramStartX === null || spectrogramStartY === null) {
        return;
    }
    
    // Only draw if user has dragged at least 5 pixels
    if (spectrogramCurrentX === null || spectrogramCurrentY === null) {
        return;
    }
    
    const dragDistanceX = Math.abs(spectrogramCurrentX - spectrogramStartX);
    const dragDistanceY = Math.abs(spectrogramCurrentY - spectrogramStartY);
    const dragDistance = Math.max(dragDistanceX, dragDistanceY);
    
    if (dragDistance < 5) {
        return; // Not enough drag yet
    }
    
    // Convert CSS pixels to device pixels for rendering
    const canvas = document.getElementById('spectrogram');
    if (!canvas) return;
    
    const scaleX = canvas.width / canvas.offsetWidth;
    const scaleY = canvas.height / canvas.offsetHeight;
    
    const startX_device = spectrogramStartX * scaleX;
    const startY_device = spectrogramStartY * scaleY;
    const currentX_device = spectrogramCurrentX * scaleX;
    const currentY_device = spectrogramCurrentY * scaleY;
    
    // Calculate normalized rectangle
    const x = Math.min(startX_device, currentX_device);
    const y = Math.min(startY_device, currentY_device);
    const width = Math.abs(currentX_device - startX_device);
    const height = Math.abs(currentY_device - startY_device);
    
    // Draw selection box on canvas (matches the old DOM style)
    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, width, height);
    
    // Semi-transparent fill
    ctx.fillStyle = 'rgba(255, 68, 68, 0.2)';
    ctx.fillRect(x, y, width, height);
}

/**
 * Cleanup spectrogram selection event listeners
 * 🔥 FIX: Prevents memory leaks from accumulating listeners
 */
export function cleanupSpectrogramSelection() {
    if (spectrogramMouseUpHandler) {
        const canvas = document.getElementById('spectrogram');
        if (canvas) {
            // 🔥 FIX: Remove from canvas, not document (matches the addEventListener)
            canvas.removeEventListener('mouseup', spectrogramMouseUpHandler);
        }
        spectrogramMouseUpHandler = null;
    }
    if (spectrogramKeyDownHandler) {
        document.removeEventListener('keydown', spectrogramKeyDownHandler);
        spectrogramKeyDownHandler = null;
    }
    if (spectrogramVisibilityHandler) {
        document.removeEventListener('visibilitychange', spectrogramVisibilityHandler);
        spectrogramVisibilityHandler = null;
    }
    if (spectrogramFocusHandler) {
        window.removeEventListener('focus', spectrogramFocusHandler);
        spectrogramFocusHandler = null;
    }
    if (spectrogramBlurHandler) {
        window.removeEventListener('blur', spectrogramBlurHandler);
        spectrogramBlurHandler = null;
    }
    if (spectrogramResizeObserver) {
        spectrogramResizeObserver.disconnect();
        spectrogramResizeObserver = null;
    }
    if (spectrogramRepositionOnVisibility) {
        document.removeEventListener('visibilitychange', spectrogramRepositionOnVisibility);
        spectrogramRepositionOnVisibility = null;
    }

    // Clear any active timeouts
    if (spectrogramSelectionTimeout) {
        clearTimeout(spectrogramSelectionTimeout);
        spectrogramSelectionTimeout = null;
    }
    
    // Remove overlay canvas
    if (spectrogramOverlayCanvas) {
        spectrogramOverlayCanvas.remove();
        spectrogramOverlayCanvas = null;
        spectrogramOverlayCtx = null;
    }

    spectrogramSelectionSetup = false;
}

