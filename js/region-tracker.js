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
import { renderCompleteSpectrogramForRegion, renderCompleteSpectrogram, resetSpectrogramState } from './spectrogram-complete-renderer.js';

// Region data structure
let regions = [];
let activeRegionIndex = null;
let activePlayingRegionIndex = null; // Track which region is currently playing (if any)

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
    
    if (regions.length === 0) {
        return; // No regions to draw
    }
    
    // Convert region ISO timestamps to seconds from start of audio (like selectionStart/End)
    const dataStartMs = State.dataStartTime.getTime();
    
    // Draw highlights for each region
    regions.forEach((region, index) => {
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
        
        // 🏛️ Use zoom-aware conversion for pixel positioning
        let startX, endX;
        if (zoomState.isInitialized()) {
            // Convert from sample indices to pixels using zoom state
            startX = zoomState.sampleToPixel(region.startSample !== undefined ? region.startSample : zoomState.timeToSample(regionStartSeconds), canvasWidth);
            endX = zoomState.sampleToPixel(region.endSample !== undefined ? region.endSample : zoomState.timeToSample(regionEndSeconds), canvasWidth);
        } else {
            // Fallback to old behavior if zoom state not initialized
            const startProgress = regionStartSeconds / State.totalAudioDuration;
            const endProgress = regionEndSeconds / State.totalAudioDuration;
            startX = startProgress * canvasWidth;
            endX = endProgress * canvasWidth;
        }
        const highlightWidth = endX - startX;
        
        // Draw filled rectangle (EXACT same pattern as yellow box)
        if (index === activeRegionIndex) {
            // Active region: 50% opacity
            ctx.fillStyle = 'rgba(68, 136, 255, 0.5)';
        } else {
            // Inactive region: 20% opacity
            ctx.fillStyle = 'rgba(68, 136, 255, 0.2)';
        }
        ctx.fillRect(startX, 0, highlightWidth, canvasHeight);
        
        // Draw border lines (EXACT same pattern as yellow box)
        if (index === activeRegionIndex) {
            ctx.strokeStyle = 'rgba(68, 136, 255, 0.9)';
        } else {
            ctx.strokeStyle = 'rgba(68, 136, 255, 0.6)';
        }
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(startX, 0);
        ctx.lineTo(startX, canvasHeight);
        ctx.moveTo(endX, 0);
        ctx.lineTo(endX, canvasHeight);
        ctx.stroke();
        
        // Draw region number - position dynamically based on region width
        const regionNumber = index + 1; // 1-indexed for display
        const paddingY = 6; // Padding from top edge (moved up more)
        
        // Position number outside to the left if region is too narrow, otherwise inside
        let labelX;
        if (highlightWidth < 30) {
            // Position number to the left, outside the box
            labelX = startX - 20;
        } else {
            // Position inside, top-left corner (with padding from left edge, moved left a bit)
            labelX = startX + 10;
        }
        const labelY = paddingY;
        
        // Set text style - white with 80% opacity
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, "Segoe UI"';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        
        ctx.fillText(regionNumber.toString(), labelX, labelY);
    });
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
    if (regions[regionIndex] && regions[regionIndex].features[featureIndex]) {
        regions[regionIndex].features[featureIndex].lowFreq = lowFreq.toFixed(2);
        regions[regionIndex].features[featureIndex].highFreq = highFreq.toFixed(2);
        
        if (startTime && endTime) {
            regions[regionIndex].features[featureIndex].startTime = startTime;
            regions[regionIndex].features[featureIndex].endTime = endTime;
        }
        
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
        <span class="region-label">Region ${region.id}</span>
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
        
        // Check if we're already zoomed into THIS region
        if (zoomState.mode === 'temple' && zoomState.activeTempleId === region.id) {
            // We're zoomed in - zoom back out
            zoomToFull();
        } else {
            // Zoom into this region
            zoomToRegion(index);
        }
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
        });
    }
    if (addFeatureLabel && !isMaxFeatures) {
        addFeatureLabel.addEventListener('click', (e) => {
            e.stopPropagation();
            addFeature(index);
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
        });
        
        typeSelect.addEventListener('change', function() {
            updateFeature(regionIndex, featureIndex, 'type', this.value);
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
    if (activeRegionIndex === null || activeRegionIndex >= regions.length) {
        return false;
    }
    
    const region = regions[activeRegionIndex];
    if (!State.dataStartTime || !State.dataEndTime) {
        return false;
    }
    
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
    const region = regions[index];
    const regionTime = `${formatTime(region.startTime)} – ${formatTime(region.stopTime)}`;
    console.log(`🎵 Region ${index + 1} play button clicked - ${regionTime} (Region ID: ${region.id})`);
    
    
    // Reset old playing region button (if different)
    if (activePlayingRegionIndex !== null && activePlayingRegionIndex !== index) {
        resetRegionPlayButton(activePlayingRegionIndex);
    }
    
    // Make this region active
    activePlayingRegionIndex = index;
    setActiveRegion(index);
    
    // Set selection to region bounds
    if (!setSelectionFromActiveRegion()) {
        console.warn('⚠️ Could not set selection from region');
        return;
    }
    
    // 🏛️ Calculate region start position (use sample indices if available)
    let regionStartSeconds;
    if (region.startSample !== undefined) {
        // New format: convert from eternal sample index
        regionStartSeconds = zoomState.sampleToTime(region.startSample);
    } else {
        // Old format: convert from timestamp (backward compatibility)
        const dataStartMs = State.dataStartTime.getTime();
        const regionStartMs = new Date(region.startTime).getTime();
        regionStartSeconds = (regionStartMs - dataStartMs) / 1000;
    }
    
    // Update region button to GREEN (playing state)
    region.playing = true;
    const regionCard = document.querySelector(`[data-region-id="${region.id}"]`);
    const playBtn = regionCard?.querySelector('.play-btn');
    if (playBtn) {
        playBtn.classList.add('playing');
        playBtn.textContent = '▶';
        playBtn.title = 'Play region from start';
    }
    
    // Seek to region start AND start playback
    // This handles everything: seeking, starting playback, updating master button
    seekToPosition(regionStartSeconds, true);
    
    console.log(`▶️ Region ${index + 1} playing from ${regionStartSeconds.toFixed(2)}s`);
}

/**
 * Reset a region's play button to play state
 */
function resetRegionPlayButton(index) {
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
 * Region button always shows ▶ and stays GREEN while it's the active region
 */
export function updateActiveRegionPlayButton(isPlaying) {
    // Region button stays GREEN and shows ▶ regardless of pause state
    // Master play/pause handles the actual pause/resume functionality
    // The button only changes back to RED when the region finishes or another region is selected
    // So this function doesn't need to do anything to the button appearance
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
 * Reset region play button if playback has reached the end of the region
 * Clears active playing region and resets button to play
 */
export function resetRegionPlayButtonIfFinished() {
    if (activePlayingRegionIndex === null || activePlayingRegionIndex >= regions.length) {
        return;
    }
    
    // Skip check if we just seeked (avoids race condition with stale position)
    if (State.justSeeked) {
        return;
    }
    
    const region = regions[activePlayingRegionIndex];
    if (!region.playing || !State.dataStartTime || !State.totalAudioDuration) {
        return;
    }
    
    // 🏛️ Check if current position is at or past the end of the region (use sample indices if available)
    let regionEndSeconds;
    if (region.endSample !== undefined) {
        // New format: convert from eternal sample index
        regionEndSeconds = zoomState.sampleToTime(region.endSample);
    } else {
        // Old format: convert from timestamp (backward compatibility)
        const dataStartMs = State.dataStartTime.getTime();
        const regionEndMs = new Date(region.stopTime).getTime();
        regionEndSeconds = (regionEndMs - dataStartMs) / 1000;
    }
    
    // If we're at or past the end of the region, reset it
    if (State.currentAudioPosition >= regionEndSeconds - 0.1) { // Small tolerance for timing
        const region = regions[activePlayingRegionIndex];
        const regionTime = `${formatTime(region.startTime)} – ${formatTime(region.stopTime)}`;
        console.log(`🚪 PLAYHEAD EXITED REGION: Region ${activePlayingRegionIndex + 1} (${regionTime})`);
        console.log(`   📍 Position: ${State.currentAudioPosition.toFixed(2)}s (region end: ${regionEndSeconds.toFixed(2)}s)`);
        resetRegionPlayButton(activePlayingRegionIndex);
        activePlayingRegionIndex = null;
        console.log('✅ Region playback finished - reset button');
    }
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
    const region = regions[regionIndex];
    
    if (region.featureCount <= 1 || featureIndex === 0) {
        console.log('Cannot delete - minimum 1 feature required or attempting to delete first feature');
        return;
    }
    
    region.features.splice(featureIndex, 1);
    region.featureCount = region.features.length;
    
    renderFeatures(region.id, regionIndex);
}

/**
 * Update feature property
 */
export function updateFeature(regionIndex, featureIndex, property, value) {
    setActiveRegion(regionIndex);
    if (!regions[regionIndex].features[featureIndex]) {
        regions[regionIndex].features[featureIndex] = {};
    }
    regions[regionIndex].features[featureIndex][property] = value;
    
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
        regions.splice(index, 1);
        if (activeRegionIndex === index) {
            activeRegionIndex = null;
        } else if (activeRegionIndex > index) {
            activeRegionIndex--;
        }
        renderRegions();
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
    renderRegions();
    setActiveRegion(regions.length - 1);
    
    console.log('✅ Test region created');
}

/**
 * Zoom into a region (the introspective lens!)
 * Makes the region fill the entire waveform/spectrogram view
 */
export function zoomToRegion(regionIndex) {
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
    
    // 🏛️ Hide "Add Region" button when entering temple mode
    hideAddRegionButton();
    
    // If we were zoomed into a different region, reset its button first
    if (zoomState.mode === 'temple' && zoomState.activeTempleId !== region.id) {
        const oldRegionCard = document.querySelector(`[data-region-id="${zoomState.activeTempleId}"]`);
        if (oldRegionCard) {
            const oldZoomBtn = oldRegionCard.querySelector('.zoom-btn');
            if (oldZoomBtn) {
                oldZoomBtn.textContent = '🔍';
                oldZoomBtn.title = 'Zoom to region';
            }
        }
    }
    
    // Update zoom state to this region's bounds
    zoomState.mode = 'temple';
    zoomState.currentViewStartSample = region.startSample;
    zoomState.currentViewEndSample = region.endSample;
    zoomState.activeTempleId = region.id;
    
    // 🚩 RAISE THE FLAG! We're respecting this temple's boundaries
    // Set selection to region bounds (for worklet boundaries)
    const regionStartSeconds = zoomState.sampleToTime(region.startSample);
    const regionEndSeconds = zoomState.sampleToTime(region.endSample);
    State.setSelectionStart(regionStartSeconds);
    State.setSelectionEnd(regionEndSeconds);
    // DON'T force looping - let user control it via loop toggle!
    // State.setIsLooping stays whatever the user set it to
    updateWorkletSelection(); // Send boundaries to worklet
    
    // Set as active region
    setActiveRegion(regionIndex);
    
    // Re-render waveform for zoomed range
    drawWaveform();
    
    // Re-render spectrogram for zoomed range
    renderCompleteSpectrogramForRegion(regionStartSeconds, regionEndSeconds);
    
    // Update zoom button for THIS region
    const regionCard = document.querySelector(`[data-region-id="${region.id}"]`);
    if (regionCard) {
        const zoomBtn = regionCard.querySelector('.zoom-btn');
        if (zoomBtn) {
            zoomBtn.textContent = '↩️';
            zoomBtn.title = 'Return to full view';
        }
    }
    
    console.log(`🔍 Temple boundaries set: ${regionStartSeconds.toFixed(2)}s - ${regionEndSeconds.toFixed(2)}s`);
    console.log(`🚩 Flag raised - respecting temple walls`);
    console.log(`🔍 Zoomed to ${zoomState.getZoomLevel().toFixed(1)}x - the introspective lens is open! 🦋`);
    console.log(`🔄 ZOOM MODE TOGGLE: full view → temple mode (region ${regionIndex + 1})`);
}

/**
 * Zoom back out to full view
 */
export function zoomToFull() {
    if (!zoomState.isInitialized()) {
        return;
    }
    
    console.log('🌍 Zooming to full view');
    
    // 🚩 LOWER THE FLAG! No longer respecting boundaries
    // Clear selection (free roaming)
    State.setSelectionStart(null);
    State.setSelectionEnd(null);
    updateWorkletSelection(); // Clear boundaries in worklet
    
    // Reset zoom state to full view
    zoomState.mode = 'full';
    zoomState.currentViewStartSample = 0;
    zoomState.currentViewEndSample = zoomState.totalSamples;
    zoomState.activeTempleId = null;
    
    // Reset spectrogram state to allow re-rendering
    resetSpectrogramState();
    
    // Re-render waveform for full view
    drawWaveform();
    
    // Re-render spectrogram for full view
    renderCompleteSpectrogram();
    
    // Update ALL zoom buttons back to 🔍
    regions.forEach(region => {
        const regionCard = document.querySelector(`[data-region-id="${region.id}"]`);
        if (regionCard) {
            const zoomBtn = regionCard.querySelector('.zoom-btn');
            if (zoomBtn) {
                zoomBtn.textContent = '🔍';
                zoomBtn.title = 'Zoom to region';
            }
        }
    });
    
    console.log('🌍 Returned to full view - flag lowered, free roaming restored! 🏛️');
    console.log(`🔄 ZOOM MODE TOGGLE: temple mode → full view`);
}

// Export state getters for external access
export function getRegions() {
    return regions;
}

export function isInFrequencySelectionMode() {
    return isSelectingFrequency;
}

