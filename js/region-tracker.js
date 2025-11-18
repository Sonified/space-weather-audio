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
import { renderCompleteSpectrogramForRegion, renderCompleteSpectrogram, resetSpectrogramState, cacheFullSpectrogram, clearCachedFullSpectrogram, cacheZoomedSpectrogram, clearCachedZoomedSpectrogram, updateSpectrogramViewport, restoreInfiniteCanvasFromCache, cancelActiveRender, shouldCancelActiveRender } from './spectrogram-complete-renderer.js';
import { animateZoomTransition, getInterpolatedTimeRange, getRegionOpacityProgress, isZoomTransitionInProgress, getZoomTransitionProgress, getOldTimeRange } from './waveform-x-axis-renderer.js';
import { initButtonsRenderer } from './waveform-buttons-renderer.js';
import { addFeatureBox, removeFeatureBox, updateAllFeatureBoxPositions } from './spectrogram-feature-boxes.js';
import { cancelSpectrogramSelection } from './spectrogram-renderer.js';
import { isTutorialActive, getTutorialPhase } from './tutorial-state.js';
import { isStudyMode, isTestStudyEndMode } from './master-modes.js';
import { hasSeenTutorial } from './study-workflow.js';

// Region data structure - stored per volcano
// Map<volcanoName, regions[]>
let regionsByVolcano = new Map();
let currentVolcano = null;
let activeRegionIndex = null;
let activePlayingRegionIndex = null; // Track which region is currently playing (if any)

// localStorage key prefix for feature persistence
const STORAGE_KEY_PREFIX = 'volcano_audio_regions_';

// Button positions are recalculated on every click - no caching needed
// This ensures positions are always fresh and immune to resize timing, DPR changes, etc.

/**
 * Get the current volcano from the UI
 */
function getCurrentVolcano() {
    const volcanoSelect = document.getElementById('volcano');
    return volcanoSelect ? volcanoSelect.value : null;
}

/**
 * Get the current playback speed factor (base speed, not multiplied)
 * This is the speed the user sees on the slider (e.g., 1.0x, 2.5x, etc.)
 * Returns null if speed cannot be determined
 */
function getCurrentSpeedFactor() {
    try {
        const speedSlider = document.getElementById('playbackSpeed');
        if (speedSlider) {
            const value = parseFloat(speedSlider.value);
            // Same calculation as updatePlaybackSpeed() in audio-player.js
            // Logarithmic mapping: 0-1000 -> 0.1-15, with 667 = 1.0
            if (value <= 667) {
                const normalized = value / 667;
                return 0.1 * Math.pow(10, normalized);
            } else {
                const normalized = (value - 667) / 333;
                return Math.pow(15, normalized);
            }
        }
    } catch (error) {
        console.warn('Could not get speed factor:', error);
    }
    return null;
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
 * Save regions to localStorage (persists across page reloads)
 */
function saveRegionsToStorage(volcano, regions) {
    if (!volcano) return;
    
    try {
        const storageKey = STORAGE_KEY_PREFIX + volcano;
        // Save regions with all data including notes
        const dataToSave = {
            volcano: volcano,
            regions: regions,
            savedAt: new Date().toISOString()
        };
        localStorage.setItem(storageKey, JSON.stringify(dataToSave));
        console.log(`💾 Saved ${regions.length} regions for ${volcano} to localStorage`);
    } catch (error) {
        console.error('❌ Failed to save regions to localStorage:', error);
        // localStorage might be full or disabled - continue without persistence
    }
}

/**
 * Load regions from localStorage (restores after page reload)
 */
function loadRegionsFromStorage(volcano) {
    if (!volcano) return null;
    
    try {
        const storageKey = STORAGE_KEY_PREFIX + volcano;
        const stored = localStorage.getItem(storageKey);
        
        if (!stored) {
            return null;
        }
        
        const data = JSON.parse(stored);
        if (data && data.regions && Array.isArray(data.regions)) {
            console.log(`📂 Loaded ${data.regions.length} regions for ${volcano} from localStorage`);
            return data.regions;
        }
    } catch (error) {
        console.error('❌ Failed to load regions from localStorage:', error);
    }
    
    return null;
}

/**
 * Set regions for the current volcano
 * Uses currentVolcano if set, otherwise reads from UI
 * Also saves to localStorage for persistence
 */
function setCurrentRegions(newRegions) {
    // Use currentVolcano if available (more reliable during volcano switches)
    // Otherwise fall back to reading from UI
    const volcano = currentVolcano || getCurrentVolcano();
    if (!volcano) {
        return;
    }
    regionsByVolcano.set(volcano, newRegions);
    
    // ✅ Save to localStorage for persistence (includes notes!)
    saveRegionsToStorage(volcano, newRegions);
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
    
    // Clear selection state when switching volcanoes (selections should NOT persist)
    // Only regions are saved per volcano, not selections
    State.setSelectionStart(null);
    State.setSelectionEnd(null);
    State.setSelectionStartX(null);
    State.setIsSelecting(false);
    hideAddRegionButton();
    updateWorkletSelection(); // Clear selection in worklet
    
    // Update current volcano
    currentVolcano = newVolcano;
    
    // ✅ Load regions from localStorage if available, otherwise initialize empty array
    if (!regionsByVolcano.has(newVolcano)) {
        const loadedRegions = loadRegionsFromStorage(newVolcano);
        if (loadedRegions && loadedRegions.length > 0) {
            regionsByVolcano.set(newVolcano, loadedRegions);
            console.log(`📂 Restored ${loadedRegions.length} regions for ${newVolcano} from localStorage`);
        } else {
            regionsByVolcano.set(newVolcano, []);
        }
    }
    
    // Re-render regions for the new volcano
    renderRegions();
    
    // ✅ Rebuild canvas feature boxes from loaded regions
    import('./spectrogram-renderer.js').then(module => {
        if (module.redrawAllCanvasFeatureBoxes) {
            module.redrawAllCanvasFeatureBoxes();
        }
    }).catch(() => {
        // Module not loaded yet, that's okay
    });
    
    // Redraw waveform to update region highlights
    drawWaveformWithSelection();
    
    if (!isStudyMode()) {
        console.log(`🌋 Switched to volcano: ${newVolcano} (${regionsByVolcano.get(newVolcano).length} regions)`);
    }
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
const MAX_FEATURES_PER_REGION = 20; // Maximum features allowed per region
const MAX_TOTAL_FEATURES = 100; // Global maximum features across all regions

/**
 * Count total features across all regions
 */
function getTotalFeatureCount() {
    const regions = getCurrentRegions();
    return regions.reduce((total, region) => total + region.featureCount, 0);
}

/**
 * Initialize region tracker
 * Sets up event listeners and prepares UI
 */
export function initRegionTracker() {
    // Only log in dev/personal modes, not study mode
    if (!isStudyMode()) {
        console.log('🎯 Region tracker initialized');
    }
    
    // Initialize buttons renderer (must be after all variables are defined)
    initializeButtonsRenderer();
    
    // Initialize current volcano
    currentVolcano = getCurrentVolcano();
    if (currentVolcano) {
        // ✅ Load regions from localStorage if available, otherwise initialize empty array
        if (!regionsByVolcano.has(currentVolcano)) {
            const loadedRegions = loadRegionsFromStorage(currentVolcano);
            if (loadedRegions && loadedRegions.length > 0) {
                regionsByVolcano.set(currentVolcano, loadedRegions);
                console.log(`📂 Restored ${loadedRegions.length} regions for ${currentVolcano} from localStorage`);
                
                // Render the loaded regions
                renderRegions();
                
                // Rebuild canvas feature boxes from loaded regions
                import('./spectrogram-renderer.js').then(module => {
                    if (module.redrawAllCanvasFeatureBoxes) {
                        module.redrawAllCanvasFeatureBoxes();
                    }
                }).catch(() => {
                    // Module not loaded yet, that's okay
                });
            } else {
                regionsByVolcano.set(currentVolcano, []);
            }
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
    // Check if region creation is enabled (requires "Begin Analysis" to be pressed)
    if (!State.isRegionCreationEnabled()) {
        return; // Region creation disabled - don't show button
    }
    
    // Check document connection before DOM access
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
export function createRegionFromSelectionTimes(selectionStartSeconds, selectionEndSeconds) {
    // Check if region creation is enabled (requires "Begin Analysis" to be pressed)
    if (!State.isRegionCreationEnabled()) {
        console.log('🔒 Region creation disabled - please press "Begin Analysis" first');
        return;
    }
    
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
            notes: '',
            speedFactor: getCurrentSpeedFactor() // Capture speed at feature creation time
        }],
        expanded: true,
        playing: false
    };
    
    regions.push(newRegion);
    setCurrentRegions(regions);
    const newRegionIndex = regions.length - 1;
    
    // Update complete button state (new region starts with incomplete feature)
    updateCompleteButtonState();
    
    // Update Complete button state (enable if first feature identified)
    updateCmpltButtonState();
    
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
    
    // Hide the add region button
    hideAddRegionButton();
    
    // 🔥 Resolve tutorial promise if waiting for region creation
    if (State.waitingForRegionCreation && State._regionCreationResolve) {
        State._regionCreationResolve();
        State.setRegionCreationResolve(null);
        State.setWaitingForRegionCreation(false);
    }
    
    // Update status message with region number (1-indexed)
    const regionNumber = newRegionIndex + 1;
    const statusEl = document.getElementById('status');
    if (statusEl) {
        statusEl.className = 'status info';
        statusEl.textContent = `Type (${regionNumber}) to zoom into this region, or click the magnifier button.`;
    }
    
    // Clear the yellow selection box by clearing selection state
    // The selection will be set to the region when space is pressed or play button is clicked
    State.setSelectionStart(null);
    State.setSelectionEnd(null);
    
    // Redraw waveform without the yellow selection box (only blue region highlight will remain)
    drawWaveformWithSelection();
}

// Initialize buttons renderer - called after module loads to avoid circular dependencies
// The init function will be called from initRegionTracker() to ensure all variables are initialized
let buttonsRendererInitialized = false;
function initializeButtonsRenderer() {
    if (buttonsRendererInitialized) return;
    initButtonsRenderer({
        getCurrentRegions: () => getCurrentRegions(),
        get activeRegionIndex() { return activeRegionIndex; },
        get activePlayingRegionIndex() { return activePlayingRegionIndex; }
    });
    buttonsRendererInitialized = true;
}

// Buttons are now rendered in waveform-buttons-renderer.js
// Re-export for backward compatibility
export { drawRegionButtons, positionWaveformButtonsCanvas, resizeWaveformButtonsCanvas } from './waveform-buttons-renderer.js';

/**
 * Draw region highlights on waveform canvas (NO buttons - buttons are on separate overlay)
 * Called from waveform-renderer after drawing waveform
 * Uses EXACT same approach as yellow selection box
 */
export function drawRegionHighlights(ctx, canvasWidth, canvasHeight) {
    if (!State.dataStartTime || !State.dataEndTime || !State.totalAudioDuration) {
        return; // No data loaded yet
    }
    
    // Use provided dimensions (passed from caller to avoid DOM lookups)
    if (!canvasWidth || !canvasHeight) {
        // Fallback to reading from DOM if not provided
        const canvas = document.getElementById('waveform');
        if (!canvas) return;
        canvasWidth = canvas.width;
        canvasHeight = canvas.height;
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
        
        // Buttons and numbers are now drawn on separate overlay canvas (drawRegionButtons)
        // This keeps them independent of cached waveform canvas state
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
    
    // Softer, less intense yellow
    ctx.fillStyle = 'rgba(255, 240, 160, 0.12)';
    ctx.fillRect(startX, 0, selectionWidth, canvasHeight);
    
    ctx.strokeStyle = 'rgba(255, 200, 120, 0.4)';
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
 * 
 * Reads FRESH dimensions from DOM - never uses stale parameters
 */
function calculateButtonPositions(region, index) {
    if (!State.dataStartTime || !State.dataEndTime || !State.totalAudioDuration) {
        return null;
    }
    
    // ✅ Read FRESH dimensions from BUTTONS canvas (not waveform canvas!)
    // Buttons canvas is always fresh and matches current display size
    // Waveform canvas can be stale during resize/zoom transitions
    const buttonsCanvas = document.getElementById('waveform-buttons');
    if (!buttonsCanvas) return null;
    
    const canvasWidth = buttonsCanvas.width;   // Current device pixels from buttons canvas
    const canvasHeight = buttonsCanvas.height; // Current device pixels from buttons canvas
    
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
    
    // Calculate button sizes (fixed CSS pixels, scaled for DPR only)
    // Buttons are always 21×15 CSS pixels - no squishing on narrow canvases
    const dpr = window.devicePixelRatio || 1;
    const baseButtonWidth = 21;
    const baseButtonHeight = 15;
    const buttonWidth = baseButtonWidth * dpr;
    const buttonHeight = baseButtonHeight * dpr;
    const buttonPadding = 4 * dpr;
    const numberTextSize = 20 * dpr;
    const numberTextHeight = numberTextSize;
    const numberTextWidth = 18 * dpr;
    
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
 * cssX, cssY are in CSS pixels (from event coordinates via getBoundingClientRect)
 * Returns region index if clicked, null otherwise
 * 
 * CRITICAL: Reads CURRENT dimensions from DOM on every click to avoid stale dimensions
 * after resize. This ensures positions are always fresh and immune to resize timing,
 * DPR changes, and async weirdness.
 */
export function checkCanvasZoomButtonClick(cssX, cssY) {
    // ✅ Use BUTTONS canvas for click detection (matches where buttons are drawn!)
    const buttonsCanvas = document.getElementById('waveform-buttons');
    if (!buttonsCanvas) return null;
    
    // Convert CSS pixels to device pixels using buttons canvas dimensions
    // Buttons canvas width/height are in device pixels, so we need to scale CSS coords
    const waveformCanvas = document.getElementById('waveform');
    if (!waveformCanvas) return null;
    
    // Get CSS dimensions from waveform (for coordinate scaling)
    const cssWidth = waveformCanvas.offsetWidth;
    const cssHeight = waveformCanvas.offsetHeight;
    
    // Scale CSS coordinates to device coordinates using buttons canvas dimensions
    const deviceX = (cssX / cssWidth) * buttonsCanvas.width;
    const deviceY = (cssY / cssHeight) * buttonsCanvas.height;
    
    const regions = getCurrentRegions();
    
    // Recalculate positions for each region (reads dimensions fresh from DOM)
    for (const [index, region] of regions.entries()) {
        const buttonPos = calculateButtonPositions(region, index);
        if (!buttonPos) continue; // Off-screen
        
        const btn = buttonPos.zoomButton;
        if (deviceX >= btn.x && deviceX <= btn.x + btn.width &&
            deviceY >= btn.y && deviceY <= btn.y + btn.height) {
            return index;
        }
    }
    return null;
}

/**
 * Check if click is on a canvas play button
 * cssX, cssY are in CSS pixels (from event coordinates via getBoundingClientRect)
 * Returns region index if clicked, null otherwise
 * 
 * CRITICAL: Reads CURRENT dimensions from DOM on every click to avoid stale dimensions
 * after resize. This ensures positions are always fresh and immune to resize timing,
 * DPR changes, and async weirdness.
 */
export function checkCanvasPlayButtonClick(cssX, cssY) {
    // ✅ Use BUTTONS canvas for click detection (matches where buttons are drawn!)
    const buttonsCanvas = document.getElementById('waveform-buttons');
    if (!buttonsCanvas) return null;
    
    // Convert CSS pixels to device pixels using buttons canvas dimensions
    // Buttons canvas width/height are in device pixels, so we need to scale CSS coords
    const waveformCanvas = document.getElementById('waveform');
    if (!waveformCanvas) return null;
    
    // Get CSS dimensions from waveform (for coordinate scaling)
    const cssWidth = waveformCanvas.offsetWidth;
    const cssHeight = waveformCanvas.offsetHeight;
    
    // Scale CSS coordinates to device coordinates using buttons canvas dimensions
    const deviceX = (cssX / cssWidth) * buttonsCanvas.width;
    const deviceY = (cssY / cssHeight) * buttonsCanvas.height;
    
    const regions = getCurrentRegions();
    
    // Recalculate positions for each region (reads dimensions fresh from DOM)
    for (const [index, region] of regions.entries()) {
        const buttonPos = calculateButtonPositions(region, index);
        if (!buttonPos) continue; // Off-screen
        
        const btn = buttonPos.playButton;
        if (deviceX >= btn.x && deviceX <= btn.x + btn.width &&
            deviceY >= btn.y && deviceY <= btn.y + btn.height) {
            return index;
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
 * Stop frequency selection mode
 */
export function stopFrequencySelection() {
    // 🔍 DEBUG: Log state before stopping selection
    console.log('🔴 [DEBUG] STOP_FREQUENCY_SELECTION CALLED:', {
        wasSelectingFrequency: isSelectingFrequency,
        hadCurrentSelection: !!currentFrequencySelection,
        currentSelection: currentFrequencySelection,
        documentHasFocus: document.hasFocus(),
        windowHasFocus: document.visibilityState === 'visible'
    });
    
    if (!isSelectingFrequency) {
        console.log('🔴 [DEBUG] Not in frequency selection mode - nothing to stop');
        return;
    }
    
    // Store selection info before clearing it (for button lookup)
    const selectionInfo = currentFrequencySelection;
    
    isSelectingFrequency = false;
    currentFrequencySelection = null;
    
    console.log('🔴 [DEBUG] Frequency selection stopped - canceling any active selection box');
    
    // Cancel any active selection box (remove red box stuck to mouse)
    cancelSpectrogramSelection();
    
    // Remove active state from button
    // Try to find the button using the stored selection info first
    let activeButton = null;
    if (selectionInfo) {
        const { regionIndex, featureIndex } = selectionInfo;
        activeButton = document.getElementById(`select-btn-${regionIndex}-${featureIndex}`);
    }
    // Fallback: find any active button if we can't find the specific one
    if (!activeButton) {
        activeButton = document.querySelector('.select-freq-btn.active');
    }
    if (activeButton) {
        activeButton.classList.remove('active');
    }
    
    // Remove selection cursor from spectrogram
    const canvas = document.getElementById('spectrogram');
    if (canvas) {
        canvas.classList.remove('selecting');
        canvas.style.cursor = '';
    }
}

/**
 * Collapse all region panels
 */
function collapseAllRegions() {
    const regions = getCurrentRegions();
    
    regions.forEach((region, index) => {
        if (!region.expanded) return;
        
        const regionCard = document.querySelector(`[data-region-id="${region.id}"]`);
        if (!regionCard) return;
        
        const header = regionCard.querySelector('.region-header');
        const details = regionCard.querySelector('.region-details');
        if (!header || !details) return;
        
        region.expanded = false;
        
        header.classList.remove('expanded');
        const currentHeight = details.scrollHeight;
        details.style.maxHeight = currentHeight + 'px';
        details.style.transition = 'max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
        void details.offsetHeight;
        
        requestAnimationFrame(() => {
            if (!document.body || !document.body.isConnected) {
                return;
            }
            details.style.maxHeight = '0px';
            setTimeout(() => {
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
    });
}

/**
 * Start frequency selection mode for a specific feature
 */
export function startFrequencySelection(regionIndex, featureIndex) {
    // 🔍 DEBUG: Log state before starting selection
    console.log('🟠 [DEBUG] START_FREQUENCY_SELECTION CALLED:', {
        regionIndex,
        featureIndex,
        wasSelectingFrequency: isSelectingFrequency,
        hadCurrentSelection: !!currentFrequencySelection,
        documentHasFocus: document.hasFocus(),
        windowHasFocus: document.visibilityState === 'visible',
        isInRegion: zoomState.isInRegion()
    });
    
    // Prevent feature selection when zoomed out
    if (!zoomState.isInRegion()) {
        console.warn('⚠️ Cannot start feature selection: must be zoomed into a region');
        return;
    }
    
    // 🎓 Allow feature selection during tutorial (tutorial will manage it)
    // Removed the check that prevented feature selection during tutorial
    
    // 🔥 FIX: If already selecting, stop first to prevent state confusion
    if (isSelectingFrequency) {
        console.warn('⚠️ [DEBUG] Already in frequency selection mode - stopping before starting new one');
        stopFrequencySelection();
    }
    
    isSelectingFrequency = true;
    currentFrequencySelection = { regionIndex, featureIndex };
    
    console.log('🟠 [DEBUG] Frequency selection started:', {
        isSelectingFrequency,
        currentFrequencySelection
    });
    
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
export async function handleSpectrogramSelection(startY, endY, canvasHeight, startX, endX, canvasWidth) {
    console.log('🟢 [DEBUG] HANDLE_SPECTROGRAM_SELECTION CALLED');

    // 🎯 NEW ARCHITECTURE: Auto-determine which feature to fill in
    // Find the active region and either use incomplete feature or create new one
    const activeRegionIndex = getActiveRegionIndex();
    if (activeRegionIndex === null) {
        console.warn('⚠️ No active region - cannot create feature');
        return;
    }

    const regions = getCurrentRegions();
    const region = regions[activeRegionIndex];
    if (!region) {
        console.warn('⚠️ Active region not found');
        return;
    }

    // Find first incomplete feature, or we'll create a new one
    let featureIndex = region.features.findIndex(feature =>
        !feature.lowFreq || !feature.highFreq || !feature.startTime || !feature.endTime
    );

    // No incomplete features - create a new one
    if (featureIndex === -1) {
        const totalFeatures = getTotalFeatureCount();
        if (region.featureCount >= MAX_FEATURES_PER_REGION || totalFeatures >= MAX_TOTAL_FEATURES) {
            console.warn('⚠️ Cannot create feature - limit reached');
            return;
        }

        addFeature(activeRegionIndex);
        featureIndex = region.features.length - 1; // New feature will be at the end (0-indexed)
    }

    const regionIndex = activeRegionIndex;

    console.log(`🎯 Auto-selected feature: region ${regionIndex + 1}, feature ${featureIndex + 1}`);
    
    console.log('🎯 ========== MOUSE UP: Feature Selection Complete ==========');
    console.log('📍 Canvas coordinates (pixels):', {
        startX: startX?.toFixed(1),
        endX: endX?.toFixed(1),
        startY: startY?.toFixed(1),
        endY: endY?.toFixed(1),
        canvasWidth,
        canvasHeight
    });
    
    // Convert Y positions to frequencies (with playbackRate for accurate conversion!)
    const playbackRate = State.currentPlaybackRate || 1.0;

    // Get ACTUAL Nyquist from metadata (NOT hardcoded 50!)
    const originalSampleRate = State.currentMetadata?.original_sample_rate || 100;
    const originalNyquist = originalSampleRate / 2;

    const lowFreq = getFrequencyFromY(Math.max(startY, endY), originalNyquist, canvasHeight, State.frequencyScale, playbackRate);
    const highFreq = getFrequencyFromY(Math.min(startY, endY), originalNyquist, canvasHeight, State.frequencyScale, playbackRate);

    console.log('🎵 Converted to frequencies (Hz):', {
        startY_device: Math.min(startY, endY).toFixed(1),
        endY_device: Math.max(startY, endY).toFixed(1),
        canvasHeight_device: canvasHeight,
        lowFreq: lowFreq.toFixed(2),
        highFreq: highFreq.toFixed(2),
        playbackRate: playbackRate.toFixed(2),
        frequencyScale: State.frequencyScale
    });
    
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
            
            console.log('🏛️ Converted to samples (eternal coordinates):', {
                startSample: startSample.toLocaleString(),
                endSample: endSample.toLocaleString(),
                sampleRate: zoomState.sampleRate
            });
            
            if (startTimestamp && endTimestamp) {
                // Ensure start is before end
                const actualStartMs = Math.min(startTimestamp.getTime(), endTimestamp.getTime());
                const actualEndMs = Math.max(startTimestamp.getTime(), endTimestamp.getTime());
                
                startTime = new Date(actualStartMs).toISOString();
                endTime = new Date(actualEndMs).toISOString();
                
                console.log('📅 Converted to timestamps:', {
                    startTime,
                    endTime
                });
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
            
            console.log('⚠️ FALLBACK: Using progress-based conversion (zoom not initialized)');
            console.log('📅 Timestamps:', { startTime, endTime });
        }
    }
    
    // Update feature data (regions already declared at top of function)
    if (regions[regionIndex] && regions[regionIndex].features[featureIndex]) {
        regions[regionIndex].features[featureIndex].lowFreq = lowFreq.toFixed(2);
        regions[regionIndex].features[featureIndex].highFreq = highFreq.toFixed(2);
        
        if (startTime && endTime) {
            regions[regionIndex].features[featureIndex].startTime = startTime;
            regions[regionIndex].features[featureIndex].endTime = endTime;
        }
        
        console.log('💾 SAVED to feature data:', {
            regionIndex,
            featureIndex,
            lowFreq: lowFreq.toFixed(2),
            highFreq: highFreq.toFixed(2),
            startTime,
            endTime
        });
        console.log('🎯 ========== END Feature Selection ==========\n');
        
        setCurrentRegions(regions);
        
        // 🎯 NEW ARCHITECTURE: Return region/feature indices for canvas box storage
        // (OLD: used to call addFeatureBox() to create orange DOM boxes - now using pure canvas!)
        
        // Re-render the feature
        renderFeatures(regions[regionIndex].id, regionIndex);
        
        // Update complete button state (enable if first feature identified)
        updateCompleteButtonState(); // Begin Analysis button
        updateCmpltButtonState(); // Complete button
        
        // Pulse the button and focus notes field
        setTimeout(() => {
            const selectBtn = document.getElementById(`select-btn-${regionIndex}-${featureIndex}`);
            const notesField = document.getElementById(`notes-${regionIndex}-${featureIndex}`);
            
            if (selectBtn) {
                selectBtn.classList.remove('active', 'pulse');
                selectBtn.classList.add('completed', 'pulse');
                setTimeout(() => selectBtn.classList.remove('pulse'), 250);
            }
            
            // 🔧 TESTING: Disabled auto-focus to test ghost click bug
            // if (notesField) {
            //     setTimeout(() => {
            //         notesField.classList.add('pulse');
            //         notesField.focus();
            //         setTimeout(() => notesField.classList.remove('pulse'), 800);
            //     }, 150);
            // }
        }, 50);
        
        // 🎓 Resolve tutorial promise if waiting for feature selection
        if (State.waitingForFeatureSelection && State._featureSelectionResolve) {
            State._featureSelectionResolve();
            State.setWaitingForFeatureSelection(false);
            State.setFeatureSelectionResolve(null);
        }
        
        // ✅ Return indices and feature data for canvas box storage
        const featureData = regions[regionIndex].features[featureIndex];
        return { 
            regionIndex, 
            featureIndex,
            featureData: {
                startTime: featureData.startTime,
                endTime: featureData.endTime,
                lowFreq: parseFloat(featureData.lowFreq),
                highFreq: parseFloat(featureData.highFreq)
            }
        };
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
    
    // If we didn't save data, return null
    return null;
}

/**
 * Convert Y position to frequency based on scale type
 * 🔗 INVERSE of getYPositionForFrequencyScaled() from axis renderer
 * This MUST produce frequencies in the ORIGINAL scale (not stretched by playback)
 */
function getFrequencyFromY(y, maxFreq, canvasHeight, scaleType, playbackRate = 1.0) {
    if (scaleType === 'logarithmic') {
        // 🦋 LOGARITHMIC: The axis does NOT scale input freq by playbackRate!
        // It calculates position at 1x, then stretches the POSITION
        // So inverse: unstretched position → original frequency (no playback division!)
        const minFreq = 0.1;
        const logMin = Math.log10(minFreq);
        const logMax = Math.log10(maxFreq); // FIXED: use original Nyquist

        // Calculate stretch factor
        const effectiveNyquist = maxFreq * playbackRate;
        const logMax_1x = Math.log10(maxFreq);
        const logMax_scaled = Math.log10(effectiveNyquist);
        const stretchFactor = logMax_scaled / logMax_1x;

        // Reverse: heightFromBottom_scaled → heightFromBottom_1x
        const heightFromBottom_scaled = canvasHeight - y;
        const heightFromBottom_1x = heightFromBottom_scaled / stretchFactor;

        // Convert heightFromBottom_1x back to frequency (in ORIGINAL scale, no playback!)
        const normalizedLog = heightFromBottom_1x / canvasHeight;
        const logFreq = logMin + (normalizedLog * (logMax - logMin));
        const freq = Math.pow(10, logFreq);

        // CLAMP to valid range [minFreq, maxFreq]
        return Math.max(minFreq, Math.min(maxFreq, freq));
    } else {
        // Linear and sqrt: These ARE homogeneous - freq gets scaled by playbackRate
        // Forward: effectiveFreq = freq * playbackRate, then normalize
        // Inverse: normalize → effectiveFreq, then divide by playbackRate
        const normalizedY = (canvasHeight - y) / canvasHeight;

        if (scaleType === 'sqrt') {
            // Reverse sqrt
            const normalized = normalizedY * normalizedY;
            const effectiveFreq = normalized * maxFreq;
            const freq = effectiveFreq / playbackRate;

            // CLAMP to valid range
            return Math.max(0.1, Math.min(maxFreq, freq));
        } else {
            // Linear
            const effectiveFreq = normalizedY * maxFreq;
            const freq = effectiveFreq / playbackRate;

            // CLAMP to valid range
            return Math.max(0, Math.min(maxFreq, freq));
        }
    }
}

/**
 * Format time for display (HH:MM format)
 * CONVERTS UTC TO LOCAL TIME for display (matches x-axis behavior)
 */
function formatTime(isoString) {
    const date = new Date(isoString); // This is UTC
    // Get LOCAL time components (just like x-axis does!)
    const hours = String(date.getHours()).padStart(2, '0'); // Local!
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

/**
 * Format time for display with seconds (H:MM:SS format, no leading zero on hours if < 10)
 * CONVERTS UTC TO LOCAL TIME for display (matches x-axis behavior)
 */
function formatTimeWithSeconds(isoString) {
    const date = new Date(isoString); // This is UTC
    
    // Get LOCAL time components (just like x-axis does!)
    const hours = date.getHours(); // Local hours (0-23), no padding - single digit for 0-9
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    
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
        
        // 🔥 Check if region buttons are disabled (during tutorial)
        if (State.regionButtonsDisabled) {
            // Check if this specific zoom button is enabled for tutorial
            if (!State.isRegionZoomButtonEnabled(index)) {
                return;
            }
        }
        
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
        
        // 🔥 Check if region buttons are disabled (during tutorial)
        if (State.regionButtonsDisabled) {
            // Check if this specific play button is enabled for tutorial
            if (!State.isRegionPlayButtonEnabled(index)) {
                return;
            }
        }
        
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
    
    const totalFeatures = getTotalFeatureCount();
    const isMaxFeaturesPerRegion = region.featureCount >= MAX_FEATURES_PER_REGION;
    const isMaxFeaturesGlobal = totalFeatures >= MAX_TOTAL_FEATURES;
    const isMaxFeatures = isMaxFeaturesPerRegion || isMaxFeaturesGlobal;

    let maxFeatureMessage = 'Add feature';
    if (isMaxFeaturesGlobal) {
        maxFeatureMessage = `Global max features (${MAX_TOTAL_FEATURES}) reached`;
    } else if (isMaxFeaturesPerRegion) {
        maxFeatureMessage = `Max features per region (${MAX_FEATURES_PER_REGION}) reached`;
    }

    detailsContent.innerHTML = `
        <div class="features-list">
            <div id="features-${region.id}" class="features-container"></div>
            <div class="add-feature-row">
                <button class="add-feature-btn"
                        data-region-index="${index}"
                        ${isMaxFeatures ? 'disabled' : ''}
                        title="${isMaxFeatures ? maxFeatureMessage : 'Add feature'}">
                    +
                </button>
                <span class="add-feature-label ${isMaxFeatures ? 'disabled' : ''}"
                      data-region-index="${index}"
                      title="${isMaxFeatures ? maxFeatureMessage : 'Add feature'}">
                    ${isMaxFeatures ? maxFeatureMessage : 'Add feature'}
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
            notes: '',
            speedFactor: getCurrentSpeedFactor() // Capture speed at feature creation time
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
            
            <button class="select-freq-btn ${!zoomState.isInRegion() || isTutorialActive() ? 'disabled' : (!feature.lowFreq || !feature.highFreq || !feature.startTime || !feature.endTime ? 'pulse' : 'completed')}" 
                    id="select-btn-${regionIndex}-${featureIndex}"
                    data-region-index="${regionIndex}" data-feature-index="${featureIndex}"
                    ${!zoomState.isInRegion() || isTutorialActive() ? 'disabled' : ''}
                    title="${!zoomState.isInRegion() ? 'Zoom into region to select features' : isTutorialActive() ? 'Tutorial in progress' : (feature.lowFreq && feature.highFreq && feature.startTime && feature.endTime ? 'click to select' : '')}">
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
            // Prevent click when zoomed out
            if (!zoomState.isInRegion()) {
                return;
            }
            // 🎓 Allow feature selection during tutorial (tutorial will manage it)
            startFrequencySelection(regionIndex, featureIndex);
        });
        
        // Store original text and add hover effect (only when zoomed into a region)
        const originalText = freqBtn.textContent;
        if (feature.lowFreq && feature.highFreq && feature.startTime && feature.endTime && zoomState.isInRegion()) {
            freqBtn.addEventListener('mouseenter', () => {
                // Only show hover text when zoomed into a region
                if (zoomState.isInRegion()) {
                    freqBtn.textContent = 'Click to re-select feature.';
                }
            });
            freqBtn.addEventListener('mouseleave', () => {
                freqBtn.textContent = originalText;
            });
        }
        
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
 * Expand a region and collapse all others
 */
function expandRegionAndCollapseOthers(targetIndex) {
    const regions = getCurrentRegions();
    
    regions.forEach((region, index) => {
        const regionCard = document.querySelector(`[data-region-id="${region.id}"]`);
        if (!regionCard) return;
        
        const header = regionCard.querySelector('.region-header');
        const details = regionCard.querySelector('.region-details');
        if (!header || !details) return;
        
        if (index === targetIndex) {
            // Expand target region
            if (!region.expanded) {
                region.expanded = true;
                
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
                    if (!document.body || !document.body.isConnected) {
                        return;
                    }
                    const targetHeight = details.scrollHeight;
                    details.style.transition = 'max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
                    details.style.maxHeight = targetHeight + 'px';
                });
            }
            
            // Re-render features to update button states (enabled/disabled based on zoom state)
            renderFeatures(region.id, index);
        } else {
            // Collapse other regions
            if (region.expanded) {
                region.expanded = false;
                
                header.classList.remove('expanded');
                const currentHeight = details.scrollHeight;
                details.style.maxHeight = currentHeight + 'px';
                details.style.transition = 'max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
                void details.offsetHeight;
                
                requestAnimationFrame(() => {
                    if (!document.body || !document.body.isConnected) {
                        return;
                    }
                    details.style.maxHeight = '0px';
                    setTimeout(() => {
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
            }
        }
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
        
        // Re-render features to update button states (enabled/disabled based on zoom state)
        renderFeatures(region.id, index);
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
    
    // console.log(`🎵 Region ${index + 1} play button clicked`);
    
    // 🎓 Tutorial: Resolve promise if waiting for region play click
    if (State.waitingForRegionPlayClick && State._regionPlayClickResolve) {
        State.setWaitingForRegionPlayClick(false);
        const resolve = State._regionPlayClickResolve;
        State.setRegionPlayClickResolve(null);
        resolve();
    }
    
    // 🎓 Tutorial: Also resolve if waiting for region play or resume
    if (State.waitingForRegionPlayOrResume && State._regionPlayOrResumeResolve) {
        State.setWaitingForRegionPlayOrResume(false);
        State.setWaitingForRegionPlayClick(false);
        const resolve = State._regionPlayOrResumeResolve;
        State.setRegionPlayOrResumeResolve(null);
        State.setRegionPlayClickResolve(null);
        resolve();
    }
    
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
    
    // console.log(`▶️ Region ${index + 1} playing from ${b.start.toFixed(2)}s`);
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
    // 🎓 Tutorial: Resolve promise if waiting for add feature button click
    if (State.waitingForAddFeatureButtonClick && State._addFeatureButtonClickResolve) {
        State.setWaitingForAddFeatureButtonClick(false);
        const resolve = State._addFeatureButtonClickResolve;
        State.setAddFeatureButtonClickResolve(null);
        resolve();
    }
    
    const regions = getCurrentRegions();
    const region = regions[regionIndex];
    const currentCount = region.featureCount;
    const totalFeatures = getTotalFeatureCount();

    if (currentCount >= MAX_FEATURES_PER_REGION) {
        console.log(`Maximum features per region (${MAX_FEATURES_PER_REGION}) reached`);
        return;
    }

    if (totalFeatures >= MAX_TOTAL_FEATURES) {
        console.log(`Global maximum features (${MAX_TOTAL_FEATURES}) reached`);
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

    // 🗑️ Remove the feature box from DOM
    removeFeatureBox(regionIndex, featureIndex);

    // Remove feature from array (this shifts all subsequent indices down)
    region.features.splice(featureIndex, 1);
    region.featureCount = region.features.length;

    setCurrentRegions(regions);

    // 🔢 Renumber all remaining boxes for this region (features after deleted one shift down)
    import('./spectrogram-feature-boxes.js').then(module => {
        if (module.renumberFeatureBoxes) {
            module.renumberFeatureBoxes(regionIndex);
        }
    });
    
    // 🎨 Rebuild canvas boxes (handles deletion and renumbering automatically!)
    import('./spectrogram-renderer.js').then(module => {
        if (module.removeCanvasFeatureBox) {
            module.removeCanvasFeatureBox(regionIndex, featureIndex);
        }
    });

    // Update complete button state (in case we deleted the last identified feature)
    updateCompleteButtonState();

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
    
    // Update complete button state (in case a feature was just completed)
    updateCompleteButtonState(); // Begin Analysis button
    updateCmpltButtonState(); // Complete button
    
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
        
        regions.splice(index, 1);
        setCurrentRegions(regions);
        if (activeRegionIndex === index) {
            activeRegionIndex = null;
        } else if (activeRegionIndex > index) {
            activeRegionIndex--;
        }
        renderRegions();
        
        // ✅ Rebuild canvas boxes (removes boxes for deleted region!)
        import('./spectrogram-renderer.js').then(module => {
            if (module.redrawAllCanvasFeatureBoxes) {
                module.redrawAllCanvasFeatureBoxes();
            }
        }).catch(() => {
            // Module not loaded yet, that's okay
        });
        
        // Update complete button state (in case we deleted the last identified feature)
        updateCompleteButtonState(); // Begin Analysis button
        updateCmpltButtonState(); // Complete button
        
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
    
    // console.log(`🔍 Zooming into region ${regionIndex + 1} (samples ${region.startSample.toLocaleString()}-${region.endSample.toLocaleString()})`);
    
    // console.log('🔍 ========== ZOOM IN: Starting Region Zoom ==========');
    // console.log('🏛️ Region data:', {
    //     regionIndex,
    //     startSample: region.startSample?.toLocaleString(),
    //     endSample: region.endSample?.toLocaleString(),
    //     startTime: region.startTime,
    //     stopTime: region.stopTime
    // });
    
    // Print all features before zoom
    // console.log('📦 Features before zoom:');
    // region.features.forEach((feature, idx) => {
    //     console.log(`  Feature ${idx}:`, {
    //         lowFreq: feature.lowFreq,
    //         highFreq: feature.highFreq,
    //         startTime: feature.startTime,
    //         endTime: feature.endTime
    //     });
    // });
    
    // 🔥 CRITICAL: Read current interpolated position BEFORE cancelling or updating zoomState
    // If transition is in progress, use CURRENT interpolated position (not the target)
    // This ensures smooth transitions when switching mid-animation
    let oldStartTime, oldEndTime;
    const wasTransitionInProgress = isZoomTransitionInProgress();
    if (wasTransitionInProgress) {
        // Transition in progress - MUST read current position BEFORE cancelling
        // because stopZoomTransition() clears oldTimeRange
        const currentRange = getInterpolatedTimeRange();
        oldStartTime = currentRange.startTime;
        oldEndTime = currentRange.endTime;
        console.log('🔄 Using current interpolated position as transition start:', {
            startTime: oldStartTime,
            endTime: oldEndTime
        });
    } else if (zoomState.isInRegion()) {
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
        // console.log('💾 Cached full waveform canvas before zooming in');
    }
    
    // Enter the temple (update zoomState AFTER reading current position)
    zoomState.mode = 'region';
    zoomState.currentViewStartSample = region.startSample;
    zoomState.currentViewEndSample = region.endSample;
    zoomState.activeRegionId = region.id;
    
    // Update submit button visibility (show when zoomed in)
    if (typeof window.updateSubmitButtonVisibility === 'function') {
        window.updateSubmitButtonVisibility();
    }
    
    // 🎓 Tutorial: Resolve promise if waiting for region zoom
    if (State.waitingForRegionZoom && State._regionZoomResolve) {
        State.setWaitingForRegionZoom(false);
        const resolve = State._regionZoomResolve;
        State.setRegionZoomResolve(null);
        // Resolve after a small delay to ensure zoom state is fully updated
        setTimeout(() => resolve(), 50);
    }
    
    // Immediately redraw regions at new positions
    drawWaveformWithSelection();
    
    const regionStartSeconds = zoomState.sampleToTime(region.startSample);
    const regionEndSeconds = zoomState.sampleToTime(region.endSample);
    
    State.setSelectionStart(null);
    State.setSelectionEnd(null);
    updateWorkletSelection();
    
    setActiveRegion(regionIndex);
    
    // Expand this region's panel and collapse all others
    expandRegionAndCollapseOthers(regionIndex);
    
    // Update status message with region number (1-indexed)
    // 🎓 Suppress standard interaction message during tutorial
    const regionNumber = regionIndex + 1;
    const statusEl = document.getElementById('status');
    if (statusEl) {
        // Check if tutorial is active - if so, don't override tutorial messages
        if (!isTutorialActive()) {
            statusEl.className = 'status info';
            statusEl.textContent = `Type (${regionNumber}) again to play this region, click and drag to select a feature, (esc) to zoom out.`;
        }
    }
    
    const newStartTime = zoomState.sampleToRealTimestamp(region.startSample);
    const newEndTime = zoomState.sampleToRealTimestamp(region.endSample);
    
    // 🔍 Diagnostic: Track region zoom start
    // console.log('🔍 REGION ZOOM IN starting:', {
    //     startTime: regionStartSeconds,
    //     endTime: regionEndSeconds,
    //     startSample: region.startSample,
    //     endSample: region.endSample
    // });
    
    // 🔥 PROTECTION: Cancel render for different region if needed
    // NOTE: Don't call stopZoomTransition() here - animateZoomTransition() will handle cancelling the RAF
    // We already read the current position above, so we're good to start the new transition
    if (shouldCancelActiveRender(region.id)) {
        // Cancel render for different region even if no transition in progress
        console.log('🛑 Cancelling render for different region...');
        cancelActiveRender();
    }
    
    // 🔬 START HIGH-RES RENDER IN BACKGROUND (don't wait!)
    // console.log('🔬 Starting high-res render in background...');
    const renderPromise = renderCompleteSpectrogramForRegion(
        regionStartSeconds, 
        regionEndSeconds,
        true,  // renderInBackground = true
        region.id  // Pass region ID for tracking
    );
    
    // 🎬 Animate with elastic friend - no waiting!
    animateZoomTransition(oldStartTime, oldEndTime, true).then(() => {
        // console.log('🎬 Zoom animation complete');
        
        // console.log('🔍 ========== ZOOM IN: Animation Complete ==========');
        // console.log('🏛️ Now inside region:', {
        //     regionIndex,
        //     mode: zoomState.mode,
        //     activeRegionId: zoomState.activeRegionId,
        //     currentViewStartSample: zoomState.currentViewStartSample.toLocaleString(),
        //     currentViewEndSample: zoomState.currentViewEndSample.toLocaleString()
        // });
        
        // Print all features after zoom
        const regionsAfter = getCurrentRegions();
        // console.log('📦 Features after zoom:');
        // regionsAfter[regionIndex].features.forEach((feature, idx) => {
        //     console.log(`  Feature ${idx}:`, {
        //         lowFreq: feature.lowFreq,
        //         highFreq: feature.highFreq,
        //         startTime: feature.startTime,
        //         endTime: feature.endTime
        //     });
        // });
        // console.log('🔍 ========== END Zoom In ==========\n');
        
        // Update feature box positions after zoom transition completes
        import('./spectrogram-feature-boxes.js').then(module => {
            module.updateAllFeatureBoxPositions();
        });
        
        // Rebuild waveform (fast)
        drawWaveform();
        
        // Wait for high-res spectrogram if needed, then crossfade
        // 🔥 PROTECTION: Only update viewport if we're still in the same region (not cancelled)
        renderPromise.then(() => {
            // Check if we're still zoomed into the same region (render wasn't cancelled)
            if (zoomState.isInRegion() && zoomState.activeRegionId === region.id) {
                // console.log('🔬 High-res ready - updating viewport');
                const playbackRate = State.currentPlaybackRate || 1.0;
                updateSpectrogramViewport(playbackRate);
                
                // Update feature box positions again after viewport update
                import('./spectrogram-feature-boxes.js').then(module => {
                    module.updateAllFeatureBoxPositions();
                });
                
                // 🔍 Diagnostic: Track region zoom complete
                console.log('✅ REGION ZOOM IN complete');
            } else {
                console.log('🛑 Render completed but region changed - skipping viewport update');
            }
        }).catch(err => {
            // Suppress errors from cancelled renders
            if (err.name !== 'AbortError') {
                console.error('❌ Error in render promise:', err);
            }
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
    
    // console.log(`🔍 Temple boundaries set: ${regionStartSeconds.toFixed(2)}s - ${regionEndSeconds.toFixed(2)}s`);
    // console.log(`🚩 Flag raised - respecting temple walls`);
    // console.log(`🔍 Zoomed to ${zoomState.getZoomLevel().toFixed(1)}x - the introspective lens is open! 🦋`);
    // console.log(`🔄 ZOOM MODE TOGGLE: full view → temple mode (region ${regionIndex + 1})`);
    // console.log(`🏛️ Entering the temple - sacred walls at ${regionStartSeconds.toFixed(2)}s - ${regionEndSeconds.toFixed(2)}s`);
    
    // Auto-enter selection mode for the first incomplete feature when zooming in
    // 🎓 Skip this during tutorial to avoid interrupting tutorial flow
    if (!isTutorialActive()) {
        // Find the first feature that needs selection (missing frequency or time data)
        const firstIncompleteFeatureIndex = region.features.findIndex(feature => 
            !feature.lowFreq || !feature.highFreq || !feature.startTime || !feature.endTime
        );
        
        if (firstIncompleteFeatureIndex !== -1) {
            setTimeout(() => {
                startFrequencySelection(regionIndex, firstIncompleteFeatureIndex);
            }, 100);
        }
    }
}

/**
 * Zoom back out to full view
 */
export function zoomToFull() {
    console.log('🔍 [ZOOM_TO_FULL DEBUG] zoomToFull() called');
    console.log('🔍 [ZOOM_TO_FULL DEBUG] State.waitingForZoomOut:', State.waitingForZoomOut);
    console.log('🔍 [ZOOM_TO_FULL DEBUG] State._zoomOutResolve exists:', !!State._zoomOutResolve);
    
    // 🎓 Tutorial: Resolve promise if waiting for zoom out
    if (State.waitingForZoomOut && State._zoomOutResolve) {
        console.log('🔍 [ZOOM_TO_FULL DEBUG] Resolving tutorial zoom out promise');
        State.setWaitingForZoomOut(false);
        const resolve = State._zoomOutResolve;
        State.setZoomOutResolve(null);
        resolve();
    }
    
    if (!zoomState.isInitialized()) {
        console.log('🔍 [ZOOM_TO_FULL DEBUG] zoomState not initialized - returning early');
        return;
    }
    
    console.log('🔍 [ZOOM_TO_FULL DEBUG] Continuing with zoom out...');
    
    // console.log('🌍 Zooming to full view');
    // console.log('🔙 ZOOMING OUT TO FULL VIEW starting');
    
    // console.log('🌍 ========== ZOOM OUT: Starting Full View Zoom ==========');
    // console.log('🏛️ Current state:', {
    //     mode: zoomState.mode,
    //     activeRegionId: zoomState.activeRegionId,
    //     currentViewStartSample: zoomState.currentViewStartSample.toLocaleString(),
    //     currentViewEndSample: zoomState.currentViewEndSample.toLocaleString()
    // });
    
    // Print all features before zoom
    const regionsBefore = getCurrentRegions();
    // console.log('📦 All features before zoom out:');
    // regionsBefore.forEach((region, regionIndex) => {
    //     console.log(`  Region ${regionIndex}:`);
    //     region.features.forEach((feature, featureIndex) => {
    //         console.log(`    Feature ${featureIndex}:`, {
    //             lowFreq: feature.lowFreq,
    //             highFreq: feature.highFreq,
    //             startTime: feature.startTime,
    //             endTime: feature.endTime
    //         });
    //     });
    // });
    
    // 🔥 CRITICAL: Read current interpolated position BEFORE cancelling or updating zoomState
    // If transition is in progress, use CURRENT interpolated position (not the target)
    // This ensures smooth transitions when switching mid-animation
    let oldStartTime, oldEndTime;
    const wasTransitionInProgress = isZoomTransitionInProgress();
    if (wasTransitionInProgress) {
        // Transition in progress - MUST read current position BEFORE cancelling
        // because stopZoomTransition() clears oldTimeRange
        const currentRange = getInterpolatedTimeRange();
        oldStartTime = currentRange.startTime;
        oldEndTime = currentRange.endTime;
        // console.log('🔄 Using current interpolated position as transition start (zoom out):', {
        //     startTime: oldStartTime,
        //     endTime: oldEndTime
        // });
    } else if (zoomState.isInRegion()) {
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
    
    // 💾 Cache the zoomed spectrogram BEFORE resetting (so we can crossfade it)
    cacheZoomedSpectrogram();
    
    // 🏛️ Exit the temple - return to full view (update zoomState AFTER reading current position)
    zoomState.mode = 'full';
    zoomState.currentViewStartSample = 0;
    zoomState.currentViewEndSample = zoomState.totalSamples;
    zoomState.activeRegionId = null;
    
    // Update submit button visibility (hide when zoomed out)
    if (typeof window.updateSubmitButtonVisibility === 'function') {
        window.updateSubmitButtonVisibility();
    }
    
    // 🔧 FIX: Clear active region to prevent UI confusion after zoom-out
    activeRegionIndex = null;
    
    // Collapse all region panels and disable feature selection mode
    collapseAllRegions();
    stopFrequencySelection();
    
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
        // console.log('💾 Restored cached full waveform - ready for interpolation');
    } else {
        // No cached full waveform - rebuild it (fallback)
        console.log('⚠️ No cached full waveform - rebuilding');
        drawWaveform();
    }

    // 🔥 PROTECTION: Cancel render if needed
    // NOTE: Don't call stopZoomTransition() here - animateZoomTransition() will handle cancelling the RAF
    // We already read the current position above, so we're good to start the new transition
    if (shouldCancelActiveRender(null)) {
        // Cancel any active render when zooming to full (regionId is null for full view)
        console.log('🛑 Cancelling active render when zooming to full view...');
        cancelActiveRender();
    }
    
    // 🏛️ Animate x-axis tick interpolation (smooth transition back to full view)
    // 🎬 Wait for animation to complete, THEN rebuild infinite canvas for full view
    animateZoomTransition(oldStartTime, oldEndTime, false).then(() => {
        // console.log('🎬 Zoom-out animation complete - restoring full view');
        
        // console.log('🌍 ========== ZOOM OUT: Animation Complete ==========');
        // console.log('🏛️ Now in full view:', {
        //     mode: zoomState.mode,
        //     activeRegionId: zoomState.activeRegionId,
        //     currentViewStartSample: zoomState.currentViewStartSample.toLocaleString(),
        //     currentViewEndSample: zoomState.currentViewEndSample.toLocaleString()
        // });
        
        // Print all features after zoom
        const regionsAfter = getCurrentRegions();
        // console.log('📦 All features after zoom out:');
        // regionsAfter.forEach((region, regionIndex) => {
        //     console.log(`  Region ${regionIndex}:`);
        //     region.features.forEach((feature, featureIndex) => {
        //         console.log(`    Feature ${featureIndex}:`, {
        //             lowFreq: feature.lowFreq,
        //             highFreq: feature.highFreq,
        //             startTime: feature.startTime,
        //             endTime: feature.endTime
        //         });
        //     });
        // });
        // console.log('🌍 ========== END Zoom Out ==========\n');
        
        // Update feature box positions after zoom transition completes
        import('./spectrogram-feature-boxes.js').then(module => {
            module.updateAllFeatureBoxPositions();
        });
        
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
        
        // Update feature box positions again after viewport update
        import('./spectrogram-feature-boxes.js').then(module => {
            module.updateAllFeatureBoxPositions();
        });
        
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
    
    // console.log('🌍 Returned to full view - flag lowered, free roaming restored! 🏛️');
    // console.log(`🔄 ZOOM MODE TOGGLE: temple mode → full view`);
    // console.log(`🏛️ Exiting the temple - returning to full view`);
}

// Export state getters for external access
export function getRegions() {
    return getCurrentRegions();
}

export function isInFrequencySelectionMode() {
    return isSelectingFrequency;
}

/**
 * Get the current frequency selection (if any)
 * @returns {Object|null} { regionIndex, featureIndex } or null
 */
export function getCurrentFrequencySelection() {
    return currentFrequencySelection;
}

/**
 * Check if at least one feature has been identified (has all required fields)
 * A feature is considered identified when it has: lowFreq, highFreq, startTime, and endTime
 */
export function hasIdentifiedFeature() {
    const regions = getCurrentRegions();
    for (const region of regions) {
        if (region.features && region.features.length > 0) {
            for (const feature of region.features) {
                if (feature.lowFreq && feature.highFreq && feature.startTime && feature.endTime) {
                    return true;
                }
            }
        }
    }
    return false;
}

/**
 * Update the complete button state based on whether data has been downloaded
 * Button enables after a complete data set downloads for the first time
 */
export function updateCompleteButtonState() {
    const completeBtn = document.getElementById('completeBtn');
    if (completeBtn) {
        // Check if complete data set has been downloaded
        const hasData = State.completeSamplesArray && State.completeSamplesArray.length > 0;
        const sampleCount = State.completeSamplesArray ? State.completeSamplesArray.length : 0;
        if (!isStudyMode()) {
            console.log(`🔵 updateCompleteButtonState: hasData=${hasData}, sampleCount=${sampleCount.toLocaleString()}`);
        }
        
        // Check if button is in "Begin Analysis" mode (before transformation) or "Complete" mode (after)
        const isBeginAnalysisMode = completeBtn.textContent === 'Begin Analysis';
        
        // In study mode (STUDY and STUDY_CLEAN), "Begin Analysis" button should NEVER show
        // Region creation is enabled automatically before the tutorial starts
        // BUT: TEST_STUDY_END is a debug mode and should show the button like DEV mode
        const isRealStudyMode = isStudyMode() && !isTestStudyEndMode();

        if (isRealStudyMode) {
            if (isBeginAnalysisMode) {
                // For FIRST VISIT: Always disable/hide button (tutorial will show it when ready)
                // For ALL OTHER VISITS: Standard behavior - show button if data available
                const isFirstVisit = !hasSeenTutorial();
                
                // ✅ CRITICAL: If tutorial is currently showing the button, don't override it!
                // Check if we're in the Begin Analysis tutorial step
                const currentPhase = getTutorialPhase();
                const isBeginAnalysisTutorialActive = currentPhase === 'waiting_for_begin_analysis_click';
                
                if (isFirstVisit) {
                    // First visit = hide/disable button UNLESS tutorial is showing it
                    if (isBeginAnalysisTutorialActive) {
                        // Tutorial is controlling the button - don't override!
                        // Button is already visible and enabled by runBeginAnalysisTutorial()
                        return; // Exit early, let tutorial control it
                    }
                    
                    // Tutorial not active - hide button until tutorial shows it
                    completeBtn.style.display = 'none';
                    completeBtn.disabled = true;
                    completeBtn.style.opacity = '0.5';
                    completeBtn.style.cursor = 'not-allowed';
                } else {
                    // Returning visit - show button if data is available
                    if (hasData) {
                        completeBtn.style.display = 'flex';
                        completeBtn.style.alignItems = 'center';
                        completeBtn.style.justifyContent = 'center';
                        completeBtn.disabled = false;
                        completeBtn.style.opacity = '1';
                        completeBtn.style.cursor = 'pointer';
                    } else {
                        completeBtn.style.display = 'none';
                    }
                }
            } else {
                // This is the "Complete" button (post-transformation) - handle normally
                if (hasData && !isTutorialActive()) {
                    completeBtn.style.display = 'flex';
                    completeBtn.style.alignItems = 'center';
                    completeBtn.style.justifyContent = 'center';
                    completeBtn.disabled = false;
                    completeBtn.style.opacity = '1';
                    completeBtn.style.cursor = 'pointer';
                } else {
                    completeBtn.style.display = 'none';
                }
            }
        } else {
            // Non-study mode: show button but disable it when no data OR during tutorial (first visit)
            completeBtn.style.display = 'flex';
            completeBtn.style.alignItems = 'center';
            completeBtn.style.justifyContent = 'center';
            // Disable during first visit - tutorial will enable it when ready
            // Don't check isTutorialActive() because tutorialPhase might not be set yet
            const isFirstVisit = !hasSeenTutorial();
            if (isFirstVisit) {
                completeBtn.disabled = true;
                completeBtn.style.opacity = '0.5';
                completeBtn.style.cursor = 'not-allowed';
                console.log('❌ Begin Analysis button DISABLED (first visit - tutorial will enable)');
            } else {
                completeBtn.disabled = !hasData;
                if (hasData) {
                    completeBtn.style.opacity = '1';
                    completeBtn.style.cursor = 'pointer';
                    console.log('✅ Begin Analysis button ENABLED');
                } else {
                    completeBtn.style.opacity = '0.5';
                    completeBtn.style.cursor = 'not-allowed';
                    console.log('❌ Begin Analysis button DISABLED');
                }
            }
        }
    } else {
        console.warn('⚠️ updateCompleteButtonState: completeBtn not found in DOM');
    }
}

/**
 * Update the Complete button (completeBtn after transformation) state based on whether features have been identified
 * Button enables after at least one feature has been identified (has all required fields)
 * Uses the existing hasIdentifiedFeature() logic
 */
export function updateCmpltButtonState() {
    const completeBtn = document.getElementById('completeBtn');
    if (completeBtn && completeBtn.textContent === 'Complete') {
        // Only update if button has been transformed to Complete
        const hasFeature = hasIdentifiedFeature();
        
        if (!isStudyMode()) {
            console.log(`✅ updateCmpltButtonState: hasFeature=${hasFeature}`);
        }
        
        completeBtn.disabled = !hasFeature;
        if (hasFeature) {
            completeBtn.style.opacity = '1';
            completeBtn.style.cursor = 'pointer';
            if (!isStudyMode()) {
                console.log('✅ Complete button ENABLED');
            }
        } else {
            completeBtn.style.opacity = '0.5';
            completeBtn.style.cursor = 'not-allowed';
            if (!isStudyMode()) {
                console.log('❌ Complete button DISABLED');
            }
        }
    }
}

