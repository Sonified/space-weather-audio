/**
 * waveform-x-axis-renderer.js
 * X-axis rendering for waveform showing time ticks
 */

import * as State from './audio-state.js';
import { zoomState } from './zoom-state.js';

// Debug flag for axis drawing logs (set to true to enable detailed logging)
const DEBUG_AXIS = false;

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
    
    // Set internal canvas resolution to match display size
    canvas.width = displayWidth;
    canvas.height = 40; // Fixed height for x-axis
    
    const ctx = canvas.getContext('2d');
    const canvasWidth = canvas.width;
    const canvasHeight = canvas.height;
    
    // Clear canvas (transparent background)
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    
    // 🏛️ Use zoom state for time range
    let displayStartTime, displayEndTime;
    
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
    
    if (!displayStartTime || !displayEndTime) {
        return; // No data loaded yet
    }
    
    const startTimeUTC = new Date(displayStartTime);
    const endTimeUTC = new Date(displayEndTime);
    
    // Calculate actual time span in seconds (not playback duration!)
    const actualTimeSpanSeconds = (endTimeUTC.getTime() - startTimeUTC.getTime()) / 1000;
    
    // Validate time span
    if (!isFinite(actualTimeSpanSeconds) || actualTimeSpanSeconds <= 0) {
        console.warn(`🕐 X-axis: Invalid time span ${actualTimeSpanSeconds}, skipping draw`);
        return;
    }
    
    if (DEBUG_AXIS) console.log(`🕐 X-axis: Drawing with time span=${actualTimeSpanSeconds.toFixed(1)}s (${(actualTimeSpanSeconds/3600).toFixed(1)}h), canvas width=${canvasWidth}px`);
    
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
    
    // Calculate hourly ticks
    // Quantize at midnight (00:00), find first hour boundary within region
    const ticks = calculateHourlyTicks(startTimeUTC, endTimeUTC);
    
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
            console.log(`🕐 Tick filtered out: ${currentTickLocal.toLocaleString()} (UTC: ${tickUTCForPosition.toISOString()}) not in range`);
        }
        
        previousTickDate = currentTickDate;
        
        // Move to next hour block (in local time)
        currentTickLocal.setHours(currentTickLocal.getHours() + 1);
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
    
    // Match width to waveform display width
    xAxisCanvas.width = waveformCanvas.offsetWidth;
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

