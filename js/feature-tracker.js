/**
 * feature-tracker.js
 * Feature tracking for standalone spectrogram annotations (EMIC study)
 *
 * The old region-based workflow (multi-step selection, zoom, play buttons, region
 * highlighting on the waveform) has been removed. Only the standalone features
 * system and shared utilities remain.
 */

import * as State from './audio-state.js';
import { getActiveId } from './participant-id.js';
import { zoomState } from './zoom-state.js';
import { cancelSpectrogramSelection, redrawAllCanvasFeatureBoxes, closeFeaturePopup, changeColormap, changeFftSize, changeFrequencyScale } from './spectrogram-renderer.js';
import { switchComponent } from './component-selector.js';
import { getLogScaleMinFreq } from './spectrogram-axis-renderer.js';
import { isStudyMode } from './master-modes.js';
import { logGroup, logGroupEnd } from './logger.js';

// ── Standalone features (drawn directly on spectrogram in windowed mode) ──
// This is the PRIMARY feature tracking mechanism for EMIC study participants.
// Each feature: { type, repetition, lowFreq, highFreq, startTime, endTime, notes, speedFactor }
let standaloneFeatures = [];

// Cached EMIC flags module (avoids dynamic import microtask on every call)
let _emicFlagsModule = null;

// localStorage key prefix for feature persistence
const STORAGE_KEY_PREFIX = 'solar_audio_regions_';

// Spectrogram frequency selection state
let isSelectingFrequency = false;
let currentFrequencySelection = null;


// ── Storage Key Utilities ────────────────────────────────────────────────

/**
 * Generate a unique storage key hash for a specific data fetch
 * Combines username, spacecraft, data type, start time, and end time
 * This ensures features are associated with the exact data AND user they were created by
 */
function generateStorageKey(spacecraft, dataType, startTime, endTime) {
    const username = getActiveId();

    if (!spacecraft || !dataType || !startTime || !endTime) {
        return spacecraft ? `${STORAGE_KEY_PREFIX}${username}_${spacecraft}` : null;
    }

    const startISO = startTime instanceof Date ? startTime.toISOString() : startTime;
    const endISO = endTime instanceof Date ? endTime.toISOString() : endTime;

    return `${STORAGE_KEY_PREFIX}${username}_${spacecraft}_${dataType}_${startISO}_${endISO}`;
}

/**
 * Get current data type/dataset from metadata (not UI)
 * Uses the actual dataset that was fetched, not what's shown in the dropdown
 */
function getCurrentDataType() {
    if (State.currentMetadata && State.currentMetadata.dataset) {
        return State.currentMetadata.dataset;
    }
    const dataTypeSelect = document.getElementById('dataType');
    return dataTypeSelect ? dataTypeSelect.value : null;
}

/**
 * Get the current storage key based on spacecraft, data type, and time range
 * Always uses metadata values (not cached) for accuracy
 */
function getCurrentStorageKey() {
    const spacecraft = getCurrentSpacecraft();
    const dataType = getCurrentDataType();
    const startTime = State.dataStartTime;
    const endTime = State.dataEndTime;

    return generateStorageKey(spacecraft, dataType, startTime, endTime);
}

/**
 * Get the current spacecraft from metadata (not UI)
 * Uses the actual spacecraft that was fetched, not what's shown in the dropdown
 */
function getCurrentSpacecraft() {
    if (State.currentMetadata && State.currentMetadata.spacecraft) {
        return State.currentMetadata.spacecraft;
    }
    const spacecraftSelect = document.getElementById('spacecraft');
    return spacecraftSelect ? spacecraftSelect.value : null;
}

/**
 * Get the current playback speed factor (base speed, not multiplied)
 * Returns null if speed cannot be determined
 */
function getCurrentSpeedFactor() {
    try {
        const speedSlider = document.getElementById('playbackSpeed');
        if (speedSlider) {
            const value = parseFloat(speedSlider.value);
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

// ── Standalone Features ──────────────────────────────────────────────────

/**
 * Get the current standalone features array
 */
export function getStandaloneFeatures() {
    return standaloneFeatures;
}

/**
 * Save standalone features and persist to localStorage
 */
export function saveStandaloneFeatures() {
    try {
        const storageKey = getCurrentStorageKey();
        if (!storageKey) return;
        const data = { features: standaloneFeatures, savedAt: new Date().toISOString() };
        localStorage.setItem(storageKey + '_standalone', JSON.stringify(data));
    } catch (error) {
        console.error('Failed to save standalone features:', error);
    }
}

/**
 * Load standalone features from localStorage
 */
function loadStandaloneFeatures() {
    try {
        const storageKey = getCurrentStorageKey();
        if (!storageKey) return;
        const stored = localStorage.getItem(storageKey + '_standalone');
        if (stored) {
            const data = JSON.parse(stored);
            if (data && Array.isArray(data.features)) {
                standaloneFeatures = data.features;
                if (window.pm?.features) console.log(`Loaded ${standaloneFeatures.length} standalone feature(s)`);
                updateStandaloneFeatureCount();
                return;
            }
        }
    } catch (error) {
        console.error('Failed to load standalone features:', error);
    }
    standaloneFeatures = [];
}

/**
 * Add a standalone feature (returns the new feature index)
 */
function addStandaloneFeature(featureData) {
    standaloneFeatures.push(featureData);
    saveStandaloneFeatures();
    updateStandaloneFeatureCount();
    const idx = standaloneFeatures.length - 1;
    // Dispatch event for prompt sequencer and other listeners
    window.dispatchEvent(new CustomEvent('featureCreated', { detail: { index: idx, feature: featureData } }));
    return idx;
}

/**
 * Delete a standalone feature by index
 */
export function deleteStandaloneFeature(featureIndex) {
    if (featureIndex < 0 || featureIndex >= standaloneFeatures.length) return;
    closeFeaturePopup();
    standaloneFeatures.splice(featureIndex, 1);
    saveStandaloneFeatures();
    updateStandaloneFeatureCount();
}

/** Update EMIC active feature count from standalone features */
function updateStandaloneFeatureCount() {
    try {
        if (_emicFlagsModule) {
            _emicFlagsModule.updateActiveFeatureCount(standaloneFeatures.length);
        } else {
            import('./emic-study-flags.js').then(mod => {
                _emicFlagsModule = mod;
                mod.updateActiveFeatureCount(standaloneFeatures.length);
            }).catch(() => {});
        }
    } catch {}
}

// ── Feature Number Utility ───────────────────────────────────────────────

/**
 * Get flat sequential feature number for standalone features.
 * regionIndex is accepted for backward compatibility but ignored (always -1 now).
 */
export function getFlatFeatureNumber(_regionIndex, featureIndex) {
    // Only standalone features remain
    return featureIndex + 1;
}

// ── Loading After Data Fetch ─────────────────────────────────────────────

/**
 * Load features from storage after data fetch completes
 * Call this after State.dataStartTime and State.dataEndTime are set
 */
export function loadRegionsAfterDataFetch() {
    const spacecraft = getCurrentSpacecraft();
    if (!spacecraft) {
        console.warn('Cannot load features - no spacecraft selected');
        return;
    }

    const featureGroupOpen = logGroup('features', `Loading features for ${spacecraft}`);

    // Load standalone features
    loadStandaloneFeatures();

    // Render standalone features list and canvas boxes
    renderStandaloneFeaturesList();
    redrawAllCanvasFeatureBoxes();
    updateCompleteButtonState();

    if (featureGroupOpen) logGroupEnd();

    // Check for pending view settings (from shared links) and apply after a delay
    const pendingViewSettings = sessionStorage.getItem('pendingSharedViewSettings');
    if (pendingViewSettings) {
        try {
            const viewSettings = JSON.parse(pendingViewSettings);
            sessionStorage.removeItem('pendingSharedViewSettings');

            const viewGroupOpen = logGroup('share', 'Restoring shared view settings');

            if (viewSettings.colormap) {
                console.log(`Colormap: ${viewSettings.colormap}`);
                const colormapSelect = document.getElementById('colormap');
                if (colormapSelect) {
                    colormapSelect.value = viewSettings.colormap;
                    changeColormap();
                }
            }

            if (viewSettings.fft_size) {
                console.log(`FFT size: ${viewSettings.fft_size}`);
                const fftSizeSelect = document.getElementById('fftSize');
                if (fftSizeSelect) {
                    fftSizeSelect.value = viewSettings.fft_size.toString();
                    changeFftSize();
                }
            }

            if (viewSettings.frequency_scale) {
                console.log(`Frequency scale: ${viewSettings.frequency_scale}`);
                const freqScaleSelect = document.getElementById('frequencyScale');
                if (freqScaleSelect) {
                    freqScaleSelect.value = viewSettings.frequency_scale;
                    changeFrequencyScale();
                }
            }

            if (viewSettings.component_index !== undefined && viewSettings.component_index !== null) {
                console.log(`Component index: ${viewSettings.component_index}`);
                const componentSelector = document.getElementById('componentSelector');
                if (componentSelector && componentSelector.options.length > viewSettings.component_index) {
                    componentSelector.value = viewSettings.component_index.toString();
                    switchComponent(viewSettings.component_index);
                }
            }

            if (viewGroupOpen) logGroupEnd();
        } catch (e) {
            console.error('Failed to parse pending view settings:', e);
            sessionStorage.removeItem('pendingSharedViewSettings');
        }
    }
}

// ── Initialization ───────────────────────────────────────────────────────

/**
 * Initialize region tracker (now just standalone features)
 */
export function initRegionTracker() {
    if (!isStudyMode()) {
        console.log('Feature tracker initialized');
    }
}

// ── Frequency Selection ──────────────────────────────────────────────────

/**
 * Stop frequency selection mode
 */
export function stopFrequencySelection() {
    if (!isSelectingFrequency) {
        return;
    }

    const selectionInfo = currentFrequencySelection;

    isSelectingFrequency = false;
    currentFrequencySelection = null;

    console.log('[DEBUG] Frequency selection stopped - canceling any active selection box');

    cancelSpectrogramSelection();

    // Remove active state from button
    let activeButton = null;
    if (selectionInfo) {
        const { regionIndex, featureIndex } = selectionInfo;
        activeButton = document.getElementById(`select-btn-${regionIndex}-${featureIndex}`);
    }
    if (!activeButton) {
        activeButton = document.querySelector('.select-freq-btn.active');
    }
    if (activeButton) {
        activeButton.classList.remove('active');
    }

    const canvas = document.getElementById('spectrogram');
    if (canvas) {
        canvas.classList.remove('selecting');
        canvas.style.cursor = '';
    }
}

/**
 * Start frequency selection mode for a specific feature
 */
export function startFrequencySelection(regionIndex, featureIndex) {
    if (isSelectingFrequency) {
        console.warn('[DEBUG] Already in frequency selection mode - stopping before starting new one');
        stopFrequencySelection();
    }

    isSelectingFrequency = true;
    currentFrequencySelection = { regionIndex, featureIndex };

    const button = document.getElementById(`select-btn-${regionIndex}-${featureIndex}`);
    if (button) {
        button.classList.add('active');
        button.classList.remove('pulse', 'completed');
    }

    const canvas = document.getElementById('spectrogram');
    if (canvas) {
        canvas.classList.add('selecting');
        canvas.style.cursor = 'crosshair';
    }
}

/**
 * Handle spectrogram frequency selection
 * Called when user completes a box selection on spectrogram — standalone feature creation only
 */
export async function handleSpectrogramSelection(startY, endY, canvasHeight, startX, endX, canvasWidth) {
    if (window.pm?.interaction) console.log('[DEBUG] HANDLE_SPECTROGRAM_SELECTION CALLED');

    let featureIndex;

    // Check if user explicitly clicked a button to reselect a specific feature
    if (currentFrequencySelection) {
        featureIndex = currentFrequencySelection.featureIndex;
        if (window.pm?.features) console.log(`Using explicit selection: standalone feature ${featureIndex + 1}`);

        // Clear it so next draw creates a new feature (one-shot reselection)
        currentFrequencySelection = null;
        isSelectingFrequency = false;
    } else {
        // Auto-determine: create new standalone feature
        const mainDragEl = document.getElementById('mainWindowDrag');
        const isDrawFeature = mainDragEl && mainDragEl.value === 'drawFeature';
        const modeEl = document.getElementById('viewingMode');
        const isWindowed = modeEl && (modeEl.value === 'static' || modeEl.value === 'scroll' || modeEl.value === 'pageTurn');

        if (isDrawFeature && isWindowed) {
            featureIndex = standaloneFeatures.length;
            if (window.pm?.features) console.log(`Standalone feature mode: will create feature #${featureIndex + 1}`);
        } else {
            console.warn('Cannot create feature - not in draw feature / windowed mode');
            return;
        }
    }

    if (window.pm?.features) {
        console.log('========== MOUSE UP: Feature Selection Complete ==========');
        console.log('Canvas coordinates (pixels):', {
            startX: startX?.toFixed(1),
            endX: endX?.toFixed(1),
            startY: startY?.toFixed(1),
            endY: endY?.toFixed(1),
            canvasWidth,
            canvasHeight
        });
    }

    // Convert Y positions to frequencies
    const playbackRate = State.currentPlaybackRate || 1.0;
    const originalNyquist = State.originalDataFrequencyRange?.max || 50;

    const lowFreq = getFrequencyFromY(Math.max(startY, endY), originalNyquist, canvasHeight, State.frequencyScale, playbackRate);
    const highFreq = getFrequencyFromY(Math.min(startY, endY), originalNyquist, canvasHeight, State.frequencyScale, playbackRate);

    if (window.pm?.features) console.log('Converted to frequencies (Hz):', {
        startY_device: Math.min(startY, endY).toFixed(1),
        endY_device: Math.max(startY, endY).toFixed(1),
        canvasHeight_device: canvasHeight,
        lowFreq: lowFreq.toFixed(3),
        highFreq: highFreq.toFixed(3),
        playbackRate: playbackRate.toFixed(2),
        frequencyScale: State.frequencyScale
    });

    // Convert X positions to timestamps
    let startTime = null;
    let endTime = null;

    if (startX !== null && endX !== null && State.dataStartTime && State.dataEndTime) {
        if (zoomState.isInitialized()) {
            const startSample = zoomState.pixelToSample(startX, canvasWidth);
            const endSample = zoomState.pixelToSample(endX, canvasWidth);
            const startTimestamp = zoomState.sampleToRealTimestamp(startSample);
            const endTimestamp = zoomState.sampleToRealTimestamp(endSample);

            if (window.pm?.features) console.log('Converted to samples (eternal coordinates):', {
                startSample: startSample.toLocaleString(),
                endSample: endSample.toLocaleString(),
                sampleRate: zoomState.sampleRate
            });

            if (startTimestamp && endTimestamp) {
                const actualStartMs = Math.min(startTimestamp.getTime(), endTimestamp.getTime());
                const actualEndMs = Math.max(startTimestamp.getTime(), endTimestamp.getTime());

                startTime = new Date(actualStartMs).toISOString();
                endTime = new Date(actualEndMs).toISOString();

                if (window.pm?.features) console.log('Converted to timestamps:', { startTime, endTime });
            }
        } else {
            const dataStartMs = State.dataStartTime.getTime();
            const dataEndMs = State.dataEndTime.getTime();
            const totalDurationMs = dataEndMs - dataStartMs;

            const startProgress = Math.max(0, Math.min(1, startX / canvasWidth));
            const endProgress = Math.max(0, Math.min(1, endX / canvasWidth));

            const startTimeMs = dataStartMs + (startProgress * totalDurationMs);
            const endTimeMs = dataEndMs + (endProgress * totalDurationMs);

            const actualStartMs = Math.min(startTimeMs, endTimeMs);
            const actualEndMs = Math.max(startTimeMs, endTimeMs);

            startTime = new Date(actualStartMs).toISOString();
            endTime = new Date(actualEndMs).toISOString();

            if (window.pm?.features) {
                console.log('FALLBACK: Using progress-based conversion (zoom not initialized)');
                console.log('Timestamps:', { startTime, endTime });
            }
        }
    }

    // ── Save standalone feature ──
    const newFeature = {
        type: 'Impulsive',
        repetition: 'Unique',
        lowFreq: lowFreq.toFixed(3),
        highFreq: highFreq.toFixed(3),
        startTime: startTime || '',
        endTime: endTime || '',
        notes: '',
        speedFactor: getCurrentSpeedFactor()
    };
    featureIndex = addStandaloneFeature(newFeature);

    if (window.pm?.features) {
        console.log('SAVED standalone feature:', { featureIndex, lowFreq: lowFreq.toFixed(3), highFreq: highFreq.toFixed(3), startTime, endTime });
        console.log('========== END Feature Selection ==========\n');
    }

    // Rebuild canvas boxes (includes standalone features)
    redrawAllCanvasFeatureBoxes();
    renderStandaloneFeaturesList();

    // Update complete button state
    updateCompleteButtonState();
    updateCmpltButtonState();

    return {
        regionIndex: -1,
        featureIndex,
        featureData: {
            startTime: newFeature.startTime,
            endTime: newFeature.endTime,
            lowFreq: parseFloat(newFeature.lowFreq),
            highFreq: parseFloat(newFeature.highFreq)
        }
    };
}

// ── Coordinate Conversion Utilities ──────────────────────────────────────

/**
 * Convert Y position to frequency based on scale type
 * Inverse of getYPositionForFrequencyScaled() from axis renderer
 * Produces frequencies in the ORIGINAL scale (not stretched by playback)
 */
function getFrequencyFromY(y, maxFreq, canvasHeight, scaleType, playbackRate = 1.0) {
    const minFreq = getLogScaleMinFreq();

    if (scaleType === 'logarithmic') {
        const logMin = Math.log10(minFreq);
        const logMax = Math.log10(maxFreq);
        const logRange = logMax - logMin;

        const targetMaxFreq = maxFreq / playbackRate;
        const logTargetMax = Math.log10(Math.max(targetMaxFreq, minFreq));
        const targetLogRange = logTargetMax - logMin;
        const fraction = targetLogRange / logRange;
        const stretchFactor = 1 / fraction;

        const heightFromBottom_scaled = canvasHeight - y;
        const heightFromBottom_1x = heightFromBottom_scaled / stretchFactor;

        const normalizedLog = heightFromBottom_1x / canvasHeight;
        const logFreq = logMin + (normalizedLog * (logMax - logMin));
        const freq = Math.pow(10, logFreq);

        return Math.max(0, Math.min(maxFreq, freq));
    } else {
        const normalizedY = (canvasHeight - y) / canvasHeight;

        if (scaleType === 'sqrt') {
            const normalized = normalizedY * normalizedY;
            const effectiveFreq = normalized * (maxFreq - minFreq) + minFreq;
            const freq = effectiveFreq / playbackRate;
            return Math.max(minFreq, Math.min(maxFreq, freq));
        } else {
            const effectiveFreq = normalizedY * (maxFreq - minFreq) + minFreq;
            const freq = effectiveFreq / playbackRate;
            return Math.max(minFreq, Math.min(maxFreq, freq));
        }
    }
}

// ── Formatting Utilities ─────────────────────────────────────────────────

/**
 * Format time for display with seconds (H:MM:SS format, no leading zero on hours if < 10)
 * Displays in UTC for space physics data
 */
function formatTimeWithSeconds(isoString) {
    const date = new Date(isoString);
    const hours = date.getUTCHours();
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    const seconds = String(date.getUTCSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

/**
 * Format feature button text: "HH:MM:SS - HH:MM:SS  X.X - X.X Hz"
 */
function formatFeatureButtonText(feature) {
    if (!feature.startTime || !feature.endTime || !feature.lowFreq || !feature.highFreq) {
        return 'Select feature';
    }

    const startTimeStr = formatTimeWithSeconds(feature.startTime);
    const endTimeStr = formatTimeWithSeconds(feature.endTime);
    const freqStr = `${parseFloat(feature.lowFreq).toFixed(1)} - ${parseFloat(feature.highFreq).toFixed(1)} Hz`;

    return `${startTimeStr} - ${endTimeStr}\u00A0\u00A0\u2022\u00A0\u00A0${freqStr}`;
}

// ── Standalone Features List Rendering ───────────────────────────────────

/**
 * Render standalone features list in the sidebar (windowed mode, no regions)
 * Shows a simple flat list of features numbered sequentially
 */
export function renderStandaloneFeaturesList() {
    const container = document.getElementById('regionsList');
    if (!container) return;

    // Remove old standalone section if it exists
    const oldSection = document.getElementById('standaloneFeaturesList');
    if (oldSection) oldSection.remove();

    if (standaloneFeatures.length === 0) return;

    const section = document.createElement('div');
    section.id = 'standaloneFeaturesList';
    section.className = 'standalone-features-section';
    container.appendChild(section);

    standaloneFeatures.forEach((feature, idx) => {
        const flatNum = idx + 1;
        const featureRow = document.createElement('div');
        featureRow.className = 'feature-row';

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-feature-btn-inline';
        deleteBtn.textContent = '\u00d7';
        deleteBtn.title = 'Delete this feature';
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            deleteStandaloneFeature(idx);
            redrawAllCanvasFeatureBoxes();
            renderStandaloneFeaturesList();
        };

        const hasCoords = feature.lowFreq && feature.highFreq && feature.startTime && feature.endTime;

        featureRow.innerHTML = `
            <span class="feature-number">Feature ${flatNum}</span>
            <select id="repetition-sa-${idx}">
                <option value="Unique" ${feature.repetition === 'Unique' || !feature.repetition ? 'selected' : ''}>Unique</option>
                <option value="Repeated" ${feature.repetition === 'Repeated' ? 'selected' : ''}>Repeated</option>
            </select>
            <select id="type-sa-${idx}">
                <option value="Impulsive" ${feature.type === 'Impulsive' || !feature.type ? 'selected' : ''}>Impulsive</option>
                <option value="Continuous" ${feature.type === 'Continuous' ? 'selected' : ''}>Continuous</option>
            </select>
            <span class="freq-display ${hasCoords ? 'completed' : ''}">${hasCoords ? formatFeatureButtonText(feature) : 'No selection'}</span>
            <textarea class="freq-input notes-field"
                      placeholder="Add description..."
                      id="notes-sa-${idx}">${feature.notes || ''}</textarea>
        `;

        featureRow.insertBefore(deleteBtn, featureRow.firstChild);

        // Wire up change listeners
        const repetitionSelect = featureRow.querySelector(`#repetition-sa-${idx}`);
        const typeSelect = featureRow.querySelector(`#type-sa-${idx}`);
        const notesField = featureRow.querySelector(`#notes-sa-${idx}`);

        repetitionSelect.addEventListener('change', function() {
            standaloneFeatures[idx].repetition = this.value;
            saveStandaloneFeatures();
            this.blur();
        });

        typeSelect.addEventListener('change', function() {
            standaloneFeatures[idx].type = this.value;
            saveStandaloneFeatures();
            this.blur();
        });

        notesField.addEventListener('change', function() {
            standaloneFeatures[idx].notes = this.value;
            saveStandaloneFeatures();
        });

        notesField.addEventListener('keydown', function(event) {
            if (event.key === 'Enter') {
                event.preventDefault();
                this.blur();
            }
        });

        section.appendChild(featureRow);
    });
}

// ── Selection Drawing ────────────────────────────────────────────────────

/**
 * Draw selection box on spectrogram canvas
 */
export function drawSpectrogramSelection(ctx, canvasWidth, canvasHeight) {
    if (State.selectionStart === null || State.selectionEnd === null) {
        return;
    }

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

// ── Feature Identification Check ─────────────────────────────────────────

/**
 * Check if at least one standalone feature has been identified (has all required fields)
 */
export function hasIdentifiedFeature() {
    for (const feature of standaloneFeatures) {
        if (feature.lowFreq && feature.highFreq && feature.startTime && feature.endTime) {
            return true;
        }
    }
    return false;
}

// ── Button State ─────────────────────────────────────────────────────────

/**
 * Update the complete button state - SINGLE SOURCE OF TRUTH
 * Handles BOTH modes: "Begin Analysis" (before transformation) and "Complete" (after transformation)
 */
export async function updateCompleteButtonState() {
    const completeBtn = document.getElementById('completeBtn');
    if (!completeBtn) {
        console.warn('updateCompleteButtonState: completeBtn not found in DOM');
        return;
    }

    const { CURRENT_MODE, AppMode } = await import('./master-modes.js');
    if (CURRENT_MODE === AppMode.SOLAR_PORTAL) {
        completeBtn.style.display = 'none';
        return;
    }

    completeBtn.style.display = 'flex';
    completeBtn.style.alignItems = 'center';
    completeBtn.style.justifyContent = 'center';

    const isBeginAnalysisMode = completeBtn.textContent === 'Begin Analysis';

    let shouldDisable;

    if (isBeginAnalysisMode) {
        const hasData = State.completeSamplesArray && State.completeSamplesArray.length > 0;
        shouldDisable = !hasData;

        if (!isStudyMode()) {
            const sampleCount = State.completeSamplesArray ? State.completeSamplesArray.length : 0;
            if (window.pm?.interaction) console.log(`Begin Analysis button: hasData=${hasData}, samples=${sampleCount.toLocaleString()}`);
        }
    } else {
        const hasFeature = hasIdentifiedFeature();
        shouldDisable = !hasFeature;

        if (!isStudyMode()) {
            if (window.pm?.interaction) console.log(`Complete button: hasFeature=${hasFeature}`);
        }
    }

    completeBtn.disabled = shouldDisable;
    if (shouldDisable) {
        completeBtn.style.opacity = '0.5';
        completeBtn.style.cursor = 'not-allowed';
        if (!isStudyMode()) {
            console.log(`${isBeginAnalysisMode ? 'Begin Analysis' : 'Complete'} button DISABLED`);
        }
    } else {
        completeBtn.style.opacity = '1';
        completeBtn.style.cursor = 'pointer';
        if (!isStudyMode()) {
            console.log(`${isBeginAnalysisMode ? 'Begin Analysis' : 'Complete'} button ENABLED`);
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

// ── Frequency Selection State Queries ────────────────────────────────────

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
