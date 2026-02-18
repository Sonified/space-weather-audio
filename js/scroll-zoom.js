/**
 * scroll-zoom.js
 * Scroll-to-zoom for spectrogram and waveform canvases (EMIC study mode).
 * Gated behind the "Scroll to zoom" checkbox (#scrollBehavior).
 * Supports mouse wheel and trackpad two-finger pinch/scroll.
 *
 * Wheel events can fire far faster than 60fps on trackpads.
 * We compute zoom math on every event (so preventDefault works immediately)
 * but coalesce rendering to one frame via requestAnimationFrame.
 */

import { zoomState } from './zoom-state.js';
import * as State from './audio-state.js';
import { drawWaveformFromMinMax } from './waveform-renderer.js';
import { drawWaveformXAxis } from './waveform-x-axis-renderer.js';
import { updateSpectrogramViewportFromZoom } from './spectrogram-three-renderer.js';
import { updateAllFeatureBoxPositions } from './spectrogram-feature-boxes.js';
import { drawSpectrogramPlayhead } from './spectrogram-playhead.js';
import { drawDayMarkers } from './day-markers.js';

let initialized = false;
let rafPending = false; // true while a render frame is scheduled

/**
 * Get current viewport start/end as ms timestamps
 */
function getViewport() {
    if (zoomState.isInitialized()) {
        return {
            startMs: zoomState.currentViewStartTime.getTime(),
            endMs: zoomState.currentViewEndTime.getTime()
        };
    }
    return {
        startMs: State.dataStartTime.getTime(),
        endMs: State.dataEndTime.getTime()
    };
}

/**
 * Render everything for the current zoomState viewport.
 * Called once per animation frame, no matter how many wheel events fired.
 */
function renderFrame() {
    rafPending = false;
    drawWaveformFromMinMax();
    drawWaveformXAxis();
    updateSpectrogramViewportFromZoom();
    updateAllFeatureBoxPositions();
    drawSpectrogramPlayhead();
    drawDayMarkers();
}

/**
 * Handle wheel event on a canvas
 */
function onWheel(e) {
    // Gate: only zoom if checkbox is checked
    const checkbox = document.getElementById('scrollBehavior');
    if (!checkbox || !checkbox.checked) return;

    // Must have data loaded
    if (!State.dataStartTime || !State.dataEndTime) return;

    e.preventDefault();

    const canvas = e.currentTarget;
    const { startMs, endMs } = getViewport();
    const spanMs = endMs - startMs;
    if (spanMs <= 0) return;

    // Cursor position as fraction across the canvas
    const rect = canvas.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

    // Timestamp under cursor
    const cursorMs = startMs + frac * spanMs;

    // Zoom factor: scroll up (negative deltaY) = zoom in, scroll down = zoom out
    // Clamp to [0.8, 1.2] per tick to prevent wild jumps
    const raw = 1 + e.deltaY * 0.001;
    const zoomFactor = Math.max(0.8, Math.min(1.2, raw));

    // New viewport anchored on cursor position
    let newStartMs = cursorMs - (cursorMs - startMs) * zoomFactor;
    let newEndMs = cursorMs + (endMs - cursorMs) * zoomFactor;

    // Clamp to data bounds
    const dataStartMs = State.dataStartTime.getTime();
    const dataEndMs = State.dataEndTime.getTime();
    if (newStartMs < dataStartMs) newStartMs = dataStartMs;
    if (newEndMs > dataEndMs) newEndMs = dataEndMs;

    // Minimum zoom: don't go below 1 second of visible data
    const minSpanMs = 1000;
    if (newEndMs - newStartMs < minSpanMs) return;

    // If zoomed all the way out, snap to full view
    const dataSpanMs = dataEndMs - dataStartMs;
    if (newEndMs - newStartMs >= dataSpanMs * 0.99) {
        zoomState.setViewportToFull();
    } else {
        // Set viewport timestamps directly — keep mode as 'full' so regions/buttons stay visible
        zoomState.currentViewStartTime = new Date(newStartMs);
        zoomState.currentViewEndTime = new Date(newEndMs);
    }

    // Schedule one render per animation frame — coalesces rapid wheel events
    if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(renderFrame);
    }
}

/**
 * Initialize scroll-to-zoom on spectrogram and waveform canvases.
 * Safe to call multiple times (idempotent).
 */
export function initScrollZoom() {
    if (initialized) return;

    const specCanvas = document.getElementById('spectrogram');
    const wfCanvas = document.getElementById('waveform');

    // passive: false is required for preventDefault() to work in Chrome
    if (specCanvas) specCanvas.addEventListener('wheel', onWheel, { passive: false });
    if (wfCanvas) wfCanvas.addEventListener('wheel', onWheel, { passive: false });

    initialized = true;
}
