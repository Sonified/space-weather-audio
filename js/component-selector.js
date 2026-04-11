/**
 * component-selector.js
 * Handles switching between CDAWeb audio components (br, bt, bn)
 * Uses cached blobs instead of URLs to avoid CDAWeb temporary file expiration
 */

import * as State from './audio-state.js';
import { getAudioData } from './cdaweb-cache.js';
import { toggleDenoise, runDenoise, isDenoiseActive, setDenoiseQ } from './spin-tone-denoise.js';

// Store component count and cached blobs
let componentCount = 0;
let currentComponentIndex = 0;
let cachedComponentBlobs = []; // Blobs from cache or background download

// Current data identifiers (for cache lookup)
let currentSpacecraft = null;
let currentDataset = null;
let currentStartTime = null;
let currentEndTime = null;

// Component labels by spacecraft/dataset type
const COMPONENT_LABELS = {
    // PSP - RTN coordinates (Radial, Tangential, Normal)
    'PSP': ['br (Radial)', 'bt (Tangential)', 'bn (Normal)'],
    // THEMIS - GSE coordinates (X, Y, Z)
    'THEMIS': ['Bx (GSE)', 'By (GSE)', 'Bz (GSE)'],
    // MMS - GSE coordinates
    'MMS': ['Bx (GSE)', 'By (GSE)', 'Bz (GSE)'],
    // Wind - GSE coordinates
    'Wind': ['Bx (GSE)', 'By (GSE)', 'Bz (GSE)'],
    // Solar Orbiter - RTN coordinates (Radial, Tangential, Normal)
    'SolO': ['br (Radial)', 'bt (Tangential)', 'bn (Normal)'],
    // GOES - GSE coordinates (X, Y, Z)
    'GOES': ['Bx (GSE)', 'By (GSE)', 'Bz (GSE)'],
    // ACE - GSE coordinates
    'ACE': ['Bx (GSE)', 'By (GSE)', 'Bz (GSE)'],
    // Geotail - GSE coordinates
    'Geotail': ['Bx (GSE)', 'By (GSE)', 'Bz (GSE)'],
    // Voyager 1 & 2 - HG coordinates (Radial, Tangential, Normal)
    'Voyager 1': ['BR (Radial)', 'BT (Tangential)', 'BN (Normal)'],
    'Voyager 2': ['BR (Radial)', 'BT (Tangential)', 'BN (Normal)'],
    // DSCOVR - GSE coordinates
    'DSCOVR': ['Bx (GSE)', 'By (GSE)', 'Bz (GSE)'],
    // Cluster - GSE coordinates (FGM default, EFW/STAFF overridden in DATASET_COMPONENT_LABELS)
    'Cluster': ['Bx (GSE)', 'By (GSE)', 'Bz (GSE)'],
    // Default fallback
    'default': ['Component 1', 'Component 2', 'Component 3']
};

// Dataset-specific overrides for electric field components
const DATASET_COMPONENT_LABELS = {
    'MMS1_EDP_SLOW_L2_DCE': ['Ex (GSE)', 'Ey (GSE)', 'Ez (GSE)'],
    'MMS1_SCM_SRVY_L2_SCSRVY': ['Bx (GSE)', 'By (GSE)', 'Bz (GSE)'],
    'THA_L2_EFI': ['Ex (GSE)', 'Ey (GSE)', 'Ez (GSE)'],
    'THB_L2_EFI': ['Ex (GSE)', 'Ey (GSE)', 'Ez (GSE)'],
    'THC_L2_EFI': ['Ex (GSE)', 'Ey (GSE)', 'Ez (GSE)'],
    'THD_L2_EFI': ['Ex (GSE)', 'Ey (GSE)', 'Ez (GSE)'],
    'THE_L2_EFI': ['Ex (GSE)', 'Ey (GSE)', 'Ez (GSE)'],
    'PSP_FLD_L2_DFB_WF_DVDC': ['dV1 (Sensor)', 'dV2 (Sensor)'],
    'SOLO_L2_RPW-LFR-SURV-CWF-E': ['Ex', 'Ey', 'Ez'],
    // Cluster EFW - ISR2 coordinates
    'C1_CP_EFW_L3_E3D_INERT': ['Ex (ISR2)', 'Ey (ISR2)', 'Ez (ISR2)'],
    'C2_CP_EFW_L3_E3D_INERT': ['Ex (ISR2)', 'Ey (ISR2)', 'Ez (ISR2)'],
    'C3_CP_EFW_L3_E3D_INERT': ['Ex (ISR2)', 'Ey (ISR2)', 'Ez (ISR2)'],
    'C4_CP_EFW_L3_E3D_INERT': ['Ex (ISR2)', 'Ey (ISR2)', 'Ez (ISR2)'],
    // Cluster STAFF Search Coil - GSE coordinates
    'C1_CP_STA_CWF_GSE': ['Bx (GSE)', 'By (GSE)', 'Bz (GSE)'],
    'C2_CP_STA_CWF_GSE': ['Bx (GSE)', 'By (GSE)', 'Bz (GSE)'],
    'C3_CP_STA_CWF_GSE': ['Bx (GSE)', 'By (GSE)', 'Bz (GSE)'],
    'C4_CP_STA_CWF_GSE': ['Bx (GSE)', 'By (GSE)', 'Bz (GSE)'],
    // Geotail EFD
    'GE_K0_EFD': ['E-sunward', 'E-duskward'],
};

/**
 * Get component labels for current spacecraft
 * @returns {Array<string>}
 */
function getLabelsForSpacecraft() {
    // Check dataset-specific labels first (for electric field, SCM, etc.)
    if (currentDataset && DATASET_COMPONENT_LABELS[currentDataset]) {
        return DATASET_COMPONENT_LABELS[currentDataset];
    }
    return COMPONENT_LABELS[currentSpacecraft] || COMPONENT_LABELS['default'];
}

/**
 * Initialize component selector with file URLs from CDAWeb
 * @param {Array<string>} fileUrls - Array of WAV file URLs (used for count, not fetching)
 * @param {Object} metadata - Metadata containing spacecraft, dataset, times
 */
export function initializeComponentSelector(fileUrls, metadata = {}) {
    componentCount = fileUrls?.length || 0;
    // Restore last selected component from localStorage (clamped to valid range)
    const savedIdx = parseInt(localStorage.getItem('selectedComponent') || '0', 10);
    currentComponentIndex = (componentCount > 0 && savedIdx >= 0 && savedIdx < componentCount) ? savedIdx : 0;
    cachedComponentBlobs = [];

    // Store identifiers for cache lookup
    currentSpacecraft = metadata.spacecraft || State.currentMetadata?.spacecraft;
    currentDataset = metadata.dataset || State.currentMetadata?.dataset;
    currentStartTime = metadata.startTime || State.dataStartTime?.toISOString();
    currentEndTime = metadata.endTime || State.dataEndTime?.toISOString();

    const container = document.getElementById('componentSelectorContainer');
    const selector = document.getElementById('componentSelector');

    if (!container || !selector) {
        console.warn('Component selector elements not found');
        return;
    }

    // Show selector only if we have multiple components
    if (componentCount > 1) {
        // Update selector options based on actual number of files
        selector.innerHTML = '';
        for (let i = 0; i < componentCount; i++) {
            const option = document.createElement('option');
            option.value = i;
            const labels = getLabelsForSpacecraft();
            option.textContent = labels[i] || `Component ${i + 1}`;
            selector.appendChild(option);
        }

        selector.value = currentComponentIndex;
        container.style.display = 'flex';
        container.style.opacity = '1';
        container.style.pointerEvents = 'auto';

        // Show denoise toggle
        const denoiseContainer = document.getElementById('denoiseContainer');
        if (denoiseContainer) {
            denoiseContainer.style.display = 'flex';
            // Wire up toggle (only once)
            const toggle = document.getElementById('denoiseToggle');
            if (toggle && !toggle._denoiseWired) {
                toggle._denoiseWired = true;
                // Restore saved state from localStorage
                const savedDetone = localStorage.getItem('detoneEnabled') === 'true';
                toggle.checked = savedDetone;

                toggle.addEventListener('change', (e) => {
                    const active = e.target.checked;
                    localStorage.setItem('detoneEnabled', active ? 'true' : 'false');
                    toggleDenoise(active);
                    if (active) {
                        const samples = State.getCompleteSamplesArray?.() || State.completeSamplesArray;
                        if (samples && samples.length > 0) {
                            const sr = State.audioContext?.sampleRate || 44100;
                            runDenoise(samples, sr);
                        }
                    }
                    e.target.blur();
                });
            }

            // If saved state was on, kick off detection immediately for the loaded data
            if (toggle && toggle.checked) {
                toggleDenoise(true);
                const samples = State.getCompleteSamplesArray?.() || State.completeSamplesArray;
                if (samples && samples.length > 0) {
                    const sr = State.audioContext?.sampleRate || 44100;
                    runDenoise(samples, sr);
                }
            }
        }

        // If saved component is not the default (index 0), switch to it now
        // The data pipeline always loads index 0 first; we follow up with the saved choice
        if (currentComponentIndex !== 0) {
            // Mark internal state as 0 so switchComponent knows it's a real switch
            const targetIdx = currentComponentIndex;
            currentComponentIndex = 0;
            setTimeout(() => switchComponent(targetIdx), 100);
        }
    } else {
        container.style.display = 'none';
        const denoiseContainer = document.getElementById('denoiseContainer');
        if (denoiseContainer) denoiseContainer.style.display = 'none';
    }
}

/**
 * Hide the component selector
 */
export function hideComponentSelector() {
    const container = document.getElementById('componentSelectorContainer');
    if (container) {
        container.style.display = 'none';
    }
    componentCount = 0;
    currentComponentIndex = 0;
    cachedComponentBlobs = [];
}

/**
 * Get component blob from cache
 * @param {number} componentIndex
 * @returns {Promise<Blob|null>}
 */
async function getComponentBlob(componentIndex) {
    // Check if we already have blobs in memory
    if (cachedComponentBlobs[componentIndex]) {
        if (window.pm?.data) console.log(`   📦 Using in-memory cached blob for component ${componentIndex}`);
        return cachedComponentBlobs[componentIndex];
    }

    // Try to get from IndexedDB cache
    if (currentSpacecraft && currentDataset && currentStartTime && currentEndTime) {
        const cached = await getAudioData(currentSpacecraft, currentDataset, currentStartTime, currentEndTime);
        if (window.pm?.data) console.log(`   🔍 Cache lookup result:`, {
            hasCache: !!cached,
            hasAllComponentBlobs: !!cached?.allComponentBlobs,
            blobCount: cached?.allComponentBlobs?.length || 0,
            requestedIndex: componentIndex
        });
        if (cached?.allComponentBlobs && cached.allComponentBlobs[componentIndex]) {
            // Store all blobs in memory for future use
            cachedComponentBlobs = cached.allComponentBlobs;
            if (window.pm?.data) console.log(`   📦 Loaded ${cachedComponentBlobs.length} component blobs from IndexedDB cache`);
            return cachedComponentBlobs[componentIndex];
        }
    }

    return null;
}

/**
 * Switch to a different component
 * @param {number} componentIndex - Index of the component to switch to
 */
export async function switchComponent(componentIndex) {
    if (componentIndex < 0 || componentIndex >= componentCount) {
        console.warn(`Invalid component index: ${componentIndex}`);
        return;
    }

    if (componentIndex === currentComponentIndex) {
        return; // Already on this component
    }

    const labels = getLabelsForSpacecraft();
    if (window.pm?.data) {
        console.log(`🔄 Switching to component ${componentIndex}: ${labels[componentIndex]}`);
        console.log(`   📍 Time range and regions will be preserved (same time period, different vector component)`);
    }

    try {
        // Capture current playback state before switching
        const wasPlaying = State.playbackState === 'playing';
        const currentPosition = State.currentAudioPosition;
        if (window.pm?.audio) console.log(`   🎵 Current state: wasPlaying=${wasPlaying}, position=${currentPosition?.toFixed(2)}s`);

        // Get blob from cache (NOT from URL - those expire!)
        const wavBlob = await getComponentBlob(componentIndex);

        if (!wavBlob) {
            throw new Error(`Component ${componentIndex} not available in cache. The CDAWeb temporary files may have expired. Please reload the data.`);
        }

        // Decode the WAV file — MUST patch the header to 44.1 kHz first, same as
        // the initial load path in data-fetcher.js/decodeWAVBlob. Without this,
        // the browser resamples 22 kHz → 44.1 kHz, doubling the sample count and
        // breaking everything downstream (audio, spectrogram range, waveform).
        const arrayBuffer = await wavBlob.arrayBuffer();
        {
            const headerView = new DataView(arrayBuffer);
            const origSampleRate = headerView.getUint32(24, true);
            const numChannels = headerView.getUint16(22, true);
            const bitsPerSample = headerView.getUint16(34, true);
            const targetSampleRate = 44100;
            if (origSampleRate !== targetSampleRate) {
                headerView.setUint32(24, targetSampleRate, true);
                headerView.setUint32(28, targetSampleRate * numChannels * (bitsPerSample / 8), true);
            }
        }
        const offlineContext = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await offlineContext.decodeAudioData(arrayBuffer);
        await offlineContext.close();

        // Extract samples
        const samples = audioBuffer.getChannelData(0);

        if (window.pm?.data) console.log(`   📊 Loaded ${samples.length.toLocaleString()} samples for ${labels[componentIndex]}`);

        // Apply the same detrend+normalize pipeline as the initial load
        // (data-fetcher.js). Without this, switching to a component with a big
        // DC offset (e.g. Br ≈ -0.8) lands 16× louder than the first load.
        const { removeDCOffset: detrend, normalize: norm } = await import('./minimap-window-renderer.js');
        const rawSamples = new Float32Array(samples);
        const playbackSamples = norm(detrend(new Float32Array(samples), 0.999));
        window.rawWaveformData = rawSamples;
        window._playbackSamples = playbackSamples;

        // Update state with playback version (DC-removed, normalized) — matches initial load
        State.setCompleteSamplesArray(playbackSamples);

        // Re-run denoise detection if active — use AUDIO sample rate, not data sample rate
        if (isDenoiseActive()) {
            const sr = State.audioContext?.sampleRate || 44100;
            setTimeout(() => runDenoise(playbackSamples, sr), 100);
        }

        // NOTE: We do NOT update dataStartTime, dataEndTime, or clear regions
        // Those represent the SAME time period across all components

        // Send to waveform worker - RESET first, then add new samples
        if (State.waveformWorker) {
            // Reset worker to clear old samples (otherwise it appends!)
            State.waveformWorker.postMessage({ type: 'reset' });
            // Worker gets playback for processed path, raw for visual (matches initial load contract)
            State.waveformWorker.postMessage({
                type: 'add-samples',
                samples: playbackSamples,
                rawSamples: rawSamples
            });
        }

        // Send to AudioWorklet - use dual-buffer crossfade for seamless switching
        if (State.workletNode) {
            if (window.pm?.audio) console.log(`   🔊 Sending ${playbackSamples.length.toLocaleString()} samples to AudioWorklet for crossfade...`);

            // Use swap-buffer for seamless crossfade (no clicks!)
            // The worklet will:
            // 1. Store new samples in pending buffer
            // 2. Crossfade from current buffer to pending buffer (50ms)
            // 3. After crossfade, pending becomes primary
            State.workletNode.port.postMessage({
                type: 'swap-buffer',
                samples: playbackSamples,
                sampleRate: State.currentMetadata?.original_sample_rate || 100
            });
            if (window.pm?.audio) console.log(`   🔊 Initiated crossfade swap (50ms equal-power crossfade)`);

            // Also update stretch processor if it's active
            if (State.stretchActive && State.stretchNode) {
                State.stretchNode.port.postMessage({
                    type: 'load-audio',
                    data: { samples: Array.from(playbackSamples) }
                });
            }

            // No need to seek - the worklet maintains position during swap
        } else {
            console.warn(`   ⚠️ No workletNode available!`);
        }

        // rawWaveformData already set above. Redraw minimap directly — do NOT call
        // changeWaveformFilter(): it would normalize(raw) and send its own swap-buffer,
        // stomping the detrended+normalized buffer we just installed.
        const { drawWaveform } = await import('./minimap-window-renderer.js');
        drawWaveform();

        // 🔄 SPECTROGRAM CROSSFADE: Use same pattern as frequency scale change
        // (capture old, reset state, render new, animate crossfade)
        const {
            resetSpectrogramState,
            renderCompleteSpectrogram,
            getSpectrogramViewport
        } = await import('./main-window-renderer.js');

        // Reset and re-render with Three.js (GPU render is instant, no crossfade needed)
        resetSpectrogramState();
        await renderCompleteSpectrogram();

        currentComponentIndex = componentIndex;
        localStorage.setItem('selectedComponent', String(componentIndex));
        if (window.pm?.render) {
            console.log(`✅ Component switched to ${labels[componentIndex]}`);
            console.log(`   ✅ Regions and time range preserved`);
        }

    } catch (error) {
        console.error(`❌ Failed to switch component:`, error);
    }
}

/**
 * Set up event listener for component selector
 */
export function setupComponentSelectorListener() {
    const selector = document.getElementById('componentSelector');

    if (!selector) {
        console.warn('Component selector not found');
        return;
    }

    selector.addEventListener('change', (e) => {
        const newIndex = parseInt(e.target.value);
        switchComponent(newIndex);
        // Blur so spacebar still works for play/pause
        e.target.blur();
    });

    // Blur on spacebar so it doesn't capture play/pause
    selector.addEventListener('keydown', (e) => {
        if (e.code === 'Space') {
            e.preventDefault();
            e.target.blur();
        }
    });

    // Listen for background download completion
    window.addEventListener('componentsReady', (e) => {
        const { allBlobs } = e.detail;
        if (allBlobs && allBlobs.length > 0) {
            cachedComponentBlobs = allBlobs;
            if (window.pm?.data) console.log(`📊 Component selector received ${allBlobs.length} cached blobs`);
        }
    });

    if (window.pm?.init) console.log('📊 Component selector listener attached');
}

/**
 * Get current component count
 * @returns {number}
 */
export function getComponentCount() {
    return componentCount;
}

/**
 * Get current component index
 * @returns {number}
 */
export function getCurrentComponentIndex() {
    return currentComponentIndex;
}

/**
 * Get all component blobs from cache
 * @returns {Promise<Array<Blob>|null>}
 */
export async function getAllComponentBlobs() {
    // Check if we have blobs in memory
    if (cachedComponentBlobs.length > 0) {
        if (window.pm?.data) console.log(`📦 Using ${cachedComponentBlobs.length} in-memory cached blobs`);
        return cachedComponentBlobs;
    }

    // Try to get from IndexedDB cache
    if (currentSpacecraft && currentDataset && currentStartTime && currentEndTime) {
        const cached = await getAudioData(currentSpacecraft, currentDataset, currentStartTime, currentEndTime);
        if (cached?.allComponentBlobs && cached.allComponentBlobs.length > 0) {
            cachedComponentBlobs = cached.allComponentBlobs;
            if (window.pm?.data) console.log(`📦 Loaded ${cachedComponentBlobs.length} component blobs from IndexedDB cache`);
            return cachedComponentBlobs;
        }
    }

    return null;
}

/**
 * Get current component labels
 * @returns {Array<string>}
 */
export function getComponentLabels() {
    const labels = getLabelsForSpacecraft();
    return labels.slice(0, componentCount);
}

/**
 * Get current data identifiers for filename generation
 * @returns {Object}
 */
export function getCurrentDataIdentifiers() {
    return {
        spacecraft: currentSpacecraft,
        dataset: currentDataset,
        startTime: currentStartTime,
        endTime: currentEndTime
    };
}
