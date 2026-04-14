/**
 * spectrogram-renderer.js
 * Spectrogram visualization
 */

import * as State from './audio-state.js';
import { PlaybackState, onPlaybackStateChange } from './audio-state.js';
import { drawFrequencyAxis, positionAxisCanvas, resizeAxisCanvas, initializeAxisPlaybackRate, getYPositionForFrequencyScaled, getScaleTransitionState, getLogScaleMinFreq } from './spectrogram-axis-renderer.js';
import { handleSpectrogramSelection, isInFrequencySelectionMode, getStandaloneFeatures, saveStandaloneFeatures, startFrequencySelection, getFlatFeatureNumber, deleteStandaloneFeature, renderStandaloneFeaturesList, updateFeature } from './feature-tracker.js';
import { renderCompleteSpectrogram, clearCompleteSpectrogram, isCompleteSpectrogramRendered, renderCompleteSpectrogramForRegion, updateSpectrogramViewport, updateSpectrogramViewportFromZoom, resetSpectrogramState, updateElasticFriendInBackground, onColormapChanged, setScrollZoomHiRes } from './main-window-renderer.js';
import { zoomState } from './zoom-state.js';
import { isStudyMode } from './master-modes.js';
import { getInterpolatedTimeRange } from './minimap-x-axis-renderer.js';
import { updateAllFeatureBoxPositions } from './spectrogram-feature-boxes.js';
import { animateScaleTransition } from './spectrogram-axis-renderer.js';
import { startPlaybackIndicator, buildWaveformColorLUT, drawWaveformFromMinMax, rebuildWaveformColormapTexture } from './minimap-window-renderer.js';
import { seekToPosition, pausePlayback, getCurrentPosition } from './audio-player.js';
import { enableIsolation, disableIsolation, updateIsolationFrequencies } from './audio-worklet-init.js';
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

// Feature box fade-in: boxes stay hidden until spectrogram-ready, then fade up
let featureBoxOpacity = 0;
let featureBoxReadyToShow = false;
export function isFeatureBoxReadyToShow() { return featureBoxReadyToShow; }

// ── Feature box dimension helpers (single source of truth) ──
// All feature box drawing, hit-testing, and coordinate conversion uses these
// instead of reading canvas.width/height directly (which can be stale after resize).

/**
 * Get the device-pixel dimensions for feature box coordinate math.
 * Uses the overlay canvas (sized from CSS truth via ResizeObserver).
 * Falls back to the main canvas CSS dimensions if overlay isn't ready.
 */
function getOverlayDimensions() {
    if (spectrogramOverlayCanvas && spectrogramOverlayCanvas.width > 0) {
        return { width: spectrogramOverlayCanvas.width, height: spectrogramOverlayCanvas.height };
    }
    const c = document.getElementById('spectrogram');
    return { width: c?.offsetWidth || 0, height: c?.offsetHeight || 0 };
}

/**
 * Get scale factors for converting CSS pixels → device pixels.
 * Uses overlay dimensions (always current) divided by CSS layout size.
 */
function getCSSToDeviceScale() {
    const c = document.getElementById('spectrogram');
    if (!c || !c.offsetWidth || !c.offsetHeight) return { x: 1, y: 1 };
    const dim = getOverlayDimensions();
    return { x: dim.width / c.offsetWidth, y: dim.height / c.offsetHeight };
}

// ── Feature box colors (colormap-aware) ──
// Colormaps with hot reds/oranges (like inferno) need a shifted hue to stay visible
function getFeatureBoxColors() {
    const cmap = getCurrentColormap();
    const hotMaps = ['inferno', 'magma', 'hot', 'plasma'];
    if (hotMaps.includes(cmap)) {
        return {
            stroke: '#ff2266',
            fill: 'rgba(255, 34, 102, 0.2)',
            fillHover: 'rgba(255, 34, 102, 0.35)',
            label: '#ff2266',
            labelShadow: 'rgba(255, 255, 255, 0.4)',
        };
    }
    return {
        stroke: '#ff4444',
        fill: 'rgba(255, 68, 68, 0.2)',
        fillHover: 'rgba(255, 100, 100, 0.35)',
        label: '#ff4444',
        labelShadow: 'rgba(255, 255, 255, 0.3)',
    };
}

// ── Close button (×) fade timing per box ──
const closeButtonFadeState = new Map(); // key → { visible: bool, startTime: number }

// ── Feature box drag/resize state ──
// Tracks in-progress move or edge/corner resize of an existing feature box.
// Set on mousedown over a box, cleared on mouseup.
let boxDragState = null;
// { boxIndex, mode, startMouseX, startMouseY, origBox: {startTime, endTime, lowFreq, highFreq} }
// mode: 'move' | 'edge-left' | 'edge-right' | 'edge-top' | 'edge-bottom'
//       | 'corner-tl' | 'corner-tr' | 'corner-bl' | 'corner-br'
let hoveredBoxInteraction = null; // current hover result for cursor + handle drawing
let hoveredBoxKey = null; // "regionIndex-featureIndex" of mouse-hovered box (all modes)

/**
 * Single source of truth for hover tracking.
 * Call with CSS coordinates to update, or null to clear (mouseleave).
 * Returns the box result from getBoxAtPoint (or null).
 */
let _hoverFadeRAF = null;
function updateHoveredBox(cssX, cssY) {
    const box = (cssX !== null) ? getBoxAtPoint(cssX, cssY) : null;
    const newKey = box ? `${box.regionIndex}-${box.featureIndex}` : null;
    if (newKey !== hoveredBoxKey) {
        hoveredBoxKey = newKey;
        redrawCanvasBoxes();
        // Drive the annotation fade animation — redrawCanvasBoxes runs the
        // timing state machine but we need repeated frames for the fade.
        // Use redrawCanvasBoxes (not updateCanvasAnnotations) to avoid
        // re-triggering the featureBoxOpacity fade-in.
        if (!_hoverFadeRAF) {
            const pumpFade = () => {
                redrawCanvasBoxes();
                const hasFading = [...annotationTimingState.values()].some(
                    t => t.state === 'fading-in' || t.state === 'fading-out'
                );
                if (hasFading) {
                    _hoverFadeRAF = requestAnimationFrame(pumpFade);
                } else {
                    _hoverFadeRAF = null;
                }
            };
            _hoverFadeRAF = requestAnimationFrame(pumpFade);
        }
    }
    return box;
}

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
 * Lightweight confirm dialog — no backdrop dimming, centered popup, defaults to OK.
 * Returns a Promise<boolean>.
 */
let _confirmDeleteOpen = false;
function confirmDelete(message, clientX, clientY) {
    if (_confirmDeleteOpen) return Promise.resolve(false);
    _confirmDeleteOpen = true;
    return new Promise(resolve => {
        const dialog = document.createElement('div');
        // Position to the right of click, vertically centered on it; fallback to screen center
        const posStyle = (clientX != null && clientY != null)
            ? `position: fixed; left: ${clientX + 40}px; top: ${clientY}px; transform: translateY(-50%);`
            : `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);`;
        dialog.style.cssText = `
            ${posStyle}
            z-index: 100000; background: #1e1e2e; color: #e0e0e0;
            border: 1px solid rgba(102, 126, 234, 0.4); border-radius: 8px;
            padding: 20px 28px; box-shadow: 0 8px 32px rgba(0,0,0,0.6);
            font-family: Arial, sans-serif; font-size: 14px; text-align: center;
            min-width: 240px;
        `;
        const msg = document.createElement('div');
        msg.textContent = message;
        msg.style.marginBottom = '16px';

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display: flex; gap: 10px; justify-content: center;';

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = `
            padding: 6px 20px; font-size: 13px; font-weight: 600; border: none;
            border-radius: 4px; cursor: pointer;
            background: rgba(100, 100, 120, 0.6); color: #ccc;
        `;
        const okBtn = document.createElement('button');
        okBtn.textContent = 'OK \u21B5';
        okBtn.style.cssText = `
            padding: 6px 20px; font-size: 13px; font-weight: 600; border: none;
            border-radius: 4px; cursor: pointer;
            background: rgba(70, 120, 230, 0.9); color: #fff;
        `;

        const cleanup = (result) => {
            _confirmDeleteOpen = false;
            document.removeEventListener('keydown', onKey);
            dialog.remove();
            resolve(result);
        };
        const onKey = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); cleanup(true); }
            else if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
        };
        okBtn.addEventListener('click', () => cleanup(true));
        cancelBtn.addEventListener('click', () => cleanup(false));
        document.addEventListener('keydown', onKey);

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);
        dialog.appendChild(msg);
        dialog.appendChild(btnRow);
        document.body.appendChild(dialog);

        // If it goes off the right edge, flip to the left of the click
        const rect = dialog.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            dialog.style.left = (clientX - 16 - rect.width) + 'px';
        }
        // Clamp vertically
        if (rect.bottom > window.innerHeight) {
            dialog.style.top = (window.innerHeight - rect.height - 8) + 'px';
            dialog.style.transform = 'none';
        }
        if (rect.top < 0) {
            dialog.style.top = '8px';
            dialog.style.transform = 'none';
        }

        okBtn.focus();
    });
}

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
    featureBoxReadyToShow = false;
    featureBoxOpacity = 0;
    featureBoxPendingUntilSpectrogram = false;
    featureBoxGeneration++;  // invalidate any stale pyramid-ready listeners

    if (spectrogramOverlayCtx && spectrogramOverlayCanvas) {
        spectrogramOverlayCtx.clearRect(0, 0, spectrogramOverlayCanvas.width, spectrogramOverlayCanvas.height);
    }

    if (window.pm?.features) console.log('🧹 Cleared all canvas feature boxes');
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
/**
 * Hit-test: is there a feature box at this point (CSS px)?
 * Used for both click handling and hover detection.
 * Returns { regionIndex, featureIndex, screenRect } or null.
 */
function getBoxAtPoint(x, y) {
    if (!spectrogramOverlayCanvas) return null;

    const canvas = document.getElementById('spectrogram');
    if (!canvas) return null;

    const scale = getCSSToDeviceScale();
    const x_device = x * scale.x;
    const y_device = y * scale.y;

    // Match getBoxInteraction tolerance so hover doesn't flicker at edges
    const hitTol = 5;
    for (let i = 0; i < completedSelectionBoxes.length; i++) {
        const box = completedSelectionBoxes[i];
        const rect = getBoxDeviceRect(box);
        if (!rect) continue;

        if (x_device >= rect.x - hitTol && x_device <= rect.x + rect.w + hitTol &&
            y_device >= rect.y - hitTol && y_device <= rect.y + rect.h + hitTol) {
            const canvasRect = canvas.getBoundingClientRect();
            return {
                regionIndex: box.regionIndex,
                featureIndex: box.featureIndex,
                screenRect: {
                    left:   canvasRect.left + rect.x / scale.x,
                    right:  canvasRect.left + (rect.x + rect.w) / scale.x,
                    top:    canvasRect.top  + rect.y / scale.y,
                    bottom: canvasRect.top  + (rect.y + rect.h) / scale.y
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
    if (!spectrogramOverlayCanvas || !State.dataStartTime || !State.dataEndTime || !zoomState.isInitialized()) return null;

    const scale = getCSSToDeviceScale();
    const x_device = x * scale.x;
    const y_device = y * scale.y;

    const closeSize = 12;
    const closePad = 6;
    const hitRadius = closeSize / 2 + 4; // generous hit target

    for (const box of completedSelectionBoxes) {
        const rect = getBoxDeviceRect(box);
        if (!rect) continue;

        const { x: bx, y: by, w: bw, h: bh } = rect;

        // Skip if box too small for close button
        if (bw <= closeSize + closePad * 3 || bh <= closeSize + closePad * 3) continue;

        // Close button center
        const cx = bx + bw - closeSize / 2 - closePad;
        const cy = by + closePad + closeSize / 2;

        const ddx = x_device - cx;
        const ddy = y_device - cy;
        if (ddx * ddx + ddy * ddy <= hitRadius * hitRadius) {
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
    if (!spectrogramOverlayCanvas || !State.dataStartTime || !State.dataEndTime || !zoomState.isInitialized()) return null;

    // Use overlay canvas dimensions — always current (tracks CSS layout)
    const drawWidth = spectrogramOverlayCanvas.width;
    const drawHeight = spectrogramOverlayCanvas.height;

    const originalNyquist = State.originalDataFrequencyRange?.max || 50;
    const playbackRate = State.getPlaybackRate();
    const scaleTransition = getScaleTransitionState();
    let lowY, highY;

    if (scaleTransition.inProgress && scaleTransition.oldScaleType) {
        const oL = getYPositionForFrequencyScaled(box.lowFreq, originalNyquist, drawHeight, scaleTransition.oldScaleType, playbackRate);
        const nL = getYPositionForFrequencyScaled(box.lowFreq, originalNyquist, drawHeight, State.frequencyScale, playbackRate);
        const oH = getYPositionForFrequencyScaled(box.highFreq, originalNyquist, drawHeight, scaleTransition.oldScaleType, playbackRate);
        const nH = getYPositionForFrequencyScaled(box.highFreq, originalNyquist, drawHeight, State.frequencyScale, playbackRate);
        lowY = oL + (nL - oL) * scaleTransition.interpolationFactor;
        highY = oH + (nH - oH) * scaleTransition.interpolationFactor;
    } else {
        lowY = getYPositionForFrequencyScaled(box.lowFreq, originalNyquist, drawHeight, State.frequencyScale, playbackRate);
        highY = getYPositionForFrequencyScaled(box.highFreq, originalNyquist, drawHeight, State.frequencyScale, playbackRate);
    }

    const range = getInterpolatedTimeRange();
    const dStartMs = range.startTime.getTime();
    const dSpanMs = range.endTime.getTime() - dStartMs;
    const sMs = new Date(box.startTime).getTime();
    const eMs = new Date(box.endTime).getTime();
    const sX = ((sMs - dStartMs) / dSpanMs) * drawWidth;
    const eX = ((eMs - dStartMs) / dSpanMs) * drawWidth;

    return {
        x: Math.min(sX, eX),
        y: Math.min(highY, lowY),
        w: Math.abs(eX - sX),
        h: Math.abs(lowY - highY),
        canvasWidth: drawWidth,
        canvasHeight: drawHeight
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
    if (!canvas || !spectrogramOverlayCanvas) return null;

    const scale = getCSSToDeviceScale();
    const dx = cssX * scale.x;
    const dy = cssY * scale.y;

    const edgeTol = 4;
    const cornerTol = 5;

    for (let i = 0; i < completedSelectionBoxes.length; i++) {
        const rect = getBoxDeviceRect(completedSelectionBoxes[i]);
        if (!rect) continue;

        const { x, y, w, h } = rect;
        if (dx < x - edgeTol || dx > x + w + edgeTol || dy < y - edgeTol || dy > y + h + edgeTol) continue;

        const nearLeft = Math.abs(dx - x) <= cornerTol;
        const nearRight = Math.abs(dx - (x + w)) <= cornerTol;
        const nearTop = Math.abs(dy - y) <= cornerTol;
        const nearBottom = Math.abs(dy - (y + h)) <= cornerTol;

        let mode;
        // Review mode: no edge/corner interactions — boxes are view-only
        if (window.__REVIEW_MODE) {
            if (dx >= x && dx <= x + w && dy >= y && dy <= y + h) mode = 'move';
            else continue;
        } else {
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
        }

        const canvasRect = canvas.getBoundingClientRect();
        return {
            boxIndex: i,
            mode,
            screenRect: {
                left: canvasRect.left + x / scale.x,
                right: canvasRect.left + (x + w) / scale.x,
                top: canvasRect.top + y / scale.y,
                bottom: canvasRect.top + (y + h) / scale.y
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
 * Inverse of getYPositionForFrequencyScaled — inlined from feature-tracker.js
 */
function deviceYToFrequency(deviceY, canvasHeight) {
    const originalNyquist = State.originalDataFrequencyRange?.max || 50;
    const playbackRate = State.getPlaybackRate();
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
    const _mode = document.getElementById('viewingMode');
    const isWindowed = _mode && (_mode.value === 'static' || _mode.value === 'scroll' || _mode.value === 'pageTurn');
    if (!isWindowed) return false;

    const canvasRect = canvas.getBoundingClientRect();
    const clickX = e.clientX - canvasRect.left;
    const clickY = e.clientY - canvasRect.top;

    // Check interaction (edges, corners, interior) — this has tolerance that extends outside box
    const interaction = getBoxInteraction(clickX, clickY);
    const clickedBox = getBoxAtPoint(clickX, clickY);

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

    // Active drag — apply movement (disabled in review mode)
    if (boxDragState) {
        if (window.__REVIEW_MODE) { boxDragState = null; return false; }
        if (!boxDragWasDrag) {
            const ddx = Math.abs(mouseX - boxDragStartX);
            const ddy = Math.abs(mouseY - boxDragStartY);
            if (Math.max(ddx, ddy) >= 5) {
                boxDragWasDrag = true;
            }
        }

        if (boxDragWasDrag) {
            canvas.style.cursor = boxDragState.mode === 'move' ? 'grabbing' : getCursorForMode(boxDragState.mode);

            const scale = getCSSToDeviceScale();
            const dim = getOverlayDimensions();
            const startDevX = boxDragState.startMouseX * scale.x;
            const startDevY = boxDragState.startMouseY * scale.y;
            const curDevX = mouseX * scale.x;
            const curDevY = mouseY * scale.y;

            const startTsMs = new Date(deviceXToTimestamp(startDevX, dim.width)).getTime();
            const curTsMs = new Date(deviceXToTimestamp(curDevX, dim.width)).getTime();
            const dtMs = curTsMs - startTsMs;

            const pixelDeltaY = curDevY - startDevY;
            const origNyquist = State.originalDataFrequencyRange?.max || 50;
            const pr = State.getPlaybackRate();
            const freqToPixY = (f) => getYPositionForFrequencyScaled(f, origNyquist, dim.height, State.frequencyScale, pr);

            const orig = boxDragState.origBox;
            const box = completedSelectionBoxes[boxDragState.boxIndex];
            const mode = boxDragState.mode;

            if (mode === 'move') {
                box.startTime = new Date(new Date(orig.startTime).getTime() + dtMs).toISOString();
                box.endTime = new Date(new Date(orig.endTime).getTime() + dtMs).toISOString();
                box.lowFreq = deviceYToFrequency(freqToPixY(orig.lowFreq) + pixelDeltaY, dim.height);
                box.highFreq = deviceYToFrequency(freqToPixY(orig.highFreq) + pixelDeltaY, dim.height);
            } else {
                if (mode === 'edge-left' || mode === 'corner-tl' || mode === 'corner-bl')
                    box.startTime = new Date(new Date(orig.startTime).getTime() + dtMs).toISOString();
                if (mode === 'edge-right' || mode === 'corner-tr' || mode === 'corner-br')
                    box.endTime = new Date(new Date(orig.endTime).getTime() + dtMs).toISOString();
                if (mode === 'edge-top' || mode === 'corner-tl' || mode === 'corner-tr')
                    box.highFreq = deviceYToFrequency(freqToPixY(orig.highFreq) + pixelDeltaY, dim.height);
                if (mode === 'edge-bottom' || mode === 'corner-bl' || mode === 'corner-br')
                    box.lowFreq = deviceYToFrequency(freqToPixY(orig.lowFreq) + pixelDeltaY, dim.height);
            }

            redrawCanvasBoxes();
            syncPopupFieldsFromBox(box);

            // Update isolation mask + filter cutoffs if this is the isolated box
            if (isolatedFeatureBox &&
                isolatedFeatureBox.regionIndex === box.regionIndex &&
                isolatedFeatureBox.featureIndex === box.featureIndex) {
                // Keep reference in sync (rebuild may have created a new object)
                isolatedFeatureBox = box;
                const originalSampleRate = State.currentMetadata?.original_sample_rate || 100;
                const baseSampleRateEl = document.getElementById('baseSampleRate');
                const playbackSampleRate = baseSampleRateEl ? parseFloat(baseSampleRateEl.value) : 44100;
                const speedup = playbackSampleRate / originalSampleRate;
                updateIsolationFrequencies(box.lowFreq * speedup, box.highFreq * speedup);
            }
        }
        return true;
    }

    // Don't claim hover events during an active selection drag
    if (spectrogramSelectionActive) return false;

    // Not dragging — set hover cursor for box edges/corners (windowed mode only)
    const _modeHover = document.getElementById('viewingMode');
    const isWindowed = _modeHover && (_modeHover.value === 'static' || _modeHover.value === 'scroll' || _modeHover.value === 'pageTurn');
    const interaction = isWindowed ? getBoxInteraction(mouseX, mouseY) : null;
    hoveredBoxInteraction = interaction;

    // Update hover state via single source of truth
    updateHoveredBox(mouseX, mouseY);

    if (interaction) {
        canvas.style.cursor = interaction.mode === 'move' ? 'pointer' : getCursorForMode(interaction.mode);
        return true;
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
        const features = getStandaloneFeatures();
        const feature = features[box.featureIndex];
        if (feature) {
            feature.startTime = box.startTime;
            feature.endTime = box.endTime;
            feature.lowFreq = box.lowFreq;
            feature.highFreq = box.highFreq;
            saveStandaloneFeatures();
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
let popupLastSide = null;       // 'left' or 'right' — tracks which side popup is on
let popupDetailsOpen = false;   // true while Details is expanded — locks vertical position
let popupPinOffset = null;      // { dx, dy } drag offset from computed pinned position

// ── Feature play button state ──
let featurePlaybackRAF = null;
let featurePlaybackEndTime = null; // audio seconds at which to auto-stop

// ── Feature isolation state ──
let isolatedFeatureBox = null; // The box currently being isolated (for overlay dimming + audio filter)
let lastIsolatedFeatureId = null; // { regionIndex, featureIndex } — remembers which feature had isolation on

// When playback starts during isolation, auto-stop at the box boundary.
// If playhead is at/past the end, jump back to the feature start.
onPlaybackStateChange((newState) => {
    if (newState === PlaybackState.PLAYING && isolatedFeatureBox) {
        if (State.dataStartTime && isolatedFeatureBox.endTime && isolatedFeatureBox.startTime) {
            const dataStartMs = State.dataStartTime.getTime();
            const isoStartSec = (new Date(isolatedFeatureBox.startTime).getTime() - dataStartMs) / 1000;
            const isoEndSec = (new Date(isolatedFeatureBox.endTime).getTime() - dataStartMs) / 1000;
            const pos = getCurrentPosition();
            if (pos >= isoEndSec || pos < isoStartSec) {
                seekToPosition(isoStartSec, true);
                return; // seekToPosition will fire another PLAYING event
            }
        }
        startIsolationEndStop();
    }
});

/**
 * Start a RAF monitor that auto-pauses playback when it reaches endTimeSec.
 */
function startPlaybackEndMonitor(endTimeSec) {
    if (featurePlaybackRAF) {
        cancelAnimationFrame(featurePlaybackRAF);
        featurePlaybackRAF = null;
    }
    featurePlaybackEndTime = endTimeSec;

    function monitorPlayback() {
        if (State.playbackState !== PlaybackState.PLAYING) {
            featurePlaybackRAF = null;
            featurePlaybackEndTime = null;
            return;
        }
        const pos = getCurrentPosition();
        if (pos >= featurePlaybackEndTime) {
            if (State.isLooping && isolatedFeatureBox && State.dataStartTime) {
                const dataStartMs = State.dataStartTime.getTime();
                const isoStartSec = (new Date(isolatedFeatureBox.startTime).getTime() - dataStartMs) / 1000;
                const padding = 0.5;
                seekToPosition(Math.max(0, isoStartSec - padding), true);
                startIsolationEndStop();
            } else {
                pausePlayback();
                featurePlaybackRAF = null;
                featurePlaybackEndTime = null;
            }
            return;
        }
        featurePlaybackRAF = requestAnimationFrame(monitorPlayback);
    }
    featurePlaybackRAF = requestAnimationFrame(monitorPlayback);
}

/**
 * If isolation mode is active, compute the end-stop time from the isolated box
 * and start the playback monitor. Call this after any seek/play action.
 */
function startIsolationEndStop() {
    if (!isolatedFeatureBox || !State.dataStartTime || !State.totalAudioDuration) return;
    const dataStartMs = State.dataStartTime.getTime();
    const endSec = (new Date(isolatedFeatureBox.endTime).getTime() - dataStartMs) / 1000;
    const padding = 0.5;
    const paddedEnd = Math.min(State.totalAudioDuration, endSec + padding);
    startPlaybackEndMonitor(paddedEnd);
}

/**
 * Play a feature: seek to just before it, play through, auto-stop just after.
 * Always restarts from the beginning (not a toggle).
 */
function playFeature(startTimeISO, endTimeISO) {
    if (!State.dataStartTime || !State.totalAudioDuration) return;

    const dataStartMs = State.dataStartTime.getTime();
    const featureStartSec = (new Date(startTimeISO).getTime() - dataStartMs) / 1000;
    const featureEndSec = (new Date(endTimeISO).getTime() - dataStartMs) / 1000;

    // Add padding (0.5s before/after), clamped to audio bounds
    const padding = 0.5;
    const paddedStart = Math.max(0, featureStartSec - padding);
    const paddedEnd = Math.min(State.totalAudioDuration, featureEndSec + padding);

    // Seek and start playing
    seekToPosition(paddedStart, true);
    startPlaybackEndMonitor(paddedEnd);
}

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
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    const h = d.getUTCHours();
    const min = String(d.getUTCMinutes()).padStart(2, '0');
    const s = String(d.getUTCSeconds()).padStart(2, '0');
    return `${mm}/${dd}/${yyyy} ${h}:${min}:${s}`;
}

/**
 * Convert a popup time string back to a full ISO string.
 * Accepts "MM/DD/YYYY H:MM:SS" or legacy "H:MM:SS" (date from originalISO).
 */
function parsePopupTimeToISO(shortTime, originalISO) {
    if (!shortTime || !originalISO) return shortTime;
    const orig = new Date(originalISO);
    if (isNaN(orig.getTime())) return shortTime;

    // Try MM/DD/YYYY H:MM:SS format first
    const dateTimeMatch = shortTime.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
    if (dateTimeMatch) {
        const [, mo, dy, yr, hr, mn, sc] = dateTimeMatch.map(Number);
        orig.setUTCFullYear(yr, mo - 1, dy);
        orig.setUTCHours(hr, mn, sc, 0);
        return orig.toISOString();
    }

    // Fallback: time-only (H:MM:SS)
    const parts = shortTime.split(':').map(Number);
    if (parts.length < 2 || parts.some(isNaN)) return shortTime;
    orig.setUTCHours(parts[0], parts[1], parts[2] || 0, 0);
    return orig.toISOString();
}

export function isFeaturePopupOpen() {
    return popupFeatureBox !== null;
}

/** Returns "regionIndex-featureIndex" key of mouse-hovered box, or null */
export function getHoveredBoxKey() {
    return hoveredBoxKey;
}

export function closeFeaturePopup() {
    if (featurePopupEl && popupFeatureBox != null) {
        // Auto-save notes/confidence before destroying popup — feature-tracker owns the D1 sync
        const updates = {};
        const notesArea = featurePopupEl.querySelector('.feature-popup-notes');
        if (notesArea) updates.notes = notesArea.value.trim();
        const activePill = featurePopupEl.querySelector('.feature-popup-pill.active');
        if (activePill) updates.confidence = activePill.dataset.confidence;
        updateFeature(popupFeatureBox.featureIndex, updates);
    }
    if (featurePopupEl) {
        featurePopupEl.remove();
        featurePopupEl = null;
    }
    popupDetailsOpen = false;
    if (featurePopupCleanup) {
        featurePopupCleanup();
        featurePopupCleanup = null;
    }
    // Always disable isolation visually/audibly on close, but remember the feature
    if (isolatedFeatureBox) {
        disableIsolation();
        isolatedFeatureBox = null;
        redrawCanvasBoxes();
    }
    popupFeatureBox = null;
    popupPinOffset = null;
    popupLastSide = null;
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
    const scale = getCSSToDeviceScale();
    return {
        left:   canvasRect.left + rect.x / scale.x,
        right:  canvasRect.left + (rect.x + rect.w) / scale.x,
        top:    canvasRect.top  + rect.y / scale.y,
        bottom: canvasRect.top  + (rect.y + rect.h) / scale.y
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
    let side = null;

    if (sr) {
        const spaceRight = window.innerWidth - sr.right;
        const spaceLeft = sr.left;
        const boxCenterY = (sr.top + sr.bottom) / 2;

        if (spaceRight >= popupRect.width + gap || spaceRight >= spaceLeft) {
            left = sr.right + gap;
            side = 'right';
        } else {
            left = sr.left - popupRect.width - gap;
            side = 'left';
        }
        top = boxCenterY - popupRect.height / 2;
    } else {
        left = (window.innerWidth - popupRect.width) / 2;
        top = (window.innerHeight - popupRect.height) / 2;
    }

    // Fade out and back in when the popup switches sides
    if (side && popupLastSide && side !== popupLastSide) {
        popup.style.transition = 'none';
        popup.style.opacity = '0';
        requestAnimationFrame(() => {
            popup.style.transition = 'opacity 200ms ease';
            popup.style.opacity = '1';
            // Clear inline transition after fade so CSS classes (--off-screen) work again
            setTimeout(() => { popup.style.transition = ''; popup.style.opacity = ''; }, 220);
        });
    }
    popupLastSide = side;

    // Store anchor position before offset
    const anchorLeft = left;
    const anchorTop = top;

    // Apply drag offset if any
    if (offset) {
        left += offset.dx;
        top += offset.dy;
    }

    // When Details is open, keep the current top so popup grows downward
    if (popupDetailsOpen && popup.style.top) {
        top = parseFloat(popup.style.top);
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

    // Opening a different feature clears isolation
    if (isolatedFeatureBox &&
        (isolatedFeatureBox.regionIndex !== box.regionIndex ||
         isolatedFeatureBox.featureIndex !== box.featureIndex)) {
        disableIsolation();
        isolatedFeatureBox = null;
        lastIsolatedFeatureId = null;
        redrawCanvasBoxes();
    }

    // Track which feature this popup belongs to
    popupFeatureBox = { regionIndex: box.regionIndex, featureIndex: box.featureIndex };
    popupPinOffset = null;

    // Get feature data
    const standalone = getStandaloneFeatures();
    const feature = standalone[box.featureIndex];
    if (!feature) return;

    // Build popup DOM
    const flatNum = getFlatFeatureNumber(box.regionIndex, box.featureIndex);
    const isAdvanced = document.getElementById('advancedMode')?.checked;
    const reviewMode = !!window.__REVIEW_MODE;
    const canDelete = !reviewMode;
    const popup = document.createElement('div');
    popup.className = 'feature-popup';
    popup.innerHTML = `
        <div class="feature-popup-header">
            <!-- Play triangle vertical position: adjust top:-Npx on the button inline style -->
            <span class="feature-popup-title" style="display:flex;align-items:center">Feature <strong>${flatNum}</strong> <button class="feature-popup-play" title="Play this feature from the beginning" data-start="${feature.startTime}" data-end="${feature.endTime}" style="position:relative;top:-2px">&#9654;</button>${window.__STUDY_MODE ? '' : `<button class="feature-popup-isolate" title="Isolate: bandpass filter to this feature's frequency range" data-low-freq="${feature.lowFreq || ''}" data-high-freq="${feature.highFreq || ''}">Isolate</button>`}</span>
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
                <span class="feature-popup-settings-label">Location</span>
                <div class="feature-popup-settings-options" data-setting="feature_popup_pin">
                    <button data-value="static">Drag & Drop</button>
                    <button data-value="to-feature" class="active">Pin to Feature</button>
                </div>
            </div>
            <div class="feature-popup-settings-row">
                <span class="feature-popup-settings-label">Click Outside</span>
                <div class="feature-popup-settings-options" data-setting="feature_popup_canvas_click">
                    <button data-value="stay-open" class="active">Stay Open</button>
                    <button data-value="close">Close</button>
                </div>
            </div>
            <div class="feature-popup-settings-row">
                <span class="feature-popup-settings-label">New Feature Info</span>
                <div class="feature-popup-settings-options" data-setting="feature_new_info">
                    <button data-value="auto" class="active">Appear Automatically</button>
                    <button data-value="click">Appear on Click</button>
                </div>
            </div>
            <div class="feature-popup-settings-row">
                <span class="feature-popup-settings-label">Text Input</span>
                <div class="feature-popup-settings-options" data-setting="feature_text_required">
                    <button data-value="optional" class="active">Optional</button>
                    <button data-value="required">Required</button>
                </div>
            </div>
        </div>
        ${isStudyMode() ? `<div class="feature-popup-confidence">
            <span class="feature-popup-confidence-label">Is this an EMIC wave?</span>
            <div class="feature-popup-pills">
                <button class="feature-popup-pill${feature.confidence === 'confirmed' ? ' active' : ''}" data-confidence="confirmed">Yes</button>
                <button class="feature-popup-pill${feature.confidence === 'possibly' ? ' active' : ''}" data-confidence="possibly">Possibly</button>
            </div>
        </div>` : ''}
        <textarea class="feature-popup-notes" placeholder="Describe this feature...">${feature.notes || ''}</textarea>
        <details class="feature-popup-details"${reviewMode ? ' open' : ''}>
            <summary>Details</summary>
            <div class="feature-popup-details-content">
                <div class="feature-popup-details-inner">
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
                </div>
            </div>
        </details>
        <button class="feature-popup-save" disabled>Done</button>
    `;

    // Review mode: make everything read-only
    if (reviewMode) {
        const textarea = popup.querySelector('.feature-popup-notes');
        if (textarea) { textarea.readOnly = true; textarea.style.opacity = '0.8'; }
        popup.querySelectorAll('.feature-popup-pill').forEach(btn => { btn.disabled = true; btn.style.pointerEvents = 'none'; });
        popup.querySelectorAll('.feature-popup-details input').forEach(inp => { inp.readOnly = true; });
        const saveBtn = popup.querySelector('.feature-popup-save');
        if (saveBtn) saveBtn.style.display = 'none';
        const gearEl = popup.querySelector('.feature-popup-gear');
        if (gearEl) gearEl.style.display = 'none';
    }

    popup.style.visibility = 'hidden';
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
        popup.classList.toggle('feature-popup--pinned', (localStorage.getItem('feature_popup_pin') || 'to-feature') === 'to-feature');

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

            // Re-evaluate save button when text requirement changes
            if (setting === 'feature_text_required') updateSaveState();

            applyPopupSettings();
        });
    });

    applyPopupSettings();

    // Position beside the feature box (hidden until positioned to prevent jump)
    const sr = box.screenRect || getScreenRectForBox(box);
    positionPopupBesideRect(popup, sr, null);
    popup.style.visibility = '';

    // Forward wheel events to the spectrogram canvas so pan momentum isn't killed
    popup.addEventListener('wheel', (e) => {
        const canvas = document.getElementById('spectrogram');
        if (canvas) {
            canvas.dispatchEvent(new WheelEvent('wheel', e));
            e.preventDefault();
        }
    }, { passive: false });

    // Close button
    popup.querySelector('.feature-popup-close').addEventListener('click', () => closeFeaturePopup());

    // Animated details open/close
    const detailsEl = popup.querySelector('.feature-popup-details');
    if (detailsEl) {
        detailsEl.querySelector('summary').addEventListener('click', (e) => {
            if (detailsEl.open) {
                // Closing: animate first, then remove open attribute
                e.preventDefault();
                const content = detailsEl.querySelector('.feature-popup-details-content');
                content.style.gridTemplateRows = '0fr';
                content.style.opacity = '0';
                content.addEventListener('transitionend', () => {
                    detailsEl.removeAttribute('open');
                    content.style.gridTemplateRows = '';
                    content.style.opacity = '';
                    popupDetailsOpen = false;
                }, { once: true });
            } else {
                popupDetailsOpen = true;
            }
        });
    }

    // Play button
    popup.querySelector('.feature-popup-play').addEventListener('click', (e) => {
        e.stopPropagation();
        e.currentTarget.blur();
        const btn = e.currentTarget;
        playFeature(btn.dataset.start, btn.dataset.end);
    });

    // Isolate button — crossfade to bandpass-filtered audio path (hidden in study mode)
    const isolateBtn = popup.querySelector('.feature-popup-isolate');
    if (isolateBtn && lastIsolatedFeatureId &&
        lastIsolatedFeatureId.regionIndex === box.regionIndex &&
        lastIsolatedFeatureId.featureIndex === box.featureIndex &&
        !isolatedFeatureBox) {
        // Re-enable isolation
        const lf = parseFloat(feature.lowFreq);
        const hf = parseFloat(feature.highFreq);
        if (isFinite(lf) && isFinite(hf) && lf < hf) {
            const origRate = State.currentMetadata?.original_sample_rate || 100;
            const baseEl = document.getElementById('baseSampleRate');
            const playRate = baseEl ? parseFloat(baseEl.value) : 44100;
            const spd = playRate / origRate;
            enableIsolation(lf * spd, hf * spd);
            isolatedFeatureBox = completedSelectionBoxes.find(b =>
                b.regionIndex === box.regionIndex && b.featureIndex === box.featureIndex) || box;
            isolateBtn.classList.add('active');
            // Jump playhead to feature start if outside
            if (State.dataStartTime && isolatedFeatureBox.startTime && isolatedFeatureBox.endTime) {
                const dataStartMs = State.dataStartTime.getTime();
                const isoStartSec = (new Date(isolatedFeatureBox.startTime).getTime() - dataStartMs) / 1000;
                const isoEndSec = (new Date(isolatedFeatureBox.endTime).getTime() - dataStartMs) / 1000;
                const pos = getCurrentPosition();
                if (pos < isoStartSec || pos > isoEndSec) {
                    seekToPosition(isoStartSec, State.playbackState === PlaybackState.PLAYING);
                }
            }
            redrawCanvasBoxes();
        }
    } else if (isolateBtn && isolatedFeatureBox && isolatedFeatureBox.regionIndex === box.regionIndex &&
        isolatedFeatureBox.featureIndex === box.featureIndex) {
        isolateBtn.classList.add('active');
    }
    isolateBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        btn.blur();
        const isActive = btn.classList.toggle('active');

        if (isActive) {
            const lowFreq = parseFloat(feature.lowFreq);
            const highFreq = parseFloat(feature.highFreq);
            if (!isFinite(lowFreq) || !isFinite(highFreq) || lowFreq >= highFreq) return btn.classList.remove('active');

            // Convert data-domain Hz → audio-domain Hz
            const originalSampleRate = State.currentMetadata?.original_sample_rate || 100;
            const baseSampleRateEl = document.getElementById('baseSampleRate');
            const playbackSampleRate = baseSampleRateEl ? parseFloat(baseSampleRateEl.value) : 44100;
            const speedup = playbackSampleRate / originalSampleRate;

            const hpAudio = lowFreq * speedup;
            const lpAudio = highFreq * speedup;

            enableIsolation(hpAudio, lpAudio);
            // Use the full completedSelectionBoxes entry (box from getBoxAtPoint is sparse)
            isolatedFeatureBox = completedSelectionBoxes.find(b =>
                b.regionIndex === box.regionIndex && b.featureIndex === box.featureIndex) || box;
            lastIsolatedFeatureId = { regionIndex: box.regionIndex, featureIndex: box.featureIndex };

            // If playhead is outside the feature, jump to its start
            if (State.dataStartTime && isolatedFeatureBox.startTime && isolatedFeatureBox.endTime) {
                const dataStartMs = State.dataStartTime.getTime();
                const isoStartSec = (new Date(isolatedFeatureBox.startTime).getTime() - dataStartMs) / 1000;
                const isoEndSec = (new Date(isolatedFeatureBox.endTime).getTime() - dataStartMs) / 1000;
                const pos = getCurrentPosition();
                if (pos < isoStartSec || pos > isoEndSec) {
                    const isPlaying = State.playbackState === PlaybackState.PLAYING;
                    seekToPosition(isoStartSec, isPlaying);
                }
            }

            redrawCanvasBoxes();
        } else {
            disableIsolation();
            isolatedFeatureBox = null;
            lastIsolatedFeatureId = null;
            redrawCanvasBoxes();
        }
    });

    // Delete button with confirmation (only present when canDelete is true)
    popup.querySelector('.feature-popup-delete')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const label = `Feature ${getFlatFeatureNumber(box.regionIndex, box.featureIndex)}`;
        if (await confirmDelete(`Delete ${label}? This cannot be undone.`, e.clientX, e.clientY)) {
            deleteStandaloneFeature(box.featureIndex);
            redrawAllCanvasFeatureBoxes();
            renderStandaloneFeaturesList();
        }
    });

    // Draggable header
    const header = popup.querySelector('.feature-popup-header');
    let dragOffsetX = 0, dragOffsetY = 0, isDragging = false;
    let dragStartLeft = 0, dragStartTop = 0;
    header.addEventListener('mousedown', (ev) => {
        if (ev.target.closest('.feature-popup-close') || ev.target.closest('.feature-popup-gear') || ev.target.closest('.feature-popup-delete') || ev.target.closest('.feature-popup-play')) return;
        // No dragging in pin-to-feature mode
        if ((localStorage.getItem('feature_popup_pin') || 'to-feature') === 'to-feature') return;
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
        const pinMode = localStorage.getItem('feature_popup_pin') || 'to-feature';
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
    const pills = popup.querySelectorAll('.feature-popup-pill');

    // Wire confidence pills
    if (window.pm?.interaction) console.log('%c[PILL] Wiring pills:', 'color: #f00; font-weight: bold', pills.length, 'pills found');
    pills.forEach(pill => {
        pill.addEventListener('click', (e) => {
            if (window.pm?.interaction) console.log('%c[PILL] CLICKED!', 'color: #f00; font-weight: bold', pill.dataset.confidence);
            e.stopPropagation();
            pills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            // Write confidence immediately to feature object
            const features = getStandaloneFeatures();
            const f = features[box.featureIndex];
            if (window.pm?.interaction) console.log('%c[PILL] feature:', 'color: #f00', f?.confidence, '→', pill.dataset.confidence);
            if (f) f.confidence = pill.dataset.confidence;
            rebuildCanvasBoxesFromFeatures();
            updateSaveState();
        });
    });

    // Auto-focus: if confidence already set, focus notes; otherwise let eye land on pills
    const hasConfidence = popup.querySelector('.feature-popup-pill.active');
    if (hasConfidence) {
        requestAnimationFrame(() => {
            notesArea.focus();
            notesArea.selectionStart = notesArea.selectionEnd = notesArea.value.length;
        });
    }

    // Track whether user has modified anything
    const originalNotes = notesArea.value;
    const originalFields = {};
    popup.querySelectorAll('input[data-key]').forEach(input => {
        originalFields[input.dataset.key] = input.value;
    });
    let isDirty = false;

    function updateSaveState() {
        const confidenceSelected = popup.querySelector('.feature-popup-pill.active');
        // Check if anything changed from the original
        isDirty = notesArea.value !== originalNotes;
        if (!isDirty) {
            popup.querySelectorAll('input[data-key]').forEach(input => {
                if (input.value !== originalFields[input.dataset.key]) isDirty = true;
            });
        }
        saveBtn.disabled = pills.length > 0 ? !confidenceSelected : false;
        saveBtn.textContent = isDirty ? 'Save' : 'Done';
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

    // Clamp low/high frequency inputs so they can't cross each other.
    // Fires on blur/Enter (not on every keystroke) so the user can still
    // type intermediate values like "120" on the way to "1200".
    function clampFreqInputs(changedKey) {
        const lowInput = popup.querySelector('input[data-key="lowFreq"]');
        const highInput = popup.querySelector('input[data-key="highFreq"]');
        if (!lowInput || !highInput) return;
        const low = parseFloat(lowInput.value);
        const high = parseFloat(highInput.value);
        if (!isFinite(low) || !isFinite(high)) return;
        if (low >= high) {
            // Snap the one the user just edited to the boundary so they see it.
            if (changedKey === 'lowFreq') {
                lowInput.value = (high - 0.001).toFixed(3);
            } else {
                highInput.value = (low + 0.001).toFixed(3);
            }
            // Mirror into the feature object + redraw
            const features = getStandaloneFeatures();
            const f = features[box.featureIndex];
            if (f) {
                f.lowFreq = lowInput.value;
                f.highFreq = highInput.value;
            }
            redrawAllCanvasFeatureBoxes();
            updateSaveState();
        }
    }

    // Live-update feature box as user edits time/frequency fields
    popup.querySelectorAll('input[data-key]').forEach(input => {
        input.addEventListener('input', () => {
            const key = input.dataset.key;
            const val = resolveInputValue(input);
            if (!val || !key) return;

            // Write directly to the feature object
            const features = getStandaloneFeatures();
            const f = features[box.featureIndex];
            if (f) f[key] = val;

            // Redraw the canvas boxes to reflect the change
            redrawAllCanvasFeatureBoxes();
            updateSaveState();
        });
        // Clamp on blur / Enter for frequency inputs only
        if (input.dataset.key === 'lowFreq' || input.dataset.key === 'highFreq') {
            input.addEventListener('blur', () => clampFreqInputs(input.dataset.key));
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') clampFreqInputs(input.dataset.key);
            });
        }
    });

    // Save logic
    function saveAndClose() {
        const features = getStandaloneFeatures();
        const f = features[box.featureIndex];
        if (f) {
            f.notes = notesArea.value.trim();
            const activePill = popup.querySelector('.feature-popup-pill.active');
            if (activePill) f.confidence = activePill.dataset.confidence;
            // Update editable fields if changed
            popup.querySelectorAll('input[data-key]').forEach(input => {
                const key = input.dataset.key;
                const val = resolveInputValue(input);
                if (val && key) f[key] = val;
            });
            saveStandaloneFeatures();
            renderStandaloneFeaturesList();
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
        if (e.key === 'Enter' && !e.shiftKey && !isStudyMode() && !saveBtn.disabled) {
            e.preventDefault();
            e.stopPropagation();
            saveAndClose();
        }
    }
    function onClickOutside(e) {
        if (featurePopupEl && !featurePopupEl.contains(e.target)) {
            // If clicking on a feature box on the canvas, let box click handler toggle
            const canvas = document.getElementById('spectrogram');
            if (canvas && canvas.contains(e.target)) {
                const rect = canvas.getBoundingClientRect();
                // getBoxAtPoint expects CSS pixels (it scales internally)
                const clickX = e.clientX - rect.left;
                const clickY = e.clientY - rect.top;
                if (getBoxAtPoint(clickX, clickY)) return;
            }
            // "Stay open" mode: only close via X button or Save
            if ((localStorage.getItem('feature_popup_canvas_click') || 'stay-open') === 'stay-open') return;
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
    completedSelectionBoxes = [];

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
                notes: feature.notes,
                confidence: feature.confidence,
            });
        }
    });

    // Re-link isolatedFeatureBox to the new object (rebuild breaks the old reference)
    if (isolatedFeatureBox) {
        isolatedFeatureBox = completedSelectionBoxes.find(b =>
            b.regionIndex === isolatedFeatureBox.regionIndex &&
            b.featureIndex === isolatedFeatureBox.featureIndex) || null;
        if (!isolatedFeatureBox) disableIsolation();
    }

    // Redraw with rebuilt boxes
    redrawCanvasBoxes();
}

/**
 * Draw isolation dimming overlay: semi-transparent dark layer with a clear cutout
 * over the isolated feature box. Call AFTER clearing the canvas and BEFORE drawing boxes.
 */
function drawIsolationDimming(ctx) {
    if (!isolatedFeatureBox || !spectrogramOverlayCanvas) { return; }
    const rect = getBoxDeviceRect(isolatedFeatureBox);
    if (!rect) return;

    const w = spectrogramOverlayCanvas.width;
    const h = spectrogramOverlayCanvas.height;

    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';

    // Draw four rectangles around the cutout (avoids using clip/compositing)
    const bx = Math.max(0, rect.x);
    const by = Math.max(0, rect.y);
    const bx2 = Math.min(w, rect.x + rect.w);
    const by2 = Math.min(h, rect.y + rect.h);

    // Top strip (full width, above box)
    if (by > 0) ctx.fillRect(0, 0, w, by);
    // Bottom strip (full width, below box)
    if (by2 < h) ctx.fillRect(0, by2, w, h - by2);
    // Left strip (between top and bottom strips)
    if (bx > 0) ctx.fillRect(0, by, bx, by2 - by);
    // Right strip (between top and bottom strips)
    if (bx2 < w) ctx.fillRect(bx2, by, w - bx2, by2 - by);

    ctx.restore();
}

/**
 * Redraw canvas boxes (internal - clears and draws all boxes)
 */
function redrawCanvasBoxes() {
    if (spectrogramOverlayCtx && spectrogramOverlayCanvas) {
        spectrogramOverlayCtx.clearRect(0, 0, spectrogramOverlayCanvas.width, spectrogramOverlayCanvas.height);

        // Isolation dimming: darken everything outside the isolated feature
        drawIsolationDimming(spectrogramOverlayCtx);

        // Skip drawing if feature boxes are hidden
        const fbCheckbox = document.getElementById('featureBoxesVisible');
        if (fbCheckbox && !fbCheckbox.checked) return;

        // PASS 1: Draw all boxes (without annotations)
        for (const savedBox of completedSelectionBoxes) {
            drawSavedBox(spectrogramOverlayCtx, savedBox, false);
        }
        // PASS 2: Draw all annotations on top (with collision detection)
        const placedAnnotations = [];
        for (const savedBox of completedSelectionBoxes) {
            drawSavedBox(spectrogramOverlayCtx, savedBox, true, placedAnnotations);
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
let featureBoxPendingUntilSpectrogram = false;
let featureBoxGeneration = 0;  // incremented on clear — stale listeners self-invalidate

export function redrawAllCanvasFeatureBoxes() {
    // Don't draw feature boxes until pyramid tiles have rendered
    if (!featureBoxReadyToShow) {
        if (window.pm?.features) console.log(`📦 [FEAT-BOX] redrawAll called but NOT ready (pending=${featureBoxPendingUntilSpectrogram})`);
        if (!featureBoxPendingUntilSpectrogram) {
            featureBoxPendingUntilSpectrogram = true;
            const gen = featureBoxGeneration;
            if (window.pm?.rendering) console.log(`📦 [FEAT-BOX] Registering pyramid-ready listener (gen=${gen})`);
            window.addEventListener('pyramid-ready', () => {
                if (gen !== featureBoxGeneration) return; // stale — section changed since registration
                if (window.pm?.rendering) console.log(`📦 [FEAT-BOX] pyramid-ready FIRED! Starting fade-in`);
                featureBoxPendingUntilSpectrogram = false;
                featureBoxReadyToShow = true;
                featureBoxOpacity = 1; // show immediately — no rAF loop to drive a fade
                rebuildCanvasBoxesFromFeatures();
                // Redraw minimap so its feature boxes appear at the same time
                drawWaveformFromMinMax();
            }, { once: true });
        }
        return;
    }
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
        if (window.pm?.rendering) console.log(`🎬 updateCanvasAnnotations() IS RUNNING! First call.`);
    }


    if (spectrogramOverlayCtx && spectrogramOverlayCanvas) {
        spectrogramOverlayCtx.clearRect(0, 0, spectrogramOverlayCanvas.width, spectrogramOverlayCanvas.height);

        // Isolation dimming: darken everything outside the isolated feature
        drawIsolationDimming(spectrogramOverlayCtx);

        // Fade in feature boxes after spectrogram is ready
        if (featureBoxReadyToShow && featureBoxOpacity < 1) {
            featureBoxOpacity = Math.min(1, featureBoxOpacity + 0.02); // ~0.8s fade at 60fps
        }

        // Skip drawing if feature boxes are hidden
        const fbCheckbox = document.getElementById('featureBoxesVisible');
        const boxesHidden = fbCheckbox && !fbCheckbox.checked;

        if (!boxesHidden && featureBoxReadyToShow) {
            spectrogramOverlayCtx.save();
            spectrogramOverlayCtx.globalAlpha = featureBoxOpacity;

            // PASS 1: Draw all boxes (without annotations)
            for (const savedBox of completedSelectionBoxes) {
                drawSavedBox(spectrogramOverlayCtx, savedBox, false); // false = don't draw annotations yet
            }

            // PASS 2: Draw all annotations on top (with collision detection)
            // Skip annotation for the feature whose popup is open
            const placedAnnotations = []; // Track placed annotations for collision detection
            for (const savedBox of completedSelectionBoxes) {
                if (featurePopupEl && popupFeatureBox &&
                    savedBox.regionIndex === popupFeatureBox.regionIndex &&
                    savedBox.featureIndex === popupFeatureBox.featureIndex) continue;
                drawSavedBox(spectrogramOverlayCtx, savedBox, true, placedAnnotations); // true = only draw annotations
            }

            spectrogramOverlayCtx.restore();
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
                const playbackRate = State.getPlaybackRate();
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
    const pinMode = localStorage.getItem('feature_popup_pin') || 'to-feature';
    if (pinMode !== 'to-feature') return;

    // Find the matching box in completedSelectionBoxes
    const box = completedSelectionBoxes.find(b =>
        b.regionIndex === popupFeatureBox.regionIndex &&
        b.featureIndex === popupFeatureBox.featureIndex
    );
    if (!box) return;

    const sr = getScreenRectForBox(box);
    if (!sr) {
        // Can't compute position at all — hide popup
        featurePopupEl.classList.add('feature-popup--off-screen');
        return;
    }

    // Always reposition to follow the box (even off-canvas)
    positionPopupBesideRect(featurePopupEl, sr, popupPinOffset);

    // Fade out when feature box is fully off the canvas viewport
    const canvas = document.getElementById('spectrogram');
    if (canvas) {
        const canvasRect = canvas.getBoundingClientRect();
        const offScreen = sr.right < canvasRect.left || sr.left > canvasRect.right ||
            sr.bottom < canvasRect.top || sr.top > canvasRect.bottom;
        featurePopupEl.classList.toggle('feature-popup--off-screen', offScreen);
    } else {
        featurePopupEl.classList.remove('feature-popup--off-screen');
    }
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
            if (window.pm?.init) console.log(`📊 Loaded saved frequency scale: ${savedValue}`);
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
            if (window.pm?.init) console.log(`🎨 Loaded saved colormap: ${savedValue}`);
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
            if (window.pm?.init) console.log(`📐 Loaded saved FFT size: ${value}`);
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

                const playbackRate = State.getPlaybackRate();
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

            const playbackRate = State.getPlaybackRate();
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

    if (window.pm?.init) console.log('✅ [SETUP] Setting up spectrogram selection (first time)');

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
    // Use offsetLeft/offsetTop (relative to offset parent) — robust across layout changes
    spectrogramOverlayCanvas.style.left = (canvas.offsetLeft + canvas.clientLeft) + 'px';
    spectrogramOverlayCanvas.style.top = (canvas.offsetTop + canvas.clientTop) + 'px';
    
    // Size overlay from CSS truth (offsetWidth/offsetHeight) — always current
    spectrogramOverlayCanvas.width = canvas.offsetWidth;
    spectrogramOverlayCanvas.height = canvas.offsetHeight;
    spectrogramOverlayCanvas.style.width = canvas.offsetWidth + 'px';
    spectrogramOverlayCanvas.style.height = canvas.offsetHeight + 'px';
    
    spectrogramOverlayCtx = spectrogramOverlayCanvas.getContext('2d');
    container.appendChild(spectrogramOverlayCanvas);
    
    // 🔥 SLEEP FIX: Update overlay position when canvas resizes or layout changes
    // After sleep, browser may recalculate layout causing misalignment
    // This ResizeObserver keeps overlay aligned with main canvas (like playhead overlay does)
    spectrogramResizeObserver = new ResizeObserver(() => {
        if (spectrogramOverlayCanvas && canvas) {
            spectrogramOverlayCanvas.style.left = (canvas.offsetLeft + canvas.clientLeft) + 'px';
            spectrogramOverlayCanvas.style.top = (canvas.offsetTop + canvas.clientTop) + 'px';
            // Size overlay buffer from CSS layout dimensions (offsetWidth/offsetHeight).
            // canvas.width/height may be stale if Three.js resizeRendererToDisplaySize
            // hasn't run yet — offsetWidth/offsetHeight is the CSS truth.
            const w = canvas.offsetWidth;
            const h = canvas.offsetHeight;
            if (spectrogramOverlayCanvas.width !== w || spectrogramOverlayCanvas.height !== h) {
                spectrogramOverlayCanvas.width = w;
                spectrogramOverlayCanvas.height = h;
            }
            spectrogramOverlayCanvas.style.width = w + 'px';
            spectrogramOverlayCanvas.style.height = h + 'px';

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
            spectrogramOverlayCanvas.style.left = (canvas.offsetLeft + canvas.clientLeft) + 'px';
            spectrogramOverlayCanvas.style.top = (canvas.offsetTop + canvas.clientTop) + 'px';
            const w = canvas.offsetWidth;
            const h = canvas.offsetHeight;
            if (spectrogramOverlayCanvas.width !== w || spectrogramOverlayCanvas.height !== h) {
                spectrogramOverlayCanvas.width = w;
                spectrogramOverlayCanvas.height = h;
            }
            spectrogramOverlayCanvas.style.width = w + 'px';
            spectrogramOverlayCanvas.style.height = h + 'px';

            // Redraw boxes after repositioning
            if (spectrogramOverlayCtx) {
                redrawCanvasBoxes();
            }
        }
    };
    document.addEventListener('visibilitychange', spectrogramRepositionOnVisibility);

    // Redraw annotations immediately when annotation mode changes
    const annotationModeEl = document.getElementById('annotationMode');
    if (annotationModeEl) {
        annotationModeEl.addEventListener('change', () => {
            // Clear annotation timing state so persistent mode shows immediately
            annotationTimingState.clear();
            redrawCanvasBoxes();
        });
    }

    if (window.pm?.init) console.log('✅ Created spectrogram selection overlay canvas:', {
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
            if (window.pm?.render) console.log('👁️ [SLEEP WAKE] Page visible again - checking zoom state:', {
                zoomStateInitialized: zoomState.isInitialized(),
                isInRegion: zoomState.isInitialized() ? zoomState.isInRegion() : 'N/A (not initialized)',
                zoomMode: zoomState.isInitialized() ? zoomState.mode : 'N/A',
                activeRegionId: zoomState.isInitialized() ? zoomState.activeRegionId : 'N/A',
                currentViewStartSample: zoomState.isInitialized() ? zoomState.currentViewStartSample : 'N/A'
            });
            
            // Just became visible (e.g., woke from sleep) - clean up immediately!
            if (spectrogramSelectionActive || spectrogramSelectionBox) {
                if (window.pm?.render) console.log('👁️ Page visible again - cleaning up any stuck selection state');
                cancelSpectrogramSelection();
            }
            // 🔥 SLEEP FIX: Also reset any stale mouse coordinates that might break tracking
            // After sleep, browser mouse events can be in a weird state
            if (!spectrogramSelectionActive && (spectrogramStartX !== null || spectrogramCurrentX !== null)) {
                if (window.pm?.render) console.log('👁️ Page visible again - resetting stale mouse coordinates after sleep');
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
        if (window.pm?.interaction) console.log('🖱️ [MOUSEDOWN] Canvas clicked - checking zoom state:', {
            zoomStateInitialized: zoomState.isInitialized(),
            isInRegion: zoomState.isInitialized() ? zoomState.isInRegion() : 'N/A (not initialized)',
            zoomMode: zoomState.isInitialized() ? zoomState.mode : 'N/A',
            activeRegionId: zoomState.isInitialized() ? zoomState.activeRegionId : 'N/A'
        });
        
        // ✅ Check if clicking on an existing canvas box FIRST (before zoom check)
        // This allows clicking features to zoom in when zoomed out
        const canvasRect = canvas.getBoundingClientRect();
        const clickX = e.clientX - canvasRect.left;
        const clickY = e.clientY - canvasRect.top;

        // Check close button (×) before anything else
        const closedBox = getClickedCloseButton(clickX, clickY);
        if (closedBox) {
            confirmDelete('Delete this feature?', e.clientX, e.clientY).then(ok => {
                if (ok) {
                    deleteStandaloneFeature(closedBox.featureIndex);
                    redrawAllCanvasFeatureBoxes();
                    renderStandaloneFeaturesList();
                }
            });
            return;
        }

        // Box drag/resize handler (self-contained — claims event if on a box)
        if (!spectrogramSelectionActive && handleBoxDragDown(e, canvas)) return;

        const clickedBox = getBoxAtPoint(clickX, clickY);
        if (clickedBox && !spectrogramSelectionActive) {
            // Start frequency selection to re-draw the feature
            startFrequencySelection(clickedBox.regionIndex, clickedBox.featureIndex);
            console.log(`🎯 Clicked canvas box - starting reselection for feature ${clickedBox.featureIndex + 1}`);
            return;
        }

        // Check main window Click dropdown (mousedown action)
        const mainClickMode = document.getElementById('mainWindowClick');
        if (mainClickMode && mainClickMode.value === 'playAudio' && !zoomState.isInRegion()) {
            // Click=Play audio: seek immediately on mousedown
            const modeSelect = document.getElementById('viewingMode');
            const isWindowed = modeSelect && (modeSelect.value === 'static' || modeSelect.value === 'scroll' || modeSelect.value === 'pageTurn');
            if (isWindowed && State.getCompleteSamplesLength() > 0 && State.totalAudioDuration > 0 && zoomState.isInitialized() && State.dataStartTime && State.dataEndTime) {
                const timestamp = zoomState.pixelToTimestamp(clickX, canvasRect.width);
                const dataStartMs = State.dataStartTime.getTime();
                const dataSpanMs = State.dataEndTime.getTime() - dataStartMs;
                let fraction = (timestamp.getTime() - dataStartMs) / dataSpanMs;
                let targetPosition = fraction * State.totalAudioDuration;
                // In isolation mode: click left of feature = jump to start, click right = ignore
                if (isolatedFeatureBox && isolatedFeatureBox.startTime && isolatedFeatureBox.endTime) {
                    const isoStartSec = (new Date(isolatedFeatureBox.startTime).getTime() - dataStartMs) / 1000;
                    const isoEndSec = (new Date(isolatedFeatureBox.endTime).getTime() - dataStartMs) / 1000;
                    if (targetPosition > isoEndSec) return;
                    if (targetPosition < isoStartSec) targetPosition = isoStartSec;
                }
                const clamped = Math.max(0, Math.min(targetPosition, State.totalAudioDuration));
                State.setCurrentAudioPosition(clamped);
                if (State.audioContext) {
                    State.setLastUpdateTime(State.audioContext.currentTime);
                }
                Promise.all([
                    import('./audio-player.js'),
                    import('./spectrogram-playhead.js'),
                    import('./minimap-window-renderer.js')
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
            if (window.pm?.interaction) console.log('🧹 Cleaning up stale selection state before starting new one');
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
                    
                    spectrogramOverlayCanvas.style.left = (canvas.offsetLeft + canvas.clientLeft) + 'px';
                    spectrogramOverlayCanvas.style.top = (canvas.offsetTop + canvas.clientTop) + 'px';
                    spectrogramOverlayCanvas.width = canvas.offsetWidth;
                    spectrogramOverlayCanvas.height = canvas.offsetHeight;
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
                
                spectrogramOverlayCanvas.style.left = (canvas.offsetLeft + canvas.clientLeft) + 'px';
                spectrogramOverlayCanvas.style.top = (canvas.offsetTop + canvas.clientTop) + 'px';
                spectrogramOverlayCanvas.width = canvas.offsetWidth;
                spectrogramOverlayCanvas.height = canvas.offsetHeight;
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
        const hoveredBox = updateHoveredBox(hoverX, hoverY);
        const hoveredClose = getClickedCloseButton(hoverX, hoverY);

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

        // ✅ PURE CANVAS: Update state (clamp bottom to 5px above canvas edge)
        spectrogramCurrentX = currentX;
        spectrogramCurrentY = Math.min(currentY, canvasRect.height - 5);

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
        const isDragDrawFeature = !mainDragMode || mainDragMode.value === 'drawFeature';
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
    
    // --- Edge clamping: when drawing extends beyond canvas, clamp X at edge, keep Y alive ---
    let _docMoveHandler = null;
    let _docUpHandler = null;

    function _attachDocumentDrawListeners() {
        if (_docMoveHandler) return; // already attached

        _docMoveHandler = (e) => {
            if (!spectrogramSelectionActive || !spectrogramOverlayCtx) return;

            const canvasRect = canvas.getBoundingClientRect();
            const rawX = e.clientX - canvasRect.left;
            const rawY = e.clientY - canvasRect.top;

            // Clamp both axes to canvas bounds
            spectrogramCurrentX = Math.max(0, Math.min(rawX, canvasRect.width));
            spectrogramCurrentY = Math.max(0, Math.min(rawY, canvasRect.height - 5));

            // Detect drag threshold
            if (!spectrogramWasDrag && spectrogramStartX !== null) {
                const dx = Math.abs(spectrogramCurrentX - spectrogramStartX);
                const dy = Math.abs(spectrogramCurrentY - spectrogramStartY);
                if (Math.max(dx, dy) >= 5) {
                    spectrogramWasDrag = true;
                }
            }

            // Redraw overlay
            const mainDragMode = document.getElementById('mainWindowDrag');
            if (!mainDragMode || mainDragMode.value === 'drawFeature') {
                const width = spectrogramOverlayCanvas.width;
                const height = spectrogramOverlayCanvas.height;
                spectrogramOverlayCtx.clearRect(0, 0, width, height);
                for (const box of completedSelectionBoxes) {
                    drawSavedBox(spectrogramOverlayCtx, box);
                }
                drawSpectrogramSelectionBox(spectrogramOverlayCtx, width, height);
            }
        };

        _docUpHandler = (e) => {
            if (!spectrogramSelectionActive) return;
            // Clamp final coordinates before forwarding to the canvas mouseup handler
            const canvasRect = canvas.getBoundingClientRect();
            const rawX = e.clientX - canvasRect.left;
            spectrogramCurrentX = Math.max(0, Math.min(rawX, canvasRect.width));
            spectrogramCurrentY = Math.max(0, Math.min(e.clientY - canvasRect.top, canvasRect.height - 5));
            // Fire the same handler as canvas mouseup
            spectrogramMouseUpHandler(e);
        };

        document.addEventListener('mousemove', _docMoveHandler);
        document.addEventListener('mouseup', _docUpHandler);
    }

    function _detachDocumentDrawListeners() {
        if (_docMoveHandler) {
            document.removeEventListener('mousemove', _docMoveHandler);
            _docMoveHandler = null;
        }
        if (_docUpHandler) {
            document.removeEventListener('mouseup', _docUpHandler);
            _docUpHandler = null;
        }
    }

    // Expose detach so cancelSpectrogramSelection can clean up
    window._detachSpectrogramDocListeners = _detachDocumentDrawListeners;

    canvas.addEventListener('mouseleave', () => {
        cancelBoxDrag();
        updateHoveredBox(null, null);
        if (spectrogramSelectionActive) {
            // Don't cancel — attach document listeners so drawing continues with edge clamping
            _attachDocumentDrawListeners();
        }
    });

    canvas.addEventListener('mouseenter', () => {
        if (spectrogramSelectionActive) {
            // Back on canvas — remove document listeners, canvas handlers take over
            _detachDocumentDrawListeners();
        }
        // Sleep recovery: reset stale state
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
            if ((!mainReleaseMode || mainReleaseMode.value === 'playAudio') && !zoomState.isInRegion()) {
                const canvasRect = canvas.getBoundingClientRect();
                const releaseX = e.clientX - canvasRect.left;
                const modeSelect = document.getElementById('viewingMode');
                const isWindowed = modeSelect && (modeSelect.value === 'static' || modeSelect.value === 'scroll' || modeSelect.value === 'pageTurn');
                if (isWindowed && State.getCompleteSamplesLength() > 0 && State.totalAudioDuration > 0 && zoomState.isInitialized() && State.dataStartTime && State.dataEndTime) {
                    const timestamp = zoomState.pixelToTimestamp(releaseX, canvasRect.width);
                    const dataStartMs = State.dataStartTime.getTime();
                    const dataSpanMs = State.dataEndTime.getTime() - dataStartMs;
                    let fraction = (timestamp.getTime() - dataStartMs) / dataSpanMs;
                    let targetPosition = fraction * State.totalAudioDuration;
                    // In isolation mode: click left of feature = jump to start, click right = ignore
                    if (isolatedFeatureBox && isolatedFeatureBox.startTime && isolatedFeatureBox.endTime) {
                        const isoStartSec = (new Date(isolatedFeatureBox.startTime).getTime() - dataStartMs) / 1000;
                        const isoEndSec = (new Date(isolatedFeatureBox.endTime).getTime() - dataStartMs) / 1000;
                        if (targetPosition > isoEndSec) return;
                        if (targetPosition < isoStartSec) targetPosition = isoStartSec;
                    }
                    const clamped = Math.max(0, Math.min(targetPosition, State.totalAudioDuration));
                    State.setCurrentAudioPosition(clamped);
                    if (State.audioContext) {
                        State.setLastUpdateTime(State.audioContext.currentTime);
                    }
                    Promise.all([
                        import('./audio-player.js'),
                        import('./spectrogram-playhead.js'),
                        import('./minimap-window-renderer.js')
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
        const isDragDrawFeature = !mainDragMode || mainDragMode.value === 'drawFeature';

        if (!isDragDrawFeature) {
            // Drag=No action — cancel without creating feature
            cancelSpectrogramSelection();
            return;
        }

        // Drag=Draw feature — create the feature
        const endY_css = spectrogramCurrentY;
        const endX_css = spectrogramCurrentX;

        // Convert CSS pixels to DEVICE pixels (same coordinate system as axis!)
        const scale = getCSSToDeviceScale();
        const dim = getOverlayDimensions();
        const startY_device = spectrogramStartY * scale.y;
        const endY_device = endY_css * scale.y;
        const startX_device = spectrogramStartX * scale.x;
        const endX_device = endX_css * scale.x;

        // Stop accepting new mouse moves first
        spectrogramSelectionActive = false;
        _detachDocumentDrawListeners();

        // Call the handler (this creates the data for the feature and returns region/feature indices)
        const result = await handleSpectrogramSelection(
            startY_device, endY_device,
            dim.height,
            startX_device, endX_device,
            dim.width
        );

        // Rebuild canvas boxes from feature data (ensures sync with array!)
        rebuildCanvasBoxesFromFeatures();

        // Auto-show feature info popup for newly created feature
        const autoShow = (localStorage.getItem('feature_new_info') || 'auto') === 'auto';
        if (autoShow && completedSelectionBoxes.length > 0) {
            const newBox = completedSelectionBoxes[completedSelectionBoxes.length - 1];
            showFeaturePopup(newBox);
        }

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
    if (!isStudyMode() && window.pm?.init) {
        console.log('🎯 Spectrogram frequency selection enabled');
    }
}

/**
 * Cancel active spectrogram selection (reset state)
 * Called when user presses Escape or exits feature selection mode
 * NOTE: Does NOT clear completed boxes - only cancels the current drag!
 */
export function cancelSpectrogramSelection() {
    // Clean up document-level edge-clamping listeners
    if (window._detachSpectrogramDocListeners) {
        window._detachSpectrogramDocListeners();
    }

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
        if (window.pm?.interaction) console.log(`🧹 Canceled current drag, kept ${completedSelectionBoxes.length} completed boxes`);
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
    if (!spectrogramOverlayCanvas) return;

    // Need zoom state and data times
    if (!State.dataStartTime || !State.dataEndTime || !zoomState.isInitialized()) {
        return;
    }

    // Use overlay canvas dimensions — these track CSS layout (offsetWidth/offsetHeight)
    // and are always current, even when canvas.width/height buffer lags behind.
    const drawWidth = spectrogramOverlayCanvas.width;
    const drawHeight = spectrogramOverlayCanvas.height;

    // Convert eternal coordinates (time/frequency) to pixel positions
    const lowFreq = box.lowFreq;
    const highFreq = box.highFreq;

    // Use same source as Y-axis for consistency
    const originalNyquist = State.originalDataFrequencyRange?.max || 50;

    // Get current playback rate (CRITICAL for stretching!)
    const playbackRate = State.getPlaybackRate();

    // Convert frequencies to Y positions (DEVICE PIXELS) - WITH SCALE INTERPOLATION!
    const scaleTransition = getScaleTransitionState();

    let lowFreqY_device, highFreqY_device;

    if (scaleTransition.inProgress && scaleTransition.oldScaleType) {
        const oldLowY = getYPositionForFrequencyScaled(lowFreq, originalNyquist, drawHeight, scaleTransition.oldScaleType, playbackRate);
        const newLowY = getYPositionForFrequencyScaled(lowFreq, originalNyquist, drawHeight, State.frequencyScale, playbackRate);
        const oldHighY = getYPositionForFrequencyScaled(highFreq, originalNyquist, drawHeight, scaleTransition.oldScaleType, playbackRate);
        const newHighY = getYPositionForFrequencyScaled(highFreq, originalNyquist, drawHeight, State.frequencyScale, playbackRate);

        lowFreqY_device = oldLowY + (newLowY - oldLowY) * scaleTransition.interpolationFactor;
        highFreqY_device = oldHighY + (newHighY - oldHighY) * scaleTransition.interpolationFactor;
    } else {
        lowFreqY_device = getYPositionForFrequencyScaled(lowFreq, originalNyquist, drawHeight, State.frequencyScale, playbackRate);
        highFreqY_device = getYPositionForFrequencyScaled(highFreq, originalNyquist, drawHeight, State.frequencyScale, playbackRate);
    }

    // Convert times to X positions (DEVICE PIXELS)
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

    const startX_device = startProgress * drawWidth;
    const endX_device = endProgress * drawWidth;

    // Check if completely off-screen horizontally (don't draw)
    if (endX_device < 0 || startX_device > drawWidth) {
        return;
    }

    // Check if completely off-screen vertically (don't draw)
    const topY = Math.min(highFreqY_device, lowFreqY_device);
    const bottomY = Math.max(highFreqY_device, lowFreqY_device);
    if (bottomY < 0 || topY > drawHeight) {
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
        const fbc = getFeatureBoxColors();

        ctx.strokeStyle = fbc.stroke;
        ctx.lineWidth = 2;
        // Dashed borders by confidence level
        const conf = box.confidence;
        if (conf === 'possibly') {
            ctx.setLineDash([6, 4]);
            ctx.lineDashOffset = 0;
            // Each edge as its own path — dashes always start from the corner
            ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + width, y); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(x + width, y); ctx.lineTo(x + width, y + height); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(x + width, y + height); ctx.lineTo(x, y + height); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(x, y + height); ctx.lineTo(x, y); ctx.stroke();
            ctx.setLineDash([]);
        } else {
            ctx.strokeRect(x, y, width, height);
        }

        ctx.fillStyle = isBoxHovered ? fbc.fillHover : fbc.fill;
        ctx.fillRect(x, y, width, height);

        const numbersMode = document.getElementById('mainWindowNumbers')?.value || 'red';

        // Shared sizing for close button + number labels (both depend on font size)
        const userFontSize = parseInt(document.getElementById('mainWindowNumbersSize')?.value || '15', 10);
        const closeSize = Math.round(userFontSize * 0.8);
        const closePad = Math.round(userFontSize * 0.4);

        // Draw close button (×) in top-right inside corner — scales with font size
        // Hidden in review mode (read-only)
        if (!window.__REVIEW_MODE) {
        const closeX = x + width - closeSize - closePad;
        const closeY = y + closePad;
        // Only draw × when box is wide enough that it won't look like "6×"
        // 250ms fade in / 150ms fade out based on crossing the size threshold
        const xMinW = closeSize * 2.5 + closePad * 2;
        const xMinH = closeSize + closePad * 3;
        const shouldShowX = width > xMinW && height > xMinH;
        const now = performance.now();
        const fadeKey = `${box.regionIndex}-${box.featureIndex}-close`;
        let fadeState = closeButtonFadeState.get(fadeKey);
        if (!fadeState) {
            fadeState = { visible: shouldShowX, transitionStart: now - 250 };
            closeButtonFadeState.set(fadeKey, fadeState);
        }
        if (shouldShowX !== fadeState.visible) {
            fadeState.visible = shouldShowX;
            fadeState.transitionStart = now;
        }
        const elapsed = now - fadeState.transitionStart;
        const fadeAlpha = shouldShowX
            ? Math.min(1, elapsed / 250)      // fade in
            : Math.max(0, 1 - elapsed / 150); // fade out
        if (fadeAlpha > 0) {
            const inset = 2;
            const xColor = numbersMode === 'white' ? 'rgba(255, 255, 255, 0.8)'
                : numbersMode === 'black' ? 'rgba(0, 0, 0, 0.85)' : fbc.stroke;
            ctx.save();
            ctx.globalAlpha = fadeAlpha;
            ctx.strokeStyle = xColor;
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(closeX + inset, closeY + inset);
            ctx.lineTo(closeX + closeSize - inset, closeY + closeSize - inset);
            ctx.moveTo(closeX + closeSize - inset, closeY + inset);
            ctx.lineTo(closeX + inset, closeY + closeSize - inset);
            ctx.stroke();
            ctx.restore();
        }
        } // end !__REVIEW_MODE close button guard

        // Add flat sequential feature number label (gated by Numbers dropdown)
        if (numbersMode !== 'hide') {
            const numbersLoc = document.getElementById('mainWindowNumbersLoc')?.value || 'above';
            const fontWeight = document.getElementById('mainWindowNumbersWeight')?.value || '500';
            const fontSize = document.getElementById('mainWindowNumbersSize')?.value || '15';
            const shadowOn = (document.getElementById('mainWindowNumbersShadow')?.value || 'on') === 'on';
            const flatNum = getFlatFeatureNumber(box.regionIndex, box.featureIndex);
            const numberText = `${flatNum}`;
            ctx.font = `${fontWeight} ${fontSize}px Arial, sans-serif`;

            // Upper-left normally; slides toward center as box narrows
            // textAlign=center — browser centers around the X we give, no measureText math
            ctx.textAlign = 'center';
            const pad = numbersLoc === 'inside' ? closePad : 2;
            const fSize = parseInt(fontSize, 10);
            // Fixed anchor near upper-left (pad + half a font-size-ish offset)
            // vs box midpoint — whichever is smaller wins
            const leftAnchor = pad + fSize * 0.45;
            const anchorX = Math.min(leftAnchor, width / 2);

            let labelX, labelY;
            if (numbersLoc === 'inside') {
                ctx.textBaseline = 'top';
                labelX = x + anchorX;
                labelY = y + closePad;
            } else {
                ctx.textBaseline = 'bottom';
                labelX = x + anchorX;
                labelY = y - 3;
            }

            if (numbersMode === 'outline') {
                ctx.fillStyle = fbc.label;
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
                ctx.lineWidth = 2.5;
                ctx.lineJoin = 'round';
                if (shadowOn) ctx.strokeText(numberText, labelX, labelY);
                ctx.fillText(numberText, labelX, labelY);
            } else if (numbersMode === 'black') {
                ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
                if (shadowOn) {
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
                    ctx.lineWidth = 2.5;
                    ctx.lineJoin = 'round';
                    ctx.strokeText(numberText, labelX, labelY);
                }
                ctx.fillText(numberText, labelX, labelY);
            } else if (numbersMode === 'white') {
                // White text with dark stroke underneath for contrast
                if (shadowOn) {
                    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
                    ctx.lineWidth = 2.5;
                    ctx.lineJoin = 'round';
                    ctx.strokeText(numberText, labelX, labelY);
                }
                ctx.fillStyle = 'rgba(255, 255, 255, 0.83)';
                ctx.fillText(numberText, labelX, labelY);
            } else {
                // Red
                ctx.fillStyle = fbc.label;
                if (shadowOn) {
                    ctx.strokeStyle = fbc.labelShadow;
                    ctx.lineWidth = 2.5;
                    ctx.lineJoin = 'round';
                    ctx.strokeText(numberText, labelX, labelY);
                }
                ctx.fillText(numberText, labelX, labelY);
            }
            ctx.textAlign = 'left'; // reset
        }

        // Draw resize handles when hovered or being dragged
        const isHovered = hoveredBoxInteraction && completedSelectionBoxes[hoveredBoxInteraction.boxIndex] === box;
        const isDragged = boxDragState && completedSelectionBoxes[boxDragState.boxIndex] === box;
        if (isHovered || isDragged) {
            const hs = 2.5; // handle half-size (device px)
            ctx.fillStyle = fbc.stroke;
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
        const key = `${box.regionIndex}-${box.featureIndex}`;
        const now = performance.now();

        // Annotation mode: "none" | "persistent" | "live"
        const modeSelect = document.getElementById('annotationMode');
        const annotationMode = modeSelect ? modeSelect.value : 'persistent';

        if (annotationMode === 'none') {
            annotationTimingState.delete(key);
            return;
        }

        const liveMode = annotationMode === 'live';
        let opacity = liveMode ? 0 : 1;

        // Ensure a timing/cache entry exists for text measurement caching
        let timing = annotationTimingState.get(key);
        if (!timing) {
            timing = { showTime: now, hideTime: null, state: liveMode ? 'hidden' : 'visible' };
            annotationTimingState.set(key, timing);
        }

        if (liveMode) {
            // Hover works regardless of audio/zoom state
            const isHovered = hoveredBoxKey === key;

            // Playhead proximity needs audio state
            let playheadNear = false;
            if (State.totalAudioDuration > 0 && zoomState.isInitialized() && State.dataStartTime && State.dataEndTime) {
                const dataStartMs = State.dataStartTime.getTime();
                const dataEndMs = State.dataEndTime.getTime();
                const totalSamples = zoomState.totalSamples;

                const startTimestampMs = new Date(box.startTime).getTime();
                const endTimestampMs = new Date(box.endTime).getTime();

                const startProgress = (startTimestampMs - dataStartMs) / (dataEndMs - dataStartMs);
                const endProgress = (endTimestampMs - dataStartMs) / (dataEndMs - dataStartMs);

                const featureStartSample = startProgress * totalSamples;
                const featureEndSample = endProgress * totalSamples;

                const currentSample = zoomState.timeToSample(State.currentAudioPosition);
                const samplesToFeature = featureStartSample - currentSample;
                const featureDurationSamples = featureEndSample - featureStartSample;

                const playbackRate = State.getPlaybackRate();
                const LEAD_SAMPLES_OUTPUT = Math.floor(ANNOTATION_LEAD_TIME_MS * 44.1);
                const leadTimeSamples = Math.floor(LEAD_SAMPLES_OUTPUT * playbackRate);

                playheadNear = samplesToFeature <= leadTimeSamples && samplesToFeature > -featureDurationSamples;
            }

            const shouldShow = playheadNear || isHovered;

            if (shouldShow && timing.state !== 'fading-in' && timing.state !== 'visible') {
                timing.showTime = now;
                timing.hideTime = null;
                timing.state = 'fading-in';
                timing.hoveredOnly = isHovered && !playheadNear;
            } else if (!shouldShow && timing.state !== 'fading-out' && timing.state !== 'hidden') {
                const timeSinceShow = now - timing.showTime;
                if (timing.hoveredOnly || timeSinceShow > ANNOTATION_MIN_DISPLAY_MS) {
                    timing.state = 'fading-out';
                    timing.hideTime = now;
                }
            }

            opacity = 0;

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
        }

        if (opacity > 0) {
            // Inverse scale: device→CSS (for text stretch correction)
            const dim = getOverlayDimensions();
            const specCanvas = document.getElementById('spectrogram');
            const cssW = specCanvas?.offsetWidth || dim.width;
            const cssH = specCanvas?.offsetHeight || dim.height;
            const xStretchFactor = (dim.width > 0 && dim.height > 0)
                ? (cssW / dim.width) / (cssH / dim.height) : 1;

            ctx.save();

            // Set font from settings
            const fontSizeInput = document.getElementById('annotationFontSize');
            const annotFontSize = fontSizeInput ? parseInt(fontSizeInput.value) || 13 : 13;
            ctx.font = `600 ${annotFontSize}px Arial, sans-serif`;

            // Check if text/settings changed - only re-wrap if needed
            const lineHeight = Math.round(annotFontSize * 1.23); // ~1.23 ratio like 13→16
            let lines, textWidth, halfWidth, totalHeight;
            const widthInput = document.getElementById('annotationWidth');
            const annotMaxWidth = widthInput ? parseInt(widthInput.value) || 325 : 325;
            if (timing.cachedText !== box.notes || timing.cachedMaxWidth !== annotMaxWidth || timing.cachedFontSize !== annotFontSize) {
                // Text or width changed! Re-wrap and recalculate dimensions
                const maxWidth = annotMaxWidth;
                lines = wrapText(ctx, box.notes, maxWidth);
                textWidth = Math.max(...lines.map(line => ctx.measureText(line).width));
                halfWidth = textWidth / 2;
                totalHeight = lines.length * lineHeight;

                // Cache for next frame
                timing.cachedText = box.notes;
                timing.cachedMaxWidth = annotMaxWidth;
                timing.cachedFontSize = annotFontSize;
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
            if (textX + halfWidth > dim.width - 10) {
                textX = dim.width - 10 - halfWidth;
            }

            // Collision detection: check against already-placed annotations
            // ONLY run on first frame - then lock Y position to prevent dropping when others fade out
            const padding = 10;
            let finalTextY;

            const isDragging = boxDragState && completedSelectionBoxes[boxDragState.boxIndex] === box;
            if (isDragging) {
                // Box is being dragged — recalculate from current box position
                delete timing.lockedY;
            }

            if (liveMode && timing.lockedY !== undefined) {
                // Live mode: use stored Y position (annotation stays at its height during fade)
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

                // Lock this Y position for future frames (live mode only, persistent recalculates)
                if (liveMode) timing.lockedY = finalTextY;
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

            // Annotation alignment: 'center' (default) or 'left'
            const alignSelect = document.getElementById('annotationAlignment');
            const annotAlign = alignSelect ? alignSelect.value : 'center';

            ctx.globalAlpha = opacity;
            ctx.fillStyle = '#fff';
            ctx.textAlign = annotAlign;
            ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
            ctx.shadowBlur = 6;
            ctx.shadowOffsetX = 1;
            ctx.shadowOffsetY = 1;

            // For left-align, draw from left edge of text block (textX is center)
            const drawX = annotAlign === 'left' ? textX - halfWidth : textX;

            // Draw each line
            lines.forEach((line, i) => {
                ctx.fillText(line, drawX, textY + (i * lineHeight));
            });

            ctx.restore();
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
    const scale = getCSSToDeviceScale();

    const startX_device = spectrogramStartX * scale.x;
    const startY_device = spectrogramStartY * scale.y;
    const currentX_device = spectrogramCurrentX * scale.x;
    const currentY_device = spectrogramCurrentY * scale.y;
    
    // Calculate normalized rectangle
    const x = Math.min(startX_device, currentX_device);
    const y = Math.min(startY_device, currentY_device);
    const width = Math.abs(currentX_device - startX_device);
    const height = Math.abs(currentY_device - startY_device);
    
    // Draw selection box on canvas (matches the old DOM style)
    const fbc = getFeatureBoxColors();
    ctx.strokeStyle = fbc.stroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, width, height);

    // Semi-transparent fill
    ctx.fillStyle = fbc.fill;
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

