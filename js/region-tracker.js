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
import { isTouchDevice, isMobileScreen } from './audio-state.js';
import { drawWaveformWithSelection, updatePlaybackIndicator, drawWaveform } from './waveform-renderer.js';
import { togglePlayPause, seekToPosition, updateWorkletSelection } from './audio-player.js';
import { zoomState } from './zoom-state.js';
import { getCurrentPlaybackBoundaries } from './playback-boundaries.js';
import { renderCompleteSpectrogramForRegion, renderCompleteSpectrogram, resetSpectrogramState, cacheFullSpectrogram, clearCachedFullSpectrogram, cacheZoomedSpectrogram, clearCachedZoomedSpectrogram, updateSpectrogramViewport, restoreInfiniteCanvasFromCache, cancelActiveRender, shouldCancelActiveRender, clearSmartRenderBounds, getInfiniteCanvasStatus, getCachedFullStatus } from './spectrogram-complete-renderer.js';
import { animateZoomTransition, getInterpolatedTimeRange, getRegionOpacityProgress, isZoomTransitionInProgress, getZoomTransitionProgress, getOldTimeRange, drawWaveformXAxis } from './waveform-x-axis-renderer.js';
import { initButtonsRenderer } from './waveform-buttons-renderer.js';
import { addFeatureBox, removeFeatureBox, updateAllFeatureBoxPositions, renumberFeatureBoxes } from './spectrogram-feature-boxes.js';
import { cancelSpectrogramSelection, redrawAllCanvasFeatureBoxes, removeCanvasFeatureBox, changeColormap, changeFftSize, changeFrequencyScale } from './spectrogram-renderer.js';
import { getLogScaleMinFreq } from './spectrogram-axis-renderer.js';
import { isTutorialActive, getTutorialPhase } from './tutorial-state.js';
import { isStudyMode, isTutorialEndMode } from './master-modes.js';
import { hasSeenTutorial } from './study-workflow.js';
import { log, logGroup, logGroupEnd } from './logger.js';

// Region data structure - stored per spacecraft
// Map<spacecraftName, regions[]>
let regionsBySpacecraft = new Map();
let currentSpacecraft = null;
let activeRegionIndex = null;
let activePlayingRegionIndex = null; // Track which region is currently playing (if any)
let regionsDelayedForCrossfade = false; // Flag to track if regions are waiting for crossfade to complete

/**
 * Update spectrogram touch-action for mobile devices
 * When zoomed into a region, allow drawing (touch-action: none)
 * When zoomed out, allow scrolling (touch-action: pan-y via CSS default)
 */
function updateSpectrogramTouchMode(isZoomedIn) {
    if (!isTouchDevice) return; // Only needed for touch devices

    const spectrogram = document.getElementById('spectrogram');
    if (!spectrogram) return;

    if (isZoomedIn) {
        spectrogram.classList.add('touch-draw');
    } else {
        spectrogram.classList.remove('touch-draw');
    }
}

// 🎨 ANIMATION TOGGLE: Set to true for smooth slide animation, false for instant reordering
const ANIMATE_REGION_REORDER = true; // Change to true to enable smooth slide animation

// localStorage key prefix for feature persistence
const STORAGE_KEY_PREFIX = 'solar_audio_regions_';

/**
 * Generate a unique storage key hash for a specific data fetch
 * Combines username, spacecraft, data type, start time, and end time
 * This ensures features are associated with the exact data AND user they were created by
 */
function generateStorageKey(spacecraft, dataType, startTime, endTime) {
    // Get the current username
    const username = localStorage.getItem('participantId') || 'anonymous';

    if (!spacecraft || !dataType || !startTime || !endTime) {
        // Fallback to old format if any component is missing
        return spacecraft ? `${STORAGE_KEY_PREFIX}${username}_${spacecraft}` : null;
    }

    // Format times as ISO strings for consistent hashing
    const startISO = startTime instanceof Date ? startTime.toISOString() : startTime;
    const endISO = endTime instanceof Date ? endTime.toISOString() : endTime;

    // Create a deterministic key from all components including username
    // Format: solar_audio_regions_username_spacecraft_dataset_startTime_endTime
    return `${STORAGE_KEY_PREFIX}${username}_${spacecraft}_${dataType}_${startISO}_${endISO}`;
}

/**
 * Get current data type/dataset from metadata (not UI)
 * Uses the actual dataset that was fetched, not what's shown in the dropdown
 */
function getCurrentDataType() {
    // Use the actual dataset from metadata - this is set during data fetch
    // and reflects the real data being viewed, not just UI state
    if (State.currentMetadata && State.currentMetadata.dataset) {
        return State.currentMetadata.dataset;
    }
    // Fallback to UI if metadata not available (shouldn't happen after data fetch)
    const dataTypeSelect = document.getElementById('dataType');
    return dataTypeSelect ? dataTypeSelect.value : null;
}

/**
 * Get the current storage key based on spacecraft, data type, and time range
 * Always uses metadata values (not cached currentSpacecraft) for accuracy
 */
function getCurrentStorageKey() {
    // Always use getCurrentSpacecraft() which reads from metadata
    // Don't use the cached currentSpacecraft variable - it may be stale
    const spacecraft = getCurrentSpacecraft();
    const dataType = getCurrentDataType();
    const startTime = State.dataStartTime;
    const endTime = State.dataEndTime;

    return generateStorageKey(spacecraft, dataType, startTime, endTime);
}

// Button positions are recalculated on every click - no caching needed
// This ensures positions are always fresh and immune to resize timing, DPR changes, etc.

/**
 * Get the current spacecraft from metadata (not UI)
 * Uses the actual spacecraft that was fetched, not what's shown in the dropdown
 */
function getCurrentSpacecraft() {
    // Use the actual spacecraft from metadata - this is set during data fetch
    // and reflects the real data being viewed, not just UI state
    if (State.currentMetadata && State.currentMetadata.spacecraft) {
        return State.currentMetadata.spacecraft;
    }
    // Fallback to UI if metadata not available
    const spacecraftSelect = document.getElementById('spacecraft');
    return spacecraftSelect ? spacecraftSelect.value : null;
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
 * Get regions for the current spacecraft
 * Uses metadata (actual loaded data) as source of truth
 */
export function getCurrentRegions() {
    // Always use getCurrentSpacecraft() which reads from metadata
    // Don't use the cached currentSpacecraft variable - it may be stale
    const spacecraft = getCurrentSpacecraft();
    if (!spacecraft) {
        return [];
    }
    if (!regionsBySpacecraft.has(spacecraft)) {
        regionsBySpacecraft.set(spacecraft, []);
    }
    return regionsBySpacecraft.get(spacecraft);
}

/**
 * Save regions to localStorage (persists across page reloads)
 * Uses hash-based key: spacecraft + dataType + startTime + endTime
 * This ensures features are associated with the exact data they were created on
 */
function saveRegionsToStorage(spacecraft, regions) {
    if (!spacecraft) return;

    try {
        // Use hash-based storage key for precise data association
        const storageKey = getCurrentStorageKey();
        if (!storageKey) {
            console.warn('⚠️ Cannot save regions - storage key not available (missing data type or time range)');
            return;
        }

        // For hash-based keys, we don't merge - each data fetch has its own storage
        // Simply save the current regions for this specific data fetch
        const dataToSave = {
            spacecraft: spacecraft,
            dataType: getCurrentDataType(),
            startTime: State.dataStartTime?.toISOString(),
            endTime: State.dataEndTime?.toISOString(),
            regions: regions,
            savedAt: new Date().toISOString()
        };
        localStorage.setItem(storageKey, JSON.stringify(dataToSave));

        console.log(`💾 Saved ${regions.length} region(s) to localStorage with key: ${storageKey}`);
    } catch (error) {
        console.error('❌ Failed to save regions to localStorage:', error);
        // localStorage might be full or disabled - continue without persistence
    }
}

/**
 * Load regions from localStorage (restores after page reload)
 * Uses hash-based key: spacecraft + dataType + startTime + endTime
 * Since the key is unique per data fetch, no filtering is needed
 */
function loadRegionsFromStorage(spacecraft) {
    if (!spacecraft) return null;

    try {
        // Use hash-based storage key for precise data association
        const storageKey = getCurrentStorageKey();
        if (!storageKey) {
            console.log(`📂 Skipping region load for ${spacecraft} - storage key not available yet`);
            return null;
        }

        const stored = localStorage.getItem(storageKey);

        if (!stored) {
            console.log(`📂 No saved regions found for key: ${storageKey}`);
            return null;
        }

        const data = JSON.parse(stored);
        if (data && data.regions && Array.isArray(data.regions)) {
            // With hash-based keys, regions are already specific to this exact data fetch
            // No filtering needed - just validate that regions have valid time ranges
            const validRegions = data.regions.filter(region => {
                // Check if region is valid (start < end)
                if (region.startTime && region.stopTime) {
                    const regionStartMs = new Date(region.startTime).getTime();
                    const regionEndMs = new Date(region.stopTime).getTime();
                    if (regionStartMs >= regionEndMs) {
                        console.warn(`⚠️ Filtering out region ${region.id}: invalid time range (start >= end)`);
                        return false;
                    }
                }
                return true;
            });

            console.log(`📂 Loaded ${validRegions.length} region(s) from localStorage with key: ${storageKey}`);
            return validRegions;
        }
    } catch (error) {
        console.error('❌ Failed to load regions from localStorage:', error);
    }

    return null;
}

/**
 * Set regions for the current spacecraft
 * Uses currentSpacecraft if set, otherwise reads from UI
 * Also saves to localStorage for persistence
 */
function setCurrentRegions(newRegions) {
    // Use currentSpacecraft if available (more reliable during spacecraft switches)
    // Otherwise fall back to reading from UI
    const spacecraft = currentSpacecraft || getCurrentSpacecraft();
    if (!spacecraft) {
        return;
    }
    regionsBySpacecraft.set(spacecraft, newRegions);
    
    // ✅ Save to localStorage for persistence (includes notes!)
    saveRegionsToStorage(spacecraft, newRegions);
}

/**
 * Switch to a different spacecraft's regions
 * Called when spacecraft selection changes
 * Note: This is called AFTER the UI select has already changed to the new spacecraft
 * @param {string} newSpacecraft - The spacecraft to switch to
 * @param {boolean} delayRender - If true, don't render regions immediately (wait for crossfade)
 */
export function switchSpacecraftRegions(newSpacecraft, delayRender = false) {
    if (!newSpacecraft) {
        console.warn('⚠️ Cannot switch: no spacecraft specified');
        return;
    }
    
    // Save current regions before switching (if we have a current spacecraft and it's different)
    // Since getCurrentRegions() now uses currentSpacecraft when available, we can safely get the old spacecraft's regions
    if (currentSpacecraft && currentSpacecraft !== newSpacecraft) {
        // Get the current regions (for the old spacecraft) and save them
        const oldRegions = getCurrentRegions();
        regionsBySpacecraft.set(currentSpacecraft, oldRegions);
    }
    
    // Clear active region indices when switching spacecraft
    activeRegionIndex = null;
    activePlayingRegionIndex = null;
    
    // Clear selection state when switching spacecraft (selections should NOT persist)
    // Only regions are saved per spacecraft, not selections
    State.setSelectionStart(null);
    State.setSelectionEnd(null);
    State.setSelectionStartX(null);
    State.setIsSelecting(false);
    hideAddRegionButton();
    updateWorkletSelection(); // Clear selection in worklet
    
    // Update current spacecraft
    currentSpacecraft = newSpacecraft;
    
    // Initialize empty array for new spacecraft (regions will be loaded AFTER Fetch Data is clicked)
    // Don't load regions here - they should only load after data fetch completes
    if (!regionsBySpacecraft.has(newSpacecraft)) {
        regionsBySpacecraft.set(newSpacecraft, []);
        console.log(`📂 Initialized empty region array for ${newSpacecraft} (will load after Fetch Data)`);
    }
    
    // 🔧 FIX: Delay region rendering until waveform crossfade completes
    if (delayRender) {
        // Don't render regions yet - wait for crossfade to complete
        // Regions will be rendered when waveform crossfade finishes
        regionsDelayedForCrossfade = true;
        console.log('⏳ Delaying region rendering until waveform crossfade completes');
    } else {
        // Re-render regions for the new spacecraft (will be empty until data is fetched)
        renderRegions();
        
        // Clear canvas feature boxes (no regions loaded yet)
        redrawAllCanvasFeatureBoxes();
        
        // Redraw waveform to update region highlights
        drawWaveformWithSelection();
        
        // Clear delay flag since we rendered immediately
        regionsDelayedForCrossfade = false;
    }
    
    if (!isStudyMode()) {
        console.log(`🌋 Switched to spacecraft: ${newSpacecraft} (${regionsBySpacecraft.get(newSpacecraft).length} regions)`);
    }
}

/**
 * Render regions after waveform crossfade completes
 * Called when loading new spacecraft data to delay region display until crossfade finishes
 */
export function renderRegionsAfterCrossfade() {
    // Only render if regions were actually delayed
    if (regionsDelayedForCrossfade) {
        renderRegions();
        redrawAllCanvasFeatureBoxes();
        drawWaveformWithSelection();
        regionsDelayedForCrossfade = false; // Clear flag
        console.log('✅ Regions rendered after waveform crossfade completed');
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
 * Load regions from storage after data fetch completes
 * Call this after State.dataStartTime and State.dataEndTime are set
 * Prioritizes pending shared regions (from shared links) over localStorage
 */
export function loadRegionsAfterDataFetch() {
    const spacecraft = getCurrentSpacecraft();
    if (!spacecraft) {
        console.warn('⚠️ Cannot load regions - no spacecraft selected');
        return;
    }

    // 🔧 CRITICAL: Always clear in-memory regions first before loading
    // This ensures old regions from previous data don't persist
    regionsBySpacecraft.set(spacecraft, []);

    // Check for pending shared regions first (from shared links)
    let loadedRegions = null;
    let loadedFromShareLink = false;
    const pendingSharedRegions = sessionStorage.getItem('pendingSharedRegions');

    // Start region loading group (will be closed after all loading logs)
    const regionGroupOpen = logGroup('regions', `Loading regions for ${spacecraft}`);

    if (pendingSharedRegions) {
        try {
            loadedRegions = JSON.parse(pendingSharedRegions);
            loadedFromShareLink = true;
            console.log(`🔗 From share link: ${loadedRegions.length} region(s)`);
            // Clear the pending regions so they don't load again
            sessionStorage.removeItem('pendingSharedRegions');
        } catch (e) {
            console.error('Failed to parse pending shared regions:', e);
            sessionStorage.removeItem('pendingSharedRegions');
        }
    }

    // Fall back to localStorage if no shared regions
    if (!loadedRegions) {
        loadedRegions = loadRegionsFromStorage(spacecraft);
    }
    if (loadedRegions && loadedRegions.length > 0) {
        // 🔧 CRITICAL FIX: Recalculate sample indices from timestamps!
        // Sample indices are relative to the current data fetch and MUST be recalculated
        // otherwise regions will drift when data is re-fetched with a different time range
        loadedRegions.forEach(region => {
            if (region.startTime && region.stopTime && zoomState.isInitialized()) {
                // Recalculate sample indices from absolute timestamps
                const dataStartMs = State.dataStartTime.getTime();
                const dataEndMs = State.dataEndTime.getTime();
                const regionStartMs = new Date(region.startTime).getTime();
                const regionEndMs = new Date(region.stopTime).getTime();
                
                // 🔥 GUARD: Clamp region to data bounds if it extends beyond
                // This prevents rendering regions that go "over the edge"
                let clampedStartMs = Math.max(regionStartMs, dataStartMs);
                let clampedEndMs = Math.min(regionEndMs, dataEndMs);
                
                // If clamping changed the region, update it
                if (clampedStartMs !== regionStartMs || clampedEndMs !== regionEndMs) {
                    console.warn(`⚠️ Region ${region.id} extends beyond data bounds - clamping:`, {
                        original: `${new Date(regionStartMs).toISOString()} → ${new Date(regionEndMs).toISOString()}`,
                        clamped: `${new Date(clampedStartMs).toISOString()} → ${new Date(clampedEndMs).toISOString()}`,
                        dataBounds: `${new Date(dataStartMs).toISOString()} → ${new Date(dataEndMs).toISOString()}`
                    });
                    // Update region timestamps to clamped values
                    region.startTime = new Date(clampedStartMs).toISOString();
                    region.stopTime = new Date(clampedEndMs).toISOString();
                }
                
                const regionStartSeconds = (clampedStartMs - dataStartMs) / 1000;
                const regionEndSeconds = (clampedEndMs - dataStartMs) / 1000;
                
                // Update sample indices for current data fetch
                const oldStartSample = region.startSample;
                const oldEndSample = region.endSample;
                region.startSample = zoomState.timeToSample(regionStartSeconds);
                region.endSample = zoomState.timeToSample(regionEndSeconds);
                
                if (!isStudyMode()) {
                    console.log(`🔧 Region ${region.id} timestamps: ${region.startTime} → ${region.stopTime}`);
                    console.log(`🔧 Recalculated samples: ${oldStartSample?.toLocaleString()} → ${region.startSample.toLocaleString()} (start)`);
                    console.log(`🔧 Recalculated samples: ${oldEndSample?.toLocaleString()} → ${region.endSample.toLocaleString()} (end)`);
                }
            }

            // Initialize missing fields for shared regions
            if (!region.features) {
                region.features = [{
                    type: 'Impulsive',
                    repetition: 'Unique',
                    lowFreq: '',
                    highFreq: '',
                    startTime: '',
                    endTime: '',
                    notes: '',
                    speedFactor: 1
                }];
            }
            if (region.featureCount === undefined) {
                region.featureCount = region.features.length || 1;
            }
            if (region.expanded === undefined) {
                region.expanded = false;
            }
            if (region.playing === undefined) {
                region.playing = false;
            }
        });
        
        regionsBySpacecraft.set(spacecraft, loadedRegions);
        console.log(`📂 Restored ${loadedRegions.length} region(s) from ${loadedFromShareLink ? 'share link' : 'localStorage'}`);

        // 🔗 CRITICAL: If regions came from share link, save them to localStorage
        // This ensures they persist across page refreshes after the URL is consumed
        if (loadedFromShareLink) {
            saveRegionsToStorage(spacecraft, loadedRegions);
            console.log(`💾 Saved to localStorage for future sessions`);
        }

        // 🔥 Render regions immediately (don't wait for crossfade)
        // Regions need to be visible as soon as data loads
        renderRegions();
        redrawAllCanvasFeatureBoxes();
        drawWaveformWithSelection();
        console.log('✅ Rendered');
        if (regionGroupOpen) logGroupEnd();

        // Update button states
        updateCompleteButtonState();
    } else {
        console.log(`📂 No saved regions found`);
        if (regionGroupOpen) logGroupEnd();
        // 🔧 CRITICAL: Still need to re-render to clear any old regions from display
        renderRegions();
        redrawAllCanvasFeatureBoxes();
        drawWaveformWithSelection();
        updateCompleteButtonState();
    }

    // Check for pending view settings (from shared links) and apply zoom after a delay
    const pendingViewSettings = sessionStorage.getItem('pendingSharedViewSettings');
    if (pendingViewSettings) {
        try {
            const viewSettings = JSON.parse(pendingViewSettings);
            sessionStorage.removeItem('pendingSharedViewSettings');

            const viewGroupOpen = logGroup('share', 'Restoring shared view settings');

            // Apply colormap if specified
            if (viewSettings.colormap) {
                console.log(`Colormap: ${viewSettings.colormap}`);
                const colormapSelect = document.getElementById('colormap');
                if (colormapSelect) {
                    colormapSelect.value = viewSettings.colormap;
                    changeColormap();
                }
            }

            // Apply FFT size if specified
            if (viewSettings.fft_size) {
                console.log(`FFT size: ${viewSettings.fft_size}`);
                const fftSizeSelect = document.getElementById('fftSize');
                if (fftSizeSelect) {
                    fftSizeSelect.value = viewSettings.fft_size.toString();
                    changeFftSize();
                }
            }

            // Apply frequency scale if specified
            if (viewSettings.frequency_scale) {
                console.log(`Frequency scale: ${viewSettings.frequency_scale}`);
                const freqScaleSelect = document.getElementById('frequencyScale');
                if (freqScaleSelect) {
                    freqScaleSelect.value = viewSettings.frequency_scale;
                    changeFrequencyScale();
                }
            }

            // Apply zoom after a 1-second delay to let the UI settle
            if (viewSettings.zoom && viewSettings.zoom.mode === 'region') {
                console.log(`Zoom: region ${viewSettings.zoom.region_id} (delayed 1s)`);
                setTimeout(() => {
                    // Find the region by ID and zoom to it
                    const regions = getCurrentRegions();
                    const regionIndex = regions.findIndex(r => r.id === viewSettings.zoom.region_id);
                    if (regionIndex !== -1) {
                        log('share', `Zoomed to region: ${viewSettings.zoom.region_id}`);
                        zoomToRegion(regionIndex);
                    } else {
                        log('share', 'Shared region not found, staying at full view');
                    }
                }, 1000);
            }

            if (viewGroupOpen) logGroupEnd();
        } catch (e) {
            console.error('Failed to parse pending view settings:', e);
            sessionStorage.removeItem('pendingSharedViewSettings');
        }
    }
}

/**
 * Initialize region tracker
 * Sets up event listeners and prepares UI
 * NOTE: Regions are NOT loaded here - they are only loaded after fetchData is called
 * This ensures we know the spacecraft and time range before loading regions
 */
export function initRegionTracker() {
    // Only log in dev/personal modes, not study mode
    if (!isStudyMode()) {
        console.log('🎯 Region tracker initialized');
    }
    
    // Initialize buttons renderer (must be after all variables are defined)
    initializeButtonsRenderer();
    
    // Initialize current spacecraft
    currentSpacecraft = getCurrentSpacecraft();
    if (currentSpacecraft) {
        // ✅ Start with empty regions - they will be loaded after fetchData is called
        // This ensures we know the time range before loading (regions outside range are filtered out)
        regionsBySpacecraft.set(currentSpacecraft, []);
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
    
    const canvasWidth = canvas.offsetWidth;
    
    // 🏛️ Use zoom-aware coordinate conversion (same as drawRegionHighlights)
    // This ensures the button position matches where the region will actually appear
    let startX, endX;
    if (zoomState.isInitialized()) {
        // Convert selection times to timestamps, then to pixels (same logic as region drawing)
        const dataStartMs = State.dataStartTime.getTime();
        const selectionStartMs = dataStartMs + (selectionStart * 1000);
        const selectionEndMs = dataStartMs + (selectionEnd * 1000);
        const selectionStartTimestamp = new Date(selectionStartMs);
        const selectionEndTimestamp = new Date(selectionEndMs);
        
        // Use interpolated time range for positioning (matches region drawing)
        const interpolatedRange = getInterpolatedTimeRange();
        const displayStartMs = interpolatedRange.startTime.getTime();
        const displayEndMs = interpolatedRange.endTime.getTime();
        const displaySpanMs = displayEndMs - displayStartMs;
        
        const startProgress = (selectionStartMs - displayStartMs) / displaySpanMs;
        const endProgress = (selectionEndMs - displayStartMs) / displaySpanMs;
        
        startX = startProgress * canvasWidth;
        endX = endProgress * canvasWidth;
    } else {
        // Fallback to old behavior if zoom state not initialized
        const startProgress = (selectionStart / State.totalAudioDuration);
        const endProgress = (selectionEnd / State.totalAudioDuration);
        startX = startProgress * canvasWidth;
        endX = endProgress * canvasWidth;
    }
    
    // Create or get button - attach to body for free-floating positioning
    if (!addRegionButton) {
        addRegionButton = document.createElement('button');
        addRegionButton.className = 'add-region-button';
        addRegionButton.textContent = 'Add Region (R)';
        document.body.appendChild(addRegionButton);
    }
    
    // Update onclick with NEW selection times every time
    addRegionButton.onclick = (e) => {
        e.stopPropagation();
        createRegionFromSelectionTimes(selectionStart, selectionEnd);
    };
    
    // Calculate button position based on viewport coordinates
    // Get canvas position in viewport
    const canvasRect = canvas.getBoundingClientRect();
    
    // Calculate center of selection in viewport coordinates
    const centerX = canvasRect.left + (startX + endX) / 2;
    const buttonTop = canvasRect.top - 39; // 39px above waveform top edge
    
    // Check if button is already visible and in a different position
    const isCurrentlyVisible = addRegionButton.style.display === 'block' && 
                               parseFloat(addRegionButton.style.opacity) > 0;
    const currentLeft = parseFloat(addRegionButton.style.left) || 0;
    const currentTop = parseFloat(addRegionButton.style.top) || 0;
    const positionChanged = Math.abs(currentLeft - centerX) > 1 || Math.abs(currentTop - buttonTop) > 1;
    
    if (isCurrentlyVisible && positionChanged) {
        // Fade out first, then move and fade in
        addRegionButton.style.transition = 'opacity 0.15s ease-out';
        addRegionButton.style.opacity = '0';
        
        setTimeout(() => {
            // 🔥 FIX: Check document connection before DOM manipulation
            if (!document.body || !document.body.isConnected || !addRegionButton) {
                return;
            }
            
            // Move to new position while invisible (viewport coordinates)
            addRegionButton.style.position = 'fixed';
            addRegionButton.style.left = centerX + 'px';
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
        addRegionButton.style.position = 'fixed';
        addRegionButton.style.left = centerX + 'px';
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
    
    // 🏛️ Convert selection times to absolute sample indices (the eternal truth)
    const startSample = zoomState.timeToSample(selectionStartSeconds);
    const endSample = zoomState.timeToSample(selectionEndSeconds);

    // Convert to real-world timestamps (for display/export)
    const startTimestamp = zoomState.sampleToRealTimestamp(startSample);
    const endTimestamp = zoomState.sampleToRealTimestamp(endSample);

    const startTime = startTimestamp ? startTimestamp.toISOString() : null;
    const endTime = endTimestamp ? endTimestamp.toISOString() : null;

    // Get current spacecraft's regions
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
        get activePlayingRegionIndex() { return activePlayingRegionIndex; },
        getRegionsDelayedForCrossfade: () => regionsDelayedForCrossfade
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
    
    // 🔥 Don't draw regions if they're delayed for crossfade
    if (regionsDelayedForCrossfade) {
        return; // Wait for crossfade to complete
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
        
        // 🏛️ ALWAYS use timestamps as source of truth (they're absolute and don't drift)
        // Sample indices are relative to a specific data fetch and become stale after reload
        let regionStartSeconds, regionEndSeconds;
        let conversionMethod = 'unknown';
        
        if (region.startTime && region.stopTime) {
            // Convert from absolute timestamps (source of truth!)
            const regionStartMs = new Date(region.startTime).getTime();
            const regionEndMs = new Date(region.stopTime).getTime();
            regionStartSeconds = (regionStartMs - dataStartMs) / 1000;
            regionEndSeconds = (regionEndMs - dataStartMs) / 1000;
            conversionMethod = 'timestamps';
        } else if (region.startSample !== undefined && region.endSample !== undefined) {
            // Old format fallback: convert from sample indices (may drift!)
            regionStartSeconds = zoomState.sampleToTime(region.startSample);
            regionEndSeconds = zoomState.sampleToTime(region.endSample);
            conversionMethod = 'samples';
            console.warn(`⚠️ Region ${index} using OLD sample-based positioning - may drift! Please recreate this region.`);
        } else {
            // No valid data - skip this region
            return;
        }
        
        // console.log(`   Drawing region ${index}: ${regionStartSeconds.toFixed(2)}s - ${regionEndSeconds.toFixed(2)}s`);

        // 🏛️ Use interpolated time range for pixel positioning (makes regions surf the zoom animation!)
        // This keeps region boundaries aligned with the interpolating tick marks
        let startX, endX;
        if (zoomState.isInitialized()) {
            // Get the current interpolated time range (same range the x-axis ticks are using)
            const interpolatedRange = getInterpolatedTimeRange();

            // 🔥 FIX: Use saved timestamps DIRECTLY (not sample conversions which accumulate rounding errors!)
            // This matches how features are positioned, ensuring regions and features stay in sync
            const regionStartTimestamp = new Date(region.startTime);
            const regionEndTimestamp = new Date(region.stopTime);

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
        // Convert region to seconds - ALWAYS use timestamps as source of truth
        let regionStartSeconds, regionEndSeconds;
        if (region.startTime && region.stopTime) {
            const dataStartMs = State.dataStartTime.getTime();
            const regionStartMs = new Date(region.startTime).getTime();
            const regionEndMs = new Date(region.stopTime).getTime();
            regionStartSeconds = (regionStartMs - dataStartMs) / 1000;
            regionEndSeconds = (regionEndMs - dataStartMs) / 1000;
        } else if (region.startSample !== undefined && region.endSample !== undefined) {
            // Old format fallback
            regionStartSeconds = zoomState.sampleToTime(region.startSample);
            regionEndSeconds = zoomState.sampleToTime(region.endSample);
        } else {
            return; // No valid data
        }
        
        // Use interpolated time range (same as waveform)
        let startX, endX;
        if (zoomState.isInitialized()) {
            const interpolatedRange = getInterpolatedTimeRange();
            // 🔥 TIMESTAMPS ONLY - never use stored sample indices (rolling window!)
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
    
    // Calculate region position - ALWAYS use timestamps as source of truth
    const dataStartMs = State.dataStartTime.getTime();
    let regionStartSeconds, regionEndSeconds;
    
    if (region.startTime && region.stopTime) {
        const regionStartMs = new Date(region.startTime).getTime();
        const regionEndMs = new Date(region.stopTime).getTime();
        regionStartSeconds = (regionStartMs - dataStartMs) / 1000;
        regionEndSeconds = (regionEndMs - dataStartMs) / 1000;
    } else if (region.startSample !== undefined && region.endSample !== undefined) {
        // Old format fallback
        regionStartSeconds = zoomState.sampleToTime(region.startSample);
        regionEndSeconds = zoomState.sampleToTime(region.endSample);
    } else {
        return null; // No valid data
    }
    
    // Calculate pixel positions (same logic as drawRegionHighlights)
    let startX, endX;
    if (zoomState.isInitialized()) {
        const interpolatedRange = getInterpolatedTimeRange();
        // 🔥 FIX: Use saved timestamps DIRECTLY (matches region & button rendering fix!)
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
            // 🔥 FIX: Use saved timestamps DIRECTLY (matches region & button rendering fix!)
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

    let regionIndex;
    let featureIndex;
    const regions = getCurrentRegions();

    // 🔥 FIX: Check if user explicitly clicked a button to reselect a specific feature
    if (currentFrequencySelection) {
        // User clicked a button - use that specific feature (reselection)
        regionIndex = currentFrequencySelection.regionIndex;
        featureIndex = currentFrequencySelection.featureIndex;
        console.log(`🎯 Using explicit selection: region ${regionIndex + 1}, feature ${featureIndex + 1}`);

        // Clear it so next draw creates a new feature (one-shot reselection)
        currentFrequencySelection = null;
        isSelectingFrequency = false;
    } else {
        // Auto-determine which feature to fill in
        // Find the active region and either use incomplete feature or create new one
        const activeRegionIndex = getActiveRegionIndex();
        if (activeRegionIndex === null) {
            console.warn('⚠️ No active region - cannot create feature');
            return;
        }

        const region = regions[activeRegionIndex];
        if (!region) {
            console.warn('⚠️ Active region not found');
            return;
        }

        // Find first incomplete feature, or we'll create a new one
        featureIndex = region.features.findIndex(feature =>
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

        regionIndex = activeRegionIndex;
        console.log(`🎯 Auto-selected feature: region ${regionIndex + 1}, feature ${featureIndex + 1}`);
    }
    
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

    // Use same source as Y-axis for consistency
    const originalNyquist = State.originalDataFrequencyRange?.max || 50;

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
    // Use a very low minFreq for region drawing to allow selecting any frequency
    // This is independent of the axis display minFreq
    const minFreq = 0.001;

    if (scaleType === 'logarithmic') {
        // Use low minFreq for full frequency range selection
        const logMin = Math.log10(minFreq);
        const logMax = Math.log10(maxFreq);
        const logRange = logMax - logMin;

        // Calculate stretch factor using SAME formula as calculateStretchFactorForLog
        const targetMaxFreq = maxFreq / playbackRate;  // DIVISION, not multiplication!
        const logTargetMax = Math.log10(Math.max(targetMaxFreq, minFreq));
        const targetLogRange = logTargetMax - logMin;
        const fraction = targetLogRange / logRange;
        const stretchFactor = 1 / fraction;

        // Reverse: heightFromBottom_scaled → heightFromBottom_1x
        const heightFromBottom_scaled = canvasHeight - y;
        const heightFromBottom_1x = heightFromBottom_scaled / stretchFactor;

        // Convert heightFromBottom_1x back to frequency (in ORIGINAL scale, no playback!)
        const normalizedLog = heightFromBottom_1x / canvasHeight;
        const logFreq = logMin + (normalizedLog * (logMax - logMin));
        const freq = Math.pow(10, logFreq);

        // CLAMP to valid range [0, maxFreq] - allow full frequency range
        return Math.max(0, Math.min(maxFreq, freq));
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

            // CLAMP to valid range [0, maxFreq] - allow full frequency range
            return Math.max(0, Math.min(maxFreq, freq));
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
 * Displays in UTC for space physics data
 */
function formatTime(isoString) {
    const date = new Date(isoString);
    // Get UTC time components
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

/**
 * Format time for display with seconds (H:MM:SS format, no leading zero on hours if < 10)
 * Displays in UTC for space physics data
 */
function formatTimeWithSeconds(isoString) {
    const date = new Date(isoString);

    // Get UTC time components
    const hours = date.getUTCHours(); // UTC hours (0-23), no padding - single digit for 0-9
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
 * Active region (if any) is always displayed first, but keeps its original number
 */
function renderRegions() {
    const container = document.getElementById('regionsList');
    if (!container) return;
    
    const regions = getCurrentRegions();
    
    // Build array with original indices preserved
    const regionsWithIndex = regions.map((region, originalIndex) => ({
        region,
        originalIndex
    }));
    
    // Sort: active region first, then others in original order
    const sortedRegions = [...regionsWithIndex];
    if (activeRegionIndex !== null && activeRegionIndex >= 0 && activeRegionIndex < regions.length) {
        const activeRegion = sortedRegions[activeRegionIndex];
        if (activeRegion) {
            sortedRegions.splice(activeRegionIndex, 1);
            sortedRegions.unshift(activeRegion);
        }
    }
    
    // Check if we can reorder existing cards (smooth transition)
    const existingCards = Array.from(container.children);
    const cardMap = new Map();
    existingCards.forEach(card => {
        const regionId = card.dataset.regionId;
        if (regionId) {
            cardMap.set(regionId, card);
        }
    });
    
    // If we have all cards and count matches, reorder them smoothly
    const canReorder = existingCards.length === regions.length && 
                       sortedRegions.every(({ region }) => cardMap.has(String(region.id)));
    
    // Debug: Check if we're actually reordering
    // if (canReorder && activeRegionIndex !== null) {
    //     const firstRegionId = sortedRegions[0]?.region?.id;
    //     const firstCardId = existingCards[0]?.dataset?.regionId;
    //     if (firstRegionId !== firstCardId) {
    //         console.log(`🔄 Reordering regions: active region will move to top (animation: ${ANIMATE_REGION_REORDER ? 'ON' : 'OFF'})`);
    //     }
    // }
    
    if (canReorder) {
        // Get current order of cards in DOM
        const currentOrder = Array.from(container.children).map(card => card.dataset.regionId);
        
        // Get target order
        const targetOrder = sortedRegions.map(({ region }) => String(region.id));
        
        // Check if reordering is actually needed
        const needsReorder = currentOrder.some((id, index) => id !== targetOrder[index]);
        
        if (needsReorder && ANIMATE_REGION_REORDER) {
            // 🎨 ANIMATED MODE: Smooth slide animation
            // console.log('🔄 Animating region reorder...', {
            //     currentOrder: currentOrder,
            //     targetOrder: targetOrder,
            //     activeRegionIndex
            // });
            
            // Store current positions using getBoundingClientRect (more reliable)
            const containerRect = container.getBoundingClientRect();
            const cardPositions = new Map();
            const cardHeights = new Map();
            
            existingCards.forEach((card, index) => {
                const regionId = card.dataset.regionId;
                if (regionId) {
                    const rect = card.getBoundingClientRect();
                    // Position relative to container top
                    const relativeTop = rect.top - containerRect.top + container.scrollTop;
                    cardPositions.set(regionId, relativeTop);
                    cardHeights.set(regionId, rect.height);
                    // console.log(`  Current: Card ${regionId} at position ${index}, top: ${relativeTop.toFixed(0)}px`);
                }
            });
            
            // Update card content first (without reordering)
            sortedRegions.forEach(({ region, originalIndex }) => {
                const card = cardMap.get(String(region.id));
                if (card) {
                    // Update active class based on whether this is the active region
                    const isActive = originalIndex === activeRegionIndex;
                    if (isActive) {
                        card.classList.add('active');
                    } else {
                        card.classList.remove('active');
                    }
                    // Update region number display (preserve original index)
                    const regionLabel = card.querySelector('.region-label');
                    if (regionLabel) {
                        regionLabel.textContent = `${isMobileScreen() ? 'Reg' : 'Region'} ${originalIndex + 1}`;
                    }
                    // Update data attributes for event handlers
                    updateRegionCardDataAttributes(card, originalIndex);
                }
            });
            
            // Calculate target positions - cards stack from first card's current position
            const marginBottom = 6; // From CSS: margin-bottom: 6px
            const targetPositions = new Map();
            let currentY = cardPositions.get(existingCards[0]?.dataset?.regionId) || 0;
            
            sortedRegions.forEach(({ region }, index) => {
                const card = cardMap.get(String(region.id));
                if (card) {
                    const height = cardHeights.get(String(region.id)) || card.getBoundingClientRect().height;
                    targetPositions.set(String(region.id), currentY);
                    // console.log(`  Target: Card ${region.id} at position ${index}, top: ${currentY.toFixed(0)}px`);
                    currentY += height + marginBottom;
                }
            });
            
            // Set transforms to current positions BEFORE reordering
            sortedRegions.forEach(({ region }) => {
                const card = cardMap.get(String(region.id));
                if (!card) return;
                
                const oldTop = cardPositions.get(String(region.id));
                const targetTop = targetPositions.get(String(region.id));
                
                if (oldTop !== undefined && targetTop !== undefined) {
                    const deltaY = oldTop - targetTop;
                    // console.log(`  Card ${region.id}: deltaY = ${deltaY.toFixed(0)}px (from ${oldTop.toFixed(0)} to ${targetTop.toFixed(0)})`);
                    
                    if (Math.abs(deltaY) > 1) {
                        // Set transform to maintain current visual position
                        card.style.transform = `translateY(${deltaY}px)`;
                        card.style.transition = 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
                    }
                }
            });
            
            // Force reflow to apply transforms
            void container.offsetHeight;
            
            // Now reorder DOM nodes
            sortedRegions.forEach(({ region }) => {
                const card = cardMap.get(String(region.id));
                if (card) {
                    container.appendChild(card);
                }
            });
            
            // Animate to final position
            requestAnimationFrame(() => {
                sortedRegions.forEach(({ region }) => {
                    const card = cardMap.get(String(region.id));
                    if (card && card.style.transform) {
                        // console.log(`  Animating card ${region.id} to final position`);
                        card.style.transform = 'translateY(0)';
                        
                        // Clean up after animation completes
                        setTimeout(() => {
                            card.style.transition = '';
                            card.style.transform = '';
                        }, 500);
                    }
                });
            });
        } else if (needsReorder && !ANIMATE_REGION_REORDER) {
            // 🎨 INSTANT MODE: Just reorder immediately without animation
            // console.log('🔄 Instantly reordering regions (animation disabled)');
            
            // Update card content first
            sortedRegions.forEach(({ region, originalIndex }) => {
                const card = cardMap.get(String(region.id));
                if (card) {
                    // Update active class based on whether this is the active region
                    const isActive = originalIndex === activeRegionIndex;
                    if (isActive) {
                        card.classList.add('active');
                    } else {
                        card.classList.remove('active');
                    }
                    // Update region number display (preserve original index)
                    const regionLabel = card.querySelector('.region-label');
                    if (regionLabel) {
                        regionLabel.textContent = `${isMobileScreen() ? 'Reg' : 'Region'} ${originalIndex + 1}`;
                    }
                    // Update data attributes for event handlers
                    updateRegionCardDataAttributes(card, originalIndex);
                }
            });
            
            // Instantly reorder DOM nodes
            sortedRegions.forEach(({ region }) => {
                const card = cardMap.get(String(region.id));
                if (card) {
                    container.appendChild(card);
                }
            });
        } else {
            // No reordering needed, just update content
            sortedRegions.forEach(({ region, originalIndex }) => {
                const card = cardMap.get(String(region.id));
                if (card) {
                    // Update active class based on whether this is the active region
                    const isActive = originalIndex === activeRegionIndex;
                    if (isActive) {
                        card.classList.add('active');
                    } else {
                        card.classList.remove('active');
                    }
                    const regionLabel = card.querySelector('.region-label');
                    if (regionLabel) {
                        regionLabel.textContent = `${isMobileScreen() ? 'Reg' : 'Region'} ${originalIndex + 1}`;
                    }
                    updateRegionCardDataAttributes(card, originalIndex);
                }
            });
        }
    } else {
        // Recreate all cards (new regions or count changed)
        container.innerHTML = '';
        sortedRegions.forEach(({ region, originalIndex }) => {
            const regionCard = createRegionCard(region, originalIndex);
            container.appendChild(regionCard);
        });
    }
    
    // Region highlights are drawn by waveform-renderer.js, no need to call here
}

/**
 * Update data attributes on region card elements to use correct index
 * Event handlers are already bound via closures, so we just update data attributes
 */
function updateRegionCardDataAttributes(card, index) {
    // Update all data-region-index attributes
    const elementsWithIndex = card.querySelectorAll('[data-region-index]');
    elementsWithIndex.forEach(el => {
        el.dataset.regionIndex = index;
    });
}

/**
 * Create a region card element
 */
function createRegionCard(region, index) {
    const card = document.createElement('div');
    // Add 'active' class if this is the active region
    const isActive = index === activeRegionIndex;
    card.className = `region-card${isActive ? ' active' : ''}`;
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
        <span class="region-label">${isMobileScreen() ? 'Reg' : 'Region'} ${index + 1}</span>
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
    if (!region) {
        console.warn(`⚠️ renderFeatures: Region at index ${regionIndex} not found`);
        return;
    }

    // Initialize features array if missing (fallback - should be handled in loadRegionsAfterDataFetch)
    if (!region.features) {
        console.warn(`⚠️ renderFeatures: Region ${region.id} missing features array - initializing`);
        region.features = [];
    }
    if (region.featureCount === undefined) {
        region.featureCount = 1;
    }

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
            // Tab to next feature's notes field (wrap to first)
            if (event.key === 'Tab' && !event.shiftKey) {
                event.preventDefault();
                const nextNotesField = document.getElementById(`notes-${regionIndex}-${featureIndex + 1}`);
                if (nextNotesField) {
                    nextNotesField.focus();
                } else {
                    // Wrap to first feature
                    const firstNotesField = document.getElementById(`notes-${regionIndex}-0`);
                    if (firstNotesField) firstNotesField.focus();
                }
            }
            // Shift+Tab to previous feature's notes field (wrap to last)
            if (event.key === 'Tab' && event.shiftKey) {
                event.preventDefault();
                const prevNotesField = document.getElementById(`notes-${regionIndex}-${featureIndex - 1}`);
                if (prevNotesField) {
                    prevNotesField.focus();
                } else {
                    // Wrap to last feature
                    let lastIndex = 0;
                    while (document.getElementById(`notes-${regionIndex}-${lastIndex + 1}`)) lastIndex++;
                    const lastNotesField = document.getElementById(`notes-${regionIndex}-${lastIndex}`);
                    if (lastNotesField) lastNotesField.focus();
                }
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
    // 🏛️ ALWAYS use timestamps as source of truth (sample indices drift after reload)
    let regionStartSeconds, regionEndSeconds;
    
    if (region.startTime && region.stopTime) {
        // Convert from absolute timestamps (source of truth!)
        const dataStartMs = State.dataStartTime.getTime();
        const regionStartMs = new Date(region.startTime).getTime();
        const regionEndMs = new Date(region.stopTime).getTime();
        regionStartSeconds = (regionStartMs - dataStartMs) / 1000;
        regionEndSeconds = (regionEndMs - dataStartMs) / 1000;
    } else if (region.startSample !== undefined && region.endSample !== undefined) {
        // Old format fallback
        regionStartSeconds = zoomState.sampleToTime(region.startSample);
        regionEndSeconds = zoomState.sampleToTime(region.endSample);
    } else {
        return false; // No valid data
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
        
        // Note: We don't auto-start selection here - it caused bugs when drawing rapidly
        // zoomToRegion handles auto-selecting incomplete features when entering a region
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
    renumberFeatureBoxes(regionIndex);
    
    // 🎨 Rebuild canvas boxes (handles deletion and renumbering automatically!)
    removeCanvasFeatureBox(regionIndex, featureIndex);

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

        // If user is currently zoomed into this region, zoom out first
        if (zoomState.isInRegion() && zoomState.getCurrentRegionId() === deletedRegion.id) {
            zoomToFull();
        }

        regions.splice(index, 1);
        setCurrentRegions(regions);
        if (activeRegionIndex === index) {
            activeRegionIndex = null;
        } else if (activeRegionIndex > index) {
            activeRegionIndex--;
        }
        renderRegions();
        
        // ✅ Rebuild canvas boxes (removes boxes for deleted region!)
        redrawAllCanvasFeatureBoxes();
        
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
    
    // 🏛️ Handle backward compatibility: if region doesn't have timestamps, we can't zoom
    if (!region.startTime || !region.stopTime) {
        console.warn('⚠️ Cannot zoom: region missing timestamps (old format). Please recreate this region.');
        return;
    }

    // 📱 Mobile: Enable touch drawing on spectrogram when zoomed in
    updateSpectrogramTouchMode(true);

    // Timestamps calculated from region.startTime/stopTime (our only source of truth!)
    const dataStartMs = State.dataStartTime.getTime();
    const dataEndMs = State.dataEndTime.getTime();
    const regionStartMs = new Date(region.startTime).getTime();
    const regionEndMs = new Date(region.stopTime).getTime();
    
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
    
    // 🙏 Timestamps as a source of truth: Calculate seconds from timestamps
    const regionStartSeconds = (regionStartMs - dataStartMs) / 1000;
    const regionEndSeconds = (regionEndMs - dataStartMs) / 1000;

    // 🎯 MAGIC TRICK: Predictive rendering with smart quality zones!
    // Detect zoom direction and calculate expanded render window
    // 🔥 FIX: Get current visual position (where we are NOW, even mid-transition)
    const currentPosition = isZoomTransitionInProgress() 
        ? getInterpolatedTimeRange() 
        : (zoomState.isInRegion() 
            ? zoomState.getRegionRange() 
            : { startTime: State.dataStartTime, endTime: State.dataEndTime });
    
    const regionCenter = (regionStartSeconds + regionEndSeconds) / 2;
    const regionDuration = regionEndSeconds - regionStartSeconds;
    const oldStartSeconds = (currentPosition.startTime.getTime() - dataStartMs) / 1000;
    const oldEndSeconds = (currentPosition.endTime.getTime() - dataStartMs) / 1000;
    const oldDuration = oldEndSeconds - oldStartSeconds;
    const oldCenter = (oldStartSeconds + oldEndSeconds) / 2;
    
    // Where is region center relative to current viewport center?
    const relativePos = (regionCenter - oldCenter) / oldDuration;
    
    let expandedStartSeconds, expandedEndSeconds, zoomDirection;
    if (relativePos < -0.2) {
        // Coming from LEFT edge → render center + right (2x)
        zoomDirection = 'left';
        expandedStartSeconds = regionStartSeconds;
        expandedEndSeconds = regionEndSeconds + regionDuration;
        // console.log('🎯 Zoom from LEFT: rendering target + right buffer (2x)');
    } else if (relativePos > 0.2) {
        // Coming from RIGHT edge → render left + center (2x)
        zoomDirection = 'right';
        expandedStartSeconds = regionStartSeconds - regionDuration;
        expandedEndSeconds = regionEndSeconds;
        // console.log('🎯 Zoom from RIGHT: rendering left buffer + target (2x)');
    } else {
        // CENTER or unknown → render left + center + right (3x) to be safe
        zoomDirection = 'center';
        expandedStartSeconds = regionStartSeconds - regionDuration;
        expandedEndSeconds = regionEndSeconds + regionDuration;
        // console.log('🎯 Zoom from CENTER: rendering left + target + right (3x)');
    }
    
    // Clamp to data bounds
    const dataStartSeconds = 0;
    const dataEndSeconds = (State.dataEndTime.getTime() - dataStartMs) / 1000;
    expandedStartSeconds = Math.max(dataStartSeconds, expandedStartSeconds);
    expandedEndSeconds = Math.min(dataEndSeconds, expandedEndSeconds);

    // Set viewport to region timestamps directly
    // No sample calculations - just store the eternal timestamps
    zoomState.setViewportToRegion(region.startTime, region.stopTime, region.id);

    // console.log('🔍 ========== ZOOM DIAGNOSTIC ==========');
    // console.log('📅 Region timestamps:', {
    //     startTime: region.startTime,
    //     stopTime: region.stopTime,
    //     regionStartMs,
    //     regionEndMs
    // });
    // console.log('📅 Data time range:', {
    //     dataStartTime: State.dataStartTime.toISOString(),
    //     dataEndTime: State.dataEndTime.toISOString(),
    //     dataStartMs,
    //     dataEndMs: State.dataEndTime.getTime()
    // });
    // console.log('👑 Viewport set to timestamps (samples calculated on-the-fly)');
    // console.log('🔍 ========================================');
    
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

    State.setSelectionStart(null);
    State.setSelectionEnd(null);
    updateWorkletSelection();
    
    setActiveRegion(regionIndex);
    
    // Reorder regions list so active region is at top (smooth slide animation)
    renderRegions();
    
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

    // 🔥 FIX: Use timestamps directly instead of converting from samples
    const newStartTime = new Date(region.startTime);
    const newEndTime = new Date(region.stopTime);

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
    
    // 🔬 START SMART PREDICTIVE RENDER IN BACKGROUND (don't wait!)
    // console.log('🔬 Passing to renderCompleteSpectrogramForRegion with smart window:', {
    //     target: `${regionStartSeconds.toFixed(2)}s - ${regionEndSeconds.toFixed(2)}s`,
    //     expanded: `${expandedStartSeconds.toFixed(2)}s - ${expandedEndSeconds.toFixed(2)}s`,
    //     direction: zoomDirection,
    //     regionId: region.id
    // });
    const renderPromise = renderCompleteSpectrogramForRegion(
        regionStartSeconds,
        regionEndSeconds,
        true,  // renderInBackground = true
        region.id,  // Pass region ID for tracking
        {
            // 🎯 Smart predictive rendering with quality zones
            expandedStart: expandedStartSeconds,
            expandedEnd: expandedEndSeconds,
            direction: zoomDirection
        }
    );
    
    // 🎬 Animate with elastic friend - no waiting!
    // console.log('🎬 ⏱️ ZOOM ANIMATION START:', performance.now().toFixed(0) + 'ms');
    animateZoomTransition(oldStartTime, oldEndTime, true).then(() => {
        // console.log('🎬 ⏱️ ZOOM ANIMATION COMPLETE:', performance.now().toFixed(0) + 'ms');
        
        // Clear smart render flag when animation completes
        clearSmartRenderBounds();
        // console.log('🎯 Cleared smart render bounds after zoom complete');
        
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
        updateAllFeatureBoxPositions();

        // 🎯 CRITICAL: Redraw x-axis so tick density updates for the new region!
        drawWaveformXAxis();

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
                updateAllFeatureBoxPositions();
                
                // 🔍 Diagnostic: Track region zoom complete
                // console.log('✅ REGION ZOOM IN complete');
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
    // console.log('🔍 [ZOOM_TO_FULL DEBUG] zoomToFull() called');
    // console.log('🔍 [ZOOM_TO_FULL DEBUG] State.waitingForZoomOut:', State.waitingForZoomOut);
    // console.log('🔍 [ZOOM_TO_FULL DEBUG] State._zoomOutResolve exists:', !!State._zoomOutResolve);

    // 🎓 Tutorial: Resolve promise if waiting for zoom out
    if (State.waitingForZoomOut && State._zoomOutResolve) {
        // console.log('🔍 [ZOOM_TO_FULL DEBUG] Resolving tutorial zoom out promise');
        State.setWaitingForZoomOut(false);
        const resolve = State._zoomOutResolve;
        State.setZoomOutResolve(null);
        resolve();
    }

    if (!zoomState.isInitialized()) {
        // console.log('🔍 [ZOOM_TO_FULL DEBUG] zoomState not initialized - returning early');
        return;
    }

    // 📱 Mobile: Disable touch drawing, allow scrolling when zoomed out
    updateSpectrogramTouchMode(false);

    // console.log('🔍 [ZOOM_TO_FULL DEBUG] Continuing with zoom out...');

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

    // 🔍 DIAGNOSTIC: Log canvas states BEFORE zoom-out starts
    console.log(`🔍 ZOOM OUT START - Canvas states:`, {
        infiniteCanvas: getInfiniteCanvasStatus ? getInfiniteCanvasStatus() : 'NO STATUS FUNCTION',
        cachedFull: getCachedFullStatus ? getCachedFullStatus() : 'NO STATUS FUNCTION'
    });

    // 🙏 Timestamps as source of truth: Return viewport to full data range
    // No sample calculations - just restore the eternal timestamp boundaries
    zoomState.setViewportToFull();
    
    // Update submit button visibility (hide when zoomed out)
    if (typeof window.updateSubmitButtonVisibility === 'function') {
        window.updateSubmitButtonVisibility();
    }
    
    // 🔧 FIX: Clear active region to prevent UI confusion after zoom-out
    activeRegionIndex = null;
    
    // Restore original region order (smooth slide animation)
    renderRegions();
    
    // Collapse all region panels and disable feature selection mode
    collapseAllRegions();
    stopFrequencySelection();
    
    // 🦋 Update worklet boundaries AFTER exiting temple
    // If activePlayingRegionIndex is set, boundaries will still be the region
    // Otherwise, boundaries will be full audio
    updateWorkletSelection();

    // 🔧 FIX: DON'T reset spectrogram state yet - keep infiniteCanvas visible!
    // We'll clear it AFTER the fade-in completes (in animation completion handler)
    // resetSpectrogramState(); // <-- Moved to after animation

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
        
        // DON'T reset spectrogram state - we just restored it!
        // The spectrogram is fully functional and initialized after zoom out
        // import('./spectrogram-complete-renderer.js').then(module => {
        //     module.resetSpectrogramState();
        // });
        
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
        updateAllFeatureBoxPositions();

        // 🎯 Redraw x-axis so tick density updates for full view
        drawWaveformXAxis();

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
        updateAllFeatureBoxPositions();
        
        // Clear cached spectrograms after transition (no longer needed)
        clearCachedFullSpectrogram();
        clearCachedZoomedSpectrogram();
        
        // Clear cached full waveform after transition (no longer needed)
        State.setCachedFullWaveformCanvas(null);
        
        // 🔍 Diagnostic: Track zoom out complete
        console.log('✅ ZOOM OUT complete');

        // Update status text to guide user
        if (!isTutorialActive()) {
            const statusEl = document.getElementById('status');
            if (statusEl) {
                const regions = getCurrentRegions();
                if (regions.length > 0) {
                    statusEl.className = 'status info';
                    statusEl.textContent = `Click and drag to create a region, type a region # to zoom in, or click 🔍`;
                }
            }
        }
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
 * Update the complete button state - SINGLE SOURCE OF TRUTH
 * Handles BOTH modes: "Begin Analysis" (before transformation) and "Complete" (after transformation)
 */
export async function updateCompleteButtonState() {
    const completeBtn = document.getElementById('completeBtn');
    if (!completeBtn) {
        console.warn('⚠️ updateCompleteButtonState: completeBtn not found in DOM');
        return;
    }
    
    // Check if Solar Portal mode - hide button permanently
    const { CURRENT_MODE, AppMode } = await import('./master-modes.js');
    if (CURRENT_MODE === AppMode.SOLAR_PORTAL) {
        completeBtn.style.display = 'none';
        return;
    }
    
    // Always ensure button is visible
    completeBtn.style.display = 'flex';
    completeBtn.style.alignItems = 'center';
    completeBtn.style.justifyContent = 'center';
    
    // Check if button is in "Begin Analysis" mode (before transformation) or "Complete" mode (after)
    const isBeginAnalysisMode = completeBtn.textContent === 'Begin Analysis';
    
    // Check if tutorial is in progress - if so, don't override button state
    const { isTutorialInProgress } = await import('./study-workflow.js');
    
    if (isTutorialInProgress()) {
        // Tutorial in progress - don't override button state, let tutorial control it
        if (!isStudyMode()) {
            console.log('🎓 Tutorial in progress - not changing button state');
        }
        return; // Exit early, let tutorial control it
    }
    
    // Determine what should control the button state
    let shouldDisable;
    
    if (isBeginAnalysisMode) {
        // BEGIN ANALYSIS MODE: Enable when data is loaded
        const hasData = State.completeSamplesArray && State.completeSamplesArray.length > 0;
        shouldDisable = !hasData;
        
        if (!isStudyMode()) {
            const sampleCount = State.completeSamplesArray ? State.completeSamplesArray.length : 0;
            console.log(`🔵 Begin Analysis button: hasData=${hasData}, samples=${sampleCount.toLocaleString()}`);
        }
    } else {
        // COMPLETE MODE: Enable when at least one feature is identified
        const hasFeature = hasIdentifiedFeature();
        shouldDisable = !hasFeature;
        
        if (!isStudyMode()) {
            console.log(`🔵 Complete button: hasFeature=${hasFeature}`);
        }
    }
    
    // Update disabled state
    completeBtn.disabled = shouldDisable;
    if (shouldDisable) {
        completeBtn.style.opacity = '0.5';
        completeBtn.style.cursor = 'not-allowed';
        if (!isStudyMode()) {
            console.log(`❌ ${isBeginAnalysisMode ? 'Begin Analysis' : 'Complete'} button DISABLED`);
        }
    } else {
        completeBtn.style.opacity = '1';
        completeBtn.style.cursor = 'pointer';
        if (!isStudyMode()) {
            console.log(`✅ ${isBeginAnalysisMode ? 'Begin Analysis' : 'Complete'} button ENABLED`);
        }
    }
}

/**
 * @deprecated Use updateCompleteButtonState() instead - it handles both modes
 * Keeping for backward compatibility
 */
export function updateCmpltButtonState() {
    updateCompleteButtonState();
}

