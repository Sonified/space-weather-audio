/**
 * streaming.js
 * Data streaming orchestration: startStreaming flow and spacecraft dropdown labels.
 * Extracted from main.js for modularity.
 */

import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { initWaveformWorker, clearWaveformRenderer } from './minimap-window-renderer.js';
import { clearAllCanvasFeatureBoxes } from './spectrogram-renderer.js';
import { clearCompleteSpectrogram } from './main-window-renderer.js';
import { zoomState } from './zoom-state.js';
import { updateShareButtonState } from './share-modal.js';
import { drawDayMarkers } from './day-markers.js';
import { initScrollZoom } from './scroll-zoom.js';
import { isStudyMode } from './master-modes.js';
import { initAudioWorklet } from './audio-worklet-init.js';

// ===== FIRST FETCH TRACKING =====
let hasPerformedFirstFetch = false; // Track if first fetch has been performed

/**
 * Getter for hasPerformedFirstFetch (module-scoped let can't be re-exported)
 */
export function getHasPerformedFirstFetch() {
    return hasPerformedFirstFetch;
}

/**
 * Main data streaming function — fetches space weather data and sets up playback.
 * @param {Event|null} event - The triggering event (e.g., form submit), or null
 * @param {Object|null} config - Optional direct config { spacecraft, dataset, startTime, endTime }
 */
export async function startStreaming(event, config = null) {
    try {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }

        // Mark that first fetch has been performed (disables Enter key shortcut)
        hasPerformedFirstFetch = true;

        // Remove pulsing glow from spacecraft selector when user starts fetching
        const spacecraftSelect = document.getElementById('spacecraft');
        if (spacecraftSelect) {
            spacecraftSelect.classList.remove('pulse-glow');
        }

        // Group cleanup operations
        if (!isStudyMode()) {
            console.groupCollapsed('🧹 [CLEANUP] Preparing for New Data');
        }

        // Clear complete spectrogram and waveform renderers when loading new data
        clearCompleteSpectrogram();
        clearWaveformRenderer();
        clearAllCanvasFeatureBoxes();

        // Close old AudioContext to release OS audio threads and internal buffers (~10-50MB)
        if (State.audioContext) {
            try { State.audioContext.close(); } catch (e) { /* already closed */ }
            State.setAudioContext(null);
        }

        // Clear stale window globals
        window.playbackDurationSeconds = null;
        window.streamingStartTime = null;

        // 🔧 FIX: Reset zoom state fully when loading new data
        // Must null out timestamps so isInitialized() returns false —
        // otherwise the old dataset's timestamps persist and the camera
        // ends up at (oldTime - newDataStart) = millions of seconds off-screen
        if (zoomState.isInitialized()) {
            zoomState.mode = 'full';
            zoomState.currentViewStartSample = 0;
            zoomState.currentViewStartTime = null;
            zoomState.currentViewEndTime = null;
            zoomState.activeRegionId = null;
            if (!isStudyMode()) {
                console.log('🔄 Reset zoom state for new data');
            }
        }

        // Reset waveform click tracking when loading new data
        State.setWaveformHasBeenClicked(false);
        const waveformCanvas = document.getElementById('minimap');
        if (waveformCanvas) {
            waveformCanvas.classList.remove('pulse');
        }

        // Terminate and recreate waveform worker to free memory
        // Note: initWaveformWorker() already handles cleanup, but we do it here too for safety
        if (State.waveformWorker) {
            State.waveformWorker.onmessage = null;  // Break closure chain
            State.waveformWorker.terminate();
            if (!isStudyMode()) {
                console.log('🧹 Terminated waveform worker');
            }
        }
        initWaveformWorker();

        if (!isStudyMode()) {
            console.groupEnd(); // End Cleanup
        }

        State.setIsShowingFinalWaveform(false);

        // Initialize audio worklet for playback
        await initAudioWorklet();

        window.streamingStartTime = performance.now();
        const logTime = () => `[${Math.round(performance.now() - window.streamingStartTime)}ms]`;

        if (window.pm?.data) console.log('🎬 [0ms] Fetching CDAWeb audio data');

        // Get data config: direct config object OR form values
        let spacecraft, dataset, startTimeISO, endTimeISO;

        if (config) {
            // Direct config passed (e.g., EMIC study with fixed time window)
            spacecraft = config.spacecraft;
            dataset = config.dataset;
            startTimeISO = config.startTime;
            endTimeISO = config.endTime;
        } else {
            // Read from form elements
            const spacecraftEl = document.getElementById('spacecraft');
            const dataTypeEl = document.getElementById('dataType');
            const startDateEl = document.getElementById('startDate');
            const startTimeEl = document.getElementById('startTime');
            const endDateEl = document.getElementById('endDate');
            const endTimeEl = document.getElementById('endTime');

            const sv = spacecraftEl?.value, dv = dataTypeEl?.value;
            const sd = startDateEl?.value, st = startTimeEl?.value;
            const ed = endDateEl?.value, et = endTimeEl?.value;

            if (!sv || !dv || !sd || !st || !ed || !et) {
                alert('Please fill in all fields (spacecraft, dataset, start date/time, end date/time)');
                return;
            }

            spacecraft = sv;
            dataset = dv;
            startTimeISO = `${sd}T${st}Z`;
            endTimeISO = `${ed}T${et}Z`;
        }

        if (window.pm?.data) console.log(`🛰️ ${logTime()} Fetching: ${spacecraft} ${dataset} from ${startTimeISO} to ${endTimeISO}`);

        // Check data source selection
        const dataSourceEl = document.getElementById('dataSource');
        const dataSource = dataSourceEl ? dataSourceEl.value : 'cdaweb';

        // Update status with animated loading indicator
        const statusDiv = document.getElementById('status');
        const silentDownload = document.getElementById('silentDownload')?.checked;
        let dotCount = 0;
        const sourceName = dataSource === 'cloudflare' ? 'Cloudflare' : 'CDAWeb';
        const baseMessage = `Fetching ${spacecraft} ${dataset} from ${sourceName}`;
        let loadingInterval = null;
        if (statusDiv && !silentDownload) {
            // Cancel any active typing/pulse animations that could fight with our interval
            import('./status-text.js').then(m => m.cancelTyping && m.cancelTyping()).catch(() => {});
            statusDiv.textContent = baseMessage + '...';
            statusDiv.className = 'status loading';
            loadingInterval = setInterval(() => {
                dotCount = (dotCount % 3) + 1;
                // Re-assert loading class in case something else changed it
                if (!statusDiv.classList.contains('loading')) {
                    statusDiv.className = 'status loading';
                }
                statusDiv.textContent = baseMessage + '.'.repeat(dotCount);
            }, 500);
            // Store so the fetcher can kill this animation once chunk downloads begin
            State.setLoadingInterval(loadingInterval);
        }

        // Fetch and load data from selected source
        if (window.pm?.data) console.log(`📦 [STREAMING] Data source: ${dataSource} — starting fetch for ${spacecraft}/${dataset} (${startTimeISO} → ${endTimeISO})`);
        try {
        if (dataSource === 'cloudflare') {
            if (window.pm?.data) console.log(`📦 [STREAMING] Importing goes-cloudflare-fetcher.js...`);
            const { fetchAndLoadCloudflareData } = await import('./goes-cloudflare-fetcher.js');
            await fetchAndLoadCloudflareData(spacecraft, dataset, startTimeISO, endTimeISO);
            if (window.pm?.data) console.log(`📦 [STREAMING] Cloudflare fetch complete`);
        } else {
            if (window.pm?.data) console.log(`📦 [STREAMING] Importing data-fetcher.js...`);
            const { fetchAndLoadCDAWebData } = await import('./data-fetcher.js');
            await fetchAndLoadCDAWebData(spacecraft, dataset, startTimeISO, endTimeISO);
            if (window.pm?.data) console.log(`📦 [STREAMING] CDAWeb fetch complete`);
        }
        } finally {
            if (loadingInterval) clearInterval(loadingInterval);
            if (statusDiv) statusDiv.classList.remove('loading');
        }

        // Check if autoPlay is enabled and start playback indicator
        const autoPlayEnabled = document.getElementById('autoPlay')?.checked;
        if (autoPlayEnabled && State.playbackState === PlaybackState.PLAYING) {
            const { startPlaybackIndicator } = await import('./minimap-window-renderer.js');
            // console.log(`⏱️ ${logTime()} Worklet confirmed playback`);
            startPlaybackIndicator();
        }

        // Update status and highlight waveform for user guidance
        // For shared sessions, show "Ready to play" message instead
        // Uses separate localStorage variable from tutorial State to persist across sessions
        const userHasClickedWaveformOnce = localStorage.getItem('userHasClickedWaveformOnce') === 'true';
        const isSharedSession = sessionStorage.getItem('isSharedSession') === 'true';
        // Don't overwrite study flow status text (it manages its own instructions)
        if (statusDiv && !isStudyMode()) {
            if (isSharedSession) {
                statusDiv.textContent = '🎧 Ready! Click PLAY or press the SPACE BAR to start playback.';
                statusDiv.className = 'status';
            } else if (userHasClickedWaveformOnce) {
                statusDiv.textContent = 'Scroll to zoom, drag to pan, arrow keys to navigate, click and drag to draw a feature box';
                statusDiv.className = 'status info';
            } else {
                statusDiv.textContent = 'Click the waveform to jump to a new location.';
                statusDiv.className = 'status info';
            }
        }
        // Pulse removed — was distracting

        // Reload recent searches dropdown (function is defined in DOMContentLoaded)
        if (typeof window.loadRecentSearches === 'function') {
            await window.loadRecentSearches();
        }

        // Enable share button now that data is loaded
        updateShareButtonState();

        // Draw day markers if enabled in gear popovers (EMIC mode)
        // Skip if rendering is deferred (triggered mode) — they'll draw when rendering starts
        const renderMode = document.getElementById('dataRendering')?.value;
        if (renderMode !== 'triggered') drawDayMarkers();

        // Initialize scroll-to-zoom (EMIC mode, gated by checkbox)
        initScrollZoom();


        if (window.pm?.init) console.log(`🎉 ${logTime()} Complete!`);
        if (window.pm?.rendering) {
            console.log('════════════════════');
            console.log('📌 v2.0 (2026-02-12) Three.js GPU-accelerated rendering');
            console.log('════════════════════');
        }

    } catch (error) {

        console.error('❌ Error in startStreaming:', error);
        const statusDiv = document.getElementById('status');
        if (statusDiv) {
            statusDiv.textContent = `Error: ${error.message}`;
            statusDiv.className = 'status error';
        }
        throw error;
    }
}

/**
 * Update spacecraft dropdown labels to show which spacecraft has loaded data
 * @param {string|null} loadedSpacecraft - Spacecraft with loaded data (null to clear all flags)
 * @param {string} selectedSpacecraft - Currently selected spacecraft
 */
export function updateSpacecraftDropdownLabels(loadedSpacecraft, selectedSpacecraft) {
    const spacecraftSelect = document.getElementById('spacecraft');
    if (!spacecraftSelect) return;

    // Update all options - use data attribute or current text as base
    Array.from(spacecraftSelect.options).forEach(option => {
        const spacecraftValue = option.value;
        // Store original label in data attribute if not already stored
        if (!option.dataset.originalLabel) {
            option.dataset.originalLabel = option.textContent;
        }
        const baseLabel = option.dataset.originalLabel;

        if (loadedSpacecraft && spacecraftValue === loadedSpacecraft && spacecraftValue !== selectedSpacecraft) {
            // This spacecraft has loaded data but user selected a different one
            option.textContent = `${baseLabel} - Currently Loaded`;
        } else {
            // Clear any flags
            option.textContent = baseLabel;
        }
    });
}
