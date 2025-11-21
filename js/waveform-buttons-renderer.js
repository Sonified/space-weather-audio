/**
 * waveform-buttons-renderer.js
 * Button overlay canvas rendering for region zoom/play buttons
 * 
 * Follows the x-axis pattern: separate overlay canvas that reads dimensions fresh every time
 * This ensures buttons never depend on cached waveform canvas state
 */

import * as State from './audio-state.js';
import { zoomState } from './zoom-state.js';
import { getInterpolatedTimeRange, isZoomTransitionInProgress, getZoomTransitionProgress, getOldTimeRange } from './waveform-x-axis-renderer.js';

// Import region data access functions
let getCurrentRegions, activeRegionIndex, activePlayingRegionIndex, getRegionsDelayedForCrossfade;

// Throttle logging to once per second
let lastLogTime = 0;
const LOG_THROTTLE_MS = 1000; // Only log once per second

/**
 * Initialize with region tracker functions
 * Called from region-tracker.js to avoid circular dependencies
 */
export function initButtonsRenderer(regionTracker) {
    getCurrentRegions = regionTracker.getCurrentRegions;
    activeRegionIndex = regionTracker.activeRegionIndex;
    activePlayingRegionIndex = regionTracker.activePlayingRegionIndex;
    getRegionsDelayedForCrossfade = regionTracker.getRegionsDelayedForCrossfade;
}

/**
 * Position the waveform buttons canvas as an overlay on top of the waveform
 * Follows the same pattern as x-axis positioning
 */
export function positionWaveformButtonsCanvas() {
    const waveformCanvas = document.getElementById('waveform');
    const buttonsCanvas = document.getElementById('waveform-buttons');
    const panel = waveformCanvas?.closest('.panel');
    
    if (!waveformCanvas || !buttonsCanvas || !panel) return;
    
    const waveformRect = waveformCanvas.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    
    // Position buttons canvas exactly over waveform (transparent overlay)
    const leftEdge = waveformRect.left - panelRect.left;
    const topEdge = waveformRect.top - panelRect.top;
    
    buttonsCanvas.style.cssText = `
        position: absolute;
        left: ${leftEdge}px;
        top: ${topEdge}px;
        width: ${waveformRect.width}px;
        height: ${waveformRect.height}px;
        pointer-events: none;
        opacity: 1;
        visibility: visible;
        background: transparent !important;
        z-index: 1;
    `;
}

/**
 * Draw region buttons on the buttons overlay canvas
 * Separate canvas = no dependency on cached waveform = always correct!
 * 
 * Reads FRESH dimensions every time (just like x-axis does)
 */
export function drawRegionButtons() {
    const buttonsCanvas = document.getElementById('waveform-buttons');
    if (!buttonsCanvas) return;
    
    const waveformCanvas = document.getElementById('waveform');
    if (!waveformCanvas) return;
    
    // ✅ FRESH dimensions every time (just like x-axis!)
    const dpr = window.devicePixelRatio || 1;
    buttonsCanvas.width = waveformCanvas.offsetWidth * dpr;
    buttonsCanvas.height = waveformCanvas.offsetHeight * dpr;
    
    // 🔍 DIAGNOSTIC: Log render context (throttled to once per second)
    // const now = performance.now();
    // const shouldLog = (now - lastLogTime) > LOG_THROTTLE_MS;
    
    // if (shouldLog) {
    //     console.log('🎨 BUTTON RENDER:');
    //     console.log(`  Canvas dimensions: ${buttonsCanvas.width}px × ${buttonsCanvas.height}px (device)`);
    //     console.log(`  Waveform CSS: ${waveformCanvas.offsetWidth}px × ${waveformCanvas.offsetHeight}px`);
    //     console.log(`  DPR: ${dpr}`);
    //     lastLogTime = now;
    // }
    
    const ctx = buttonsCanvas.getContext('2d', { alpha: true });
    const canvasWidth = buttonsCanvas.width;
    const canvasHeight = buttonsCanvas.height;
    
    // Clear canvas (transparent background) - explicitly clear to ensure transparency
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    
    if (!State.dataStartTime || !State.dataEndTime || !State.totalAudioDuration) {
        return;
    }
    
    // 🔥 Don't draw buttons if regions are delayed for crossfade
    if (getRegionsDelayedForCrossfade && getRegionsDelayedForCrossfade()) {
        return; // Wait for crossfade to complete
    }
    
    if (!getCurrentRegions) {
        console.warn('⚠️ Buttons renderer not initialized - call initButtonsRenderer() first');
        return;
    }
    
    const regions = getCurrentRegions();
    if (regions.length === 0) return;
    
    // Convert region ISO timestamps to seconds from start of audio
    const dataStartMs = State.dataStartTime.getTime();
    
    // Draw buttons for each region
    regions.forEach((region, index) => {
        // 🏛️ Inside the temple, only render the active region (skip others for performance)
        if (zoomState.isInRegion() && !isZoomTransitionInProgress()) {
            const isActiveRegion = index === activeRegionIndex || region.id === zoomState.getCurrentRegionId();
            if (!isActiveRegion) {
                return;
            }
        }
        
        // Calculate region position (same logic as drawRegionHighlights)
        let regionStartSeconds, regionEndSeconds;
        if (region.startSample !== undefined && region.endSample !== undefined) {
            regionStartSeconds = zoomState.sampleToTime(region.startSample);
            regionEndSeconds = zoomState.sampleToTime(region.endSample);
        } else {
            const regionStartMs = new Date(region.startTime).getTime();
            const regionEndMs = new Date(region.stopTime).getTime();
            regionStartSeconds = (regionStartMs - dataStartMs) / 1000;
            regionEndSeconds = (regionEndMs - dataStartMs) / 1000;
        }
        
        // Calculate pixel positions
        let startX, endX;
        if (zoomState.isInitialized()) {
            const interpolatedRange = getInterpolatedTimeRange();
            // 🔥 FIX: Use saved timestamps DIRECTLY (matches region positioning fix!)
            const regionStartTimestamp = new Date(region.startTime);
            const regionEndTimestamp = new Date(region.stopTime);
            const displayStartMs = interpolatedRange.startTime.getTime();
            const displayEndMs = interpolatedRange.endTime.getTime();
            const displaySpanMs = displayEndMs - displayStartMs;
            const regionStartMs = regionStartTimestamp.getTime();
            const regionEndMs = regionEndTimestamp.getTime();
            const startProgress = (regionStartMs - displayStartMs) / displaySpanMs;
            const endProgress = (regionEndMs - displayStartMs) / displaySpanMs;
            startX = startProgress * canvasWidth;
            endX = endProgress * canvasWidth;
        } else {
            const startProgress = regionStartSeconds / State.totalAudioDuration;
            const endProgress = regionEndSeconds / State.totalAudioDuration;
            startX = startProgress * canvasWidth;
            endX = endProgress * canvasWidth;
        }
        const highlightWidth = endX - startX;
        
        // Calculate label position (same logic as drawRegionHighlights)
        const paddingY = 6;
        const insidePosition = startX + 10;
        const outsidePosition = startX - 20;
        let labelX;
        if (isZoomTransitionInProgress()) {
            const transitionProgress = getZoomTransitionProgress();
            const oldRange = getOldTimeRange();
            if (oldRange) {
                // 🔥 FIX: Use saved timestamps DIRECTLY (matches region positioning fix!)
                const regionStartTimestamp = new Date(region.startTime);
                const regionEndTimestamp = new Date(region.stopTime);
                const oldStartMs = regionStartTimestamp.getTime();
                const oldEndMs = regionEndTimestamp.getTime();
                const oldDisplayStartMs = oldRange.startTime.getTime();
                const oldDisplayEndMs = oldRange.endTime.getTime();
                const oldDisplaySpanMs = oldDisplayEndMs - oldDisplayStartMs;
                const oldStartProgress = (oldStartMs - oldDisplayStartMs) / oldDisplaySpanMs;
                const oldEndProgress = (oldEndMs - oldDisplayStartMs) / oldDisplaySpanMs;
                const oldStartX = oldStartProgress * canvasWidth;
                const oldEndX = oldEndProgress * canvasWidth;
                const oldWidth = oldEndX - oldStartX;
                const oldPosition = oldWidth < 30 ? (oldStartX - 20) : (oldStartX + 10);
                let targetStartTime, targetEndTime;
                if (zoomState.isInRegion()) {
                    const regionRange = zoomState.getRegionRange();
                    targetStartTime = zoomState.sampleToRealTimestamp(regionRange.startSample);
                    targetEndTime = zoomState.sampleToRealTimestamp(regionRange.endSample);
                } else {
                    targetStartTime = State.dataStartTime;
                    targetEndTime = State.dataEndTime;
                }
                const targetStartMs = targetStartTime.getTime();
                const targetEndMs = targetEndTime.getTime();
                const targetSpanMs = targetEndMs - targetStartMs;
                const targetStartProgress = (oldStartMs - targetStartMs) / targetSpanMs;
                const targetEndProgress = (oldEndMs - targetStartMs) / targetSpanMs;
                const targetStartX = targetStartProgress * canvasWidth;
                const targetEndX = targetEndProgress * canvasWidth;
                const targetWidth = targetEndX - targetStartX;
                const newInsidePos = targetStartX + 10;
                const newOutsidePos = targetStartX - 20;
                const newPosition = targetWidth < 30 ? newOutsidePos : newInsidePos;
                const easedProgress = 1 - Math.pow(1 - transitionProgress, 3);
                labelX = oldPosition + (newPosition - oldPosition) * easedProgress;
            } else {
                labelX = highlightWidth < 30 ? outsidePosition : insidePosition;
            }
        } else {
            labelX = highlightWidth < 30 ? outsidePosition : insidePosition;
        }
        const labelY = paddingY;
        
        // Calculate button sizes (fixed CSS pixels, scaled for DPR only)
        const baseButtonWidth = 21;
        const baseButtonHeight = 15;
        const buttonWidth = baseButtonWidth * dpr;
        const buttonHeight = baseButtonHeight * dpr;
        const buttonPadding = 4 * dpr;
        const numberTextSize = 20 * dpr;
        const numberTextHeight = numberTextSize;
        const numberTextWidth = 18 * dpr;
        
        // Calculate total width needed (number + buttons + padding)
        const totalButtonAreaWidth = numberTextWidth + buttonWidth + buttonPadding + buttonWidth + buttonPadding;
        const isOnScreen = labelX + totalButtonAreaWidth > 0 && labelX < canvasWidth;
        
        if (isOnScreen) {
            const regionNumber = index + 1; // 1-indexed for display
            
            // Draw zoom button next to the number
            const zoomButtonX = labelX + numberTextWidth;
            const buttonY = labelY + (numberTextHeight - buttonHeight) / 2;
            
            // 🔍 DIAGNOSTIC: Log button position (throttled to once per second)
            // if (shouldLog) {
            //     const buttonCenterX = (zoomButtonX + buttonWidth / 2);
            //     const buttonCenterPercent = (buttonCenterX / canvasWidth) * 100;
            //     
            //     console.log(`  Region ${regionNumber} zoom button:`);
            //     console.log(`    Position: ${zoomButtonX.toFixed(1)}px (device) = ${buttonCenterPercent.toFixed(1)}% across`);
            //     console.log(`    Size: ${buttonWidth.toFixed(1)}px × ${buttonHeight.toFixed(1)}px (device)`);
            //     console.log(`    Bounds: [${zoomButtonX.toFixed(1)}, ${buttonY.toFixed(1)}] to [${(zoomButtonX + buttonWidth).toFixed(1)}, ${(buttonY + buttonHeight).toFixed(1)}]`);
            // }
            
            // Set text style - white with 80% opacity
            ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
            ctx.font = `bold ${numberTextSize}px -apple-system, BlinkMacSystemFont, "Segoe UI"`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            
            ctx.fillText(regionNumber.toString(), labelX, labelY);
            
            // Determine zoom button state
            const isZoomedIntoThisRegion = zoomState.isInRegion() && zoomState.getCurrentRegionId() === region.id;
            const zoomButtonIcon = isZoomedIntoThisRegion ? '↩️' : '🔍';
            
            // Draw play button to the right of zoom button
            const playButtonX = zoomButtonX + buttonWidth + buttonPadding;
            
            // Determine play button state
            const isThisRegionPlaying = activePlayingRegionIndex === index;
            const playGradient = isThisRegionPlaying
                ? ['#34ce57', '#1e7e34'] // Green when playing
                : ['#d32f3f', '#a01d2a']; // Red when not playing
            
            // Helper function to draw a button with 3D effect
            const drawButton = (x, y, gradientColors, drawIcon) => {
                ctx.save();
                ctx.globalAlpha = 1.0;
                
                const radius = 3 * dpr;
                
                // Create gradient for button background
                const gradient = ctx.createLinearGradient(x, y, x + buttonWidth, y + buttonHeight);
                gradient.addColorStop(0, gradientColors[0]);
                gradient.addColorStop(1, gradientColors[1]);
                
                // Draw button background with gradient
                ctx.beginPath();
                ctx.moveTo(x + radius, y);
                ctx.lineTo(x + buttonWidth - radius, y);
                ctx.quadraticCurveTo(x + buttonWidth, y, x + buttonWidth, y + radius);
                ctx.lineTo(x + buttonWidth, y + buttonHeight - radius);
                ctx.quadraticCurveTo(x + buttonWidth, y + buttonHeight, x + buttonWidth - radius, y + buttonHeight);
                ctx.lineTo(x + radius, y + buttonHeight);
                ctx.quadraticCurveTo(x, y + buttonHeight, x, y + buttonHeight - radius);
                ctx.lineTo(x, y + radius);
                ctx.quadraticCurveTo(x, y, x + radius, y);
                ctx.closePath();
                ctx.fillStyle = gradient;
                ctx.fill();
                
                // Draw border highlights
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x + radius, y);
                ctx.lineTo(x + buttonWidth - radius, y);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(x, y + radius);
                ctx.lineTo(x, y + buttonHeight - radius);
                ctx.stroke();
                
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
                ctx.beginPath();
                ctx.moveTo(x + radius, y + buttonHeight);
                ctx.lineTo(x + buttonWidth - radius, y + buttonHeight);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(x + buttonWidth, y + radius);
                ctx.lineTo(x + buttonWidth, y + buttonHeight - radius);
                ctx.stroke();
                
                // Draw inset highlights
                ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
                ctx.beginPath();
                ctx.moveTo(x + radius, y);
                ctx.lineTo(x + buttonWidth - radius, y);
                ctx.lineTo(x + buttonWidth - radius, y + 1);
                ctx.lineTo(x + radius, y + 1);
                ctx.closePath();
                ctx.fill();
                
                // Draw inset shadow
                ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
                ctx.beginPath();
                ctx.moveTo(x + radius, y + buttonHeight - 1);
                ctx.lineTo(x + buttonWidth - radius, y + buttonHeight - 1);
                ctx.lineTo(x + buttonWidth - radius, y + buttonHeight);
                ctx.lineTo(x + radius, y + buttonHeight);
                ctx.closePath();
                ctx.fill();
                
                // Draw icon (if provided)
                if (drawIcon) {
                    drawIcon(x, y);
                }
                
                ctx.restore();
            };
            
            // Draw zoom button
            const zoomGradient = isZoomedIntoThisRegion 
                ? ['#ff8c00', '#ff6600'] // Orange for return
                : ['#2196F3', '#1565C0']; // Blue for zoom
            drawButton(zoomButtonX, buttonY, zoomGradient, (x, y) => {
                ctx.fillStyle = 'rgba(255, 255, 255, 1.0)';
                const iconFontSize = 12 * dpr;
                ctx.font = `${iconFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI"`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(zoomButtonIcon, x + buttonWidth / 2, y + buttonHeight / 2);
            });
            
            // Draw play button
            drawButton(playButtonX, buttonY, playGradient, (x, y) => {
                const triangleSize = buttonWidth * 0.4;
                const triangleX = x + buttonWidth / 2 - triangleSize / 2;
                const triangleY = y + buttonHeight / 2;
                
                ctx.fillStyle = 'rgba(255, 255, 255, 1.0)';
                ctx.beginPath();
                ctx.moveTo(triangleX, triangleY - triangleSize / 2);
                ctx.lineTo(triangleX + triangleSize, triangleY);
                ctx.lineTo(triangleX, triangleY + triangleSize / 2);
                ctx.closePath();
                ctx.fill();
            });
        }
    });
}

/**
 * Resize buttons canvas to match waveform dimensions
 * Called on resize - positions and redraws buttons
 */
export function resizeWaveformButtonsCanvas() {
    positionWaveformButtonsCanvas();
    drawRegionButtons();
}

