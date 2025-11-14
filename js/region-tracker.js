/**
 * region-tracker.js
 * Region tracking functionality for marking and annotating time/frequency regions
 */

import * as State from './audio-state.js';
import { drawWaveformWithSelection } from './waveform-renderer.js';

// Region data structure
let regions = [];
let activeRegionIndex = null;

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
            // Move to new position while invisible
            addRegionButton.style.left = buttonX + 'px';
            addRegionButton.style.top = buttonTop + 'px';
            addRegionButton.style.transform = 'translateX(-50%)';
            
            // Fade in at new position
            requestAnimationFrame(() => {
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
 * Create region from waveform selection times
 */
function createRegionFromSelectionTimes(selectionStartSeconds, selectionEndSeconds) {
    if (!State.dataStartTime || !State.dataEndTime) return;
    
    console.log('🎯 Creating region from selection:', selectionStartSeconds, '-', selectionEndSeconds, 'seconds');
    console.log('   Data start:', State.dataStartTime);
    console.log('   Total audio duration:', State.totalAudioDuration);
    
    // Convert selection times (in seconds from start of audio) to ISO timestamps
    const dataStartMs = State.dataStartTime.getTime();
    const startTimeMs = dataStartMs + (selectionStartSeconds * 1000);
    const endTimeMs = dataStartMs + (selectionEndSeconds * 1000);
    
    const startTime = new Date(startTimeMs).toISOString();
    const endTime = new Date(endTimeMs).toISOString();
    
    console.log('   Region start time:', startTime);
    console.log('   Region end time:', endTime);
    
    // Collapse all existing regions before adding new one
    regions.forEach(region => {
        region.expanded = false;
    });
    
    // Create new region
    const newRegion = {
        id: regions.length > 0 ? Math.max(...regions.map(r => r.id)) + 1 : 1,
        startTime: startTime,
        stopTime: endTime,
        featureCount: 1,
        features: [{
            type: 'Impulsive',
            repetition: 'Unique',
            lowFreq: '',
            highFreq: '',
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
        const regionCard = document.querySelector(`[data-region-id="${newRegion.id}"]`);
        const details = regionCard ? regionCard.querySelector('.region-details') : null;
        
        if (details) {
            details.style.maxHeight = '0px';
            requestAnimationFrame(() => {
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
        // Convert region times to seconds from start (same as selectionStart/End)
        const regionStartMs = new Date(region.startTime).getTime();
        const regionEndMs = new Date(region.stopTime).getTime();
        
        const regionStartSeconds = (regionStartMs - dataStartMs) / 1000;
        const regionEndSeconds = (regionEndMs - dataStartMs) / 1000;
        
        // console.log(`   Drawing region ${index}: ${regionStartSeconds.toFixed(2)}s - ${regionEndSeconds.toFixed(2)}s`);
        
        // Use EXACT same logic as yellow selection box
        const startProgress = regionStartSeconds / State.totalAudioDuration;
        const endProgress = regionEndSeconds / State.totalAudioDuration;
        const startX = startProgress * canvasWidth;
        const endX = endProgress * canvasWidth;
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
export function handleSpectrogramSelection(startY, endY, canvasHeight) {
    if (!isSelectingFrequency || !currentFrequencySelection) {
        return;
    }
    
    const { regionIndex, featureIndex } = currentFrequencySelection;
    
    // Convert Y positions to frequencies
    const lowFreq = getFrequencyFromY(Math.max(startY, endY), maxFrequency, canvasHeight, State.frequencyScale);
    const highFreq = getFrequencyFromY(Math.min(startY, endY), maxFrequency, canvasHeight, State.frequencyScale);
    
    // Update feature data
    if (regions[regionIndex] && regions[regionIndex].features[featureIndex]) {
        regions[regionIndex].features[featureIndex].lowFreq = lowFreq.toFixed(2);
        regions[regionIndex].features[featureIndex].highFreq = highFreq.toFixed(2);
        
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
        <span class="collapse-icon" onclick="window.toggleRegion(${index}); event.stopPropagation();">▼</span>
        <button class="play-btn ${region.playing ? 'playing' : ''}" 
                onclick="window.toggleRegionPlay(${index}); event.stopPropagation();"
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
                onclick="window.deleteRegion(${index}); event.stopPropagation();"
                title="Delete region">
            ✕
        </button>
    `;
    
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
                        onclick="window.addFeature(${index}); event.stopPropagation();"
                        ${isMaxFeatures ? 'disabled' : ''}
                        title="${isMaxFeatures ? 'Maximum features (10) reached' : 'Add feature'}">
                    +
                </button>
                <span class="add-feature-label ${isMaxFeatures ? 'disabled' : ''}"
                      onclick="${isMaxFeatures ? '' : `window.addFeature(${index}); event.stopPropagation();`}"
                      title="${isMaxFeatures ? 'Maximum features (10) reached' : 'Add feature'}">
                    ${isMaxFeatures ? 'Max features reached' : 'Add feature'}
                </span>
            </div>
        </div>
    `;
    
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
            <span class="feature-number">${featureIndex + 1}</span>
            <select id="repetition-${regionIndex}-${featureIndex}" onchange="window.updateFeature(${regionIndex}, ${featureIndex}, 'repetition', this.value)">
                <option value="Unique" ${feature.repetition === 'Unique' || !feature.repetition ? 'selected' : ''}>Unique</option>
                <option value="Repeated" ${feature.repetition === 'Repeated' ? 'selected' : ''}>Repeated</option>
            </select>
            
            <select id="type-${regionIndex}-${featureIndex}" onchange="window.updateFeature(${regionIndex}, ${featureIndex}, 'type', this.value)">
                <option value="Impulsive" ${feature.type === 'Impulsive' || !feature.type ? 'selected' : ''}>Impulsive</option>
                <option value="Continuous" ${feature.type === 'Continuous' ? 'selected' : ''}>Continuous</option>
            </select>
            
            <button class="select-freq-btn ${!feature.lowFreq || !feature.highFreq ? 'pulse' : 'completed'}" 
                    onclick="window.startFrequencySelection(${regionIndex}, ${featureIndex})"
                    id="select-btn-${regionIndex}-${featureIndex}"
                    title="${feature.lowFreq && feature.highFreq ? 'click to select' : ''}">
                ${feature.lowFreq && feature.highFreq ? 
                    `${Math.round(parseFloat(feature.lowFreq))} - ${Math.round(parseFloat(feature.highFreq))} Hz` :
                    'select frequency range'
                }
            </button>
            
            <textarea class="freq-input notes-field" 
                      placeholder="Add description..." 
                      onchange="window.updateFeature(${regionIndex}, ${featureIndex}, 'notes', this.value)"
                      onkeydown="if(event.key === 'Enter') { event.preventDefault(); this.blur(); }"
                      id="notes-${regionIndex}-${featureIndex}">${feature.notes || ''}</textarea>
        `;
        
        featureRow.insertBefore(deleteBtn, featureRow.firstChild);
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
            details.style.maxHeight = '0px';
            setTimeout(() => {
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
            const targetHeight = details.scrollHeight;
            details.style.transition = 'max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
            details.style.maxHeight = targetHeight + 'px';
        });
    }
}

/**
 * Toggle region playback (mock implementation)
 */
export function toggleRegionPlay(index) {
    setActiveRegion(index);
    const region = regions[index];
    
    const regionCard = document.querySelector(`[data-region-id="${region.id}"]`);
    const playBtn = regionCard ? regionCard.querySelector('.play-btn') : null;
    
    if (!playBtn) return;
    
    if (!region.playing) {
        region.playing = true;
        playBtn.classList.add('playing');
        playBtn.textContent = '⏸';
        playBtn.title = 'Pause region';
        
        // Auto-stop after 1 second (mock playback)
        setTimeout(() => {
            region.playing = false;
            playBtn.classList.remove('playing');
            playBtn.textContent = '▶';
            playBtn.title = 'Play region';
        }, 1000);
    } else {
        region.playing = false;
        playBtn.classList.remove('playing');
        playBtn.textContent = '▶';
        playBtn.title = 'Play region';
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
 * Clear active region (all regions return to 20% opacity)
 */
export function clearActiveRegion() {
    activeRegionIndex = null;
    // Trigger waveform redraw to update region highlights
    drawWaveformWithSelection();
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
            requestAnimationFrame(() => {
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
    
    const dataStartMs = State.dataStartTime.getTime();
    const dataEndMs = State.dataEndTime.getTime();
    const duration = dataEndMs - dataStartMs;
    
    // Create a region in the middle 10% of the data
    const startMs = dataStartMs + (duration * 0.45);
    const endMs = dataStartMs + (duration * 0.55);
    
    const newRegion = {
        id: regions.length > 0 ? Math.max(...regions.map(r => r.id)) + 1 : 1,
        startTime: new Date(startMs).toISOString(),
        stopTime: new Date(endMs).toISOString(),
        featureCount: 1,
        features: [{
            type: 'Impulsive',
            repetition: 'Unique',
            lowFreq: '',
            highFreq: '',
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

// Export state getters for external access
export function getRegions() {
    return regions;
}

export function isInFrequencySelectionMode() {
    return isSelectingFrequency;
}

