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
import { saveFeature as saveFeatureToD1, deleteFeatureFromD1 } from './d1-sync.js';

// ── Standalone features (drawn directly on spectrogram in windowed mode) ──
// This is the PRIMARY feature tracking mechanism for EMIC study participants.
// Each feature: { lowFreq, highFreq, startTime, endTime, notes, confidence, speedFactor }
let standaloneFeatures = [];

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
 * Per-section feature counts. The study builder tells us which section we're in.
 * Each section gets its own counter. The button checks the current section's count.
 */
let _currentSection = 0;
let _sectionFeatureCounts = {};

export function setCurrentSection(n) {
    _currentSection = n;
    _sectionFeatureCounts[n] = 0;
    if (window.pm?.features) console.log(`[SECTION] Entering analysis section ${n} — feature count reset to 0`);
}

/**
 * Save standalone features and persist to localStorage
 */
export function saveStandaloneFeatures() {
    if (window.__REVIEW_MODE) return; // Read-only in feature viewer
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
            
                return;
            }
        }
    } catch (error) {
        console.error('Failed to load standalone features:', error);
    }
    standaloneFeatures = [];
}

/**
 * Load features from D1 for review mode (feature viewer page).
 * Fetches the reviewed participant's features and maps D1 format → internal format.
 */
async function loadReviewFeatures() {
    try {
        const { fetchFeatures } = await import('./d1-sync.js');
        const pid = window.__REVIEW_PID;
        const session = window.__REVIEW_SESSION || 1;

        const features = await fetchFeatures(pid);

        // Filter by analysis_session if specified
        const filtered = features.filter(f => f.analysis_session == session);

        // Map D1 snake_case → internal camelCase
        standaloneFeatures = filtered.map(f => ({
            lowFreq: f.low_freq != null ? String(f.low_freq) : '0',
            highFreq: f.high_freq != null ? String(f.high_freq) : '0',
            startTime: f.start_time,
            endTime: f.end_time,
            notes: f.notes || '',
            confidence: f.confidence || 'unconfirmed',
            speedFactor: f.speed_factor || null,
            d1Id: f.id,
            createdAt: f.created_at,
            analysisSession: f.analysis_session,
            _reviewOnly: true,
        }));

        console.log(`🔎 [Review] Loaded ${standaloneFeatures.length} features for ${pid} (session ${session}, ${features.length} total)`);
    } catch (e) {
        console.error('🔎 [Review] Failed to load features:', e);
        standaloneFeatures = [];
    }
}

/**
 * Add a standalone feature (returns the new feature index)
 */
function addStandaloneFeature(featureData) {
    if (window.__REVIEW_MODE) return -1; // Read-only in feature viewer
    // Assign stable D1 ID so upserts are idempotent
    if (!featureData.d1Id) {
        featureData.d1Id = crypto.randomUUID
            ? crypto.randomUUID()
            : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                const r = (Math.random() * 16) | 0;
                return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
            });
    }
    standaloneFeatures.push(featureData);
    _sectionFeatureCounts[_currentSection] = (_sectionFeatureCounts[_currentSection] || 0) + 1;
    saveStandaloneFeatures();

    // Real-time sync to D1
    if (window.pm?.features) console.log(`%c[FEATURE] created #${standaloneFeatures.length} d1Id=${featureData.d1Id?.slice(0,8)} notes="${featureData.notes}" (section ${_currentSection} count: ${_sectionFeatureCounts[_currentSection]})`, 'color: #f0a');
    if (isStudyMode()) saveFeatureToD1(featureData);

    return standaloneFeatures.length - 1;
}

/**
 * Update a feature's fields, persist to localStorage + D1.
 * Called by spectrogram-renderer when popup closes.
 */
export function updateFeature(featureIndex, updates) {
    if (window.__REVIEW_MODE) return; // Read-only in feature viewer
    const f = standaloneFeatures[featureIndex];
    if (!f) return;
    Object.assign(f, updates);
    saveStandaloneFeatures();
    if (isStudyMode()) saveFeatureToD1(f);
    if (updates.confidence) redrawAllCanvasFeatureBoxes();
    if (window.pm?.features) console.log(`%c[FEATURE] updateFeature #${featureIndex+1} d1Id=${f.d1Id?.slice(0,8)} notes="${f.notes}" conf=${f.confidence} → D1`, 'color: #f0a; font-weight: bold');
}

/**
 * Delete a standalone feature by index
 */
export function deleteStandaloneFeature(featureIndex) {
    if (window.__REVIEW_MODE) return; // Read-only in feature viewer
    if (featureIndex < 0 || featureIndex >= standaloneFeatures.length) return;
    const removed = standaloneFeatures[featureIndex];
    closeFeaturePopup();
    standaloneFeatures.splice(featureIndex, 1);
    _sectionFeatureCounts[_currentSection] = Math.max(0, (_sectionFeatureCounts[_currentSection] || 0) - 1);
    saveStandaloneFeatures();
    notifyFeatureChange();

    // Remove from D1
    if (isStudyMode() && removed?.d1Id) deleteFeatureFromD1(removed.d1Id);
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
export async function loadRegionsAfterDataFetch() {
    const spacecraft = getCurrentSpacecraft();
    if (!spacecraft) {
        console.warn('Cannot load features - no spacecraft selected');
        return;
    }

    const featureGroupOpen = logGroup('features', `Loading features for ${spacecraft}`);

    // Review mode: fetch features from D1 instead of localStorage
    if (window.__REVIEW_MODE && window.__REVIEW_PID) {
        await loadReviewFeatures();
    } else {
        // Normal path: load from localStorage
        loadStandaloneFeatures();
    }

    // Sync per-section feature count with loaded features (handles page refresh mid-analysis)
    if (_currentSection > 0) {
        const identified = standaloneFeatures.filter(f => f.lowFreq && f.highFreq && f.startTime && f.endTime).length;
        _sectionFeatureCounts[_currentSection] = identified;
    }

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
    if (window.__REVIEW_MODE) return; // No feature creation in feature viewer
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
    const playbackRate = State.getPlaybackRate();
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
        lowFreq: lowFreq.toFixed(3),
        highFreq: highFreq.toFixed(3),
        startTime: startTime || '',
        endTime: endTime || '',
        notes: '',
        confidence: 'confirmed',
        speedFactor: getCurrentSpeedFactor(),
        createdAt: new Date().toISOString(),
        analysisSession: window.__currentAnalysisSession || null
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
    if (window.pm?.features) console.log(`%c[FEATURE] renderStandaloneFeaturesList() called — ${standaloneFeatures.length} features`, 'color: #f0a', new Error().stack.split('\n')[2]?.trim());
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
            <span class="freq-display ${hasCoords ? 'completed' : ''}">${hasCoords ? formatFeatureButtonText(feature) : 'No selection'}</span>
            <label class="confidence-label" for="confidence-sa-${idx}">Confidence:</label>
            <select id="confidence-sa-${idx}">
                <option value="confirmed" ${feature.confidence === 'confirmed' || !feature.confidence ? 'selected' : ''}>Yes</option>
                <option value="possibly" ${feature.confidence === 'possibly' ? 'selected' : ''}>Possibly</option>
            </select>
            <textarea class="freq-input notes-field"
                      placeholder="Add description..."
                      id="notes-sa-${idx}">${feature.notes || ''}</textarea>
        `;

        featureRow.insertBefore(deleteBtn, featureRow.firstChild);

        // Wire up change listeners
        const confidenceSelect = featureRow.querySelector(`#confidence-sa-${idx}`);
        const notesField = featureRow.querySelector(`#notes-sa-${idx}`);

        confidenceSelect.addEventListener('change', function() {
            if (window.pm?.interaction) console.log(`%c[CONFIDENCE] idx=${idx} old=${standaloneFeatures[idx].confidence} new=${this.value}`, 'color: #f80; font-weight: bold');
            standaloneFeatures[idx].confidence = this.value;
            saveStandaloneFeatures();
            if (window.pm?.interaction) console.log(`%c[CONFIDENCE] saved. Verify:`, 'color: #f80', standaloneFeatures[idx].confidence);
            if (isStudyMode()) saveFeatureToD1(standaloneFeatures[idx]);
            redrawAllCanvasFeatureBoxes();
            this.blur();
        });

        // Sync notes to object on every keystroke (so Proceed always has latest)
        notesField.addEventListener('input', function() {
            standaloneFeatures[idx].notes = this.value;
            if (window.pm?.features) console.log(`%c[FEATURE] input #${idx+1} notes="${this.value}"`, 'color: #f0a');
        });
        // Save to localStorage + D1 on blur
        notesField.addEventListener('change', function() {
            standaloneFeatures[idx].notes = this.value;
            if (window.pm?.features) console.log(`%c[FEATURE] change/blur #${idx+1} d1Id=${standaloneFeatures[idx].d1Id?.slice(0,8)} notes="${this.value}" → saving to D1`, 'color: #f0a; font-weight: bold');
            saveStandaloneFeatures();
            if (isStudyMode()) saveFeatureToD1(standaloneFeatures[idx]);
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
    const count = _sectionFeatureCounts[_currentSection] || 0;
    if (window.pm?.features) console.log(`[BUTTON] section ${_currentSection} feature count: ${count}`);
    return count > 0;
}

// ── Feature Change Notification ──────────────────────────────────────────

/**
 * Notify listeners that features changed. study-flow.js listens for this
 * event to enable/disable the Complete button — feature-tracker stays data-only.
 */
let _lastFeatureCount = 0;
export function notifyFeatureChange() {
    const count = getStandaloneFeatures().length;
    const hasFeature = hasIdentifiedFeature();
    document.dispatchEvent(new CustomEvent('featurechange', {
        detail: { hasFeature, count }
    }));
    // Fire featureCreated when a new feature is added (count increased)
    if (count > _lastFeatureCount) {
        window.dispatchEvent(new CustomEvent('featureCreated', { detail: { count } }));
    }
    _lastFeatureCount = count;
}

/** Alias — existing callers use this name */
export function updateCompleteButtonState() { notifyFeatureChange(); }

/** Alias — existing callers use this name */
export function updateCmpltButtonState() { notifyFeatureChange(); }

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
