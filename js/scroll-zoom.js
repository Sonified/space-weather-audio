/**
 * scroll-zoom.js
 * Scroll-to-zoom for spectrogram and waveform canvases (EMIC study mode).
 * Per-canvas gating via gear popover dropdowns (#navBarScroll, #mainWindowScroll).
 * Supports mouse wheel and trackpad two-finger pinch/scroll.
 *
 * Wheel events can fire far faster than 60fps on trackpads.
 * We compute zoom math on every event (so preventDefault works immediately)
 * but coalesce rendering to one frame via requestAnimationFrame.
 *
 * Two-level quality system:
 * 1. During scrolling: UV-crops the full texture (4x upgraded) — instant, decent quality
 * 2. After scrolling settles (400ms): renders viewport-specific hi-res texture
 *    with 30% padding — region-zoom quality. Stays active while viewport fits.
 */

import { zoomState } from './zoom-state.js';
import * as State from './audio-state.js';
import { drawWaveformFromMinMax, notifyPageTurnUserDragged } from './waveform-renderer.js';
import { drawWaveformXAxis } from './waveform-x-axis-renderer.js';
import { drawSpectrogramXAxis } from './spectrogram-x-axis-renderer.js';
import { updateSpectrogramViewportFromZoom, renderCompleteSpectrogramForRegion, setScrollZoomHiRes } from './spectrogram-three-renderer.js';
import { updateAllFeatureBoxPositions } from './spectrogram-feature-boxes.js';
import { updateCanvasAnnotations } from './spectrogram-renderer.js';
import { drawSpectrogramPlayhead } from './spectrogram-playhead.js';
import { drawDayMarkers } from './day-markers.js';

let initialized = false;
let rafPending = false;     // true while a render frame is scheduled
let hiResTimer = null;      // debounce timer for hi-res viewport render

const HI_RES_DELAY_MS = 400; // ms after last scroll event to trigger hi-res render

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
    drawSpectrogramXAxis();
    updateSpectrogramViewportFromZoom();
    updateAllFeatureBoxPositions();
    updateCanvasAnnotations();
    drawSpectrogramPlayhead();
    drawDayMarkers();
}

/**
 * After scroll-zoom settles, render a hi-res texture for the current viewport.
 * Gives region-zoom quality. Rendered with 30% padding so minor scrolling
 * after settling stays within the hi-res bounds.
 */
async function renderHiResViewport() {
    if (!State.dataStartTime || !State.dataEndTime) return;

    const { startMs, endMs } = getViewport();
    const dataStartMs = State.dataStartTime.getTime();
    const dataEndMs = State.dataEndTime.getTime();
    const dataSpanMs = dataEndMs - dataStartMs;
    const dataDurationSeconds = dataSpanMs / 1000;

    // Don't re-render if at full zoom (already full resolution)
    if (endMs - startMs >= dataSpanMs * 0.95) return;

    const startSeconds = (startMs - dataStartMs) / 1000;
    const endSeconds = (endMs - dataStartMs) / 1000;

    // Only render region if zoom is deeper than base pyramid tiles can handle.
    // At 15-min base tiles with 1024 cols each, pyramid handles down to ~17 min zoom.
    const viewDurationSec = (endMs - startMs) / 1000;
    const canvasWidth = document.getElementById('spectrogram')?.width || 1200;
    const baseTileColsInView = (viewDurationSec / (15 * 60)) * 1024; // TILE_COLS per 15min
    if (baseTileColsInView >= canvasWidth * 0.8) {
        console.log(`🔺 Pyramid handles this zoom level — skipping hi-res render`);
        return;
    }

    const viewSpanSeconds = endSeconds - startSeconds;

    // Add 30% padding so minor scrolling stays within hi-res bounds
    const padding = viewSpanSeconds * 0.3;
    const expandedStart = Math.max(0, startSeconds - padding);
    const expandedEnd = Math.min(dataDurationSeconds, endSeconds + padding);

    console.log(`🔍 Scroll settled — hi-res render: ${viewSpanSeconds.toFixed(0)}s viewport (padded: ${(expandedEnd - expandedStart).toFixed(0)}s)`);

    // Render in background — doesn't disrupt current display
    const success = await renderCompleteSpectrogramForRegion(expandedStart, expandedEnd, true);

    // Only activate hi-res texture if the render actually completed
    // (it may have been aborted by a newer render)
    if (!success) return;

    // Mark the hi-res texture as ready with its bounds
    setScrollZoomHiRes(expandedStart, expandedEnd);

    // Update viewport to pick up the hi-res texture
    updateSpectrogramViewportFromZoom();

    // Update overlays
    updateAllFeatureBoxPositions();
    updateCanvasAnnotations();
    drawSpectrogramPlayhead();
    drawDayMarkers();
}

/**
 * Handle wheel event on a canvas.
 * Vertical scroll (deltaY) → zoom, horizontal scroll (deltaX) → pan.
 * Each axis gated independently via gear popover dropdowns.
 */
function onWheel(e) {
    const canvas = e.currentTarget;
    const isNavBar = canvas.id === 'waveform';

    // Check which axes are enabled
    const vScrollSelect = document.getElementById(isNavBar ? 'navBarScroll' : 'mainWindowScroll');
    const hScrollSelect = document.getElementById(isNavBar ? 'navBarHScroll' : 'mainWindowHScroll');
    const vZoomEnabled = vScrollSelect && vScrollSelect.value === 'zoom';
    const hPanEnabled = hScrollSelect && hScrollSelect.value === 'pan';

    // Disambiguate: trackpad gestures often produce both deltaX and deltaY.
    // Use the dominant axis only to prevent horizontal swipes from triggering zoom.
    const absX = Math.abs(e.deltaX);
    const absY = Math.abs(e.deltaY);
    const dominantIsHorizontal = absX > absY;
    const hasVertical = !dominantIsHorizontal && absY > 0 && vZoomEnabled;
    const hasHorizontal = dominantIsHorizontal && absX > 0 && hPanEnabled;

    if (!hasVertical && !hasHorizontal) return;
    if (!State.dataStartTime || !State.dataEndTime) return;

    e.preventDefault();
    notifyPageTurnUserDragged();

    const { startMs, endMs } = getViewport();
    const spanMs = endMs - startMs;
    if (spanMs <= 0) return;

    const dataStartMs = State.dataStartTime.getTime();
    const dataEndMs = State.dataEndTime.getTime();
    const dataSpanMs = dataEndMs - dataStartMs;

    let newStartMs = startMs;
    let newEndMs = endMs;

    // Vertical: zoom anchored on cursor
    if (hasVertical) {
        const rect = canvas.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const cursorMs = startMs + frac * spanMs;

        const raw = 1 + e.deltaY * 0.001;
        const zoomFactor = Math.max(0.8, Math.min(1.2, raw));

        newStartMs = cursorMs - (cursorMs - newStartMs) * zoomFactor;
        newEndMs = cursorMs + (newEndMs - cursorMs) * zoomFactor;
    }

    // Horizontal: pan (deltaX positive = scroll right = move viewport right)
    if (hasHorizontal) {
        const panFraction = e.deltaX * 0.001; // ~0.1% of viewport per pixel of deltaX
        const shift = spanMs * panFraction;
        newStartMs += shift;
        newEndMs += shift;
    }

    // Clamp to data bounds (preserve window size for pan)
    if (newStartMs < dataStartMs) {
        const offset = dataStartMs - newStartMs;
        newStartMs = dataStartMs;
        newEndMs += offset;
    }
    if (newEndMs > dataEndMs) {
        const offset = newEndMs - dataEndMs;
        newEndMs = dataEndMs;
        newStartMs -= offset;
    }
    // Re-clamp start in case both ends overflowed
    if (newStartMs < dataStartMs) newStartMs = dataStartMs;

    // Minimum zoom: don't go below 1 second of visible data
    if (newEndMs - newStartMs < 1000) return;

    // If zoomed all the way out, snap to full view
    if (newEndMs - newStartMs >= dataSpanMs * 0.99) {
        zoomState.setViewportToFull();
    } else {
        zoomState.currentViewStartTime = new Date(newStartMs);
        zoomState.currentViewEndTime = new Date(newEndMs);
    }

    // Schedule one render per animation frame — coalesces rapid wheel events
    if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(renderFrame);
    }

    // Debounce hi-res viewport render: reset timer on every scroll event
    if (hiResTimer) clearTimeout(hiResTimer);
    hiResTimer = setTimeout(renderHiResViewport, HI_RES_DELAY_MS);
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
