/**
 * region-tracker.js
 * Region tracking functionality for marking and annotating time/frequency regions
 * 
 * PLAYBACK LOGIC:
 * - Region play buttons ALWAYS show ▶ (never change to pause)
 * - Button color: RED (inactive) → GREEN (currently playing)
 * - Clicking a region button: plays from start, turns GREEN
 * - Clicking the same region again: replays from start (stays GREEN)
 * - Clicking a different region: old turns RED, new turns GREEN, jumps to new region
 * - When region finishes: button turns back to RED
 * - Master play/pause and spacebar handle pause/resume (region button stays GREEN)
 */

import * as State from './audio-state.js';
import { drawWaveformWithSelection, updatePlaybackIndicator, drawWaveform } from './waveform-renderer.js';
import { togglePlayPause, seekToPosition, updateWorkletSelection } from './audio-player.js';
import { zoomState } from './zoom-state.js';
import { getCurrentPlaybackBoundaries } from './playback-boundaries.js';
import { renderCompleteSpectrogramForRegion, renderCompleteSpectrogram, resetSpectrogramState, cacheFullSpectrogram, clearCachedFullSpectrogram, cacheZoomedSpectrogram, clearCachedZoomedSpectrogram, updateSpectrogramViewport, restoreInfiniteCanvasFromCache } from './spectrogram-complete-renderer.js';
import { animateZoomTransition, getInterpolatedTimeRange, getRegionOpacityProgress, isZoomTransitionInProgress, getZoomTransitionProgress, getOldTimeRange } from './waveform-x-axis-renderer.js';

// Region data structure - stored per volcano
// Map<volcanoName, regions[]>
let regionsByVolcano = new Map();
let currentVolcano = null;
let activeRegionIndex = null;
let activePlayingRegionIndex = null; // Track which region is currently playing (if any)

// Store zoom button positions on canvas for click detection
// Map<regionId, { x, y, width, height, regionIndex }>
// These are populated during drawRegionHighlights() - we just use them here!
let canvasZoomButtonPositions = new Map();

// Store play button positions on canvas for click detection
// Map<regionId, { x, y, width, height, regionIndex }>
// These are populated during drawRegionHighlights() - we just use them here!
let canvasPlayButtonPositions = new Map();

/**
 * Get the current volcano from the UI
 */
function getCurrentVolcano() {
    const volcanoSelect = document.getElementById('volcano');
    return volcanoSelect ? volcanoSelect.value : null;
}

/**
 * Get regions for the current volcano
 * Uses currentVolcano if set, otherwise reads from UI
 */
export function getCurrentRegions() {
    // Use currentVolcano if available (more reliable during volcano switches)
    // Otherwise fall back to reading from UI
    const volcano = currentVolcano || getCurrentVolcano();
    if (!volcano) {
        return [];
    }
    if (!regionsByVolcano.has(volcano)) {
        regionsByVolcano.set(volcano, []);
    }
    return regionsByVolcano.get(volcano);
}

/**
 * Set regions for the current volcano
 * Uses currentVolcano if set, otherwise reads from UI
 */
function setCurrentRegions(newRegions) {
    // Use currentVolcano if available (more reliable during volcano switches)
    // Otherwise fall back to reading from UI
    const volcano = currentVolcano || getCurrentVolcano();
    if (!volcano) {
        return;
    }
    regionsByVolcano.set(volcano, newRegions);
}

/**
 * Switch to a different volcano's regions
 * Called when volcano selection changes
 * Note: This is called AFTER the UI select has already changed to the new volcano
 */
export function switchVolcanoRegions(newVolcano) {
    if (!newVolcano) {
        console.warn('⚠️ Cannot switch: no volcano specified');
        return;
    }
    
    // Save current regions before switching (if we have a current volcano and it's different)
    // Since getCurrentRegions() now uses currentVolcano when available, we can safely get the old volcano's regions
    if (currentVolcano && currentVolcano !== newVolcano) {
        // Get the current regions (for the old volcano) and save them
        const oldRegions = getCurrentRegions();
        regionsByVolcano.set(currentVolcano, oldRegions);
    }
    
    // Clear active region indices when switching volcanoes
    activeRegionIndex = null;
    activePlayingRegionIndex = null;
    
    // Clear canvas button positions when switching volcanoes
    canvasZoomButtonPositions.clear();
    canvasPlayButtonPositions.clear();
    
    // Update current volcano
    currentVolcano = newVolcano;
    
    // Initialize regions array for new volcano if needed
    if (!regionsByVolcano.has(newVolcano)) {
        regionsByVolcano.set(newVolcano, []);
    }
    
    // Re-render regions for the new volcano
    renderRegions();
    
    // Redraw waveform to update region highlights
    drawWaveformWithSelection();
    
    console.log(`🌋 Switched to volcano: ${newVolcano} (${regionsByVolcano.get(newVolcano).length} regions)`);
}

// Waveform selection state
let isSelectingTime = false;
let selectionStartX = null;
let selectionEndX = null;
let selectionBoxElement = null;
let addRegionButton = null;

// Spectrogram frequency selection state
let isSelectingFrequency = false;
let currentFrequencySelection = null;
let spectrogramSelectionBox = null;
let spectrogramStartY = null;
let spectrogramStartX = null;
let spectrogramEndX = null;

// Constants
const maxFrequency = 50; // Hz - Nyquist frequency for 100 Hz sample rate

/**
 * Initialize region tracker
 * Sets up event listeners and prepares UI
 */
export function initRegionTracker() {
    console.log('🎯 Region tracker initialized');
    
    // Initialize current volcano
    currentVolcano = getCurrentVolcano();
    if (currentVolcano) {
        // Initialize regions array for current volcano
        if (!regionsByVolcano.has(currentVolcano)) {
            regionsByVolcano.set(currentVolcano, []);
        }
    }
    
    // Region cards will appear dynamically in #regionsList
    // No wrapper panel needed
    
    // Setup waveform selection for creating regions
    setupWaveformSelection();
}

/**
 * Setup waveform selection for creating regions
 * This just prepares the button element, actual selection is handled by waveform-renderer.js
 */
function setupWaveformSelection() {
    console.log('🎯 Waveform selection for region creation ready');
}

/**
 * Show "Add Region" button after waveform selection
 * Called by waveform-renderer.js after a selection is made
 */
export function showAddRegionButton(selectionStart, selectionEnd) {
    // 🔥 FIX: Check document connection before DOM access
    if (!document.body || !document.body.isConnected) {
        return;
    }
    
    if (!State.dataStartTime || !State.dataEndTime) return;
    
    const canvas = document.getElementById('waveform');
    if (!canvas) return;
    
    const panel = canvas.closest('.panel');
    if (!panel) return;
    
    // Calculate pixel positions from time values
    const dataStartMs = State.dataStartTime.getTime();
    const dataEndMs = State.dataEndTime.getTime();
    const totalDurationMs = dataEndMs - dataStartMs;
    
    const startProgress = (selectionStart / State.totalAudioDuration);
    const endProgress = (selectionEnd / State.totalAudioDuration);
    
    const canvasWidth = canvas.offsetWidth;
    const startX = startProgress * canvasWidth;
    const endX = endProgress * canvasWidth;
    
    // Create or get button
    if (!addRegionButton) {
        addRegionButton = document.createElement('button');
        addRegionButton.className = 'add-region-button';
        addRegionButton.textContent = '+ Add Region';
        panel.appendChild(addRegionButton);
    }
    
    // Update onclick with NEW selection times every time
    addRegionButton.onclick = (e) => {
        e.stopPropagation();
        createRegionFromSelectionTimes(selectionStart, selectionEnd);
    };
    
    // Calculate button position relative to panel
    const canvasRect = canvas.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const buttonX = canvasRect.left - panelRect.left + (startX + endX) / 2;
    const buttonTop = canvasRect.top - panelRect.top - 50; // 50px above waveform
    
    // Check if button is already visible and in a different position
    const isCurrentlyVisible = addRegionButton.style.display === 'block' && 
                               parseFloat(addRegionButton.style.opacity) > 0;
    const currentLeft = parseFloat(addRegionButton.style.left) || 0;
    const currentTop = parseFloat(addRegionButton.style.top) || 0;
    const positionChanged = Math.abs(currentLeft - buttonX) > 1 || Math.abs(currentTop - buttonTop) > 1;
    
    if (isCurrentlyVisible && positionChanged) {
        // Fade out first, then move and fade in
        addRegionButton.style.transition = 'opacity 0.15s ease-out';
        addRegionButton.style.opacity = '0';
        
        setTimeout(() => {
            // 🔥 FIX: Check document connection before DOM manipulation
            if (!document.body || !document.body.isConnected || !addRegionButton) {
                return;
            }
            
            // Move to new position while invisible
            addRegionButton.style.left = buttonX + 'px';
            addRegionButton.style.top = buttonTop + 'px';
            addRegionButton.style.transform = 'translateX(-50%)';
            
            // Fade in at new position
            requestAnimationFrame(() => {
                // 🔥 FIX: Check document connection before DOM manipulation
                if (!document.body || !document.body.isConnected || !addRegionButton) {
                    return;
                }
                addRegionButton.style.transition = 'opacity 0.2s ease-in';
                addRegionButton.style.opacity = '1';
            });
        }, 150); // Wait for fade out to complete
    } else {
        // First time showing or same position - just fade in
        addRegionButton.style.left = buttonX + 'px';
        addRegionButton.style.top = buttonTop + 'px';
        addRegionButton.style.transform = 'translateX(-50%)';
        addRegionButton.style.opacity = '0';
        addRegionButton.style.display = 'block';
        
        // Fade in quickly
        requestAnimationFrame(() => {
            // 🔥 FIX: Check document connection before DOM manipulation
            if (!document.body || !document.body.isConnected || !addRegionButton) {
                return;
            }
            addRegionButton.style.transition = 'opacity 0.2s ease-in';
            addRegionButton.style.opacity = '1';
        });
    }
}

/**
 * Hide the "Add Region" button
 */
export function hideAddRegionButton() {
    if (addRegionButton) {
        addRegionButton.style.display = 'none';
        addRegionButton.style.opacity = '0';
    }
}

/**
 * Remove the "Add Region" button from DOM to prevent detached element leaks
 * Called when clearing regions or loading new data
 */
export function removeAddRegionButton() {
    if (addRegionButton) {
        // 🔥 FIX: Clear onclick handler to break closure chain
        addRegionButton.onclick = null;
        
        // 🔥 FIX: Clear all event listeners by cloning (breaks all references)
        // This ensures detached elements can be garbage collected
        if (addRegionButton.parentNode) {
            const cloned = addRegionButton.cloneNode(false);
            addRegionButton.parentNode.replaceChild(cloned, addRegionButton);
            cloned.parentNode.removeChild(cloned);
        } else {
            // Already detached, just clear reference
            addRegionButton = null;
        }
        
        // Clear reference
        addRegionButton = null;
    }
}

/**
 * Create region from waveform selection times
 */
function createRegionFromSelectionTimes(selectionStartSeconds, selectionEndSeconds) {
    if (!State.dataStartTime || !State.dataEndTime) return;
    
    // 🏛️ Check if zoom state is initialized (required for sample calculations)
    if (!zoomState.isInitialized()) {
        console.warn('⚠️ Cannot create region: zoom state not initialized yet');
        return;
    }
    
    console.log('🎯 Creating region from selection:', selectionStartSeconds, '-', selectionEndSeconds, 'seconds');
    console.log('   Data start:', State.dataStartTime);
    console.log('   Total audio duration:', State.totalAudioDuration);
    
    // 🏛️ Convert selection times to absolute sample indices (the eternal truth)
    const startSample = zoomState.timeToSample(selectionStartSeconds);
    const endSample = zoomState.timeToSample(selectionEndSeconds);
    
    // Convert to real-world timestamps (for display/export)
    const startTimestamp = zoomState.sampleToRealTimestamp(startSample);
    const endTimestamp = zoomState.sampleToRealTimestamp(endSample);
    
    const startTime = startTimestamp ? startTimestamp.toISOString() : null;
    const endTime = endTimestamp ? endTimestamp.toISOString() : null;
    
    console.log('   Region start sample:', startSample.toLocaleString());
    console.log('   Region end sample:', endSample.toLocaleString());
    console.log('   Region start time:', startTime);
    console.log('   Region end time:', endTime);
    
    // Get current volcano's regions
    const regions = getCurrentRegions();
    
    // Collapse all existing regions before adding new one
    regions.forEach(region => {
        region.expanded = false;
    });
    
    // Create new region with both sample indices and timestamps
    const newRegion = {
        id: regions.length > 0 ? Math.max(...regions.map(r => r.id)) + 1 : 1,
        
        // 🏛️ Sacred walls (STORED as absolute sample indices)
        startSample: startSample,
        endSample: endSample,
        
        // 📅 Display timestamps (DERIVED, kept for export/labels)
        startTime: startTime,
        stopTime: endTime,
        
        featureCount: 1,
        features: [{
            type: 'Impulsive',
            repetition: 'Unique',
            lowFreq: '',
            highFreq: '',
            startTime: '',
            endTime: '',
            notes: ''
        }],
        expanded: true,
        playing: false
    };
    
    regions.push(newRegion);
    setCurrentRegions(regions);
    const newRegionIndex = regions.length - 1;
    
    // Render the new region (it will appear as a floating card)
    renderRegions();
    
    // Animate the new region's expansion
    requestAnimationFrame(() => {
        // 🔥 FIX: Check document connection before DOM manipulation
        if (!document.body || !document.body.isConnected) {
            return;
        }
        
        const regionCard = document.querySelector(`[data-region-id="${newRegion.id}"]`);
        const details = regionCard ? regionCard.querySelector('.region-details') : null;
        
        if (details) {
            details.style.maxHeight = '0px';
            requestAnimationFrame(() => {
                // 🔥 FIX: Check document connection before DOM manipulation
                if (!document.body || !document.body.isConnected) {
                    return;
                }
                const targetHeight = details.scrollHeight;
                details.style.maxHeight = targetHeight + 'px';
            });
        }
    });
    
    // Set as active region (this will deselect old regions and select the new one)
    setActiveRegion(newRegionIndex);
    
    // Auto-enter selection mode for the first feature
    setTimeout(() => {
        startFrequencySelection(newRegionIndex, 0);
    }, 100);
    
    // Hide the add region button
    hideAddRegionButton();
    
    // Clear the yellow selection box by clearing selection state
    // The selection will be set to the region when space is pressed or play button is clicked
    State.setSelectionStart(null);
    State.setSelectionEnd(null);
    
    // Redraw waveform without the yellow selection box (only blue region highlight will remain)
    drawWaveformWithSelection();
}

/**
 * Draw region highlights on waveform canvas
 * Called from waveform-renderer after drawing waveform
 * Uses EXACT same approach as yellow selection box
 */
export function drawRegionHighlights(ctx, canvasWidth, canvasHeight) {
    if (!State.dataStartTime || !State.dataEndTime || !State.totalAudioDuration) {
        return; // No data loaded yet
    }
    
    const regions = getCurrentRegions();
    
    if (regions.length === 0) {
        return; // No regions to draw
    }
    
    // Convert region ISO timestamps to seconds from start of audio (like selectionStart/End)
    const dataStartMs = State.dataStartTime.getTime();
    
    // Draw highlights for each region
    regions.forEach((region, index) => {
        // 🏛️ Inside the temple, only render the active region (skip others for performance)
        // BUT: During transitions, render all regions so they can fade out smoothly
        // When we're within sacred walls, we focus only on the current temple
        if (zoomState.isInRegion() && !isZoomTransitionInProgress()) {
            // Check both activeRegionIndex and activeRegionId to ensure we render the correct region
            const isActiveRegion = index === activeRegionIndex || region.id === zoomState.getCurrentRegionId();
            if (!isActiveRegion) {
                return; // Skip rendering non-active regions when fully zoomed in (not in transition)
            }
        }
        
        // 🏛️ Use sample indices if available (new format), otherwise fall back to timestamps (backward compatibility)
        let regionStartSeconds, regionEndSeconds;
        
        if (region.startSample !== undefined && region.endSample !== undefined) {
            // New format: convert from eternal sample indices
            regionStartSeconds = zoomState.sampleToTime(region.startSample);
            regionEndSeconds = zoomState.sampleToTime(region.endSample);
        } else {
            // Old format: convert from timestamps (backward compatibility)
            const regionStartMs = new Date(region.startTime).getTime();
            const regionEndMs = new Date(region.stopTime).getTime();
            regionStartSeconds = (regionStartMs - dataStartMs) / 1000;
            regionEndSeconds = (regionEndMs - dataStartMs) / 1000;
        }
        
        // console.log(`   Drawing region ${index}: ${regionStartSeconds.toFixed(2)}s - ${regionEndSeconds.toFixed(2)}s`);

        // 🏛️ Use interpolated time range for pixel positioning (makes regions surf the zoom animation!)
        // This keeps region boundaries aligned with the interpolating tick marks
        let startX, endX;
        if (zoomState.isInitialized()) {
            // Get the current interpolated time range (same range the x-axis ticks are using)
            const interpolatedRange = getInterpolatedTimeRange();

            // Convert region samples to real-world timestamps (eternal truth)
            const regionStartTimestamp = zoomState.sampleToRealTimestamp(region.startSample !== undefined ? region.startSample : zoomState.timeToSample(regionStartSeconds));
            const regionEndTimestamp = zoomState.sampleToRealTimestamp(region.endSample !== undefined ? region.endSample : zoomState.timeToSample(regionEndSeconds));

            // Calculate where these timestamps fall within the interpolated display range
            const displayStartMs = interpolatedRange.startTime.getTime();
            const displayEndMs = interpolatedRange.endTime.getTime();
            const displaySpanMs = displayEndMs - displayStartMs;

            const regionStartMs = regionStartTimestamp.getTime();
            const regionEndMs = regionEndTimestamp.getTime();

            // Progress within the interpolated time range (0.0 to 1.0)
            const startProgress = (regionStartMs - displayStartMs) / displaySpanMs;
            const endProgress = (regionEndMs - displayStartMs) / displaySpanMs;

            // Convert to pixel positions
            startX = startProgress * canvasWidth;
            endX = endProgress * canvasWidth;
        } else {
            // Fallback to old behavior if zoom state not initialized
            const startProgress = regionStartSeconds / State.totalAudioDuration;
            const endProgress = regionEndSeconds / State.totalAudioDuration;
            startX = startProgress * canvasWidth;
            endX = endProgress * canvasWidth;
        }
        const highlightWidth = endX - startX;
        
        // Draw filled rectangle (EXACT same pattern as yellow box)
        // Smoothly interpolate opacity during zoom transitions
        if (index === activeRegionIndex) {
            // Get opacity interpolation progress (0.0 = full view, 1.0 = zoomed in)
            // This handles both directions: zooming IN (0.5→0.2) and OUT (0.2→0.5)
            const opacityProgress = getRegionOpacityProgress();
            
            // Interpolate opacity: 0.5 (full view) → 0.2 (zoomed in)
            const fillOpacity = 0.5 - (0.5 - 0.2) * opacityProgress;
            ctx.fillStyle = `rgba(68, 136, 255, ${fillOpacity})`;
            
            // Interpolate border opacity: 0.9 (full view) → 0.4 (zoomed in)
            const strokeOpacity = 0.9 - (0.9 - 0.4) * opacityProgress;
            ctx.strokeStyle = `rgba(68, 136, 255, ${strokeOpacity})`;
        } else {
            // Inactive region: opacity varies based on zoom state
            // 25% opacity when zoomed out (full view), 10% when zoomed in
            const opacityProgress = getRegionOpacityProgress();
            const inactiveFillOpacity = 0.25 - (0.25 - 0.1) * opacityProgress;
            ctx.fillStyle = `rgba(68, 136, 255, ${inactiveFillOpacity})`;
            ctx.strokeStyle = 'rgba(68, 136, 255, 0.6)';
        }
        ctx.fillRect(startX, 0, highlightWidth, canvasHeight);
        
        // Draw border lines (EXACT same pattern as yellow box)
        // Border opacity already set above for active regions
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(startX, 0);
        ctx.lineTo(startX, canvasHeight);
        ctx.moveTo(endX, 0);
        ctx.lineTo(endX, canvasHeight);
        ctx.stroke();
        
        // Draw region number - smoothly interpolate position during zoom transitions
        // The number should "surf" the transition just like ticks and regions do! 🏄‍♂️
        const regionNumber = index + 1; // 1-indexed for display
        const paddingY = 6; // Padding from top edge
        
        // Calculate target positions (where number will be at start/end of transition)
        const insidePosition = startX + 10; // Position inside, top-left corner
        const outsidePosition = startX - 20; // Position outside, to the left
        
        let labelX;
        if (isZoomTransitionInProgress()) {
            // During transition, interpolate between old and new positions
            const transitionProgress = getZoomTransitionProgress();
            const oldRange = getOldTimeRange();
            
            if (oldRange) {
                // Calculate old positions (where number WAS before zoom)
                const regionStartTimestamp = zoomState.sampleToRealTimestamp(region.startSample !== undefined ? region.startSample : zoomState.timeToSample(regionStartSeconds));
                const regionEndTimestamp = zoomState.sampleToRealTimestamp(region.endSample !== undefined ? region.endSample : zoomState.timeToSample(regionEndSeconds));
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
                
                // Calculate old position (inside vs outside based on old width)
                const oldPosition = oldWidth < 30 ? (oldStartX - 20) : (oldStartX + 10);
                
                // Calculate NEW position (where number will be after transition completes)
                // Need to calculate target width based on FINAL time range, not interpolated
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
                
                // Calculate new position (inside vs outside based on FINAL target width)
                const newInsidePos = targetStartX + 10;
                const newOutsidePos = targetStartX - 20;
                const newPosition = targetWidth < 30 ? newOutsidePos : newInsidePos;
                
                // Smoothly interpolate between old and new positions
                // Use ease-out cubic (same as other transitions)
                const easedProgress = 1 - Math.pow(1 - transitionProgress, 3);
                labelX = oldPosition + (newPosition - oldPosition) * easedProgress;
            } else {
                // Fallback if oldRange is null
                labelX = highlightWidth < 30 ? outsidePosition : insidePosition;
            }
        } else {
            // Not in transition - use simple threshold logic
            labelX = highlightWidth < 30 ? outsidePosition : insidePosition;
        }
        const labelY = paddingY;
        
        // Calculate button sizes proportionally based on canvas size
        // Reference sizes: 21x15 at 1200px canvas width (typical size)
        // Scale proportionally to maintain aspect ratio
        const referenceCanvasWidth = 1200;
        const scaleFactor = Math.max(0.5, Math.min(1.5, canvasWidth / referenceCanvasWidth));
        const baseButtonWidth = 21;
        const baseButtonHeight = 15;
        const buttonWidth = Math.round(baseButtonWidth * scaleFactor);
        const buttonHeight = Math.round(baseButtonHeight * scaleFactor);
        const buttonPadding = Math.round(4 * scaleFactor);
        const numberTextSize = Math.round(20 * scaleFactor);
        const numberTextHeight = numberTextSize;
        const numberTextWidth = Math.round(18 * scaleFactor); // Approximate width of number text
        
        // Calculate total width needed (number + buttons + padding)
        const totalButtonAreaWidth = numberTextWidth + buttonWidth + buttonPadding + buttonWidth + buttonPadding;
        const isOnScreen = labelX + totalButtonAreaWidth > 0 && labelX < canvasWidth;
        
        if (isOnScreen) {
            // Set text style - white with 80% opacity, scaled font size
            ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
            ctx.font = `bold ${numberTextSize}px -apple-system, BlinkMacSystemFont, "Segoe UI"`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            
            ctx.fillText(regionNumber.toString(), labelX, labelY);
            
            // Draw zoom button next to the number, aligned to middle-left (vertically centered with number)
            const zoomButtonX = labelX + numberTextWidth; // Position button right after the number
            const buttonY = labelY + (numberTextHeight - buttonHeight) / 2; // Center button vertically with number
            
            // Determine zoom button state (same as panel button)
            const isZoomedIntoThisRegion = zoomState.isInRegion() && zoomState.getCurrentRegionId() === region.id;
            const zoomButtonIcon = isZoomedIntoThisRegion ? '↩️' : '🔍';
            
            // Draw play button to the right of zoom button
            const playButtonX = zoomButtonX + buttonWidth + buttonPadding;
            
            // Determine play button state (red when not playing this region, green when playing this region)
            const isThisRegionPlaying = activePlayingRegionIndex === index;
            const playGradient = isThisRegionPlaying
                ? ['#34ce57', '#1e7e34'] // Green when playing (matches panel .playing)
                : ['#d32f3f', '#a01d2a']; // Red when not playing (matches panel default)
            
            // Helper function to draw a button with 3D effect
            const drawButton = (x, y, gradientColors, drawIcon) => {
                ctx.save();
                ctx.globalAlpha = 1.0;
                
                const radius = Math.max(2, Math.round(3 * scaleFactor));
                
                // Create gradient for button background
                const gradient = ctx.createLinearGradient(x, y, x + buttonWidth, y + buttonHeight);
                gradient.addColorStop(0, gradientColors[0]); // Top-left (lighter)
                gradient.addColorStop(1, gradientColors[1]); // Bottom-right (darker)
                
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
                
                // Draw border highlights (light on top/left, dark on bottom/right)
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
            
            // Draw zoom button with emoji icon
            const zoomGradient = isZoomedIntoThisRegion 
                ? ['#ff8c00', '#ff6600'] // Orange for return
                : ['#2196F3', '#1565C0']; // Blue for zoom
            drawButton(zoomButtonX, buttonY, zoomGradient, (x, y) => {
                ctx.fillStyle = 'rgba(255, 255, 255, 1.0)';
                const iconFontSize = Math.max(8, Math.round(12 * scaleFactor));
                ctx.font = `${iconFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI"`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(zoomButtonIcon, x + buttonWidth / 2, y + buttonHeight / 2);
            });
            
            // Draw play button with white triangle icon
            drawButton(playButtonX, buttonY, playGradient, (x, y) => {
                // Draw white triangle pointing right (centered in button)
                const triangleSize = buttonWidth * 0.4;
                const triangleX = x + buttonWidth / 2 - triangleSize / 2;
                const triangleY = y + buttonHeight / 2;
                
                ctx.fillStyle = 'rgba(255, 255, 255, 1.0)'; // White triangle
                ctx.beginPath();
                ctx.moveTo(triangleX, triangleY - triangleSize / 2);
                ctx.lineTo(triangleX + triangleSize, triangleY);
                ctx.lineTo(triangleX, triangleY + triangleSize / 2);
                ctx.closePath();
                ctx.fill();
            });
            
            // Store button positions for click detection (in device pixel coordinates)
            // These will be recalculated on every render, so they're always current
            canvasZoomButtonPositions.set(region.id, {
                x: zoomButtonX,
                y: buttonY,
                width: buttonWidth,
                height: buttonHeight,
                regionIndex: index
            });
            
            canvasPlayButtonPositions.set(region.id, {
                x: playButtonX,
                y: buttonY,
                width: buttonWidth,
                height: buttonHeight,
                regionIndex: index
            });
        } else {
            // Number is off screen, remove button positions
            canvasZoomButtonPositions.delete(region.id);
            canvasPlayButtonPositions.delete(region.id);
        }
    });
}

/**
 * Draw region highlights on spectrogram canvas (lightweight version)
 * No numbers, no buttons - just subtle highlights
 */
export function drawSpectrogramRegionHighlights(ctx, canvasWidth, canvasHeight) {
    if (!State.dataStartTime || !State.dataEndTime || !State.totalAudioDuration) {
        return;
    }
    
    const regions = getCurrentRegions();
    if (regions.length === 0) return;
    
    regions.forEach((region, index) => {
        // Convert region to seconds
        let regionStartSeconds, regionEndSeconds;
        if (region.startSample !== undefined && region.endSample !== undefined) {
            regionStartSeconds = zoomState.sampleToTime(region.startSample);
            regionEndSeconds = zoomState.sampleToTime(region.endSample);
        } else {
            const dataStartMs = State.dataStartTime.getTime();
            const regionStartMs = new Date(region.startTime).getTime();
            const regionEndMs = new Date(region.stopTime).getTime();
            regionStartSeconds = (regionStartMs - dataStartMs) / 1000;
            regionEndSeconds = (regionEndMs - dataStartMs) / 1000;
        }
        
        // Use interpolated time range (same as waveform)
        let startX, endX;
        if (zoomState.isInitialized()) {
            const interpolatedRange = getInterpolatedTimeRange();
            const regionStartTimestamp = zoomState.sampleToRealTimestamp(
                region.startSample !== undefined ? region.startSample : zoomState.timeToSample(regionStartSeconds)
            );
            const regionEndTimestamp = zoomState.sampleToRealTimestamp(
                region.endSample !== undefined ? region.endSample : zoomState.timeToSample(regionEndSeconds)
            );
            
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
        
        // 🦋 Fade out completely when zooming into a region (like waveform fades)
        // opacityProgress: 0.0 = full view, 1.0 = zoomed in
        const opacityProgress = getRegionOpacityProgress();
        
        // When zoomed in (opacityProgress = 1.0), fade to 0% opacity
        // When in full view (opacityProgress = 0.0), use normal opacity
        if (index === activeRegionIndex) {
            // Active region: fade from 15% → 0% when zooming in
            const fillOpacity = 0.15 * (1 - opacityProgress);
            ctx.fillStyle = `rgba(68, 136, 255, ${fillOpacity})`;
            
            // Stroke: fade from 30% → 0%
            const strokeOpacity = 0.3 * (1 - opacityProgress);
            ctx.strokeStyle = `rgba(68, 136, 255, ${strokeOpacity})`;
        } else {
            // Inactive region: fade from 8% → 0% when zooming in
            const inactiveFillOpacity = 0.08 * (1 - opacityProgress);
            ctx.fillStyle = `rgba(68, 136, 255, ${inactiveFillOpacity})`;
            
            // Stroke: fade from 20% → 0%
            const strokeOpacity = 0.2 * (1 - opacityProgress);
            ctx.strokeStyle = `rgba(68, 136, 255, ${strokeOpacity})`;
        }
        
        // Skip drawing if opacity is effectively 0 (avoid unnecessary drawing)
        const currentFillOpacity = index === activeRegionIndex ? 0.15 * (1 - opacityProgress) : 0.08 * (1 - opacityProgress);
        if (currentFillOpacity < 0.01) {
            return; // Too faint to see, skip drawing
        }
        
        // Draw full-height rectangle
        ctx.fillRect(startX, 0, highlightWidth, canvasHeight);
        
        // Thinner borders (1px instead of 2px)
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(startX, 0);
        ctx.lineTo(startX, canvasHeight);
        ctx.moveTo(endX, 0);
        ctx.lineTo(endX, canvasHeight);
        ctx.stroke();
    });
}

/**
 * Draw selection box on spectrogram canvas (lightweight version)
 */
export function drawSpectrogramSelection(ctx, canvasWidth, canvasHeight) {
    // Only draw if NOT playing an active region (same logic as waveform)
    if (State.selectionStart === null || State.selectionEnd === null || isPlayingActiveRegion()) {
        return;
    }
    
    // Use zoom-aware conversion
    let startX, endX;
    if (zoomState.isInitialized()) {
        const startSample = zoomState.timeToSample(State.selectionStart);
        const endSample = zoomState.timeToSample(State.selectionEnd);
        startX = zoomState.sampleToPixel(startSample, canvasWidth);
        endX = zoomState.sampleToPixel(endSample, canvasWidth);
    } else {
        const startProgress = State.selectionStart / State.totalAudioDuration;
        const endProgress = State.selectionEnd / State.totalAudioDuration;
        startX = startProgress * canvasWidth;
        endX = endProgress * canvasWidth;
    }
    
    const selectionWidth = endX - startX;
    
    // Lighter yellow (8% fill, 35% stroke)
    ctx.fillStyle = 'rgba(255, 255, 0, 0.08)';
    ctx.fillRect(startX, 0, selectionWidth, canvasHeight);
    
    ctx.strokeStyle = 'rgba(255, 200, 0, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(startX, 0);
    ctx.lineTo(startX, canvasHeight);
    ctx.moveTo(endX, 0);
    ctx.lineTo(endX, canvasHeight);
    ctx.stroke();
}

/**
 * Calculate button positions for a region (helper function used by both rendering and click detection)
 * Returns { zoomButton: {x, y, width, height}, playButton: {x, y, width, height}, labelX, labelY } or null if off-screen
 */
function calculateButtonPositions(region, index, canvasWidth, canvasHeight) {
    if (!State.dataStartTime || !State.dataEndTime || !State.totalAudioDuration) {
        return null;
    }
    
    // Calculate region position (same logic as drawRegionHighlights)
    const dataStartMs = State.dataStartTime.getTime();
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
    
    // Calculate pixel positions (same logic as drawRegionHighlights)
    let startX, endX;
    if (zoomState.isInitialized()) {
        const interpolatedRange = getInterpolatedTimeRange();
        const regionStartTimestamp = zoomState.sampleToRealTimestamp(region.startSample !== undefined ? region.startSample : zoomState.timeToSample(regionStartSeconds));
        const regionEndTimestamp = zoomState.sampleToRealTimestamp(region.endSample !== undefined ? region.endSample : zoomState.timeToSample(regionEndSeconds));
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
            const regionStartTimestamp = zoomState.sampleToRealTimestamp(region.startSample !== undefined ? region.startSample : zoomState.timeToSample(regionStartSeconds));
            const regionEndTimestamp = zoomState.sampleToRealTimestamp(region.endSample !== undefined ? region.endSample : zoomState.timeToSample(regionEndSeconds));
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
    
    // Calculate button sizes (same logic as drawRegionHighlights)
    const referenceCanvasWidth = 1200;
    const scaleFactor = Math.max(0.5, Math.min(1.5, canvasWidth / referenceCanvasWidth));
    const baseButtonWidth = 21;
    const baseButtonHeight = 15;
    const buttonWidth = Math.round(baseButtonWidth * scaleFactor);
    const buttonHeight = Math.round(baseButtonHeight * scaleFactor);
    const buttonPadding = Math.round(4 * scaleFactor);
    const numberTextSize = Math.round(20 * scaleFactor);
    const numberTextHeight = numberTextSize;
    const numberTextWidth = Math.round(18 * scaleFactor);
    
    // Check if on screen
    const totalButtonAreaWidth = numberTextWidth + buttonWidth + buttonPadding + buttonWidth + buttonPadding;
    const isOnScreen = labelX + totalButtonAreaWidth > 0 && labelX < canvasWidth;
    
    if (!isOnScreen) {
        return null;
    }
    
    // Calculate button positions
    const zoomButtonX = labelX + numberTextWidth;
    const buttonY = labelY + (numberTextHeight - buttonHeight) / 2;
    const playButtonX = zoomButtonX + buttonWidth + buttonPadding;
    
    return {
        zoomButton: {
            x: zoomButtonX,
            y: buttonY,
            width: buttonWidth,
            height: buttonHeight
        },
        playButton: {
            x: playButtonX,
            y: buttonY,
            width: buttonWidth,
            height: buttonHeight
        },
        labelX,
        labelY
    };
}

/**
 * Check if click is on a canvas zoom button
 * x, y are in CSS pixels (from event coordinates)
 * canvasWidth, canvasHeight are in device pixels (from canvas.width/height)
 * Returns region index if clicked, null otherwise
 * 
 * Uses button positions stored during drawRegionHighlights() rendering
 */
export function checkCanvasZoomButtonClick(x, y, canvasWidth, canvasHeight) {
    // Convert CSS pixel coordinates to device pixel coordinates
    // Button positions are stored in device pixel coordinates (same as canvas.width/height)
    const dpr = window.devicePixelRatio || 1;
    const scaledX = x * dpr;
    const scaledY = y * dpr;
    
    // Use positions stored during rendering - no recalculation needed!
    // drawRegionHighlights() already updates these on every render
    for (const [regionId, button] of canvasZoomButtonPositions.entries()) {
        if (scaledX >= button.x && scaledX <= button.x + button.width &&
            scaledY >= button.y && scaledY <= button.y + button.height) {
            return button.regionIndex;
        }
    }
    return null;
}

/**
 * Check if click is on a canvas play button
 * x, y are in CSS pixels (from event coordinates)
 * canvasWidth, canvasHeight are in device pixels (from canvas.width/height)
 * Returns region index if clicked, null otherwise
 * 
 * Uses button positions stored during drawRegionHighlights() rendering
 */
export function checkCanvasPlayButtonClick(x, y, canvasWidth, canvasHeight) {
    // Convert CSS pixel coordinates to device pixel coordinates
    // Button positions are stored in device pixel coordinates (same as canvas.width/height)
    const dpr = window.devicePixelRatio || 1;
    const scaledX = x * dpr;
    const scaledY = y * dpr;
    
    // Use positions stored during rendering - no recalculation needed!
    // drawRegionHighlights() already updates these on every render
    for (const [regionId, button] of canvasPlayButtonPositions.entries()) {
        if (scaledX >= button.x && scaledX <= button.x + button.width &&
            scaledY >= button.y && scaledY <= button.y + button.height) {
            return button.regionIndex;
        }
    }
    return null;
}

/**
 * Handle waveform click for region selection
 * Returns true if handled, false to allow normal waveform interaction
 */
export function handleWaveformClick(event, canvas) {
    // For now, don't intercept - let normal waveform interaction work
    // We'll add region selection via a separate mode or button later
    return false;
}

/**
 * Start frequency selection mode for a specific feature
 */
export function startFrequencySelection(regionIndex, featureIndex) {
    console.log(`🎯 Starting frequency selection for region ${regionIndex}, feature ${featureIndex}`);
    
    isSelectingFrequency = true;
    currentFrequencySelection = { regionIndex, featureIndex };
    
    // Update button state
    const button = document.getElementById(`select-btn-${regionIndex}-${featureIndex}`);
    if (button) {
        button.classList.add('active');
        button.classList.remove('pulse', 'completed');
    }
    
    // Enable selection cursor on spectrogram
    const canvas = document.getElementById('spectrogram');
    if (canvas) {
        canvas.classList.add('selecting');
        canvas.style.cursor = 'crosshair';
    }
}

/**
 * Handle spectrogram frequency selection
 * Called when user completes a box selection on spectrogram
 */
export function handleSpectrogramSelection(startY, endY, canvasHeight, startX, endX, canvasWidth) {
    if (!isSelectingFrequency || !currentFrequencySelection) {
        return;
    }
    
    const { regionIndex, featureIndex } = currentFrequencySelection;
    
    // Convert Y positions to frequencies
    const lowFreq = getFrequencyFromY(Math.max(startY, endY), maxFrequency, canvasHeight, State.frequencyScale);
    const highFreq = getFrequencyFromY(Math.min(startY, endY), maxFrequency, canvasHeight, State.frequencyScale);
    
    // Convert X positions to timestamps
    let startTime = null;
    let endTime = null;
    
    if (startX !== null && endX !== null && State.dataStartTime && State.dataEndTime) {
        // 🏛️ Use zoom-aware conversion
        if (zoomState.isInitialized()) {
            const startSample = zoomState.pixelToSample(startX, canvasWidth);
            const endSample = zoomState.pixelToSample(endX, canvasWidth);
            const startTimestamp = zoomState.sampleToRealTimestamp(startSample);
            const endTimestamp = zoomState.sampleToRealTimestamp(endSample);
            
            if (startTimestamp && endTimestamp) {
                // Ensure start is before end
                const actualStartMs = Math.min(startTimestamp.getTime(), endTimestamp.getTime());
                const actualEndMs = Math.max(startTimestamp.getTime(), endTimestamp.getTime());
                
                startTime = new Date(actualStartMs).toISOString();
                endTime = new Date(actualEndMs).toISOString();
            }
        } else {
            // Fallback to old behavior if zoom state not initialized
            const dataStartMs = State.dataStartTime.getTime();
            const dataEndMs = State.dataEndTime.getTime();
            const totalDurationMs = dataEndMs - dataStartMs;
            
            // Convert pixel positions to progress (0-1)
            const startProgress = Math.max(0, Math.min(1, startX / canvasWidth));
            const endProgress = Math.max(0, Math.min(1, endX / canvasWidth));
            
            // Convert progress to timestamps
            const startTimeMs = dataStartMs + (startProgress * totalDurationMs);
            const endTimeMs = dataEndMs + (endProgress * totalDurationMs);
            
            // Ensure start is before end
            const actualStartMs = Math.min(startTimeMs, endTimeMs);
            const actualEndMs = Math.max(startTimeMs, endTimeMs);
            
            startTime = new Date(actualStartMs).toISOString();
            endTime = new Date(actualEndMs).toISOString();
        }
    }
    
    // Update feature data
    const regions = getCurrentRegions();
    if (regions[regionIndex] && regions[regionIndex].features[featureIndex]) {
        regions[regionIndex].features[featureIndex].lowFreq = lowFreq.toFixed(2);
        regions[regionIndex].features[featureIndex].highFreq = highFreq.toFixed(2);
        
        if (startTime && endTime) {
            regions[regionIndex].features[featureIndex].startTime = startTime;
            regions[regionIndex].features[featureIndex].endTime = endTime;
        }
        
        setCurrentRegions(regions);
        
        // Re-render the feature
        renderFeatures(regions[regionIndex].id, regionIndex);
        
        // Pulse the button and focus notes field
        setTimeout(() => {
            const selectBtn = document.getElementById(`select-btn-${regionIndex}-${featureIndex}`);
            const notesField = document.getElementById(`notes-${regionIndex}-${featureIndex}`);
            
            if (selectBtn) {
                selectBtn.classList.remove('active', 'pulse');
                selectBtn.classList.add('completed', 'pulse');
                setTimeout(() => selectBtn.classList.remove('pulse'), 250);
            }
            
            if (notesField) {
                setTimeout(() => {
                    notesField.classList.add('pulse');
                    notesField.focus();
                    setTimeout(() => notesField.classList.remove('pulse'), 800);
                }, 150);
            }
        }, 50);
    }
    
    // Clear selection state
    isSelectingFrequency = false;
    currentFrequencySelection = null;
    spectrogramStartX = null;
    spectrogramEndX = null;
    
    const canvas = document.getElementById('spectrogram');
    if (canvas) {
        canvas.classList.remove('selecting');
        canvas.style.cursor = '';
    }
}

/**
 * Convert Y position to frequency based on scale type
 */
function getFrequencyFromY(y, maxFreq, canvasHeight, scaleType) {
    const normalizedY = (canvasHeight - y) / canvasHeight;
    
    if (scaleType === 'logarithmic') {
        const minFreq = 0.1;
        const logMin = Math.log10(minFreq);
        const logMax = Math.log10(maxFreq);
        const logFreq = logMin + (normalizedY * (logMax - logMin));
        return Math.pow(10, logFreq);
    } else if (scaleType === 'sqrt') {
        const normalized = normalizedY * normalizedY;
        return normalized * maxFreq;
    } else {
        return normalizedY * maxFreq;
    }
}

/**
 * Format time for display (HH:MM format)
 */
function formatTime(isoString) {
    const date = new Date(isoString);
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

/**
 * Format time for display with seconds (H:MM:SS format, no leading zero on hours if < 10)
 */
function formatTimeWithSeconds(isoString) {
    const date = new Date(isoString);
    const hours = date.getUTCHours(); // No padding - single digit for 0-9
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    const seconds = String(date.getUTCSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

/**
 * Format feature button text: "HH:MM:SS - HH:MM:SS • X.X - X.X Hz"
 */
function formatFeatureButtonText(feature) {
    if (!feature.startTime || !feature.endTime || !feature.lowFreq || !feature.highFreq) {
        return 'Select feature';
    }
    
    const startTimeStr = formatTimeWithSeconds(feature.startTime);
    const endTimeStr = formatTimeWithSeconds(feature.endTime);
    const freqStr = `${parseFloat(feature.lowFreq).toFixed(1)} - ${parseFloat(feature.highFreq).toFixed(1)} Hz`;
    
    return `${startTimeStr} - ${endTimeStr}\u00A0\u00A0•\u00A0\u00A0${freqStr}`;
}

/**
 * Render all regions
 */
function renderRegions() {
    const container = document.getElementById('regionsList');
    if (!container) return;
    
    container.innerHTML = '';
    
    const regions = getCurrentRegions();
    regions.forEach((region, index) => {
        const regionCard = createRegionCard(region, index);
        container.appendChild(regionCard);
    });
    
    // Region highlights are drawn by waveform-renderer.js, no need to call here
}

/**
 * Create a region card element
 */
function createRegionCard(region, index) {
    const card = document.createElement('div');
    card.className = 'region-card';
    card.dataset.regionId = region.id;
    
    // Header bar
    const header = document.createElement('div');
    header.className = `region-header ${region.expanded ? 'expanded' : ''}`;
    header.onclick = (e) => {
        if (e.target.closest('.play-btn') || 
            e.target.closest('.zoom-btn') ||
            e.target.closest('.delete-region-btn') ||
            e.target.closest('.collapse-icon')) {
            return;
        }
        setActiveRegion(index);
    };
    
    const firstDescription = !region.expanded && region.features && region.features.length > 0 && region.features[0].notes 
        ? `<span class="region-description-preview">${region.features[0].notes}</span>` 
        : '';
    
    header.innerHTML = `
        <span class="collapse-icon" data-region-index="${index}">▼</span>
        <button class="zoom-btn" 
                data-region-index="${index}"
                title="Zoom to region">
            🔍
        </button>
        <button class="play-btn ${region.playing ? 'playing' : ''}" 
                data-region-index="${index}"
                title="Play region">
            ${region.playing ? '⏸' : '▶'}
        </button>
        <span class="region-label">Region ${index + 1}</span>
        <div class="region-summary">
            <div class="region-time-display">
                ${formatTime(region.startTime)} – ${formatTime(region.stopTime)}
                ${firstDescription}
            </div>
        </div>
        <button class="delete-region-btn" 
                data-region-index="${index}"
                title="Delete region">
            ✕
        </button>
    `;
    
    // 🧹 MEMORY LEAK FIX: Attach event listeners instead of inline onclick
    header.querySelector('.collapse-icon').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleRegion(index);
    });
    header.querySelector('.zoom-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        
        // 🏛️ Check if we're already inside THIS temple
        if (zoomState.isInRegion() && zoomState.getCurrentRegionId() === region.id) {
            // We're inside - exit the temple and return to full view
            zoomToFull();
        } else {
            // Zoom into this region
            zoomToRegion(index);
        }
        
        // Blur the button so spacebar works immediately after clicking
        e.target.blur();
    });
    header.querySelector('.play-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleRegionPlay(index);
    });
    header.querySelector('.delete-region-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteRegion(index);
    });
    
    // Details section
    const details = document.createElement('div');
    details.className = `region-details ${region.expanded ? 'expanded' : ''}`;
    
    const detailsContent = document.createElement('div');
    detailsContent.className = 'details-content';
    
    const isMaxFeatures = region.featureCount >= 10;
    detailsContent.innerHTML = `
        <div class="features-list">
            <div id="features-${region.id}" class="features-container"></div>
            <div class="add-feature-row">
                <button class="add-feature-btn" 
                        data-region-index="${index}"
                        ${isMaxFeatures ? 'disabled' : ''}
                        title="${isMaxFeatures ? 'Maximum features (10) reached' : 'Add feature'}">
                    +
                </button>
                <span class="add-feature-label ${isMaxFeatures ? 'disabled' : ''}"
                      data-region-index="${index}"
                      title="${isMaxFeatures ? 'Maximum features (10) reached' : 'Add feature'}">
                    ${isMaxFeatures ? 'Max features reached' : 'Add feature'}
                </span>
            </div>
        </div>
    `;
    
    // 🧹 MEMORY LEAK FIX: Attach event listeners for add feature buttons
    const addFeatureBtn = detailsContent.querySelector('.add-feature-btn');
    const addFeatureLabel = detailsContent.querySelector('.add-feature-label');
    if (addFeatureBtn && !isMaxFeatures) {
        addFeatureBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            addFeature(index);
            e.target.blur(); // Blur so spacebar can toggle play/pause
        });
    }
    if (addFeatureLabel && !isMaxFeatures) {
        addFeatureLabel.addEventListener('click', (e) => {
            e.stopPropagation();
            addFeature(index);
            e.target.blur(); // Blur so spacebar can toggle play/pause
        });
    }
    
    details.appendChild(detailsContent);
    card.appendChild(header);
    card.appendChild(details);
    
    // Render features after card is added to DOM
    setTimeout(() => {
        renderFeatures(region.id, index);
        
        if (region.expanded && details) {
            details.style.transition = 'none';
            details.style.maxHeight = details.scrollHeight + 'px';
            requestAnimationFrame(() => {
                // 🔥 FIX: Check document connection before DOM manipulation
                if (!document.body || !document.body.isConnected) {
                    return;
                }
                details.style.transition = '';
            });
        }
    }, 0);
    
    return card;
}

/**
 * Render features for a region
 */
function renderFeatures(regionId, regionIndex) {
    const container = document.getElementById(`features-${regionId}`);
    if (!container) return;
    
    const regions = getCurrentRegions();
    const region = regions[regionIndex];
    
    // Ensure featureCount matches features array length
    while (region.features.length < region.featureCount) {
        region.features.push({
            type: 'Impulsive',
            repetition: 'Unique',
            lowFreq: '',
            highFreq: '',
            startTime: '',
            endTime: '',
            notes: ''
        });
    }
    
    if (region.features.length > region.featureCount) {
        region.features = region.features.slice(0, region.featureCount);
    }
    
    container.innerHTML = '';
    
    region.features.forEach((feature, featureIndex) => {
        const featureRow = document.createElement('div');
        featureRow.className = 'feature-row';
        
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-feature-btn-inline';
        deleteBtn.textContent = '×';
        deleteBtn.title = featureIndex === 0 ? 'Cannot delete first feature' : 'Delete this feature';
        
        if (featureIndex === 0) {
            deleteBtn.classList.add('disabled');
            deleteBtn.disabled = true;
        } else {
            deleteBtn.onclick = (e) => {
                e.stopPropagation();
                deleteSpecificFeature(regionIndex, featureIndex);
            };
        }
        
        featureRow.innerHTML = `
            <span class="feature-number">Feature ${featureIndex + 1}</span>
            <select id="repetition-${regionIndex}-${featureIndex}">
                <option value="Unique" ${feature.repetition === 'Unique' || !feature.repetition ? 'selected' : ''}>Unique</option>
                <option value="Repeated" ${feature.repetition === 'Repeated' ? 'selected' : ''}>Repeated</option>
            </select>
            
            <select id="type-${regionIndex}-${featureIndex}">
                <option value="Impulsive" ${feature.type === 'Impulsive' || !feature.type ? 'selected' : ''}>Impulsive</option>
                <option value="Continuous" ${feature.type === 'Continuous' ? 'selected' : ''}>Continuous</option>
            </select>
            
            <button class="select-freq-btn ${!feature.lowFreq || !feature.highFreq || !feature.startTime || !feature.endTime ? 'pulse' : 'completed'}" 
                    id="select-btn-${regionIndex}-${featureIndex}"
                    data-region-index="${regionIndex}" data-feature-index="${featureIndex}"
                    title="${feature.lowFreq && feature.highFreq && feature.startTime && feature.endTime ? 'click to select' : ''}">
                ${feature.lowFreq && feature.highFreq && feature.startTime && feature.endTime ? 
                    formatFeatureButtonText(feature) :
                    'Select feature'
                }
            </button>
            
            <textarea class="freq-input notes-field" 
                      placeholder="Add description..." 
                      data-region-index="${regionIndex}" data-feature-index="${featureIndex}"
                      id="notes-${regionIndex}-${featureIndex}">${feature.notes || ''}</textarea>
        `;
        
        featureRow.insertBefore(deleteBtn, featureRow.firstChild);
        
        // 🧹 MEMORY LEAK FIX: Attach event listeners for feature controls
        const repetitionSelect = featureRow.querySelector(`#repetition-${regionIndex}-${featureIndex}`);
        const typeSelect = featureRow.querySelector(`#type-${regionIndex}-${featureIndex}`);
        const freqBtn = featureRow.querySelector(`#select-btn-${regionIndex}-${featureIndex}`);
        const notesField = featureRow.querySelector(`#notes-${regionIndex}-${featureIndex}`);
        
        repetitionSelect.addEventListener('change', function() {
            updateFeature(regionIndex, featureIndex, 'repetition', this.value);
            this.blur(); // Blur so spacebar can toggle play/pause
        });
        
        typeSelect.addEventListener('change', function() {
            updateFeature(regionIndex, featureIndex, 'type', this.value);
            this.blur(); // Blur so spacebar can toggle play/pause
        });
        
        freqBtn.addEventListener('click', () => {
            startFrequencySelection(regionIndex, featureIndex);
        });
        
        notesField.addEventListener('change', function() {
            updateFeature(regionIndex, featureIndex, 'notes', this.value);
        });
        
        notesField.addEventListener('keydown', function(event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                this.blur();
            }
        });
        
        container.appendChild(featureRow);
    });
}

/**
 * Toggle region expansion
 */
export function toggleRegion(index) {
    const regions = getCurrentRegions();
    const region = regions[index];
    const wasExpanded = region.expanded;
    
    const regionCard = document.querySelector(`[data-region-id="${region.id}"]`);
    const header = regionCard ? regionCard.querySelector('.region-header') : null;
    const details = regionCard ? regionCard.querySelector('.region-details') : null;
    
    if (!details || !header) return;
    
    region.expanded = !wasExpanded;
    
    if (wasExpanded) {
        header.classList.remove('expanded');
        const currentHeight = details.scrollHeight;
        details.style.maxHeight = currentHeight + 'px';
        details.style.transition = 'max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
        void details.offsetHeight;
        
        requestAnimationFrame(() => {
            // 🔥 FIX: Check document connection before DOM manipulation
            if (!document.body || !document.body.isConnected) {
                return;
            }
            details.style.maxHeight = '0px';
            setTimeout(() => {
                // 🔥 FIX: Check document connection before DOM manipulation
                if (!document.body || !document.body.isConnected) {
                    return;
                }
                details.classList.remove('expanded');
                
                // Update header to show description preview
                const timeDisplay = header.querySelector('.region-time-display');
                if (timeDisplay) {
                    const firstDescription = region.features && region.features.length > 0 && region.features[0].notes && region.features[0].notes.trim()
                        ? `<span class="region-description-preview">${region.features[0].notes}</span>` 
                        : '';
                    const timeText = `${formatTime(region.startTime)} – ${formatTime(region.stopTime)}`;
                    timeDisplay.innerHTML = timeText + firstDescription;
                }
            }, 400);
        });
    } else {
        // Remove description preview immediately when expanding
        const timeDisplay = header.querySelector('.region-time-display');
        if (timeDisplay) {
            const timeText = `${formatTime(region.startTime)} – ${formatTime(region.stopTime)}`;
            timeDisplay.innerHTML = timeText;
        }
        
        header.classList.add('expanded');
        details.classList.add('expanded');
        details.style.maxHeight = '0px';
        details.style.transition = 'none';
        void details.offsetHeight;
        
        requestAnimationFrame(() => {
            // 🔥 FIX: Check document connection before DOM manipulation
            if (!document.body || !document.body.isConnected) {
                return;
            }
            const targetHeight = details.scrollHeight;
            details.style.transition = 'max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
            details.style.maxHeight = targetHeight + 'px';
        });
    }
}

/**
 * Set selection to match active region's time range
 */
function setSelectionFromActiveRegion() {
    const regions = getCurrentRegions();
    if (activeRegionIndex === null || activeRegionIndex >= regions.length) {
        return false;
    }
    
    const region = regions[activeRegionIndex];
    if (!State.dataStartTime || !State.dataEndTime) {
        return false;
    }
    
    // 🎯 FIX: Only set selection if there isn't one already
    // If user made a selection, respect it!
    if (State.selectionStart !== null && State.selectionEnd !== null) {
        // Already have a selection - just update worklet and redraw
        updateWorkletSelection();
        drawWaveformWithSelection();
        return true;
    }
    
    // No existing selection - set it to match region bounds
    // 🏛️ Use sample indices if available (new format), otherwise fall back to timestamps (backward compatibility)
    let regionStartSeconds, regionEndSeconds;
    
    if (region.startSample !== undefined && region.endSample !== undefined) {
        // New format: convert from eternal sample indices
        regionStartSeconds = zoomState.sampleToTime(region.startSample);
        regionEndSeconds = zoomState.sampleToTime(region.endSample);
    } else {
        // Old format: convert from timestamps (backward compatibility)
        const dataStartMs = State.dataStartTime.getTime();
        const regionStartMs = new Date(region.startTime).getTime();
        const regionEndMs = new Date(region.stopTime).getTime();
        regionStartSeconds = (regionStartMs - dataStartMs) / 1000;
        regionEndSeconds = (regionEndMs - dataStartMs) / 1000;
    }
    
    // Set selection to region's time range
    State.setSelectionStart(regionStartSeconds);
    State.setSelectionEnd(regionEndSeconds);
    State.setIsLooping(false); // Ensure loop is off for region playback
    
    // Update worklet selection using the standard function
    updateWorkletSelection();
    
    // Redraw waveform to show selection
    drawWaveformWithSelection();
    
    return true;
}

/**
 * Play region from start
 * Button always shows ▶ (play icon)
 * Color changes: RED (not playing) → GREEN (currently playing)
 * Master play/pause and spacebar handle pause/resume
 */
export function toggleRegionPlay(index) {
    const regions = getCurrentRegions();
    const region = regions[index];
    
    console.log(`🎵 Region ${index + 1} play button clicked`);
    
    // Reset old playing region button (if different)
    if (activePlayingRegionIndex !== null && activePlayingRegionIndex !== index) {
        resetRegionPlayButton(activePlayingRegionIndex);
    }
    
    // Make this region active
    activePlayingRegionIndex = index;
    setActiveRegion(index);
    
    // 🦋 Clear selection when region button is clicked - region play takes priority!
    // The region button is an explicit choice to play that region, so it overrides any selection
    State.setSelectionStart(null);
    State.setSelectionEnd(null);
    
    // Update region button to GREEN (playing state)
    region.playing = true;
    const regionCard = document.querySelector(`[data-region-id="${region.id}"]`);
    const playBtn = regionCard?.querySelector('.play-btn');
    if (playBtn) {
        playBtn.classList.add('playing');
        playBtn.textContent = '▶';
        playBtn.title = 'Play region from start';
    }
    
    // 🦋 Get boundaries (getCurrentPlaybackBoundaries will return region bounds since selection is cleared)
    const b = getCurrentPlaybackBoundaries();
    
    // Update worklet with region boundaries BEFORE seeking
    updateWorkletSelection();
    
    // Seek to start and play
    seekToPosition(b.start, true);
    
    // Redraw waveform to update canvas play button colors
    drawWaveformWithSelection();
    
    console.log(`▶️ Region ${index + 1} playing from ${b.start.toFixed(2)}s`);
}

/**
 * Reset a region's play button to play state
 */
function resetRegionPlayButton(index) {
    const regions = getCurrentRegions();
    if (index === null || index >= regions.length) return;
    
    const region = regions[index];
    region.playing = false;
    
    // 🔥 FIX: Check if document.body exists (not detached) before querying DOM
    // This prevents retaining references to detached documents
    if (!document.body || !document.body.isConnected) {
        return;
    }
    
    const regionCard = document.querySelector(`[data-region-id="${region.id}"]`);
    if (regionCard && regionCard.isConnected) {
        const playBtn = regionCard.querySelector('.play-btn');
        if (playBtn) {
            playBtn.classList.remove('playing');
            playBtn.textContent = '▶';
            playBtn.title = 'Play region';
        }
    }
    
    // Redraw waveform to update canvas play button colors
    drawWaveformWithSelection();
}

/**
 * Set active region (50% opacity highlight)
 */
function setActiveRegion(index) {
    activeRegionIndex = index;
    // Trigger waveform redraw to update region highlights
    drawWaveformWithSelection();
}

/**
 * Get active region index (exported for use by other modules)
 */
export function getActiveRegionIndex() {
    return activeRegionIndex;
}

/**
 * Get active playing region index (exported for use by other modules)
 */
export function getActivePlayingRegionIndex() {
    return activePlayingRegionIndex;
}

/**
 * Update active region play button to match master playback state
 * Called from audio-player when master play/pause is clicked
 * When paused, all region play buttons toggle to their red state
 */
export function updateActiveRegionPlayButton(isPlaying) {
    if (!isPlaying) {
        // When master pause is pressed, reset all region play buttons to red state
        const regions = getCurrentRegions();
        
        // Check if document.body exists (not detached) before querying DOM
        if (!document.body || !document.body.isConnected) {
            return;
        }
        
        // Reset all region play buttons to red state
        regions.forEach((region, index) => {
            region.playing = false;
            const regionCard = document.querySelector(`[data-region-id="${region.id}"]`);
            if (regionCard && regionCard.isConnected) {
                const playBtn = regionCard.querySelector('.play-btn');
                if (playBtn) {
                    playBtn.classList.remove('playing');
                    playBtn.textContent = '▶';
                    playBtn.title = 'Play region';
                }
            }
        });
        
        // Clear the active playing region index
        activePlayingRegionIndex = null;
        
        // Redraw waveform to update canvas play button colors
        drawWaveformWithSelection();
    }
    // When playing, the active region button will be set to green by toggleRegionPlay
    // when a region is selected, so we don't need to do anything here
}

/**
 * Set selection from active region (exported for use by other modules)
 */
export function setSelectionFromActiveRegionIfExists() {
    return setSelectionFromActiveRegion();
}

/**
 * Check if we're currently playing an active region
 * Returns true if there's an active playing region
 * This prevents yellow selection box from showing during region playback
 */
export function isPlayingActiveRegion() {
    // Simply check if any region is marked as the active playing region
    return activePlayingRegionIndex !== null;
}

/**
 * Clear active playing region (called when worklet reaches selection end)
 * The worklet is the single source of truth - it tells us when boundaries are reached
 */
export function clearActivePlayingRegion() {
    if (activePlayingRegionIndex === null) {
        return;
    }
    
    const regions = getCurrentRegions();
    if (activePlayingRegionIndex < regions.length) {
        const region = regions[activePlayingRegionIndex];
        const regionTime = `${formatTime(region.startTime)} – ${formatTime(region.stopTime)}`;
        console.log(`🚪 WORKLET REACHED REGION END: Region ${activePlayingRegionIndex + 1} (${regionTime})`);
        
        resetRegionPlayButton(activePlayingRegionIndex);
    }
    
    activePlayingRegionIndex = null;
    
    // Clear selection when region playback finishes
    State.setSelectionStart(null);
    State.setSelectionEnd(null);
    updateWorkletSelection();
    
    console.log('✅ Region playback finished - reset button and cleared selection');
}

/**
 * Clear active region (all regions return to 20% opacity)
 */
export function clearActiveRegion() {
    activeRegionIndex = null;
    // Clear canvas button positions when clearing active region
    canvasZoomButtonPositions.clear();
    canvasPlayButtonPositions.clear();
    // Trigger waveform redraw to update region highlights
    drawWaveformWithSelection();
}

/**
 * Reset all region play buttons to "play" state
 * Called when user makes a new waveform selection (no longer playing within a region)
 */
export function resetAllRegionPlayButtons() {
    activePlayingRegionIndex = null; // Clear active playing region
    const regions = getCurrentRegions();
    regions.forEach((region, index) => {
        region.playing = false;
        const regionCard = document.querySelector(`[data-region-id="${region.id}"]`);
        if (regionCard) {
            const playBtn = regionCard.querySelector('.play-btn');
            if (playBtn) {
                playBtn.classList.remove('playing');
                playBtn.textContent = '▶';
                playBtn.title = 'Play region';
            }
        }
    });
}

/**
 * Add a feature to a region
 */
export function addFeature(regionIndex) {
    const regions = getCurrentRegions();
    const region = regions[regionIndex];
    const currentCount = region.featureCount;
    
    if (currentCount >= 10) {
        console.log('Maximum features (10) reached');
        return;
    }
    
    const newCount = currentCount + 1;
    const oldCount = currentCount;
    
    // Update the count
    region.featureCount = newCount;
    
    // Get the current details element and its height
    const regionCard = document.querySelector(`[data-region-id="${region.id}"]`);
    const details = regionCard ? regionCard.querySelector('.region-details') : null;
    
    // Only animate when ADDING features, not removing
    if (details && region.expanded && newCount > oldCount) {
        // Capture current height
        details.style.maxHeight = 'none';
        details.style.transition = 'none';
        const currentHeight = details.scrollHeight;
        
        // Lock at current height
        details.style.maxHeight = currentHeight + 'px';
        void details.offsetHeight;
        
        // Update the DOM
        setCurrentRegions(regions);
        renderFeatures(region.id, regionIndex);
        
        // Animate to new height
        requestAnimationFrame(() => {
            // 🔥 FIX: Check document connection before DOM manipulation
            if (!document.body || !document.body.isConnected) {
                return;
            }
            requestAnimationFrame(() => {
                // 🔥 FIX: Check document connection before DOM manipulation
                if (!document.body || !document.body.isConnected) {
                    return;
                }
                details.style.maxHeight = 'none';
                const targetHeight = details.scrollHeight;
                
                details.style.maxHeight = currentHeight + 'px';
                void details.offsetHeight;
                
                details.style.transition = 'max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
                details.style.maxHeight = targetHeight + 'px';
            });
        });
        
        // Auto-enter selection mode for the newly added feature
        setTimeout(() => {
            startFrequencySelection(regionIndex, newCount - 1);
        }, 100);
    } else {
        // Just update instantly (when collapsed)
        renderFeatures(region.id, regionIndex);
    }
}

/**
 * Delete a specific feature
 */
function deleteSpecificFeature(regionIndex, featureIndex) {
    const regions = getCurrentRegions();
    const region = regions[regionIndex];
    
    if (region.featureCount <= 1 || featureIndex === 0) {
        console.log('Cannot delete - minimum 1 feature required or attempting to delete first feature');
        return;
    }
    
    region.features.splice(featureIndex, 1);
    region.featureCount = region.features.length;
    
    setCurrentRegions(regions);
    renderFeatures(region.id, regionIndex);
}

/**
 * Update feature property
 */
export function updateFeature(regionIndex, featureIndex, property, value) {
    setActiveRegion(regionIndex);
    const regions = getCurrentRegions();
    if (!regions[regionIndex].features[featureIndex]) {
        regions[regionIndex].features[featureIndex] = {};
    }
    regions[regionIndex].features[featureIndex][property] = value;
    setCurrentRegions(regions);
    
    // If notes were updated and region is collapsed, update header preview
    if (property === 'notes' && featureIndex === 0 && !regions[regionIndex].expanded) {
        const region = regions[regionIndex];
        const regionCard = document.querySelector(`[data-region-id="${region.id}"]`);
        if (regionCard) {
            const header = regionCard.querySelector('.region-header');
            const timeDisplay = header ? header.querySelector('.region-time-display') : null;
            if (timeDisplay) {
                const firstDescription = value && value.trim()
                    ? `<span class="region-description-preview">${value}</span>` 
                    : '';
                const timeText = `${formatTime(region.startTime)} – ${formatTime(region.stopTime)}`;
                timeDisplay.innerHTML = timeText + firstDescription;
            }
        }
    }
}

/**
 * Delete a region
 */
export function deleteRegion(index) {
    if (confirm('Delete this region?')) {
        const regions = getCurrentRegions();
        const deletedRegion = regions[index];
        
        // Remove button position for deleted region (before deleting from array)
        if (deletedRegion) {
            canvasZoomButtonPositions.delete(deletedRegion.id);
            canvasPlayButtonPositions.delete(deletedRegion.id);
        }
        
        regions.splice(index, 1);
        setCurrentRegions(regions);
        if (activeRegionIndex === index) {
            activeRegionIndex = null;
        } else if (activeRegionIndex > index) {
            activeRegionIndex--;
        }
        renderRegions();
        
        // Redraw waveform to update button positions
        drawWaveformWithSelection();
    }
}

/**
 * Create a test region (for development/testing)
 */
export function createTestRegion() {
    if (!State.dataStartTime || !State.dataEndTime) {
        console.log('No data loaded - cannot create test region');
        return;
    }
    
    // 🏛️ Check if zoom state is initialized
    if (!zoomState.isInitialized()) {
        console.log('Zoom state not initialized - cannot create test region');
        return;
    }
    
    // Create a region in the middle 10% of the data
    const totalDuration = State.totalAudioDuration;
    const startSeconds = totalDuration * 0.45;
    const endSeconds = totalDuration * 0.55;
    
    // 🏛️ Convert to sample indices
    const startSample = zoomState.timeToSample(startSeconds);
    const endSample = zoomState.timeToSample(endSeconds);
    
    // Convert to timestamps
    const startTimestamp = zoomState.sampleToRealTimestamp(startSample);
    const endTimestamp = zoomState.sampleToRealTimestamp(endSample);
    
    const regions = getCurrentRegions();
    const newRegion = {
        id: regions.length > 0 ? Math.max(...regions.map(r => r.id)) + 1 : 1,
        
        // 🏛️ Sacred walls (STORED as absolute sample indices)
        startSample: startSample,
        endSample: endSample,
        
        // 📅 Display timestamps (DERIVED)
        startTime: startTimestamp ? startTimestamp.toISOString() : null,
        stopTime: endTimestamp ? endTimestamp.toISOString() : null,
        
        featureCount: 1,
        features: [{
            type: 'Impulsive',
            repetition: 'Unique',
            lowFreq: '',
            highFreq: '',
            startTime: '',
            endTime: '',
            notes: ''
        }],
        expanded: true,
        playing: false
    };
    
    regions.push(newRegion);
    setCurrentRegions(regions);
    renderRegions();
    setActiveRegion(regions.length - 1);
    
    console.log('✅ Test region created');
}

/**
 * Zoom into a region (the introspective lens!)
 * Makes the region fill the entire waveform/spectrogram view
 */
export function zoomToRegion(regionIndex) {
    const regions = getCurrentRegions();
    const region = regions[regionIndex];
    if (!region) {
        console.warn('⚠️ Cannot zoom: region not found');
        return;
    }
    
    // 🏛️ Check if zoom state is initialized
    if (!zoomState.isInitialized()) {
        console.warn('⚠️ Cannot zoom: zoom state not initialized');
        return;
    }
    
    // 🏛️ Handle backward compatibility: if region doesn't have sample indices, we can't zoom
    if (region.startSample === undefined || region.endSample === undefined) {
        console.warn('⚠️ Cannot zoom: region missing sample indices (old format). Please recreate this region.');
        return;
    }
    
    console.log(`🔍 Zooming into region ${regionIndex + 1} (samples ${region.startSample.toLocaleString()}-${region.endSample.toLocaleString()})`);
    
    // Store old time range for smooth interpolation
    let oldStartTime, oldEndTime;
    if (zoomState.isInRegion()) {
        const oldRange = zoomState.getRegionRange();
        oldStartTime = zoomState.sampleToRealTimestamp(oldRange.startSample);
        oldEndTime = zoomState.sampleToRealTimestamp(oldRange.endSample);
    } else {
        // Coming from full view - elastic friend is ready!
        oldStartTime = State.dataStartTime;
        oldEndTime = State.dataEndTime;
    }
    
    hideAddRegionButton();
    
    // Reset old region button if needed
    if (zoomState.isInRegion() && zoomState.getCurrentRegionId() !== region.id) {
        const oldRegionId = zoomState.getCurrentRegionId();
        const oldRegionCard = oldRegionId ? document.querySelector(`[data-region-id="${oldRegionId}"]`) : null;
        if (oldRegionCard) {
            const oldZoomBtn = oldRegionCard.querySelector('.zoom-btn');
            if (oldZoomBtn) {
                oldZoomBtn.textContent = '🔍';
                oldZoomBtn.title = 'Zoom to region';
                oldZoomBtn.classList.remove('return-mode');
            }
        }
    }
    
    // 💾 Cache full waveform BEFORE zooming in (like spectrogram's elastic friend)
    // This allows us to crossfade back to it when zooming out
    if (!zoomState.isInRegion() && State.cachedWaveformCanvas) {
        // Coming from full view - cache the full waveform canvas
        const cachedCopy = document.createElement('canvas');
        cachedCopy.width = State.cachedWaveformCanvas.width;
        cachedCopy.height = State.cachedWaveformCanvas.height;
        cachedCopy.getContext('2d').drawImage(State.cachedWaveformCanvas, 0, 0);
        State.setCachedFullWaveformCanvas(cachedCopy);
        console.log('💾 Cached full waveform canvas before zooming in');
    }
    
    // Enter the temple
    zoomState.mode = 'region';
    zoomState.currentViewStartSample = region.startSample;
    zoomState.currentViewEndSample = region.endSample;
    zoomState.activeRegionId = region.id;
    
    // Immediately redraw regions at new positions
    drawWaveformWithSelection();
    
    const regionStartSeconds = zoomState.sampleToTime(region.startSample);
    const regionEndSeconds = zoomState.sampleToTime(region.endSample);
    
    State.setSelectionStart(null);
    State.setSelectionEnd(null);
    updateWorkletSelection();
    
    setActiveRegion(regionIndex);
    
    const newStartTime = zoomState.sampleToRealTimestamp(region.startSample);
    const newEndTime = zoomState.sampleToRealTimestamp(region.endSample);
    
    // 🔍 Diagnostic: Track region zoom start
    console.log('🔍 REGION ZOOM IN starting:', {
        startTime: regionStartSeconds,
        endTime: regionEndSeconds,
        startSample: region.startSample,
        endSample: region.endSample
    });
    
    // 🔬 START HIGH-RES RENDER IN BACKGROUND (don't wait!)
    console.log('🔬 Starting high-res render in background...');
    const renderPromise = renderCompleteSpectrogramForRegion(
        regionStartSeconds, 
        regionEndSeconds,
        true  // renderInBackground = true
    );
    
    // 🎬 Animate with elastic friend - no waiting!
    animateZoomTransition(oldStartTime, oldEndTime, true).then(() => {
        console.log('🎬 Zoom animation complete');
        
        // Rebuild waveform (fast)
        drawWaveform();
        
        // Wait for high-res spectrogram if needed, then crossfade
        renderPromise.then(() => {
            console.log('🔬 High-res ready - updating viewport');
            const playbackRate = State.currentPlaybackRate || 1.0;
            updateSpectrogramViewport(playbackRate);
            
            // 🔍 Diagnostic: Track region zoom complete
            console.log('✅ REGION ZOOM IN complete');
            // Note: logInfiniteCanvasState would need to be imported/accessible here
        });
    });
    
    // Update zoom button for THIS region
    const regionCard = document.querySelector(`[data-region-id="${region.id}"]`);
    if (regionCard) {
        const zoomBtn = regionCard.querySelector('.zoom-btn');
        if (zoomBtn) {
            zoomBtn.textContent = '↩️';
            zoomBtn.title = 'Return to full view';
            zoomBtn.classList.add('return-mode'); // Add class for orange styling
        }
    }
    
    console.log(`🔍 Temple boundaries set: ${regionStartSeconds.toFixed(2)}s - ${regionEndSeconds.toFixed(2)}s`);
    console.log(`🚩 Flag raised - respecting temple walls`);
    console.log(`🔍 Zoomed to ${zoomState.getZoomLevel().toFixed(1)}x - the introspective lens is open! 🦋`);
    console.log(`🔄 ZOOM MODE TOGGLE: full view → temple mode (region ${regionIndex + 1})`);
    console.log(`🏛️ Entering the temple - sacred walls at ${regionStartSeconds.toFixed(2)}s - ${regionEndSeconds.toFixed(2)}s`);
}

/**
 * Zoom back out to full view
 */
export function zoomToFull() {
    if (!zoomState.isInitialized()) {
        return;
    }
    
    console.log('🌍 Zooming to full view');
    console.log('🔙 ZOOMING OUT TO FULL VIEW starting');
    
    // 🏛️ Store old time range for smooth tick interpolation
    let oldStartTime, oldEndTime;
    if (zoomState.isInRegion()) {
        const oldRange = zoomState.getRegionRange();
        oldStartTime = zoomState.sampleToRealTimestamp(oldRange.startSample);
        oldEndTime = zoomState.sampleToRealTimestamp(oldRange.endSample);
    } else {
        // Already in full view, no transition needed
        oldStartTime = State.dataStartTime;
        oldEndTime = State.dataEndTime;
    }
    
    // 🦋 Clear selection, but preserve active playing region if it exists
    // If we're playing a region, we should keep playing it even after zooming out
    State.setSelectionStart(null);
    State.setSelectionEnd(null);
    
    // 🦋 If we were in temple mode, preserve the region playback
    // This ensures boundaries persist after zooming out
    const wasInTemple = zoomState.isInRegion();
    const templeRegionId = wasInTemple ? zoomState.getCurrentRegionId() : null;
    
    // 💾 Cache the zoomed spectrogram BEFORE resetting (so we can crossfade it)
    cacheZoomedSpectrogram();
    
    // 🏛️ Exit the temple - return to full view
    zoomState.mode = 'full';
    zoomState.currentViewStartSample = 0;
    zoomState.currentViewEndSample = zoomState.totalSamples;
    zoomState.activeRegionId = null;
    
    // 🦋 If we were in temple mode and not already playing a specific region,
    // set activePlayingRegionIndex to preserve boundaries after zoom out
    if (wasInTemple && templeRegionId !== null && activePlayingRegionIndex === null) {
        const regions = getCurrentRegions();
        const matchingRegionIndex = regions.findIndex(r => r.id === templeRegionId);
        if (matchingRegionIndex !== -1) {
            // Set active playing region so boundaries persist after zoom out
            activePlayingRegionIndex = matchingRegionIndex;
            const region = regions[matchingRegionIndex];
            region.playing = true;
            
            // Update region button to GREEN
            const regionCard = document.querySelector(`[data-region-id="${region.id}"]`);
            const playBtn = regionCard?.querySelector('.play-btn');
            if (playBtn) {
                playBtn.classList.add('playing');
                playBtn.textContent = '▶';
            }
            
            console.log(`🦋 Preserving region ${matchingRegionIndex + 1} playback after zoom out`);
        }
    }
    
    // 🦋 Update worklet boundaries AFTER exiting temple
    // If activePlayingRegionIndex is set, boundaries will still be the region
    // Otherwise, boundaries will be full audio
    updateWorkletSelection();
    
    // 🔧 FIX: Only reset spectrogram state (clears infinite canvas)
    // DON'T clear the elastic friend - we need it for the transition!
    resetSpectrogramState();

    // 💾 Restore cached full waveform immediately (like spectrogram's elastic friend)
    // This allows drawInterpolatedWaveform() to stretch it during the transition
    if (State.cachedFullWaveformCanvas) {
        // Restore cached full waveform to State.cachedWaveformCanvas
        // drawInterpolatedWaveform() will use this and stretch it during animation
        State.setCachedWaveformCanvas(State.cachedFullWaveformCanvas);
        console.log('💾 Restored cached full waveform - ready for interpolation');
    } else {
        // No cached full waveform - rebuild it (fallback)
        console.log('⚠️ No cached full waveform - rebuilding');
        drawWaveform();
    }

    // 🏛️ Animate x-axis tick interpolation (smooth transition back to full view)
    // 🎬 Wait for animation to complete, THEN rebuild infinite canvas for full view
    animateZoomTransition(oldStartTime, oldEndTime, false).then(() => {
        console.log('🎬 Zoom-out animation complete - restoring full view');
        
        // Rebuild waveform to ensure it's up to date (if we used cached version)
        if (State.cachedFullWaveformCanvas) {
            drawWaveform();
        }
        
        // 🔧 FIX: Restore infinite canvas from elastic friend WITHOUT re-rendering spectrogram!
        // The elastic friend already has the full-view spectrogram at neutral resolution
        // We just need to recreate the infinite canvas from it
        restoreInfiniteCanvasFromCache();
        
        // Update viewport with current playback rate
        const playbackRate = State.currentPlaybackRate || 1.0;
        updateSpectrogramViewport(playbackRate);
        
        // Clear cached spectrograms after transition (no longer needed)
        clearCachedFullSpectrogram();
        clearCachedZoomedSpectrogram();
        
        // Clear cached full waveform after transition (no longer needed)
        State.setCachedFullWaveformCanvas(null);
        
        // 🔍 Diagnostic: Track zoom out complete
        console.log('✅ ZOOM OUT complete');
    });

    // Update ALL zoom buttons back to 🔍
    const regions = getCurrentRegions();
    regions.forEach(region => {
        const regionCard = document.querySelector(`[data-region-id="${region.id}"]`);
        if (regionCard) {
            const zoomBtn = regionCard.querySelector('.zoom-btn');
            if (zoomBtn) {
                zoomBtn.textContent = '🔍';
                zoomBtn.title = 'Zoom to region';
                zoomBtn.classList.remove('return-mode'); // Remove orange styling
            }
        }
    });
    
    console.log('🌍 Returned to full view - flag lowered, free roaming restored! 🏛️');
    console.log(`🔄 ZOOM MODE TOGGLE: temple mode → full view`);
    console.log(`🏛️ Exiting the temple - returning to full view`);
}

// Export state getters for external access
export function getRegions() {
    return getCurrentRegions();
}

export function isInFrequencySelectionMode() {
    return isSelectingFrequency;
}

