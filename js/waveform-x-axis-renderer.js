/**
 * waveform-x-axis-renderer.js
 * X-axis rendering for waveform showing time ticks
 */

import * as State from './audio-state.js';
import { zoomState } from './zoom-state.js';
import { drawInterpolatedWaveform, drawWaveformWithSelection } from './waveform-renderer.js';
import { drawInterpolatedSpectrogram, updateSpectrogramViewport, cancelActiveRender } from './spectrogram-three-renderer.js';
import { updateAllFeatureBoxPositions } from './spectrogram-feature-boxes.js';
import { drawSpectrogramPlayhead } from './spectrogram-playhead.js';
import { redrawAllCanvasFeatureBoxes } from './spectrogram-renderer.js';
import { drawDayMarkers } from './day-markers.js';

// Debug flag for axis drawing logs (set to true to enable detailed logging)
const DEBUG_AXIS = false;

// 🏛️ Zoom transition animation state (for smooth tick interpolation)
let zoomTransitionInProgress = false;
let zoomTransitionStartTime = null;
let zoomTransitionDuration = 500; // 500ms for snappy zoom transitions
let oldTimeRange = null; // { startTime, endTime }
let zoomTransitionRAF = null;
let isZoomingToRegion = false; // Track if we're zooming TO a region (true) or FROM a region (false)
let zoomTransitionCleanupTimeout = null; // Safety timeout — must be cancelled on new transition

/**
 * No-op — kept for backwards compatibility with main.js import.
 * Tick spacing is now computed dynamically by chooseTicks() based on actual canvas width.
 */
export function initializeMaxCanvasWidth() {}

/**
 * Draw time axis for waveform
 * Shows 2-hour ticks with date at left, handles day crossings
 */
export function drawWaveformXAxis() {
    const canvas = document.getElementById('waveform-x-axis');
    if (!canvas) return;
    
    const waveformCanvas = document.getElementById('waveform');
    if (!waveformCanvas) return;
    
    // Use display width (offsetWidth) not internal canvas width
    const displayWidth = waveformCanvas.offsetWidth;

    // Only resize if dimensions changed (resizing clears the canvas, may cause flicker)
    if (canvas.width !== displayWidth || canvas.height !== 40) {
        canvas.width = displayWidth;
        canvas.height = 40;
    }
    
    const ctx = canvas.getContext('2d');
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;
    
    // Clear canvas (transparent background)
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    
    // 🏛️ Use zoom state for time range (with interpolation during transition)
    let displayStartTime, displayEndTime;
    let interpolationFactor = 1.0;
    
    // 🏛️ Inside the temple: show the temple's time range
    // 🙏 Timestamps as source of truth: Use timestamps directly from region range
    const emicModeSelect = window.__EMIC_STUDY_MODE ? document.getElementById('viewingMode') : null;
    const isEmicWindowed = emicModeSelect && (emicModeSelect.value === 'static' || emicModeSelect.value === 'scroll' || emicModeSelect.value === 'pageTurn');
    if (isEmicWindowed) {
        // EMIC windowed mode (scroll/page-turn): waveform x-axis always shows full data range
        displayStartTime = State.dataStartTime;
        displayEndTime = State.dataEndTime;
    } else if (zoomState.isInRegion()) {
        const regionRange = zoomState.getRegionRange();
        displayStartTime = regionRange.startTime;
        displayEndTime = regionRange.endTime;
    } else {
        // Full view (or scroll-zoomed): use zoomState timestamps
        displayStartTime = zoomState.isInitialized() ? zoomState.currentViewStartTime : State.dataStartTime;
        displayEndTime = zoomState.isInitialized() ? zoomState.currentViewEndTime : State.dataEndTime;
    }
    
    // 🏛️ Interpolate during zoom transition
    if (zoomTransitionInProgress && oldTimeRange !== null) {
        const elapsed = performance.now() - zoomTransitionStartTime;
        const progress = Math.min(elapsed / zoomTransitionDuration, 1.0);
        
        // Ease-in-out cubic: slow start → fast middle → slow end (gives render time!)
        interpolationFactor = progress < 0.5 
            ? 4 * progress * progress * progress 
            : 1 - Math.pow(-2 * progress + 2, 3) / 2;
        
        // Interpolate between old and new time ranges
        const oldStartMs = oldTimeRange.startTime.getTime();
        const oldEndMs = oldTimeRange.endTime.getTime();
        const newStartMs = displayStartTime.getTime();
        const newEndMs = displayEndTime.getTime();
        
        const interpolatedStartMs = oldStartMs + (newStartMs - oldStartMs) * interpolationFactor;
        const interpolatedEndMs = oldEndMs + (newEndMs - oldEndMs) * interpolationFactor;
        
        displayStartTime = new Date(interpolatedStartMs);
        displayEndTime = new Date(interpolatedEndMs);
    }
    
    if (!displayStartTime || !displayEndTime) {
        return; // No data loaded yet
    }
    
    const startTimeUTC = new Date(displayStartTime);
    const endTimeUTC = new Date(displayEndTime);
    
    // Calculate actual time span in seconds (not playback duration!)
    const actualTimeSpanSeconds = (endTimeUTC.getTime() - startTimeUTC.getTime()) / 1000;
    
    // Validate time span
    if (!isFinite(actualTimeSpanSeconds) || actualTimeSpanSeconds <= 0) {
        // console.warn(`🕐 X-axis: Invalid time span ${actualTimeSpanSeconds}, skipping draw`);
        return;
    }
    
    // if (DEBUG_AXIS) console.log(`🕐 X-axis: Drawing with time span=${actualTimeSpanSeconds.toFixed(1)}s (${(actualTimeSpanSeconds/3600).toFixed(1)}h), canvas width=${canvasWidth}px`);
    
    // Get CSS variables for styling
    const rootStyles = getComputedStyle(document.documentElement);
    const fontSize = rootStyles.getPropertyValue('--axis-label-font-size').trim() || '16px';
    const labelColor = rootStyles.getPropertyValue('--axis-label-color').trim() || '#ddd';
    const tickColor = rootStyles.getPropertyValue('--axis-tick-color').trim() || '#888';
    
    // Setup text styling - match y-axis style
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
    
    // Choose ticks adaptively based on both time span AND pixel density
    // This prevents label clustering on narrow windows and sparse ticks on wide ones
    const ticks = chooseTicks(startTimeUTC, endTimeUTC, canvasWidth);
    
    // Draw each tick
    ticks.forEach((tick, index) => {
        // Calculate x position: (time offset from start / actual time span) * canvas width
        // Use actual time span, not playback duration!
        const timeOffsetSeconds = (tick.utcTime.getTime() - startTimeUTC.getTime()) / 1000;
        const x = (timeOffsetSeconds / actualTimeSpanSeconds) * canvasWidth;
        
        // Skip if outside canvas bounds (with small margin for edge cases)
        if (x < -10 || x > canvasWidth + 10) {
            return;
        }
        
        // Draw vertical line pointing up to waveform
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 8); // Short line pointing up
        ctx.stroke();
        
        // Format label based on whether it's a day crossing
        // 🌍 ALWAYS display in UTC for space physics data
        let label;
        if (tick.isDayCrossing) {
            // Show date in 11/12 format (mm/dd) - UTC date
            const utcMonth = tick.utcTime.getUTCMonth() + 1; // 0-indexed
            const utcDay = tick.utcTime.getUTCDate();
            label = `${utcMonth}/${utcDay}`;
        } else {
            // Show time in international format (1:00 through 13:00 and 24:00) - UTC time
            const utcHours = tick.utcTime.getUTCHours();
            const utcMinutes = tick.utcTime.getUTCMinutes();

            if (utcHours === 0 && utcMinutes === 0) {
                label = '0:00'; // Midnight shown as 0:00 UTC
            } else {
                // 1:00 through 23:00 (no leading zero for single digits per international format)
                label = `${utcHours}:${String(utcMinutes).padStart(2, '0')}`;
            }
        }
        
        // Draw label centered below the tick
        // Ensure text is visible (use CSS variable for consistent styling)
        ctx.fillStyle = labelColor;
        
        // Make date labels bold for day crossings
        if (tick.isDayCrossing) {
            ctx.font = `bold ${fontSize} Arial, sans-serif`;
        } else {
            ctx.font = `${fontSize} Arial, sans-serif`;
        }
        
        ctx.fillText(label, x, 10);
    });
    
    // 🏛️ Continue animation if in progress
    if (zoomTransitionInProgress) {
        // 🔥 SAFETY: Ensure zoomTransitionStartTime is valid
        if (!zoomTransitionStartTime) {
            console.warn('⚠️ Zoom transition stuck: zoomTransitionStartTime is null, resetting');
            zoomTransitionInProgress = false;
            oldTimeRange = null;
            zoomTransitionRAF = null;
            return;
        }
        
        const elapsed = performance.now() - zoomTransitionStartTime;
        
        // 🔥 SAFETY: Prevent infinite loops - max duration is 2x expected duration
        const MAX_DURATION = zoomTransitionDuration * 2;
        if (elapsed > MAX_DURATION) {
            console.warn(`⚠️ Zoom transition stuck: elapsed ${elapsed.toFixed(0)}ms exceeds max ${MAX_DURATION}ms, forcing stop`);
            zoomTransitionInProgress = false;
            oldTimeRange = null;
            if (zoomTransitionRAF) {
                cancelAnimationFrame(zoomTransitionRAF);
            }
            zoomTransitionRAF = null;
            drawWaveformWithSelection();
            return;
        }
        
        if (elapsed < zoomTransitionDuration) {
            // 🔥 FIX: Only schedule RAF if one isn't already scheduled
            // This prevents multiple RAF loops when drawWaveformXAxis() is called from multiple places
            if (!zoomTransitionRAF) {
                zoomTransitionRAF = requestAnimationFrame(() => {
                    // 🔥 FIX: Check document connection before executing RAF callback
                    if (!document.body || !document.body.isConnected) {
                        zoomTransitionRAF = null;
                        zoomTransitionInProgress = false;
                        return;
                    }
                    // Clear RAF ID before calling drawWaveformXAxis so it can schedule the next frame
                    const rafId = zoomTransitionRAF;
                    zoomTransitionRAF = null;
                    drawWaveformXAxis();

                    // Update spectrogram x-axis (lazy import to avoid circular dependency)
                    import('./spectrogram-x-axis-renderer.js').then(m => m.drawSpectrogramXAxis());

                    // 🏛️ Trigger interpolated waveform draw so everything zooms together
                    drawInterpolatedWaveform();

                    // 🏄‍♂️ Stretch spectrogram to match interpolated time range - everything moves together!
                    drawInterpolatedSpectrogram();

                    // 📦 Update feature boxes to move smoothly with the zoom transition!
                    updateAllFeatureBoxPositions();

                    // 🎯 Update playheads during transition so they move smoothly!
                    drawWaveformWithSelection(); // Includes waveform playhead
                    drawSpectrogramPlayhead(); // Update spectrogram playhead during transition

                    // 🎨 Update canvas feature boxes too (follow elastic horizontal stretch!)
                    redrawAllCanvasFeatureBoxes();

                    // 📅 Update day markers during zoom transition
                    drawDayMarkers();
                });
            }
        } else {
            // Animation complete
            zoomTransitionInProgress = false;
            oldTimeRange = null;
            if (zoomTransitionRAF) {
                cancelAnimationFrame(zoomTransitionRAF);
            }
            zoomTransitionRAF = null;

            // 🏛️ Draw final frame to keep regions visible while waveform rebuilds
            // This prevents the flash where regions disappear during worker rebuild
            drawWaveformWithSelection();

            // 🎯 CRITICAL: Redraw x-axis at final position so tick density updates!
            // Without this, region-to-region zoom would keep the interpolated tick density
            drawWaveformXAxis();
            import('./spectrogram-x-axis-renderer.js').then(m => m.drawSpectrogramXAxis());

            // 📅 Update day markers at final position
            drawDayMarkers();
        }
    }
}

/**
 * Draw date panel above waveform
 * Shows date extending off the left edge (in UTC)
 */
export function drawWaveformDate() {
    const canvas = document.getElementById('waveform-date');
    if (!canvas) return;

    // Need start time to get the date
    if (!State.dataStartTime) {
        return; // No data loaded yet
    }

    const startTimeUTC = new Date(State.dataStartTime);

    // Set canvas size
    canvas.width = 200;
    canvas.height = 40;

    const ctx = canvas.getContext('2d');
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;

    // Clear canvas (transparent background)
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    // Format date in 11/12 format (mm/dd) - UTC date
    const month = startTimeUTC.getUTCMonth() + 1;
    const day = startTimeUTC.getUTCDate();
    const dateLabel = `${month}/${day}`;
    
    // Get CSS variables for styling
    const rootStyles = getComputedStyle(document.documentElement);
    const fontSize = rootStyles.getPropertyValue('--axis-label-font-size').trim() || '16px';
    const labelColor = rootStyles.getPropertyValue('--axis-label-color').trim() || '#ddd';
    
    // Setup text styling - match x-axis style
    ctx.font = `${fontSize} Arial, sans-serif`;
    ctx.fillStyle = labelColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    
    // Draw date extending off the left edge (negative x position)
    ctx.fillText(dateLabel, -60, 10);
}

/**
 * Position the waveform date canvas above the waveform
 */
export function positionWaveformDateCanvas() {
    const waveformCanvas = document.getElementById('waveform');
    const dateCanvas = document.getElementById('waveform-date');
    const waveformPanel = waveformCanvas?.closest('.panel');
    const datePanel = dateCanvas?.closest('.panel');
    
    if (!waveformCanvas || !dateCanvas || !waveformPanel || !datePanel) return;
    
    const waveformRect = waveformCanvas.getBoundingClientRect();
    const datePanelRect = datePanel.getBoundingClientRect();
    
    // Position date panel above waveform, extending off the left edge
    // Calculate position relative to date panel, accounting for waveform's position
    const waveformLeftInPanel = waveformRect.left - datePanelRect.left;
    
    // Make sure panel allows overflow and has minimal padding
    datePanel.style.cssText = `
        position: relative;
        overflow: visible !important;
        margin-bottom: 0;
        padding: 0 !important;
        height: 40px;
    `;
    
    // Position canvas to extend 60px to the left of waveform's left edge
    // Use negative left position to extend off the left edge of the panel
    dateCanvas.style.cssText = `
        position: absolute;
        left: ${waveformLeftInPanel - 60}px;
        top: 0;
        width: 200px;
        height: 40px;
        opacity: 1;
        visibility: visible;
    `;
}

/**
 * Calculate hourly tick positions (UTC)
 * Quantizes at UTC midnight, finds first hour boundary within region
 *
 * Strategy:
 * 1. Start from data start time in UTC
 * 2. Find first hour boundary in UTC (00:00, 01:00, 02:00, ..., 23:00 UTC)
 * 3. Generate ticks every hour in UTC
 */
export function calculateHourlyTicks(startUTC, endUTC) {
    const ticks = [];

    // Get UTC time components from start time
    const startYear = startUTC.getUTCFullYear();
    const startMonth = startUTC.getUTCMonth();
    const startDay = startUTC.getUTCDate();
    const startHours = startUTC.getUTCHours();

    // Find first hour block (quantized at midnight UTC)
    // Hour blocks: 00:00, 01:00, 02:00, ..., 23:00 (UTC)
    // Create date at start of hour in UTC
    let firstTickUTC = new Date(Date.UTC(startYear, startMonth, startDay, startHours, 0, 0, 0));

    // If we're not starting at an hour boundary, find the first one within the region
    if (firstTickUTC.getTime() < startUTC.getTime()) {
        // Move forward to next hour block
        firstTickUTC = new Date(firstTickUTC.getTime() + 60 * 60 * 1000);
    }

    // Generate ticks every hour until we exceed end time
    let currentTickUTC = new Date(firstTickUTC);
    let previousTickDateUTC = null;

    while (currentTickUTC.getTime() <= endUTC.getTime()) {
        // Get UTC date string for day crossing detection
        const currentTickDateUTC = currentTickUTC.toISOString().split('T')[0]; // YYYY-MM-DD
        const currentHourUTC = currentTickUTC.getUTCHours();
        const currentMinutesUTC = currentTickUTC.getUTCMinutes();

        // Mark as day crossing if:
        // 1. Previous tick was on a different UTC date, OR
        // 2. This tick is at UTC midnight (00:00) - always show date at midnight
        const isDayCrossing = (previousTickDateUTC !== null && previousTickDateUTC !== currentTickDateUTC) ||
                              (currentHourUTC === 0 && currentMinutesUTC === 0);

        // Check if this UTC time falls within our data range
        if (currentTickUTC.getTime() >= startUTC.getTime() && currentTickUTC.getTime() <= endUTC.getTime()) {
            ticks.push({
                utcTime: new Date(currentTickUTC), // UTC time for positioning and display
                localTime: new Date(currentTickUTC), // Keep for compatibility (not used for UTC display)
                isDayCrossing: isDayCrossing
            });
        }

        previousTickDateUTC = currentTickDateUTC;

        // Move to next hour block (add 1 hour in milliseconds)
        currentTickUTC = new Date(currentTickUTC.getTime() + 60 * 60 * 1000);
    }

    return ticks;
}

/**
 * Calculate 6-hour tick positions starting at UTC midnight
 * Quantizes at 6-hour boundaries (00:00, 06:00, 12:00, 18:00 UTC)
 * Used for multi-day data (> 24 hours)
 */
export function calculateSixHourTicks(startUTC, endUTC) {
    const ticks = [];

    // Get UTC time components from start time
    const startYear = startUTC.getUTCFullYear();
    const startMonth = startUTC.getUTCMonth();
    const startDay = startUTC.getUTCDate();
    const startHours = startUTC.getUTCHours();

    // Find first 6-hour block starting at UTC midnight (00:00, 06:00, 12:00, 18:00)
    // Round down to nearest 6-hour boundary
    const hoursRoundedDown = Math.floor(startHours / 6) * 6;
    let firstTickUTC = new Date(Date.UTC(startYear, startMonth, startDay, hoursRoundedDown, 0, 0, 0));

    // If we're not starting at a 6-hour boundary, find the first one within the region
    if (firstTickUTC.getTime() < startUTC.getTime()) {
        // Move forward to next 6-hour block
        firstTickUTC = new Date(firstTickUTC.getTime() + 6 * 60 * 60 * 1000);
    }

    // Generate ticks every 6 hours until we exceed end time
    let currentTickUTC = new Date(firstTickUTC);
    let previousTickDateUTC = null;

    while (currentTickUTC.getTime() <= endUTC.getTime()) {
        // Get UTC date string for day crossing detection
        const currentTickDateUTC = currentTickUTC.toISOString().split('T')[0];
        const currentHourUTC = currentTickUTC.getUTCHours();
        const currentMinutesUTC = currentTickUTC.getUTCMinutes();

        // Mark as day crossing if:
        // 1. Previous tick was on a different UTC date, OR
        // 2. This tick is at UTC midnight (00:00)
        const isDayCrossing = (previousTickDateUTC !== null && previousTickDateUTC !== currentTickDateUTC) ||
                              (currentHourUTC === 0 && currentMinutesUTC === 0);

        // Check if this UTC time falls within our data range
        if (currentTickUTC.getTime() >= startUTC.getTime() && currentTickUTC.getTime() <= endUTC.getTime()) {
            ticks.push({
                utcTime: new Date(currentTickUTC),
                localTime: new Date(currentTickUTC),
                isDayCrossing: isDayCrossing
            });
        }

        previousTickDateUTC = currentTickDateUTC;

        // Move to next 6-hour block
        currentTickUTC = new Date(currentTickUTC.getTime() + 6 * 60 * 60 * 1000);
    }

    return ticks;
}

/**
 * Calculate 8-hour tick positions starting at UTC midnight
 * Quantizes at 8-hour boundaries (00:00, 08:00, 16:00 UTC)
 * Binary subdivision: 2h → 4h → 8h → 24h
 */
export function calculateEightHourTicks(startUTC, endUTC) {
    const ticks = [];
    const startYear = startUTC.getUTCFullYear();
    const startMonth = startUTC.getUTCMonth();
    const startDay = startUTC.getUTCDate();
    const startHours = startUTC.getUTCHours();

    const hoursRoundedDown = Math.floor(startHours / 8) * 8;
    let firstTickUTC = new Date(Date.UTC(startYear, startMonth, startDay, hoursRoundedDown, 0, 0, 0));

    if (firstTickUTC.getTime() < startUTC.getTime()) {
        firstTickUTC = new Date(firstTickUTC.getTime() + 8 * 60 * 60 * 1000);
    }

    let currentTickUTC = new Date(firstTickUTC);
    let previousTickDateUTC = null;

    while (currentTickUTC.getTime() <= endUTC.getTime()) {
        const currentTickDateUTC = currentTickUTC.toISOString().split('T')[0];
        const currentHourUTC = currentTickUTC.getUTCHours();
        const currentMinutesUTC = currentTickUTC.getUTCMinutes();

        const isDayCrossing = (previousTickDateUTC !== null && previousTickDateUTC !== currentTickDateUTC) ||
                              (currentHourUTC === 0 && currentMinutesUTC === 0);

        if (currentTickUTC.getTime() >= startUTC.getTime() && currentTickUTC.getTime() <= endUTC.getTime()) {
            ticks.push({
                utcTime: new Date(currentTickUTC),
                localTime: new Date(currentTickUTC),
                isDayCrossing: isDayCrossing
            });
        }

        previousTickDateUTC = currentTickDateUTC;
        currentTickUTC = new Date(currentTickUTC.getTime() + 8 * 60 * 60 * 1000);
    }

    return ticks;
}

/**
 * Calculate 12-hour tick positions starting at UTC midnight
 * Quantizes at 12-hour boundaries (00:00, 12:00 UTC)
 * Used for multi-day data on narrow canvases
 */
export function calculateTwelveHourTicks(startUTC, endUTC) {
    const ticks = [];
    const startYear = startUTC.getUTCFullYear();
    const startMonth = startUTC.getUTCMonth();
    const startDay = startUTC.getUTCDate();
    const startHours = startUTC.getUTCHours();

    const hoursRoundedDown = Math.floor(startHours / 12) * 12;
    let firstTickUTC = new Date(Date.UTC(startYear, startMonth, startDay, hoursRoundedDown, 0, 0, 0));

    if (firstTickUTC.getTime() < startUTC.getTime()) {
        firstTickUTC = new Date(firstTickUTC.getTime() + 12 * 60 * 60 * 1000);
    }

    let currentTickUTC = new Date(firstTickUTC);
    let previousTickDateUTC = null;

    while (currentTickUTC.getTime() <= endUTC.getTime()) {
        const currentTickDateUTC = currentTickUTC.toISOString().split('T')[0];
        const currentHourUTC = currentTickUTC.getUTCHours();
        const currentMinutesUTC = currentTickUTC.getUTCMinutes();

        const isDayCrossing = (previousTickDateUTC !== null && previousTickDateUTC !== currentTickDateUTC) ||
                              (currentHourUTC === 0 && currentMinutesUTC === 0);

        if (currentTickUTC.getTime() >= startUTC.getTime() && currentTickUTC.getTime() <= endUTC.getTime()) {
            ticks.push({
                utcTime: new Date(currentTickUTC),
                localTime: new Date(currentTickUTC),
                isDayCrossing: isDayCrossing
            });
        }

        previousTickDateUTC = currentTickDateUTC;
        currentTickUTC = new Date(currentTickUTC.getTime() + 12 * 60 * 60 * 1000);
    }

    return ticks;
}

/**
 * Calculate daily tick positions at UTC midnight
 * One tick per day at 00:00 UTC
 * Used for multi-day data on very narrow canvases
 */
export function calculateDailyTicks(startUTC, endUTC) {
    const ticks = [];
    const startYear = startUTC.getUTCFullYear();
    const startMonth = startUTC.getUTCMonth();
    const startDay = startUTC.getUTCDate();

    // Start at midnight of the start day
    let firstTickUTC = new Date(Date.UTC(startYear, startMonth, startDay, 0, 0, 0, 0));

    if (firstTickUTC.getTime() < startUTC.getTime()) {
        firstTickUTC = new Date(firstTickUTC.getTime() + 24 * 60 * 60 * 1000);
    }

    let currentTickUTC = new Date(firstTickUTC);

    while (currentTickUTC.getTime() <= endUTC.getTime()) {
        if (currentTickUTC.getTime() >= startUTC.getTime() && currentTickUTC.getTime() <= endUTC.getTime()) {
            ticks.push({
                utcTime: new Date(currentTickUTC),
                localTime: new Date(currentTickUTC),
                isDayCrossing: true  // Every tick is at midnight = day crossing
            });
        }

        currentTickUTC = new Date(currentTickUTC.getTime() + 24 * 60 * 60 * 1000);
    }

    return ticks;
}

/**
 * Choose the best tick interval based on time span AND available pixel width.
 * Tries intervals from finest to coarsest, picking the finest one where
 * the average pixel spacing between ticks stays >= minPixelsPerTick.
 *
 * @param {Date} startUTC - Start time
 * @param {Date} endUTC - End time
 * @param {number} canvasWidth - Current canvas width in pixels
 * @param {number} [minPixelsPerTick=44] - Minimum pixels between tick centers
 * @returns {Array} Array of tick objects
 */
export function chooseTicks(startUTC, endUTC, canvasWidth, minPixelsPerTick = 44) {
    const timeSpanSeconds = (endUTC.getTime() - startUTC.getTime()) / 1000;
    const timeSpanHours = timeSpanSeconds / 3600;

    // Ordered from finest to coarsest interval
    // Each entry: [intervalSeconds, calculatorFn, minTimeSpanHours, maxTimeSpanHours]
    // minTimeSpan/maxTimeSpan prevent nonsensical combos (e.g. daily ticks for 30min data)
    const intervals = [
        [60,        calculateOneMinuteTicks,      0,    1],
        [300,       calculateFiveMinuteTicks,      0,    6],
        [600,       calculateTenMinuteTicks,       0.15, 8],
        [1800,      calculateThirtyMinuteTicks,    0.3,  24],
        [3600,      calculateHourlyTicks,          1,    72],
        [7200,      calculateTwoHourTicks,         2,    168],
        [21600,     calculateSixHourTicks,         6,    Infinity],
        [43200,     calculateTwelveHourTicks,      12,   Infinity],
        [86400,     calculateDailyTicks,           24,   Infinity],
    ];

    // Try each interval from finest to coarsest
    for (const [intervalSec, calcFn, minSpanH, maxSpanH] of intervals) {
        // Skip intervals that don't make sense for this time span
        if (timeSpanHours < minSpanH || timeSpanHours > maxSpanH) continue;

        // Estimate how many ticks this interval would produce
        const estTickCount = timeSpanSeconds / intervalSec;
        const pixelsPerTick = canvasWidth / estTickCount;

        if (pixelsPerTick >= minPixelsPerTick) {
            return calcFn(startUTC, endUTC);
        }
    }

    // Fallback: if even daily ticks are too dense, use daily (shouldn't happen in practice)
    return calculateDailyTicks(startUTC, endUTC);
}

/**
 * Calculate 4-hour tick positions starting at UTC midnight
 * Quantizes at 4-hour boundaries (00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC)
 */
export function calculateFourHourTicks(startUTC, endUTC) {
    const ticks = [];

    // Get UTC time components from start time
    const startYear = startUTC.getUTCFullYear();
    const startMonth = startUTC.getUTCMonth();
    const startDay = startUTC.getUTCDate();
    const startHours = startUTC.getUTCHours();

    // Find first 4-hour block starting at UTC midnight (00:00, 04:00, 08:00, 12:00, 16:00, 20:00)
    // Round down to nearest 4-hour boundary
    const hoursRoundedDown = Math.floor(startHours / 4) * 4;
    let firstTickUTC = new Date(Date.UTC(startYear, startMonth, startDay, hoursRoundedDown, 0, 0, 0));

    // If we're not starting at a 4-hour boundary, find the first one within the region
    if (firstTickUTC.getTime() < startUTC.getTime()) {
        // Move forward to next 4-hour block
        firstTickUTC = new Date(firstTickUTC.getTime() + 4 * 60 * 60 * 1000);
    }

    // Generate ticks every 4 hours until we exceed end time
    let currentTickUTC = new Date(firstTickUTC);
    let previousTickDateUTC = null;

    while (currentTickUTC.getTime() <= endUTC.getTime()) {
        // Get UTC date string for day crossing detection
        const currentTickDateUTC = currentTickUTC.toISOString().split('T')[0];
        const currentHourUTC = currentTickUTC.getUTCHours();
        const currentMinutesUTC = currentTickUTC.getUTCMinutes();

        // Mark as day crossing if:
        // 1. Previous tick was on a different UTC date, OR
        // 2. This tick is at UTC midnight (00:00)
        const isDayCrossing = (previousTickDateUTC !== null && previousTickDateUTC !== currentTickDateUTC) ||
                              (currentHourUTC === 0 && currentMinutesUTC === 0);

        // Check if this UTC time falls within our data range
        if (currentTickUTC.getTime() >= startUTC.getTime() && currentTickUTC.getTime() <= endUTC.getTime()) {
            ticks.push({
                utcTime: new Date(currentTickUTC),
                localTime: new Date(currentTickUTC),
                isDayCrossing: isDayCrossing
            });
        }

        previousTickDateUTC = currentTickDateUTC;

        // Move to next 4-hour block
        currentTickUTC = new Date(currentTickUTC.getTime() + 4 * 60 * 60 * 1000);
    }

    return ticks;
}

/**
 * Calculate 2-hour tick positions starting at UTC midnight
 * Quantizes at 2-hour boundaries (00:00, 02:00, 04:00, ..., 22:00 UTC)
 * Used when canvas width is <= 3/4 of maximum width
 */
export function calculateTwoHourTicks(startUTC, endUTC) {
    const ticks = [];

    // Get UTC time components from start time
    const startYear = startUTC.getUTCFullYear();
    const startMonth = startUTC.getUTCMonth();
    const startDay = startUTC.getUTCDate();
    const startHours = startUTC.getUTCHours();

    // Find first 2-hour block starting at UTC midnight (00:00, 02:00, 04:00, ..., 22:00)
    // Round down to nearest 2-hour boundary
    const hoursRoundedDown = Math.floor(startHours / 2) * 2;
    let firstTickUTC = new Date(Date.UTC(startYear, startMonth, startDay, hoursRoundedDown, 0, 0, 0));

    // If we're not starting at a 2-hour boundary, find the first one within the region
    if (firstTickUTC.getTime() < startUTC.getTime()) {
        // Move forward to next 2-hour block
        firstTickUTC = new Date(firstTickUTC.getTime() + 2 * 60 * 60 * 1000);
    }

    // Generate ticks every 2 hours until we exceed end time
    let currentTickUTC = new Date(firstTickUTC);
    let previousTickDateUTC = null;

    while (currentTickUTC.getTime() <= endUTC.getTime()) {
        // Get UTC date string for day crossing detection
        const currentTickDateUTC = currentTickUTC.toISOString().split('T')[0];
        const currentHourUTC = currentTickUTC.getUTCHours();
        const currentMinutesUTC = currentTickUTC.getUTCMinutes();

        // Mark as day crossing if:
        // 1. Previous tick was on a different UTC date, OR
        // 2. This tick is at UTC midnight (00:00)
        const isDayCrossing = (previousTickDateUTC !== null && previousTickDateUTC !== currentTickDateUTC) ||
                              (currentHourUTC === 0 && currentMinutesUTC === 0);

        // Check if this UTC time falls within our data range
        if (currentTickUTC.getTime() >= startUTC.getTime() && currentTickUTC.getTime() <= endUTC.getTime()) {
            ticks.push({
                utcTime: new Date(currentTickUTC),
                localTime: new Date(currentTickUTC),
                isDayCrossing: isDayCrossing
            });
        }

        previousTickDateUTC = currentTickDateUTC;

        // Move to next 2-hour block
        currentTickUTC = new Date(currentTickUTC.getTime() + 2 * 60 * 60 * 1000);
    }

    return ticks;
}

/**
 * Calculate 1-minute tick positions (UTC)
 * Used when region is less than 20 minutes for finest granularity
 */
export function calculateOneMinuteTicks(startUTC, endUTC) {
    const ticks = [];

    // Get UTC time components from start time
    const startYear = startUTC.getUTCFullYear();
    const startMonth = startUTC.getUTCMonth();
    const startDay = startUTC.getUTCDate();
    const startHours = startUTC.getUTCHours();
    const startMinutes = startUTC.getUTCMinutes();

    // Start at the current minute boundary
    let firstTickUTC = new Date(Date.UTC(startYear, startMonth, startDay, startHours, startMinutes, 0, 0));

    // If we're not starting at a minute boundary, find the first one within the region
    if (firstTickUTC.getTime() < startUTC.getTime()) {
        // Move forward to next minute
        firstTickUTC = new Date(firstTickUTC.getTime() + 60 * 1000);
    }

    // Generate ticks every minute until we exceed end time
    let currentTickUTC = new Date(firstTickUTC);
    let previousTickDateUTC = null;

    while (currentTickUTC.getTime() <= endUTC.getTime()) {
        // Get UTC date string for day crossing detection
        const currentTickDateUTC = currentTickUTC.toISOString().split('T')[0];
        const currentHourUTC = currentTickUTC.getUTCHours();
        const currentMinutesUTC = currentTickUTC.getUTCMinutes();

        // Mark as day crossing if:
        // 1. Previous tick was on a different UTC date, OR
        // 2. This tick is at UTC midnight (00:00)
        const isDayCrossing = (previousTickDateUTC !== null && previousTickDateUTC !== currentTickDateUTC) ||
                              (currentHourUTC === 0 && currentMinutesUTC === 0);

        // Check if this UTC time falls within our data range
        if (currentTickUTC.getTime() >= startUTC.getTime() && currentTickUTC.getTime() <= endUTC.getTime()) {
            ticks.push({
                utcTime: new Date(currentTickUTC),
                localTime: new Date(currentTickUTC),
                isDayCrossing: isDayCrossing
            });
        }

        previousTickDateUTC = currentTickDateUTC;

        // Move to next minute
        currentTickUTC = new Date(currentTickUTC.getTime() + 60 * 1000);
    }

    return ticks;
}

/**
 * Calculate 5-minute tick positions (UTC)
 * Quantizes at 5-minute boundaries (00:00, 00:05, 00:10, ..., 00:55 UTC)
 * Used when region is less than 2 hours for finer granularity
 */
export function calculateFiveMinuteTicks(startUTC, endUTC) {
    const ticks = [];

    // Get UTC time components from start time
    const startYear = startUTC.getUTCFullYear();
    const startMonth = startUTC.getUTCMonth();
    const startDay = startUTC.getUTCDate();
    const startHours = startUTC.getUTCHours();
    const startMinutes = startUTC.getUTCMinutes();

    // Find first 5-minute block (quantized at 5-minute boundaries UTC)
    // Round down to nearest 5-minute boundary
    const roundedMinutes = Math.floor(startMinutes / 5) * 5;
    let firstTickUTC = new Date(Date.UTC(startYear, startMonth, startDay, startHours, roundedMinutes, 0, 0));

    // If we're not starting at a 5-minute boundary, find the first one within the region
    if (firstTickUTC.getTime() < startUTC.getTime()) {
        // Move forward to next 5-minute block
        firstTickUTC = new Date(firstTickUTC.getTime() + 5 * 60 * 1000);
    }

    // Generate ticks every 5 minutes until we exceed end time
    let currentTickUTC = new Date(firstTickUTC);
    let previousTickDateUTC = null;

    while (currentTickUTC.getTime() <= endUTC.getTime()) {
        // Get UTC date string for day crossing detection
        const currentTickDateUTC = currentTickUTC.toISOString().split('T')[0];
        const currentHourUTC = currentTickUTC.getUTCHours();
        const currentMinutesUTC = currentTickUTC.getUTCMinutes();

        // Mark as day crossing if:
        // 1. Previous tick was on a different UTC date, OR
        // 2. This tick is at UTC midnight (00:00)
        const isDayCrossing = (previousTickDateUTC !== null && previousTickDateUTC !== currentTickDateUTC) ||
                              (currentHourUTC === 0 && currentMinutesUTC === 0);

        // Check if this UTC time falls within our data range
        if (currentTickUTC.getTime() >= startUTC.getTime() && currentTickUTC.getTime() <= endUTC.getTime()) {
            ticks.push({
                utcTime: new Date(currentTickUTC),
                localTime: new Date(currentTickUTC),
                isDayCrossing: isDayCrossing
            });
        }

        previousTickDateUTC = currentTickDateUTC;

        // Move to next 5-minute block
        currentTickUTC = new Date(currentTickUTC.getTime() + 5 * 60 * 1000);
    }

    return ticks;
}

/**
 * Calculate 10-minute tick positions (UTC)
 * Quantizes at 10-minute boundaries (00:00, 00:10, 00:20, 00:30, 00:40, 00:50 UTC)
 */
export function calculateTenMinuteTicks(startUTC, endUTC) {
    const ticks = [];
    const startYear = startUTC.getUTCFullYear();
    const startMonth = startUTC.getUTCMonth();
    const startDay = startUTC.getUTCDate();
    const startHours = startUTC.getUTCHours();
    const startMinutes = startUTC.getUTCMinutes();

    const roundedMinutes = Math.floor(startMinutes / 10) * 10;
    let firstTickUTC = new Date(Date.UTC(startYear, startMonth, startDay, startHours, roundedMinutes, 0, 0));

    if (firstTickUTC.getTime() < startUTC.getTime()) {
        firstTickUTC = new Date(firstTickUTC.getTime() + 10 * 60 * 1000);
    }

    let currentTickUTC = new Date(firstTickUTC);
    let previousTickDateUTC = null;

    while (currentTickUTC.getTime() <= endUTC.getTime()) {
        const currentTickDateUTC = currentTickUTC.toISOString().split('T')[0];
        const currentHourUTC = currentTickUTC.getUTCHours();
        const currentMinutesUTC = currentTickUTC.getUTCMinutes();

        const isDayCrossing = (previousTickDateUTC !== null && previousTickDateUTC !== currentTickDateUTC) ||
                              (currentHourUTC === 0 && currentMinutesUTC === 0);

        if (currentTickUTC.getTime() >= startUTC.getTime() && currentTickUTC.getTime() <= endUTC.getTime()) {
            ticks.push({
                utcTime: new Date(currentTickUTC),
                localTime: new Date(currentTickUTC),
                isDayCrossing: isDayCrossing
            });
        }

        previousTickDateUTC = currentTickDateUTC;
        currentTickUTC = new Date(currentTickUTC.getTime() + 10 * 60 * 1000);
    }

    return ticks;
}

/**
 * Calculate 15-minute tick positions (UTC)
 * Quantizes at 15-minute boundaries (00:00, 00:15, 00:30, 00:45, ..., 23:45 UTC)
 * Fills the gap between 10-minute and 30-minute intervals
 */
export function calculateFifteenMinuteTicks(startUTC, endUTC) {
    const ticks = [];
    const startYear = startUTC.getUTCFullYear();
    const startMonth = startUTC.getUTCMonth();
    const startDay = startUTC.getUTCDate();
    const startHours = startUTC.getUTCHours();
    const startMinutes = startUTC.getUTCMinutes();

    const roundedMinutes = Math.floor(startMinutes / 15) * 15;
    let firstTickUTC = new Date(Date.UTC(startYear, startMonth, startDay, startHours, roundedMinutes, 0, 0));

    if (firstTickUTC.getTime() < startUTC.getTime()) {
        firstTickUTC = new Date(firstTickUTC.getTime() + 15 * 60 * 1000);
    }

    let currentTickUTC = new Date(firstTickUTC);
    let previousTickDateUTC = null;

    while (currentTickUTC.getTime() <= endUTC.getTime()) {
        const currentTickDateUTC = currentTickUTC.toISOString().split('T')[0];
        const currentHourUTC = currentTickUTC.getUTCHours();
        const currentMinutesUTC = currentTickUTC.getUTCMinutes();

        const isDayCrossing = (previousTickDateUTC !== null && previousTickDateUTC !== currentTickDateUTC) ||
                              (currentHourUTC === 0 && currentMinutesUTC === 0);

        if (currentTickUTC.getTime() >= startUTC.getTime() && currentTickUTC.getTime() <= endUTC.getTime()) {
            ticks.push({
                utcTime: new Date(currentTickUTC),
                localTime: new Date(currentTickUTC),
                isDayCrossing: isDayCrossing
            });
        }

        previousTickDateUTC = currentTickDateUTC;
        currentTickUTC = new Date(currentTickUTC.getTime() + 15 * 60 * 1000);
    }

    return ticks;
}

/**
 * Calculate 30-minute tick positions (UTC)
 * Quantizes at 30-minute boundaries (00:00, 00:30, 01:00, 01:30, ..., 23:30 UTC)
 * Used when region is less than 6 hours but 2+ hours
 */
export function calculateThirtyMinuteTicks(startUTC, endUTC) {
    const ticks = [];

    // Get UTC time components from start time
    const startYear = startUTC.getUTCFullYear();
    const startMonth = startUTC.getUTCMonth();
    const startDay = startUTC.getUTCDate();
    const startHours = startUTC.getUTCHours();
    const startMinutes = startUTC.getUTCMinutes();

    // Find first 30-minute block (quantized at 30-minute boundaries UTC)
    // Round down to nearest 30-minute boundary
    const roundedMinutes = Math.floor(startMinutes / 30) * 30;
    let firstTickUTC = new Date(Date.UTC(startYear, startMonth, startDay, startHours, roundedMinutes, 0, 0));

    // If we're not starting at a 30-minute boundary, find the first one within the region
    if (firstTickUTC.getTime() < startUTC.getTime()) {
        // Move forward to next 30-minute block
        firstTickUTC = new Date(firstTickUTC.getTime() + 30 * 60 * 1000);
    }

    // Generate ticks every 30 minutes until we exceed end time
    let currentTickUTC = new Date(firstTickUTC);
    let previousTickDateUTC = null;

    while (currentTickUTC.getTime() <= endUTC.getTime()) {
        // Get UTC date string for day crossing detection
        const currentTickDateUTC = currentTickUTC.toISOString().split('T')[0];
        const currentHourUTC = currentTickUTC.getUTCHours();
        const currentMinutesUTC = currentTickUTC.getUTCMinutes();

        // Mark as day crossing if:
        // 1. Previous tick was on a different UTC date, OR
        // 2. This tick is at UTC midnight (00:00)
        const isDayCrossing = (previousTickDateUTC !== null && previousTickDateUTC !== currentTickDateUTC) ||
                              (currentHourUTC === 0 && currentMinutesUTC === 0);

        // Check if this UTC time falls within our data range
        if (currentTickUTC.getTime() >= startUTC.getTime() && currentTickUTC.getTime() <= endUTC.getTime()) {
            ticks.push({
                utcTime: new Date(currentTickUTC),
                localTime: new Date(currentTickUTC),
                isDayCrossing: isDayCrossing
            });
        }

        previousTickDateUTC = currentTickDateUTC;

        // Move to next 30-minute block
        currentTickUTC = new Date(currentTickUTC.getTime() + 30 * 60 * 1000);
    }

    return ticks;
}

/**
 * Position the waveform x-axis canvas below the waveform
 */
export function positionWaveformXAxisCanvas() {
    const waveformCanvas = document.getElementById('waveform');
    const xAxisCanvas = document.getElementById('waveform-x-axis');
    const panel = waveformCanvas?.closest('.panel');
    
    if (!waveformCanvas || !xAxisCanvas || !panel) return;
    
    const waveformRect = waveformCanvas.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    
    // Position below waveform, aligned with left edge
    const leftEdge = waveformRect.left - panelRect.left;
    const topEdge = waveformRect.bottom - panelRect.top;
    
    xAxisCanvas.style.cssText = `
        position: absolute;
        left: ${leftEdge}px;
        top: ${topEdge}px;
        width: ${waveformRect.width}px;
        height: 40px;
        opacity: 1;
        visibility: visible;
    `;
}

/**
 * Resize waveform x-axis canvas to match waveform width
 */
export function resizeWaveformXAxisCanvas() {
    const waveformCanvas = document.getElementById('waveform');
    const xAxisCanvas = document.getElementById('waveform-x-axis');
    
    if (!waveformCanvas || !xAxisCanvas) return;
    
    const currentWidth = waveformCanvas.offsetWidth;

    // Only resize if dimensions changed (resizing clears the canvas, may cause flicker)
    if (xAxisCanvas.width !== currentWidth || xAxisCanvas.height !== 40) {
        xAxisCanvas.width = currentWidth;
        xAxisCanvas.height = 40;
    }
    
    // Reposition and redraw after resize
    positionWaveformXAxisCanvas();
    drawWaveformXAxis();
}

/**
 * Resize waveform date canvas
 */
export function resizeWaveformDateCanvas() {
    const dateCanvas = document.getElementById('waveform-date');
    
    if (!dateCanvas) return;
    
    // Reposition and redraw after resize
    positionWaveformDateCanvas();
    drawWaveformDate();
}

/**
 * 🏛️ Cancel zoom transition RAF to prevent detached document leaks
 * Called during cleanup to ensure RAF callbacks are cancelled
 */
export function cancelZoomTransitionRAF() {
    if (zoomTransitionRAF !== null) {
        cancelAnimationFrame(zoomTransitionRAF);
        zoomTransitionRAF = null;
    }
    zoomTransitionInProgress = false;
    oldTimeRange = null;
}

/**
 * 🆘 EMERGENCY: Force stop any stuck zoom transition
 * Can be called from browser console: window.stopZoomTransition()
 * 
 * CRITICAL: Ensures final high-res canvas is displayed even when transition is stopped early.
 * This function completes the transition properly (like the normal completion path) to ensure
 * the final canvas renders, preventing the issue where stopping interrupts the display.
 */
export function stopZoomTransition() {
    console.warn('🆘 Emergency stop: Cancelling zoom transition');
    
    // Cancel RAF to prevent memory leaks
    if (zoomTransitionRAF !== null) {
        cancelAnimationFrame(zoomTransitionRAF);
        zoomTransitionRAF = null;
    }
    
    // If transition was in progress, complete it properly to ensure final canvas renders
    // This mimics the normal completion path (lines 274-286) to ensure consistency
    if (zoomTransitionInProgress) {
        // Mark transition as complete (same as normal completion)
        zoomTransitionInProgress = false;
        const wasZoomingToRegion = isZoomingToRegion;
        oldTimeRange = null;
        
        // 🏛️ Draw final frame to keep regions visible while waveform rebuilds
        // This prevents the flash where regions disappear during worker rebuild
        // CRITICAL: This is the same call as the normal completion path
        drawWaveformWithSelection();
        
        // 🔥 CRITICAL: Ensure final spectrogram canvas is displayed
        // The normal completion path relies on the promise chain in region-tracker.js
        // to call updateSpectrogramViewport(), but if we're stopping early, we need
        // to ensure the viewport is updated. However, we must be careful not to
        // interfere with the normal promise chain completion.
        // 
        // Strategy: Use requestAnimationFrame to ensure this happens after any
        // pending promise chains, but still within the same frame cycle
        if (wasZoomingToRegion && zoomState.isInRegion()) {
            // Schedule viewport update for next frame to ensure it happens after
            // any pending promise resolutions, but still displays the final canvas
            // 🔥 FIX: Store RAF ID to prevent multiple callbacks if stopZoomTransition is called repeatedly
            if (zoomTransitionRAF === null) {
                zoomTransitionRAF = requestAnimationFrame(() => {
                    zoomTransitionRAF = null; // Clear ID immediately to allow GC
                // Check if infinite canvas exists (high-res render is ready)
                // If it exists, update the viewport to display it
                const playbackRate = State.currentPlaybackRate || 1.0;
                // This will only update if infiniteSpectrogramCanvas exists
                // (i.e., if the high-res render has completed)
                updateSpectrogramViewport(playbackRate);
            });
            }
        }
    } else {
        // Transition wasn't in progress, just clean up
    cancelZoomTransitionRAF();
    }
}

/**
 * 🏛️ Get current interpolated time range (for regions to follow tick interpolation)
 * Returns the interpolated time range during zoom transitions, or current range otherwise
 * @returns {Object} { startTime: Date, endTime: Date } - The current display time range
 */
export function getInterpolatedTimeRange() {
    // 🏛️ Get the base time range (what we're interpolating TO)
    // 🙏 Timestamps as source of truth: Use timestamps directly from region range
    let targetStartTime, targetEndTime;

    if (zoomState.isInRegion()) {
        const regionRange = zoomState.getRegionRange();
        targetStartTime = regionRange.startTime;
        targetEndTime = regionRange.endTime;
    } else {
        // Full view (or scroll-zoomed): use zoomState timestamps
        targetStartTime = zoomState.isInitialized() ? zoomState.currentViewStartTime : State.dataStartTime;
        targetEndTime = zoomState.isInitialized() ? zoomState.currentViewEndTime : State.dataEndTime;
    }

    // If not in transition, return target range directly
    if (!zoomTransitionInProgress || oldTimeRange === null) {
        return {
            startTime: targetStartTime,
            endTime: targetEndTime
        };
    }

    // Calculate interpolation (EXACT same logic as drawWaveformXAxis)
    const elapsed = performance.now() - zoomTransitionStartTime;
    const progress = Math.min(elapsed / zoomTransitionDuration, 1.0);

    // Ease-in-out cubic: slow start → fast middle → slow end (gives render time!)
    const interpolationFactor = progress < 0.5 
        ? 4 * progress * progress * progress 
        : 1 - Math.pow(-2 * progress + 2, 3) / 2;

    // Interpolate between old and new time ranges
    const oldStartMs = oldTimeRange.startTime.getTime();
    const oldEndMs = oldTimeRange.endTime.getTime();
    const newStartMs = targetStartTime.getTime();
    const newEndMs = targetEndTime.getTime();

    const interpolatedStartMs = oldStartMs + (newStartMs - oldStartMs) * interpolationFactor;
    const interpolatedEndMs = oldEndMs + (newEndMs - oldEndMs) * interpolationFactor;

    return {
        startTime: new Date(interpolatedStartMs),
        endTime: new Date(interpolatedEndMs)
    };
}

/**
 * 🏛️ Get interpolation factor for smooth transitions
 * Returns 0.0 (start) to 1.0 (complete) with ease-in-out cubic easing
 * Slow start gives render time, slow end gives final polish time
 * @returns {number} Interpolation factor between 0.0 and 1.0
 */
export function getZoomTransitionProgress() {
    if (!zoomTransitionInProgress || oldTimeRange === null) {
        // Not in transition - return 1.0 if zoomed in, 0.0 if not
        return zoomState.isInRegion() ? 1.0 : 0.0;
    }
    
    const elapsed = performance.now() - zoomTransitionStartTime;
    const progress = Math.min(elapsed / zoomTransitionDuration, 1.0);
    
    // Ease-out cubic for smooth deceleration (same as time range interpolation)
    return 1 - Math.pow(1 - progress, 3);
}

/**
 * 🏛️ Get opacity interpolation factor for region highlights
 * Returns 0.0 (full view opacity) to 1.0 (zoomed in opacity) with smooth easing
 * @returns {number} Interpolation factor between 0.0 and 1.0
 */
export function getRegionOpacityProgress() {
    if (!zoomTransitionInProgress || oldTimeRange === null) {
        // Not in transition - return 1.0 if zoomed in, 0.0 if not
        return zoomState.isInRegion() ? 1.0 : 0.0;
    }
    
    // Use the transition progress, but invert if zooming OUT (from region to full)
    const progress = getZoomTransitionProgress();
    return isZoomingToRegion ? progress : (1.0 - progress);
}

/**
 * 🏛️ Check if zoom transition is in progress
 * @returns {boolean} True if transition is active
 */
export function isZoomTransitionInProgress() {
    return zoomTransitionInProgress;
}

/**
 * Get zoom direction (true = zooming TO region, false = zooming FROM region)
 * @returns {boolean} True if zooming to region, false if zooming from region
 */
export function getZoomDirection() {
    return isZoomingToRegion;
}

/**
 * Get the old time range (before transition started)
 * Returns null if not in transition
 * @returns {Object|null} { startTime: Date, endTime: Date } or null
 */
export function getOldTimeRange() {
    return oldTimeRange;
}

/**
 * 🏛️ Animate zoom transition for x-axis ticks
 * Interpolates tick positions smoothly when zooming in/out
 * @param {Date} oldStartTime - Previous start time
 * @param {Date} oldEndTime - Previous end time
 * @param {boolean} zoomingToRegion - True if zooming TO a region, false if zooming FROM a region
 * @returns {Promise} Resolves when animation completes
 */
export function animateZoomTransition(oldStartTime, oldEndTime, zoomingToRegion = false) {
    return new Promise(async (resolve) => {
        // 🔥 OPTIMIZATION: Cancel any active background renders (but keep transition smooth!)
        // This prevents render conflicts but doesn't interfere with the transition animation
        // cancelActiveRender(); // COMMENTED OUT: Preventing full spectrogram render from completing
        
        // Cancel any existing transition RAF and safety timeout
        if (zoomTransitionRAF) {
            cancelAnimationFrame(zoomTransitionRAF);
            zoomTransitionRAF = null;
        }
        if (zoomTransitionCleanupTimeout) {
            clearTimeout(zoomTransitionCleanupTimeout);
            zoomTransitionCleanupTimeout = null;
        }

        // Store old time range - we'll interpolate between old and new positions
        oldTimeRange = {
            startTime: new Date(oldStartTime),
            endTime: new Date(oldEndTime)
        };
        zoomTransitionInProgress = true;
        isZoomingToRegion = zoomingToRegion; // Track direction for opacity interpolation
        // 🔥 Reset timer - if user switches mid-transition, this restarts from 0ms
        zoomTransitionStartTime = performance.now();

        // Start animation loop
        drawWaveformXAxis();

        // 🔥 SAFETY: Set a timeout to force cleanup if RAF loop doesn't complete
        // This prevents infinite loops if something goes wrong
        // MUST be tracked so it can be cancelled when a new transition starts mid-flight
        zoomTransitionCleanupTimeout = setTimeout(() => {
            zoomTransitionCleanupTimeout = null;
            // Only force cleanup if transition is still in progress
            if (zoomTransitionInProgress) {
                console.warn(`⚠️ Zoom transition timeout: forcing cleanup after ${zoomTransitionDuration}ms`);
                if (zoomTransitionRAF) {
                    cancelAnimationFrame(zoomTransitionRAF);
                }
                zoomTransitionInProgress = false;
                oldTimeRange = null;
                zoomTransitionRAF = null;
            }
            resolve();
        }, zoomTransitionDuration + 100); // Add small buffer beyond expected duration
    });
}

