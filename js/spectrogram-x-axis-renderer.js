/**
 * spectrogram-x-axis-renderer.js
 * X-axis rendering for spectrogram showing time ticks below the main window
 */

import {
    chooseTicks,
    formatTickLabel,
    getInterpolatedTimeRange
} from './waveform-x-axis-renderer.js';

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
    const rootStyles = getComputedStyle(document.documentElement);
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

    // Choose ticks adaptively based on both time span AND pixel density
    const ticks = chooseTicks(startTimeUTC, endTimeUTC, canvasWidth);
    const fadeInTime = getTickFadeInTime();
    const fadeOutTime = getTickFadeOutTime();
    const now = performance.now();

    // Detect whether the tick interval level changed (zoom in/out)
    const currentInterval = detectTickInterval(ticks);
    const levelChanged = lastTickInterval !== null && currentInterval !== null && currentInterval !== lastTickInterval;
    lastTickInterval = currentInterval;

    // Build set of currently-visible tick keys
    const currentTickKeys = new Set();
    for (const tick of ticks) {
        currentTickKeys.add(tick.utcTime.getTime());
    }

    if (levelChanged) {
        // Level changed — fade in new ticks, fade out departed ticks
        for (const key of currentTickKeys) {
            if (!tickFadeState.has(key)) {
                // Brand new tick at this level — fade in
                tickFadeState.set(key, { startOpacity: 0, targetOpacity: 1, transitionStart: now });
            } else {
                const state = tickFadeState.get(key);
                if (state.targetOpacity !== 1) {
                    // Was fading out, reverse from current opacity
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
    } else {
        // Same level (panning) — new edge ticks appear instantly, no fade needed
        for (const key of currentTickKeys) {
            if (!tickFadeState.has(key)) {
                // Scrolled into view at the same level — show immediately
                tickFadeState.set(key, { startOpacity: 1, targetOpacity: 1, transitionStart: now });
            }
        }
        for (const [key, state] of tickFadeState) {
            if (!currentTickKeys.has(key) && state.targetOpacity !== 0) {
                // Scrolled out at same level — remove immediately (no fade for panning)
                // But leave ticks that are already fading out from a level change
                tickFadeState.delete(key);
            }
        }
    }

    let needsAnimation = false;

    // Draw fading-out ticks (not in current set but still visible — only after level changes)
    for (const [key, state] of tickFadeState) {
        if (currentTickKeys.has(key)) continue;

        const opacity = computeOpacity(state, fadeInTime, fadeOutTime, now);
        if (opacity <= 0.001) {
            tickFadeState.delete(key);
            continue;
        }

        needsAnimation = true;
        const tickTime = new Date(key);
        const timeOffsetSeconds = (tickTime.getTime() - startTimeUTC.getTime()) / 1000;
        const x = (timeOffsetSeconds / actualTimeSpanSeconds) * canvasWidth;
        if (x < -10 || x > canvasWidth + 10) continue;

        ctx.globalAlpha = opacity;
        ctx.strokeStyle = tickColor;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 8);
        ctx.stroke();

        const label = formatTimeLabel(tickTime);
        ctx.fillStyle = labelColor;
        ctx.font = `${fontSize} Arial, sans-serif`;
        ctx.fillText(label, x, 10);
    }

    // Draw current ticks
    ticks.forEach((tick) => {
        const key = tick.utcTime.getTime();
        const state = tickFadeState.get(key);
        const opacity = state ? computeOpacity(state, fadeInTime, fadeOutTime, now) : 1;
        if (opacity < 0.999) needsAnimation = true;

        const timeOffsetSeconds = (tick.utcTime.getTime() - startTimeUTC.getTime()) / 1000;
        const x = (timeOffsetSeconds / actualTimeSpanSeconds) * canvasWidth;
        if (x < -10 || x > canvasWidth + 10) return;

        ctx.globalAlpha = opacity;
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
        ctx.fillText(label, x, 10);
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

    xAxisCanvas.style.cssText = `
        position: absolute;
        left: ${leftEdge}px;
        top: ${topEdge}px;
        width: ${spectrogramRect.width}px;
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
