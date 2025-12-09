/**
 * component-selector.js
 * Handles switching between CDAWeb audio components (br, bt, bn)
 * Uses cached blobs instead of URLs to avoid CDAWeb temporary file expiration
 */

import * as State from './audio-state.js';
import { getAudioData } from './cdaweb-cache.js';

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
    // Default fallback
    'default': ['Component 1', 'Component 2', 'Component 3']
};

/**
 * Get component labels for current spacecraft
 * @returns {Array<string>}
 */
function getLabelsForSpacecraft() {
    return COMPONENT_LABELS[currentSpacecraft] || COMPONENT_LABELS['default'];
}

/**
 * Initialize component selector with file URLs from CDAWeb
 * @param {Array<string>} fileUrls - Array of WAV file URLs (used for count, not fetching)
 * @param {Object} metadata - Metadata containing spacecraft, dataset, times
 */
export function initializeComponentSelector(fileUrls, metadata = {}) {
    componentCount = fileUrls?.length || 0;
    currentComponentIndex = 0;
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

        console.log(`📊 Component selector initialized with ${componentCount} components`);
    } else {
        container.style.display = 'none';
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
        console.log(`   📦 Using in-memory cached blob for component ${componentIndex}`);
        return cachedComponentBlobs[componentIndex];
    }

    // Try to get from IndexedDB cache
    if (currentSpacecraft && currentDataset && currentStartTime && currentEndTime) {
        const cached = await getAudioData(currentSpacecraft, currentDataset, currentStartTime, currentEndTime);
        console.log(`   🔍 Cache lookup result:`, {
            hasCache: !!cached,
            hasAllComponentBlobs: !!cached?.allComponentBlobs,
            blobCount: cached?.allComponentBlobs?.length || 0,
            requestedIndex: componentIndex
        });
        if (cached?.allComponentBlobs && cached.allComponentBlobs[componentIndex]) {
            // Store all blobs in memory for future use
            cachedComponentBlobs = cached.allComponentBlobs;
            console.log(`   📦 Loaded ${cachedComponentBlobs.length} component blobs from IndexedDB cache`);
            return cachedComponentBlobs[componentIndex];
        }
    }

    return null;
}

/**
 * Switch to a different component
 * @param {number} componentIndex - Index of the component to switch to
 */
async function switchComponent(componentIndex) {
    if (componentIndex < 0 || componentIndex >= componentCount) {
        console.warn(`Invalid component index: ${componentIndex}`);
        return;
    }

    if (componentIndex === currentComponentIndex) {
        return; // Already on this component
    }

    const labels = getLabelsForSpacecraft();
    console.log(`🔄 Switching to component ${componentIndex}: ${labels[componentIndex]}`);
    console.log(`   📍 Time range and regions will be preserved (same time period, different vector component)`);

    try {
        // Capture current playback state before switching
        const wasPlaying = State.playbackState === 'playing';
        const currentPosition = State.currentAudioPosition;
        console.log(`   🎵 Current state: wasPlaying=${wasPlaying}, position=${currentPosition?.toFixed(2)}s`);

        // Get blob from cache (NOT from URL - those expire!)
        const wavBlob = await getComponentBlob(componentIndex);

        if (!wavBlob) {
            throw new Error(`Component ${componentIndex} not available in cache. The CDAWeb temporary files may have expired. Please reload the data.`);
        }

        // Decode the WAV file
        const offlineContext = new (window.AudioContext || window.webkitAudioContext)();
        const arrayBuffer = await wavBlob.arrayBuffer();
        const audioBuffer = await offlineContext.decodeAudioData(arrayBuffer);
        await offlineContext.close();

        // Extract samples
        const samples = audioBuffer.getChannelData(0);

        console.log(`   📊 Loaded ${samples.length.toLocaleString()} samples for ${labels[componentIndex]}`);

        // Update state with new samples (KEEP time range and regions intact!)
        State.setCompleteSamplesArray(samples);

        // NOTE: We do NOT update dataStartTime, dataEndTime, or clear regions
        // Those represent the SAME time period across all components

        // Send to waveform worker
        if (State.waveformWorker) {
            State.waveformWorker.postMessage({
                type: 'add-samples',
                samples: samples,
                rawSamples: samples
            });
        }

        // Send to AudioWorklet - use dual-buffer crossfade for seamless switching
        if (State.workletNode) {
            console.log(`   🔊 Sending ${samples.length.toLocaleString()} samples to AudioWorklet for crossfade...`);

            // Use swap-buffer for seamless crossfade (no clicks!)
            // The worklet will:
            // 1. Store new samples in pending buffer
            // 2. Crossfade from current buffer to pending buffer (50ms)
            // 3. After crossfade, pending becomes primary
            State.workletNode.port.postMessage({
                type: 'swap-buffer',
                samples: samples,
                sampleRate: State.currentMetadata?.original_sample_rate || 100
            });
            console.log(`   🔊 Initiated crossfade swap (50ms equal-power crossfade)`);

            // No need to seek - the worklet maintains position during swap
        } else {
            console.warn(`   ⚠️ No workletNode available!`);
        }

        // Redraw waveform (new signal, same time axis)
        const { drawWaveform } = await import('./waveform-renderer.js');
        drawWaveform();

        // 🔄 SPECTROGRAM CROSSFADE: Use same pattern as frequency scale change
        // (capture old, reset state, render new, animate crossfade)
        const {
            resetSpectrogramState,
            renderCompleteSpectrogram,
            getSpectrogramViewport
        } = await import('./spectrogram-complete-renderer.js');

        const canvas = document.getElementById('spectrogram');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            const width = canvas.width;
            const height = canvas.height;

            // Step 1: Capture current spectrogram BEFORE re-rendering
            const oldSpectrogram = document.createElement('canvas');
            oldSpectrogram.width = width;
            oldSpectrogram.height = height;
            oldSpectrogram.getContext('2d').drawImage(canvas, 0, 0);

            // Step 2: Reset internal state (but NOT the display canvas!)
            resetSpectrogramState();

            // Step 3: Render new spectrogram in background
            await renderCompleteSpectrogram();

            // Step 4: Get viewport of new spectrogram for crossfade
            const playbackRate = State.currentPlaybackRate || 1.0;
            const newSpectrogram = getSpectrogramViewport(playbackRate);

            if (newSpectrogram) {
                // Step 5: Animate crossfade (50ms to match audio crossfade)
                const fadeDuration = 50;
                const fadeStart = performance.now();

                const fadeStep = () => {
                    if (!document.body || !document.body.isConnected) {
                        return;
                    }

                    const elapsed = performance.now() - fadeStart;
                    const progress = Math.min(elapsed / fadeDuration, 1.0);

                    // Clear and draw blend
                    ctx.clearRect(0, 0, width, height);

                    // Old fading OUT
                    ctx.globalAlpha = 1.0 - progress;
                    ctx.drawImage(oldSpectrogram, 0, 0);

                    // New fading IN
                    ctx.globalAlpha = progress;
                    ctx.drawImage(newSpectrogram, 0, 0);

                    ctx.globalAlpha = 1.0;

                    if (progress < 1.0) {
                        requestAnimationFrame(fadeStep);
                    } else {
                        console.log(`🔄 Spectrogram crossfade complete`);
                    }
                };

                fadeStep();
            } else {
                console.warn('⚠️ Could not get new spectrogram viewport for crossfade');
            }
        }

        currentComponentIndex = componentIndex;
        console.log(`✅ Component switched to ${labels[componentIndex]}`);
        console.log(`   ✅ Regions and time range preserved`);

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
            console.log(`📊 Component selector received ${allBlobs.length} cached blobs`);
        }
    });

    console.log('📊 Component selector listener attached');
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
        console.log(`📦 Using ${cachedComponentBlobs.length} in-memory cached blobs`);
        return cachedComponentBlobs;
    }

    // Try to get from IndexedDB cache
    if (currentSpacecraft && currentDataset && currentStartTime && currentEndTime) {
        const cached = await getAudioData(currentSpacecraft, currentDataset, currentStartTime, currentEndTime);
        if (cached?.allComponentBlobs && cached.allComponentBlobs.length > 0) {
            cachedComponentBlobs = cached.allComponentBlobs;
            console.log(`📦 Loaded ${cachedComponentBlobs.length} component blobs from IndexedDB cache`);
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
