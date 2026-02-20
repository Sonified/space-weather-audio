/**
 * spectrogram-x-axis-renderer.js
 * X-axis rendering for spectrogram showing time ticks below the main window
 */

import {
    calculateHourlyTicks,
    calculateSixHourTicks,
    calculateFourHourTicks,
    calculateTwoHourTicks,
    calculateOneMinuteTicks,
    calculateFiveMinuteTicks,
    calculateThirtyMinuteTicks,
    getInterpolatedTimeRange
} from './waveform-x-axis-renderer.js';

// Track maximum canvas width for responsive tick spacing
let maxCanvasWidth = null;

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

    // Track maximum width seen so far
    if (maxCanvasWidth === null || displayWidth > maxCanvasWidth) {
        maxCanvasWidth = displayWidth;
    }

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

    // Spectrogram x-axis shows what the spectrogram actually displays:
    // - In a region: the region's time range
    // - Otherwise: the current viewport (full data range or scroll-zoomed)
    // Unlike the minimap x-axis, no EMIC windowed override — matches the spectrogram viewport
    // getInterpolatedTimeRange() handles both transition and non-transition states
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
    ctx.fillStyle = labelColor;
    ctx.strokeStyle = tickColor;
    ctx.lineWidth = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    // Calculate ticks based on time span and canvas width
    const timeSpanHours = actualTimeSpanSeconds / 3600;
    let ticks;

    const isVeryNarrowCanvas = maxCanvasWidth !== null && canvasWidth <= (maxCanvasWidth * 1 / 2);
    const isNarrowCanvas = maxCanvasWidth !== null && canvasWidth <= (maxCanvasWidth * 3 / 4);

    if (isVeryNarrowCanvas) {
        ticks = calculateFourHourTicks(startTimeUTC, endTimeUTC);
    } else if (isNarrowCanvas) {
        ticks = calculateTwoHourTicks(startTimeUTC, endTimeUTC);
    } else if (timeSpanHours < 1/3) {
        ticks = calculateOneMinuteTicks(startTimeUTC, endTimeUTC);
    } else if (timeSpanHours < 2) {
        ticks = calculateFiveMinuteTicks(startTimeUTC, endTimeUTC);
    } else if (timeSpanHours < 6) {
        ticks = calculateThirtyMinuteTicks(startTimeUTC, endTimeUTC);
    } else if (timeSpanHours > 24) {
        ticks = calculateSixHourTicks(startTimeUTC, endTimeUTC);
    } else {
        ticks = calculateHourlyTicks(startTimeUTC, endTimeUTC);
    }

    // Draw each tick
    ticks.forEach((tick) => {
        const timeOffsetSeconds = (tick.utcTime.getTime() - startTimeUTC.getTime()) / 1000;
        const x = (timeOffsetSeconds / actualTimeSpanSeconds) * canvasWidth;

        if (x < -10 || x > canvasWidth + 10) return;

        // Tick line from top of canvas pointing up toward spectrogram
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 8);
        ctx.stroke();

        // Format label
        let label;
        if (tick.isDayCrossing) {
            const utcMonth = tick.utcTime.getUTCMonth() + 1;
            const utcDay = tick.utcTime.getUTCDate();
            label = `${utcMonth}/${utcDay}`;
        } else {
            const utcHours = tick.utcTime.getUTCHours();
            const utcMinutes = tick.utcTime.getUTCMinutes();
            if (utcHours === 0 && utcMinutes === 0) {
                label = '0:00';
            } else {
                label = `${utcHours}:${String(utcMinutes).padStart(2, '0')}`;
            }
        }

        ctx.fillStyle = labelColor;
        if (tick.isDayCrossing) {
            ctx.font = `bold ${fontSize} Arial, sans-serif`;
        } else {
            ctx.font = `${fontSize} Arial, sans-serif`;
        }

        ctx.fillText(label, x, 10);
    });
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

    // Track maximum width
    if (maxCanvasWidth === null || currentWidth > maxCanvasWidth) {
        maxCanvasWidth = currentWidth;
    }

    if (xAxisCanvas.width !== currentWidth || xAxisCanvas.height !== 40) {
        xAxisCanvas.width = currentWidth;
        xAxisCanvas.height = 40;
    }

    positionSpectrogramXAxisCanvas();
    drawSpectrogramXAxis();
}
