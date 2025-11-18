/**
 * waveform-x-axis-renderer.js
 * X-axis rendering for waveform showing time ticks
 */

import * as State from './audio-state.js';
import { zoomState } from './zoom-state.js';
import { drawInterpolatedWaveform, drawWaveformWithSelection } from './waveform-renderer.js';
import { drawInterpolatedSpectrogram } from './spectrogram-complete-renderer.js';
import { updateAllFeatureBoxPositions } from './spectrogram-feature-boxes.js';

// Debug flag for axis drawing logs (set to true to enable detailed logging)
const DEBUG_AXIS = false;

// 🏛️ Zoom transition animation state (for smooth tick interpolation)
let zoomTransitionInProgress = false;
let zoomTransitionStartTime = null;
let zoomTransitionDuration = 500; // 500ms (faster, snappier transitions)
let oldTimeRange = null; // { startTime, endTime }
let zoomTransitionRAF = null;
let isZoomingToRegion = false; // Track if we're zooming TO a region (true) or FROM a region (false)

// Track maximum canvas width for responsive tick spacing
let maxCanvasWidth = null;

/**
 * Initialize maxCanvasWidth baseline on page load
 * Sets baseline to 1200px or actual canvas width if larger
 */
export function initializeMaxCanvasWidth() {
    const waveformCanvas = document.getElementById('waveform');
    if (!waveformCanvas) return;
    
    const currentWidth = waveformCanvas.offsetWidth;
    // Set baseline to 1200px minimum, or actual width if larger
    maxCanvasWidth = Math.max(1200, currentWidth);
}

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
    
    // Track maximum width seen so far
    if (maxCanvasWidth === null || displayWidth > maxCanvasWidth) {
        maxCanvasWidth = displayWidth;
    }
    
    // Set internal canvas resolution to match display size
    canvas.width = displayWidth;
    canvas.height = 40; // Fixed height for x-axis
    
    const ctx = canvas.getContext('2d');
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;
    
    // Clear canvas (transparent background)
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    
    // 🏛️ Use zoom state for time range (with interpolation during transition)
    let displayStartTime, displayEndTime;
    let interpolationFactor = 1.0;
    
    // 🏛️ Inside the temple: show the temple's time range
    if (zoomState.isInRegion()) {
        const regionRange = zoomState.getRegionRange();
        displayStartTime = zoomState.sampleToRealTimestamp(regionRange.startSample);
        displayEndTime = zoomState.sampleToRealTimestamp(regionRange.endSample);
    } else {
        // Full view: show full time range
        displayStartTime = State.dataStartTime;
        displayEndTime = State.dataEndTime;
    }
    
    // 🏛️ Interpolate during zoom transition
    if (zoomTransitionInProgress && oldTimeRange !== null) {
        const elapsed = performance.now() - zoomTransitionStartTime;
        const progress = Math.min(elapsed / zoomTransitionDuration, 1.0);
        
        // Ease-out cubic for smooth deceleration (same as y-axis)
        interpolationFactor = 1 - Math.pow(1 - progress, 3);
        
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
    
    // Calculate ticks based on region size and canvas width
    // If canvas is <= 1/2 of maximum width, use 4-hour ticks starting at midnight
    // Else if canvas is <= 3/4 of maximum width, use 2-hour ticks starting at midnight
    // Otherwise, if region is less than 2 hours, use 5-minute intervals
    // Else if region is less than 6 hours, use 30-minute intervals
    // Otherwise use hourly intervals
    const timeSpanHours = actualTimeSpanSeconds / 3600;
    let ticks;
    
    // Check canvas width thresholds
    const isVeryNarrowCanvas = maxCanvasWidth !== null && canvasWidth <= (maxCanvasWidth * 1 / 2);
    const isNarrowCanvas = maxCanvasWidth !== null && canvasWidth <= (maxCanvasWidth * 3 / 4);
    
    if (isVeryNarrowCanvas) {
        // Canvas is very narrow - use 4-hour ticks starting at midnight
        ticks = calculateFourHourTicks(startTimeUTC, endTimeUTC);
    } else if (isNarrowCanvas) {
        // Canvas is narrow - use 2-hour ticks starting at midnight
        ticks = calculateTwoHourTicks(startTimeUTC, endTimeUTC);
    } else if (timeSpanHours < 2) {
        // Region is less than 2 hours - use 5-minute ticks
        ticks = calculateFiveMinuteTicks(startTimeUTC, endTimeUTC);
    } else if (timeSpanHours < 6) {
        // Region is less than 6 hours - use 30-minute ticks
        ticks = calculateThirtyMinuteTicks(startTimeUTC, endTimeUTC);
    } else {
        // Region is 6+ hours - use hourly ticks
        ticks = calculateHourlyTicks(startTimeUTC, endTimeUTC);
    }
    
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
        let label;
        if (tick.isDayCrossing) {
            // Show date in 11/12 format (mm/dd)
            const localDate = tick.localTime;
            const month = localDate.getMonth() + 1; // 0-indexed
            const day = localDate.getDate();
            label = `${month}/${day}`;
        } else {
            // Show time in international format (1:00 through 13:00 and 24:00)
            const localDate = tick.localTime;
            const hours = localDate.getHours();
            const minutes = localDate.getMinutes();
            
            if (hours === 0 && minutes === 0) {
                label = '24:00'; // Midnight shown as 24:00
            } else {
                // 1:00 through 23:00 (no leading zero for single digits per international format)
                label = `${hours}:${String(minutes).padStart(2, '0')}`;
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

                    // 🏛️ Trigger interpolated waveform draw so everything zooms together
                    drawInterpolatedWaveform();

                    // 🏄‍♂️ Stretch spectrogram to match interpolated time range - everything moves together!
                    drawInterpolatedSpectrogram();

                    // 📦 Update feature boxes to move smoothly with the zoom transition!
                    updateAllFeatureBoxPositions();
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
        }
    }
}

/**
 * Draw date panel above waveform
 * Shows date extending off the left edge
 */
export function drawWaveformDate() {
    const canvas = document.getElementById('waveform-date');
    if (!canvas) return;
    
    // Need start time to get the date
    if (!State.dataStartTime) {
        return; // No data loaded yet
    }
    
    const startTimeUTC = new Date(State.dataStartTime);
    const startLocal = new Date(startTimeUTC);
    
    // Set canvas size
    canvas.width = 200;
    canvas.height = 40;
    
    const ctx = canvas.getContext('2d');
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;
    
    // Clear canvas (transparent background)
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    
    // Format date in 11/12 format (mm/dd)
    const month = startLocal.getMonth() + 1;
    const day = startLocal.getDate();
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
 * Calculate hourly tick positions
 * Quantizes at midnight (local time), finds first hour boundary within region
 * 
 * Strategy:
 * 1. Start from data start time, convert to local time
 * 2. Find first hour boundary in local time (00:00, 01:00, 02:00, ..., 23:00)
 * 3. Generate ticks every hour in local time
 * 4. For each local time tick, calculate corresponding UTC time for positioning
 */
function calculateHourlyTicks(startUTC, endUTC) {
    const ticks = [];
    
    // Convert start time to local time to find boundaries
    const startLocal = new Date(startUTC);
    
    // Get local time components
    const startYear = startLocal.getFullYear();
    const startMonth = startLocal.getMonth();
    const startDay = startLocal.getDate();
    const startHours = startLocal.getHours();
    
    // Find first hour block (quantized at midnight local time)
    // Hour blocks: 00:00, 01:00, 02:00, ..., 23:00 (local time)
    let firstTickLocal = new Date(startYear, startMonth, startDay, 0, 0, 0, 0);
    
    // Round down to nearest hour boundary
    firstTickLocal.setHours(startHours, 0, 0, 0);
    
    // If we're not starting at an hour boundary, find the first one within the region
    if (firstTickLocal < startLocal) {
        // Move forward to next hour block
        firstTickLocal.setHours(firstTickLocal.getHours() + 1);
    }
    
    // Generate ticks every hour until we exceed end time
    let currentTickLocal = new Date(firstTickLocal);
    let previousTickDate = null;
    
    // Convert end time to local for comparison
    // We need to compare in the same time context - use UTC milliseconds
    const endLocal = new Date(endUTC);
    const endLocalTime = endLocal.getTime();
    
    while (currentTickLocal.getTime() <= endLocalTime) {
        // Get local date string for day crossing detection
        const currentTickDate = currentTickLocal.toDateString();
        const currentHour = currentTickLocal.getHours();
        // Mark as day crossing if:
        // 1. Previous tick was on a different date, OR
        // 2. This tick is at midnight (00:00) - always show date at midnight
        const isDayCrossing = (previousTickDate !== null && previousTickDate !== currentTickDate) || 
                              (currentHour === 0 && currentTickLocal.getMinutes() === 0);
        
        // Convert local time to UTC for positioning
        // JavaScript Date constructor with (year, month, day, hour) interprets as local time
        // getTime() returns UTC milliseconds, so we can use that for positioning
        const localYear = currentTickLocal.getFullYear();
        const localMonth = currentTickLocal.getMonth();
        const localDay = currentTickLocal.getDate();
        const localHour = currentTickLocal.getHours();
        
        // Create date from local components (browser interprets as local time)
        const tickDateLocal = new Date(localYear, localMonth, localDay, localHour, 0, 0, 0);
        
        // getTime() gives UTC milliseconds - use for positioning
        const tickUTCForPosition = new Date(tickDateLocal.getTime());
        
        // Check if this UTC time falls within our data range
        // Compare using getTime() for accurate comparison
        if (tickUTCForPosition.getTime() >= startUTC.getTime() && tickUTCForPosition.getTime() <= endUTC.getTime()) {
            ticks.push({
                utcTime: tickUTCForPosition, // UTC time for positioning
                localTime: new Date(currentTickLocal), // Local time for display
                isDayCrossing: isDayCrossing
            });
        } else {
            // console.log(`🕐 Tick filtered out: ${currentTickLocal.toLocaleString()} (UTC: ${tickUTCForPosition.toISOString()}) not in range`);
        }
        
        previousTickDate = currentTickDate;
        
        // Move to next hour block (in local time)
        currentTickLocal.setHours(currentTickLocal.getHours() + 1);
    }
    
    return ticks;
}

/**
 * Calculate 4-hour tick positions starting at midnight
 * Quantizes at 4-hour boundaries (00:00, 04:00, 08:00, 12:00, 16:00, 20:00)
 * Used when canvas width is <= 1/2 of maximum width
 */
function calculateFourHourTicks(startUTC, endUTC) {
    const ticks = [];
    
    // Convert start time to local time to find boundaries
    const startLocal = new Date(startUTC);
    
    // Get local time components
    const startYear = startLocal.getFullYear();
    const startMonth = startLocal.getMonth();
    const startDay = startLocal.getDate();
    const startHours = startLocal.getHours();
    
    // Find first 4-hour block starting at midnight (00:00, 04:00, 08:00, 12:00, 16:00, 20:00)
    // Start from midnight of the start day
    let firstTickLocal = new Date(startYear, startMonth, startDay, 0, 0, 0, 0);
    
    // Round down to nearest 4-hour boundary (00:00, 04:00, 08:00, etc.)
    const hoursRoundedDown = Math.floor(startHours / 4) * 4;
    firstTickLocal.setHours(hoursRoundedDown, 0, 0, 0);
    
    // If we're not starting at a 4-hour boundary, find the first one within the region
    if (firstTickLocal < startLocal) {
        // Move forward to next 4-hour block
        firstTickLocal.setHours(firstTickLocal.getHours() + 4);
    }
    
    // Generate ticks every 4 hours until we exceed end time
    let currentTickLocal = new Date(firstTickLocal);
    let previousTickDate = null;
    
    // Convert end time to local for comparison
    const endLocal = new Date(endUTC);
    const endLocalTime = endLocal.getTime();
    
    while (currentTickLocal.getTime() <= endLocalTime) {
        // Get local date string for day crossing detection
        const currentTickDate = currentTickLocal.toDateString();
        const currentHour = currentTickLocal.getHours();
        // Mark as day crossing if:
        // 1. Previous tick was on a different date, OR
        // 2. This tick is at midnight (00:00) - always show date at midnight
        const isDayCrossing = (previousTickDate !== null && previousTickDate !== currentTickDate) || 
                              (currentHour === 0 && currentTickLocal.getMinutes() === 0);
        
        // Convert local time to UTC for positioning
        const localYear = currentTickLocal.getFullYear();
        const localMonth = currentTickLocal.getMonth();
        const localDay = currentTickLocal.getDate();
        const localHour = currentTickLocal.getHours();
        
        // Create date from local components (browser interprets as local time)
        const tickDateLocal = new Date(localYear, localMonth, localDay, localHour, 0, 0, 0);
        
        // getTime() gives UTC milliseconds - use for positioning
        const tickUTCForPosition = new Date(tickDateLocal.getTime());
        
        // Check if this UTC time falls within our data range
        if (tickUTCForPosition.getTime() >= startUTC.getTime() && tickUTCForPosition.getTime() <= endUTC.getTime()) {
            ticks.push({
                utcTime: tickUTCForPosition, // UTC time for positioning
                localTime: new Date(currentTickLocal), // Local time for display
                isDayCrossing: isDayCrossing
            });
        }
        
        previousTickDate = currentTickDate;
        
        // Move to next 4-hour block (in local time)
        currentTickLocal.setHours(currentTickLocal.getHours() + 4);
    }
    
    return ticks;
}

/**
 * Calculate 2-hour tick positions starting at midnight
 * Quantizes at 2-hour boundaries (00:00, 02:00, 04:00, ..., 22:00)
 * Used when canvas width is <= 3/4 of maximum width
 */
function calculateTwoHourTicks(startUTC, endUTC) {
    const ticks = [];
    
    // Convert start time to local time to find boundaries
    const startLocal = new Date(startUTC);
    
    // Get local time components
    const startYear = startLocal.getFullYear();
    const startMonth = startLocal.getMonth();
    const startDay = startLocal.getDate();
    const startHours = startLocal.getHours();
    
    // Find first 2-hour block starting at midnight (00:00, 02:00, 04:00, ..., 22:00)
    // Start from midnight of the start day
    let firstTickLocal = new Date(startYear, startMonth, startDay, 0, 0, 0, 0);
    
    // Round down to nearest 2-hour boundary (00:00, 02:00, 04:00, etc.)
    const hoursRoundedDown = Math.floor(startHours / 2) * 2;
    firstTickLocal.setHours(hoursRoundedDown, 0, 0, 0);
    
    // If we're not starting at a 2-hour boundary, find the first one within the region
    if (firstTickLocal < startLocal) {
        // Move forward to next 2-hour block
        firstTickLocal.setHours(firstTickLocal.getHours() + 2);
    }
    
    // Generate ticks every 2 hours until we exceed end time
    let currentTickLocal = new Date(firstTickLocal);
    let previousTickDate = null;
    
    // Convert end time to local for comparison
    const endLocal = new Date(endUTC);
    const endLocalTime = endLocal.getTime();
    
    while (currentTickLocal.getTime() <= endLocalTime) {
        // Get local date string for day crossing detection
        const currentTickDate = currentTickLocal.toDateString();
        const currentHour = currentTickLocal.getHours();
        // Mark as day crossing if:
        // 1. Previous tick was on a different date, OR
        // 2. This tick is at midnight (00:00) - always show date at midnight
        const isDayCrossing = (previousTickDate !== null && previousTickDate !== currentTickDate) || 
                              (currentHour === 0 && currentTickLocal.getMinutes() === 0);
        
        // Convert local time to UTC for positioning
        const localYear = currentTickLocal.getFullYear();
        const localMonth = currentTickLocal.getMonth();
        const localDay = currentTickLocal.getDate();
        const localHour = currentTickLocal.getHours();
        
        // Create date from local components (browser interprets as local time)
        const tickDateLocal = new Date(localYear, localMonth, localDay, localHour, 0, 0, 0);
        
        // getTime() gives UTC milliseconds - use for positioning
        const tickUTCForPosition = new Date(tickDateLocal.getTime());
        
        // Check if this UTC time falls within our data range
        if (tickUTCForPosition.getTime() >= startUTC.getTime() && tickUTCForPosition.getTime() <= endUTC.getTime()) {
            ticks.push({
                utcTime: tickUTCForPosition, // UTC time for positioning
                localTime: new Date(currentTickLocal), // Local time for display
                isDayCrossing: isDayCrossing
            });
        }
        
        previousTickDate = currentTickDate;
        
        // Move to next 2-hour block (in local time)
        currentTickLocal.setHours(currentTickLocal.getHours() + 2);
    }
    
    return ticks;
}

/**
 * Calculate 5-minute tick positions
 * Quantizes at 5-minute boundaries (00:00, 00:05, 00:10, ..., 00:55)
 * Used when region is less than 2 hours for finer granularity
 */
function calculateFiveMinuteTicks(startUTC, endUTC) {
    const ticks = [];
    
    // Convert start time to local time to find boundaries
    const startLocal = new Date(startUTC);
    
    // Get local time components
    const startYear = startLocal.getFullYear();
    const startMonth = startLocal.getMonth();
    const startDay = startLocal.getDate();
    const startHours = startLocal.getHours();
    const startMinutes = startLocal.getMinutes();
    
    // Find first 5-minute block (quantized at 5-minute boundaries)
    // 5-minute blocks: 00:00, 00:05, 00:10, ..., 00:55 (local time)
    let firstTickLocal = new Date(startYear, startMonth, startDay, startHours, 0, 0, 0);
    
    // Round down to nearest 5-minute boundary
    const roundedMinutes = Math.floor(startMinutes / 5) * 5;
    firstTickLocal.setMinutes(roundedMinutes, 0, 0);
    
    // If we're not starting at a 5-minute boundary, find the first one within the region
    if (firstTickLocal < startLocal) {
        // Move forward to next 5-minute block
        firstTickLocal.setMinutes(firstTickLocal.getMinutes() + 5);
    }
    
    // Generate ticks every 5 minutes until we exceed end time
    let currentTickLocal = new Date(firstTickLocal);
    let previousTickDate = null;
    
    // Convert end time to local for comparison
    const endLocal = new Date(endUTC);
    const endLocalTime = endLocal.getTime();
    
    while (currentTickLocal.getTime() <= endLocalTime) {
        // Get local date string for day crossing detection
        const currentTickDate = currentTickLocal.toDateString();
        const currentHour = currentTickLocal.getHours();
        const currentMinutes = currentTickLocal.getMinutes();
        
        // Mark as day crossing if:
        // 1. Previous tick was on a different date, OR
        // 2. This tick is at midnight (00:00) - always show date at midnight
        const isDayCrossing = (previousTickDate !== null && previousTickDate !== currentTickDate) || 
                              (currentHour === 0 && currentMinutes === 0);
        
        // Convert local time to UTC for positioning
        const localYear = currentTickLocal.getFullYear();
        const localMonth = currentTickLocal.getMonth();
        const localDay = currentTickLocal.getDate();
        const localHour = currentTickLocal.getHours();
        const localMinute = currentTickLocal.getMinutes();
        
        // Create date from local components (browser interprets as local time)
        const tickDateLocal = new Date(localYear, localMonth, localDay, localHour, localMinute, 0, 0);
        
        // getTime() gives UTC milliseconds - use for positioning
        const tickUTCForPosition = new Date(tickDateLocal.getTime());
        
        // Check if this UTC time falls within our data range
        if (tickUTCForPosition.getTime() >= startUTC.getTime() && tickUTCForPosition.getTime() <= endUTC.getTime()) {
            ticks.push({
                utcTime: tickUTCForPosition, // UTC time for positioning
                localTime: new Date(currentTickLocal), // Local time for display
                isDayCrossing: isDayCrossing
            });
        }
        
        previousTickDate = currentTickDate;
        
        // Move to next 5-minute block (in local time)
        currentTickLocal.setMinutes(currentTickLocal.getMinutes() + 5);
    }
    
    return ticks;
}

/**
 * Calculate 30-minute tick positions
 * Quantizes at 30-minute boundaries (00:00, 00:30, 01:00, 01:30, ..., 23:30)
 * Used when region is less than 6 hours but 2+ hours
 */
function calculateThirtyMinuteTicks(startUTC, endUTC) {
    const ticks = [];
    
    // Convert start time to local time to find boundaries
    const startLocal = new Date(startUTC);
    
    // Get local time components
    const startYear = startLocal.getFullYear();
    const startMonth = startLocal.getMonth();
    const startDay = startLocal.getDate();
    const startHours = startLocal.getHours();
    const startMinutes = startLocal.getMinutes();
    
    // Find first 30-minute block (quantized at 30-minute boundaries)
    // 30-minute blocks: 00:00, 00:30, 01:00, 01:30, ..., 23:30 (local time)
    let firstTickLocal = new Date(startYear, startMonth, startDay, startHours, 0, 0, 0);
    
    // Round down to nearest 30-minute boundary
    const roundedMinutes = Math.floor(startMinutes / 30) * 30;
    firstTickLocal.setMinutes(roundedMinutes, 0, 0);
    
    // If we're not starting at a 30-minute boundary, find the first one within the region
    if (firstTickLocal < startLocal) {
        // Move forward to next 30-minute block
        firstTickLocal.setMinutes(firstTickLocal.getMinutes() + 30);
    }
    
    // Generate ticks every 30 minutes until we exceed end time
    let currentTickLocal = new Date(firstTickLocal);
    let previousTickDate = null;
    
    // Convert end time to local for comparison
    const endLocal = new Date(endUTC);
    const endLocalTime = endLocal.getTime();
    
    while (currentTickLocal.getTime() <= endLocalTime) {
        // Get local date string for day crossing detection
        const currentTickDate = currentTickLocal.toDateString();
        const currentHour = currentTickLocal.getHours();
        const currentMinutes = currentTickLocal.getMinutes();
        
        // Mark as day crossing if:
        // 1. Previous tick was on a different date, OR
        // 2. This tick is at midnight (00:00) - always show date at midnight
        const isDayCrossing = (previousTickDate !== null && previousTickDate !== currentTickDate) || 
                              (currentHour === 0 && currentMinutes === 0);
        
        // Convert local time to UTC for positioning
        const localYear = currentTickLocal.getFullYear();
        const localMonth = currentTickLocal.getMonth();
        const localDay = currentTickLocal.getDate();
        const localHour = currentTickLocal.getHours();
        const localMinute = currentTickLocal.getMinutes();
        
        // Create date from local components (browser interprets as local time)
        const tickDateLocal = new Date(localYear, localMonth, localDay, localHour, localMinute, 0, 0);
        
        // getTime() gives UTC milliseconds - use for positioning
        const tickUTCForPosition = new Date(tickDateLocal.getTime());
        
        // Check if this UTC time falls within our data range
        if (tickUTCForPosition.getTime() >= startUTC.getTime() && tickUTCForPosition.getTime() <= endUTC.getTime()) {
            ticks.push({
                utcTime: tickUTCForPosition, // UTC time for positioning
                localTime: new Date(currentTickLocal), // Local time for display
                isDayCrossing: isDayCrossing
            });
        }
        
        previousTickDate = currentTickDate;
        
        // Move to next 30-minute block (in local time)
        currentTickLocal.setMinutes(currentTickLocal.getMinutes() + 30);
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
    
    // Track maximum width seen so far
    const currentWidth = waveformCanvas.offsetWidth;
    if (maxCanvasWidth === null || currentWidth > maxCanvasWidth) {
        maxCanvasWidth = currentWidth;
    }
    
    // Match width to waveform display width
    xAxisCanvas.width = currentWidth;
    xAxisCanvas.height = 40;
    
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
                import('./spectrogram-complete-renderer.js').then(module => {
                    // Check if infinite canvas exists (high-res render is ready)
                    // If it exists, update the viewport to display it
                    const playbackRate = State.currentPlaybackRate || 1.0;
                    if (module.updateSpectrogramViewport) {
                        // This will only update if infiniteSpectrogramCanvas exists
                        // (i.e., if the high-res render has completed)
                        module.updateSpectrogramViewport(playbackRate);
                    }
                }).catch(err => {
                    console.warn('⚠️ Could not update spectrogram viewport after emergency stop:', err);
                });
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
    let targetStartTime, targetEndTime;

    if (zoomState.isInRegion()) {
        const regionRange = zoomState.getRegionRange();
        targetStartTime = zoomState.sampleToRealTimestamp(regionRange.startSample);
        targetEndTime = zoomState.sampleToRealTimestamp(regionRange.endSample);
    } else {
        targetStartTime = State.dataStartTime;
        targetEndTime = State.dataEndTime;
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

    // Ease-out cubic for smooth deceleration
    const interpolationFactor = 1 - Math.pow(1 - progress, 3);

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
 * Returns 0.0 (start) to 1.0 (complete) with ease-out cubic easing
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
    return new Promise((resolve) => {
        // Cancel any existing transition
        if (zoomTransitionRAF) {
            cancelAnimationFrame(zoomTransitionRAF);
            zoomTransitionRAF = null;
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
        const cleanupTimeout = setTimeout(() => {
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
        
        // 🔥 Store timeout ID so we can cancel it if transition completes early
        // (The RAF loop will complete the transition, so this is just a safety net)
        // Note: We don't need to track this timeout ID since it's just a safety net
    });
}

