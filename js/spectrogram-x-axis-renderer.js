/**
 * spectrogram-x-axis-renderer.js
 * X-axis rendering for spectrogram showing time ticks below the main window
 */

import {
    chooseTicks,
    chooseTicksMultiLevel,
    formatTickLabel,
    getInterpolatedTimeRange
} from './minimap-x-axis-renderer.js';

// Tick fade state: Map of tick timestamp (ms) → { startOpacity, targetOpacity, transitionStart }
const tickFadeState = new Map();
let fadeAnimationId = null;
let lastTickInterval = null; // ms between ticks at the current level

function getTickFadeInTime() {
    const el = document.getElementById('tickFadeInTime');
    return el ? parseFloat(el.value) : 0.9;
}

function getTickFadeOutTime() {
    const el = document.getElementById('tickFadeOutTime');
    return el ? parseFloat(el.value) : 0.3;
}

function getTickFadeCurve(direction) {
    const id = direction === 'in' ? 'tickFadeInCurve' : 'tickFadeOutCurve';
    const el = document.getElementById(id);
    return el ? el.value : 'easeOut';
}

function getTickEdgeFadeMode() {
    const el = document.getElementById('tickEdgeFadeMode');
    return el ? el.value : 'spatial';
}

function getTickEdgeSpatialWidth() {
    const el = document.getElementById('tickEdgeSpatialWidth');
    return el ? parseFloat(el.value) : 0.6;
}

function getTickEdgeTimeIn() {
    const el = document.getElementById('tickEdgeTimeIn');
    return el ? parseFloat(el.value) : 0;
}

function getTickEdgeTimeOut() {
    const el = document.getElementById('tickEdgeTimeOut');
    return el ? parseFloat(el.value) : 0.2;
}

function getTickEdgeFadeCurve() {
    const el = document.getElementById('tickEdgeFadeCurve');
    return el ? el.value : 'easeOut';
}

function getTickZoomFadeMode() {
    const el = document.getElementById('tickZoomFadeMode');
    return el ? el.value : 'time';
}

function getTickZoomSpatialWidth() {
    const el = document.getElementById('tickZoomSpatialWidth');
    return el ? parseFloat(el.value) : 0.5;
}

function getTickZoomSpatialCurve() {
    const el = document.getElementById('tickZoomSpatialCurve');
    return el ? el.value : 'easeOut';
}

const easingFunctions = {
    linear: t => t,
    easeIn: t => t * t,
    easeOut: t => t * (2 - t),
    easeInOut: t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
};

function computeOpacity(state, fadeInTime, fadeOutTime, now) {
    const fadingIn = state.targetOpacity === 1;
    const fadeTime = fadingIn ? fadeInTime : fadeOutTime;
    if (fadeTime <= 0) return state.targetOpacity;
    const elapsed = (now - state.transitionStart) / 1000;
    const tLinear = Math.min(1, elapsed / fadeTime);
    const easing = easingFunctions[getTickFadeCurve(fadingIn ? 'in' : 'out')] || easingFunctions.easeOut;
    const t = easing(tLinear);
    return state.startOpacity + (state.targetOpacity - state.startOpacity) * t;
}

/** Detect tick interval from adjacent ticks (returns ms, or null if < 2 ticks) */
function detectTickInterval(ticks) {
    if (ticks.length < 2) return null;
    return Math.round(ticks[1].utcTime.getTime() - ticks[0].utcTime.getTime());
}

/**
 * Draw time axis for spectrogram (main window)
 * Shows the spectrogram's current viewport time range
 */
export function isSpectrogramXAxisVisible() {
    const el = document.getElementById('mainWindowXAxis');
    return !el || el.value !== 'hide';
}

export function drawSpectrogramXAxis() {
    if (!isSpectrogramXAxisVisible()) return;

    const canvas = document.getElementById('spectrogram-x-axis');
    if (!canvas) return;

    const spectrogramCanvas = document.getElementById('spectrogram');
    if (!spectrogramCanvas) return;

    const displayWidth = spectrogramCanvas.offsetWidth;

    // Only resize if dimensions changed
    if (canvas.width !== displayWidth || canvas.height !== 40) {
        canvas.width = displayWidth;
        canvas.height = 40;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    const timeRange = getInterpolatedTimeRange();
    if (!timeRange || !timeRange.startTime || !timeRange.endTime) return;
    const { startTime: displayStartTime, endTime: displayEndTime } = timeRange;

    const startTimeUTC = new Date(displayStartTime);
    const endTimeUTC = new Date(displayEndTime);
    const actualTimeSpanSeconds = (endTimeUTC.getTime() - startTimeUTC.getTime()) / 1000;

    if (!isFinite(actualTimeSpanSeconds) || actualTimeSpanSeconds <= 0) return;

    // Get CSS variables for styling
    const rootStyles = getComputedStyle(document.body);
    const fontSize = rootStyles.getPropertyValue('--axis-label-font-size').trim() || '16px';
    const labelColor = rootStyles.getPropertyValue('--axis-label-color').trim() || '#ddd';
    const tickColor = rootStyles.getPropertyValue('--axis-tick-color').trim() || '#888';

    ctx.font = `${fontSize} Arial, sans-serif`;
    ctx.lineWidth = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    // Spatial zoom fade mode: multi-level pulse-based rendering
    if (getTickZoomFadeMode() === 'spatial') {
        const fadeWidth = getTickZoomSpatialWidth();
        const curveFn = easingFunctions[getTickZoomSpatialCurve()] || easingFunctions.easeOut;
        const levels = chooseTicksMultiLevel(startTimeUTC, endTimeUTC, canvasWidth, fadeWidth, curveFn);

        // Edge fade still applies independently
        const edgeFadeMode = getTickEdgeFadeMode();
        const edgeSpatialWidth = getTickEdgeSpatialWidth();
        const EDGE_PX_PER_UNIT = 80;
        const edgeFadePx = edgeSpatialWidth * EDGE_PX_PER_UNIT;
        const edgeCurve = easingFunctions[getTickEdgeFadeCurve()] || easingFunctions.easeOut;
        function spatialEdgeOpacity(x) {
            if (edgeFadeMode !== 'spatial' || edgeFadePx <= 0) return 1;
            if (x < edgeFadePx) return edgeCurve(Math.max(0, x / edgeFadePx));
            if (x > canvasWidth - edgeFadePx) return edgeCurve(Math.max(0, (canvasWidth - x) / edgeFadePx));
            return 1;
        }

        // Draw all visible levels — coarsest first (already sorted by chooseTicksMultiLevel)
        for (const level of levels) {
            for (const tick of level.ticks) {
                const timeOffsetSeconds = (tick.utcTime.getTime() - startTimeUTC.getTime()) / 1000;
                const x = (timeOffsetSeconds / actualTimeSpanSeconds) * canvasWidth;
                if (x < -10 || x > canvasWidth + 10) continue;

                const finalOpacity = level.opacity * spatialEdgeOpacity(x);
                if (finalOpacity < 0.005) continue;

                ctx.globalAlpha = finalOpacity;
                ctx.strokeStyle = tickColor;
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, 8);
                ctx.stroke();

                const label = formatTickLabel(tick);
                ctx.fillStyle = labelColor;
                ctx.font = tick.isDayCrossing ? `bold ${fontSize} Arial, sans-serif` : `${fontSize} Arial, sans-serif`;
                const halfW = ctx.measureText(label).width / 2;
                const labelX = Math.max(halfW, Math.min(x, canvasWidth - halfW));
                ctx.fillText(label, labelX, 10);
            }
        }

        ctx.globalAlpha = 1;
        return; // Skip the time-based fade state machine entirely
    }

    // Time-based zoom fade mode (existing behavior)
    // Choose ticks adaptively based on both time span AND pixel density
    const ticks = chooseTicks(startTimeUTC, endTimeUTC, canvasWidth);
    const fadeInTime = getTickFadeInTime();
    const fadeOutTime = getTickFadeOutTime();
    const now = performance.now();

    // Detect whether the tick interval level changed (zoom in/out)
    const currentInterval = detectTickInterval(ticks);
    const levelChanged = lastTickInterval !== null && currentInterval !== null && currentInterval !== lastTickInterval;
    lastTickInterval = currentInterval;

    // Build set of currently-visible tick keys + label lookup
    const currentTickKeys = new Set();
    const tickLabelMap = new Map(); // key → { label, isBold }
    for (const tick of ticks) {
        const key = tick.utcTime.getTime();
        currentTickKeys.add(key);
        tickLabelMap.set(key, { label: formatTickLabel(tick), isBold: !!tick.isDayCrossing });
    }

    // Edge fade: applies symmetrically to both left and right edges during pan.
    // Mode "spatial" = position-based opacity gradient at edges (width slider).
    // Mode "time" = time-based fade-in/out when ticks appear at edges (separate in/out sliders).
    // Mode "none" = instant appear/disappear (original behavior).
    const edgeFadeMode = getTickEdgeFadeMode();
    const edgeSpatialWidth = getTickEdgeSpatialWidth();
    const edgeTimeIn = getTickEdgeTimeIn();
    const edgeTimeOut = getTickEdgeTimeOut();
    const EDGE_PX_PER_UNIT = 80;
    const edgeFadePx = edgeSpatialWidth * EDGE_PX_PER_UNIT;
    const edgeCurve = easingFunctions[getTickEdgeFadeCurve()] || easingFunctions.easeOut;

    /** Spatial edge opacity — symmetric fade at both edges (spatial mode only) */
    function edgeOpacity(x) {
        if (edgeFadeMode !== 'spatial' || edgeFadePx <= 0) return 1;
        if (x < edgeFadePx) {
            return edgeCurve(Math.max(0, x / edgeFadePx));
        }
        if (x > canvasWidth - edgeFadePx) {
            return edgeCurve(Math.max(0, (canvasWidth - x) / edgeFadePx));
        }
        return 1;
    }

    if (levelChanged) {
        // Level changed — fade in new ticks, fade out departed ticks
        for (const key of currentTickKeys) {
            const info = tickLabelMap.get(key);
            if (!tickFadeState.has(key)) {
                tickFadeState.set(key, { startOpacity: 0, targetOpacity: 1, transitionStart: now, label: info?.label, isBold: info?.isBold });
            } else {
                const state = tickFadeState.get(key);
                if (state.targetOpacity !== 1) {
                    state.startOpacity = computeOpacity(state, fadeInTime, fadeOutTime, now);
                    state.targetOpacity = 1;
                    state.transitionStart = now;
                }
            }
        }
        for (const [key, state] of tickFadeState) {
            if (!currentTickKeys.has(key) && state.targetOpacity !== 0) {
                state.startOpacity = computeOpacity(state, fadeInTime, fadeOutTime, now);
                state.targetOpacity = 0;
                state.transitionStart = now;
            }
        }
    } else if (edgeFadeMode === 'time') {
        // Same level (panning) — time-based fade in/out at edges
        const EDGE_ZONE = edgeFadePx > 0 ? edgeFadePx : 80; // pixels from edge to count as "edge entry"
        for (const key of currentTickKeys) {
            const existing = tickFadeState.get(key);
            if (!existing) {
                // New tick — only fade in if it appeared near an edge
                const tickTime = new Date(key);
                const timeOffsetSeconds = (tickTime.getTime() - startTimeUTC.getTime()) / 1000;
                const x = (timeOffsetSeconds / actualTimeSpanSeconds) * canvasWidth;
                const nearEdge = x < EDGE_ZONE || x > canvasWidth - EDGE_ZONE;
                const info = tickLabelMap.get(key);
                if (nearEdge) {
                    tickFadeState.set(key, { startOpacity: 0, targetOpacity: 1, transitionStart: now, isEdgeTimed: true, label: info?.label, isBold: info?.isBold });
                } else {
                    // Mid-screen tick — instant full opacity
                    tickFadeState.set(key, { startOpacity: 1, targetOpacity: 1, transitionStart: now, isEdgeTimed: true, label: info?.label, isBold: info?.isBold });
                }
            } else if (existing.targetOpacity === 0) {
                // Tick re-entered viewport (user panned back) — reverse fade-out to fade-in
                existing.startOpacity = computeOpacity(existing, edgeTimeIn, edgeTimeOut, now);
                existing.targetOpacity = 1;
                existing.transitionStart = now;
            }
        }
        for (const [key, state] of tickFadeState) {
            if (!currentTickKeys.has(key) && state.targetOpacity !== 0) {
                // Start fade-out — tick will be drawn clamped to visible edge
                const fi = state.isEdgeTimed ? edgeTimeIn : fadeInTime;
                const fo = state.isEdgeTimed ? edgeTimeOut : fadeOutTime;
                const currentOpacity = computeOpacity(state, fi, fo, now);
                state.startOpacity = currentOpacity;
                state.targetOpacity = 0;
                state.transitionStart = now;
                state.isEdgeTimed = true; // convert so it gets clamped + faded in draw loop
            }
        }
    } else {
        // Same level (panning) — instant appear/disappear (spatial mode handles opacity via edgeOpacity())
        for (const key of currentTickKeys) {
            if (!tickFadeState.has(key)) {
                const info = tickLabelMap.get(key);
                tickFadeState.set(key, { startOpacity: 1, targetOpacity: 1, transitionStart: now, label: info?.label, isBold: info?.isBold });
            }
        }
        for (const [key, state] of tickFadeState) {
            if (!currentTickKeys.has(key) && state.targetOpacity !== 0) {
                // Only delete ticks that aren't actively fading out from a level change
                tickFadeState.delete(key);
            }
        }
    }

    let needsAnimation = false;

    // Draw fading-out ticks (not in current set but still visible)
    for (const [key, state] of tickFadeState) {
        if (currentTickKeys.has(key)) continue;

        // Use edge fade durations for edge-timed ticks, zoom durations otherwise
        const fi = state.isEdgeTimed ? edgeTimeIn : fadeInTime;
        const fo = state.isEdgeTimed ? edgeTimeOut : fadeOutTime;
        const opacity = computeOpacity(state, fi, fo, now);
        if (opacity <= 0.001) {
            tickFadeState.delete(key);
            continue;
        }

        needsAnimation = true;
        const tickTime = new Date(key);
        const timeOffsetSeconds = (tickTime.getTime() - startTimeUTC.getTime()) / 1000;
        let x = (timeOffsetSeconds / actualTimeSpanSeconds) * canvasWidth;

        if (state.isEdgeTimed) {
            // Clamp to visible area — tick stays at the edge while fading out
            x = Math.max(4, Math.min(x, canvasWidth - 4));
        } else {
            // Zoom-level fade-out: skip if fully off-screen
            if (x < -10 || x > canvasWidth + 10) continue;
        }

        ctx.globalAlpha = opacity;
        ctx.strokeStyle = tickColor;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 8);
        ctx.stroke();

        const label = state.label || formatTimeLabel(tickTime);
        ctx.fillStyle = labelColor;
        ctx.font = state.isBold ? `bold ${fontSize} Arial, sans-serif` : `${fontSize} Arial, sans-serif`;
        const halfW = ctx.measureText(label).width / 2;
        const labelX = Math.max(halfW, Math.min(x, canvasWidth - halfW));
        ctx.fillText(label, labelX, 10);
    }

    // Draw current ticks
    ticks.forEach((tick) => {
        const key = tick.utcTime.getTime();
        const state = tickFadeState.get(key);
        // Edge-timed ticks use separate in/out durations
        const fi = state?.isEdgeTimed ? edgeTimeIn : fadeInTime;
        const fo = state?.isEdgeTimed ? edgeTimeOut : fadeOutTime;
        const zoomOpacity = state ? computeOpacity(state, fi, fo, now) : 1;
        if (zoomOpacity < 0.999) needsAnimation = true;

        const timeOffsetSeconds = (tick.utcTime.getTime() - startTimeUTC.getTime()) / 1000;
        const x = (timeOffsetSeconds / actualTimeSpanSeconds) * canvasWidth;
        if (x < -10 || x > canvasWidth + 10) return;

        const finalOpacity = zoomOpacity * edgeOpacity(x);
        if (finalOpacity < 0.999) needsAnimation = true;
        ctx.globalAlpha = finalOpacity;
        ctx.strokeStyle = tickColor;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 8);
        ctx.stroke();

        const label = formatTickLabel(tick);
        ctx.fillStyle = labelColor;
        if (tick.isDayCrossing) {
            ctx.font = `bold ${fontSize} Arial, sans-serif`;
        } else {
            ctx.font = `${fontSize} Arial, sans-serif`;
        }
        // Clamp label inward from both edges symmetrically
        const halfW = ctx.measureText(label).width / 2;
        const labelX = Math.max(halfW, Math.min(x, canvasWidth - halfW));
        ctx.fillText(label, labelX, 10);
    });

    ctx.globalAlpha = 1;

    // Schedule animation frame if ticks are still fading
    if (needsAnimation) {
        if (fadeAnimationId) cancelAnimationFrame(fadeAnimationId);
        fadeAnimationId = requestAnimationFrame(() => {
            fadeAnimationId = null;
            drawSpectrogramXAxis();
        });
    }
}

/** Simple time label for fading-out ticks (we don't have the full tick metadata) */
function formatTimeLabel(date) {
    const h = date.getUTCHours();
    const m = String(date.getUTCMinutes()).padStart(2, '0');
    const s = date.getUTCSeconds();
    const ms = date.getUTCMilliseconds();
    if (ms > 0) return `${h}:${m}:${String(s).padStart(2, '0')}.${String(ms).charAt(0)}`;
    if (s > 0) return `${h}:${m}:${String(s).padStart(2, '0')}`;
    return `${h}:${m}`;
}

/**
 * Position spectrogram x-axis canvas below spectrogram
 */
export function positionSpectrogramXAxisCanvas() {
    if (!isSpectrogramXAxisVisible()) return;

    const spectrogramCanvas = document.getElementById('spectrogram');
    const xAxisCanvas = document.getElementById('spectrogram-x-axis');
    const panel = spectrogramCanvas?.closest('.panel');

    if (!spectrogramCanvas || !xAxisCanvas || !panel) return;

    const spectrogramRect = spectrogramCanvas.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();

    const leftEdge = spectrogramRect.left - panelRect.left;
    const topEdge = spectrogramRect.bottom - panelRect.top;
    const displayWidth = Math.round(spectrogramRect.width);

    xAxisCanvas.style.cssText = `
        position: absolute;
        left: ${leftEdge}px;
        top: ${topEdge}px;
        width: ${displayWidth}px;
        height: 40px;
        opacity: 1;
        visibility: visible;
    `;
}

/**
 * Resize spectrogram x-axis canvas to match spectrogram width
 */
export function resizeSpectrogramXAxisCanvas() {
    if (!isSpectrogramXAxisVisible()) return;

    const spectrogramCanvas = document.getElementById('spectrogram');
    const xAxisCanvas = document.getElementById('spectrogram-x-axis');

    if (!spectrogramCanvas || !xAxisCanvas) return;

    const currentWidth = spectrogramCanvas.offsetWidth;

    if (xAxisCanvas.width !== currentWidth || xAxisCanvas.height !== 40) {
        xAxisCanvas.width = currentWidth;
        xAxisCanvas.height = 40;
    }

    positionSpectrogramXAxisCanvas();
    drawSpectrogramXAxis();
}
