/**
 * day-markers.js
 * Draws UTC midnight boundary markers on spectrogram and waveform canvases
 * Only active in EMIC study mode when the "Day Markers" checkbox is enabled
 */

import * as State from './audio-state.js';
import { zoomState } from './zoom-state.js';
import { getInterpolatedTimeRange, isZoomTransitionInProgress } from './waveform-x-axis-renderer.js';

// Overlay canvas for day markers on spectrogram
let spectrogramOverlayCanvas = null;
let spectrogramOverlayCtx = null;
let spectrogramResizeObserver = null;

// Month abbreviations
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Initialize the spectrogram day-marker overlay canvas
 */
function initSpectrogramOverlay() {
    if (spectrogramOverlayCanvas) return;

    const canvas = document.getElementById('spectrogram');
    if (!canvas) return;

    const container = canvas.closest('.panel');
    if (!container) return;

    spectrogramOverlayCanvas = document.createElement('canvas');
    spectrogramOverlayCanvas.id = 'spectrogram-day-markers-overlay';
    spectrogramOverlayCanvas.style.position = 'absolute';
    spectrogramOverlayCanvas.style.pointerEvents = 'none';
    spectrogramOverlayCanvas.style.zIndex = '15'; // Above spectrogram glow overlay (10), below live annotations (25)
    spectrogramOverlayCanvas.style.background = 'transparent';

    const canvasRect = canvas.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    spectrogramOverlayCanvas.style.left = (canvasRect.left - containerRect.left) + 'px';
    spectrogramOverlayCanvas.style.top = (canvasRect.top - containerRect.top) + 'px';
    // Use CSS display size for the overlay buffer so text renders 1:1
    // (the spectrogram WebGL canvas buffer may be smaller than its CSS size)
    spectrogramOverlayCanvas.width = canvas.offsetWidth;
    spectrogramOverlayCanvas.height = canvas.offsetHeight;
    spectrogramOverlayCanvas.style.width = canvas.offsetWidth + 'px';
    spectrogramOverlayCanvas.style.height = canvas.offsetHeight + 'px';

    spectrogramOverlayCtx = spectrogramOverlayCanvas.getContext('2d');
    container.appendChild(spectrogramOverlayCanvas);

    if (spectrogramResizeObserver) spectrogramResizeObserver.disconnect();
    spectrogramResizeObserver = new ResizeObserver(() => {
        if (spectrogramOverlayCanvas && canvas) {
            const cr = canvas.getBoundingClientRect();
            const pr = container.getBoundingClientRect();
            spectrogramOverlayCanvas.style.left = (cr.left - pr.left) + 'px';
            spectrogramOverlayCanvas.style.top = (cr.top - pr.top) + 'px';
            const newW = canvas.offsetWidth;
            const newH = canvas.offsetHeight;
            if (spectrogramOverlayCanvas.width !== newW || spectrogramOverlayCanvas.height !== newH) {
                spectrogramOverlayCanvas.width = newW;
                spectrogramOverlayCanvas.height = newH;
            }
            spectrogramOverlayCanvas.style.width = newW + 'px';
            spectrogramOverlayCanvas.style.height = newH + 'px';
        }
    });
    spectrogramResizeObserver.observe(canvas);
}

/**
 * Check if day markers should be drawn
 */
function shouldDrawDayMarkers() {
    // Must be in EMIC study mode
    if (!window.__EMIC_STUDY_MODE) return false;
    // Check checkbox
    const checkbox = document.getElementById('showDayMarkers');
    return checkbox ? checkbox.checked : false;
}

/**
 * Get the current visible time range (handles zoom transitions)
 */
function getVisibleTimeRange() {
    if (isZoomTransitionInProgress()) {
        return getInterpolatedTimeRange();
    }
    if (zoomState.isInRegion()) {
        const range = zoomState.getRegionRange();
        return { startTime: range.startTime, endTime: range.endTime };
    }
    return { startTime: State.dataStartTime, endTime: State.dataEndTime };
}

/**
 * Calculate UTC midnight boundaries within a time range
 */
function getMidnightBoundaries(startTime, endTime) {
    const boundaries = [];
    if (!startTime || !endTime) return boundaries;

    const startMs = startTime.getTime();
    const endMs = endTime.getTime();

    // Find first midnight at or after startTime
    const d = new Date(startTime);
    d.setUTCHours(0, 0, 0, 0);
    if (d.getTime() < startMs) {
        d.setUTCDate(d.getUTCDate() + 1);
    }

    while (d.getTime() <= endMs) {
        boundaries.push(new Date(d));
        d.setUTCDate(d.getUTCDate() + 1);
    }
    return boundaries;
}

/**
 * Draw dashed vertical line with date label on a 2D context
 */
function drawMarkerLine(ctx, x, height, dateLabel) {
    ctx.save();

    // Dashed line
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();

    // Date label at top, left-aligned to the dashed line
    if (dateLabel) {
        ctx.setLineDash([]);
        ctx.font = 'bold 11px Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';

        // Background pill for readability
        const metrics = ctx.measureText(dateLabel);
        const pad = 4;
        const pillW = metrics.width + pad * 2;
        const pillH = 16;
        const pillX = x + 3; // Start just right of the dashed line
        const pillY = 4;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(pillX, pillY, pillW, pillH, 4);
        } else {
            ctx.rect(pillX, pillY, pillW, pillH);
        }
        ctx.fill();

        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.fillText(dateLabel, pillX + pad, pillY + 2);
    }

    ctx.restore();
}

/**
 * Draw day markers on both spectrogram and waveform canvases
 * Call this after renders and on zoom changes.
 */
export function drawDayMarkers() {
    if (!shouldDrawDayMarkers()) {
        clearDayMarkers();
        return;
    }

    const range = getVisibleTimeRange();
    if (!range.startTime || !range.endTime) return;

    const midnights = getMidnightBoundaries(range.startTime, range.endTime);
    if (midnights.length === 0) {
        clearDayMarkers();
        return;
    }

    const startMs = range.startTime.getTime();
    const spanMs = range.endTime.getTime() - startMs;
    if (spanMs <= 0) return;

    // --- Spectrogram overlay ---
    if (!spectrogramOverlayCanvas) initSpectrogramOverlay();
    if (spectrogramOverlayCtx) {
        // Re-sync overlay buffer to current CSS size in case it changed
        const specCanvas = document.getElementById('spectrogram');
        const cssW = specCanvas ? specCanvas.offsetWidth : spectrogramOverlayCanvas.width;
        const cssH = specCanvas ? specCanvas.offsetHeight : spectrogramOverlayCanvas.height;
        if (spectrogramOverlayCanvas.width !== cssW || spectrogramOverlayCanvas.height !== cssH) {
            spectrogramOverlayCanvas.width = cssW;
            spectrogramOverlayCanvas.height = cssH;
        }
        spectrogramOverlayCtx.clearRect(0, 0, cssW, cssH);
        for (const midnight of midnights) {
            const frac = (midnight.getTime() - startMs) / spanMs;
            const x = Math.round(frac * cssW);
            if (x < 0 || x > cssW) continue;
            const label = `${MONTHS[midnight.getUTCMonth()]} ${midnight.getUTCDate()}`;
            drawMarkerLine(spectrogramOverlayCtx, x, cssH, label);
        }
    }

    // --- Waveform canvas overlay ---
    // Draw directly on a separate overlay so we don't interfere with waveform rendering.
    // Re-use or create a waveform day-marker overlay canvas.
    let wfOverlay = document.getElementById('waveform-day-markers-overlay');
    const wfCanvas = document.getElementById('waveform');
    if (wfCanvas && !wfOverlay) {
        const container = wfCanvas.closest('.panel');
        if (container) {
            wfOverlay = document.createElement('canvas');
            wfOverlay.id = 'waveform-day-markers-overlay';
            wfOverlay.style.position = 'absolute';
            wfOverlay.style.pointerEvents = 'none';
            wfOverlay.style.zIndex = '9';
            wfOverlay.style.background = 'transparent';
            const cr = wfCanvas.getBoundingClientRect();
            const pr = container.getBoundingClientRect();
            wfOverlay.style.left = (cr.left - pr.left) + 'px';
            wfOverlay.style.top = (cr.top - pr.top) + 'px';
            wfOverlay.width = wfCanvas.width;
            wfOverlay.height = wfCanvas.height;
            wfOverlay.style.width = wfCanvas.offsetWidth + 'px';
            wfOverlay.style.height = wfCanvas.offsetHeight + 'px';
            container.appendChild(wfOverlay);

            // Keep in sync
            new ResizeObserver(() => {
                if (wfOverlay && wfCanvas) {
                    const cr2 = wfCanvas.getBoundingClientRect();
                    const pr2 = container.getBoundingClientRect();
                    wfOverlay.style.left = (cr2.left - pr2.left) + 'px';
                    wfOverlay.style.top = (cr2.top - pr2.top) + 'px';
                    if (wfOverlay.width !== wfCanvas.width || wfOverlay.height !== wfCanvas.height) {
                        wfOverlay.width = wfCanvas.width;
                        wfOverlay.height = wfCanvas.height;
                    }
                    wfOverlay.style.width = wfCanvas.offsetWidth + 'px';
                    wfOverlay.style.height = wfCanvas.offsetHeight + 'px';
                }
            }).observe(wfCanvas);
        }
    }

    if (wfOverlay) {
        const wfCtx = wfOverlay.getContext('2d');
        const bufW = wfOverlay.width;
        const bufH = wfOverlay.height;
        wfCtx.clearRect(0, 0, bufW, bufH);

        // Waveform canvas buffer is scaled by devicePixelRatio —
        // apply DPR scale so we draw in CSS-pixel coordinates
        const dpr = window.devicePixelRatio || 1;
        const cssW = bufW / dpr;
        const cssH = bufH / dpr;
        wfCtx.save();
        wfCtx.scale(dpr, dpr);
        for (const midnight of midnights) {
            const frac = (midnight.getTime() - startMs) / spanMs;
            const x = Math.round(frac * cssW);
            if (x < 0 || x > cssW) continue;
            const label = `${MONTHS[midnight.getUTCMonth()]} ${midnight.getUTCDate()}`;
            drawMarkerLine(wfCtx, x, cssH, label);
        }
        wfCtx.restore();
    }
}

/**
 * Clear all day marker overlays
 */
export function clearDayMarkers() {
    if (spectrogramOverlayCtx && spectrogramOverlayCanvas) {
        spectrogramOverlayCtx.clearRect(0, 0, spectrogramOverlayCanvas.width, spectrogramOverlayCanvas.height);
    }
    const wfOverlay = document.getElementById('waveform-day-markers-overlay');
    if (wfOverlay) {
        const ctx = wfOverlay.getContext('2d');
        ctx.clearRect(0, 0, wfOverlay.width, wfOverlay.height);
    }
}

/**
 * Cleanup resources
 */
export function cleanupDayMarkers() {
    if (spectrogramResizeObserver) {
        spectrogramResizeObserver.disconnect();
        spectrogramResizeObserver = null;
    }
    if (spectrogramOverlayCanvas) {
        spectrogramOverlayCanvas.remove();
        spectrogramOverlayCanvas = null;
        spectrogramOverlayCtx = null;
    }
    const wfOverlay = document.getElementById('waveform-day-markers-overlay');
    if (wfOverlay) wfOverlay.remove();
}
