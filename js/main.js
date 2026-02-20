/**
 * main.js
 * Main orchestration: initialization, startStreaming, event handlers
 */


import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { togglePlayPause, toggleLoop, changePlaybackSpeed, changeVolume, resetSpeedTo1, resetVolumeTo1, updatePlaybackSpeed, downloadAudio, cancelAllRAFLoops, setResizeRAFRef, switchStretchAlgorithm, primeStretchProcessors } from './audio-player.js';
import { initWaveformWorker, setupWaveformInteraction, drawWaveform, drawWaveformFromMinMax, drawWaveformWithSelection, changeWaveformFilter, updatePlaybackIndicator, startPlaybackIndicator, clearWaveformRenderer } from './waveform-renderer.js';
import { changeFrequencyScale, loadFrequencyScale, changeColormap, loadColormap, changeFftSize, loadFftSize, startVisualization, setupSpectrogramSelection, cleanupSpectrogramSelection, redrawAllCanvasFeatureBoxes } from './spectrogram-renderer.js';
import { clearCompleteSpectrogram, startMemoryMonitoring, updateSpectrogramViewport, aggressiveCleanup } from './spectrogram-three-renderer.js';
import { loadSavedSpacecraft, saveDateTime, updateStationList, updateDatasetOptions, enableFetchButton, purgeCloudflareCache, openParticipantModal, closeParticipantModal, submitParticipantSetup, openWelcomeModal, closeWelcomeModal, openEndModal, closeEndModal, openPreSurveyModal, closePreSurveyModal, submitPreSurvey, openPostSurveyModal, closePostSurveyModal, submitPostSurvey, openActivityLevelModal, closeActivityLevelModal, submitActivityLevelSurvey, openAwesfModal, closeAwesfModal, submitAwesfSurvey, changeBaseSampleRate, handleWaveformFilterChange, resetWaveformFilterToDefault, setupModalEventListeners, attemptSubmission, openBeginAnalysisModal, openCompleteConfirmationModal, openTutorialRevisitModal } from './ui-controls.js';
import { getParticipantIdFromURL, storeParticipantId, getParticipantId } from './qualtrics-api.js';
import { initAdminMode, isAdminMode, toggleAdminMode } from './admin-mode.js';
import { trackUserAction } from '../Qualtrics/participant-response-manager.js';
import { initializeModals } from './modal-templates.js';
import { modalManager } from './modal-manager.js';
import { initErrorReporter } from './error-reporter.js';
import { initSilentErrorReporter } from './silent-error-reporter.js';
import { positionAxisCanvas, resizeAxisCanvas, drawFrequencyAxis, initializeAxisPlaybackRate, setMinFreqMultiplier, getMinFreqMultiplier } from './spectrogram-axis-renderer.js';
import { positionWaveformAxisCanvas, resizeWaveformAxisCanvas, drawWaveformAxis } from './waveform-axis-renderer.js';
import { positionWaveformXAxisCanvas, resizeWaveformXAxisCanvas, drawWaveformXAxis, positionWaveformDateCanvas, resizeWaveformDateCanvas, drawWaveformDate, initializeMaxCanvasWidth, cancelZoomTransitionRAF, stopZoomTransition } from './waveform-x-axis-renderer.js';
import { positionWaveformButtonsCanvas, resizeWaveformButtonsCanvas, drawRegionButtons } from './waveform-buttons-renderer.js';
import { drawSpectrogramXAxis, positionSpectrogramXAxisCanvas, resizeSpectrogramXAxisCanvas } from './spectrogram-x-axis-renderer.js';
import { initRegionTracker, toggleRegion, toggleRegionPlay, addFeature, updateFeature, deleteRegion, startFrequencySelection, createTestRegion, setSelectionFromActiveRegionIfExists, getActivePlayingRegionIndex, clearActivePlayingRegion, switchSpacecraftRegions, updateCompleteButtonState, updateCmpltButtonState, showAddRegionButton } from './region-tracker.js';
import { updateAllFeatureBoxPositions } from './spectrogram-feature-boxes.js';
import { zoomState } from './zoom-state.js';
import { initKeyboardShortcuts, cleanupKeyboardShortcuts } from './keyboard-shortcuts.js';
import { setStatusText, appendStatusText, initTutorial, disableFrequencyScaleDropdown, removeVolumeSliderGlow } from './tutorial.js';
import { isTutorialActive } from './tutorial-state.js';
import { drawDayMarkers, clearDayMarkers } from './day-markers.js';
import { initScrollZoom } from './scroll-zoom.js';
import {
    CURRENT_MODE,
    AppMode,
    isPersonalMode,
    isDevMode,
    isStudyMode,
    isEmicStudyMode,
    initializeMasterMode
} from './master-modes.js';
import { initShareModal, openShareModal, checkAndLoadSharedSession, applySharedSession, updateShareButtonState } from './share-modal.js';
import { log, logGroup, logGroupEnd } from './logger.js';

// console.groupCollapsed('📦 [MODULE] Loading');
// console.log('✅ ALL IMPORTS COMPLETE');

// ===== DEBUG FLAGS =====
const DEBUG_LOOP_FADES = true; // Enable loop fade logging

// ===== FIRST FETCH TRACKING =====
let hasPerformedFirstFetch = false; // Track if first fetch has been performed

console.log('✅ CONSTANTS DEFINED');
console.groupEnd();

// Helper function to safely check study mode (handles cases where module isn't loaded yet)
function safeIsStudyMode() {
    try {
        return isStudyMode();
    } catch (e) {
        // If isStudyMode is not available, assume not in study mode (allows logging)
        return false;
    }
}

/**
 * Create a WAV file blob from Float32Array samples
 * @param {Float32Array} samples - Audio samples (normalized -1 to 1)
 * @param {number} sampleRate - Sample rate in Hz
 * @returns {Blob} WAV file blob
 */
function createWAVBlob(samples, sampleRate) {
    const numChannels = 1; // Mono
    const bitsPerSample = 16; // 16-bit PCM
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = samples.length * bytesPerSample;
    const fileSize = 44 + dataSize; // 44-byte header + data
    
    // Create ArrayBuffer for WAV file
    const buffer = new ArrayBuffer(fileSize);
    const view = new DataView(buffer);
    
    // Write WAV header
    let offset = 0;
    
    // RIFF chunk descriptor
    writeString(view, offset, 'RIFF'); offset += 4;
    view.setUint32(offset, fileSize - 8, true); offset += 4;
    writeString(view, offset, 'WAVE'); offset += 4;
    
    // fmt sub-chunk
    writeString(view, offset, 'fmt '); offset += 4;
    view.setUint32(offset, 16, true); offset += 4; // Subchunk size
    view.setUint16(offset, 1, true); offset += 2; // Audio format (1 = PCM)
    view.setUint16(offset, numChannels, true); offset += 2;
    view.setUint32(offset, sampleRate, true); offset += 4;
    view.setUint32(offset, byteRate, true); offset += 4;
    view.setUint16(offset, blockAlign, true); offset += 2;
    view.setUint16(offset, bitsPerSample, true); offset += 2;
    
    // data sub-chunk
    writeString(view, offset, 'data'); offset += 4;
    view.setUint32(offset, dataSize, true); offset += 4;
    
    // Write sample data (convert Float32 to Int16)
    for (let i = 0; i < samples.length; i++) {
        const sample = Math.max(-1, Math.min(1, samples[i])); // Clamp to [-1, 1]
        const int16 = Math.round(sample * 32767); // Convert to 16-bit integer
        view.setInt16(offset, int16, true);
        offset += 2;
    }
    
    return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

// console.log('🟡 Defined safeIsStudyMode');

// Debug flag for chunk loading logs (set to true to enable detailed logging)
// See data-fetcher.js for centralized flags documentation
const DEBUG_CHUNKS = false;

// 🔍 STATUS DEBUG: MutationObserver to catch ALL status changes with stack traces
const DEBUG_STATUS = false;
if (DEBUG_STATUS) {
    // Wait for DOM then attach observer
    const attachStatusObserver = () => {
        const statusEl = document.getElementById('status');
        if (!statusEl) {
            setTimeout(attachStatusObserver, 100);
            return;
        }
        console.log('🔍 [STATUS OBSERVER] Attached to status element');
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'childList' || mutation.type === 'characterData') {
                    const newText = statusEl.textContent?.slice(0, 60);
                    const isShared = sessionStorage.getItem('isSharedSession');
                    const stack = new Error().stack.split('\n').slice(2, 6).join('\n');
                    console.log(`🔍 [STATUS CHANGED] isSharedSession="${isShared}" text="${newText}..."\n${stack}`);
                }
            }
        });
        observer.observe(statusEl, { childList: true, characterData: true, subtree: true });
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', attachStatusObserver);
    } else {
        attachStatusObserver();
    }
}

// console.log('🟡 Set DEBUG_CHUNKS');

// 🧹 MEMORY LEAK FIX: Use event listeners instead of window.* assignments
// This prevents closure memory leaks by avoiding permanent window references
// that capture entire module scopes including State with all audio data

// console.log('🟡 About to define forceIrisFetch');

// Force IRIS fetch state
let forceIrisFetch = false;

// console.log('🟡 About to define toggleForceIris');

// Toggle Force IRIS fetch mode
function toggleForceIris() {
    forceIrisFetch = !forceIrisFetch;
    const btn = document.getElementById('forceIrisBtn');
    if (forceIrisFetch) {
        btn.textContent = '🌐 Force IRIS Fetch: ON';
        btn.style.background = '#dc3545';
        btn.style.borderColor = '#dc3545';
        btn.classList.add('loop-active');
    } else {
        btn.textContent = '🌐 Force IRIS Fetch: OFF';
        btn.style.background = '#6c757d';
        btn.style.borderColor = '#6c757d';
        btn.classList.remove('loop-active');
    }
}

// console.log('🟢 After toggleForceIris');

// Helper function to calculate slider value for 1.0x speed
function calculateSliderForSpeed(targetSpeed) {
    if (targetSpeed <= 1.0) {
        const normalized = Math.log(targetSpeed / 0.1) / Math.log(10);
        return Math.round(normalized * 667);
    } else {
        const normalized = Math.log(targetSpeed) / Math.log(15);
        return Math.round(667 + normalized * 333);
    }
}

// console.log('🟢 After calculateSliderForSpeed');

// Helper functions
function formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}m ${secs}s`;
}

// console.log('🟢 After formatDuration');

function updateCurrentPositionFromSamples(samplesConsumed, totalSamples) {
    // 🔥 FIX: Check document connection first to prevent detached document leaks
    if (!document.body || !document.body.isConnected) {
        return;
    }
    
    // 🔥 FIX: Access State.currentMetadata only when needed, don't retain reference
    const currentMetadata = State.currentMetadata;
    if (!currentMetadata || !totalSamples || totalSamples <= 0 || samplesConsumed < 0) {
        return;
    }
    
    const totalDurationSeconds = window.playbackDurationSeconds;
    
    if (!totalDurationSeconds || !isFinite(totalDurationSeconds) || totalDurationSeconds <= 0) {
        return;
    }
    
    const positionRatio = samplesConsumed / totalSamples;
    const playbackPositionSeconds = positionRatio * totalDurationSeconds;
    
    if (!isFinite(playbackPositionSeconds) || playbackPositionSeconds < 0) {
        return;
    }
    
    const currentPositionEl = document.getElementById('currentPosition');
    if (currentPositionEl && currentPositionEl.isConnected) {
        currentPositionEl.textContent = formatDuration(playbackPositionSeconds);
    }
}

function stopPositionTracking() {
    // 🔥 FIX: Check document connection first to prevent detached document leaks
    if (!document.body || !document.body.isConnected) {
        return;
    }
    
    // 🔥 FIX: Access State only when needed, don't retain reference
    const interval = State.playbackPositionInterval;
    if (interval) {
        clearInterval(interval);
        State.setPlaybackPositionInterval(null);
    }
}

// console.log('🟢 After stopPositionTracking - LINE 170');

// Oscilloscope data collection state
let oscilloscopeRAF = null;
let oscilloscopeAnalyserBuffer = null;

/**
 * Start collecting post-volume audio data from analyser node for oscilloscope visualization
 * This reads from the analyser node which is connected AFTER the gain node, so it shows volume-adjusted audio
 */
function startOscilloscopeDataCollection(analyserNode) {
    if (!analyserNode) return;
    
    // Stop any existing collection
    stopOscilloscopeDataCollection();
    
    // Create a buffer to read analyser data
    // getFloatTimeDomainData requires a buffer of size fftSize (2048), not frequencyBinCount
    const bufferSize = analyserNode.fftSize || 2048;
    oscilloscopeAnalyserBuffer = new Float32Array(bufferSize);
    
    function collectOscilloscopeData() {
        if (!State.analyserNode || !document.body || !document.body.isConnected) {
            oscilloscopeRAF = null;
            return;
        }
        
        // Read time-domain data from analyser (post-volume audio)
        State.analyserNode.getFloatTimeDomainData(oscilloscopeAnalyserBuffer);
        
        // Send to oscilloscope renderer
        import('./oscilloscope-renderer.js').then(({ addOscilloscopeData }) => {
            // Send a chunk of samples (similar to what worklet was sending)
            const samplesToSend = oscilloscopeAnalyserBuffer.slice(0, 128); // Send 128 samples per update
            addOscilloscopeData(samplesToSend);
        });
        
        // Continue collecting
        oscilloscopeRAF = requestAnimationFrame(collectOscilloscopeData);
    }
    
    // Start collection loop
    oscilloscopeRAF = requestAnimationFrame(collectOscilloscopeData);
    // console.log('🎨 Started oscilloscope data collection from analyser node (post-volume)');
}

/**
 * Stop oscilloscope data collection
 */
function stopOscilloscopeDataCollection() {
    if (oscilloscopeRAF !== null) {
        cancelAnimationFrame(oscilloscopeRAF);
        oscilloscopeRAF = null;
    }
    oscilloscopeAnalyserBuffer = null;
}

function toggleAntiAliasing() {
    // Hidden for now - always enabled
    let antiAliasingEnabled = true;
    antiAliasingEnabled = !antiAliasingEnabled;
    const btn = document.getElementById('antiAliasingBtn');
    
    if (antiAliasingEnabled) {
        btn.textContent = '🎛️ Anti-Alias: ON';
        btn.classList.remove('secondary');
        btn.classList.add('loop-active');
    } else {
        btn.textContent = '🎛️ Anti-Alias: OFF';
        btn.classList.remove('loop-active');
        btn.classList.add('secondary');
    }
    
    if (State.workletNode) {
        State.workletNode.port.postMessage({
            type: 'set-anti-aliasing',
            enabled: antiAliasingEnabled
        });
    }
}

// Initialize AudioWorklet
export async function initAudioWorklet() {
    // 🔥 FIX: Clear old worklet message handler before creating new one
    if (State.workletNode) {
        console.log('🧹 Clearing old worklet message handler before creating new worklet...');
        State.workletNode.port.onmessage = null;  // Break closure chain
        State.workletNode.disconnect();
        State.setWorkletNode(null);
    }

    // Clean up old stretch node if exists
    if (State.stretchNode) {
        State.stretchNode.port.onmessage = null;
        State.stretchNode.disconnect();
        State.setStretchNode(null);
        State.setStretchActive(false);
    }
    if (State.sourceGainNode) {
        State.sourceGainNode.disconnect();
        State.setSourceGainNode(null);
    }
    if (State.stretchGainNode) {
        State.stretchGainNode.disconnect();
        State.setStretchGainNode(null);
    }

    // 🔥 FIX: Disconnect old analyser node to prevent memory leak
    if (State.analyserNode) {
        console.log('🧹 Disconnecting old analyser node...');
        State.analyserNode.disconnect();
        State.setAnalyserNode(null);
    }
    
    if (!State.audioContext) {
        const ctx = new AudioContext({
            latencyHint: 'playback'  // 30ms buffer for stable playback (prevents dropouts)
        });
        State.setAudioContext(ctx);
        await ctx.audioWorklet.addModule('workers/audio-worklet.js');
        // Load stretch processor worklets for sub-1x speed time-stretching
        await ctx.audioWorklet.addModule('workers/resample-stretch-processor.js');
        await ctx.audioWorklet.addModule('workers/paul-stretch-processor.js');
        await ctx.audioWorklet.addModule('workers/granular-stretch-processor.js');

        if (!isStudyMode()) {
            console.groupCollapsed('🎵 [AUDIO] Audio Context Setup');
            console.log(`🎵 [${Math.round(performance.now() - window.streamingStartTime)}ms] Created new AudioContext (sampleRate: ${ctx.sampleRate} Hz, latency: playback)`);
        }
    } else {
        if (!isStudyMode()) {
            console.groupCollapsed('🎵 [AUDIO] Audio Context Setup');
        }
    }
    
    const worklet = new AudioWorkletNode(State.audioContext, 'audio-processor');
    State.setWorkletNode(worklet);

    const analyser = State.audioContext.createAnalyser();
    analyser.fftSize = 2048;
    State.setAnalyserNode(analyser);

    // Master volume gain (user's volume slider)
    const gain = State.audioContext.createGain();
    const volumeSlider = document.getElementById('volumeSlider');
    gain.gain.value = volumeSlider ? parseFloat(volumeSlider.value) / 100 : 1.0;
    State.setGainNode(gain);

    // Dual-path crossfade gains: source (normal) vs stretch (sub-1x speed)
    const sourceGain = State.audioContext.createGain();
    sourceGain.gain.value = 1; // Source active by default
    State.setSourceGainNode(sourceGain);

    const stretchGain = State.audioContext.createGain();
    stretchGain.gain.value = 0; // Stretch silent by default
    State.setStretchGainNode(stretchGain);

    // Audio graph: worklet → sourceGain → masterGain → analyser + destination
    //              stretchNode → stretchGain → masterGain (connected when stretch activates)
    worklet.connect(sourceGain);
    sourceGain.connect(gain);
    stretchGain.connect(gain);
    gain.connect(analyser);
    gain.connect(State.audioContext.destination);

    // Register callback to prime stretch processors when audio data is ready
    State.setOnCompleteSamplesReady((samples) => primeStretchProcessors(samples));

    updatePlaybackSpeed();
    
    // Initialize oscilloscope visualization
    import('./oscilloscope-renderer.js').then(({ initOscilloscope }) => {
        initOscilloscope();
        if (!isStudyMode()) {
            // console.log('🎨 Oscilloscope visualization initialized');
        }
        
        // Start reading post-volume audio from analyser node
        startOscilloscopeDataCollection(analyser);
    });
    
    // Log audio output latency for debugging sync issues
    // Only log in dev/personal modes, not study mode
    if (!isStudyMode()) {
        console.log(`🔊 Audio latency: output=${State.audioContext.outputLatency ? (State.audioContext.outputLatency * 1000).toFixed(1) : 'undefined'}ms, base=${(State.audioContext.baseLatency * 1000).toFixed(1)}ms`);
        
        // The outputLatency might be 0 or undefined on some browsers
        // The real latency is often the render quantum (128 samples) plus base latency
        const estimatedLatency = State.audioContext.baseLatency || (128 / 44100);
        console.log(`🔊 Estimated total latency: ${(estimatedLatency * 1000).toFixed(1)}ms`);
        console.groupEnd(); // End Audio Context Setup
    }
    
    worklet.port.onmessage = (event) => {
        const { type, bufferSize, samplesConsumed, totalSamples, positionSeconds, samplePosition } = event.data;
        
        if (type === 'position') {
            // CRITICAL: Ignore stale position messages after a seek to prevent playhead flash-back
            if (State.justSeeked) {
                return;
            }
            // Use worklet's reported position directly - no latency adjustment
            // The playhead should show where the audio actually is, matching the coordinate system used for clicks
            State.setCurrentAudioPosition(positionSeconds);
            State.setLastWorkletPosition(positionSeconds);
            State.setLastWorkletUpdateTime(State.audioContext.currentTime);
        } else if (type === 'selection-end-reached') {
            // CRITICAL: Ignore stale 'selection-end-reached' messages after a seek
            if (State.justSeeked) {
                console.log('⚠️ [SELECTION-END] Ignoring - stale message after seek');
                return;
            }
            
            const { position } = event.data;
            
            State.setPlaybackState(PlaybackState.PAUSED);
            State.setCurrentAudioPosition(position);
            
            // 🚩 Worklet reached boundary - reset region button if we were playing a region
            // The worklet is the single source of truth for boundaries
            if (getActivePlayingRegionIndex() !== null) {
                clearActivePlayingRegion();
            }
            
            const playBtn = document.getElementById('playPauseBtn');
            playBtn.disabled = false;
            playBtn.textContent = '▶️ Resume';
            playBtn.classList.remove('pause-active');
            playBtn.classList.add('play-active', 'pulse-resume');
            // Status message removed - no need to show "Paused at selection end"
            
            drawWaveformWithSelection();
        } else if (type === 'buffer-status') {
            // 📊 Buffer status report from worklet
            const { samplesInBuffer, totalSamplesWritten } = event.data;
            const bufferSeconds = samplesInBuffer / 44100;
            const maxBufferSeconds = (44100 * 300) / 44100; // 5 minutes max
            console.log(`📊 Buffer Status: ${samplesInBuffer.toLocaleString()} samples (${bufferSeconds.toFixed(2)}s) / ${(44100 * 300).toLocaleString()} max (${maxBufferSeconds.toFixed(0)}min) | Total written: ${totalSamplesWritten.toLocaleString()}`);
        } else if (type === 'metrics') {
            if (samplesConsumed !== undefined && totalSamples && totalSamples > 0) {
                updateCurrentPositionFromSamples(samplesConsumed, totalSamples);
            }
        } else if (type === 'oscilloscope') {
            // Ignore oscilloscope data from worklet - we now read post-volume audio from analyser node
            // This ensures the oscilloscope shows volume-adjusted audio, not raw worklet output
        } else if (type === 'started') {
            const ttfa = performance.now() - window.streamingStartTime;
            document.getElementById('ttfa').textContent = `${ttfa.toFixed(0)}ms`;
            // console.log(`⏱️ [${ttfa.toFixed(0)}ms] Worklet confirmed playback`);
        } else if (type === 'seek-ready') {
            // Worklet has cleared its buffer and is ready for samples at seek position
            const { targetSample, wasPlaying, forceResume } = event.data;
            console.log(`🎯 [SEEK-READY] Re-sending samples from ${targetSample.toLocaleString()}, wasPlaying=${wasPlaying}, forceResume=${forceResume}`);
            
            // 🔥 FIX: Use accessor that handles both Float32 and compressed Int16
            const totalSamplesCount = State.getCompleteSamplesLength();
            
            if (totalSamplesCount > 0 && targetSample >= 0 && targetSample < totalSamplesCount) {
                // Tell worklet whether to auto-resume after buffering
                const shouldAutoResume = wasPlaying || forceResume;
                
                // Send samples in chunks to avoid blocking
                const chunkSize = 44100 * 10; // 10 seconds per chunk
                
                for (let i = targetSample; i < totalSamplesCount; i += chunkSize) {
                    const end = Math.min(i + chunkSize, totalSamplesCount);
                    // Use getCompleteSamplesSlice which handles both Float32 and compressed Int16
                    const chunk = State.getCompleteSamplesSlice(i, end);
                    
                    State.workletNode.port.postMessage({
                        type: 'audio-data',
                        data: chunk,
                        autoResume: shouldAutoResume  // Tell worklet to auto-resume after buffering
                    });
                }
                
                console.log(`📤 [SEEK-READY] Sent ${(totalSamplesCount - targetSample).toLocaleString()} samples from position ${targetSample.toLocaleString()}, autoResume=${shouldAutoResume}`);
            } else {
                console.error(`❌ [SEEK-READY] Cannot re-send: completeSamplesArray unavailable or invalid target ${targetSample}`);
            }
        } else if (type === 'looped-fast') {
            // 🔥 FAST LOOP: Worklet wrapped readIndex without clearing buffer
            // Fades are now handled inside worklet (sample-accurate, no jitter!)
            const { position } = event.data;
            State.setCurrentAudioPosition(position);
            State.setLastWorkletPosition(position);
            State.setLastWorkletUpdateTime(State.audioContext.currentTime);
        } else if (type === 'loop-ready') {
            // Worklet has cleared buffer and is ready to loop from target position
            const { targetSample } = event.data;
            // console.log(`🔄 [LOOP-READY] Re-sending samples from ${targetSample.toLocaleString()} (loop restart)`);
            
            // 🔥 FIX: Use accessor that handles both Float32 and compressed Int16
            const totalSamplesCount = State.getCompleteSamplesLength();
            
            if (totalSamplesCount > 0) {
                // Update position tracking to loop target
                const newPositionSeconds = targetSample / 44100;
                State.setCurrentAudioPosition(newPositionSeconds);
                State.setLastWorkletPosition(newPositionSeconds);
                State.setLastWorkletUpdateTime(State.audioContext.currentTime);
                
                // Send samples from target position onwards with auto-resume
                const chunkSize = 44100 * 10; // 10 seconds per chunk
                
                for (let i = targetSample; i < totalSamplesCount; i += chunkSize) {
                    const end = Math.min(i + chunkSize, totalSamplesCount);
                    // Use getCompleteSamplesSlice which handles both Float32 and compressed Int16
                    const chunk = State.getCompleteSamplesSlice(i, end);
                    
                    State.workletNode.port.postMessage({
                        type: 'audio-data',
                        data: chunk,
                        autoResume: true  // Auto-resume when buffer is ready
                    });
                }
                
                // console.log(`🔄 [LOOP-READY] Sent ${(totalSamplesCount - targetSample).toLocaleString()} samples from ${newPositionSeconds.toFixed(2)}s, will auto-resume`);
            } else {
                console.error(`❌ [LOOP-READY] Cannot loop: completeSamplesArray unavailable`);
            }
        } else if (type === 'finished') {
            if (State.isFetchingNewData) {
                console.log('⚠️ [FINISHED] Ignoring - new data being fetched');
                return;
            }
            
            // CRITICAL: Ignore stale 'finished' messages after a seek
            if (State.justSeeked) {
                console.log('⚠️ [FINISHED] Ignoring - stale message after seek');
                return;
            }
            
            const { totalSamples: finishedTotalSamples, speed } = event.data;
            // console.log(`🏁 [FINISHED] Buffer empty: ${finishedTotalSamples.toLocaleString()} samples @ ${speed.toFixed(2)}x speed`);
            
            // 🔥 FIX: Copy State values to local variables to break closure chain
            const isLooping = State.isLooping;
            const allReceivedData = State.allReceivedData;
            
            if (isLooping && allReceivedData && allReceivedData.length > 0) {
                // 🏎️ AUTONOMOUS: Loop is handled by worklet, but if we get 'finished' it means
                // we need to restart. Seek to start and play.
                const loopStartPosition = State.selectionStart !== null ? State.selectionStart : 0;
                State.setCurrentAudioPosition(loopStartPosition);
                State.setLastUpdateTime(State.audioContext.currentTime);
                
                // Use seek + play (worklet handles fades autonomously)
                State.workletNode.port.postMessage({ 
                    type: 'seek',
                    position: loopStartPosition
                });
                State.workletNode.port.postMessage({ type: 'play' });
                
                State.setPlaybackState(PlaybackState.PLAYING);
                
                // 🔥 Notify oscilloscope that playback started (for flame effect fade)
                import('./oscilloscope-renderer.js').then(({ setPlayingState }) => {
                    setPlayingState(true);
                });
                
                if (State.totalAudioDuration > 0) {
                    startPlaybackIndicator();
                }
            } else {
                // Playback finished - worklet already handled fade-out
                // 🔥 FIX: Cancel animation frame loops to prevent memory leaks
                cancelAllRAFLoops();
                
                State.setPlaybackState(PlaybackState.STOPPED);
                
                // 🔥 Notify oscilloscope that playback stopped (for flame effect fade)
                import('./oscilloscope-renderer.js').then(({ setPlayingState }) => {
                    setPlayingState(false);
                });
                
                if (finishedTotalSamples && State.totalAudioDuration > 0) {
                    const finalPosition = finishedTotalSamples / 44100;
                    State.setCurrentAudioPosition(Math.min(finalPosition, State.totalAudioDuration));
                    drawWaveformWithSelection();
                }
                
                // Region button reset is handled by 'selection-end-reached' message from worklet
                // The worklet is the single source of truth for when boundaries are reached
                
                stopPositionTracking();
                const playBtn = document.getElementById('playPauseBtn');
                playBtn.disabled = false;
                playBtn.textContent = '▶️ Play';
                playBtn.classList.add('pulse-play');
                setStatusText('✅ Playback finished! Click Play to replay or enable Loop.', 'status success');
            }
        }
    };
    
    // COMMENTED OUT: Using complete spectrogram renderer instead of streaming
    // startVisualization();
}

// console.log('🟢 LINE 523 - After initAudioWorklet function');

// Main streaming function
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
        if (!safeIsStudyMode()) {
            console.groupCollapsed('🧹 [CLEANUP] Preparing for New Data');
        }
        
        // Clear complete spectrogram and waveform renderers when loading new data
        clearCompleteSpectrogram();
        clearWaveformRenderer();

        // Close old AudioContext to release OS audio threads and internal buffers (~10-50MB)
        if (State.audioContext) {
            try { State.audioContext.close(); } catch (e) { /* already closed */ }
            State.setAudioContext(null);
        }

        // Clear stale window globals
        window.playbackDurationSeconds = null;
        window.streamingStartTime = null;
        
        // 🔧 FIX: Reset zoom state to full view when loading new data
        if (zoomState.isInitialized()) {
            zoomState.mode = 'full';
            zoomState.currentViewStartSample = 0;
            zoomState.activeRegionId = null;
            if (!safeIsStudyMode()) {
                console.log('🔄 Reset zoom state to full view for new data');
            }
        }
        
        // Reset waveform click tracking for tutorial flow when loading new data
        State.setWaveformHasBeenClicked(false);
        const waveformCanvas = document.getElementById('waveform');
        if (waveformCanvas) {
            waveformCanvas.classList.remove('pulse');
        }
        
        // Hide tutorial overlay when loading new data
        const { hideTutorialOverlay, clearTutorialPhase } = await import('./tutorial.js');
        hideTutorialOverlay();
        // Clear any active tutorial phase to restart tutorial sequence
        clearTutorialPhase();
        
        // Note: Features are enabled by default - only tutorial disables them
        // Don't disable speed/volume controls here - tutorial will disable if needed
        
        // 🔥 FIX: Remove add region button to prevent detached DOM leaks
        // Import dynamically to avoid circular dependencies
        const { removeAddRegionButton } = await import('./region-tracker.js');
        removeAddRegionButton();
        
        // Terminate and recreate waveform worker to free memory
        // Note: initWaveformWorker() already handles cleanup, but we do it here too for safety
        if (State.waveformWorker) {
            State.waveformWorker.onmessage = null;  // Break closure chain
            State.waveformWorker.terminate();
            if (!safeIsStudyMode()) {
                console.log('🧹 Terminated waveform worker');
            }
        }
        initWaveformWorker();
        
        if (!safeIsStudyMode()) {
            console.groupEnd(); // End Cleanup
        }
        
        State.setIsShowingFinalWaveform(false);
        
        // Initialize audio worklet for playback
        await initAudioWorklet();
        
        window.streamingStartTime = performance.now();
        const logTime = () => `[${Math.round(performance.now() - window.streamingStartTime)}ms]`;
        
        console.log('🎬 [0ms] Fetching CDAWeb audio data');
        
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
        
        console.log(`🛰️ ${logTime()} Fetching: ${spacecraft} ${dataset} from ${startTimeISO} to ${endTimeISO}`);
        
        // Update status with animated loading indicator
        const statusDiv = document.getElementById('status');
        let dotCount = 0;
        const baseMessage = `Fetching ${spacecraft} ${dataset} from CDAWeb`;
        let loadingInterval = null;
        if (statusDiv) {
            // Cancel any active typing/pulse animations that could fight with our interval
            import('./tutorial-effects.js').then(m => m.cancelTyping && m.cancelTyping()).catch(() => {});
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
        }
        
        // Fetch and load the CDAWeb audio data
        try {
        const { fetchAndLoadCDAWebData } = await import('./data-fetcher.js');
        await fetchAndLoadCDAWebData(spacecraft, dataset, startTimeISO, endTimeISO);
        } finally {
            if (loadingInterval) clearInterval(loadingInterval);
            if (statusDiv) statusDiv.classList.remove('loading');
        }
        
        // Check if autoPlay is enabled and start playback indicator
        const autoPlayEnabled = document.getElementById('autoPlay').checked;
        if (autoPlayEnabled && State.playbackState === PlaybackState.PLAYING) {
            const { startPlaybackIndicator } = await import('./waveform-renderer.js');
            // console.log(`⏱️ ${logTime()} Worklet confirmed playback`);
            startPlaybackIndicator();
        }
        
        // Update status and highlight waveform for user guidance
        // For shared sessions, show "Ready to play" message instead
        // Uses separate localStorage variable from tutorial State to persist across sessions
        const userHasClickedWaveformOnce = localStorage.getItem('userHasClickedWaveformOnce') === 'true';
        const isSharedSession = sessionStorage.getItem('isSharedSession') === 'true';
        if (statusDiv) {
            if (isSharedSession) {
                statusDiv.textContent = '🎧 Ready! Click PLAY or press the SPACE BAR to start playback.';
                statusDiv.className = 'status';
            } else if (userHasClickedWaveformOnce) {
                statusDiv.textContent = 'Click and drag to create a region, type a region # to zoom in, or click 🔍';
                statusDiv.className = 'status info';
            } else {
                statusDiv.textContent = 'Click the waveform to jump to a new location.';
                statusDiv.className = 'status info';
            }
        }
        if (!userHasClickedWaveformOnce) {
            const waveformEl = document.getElementById('waveform');
            if (waveformEl) {
                waveformEl.classList.add('pulse');
            }
        }

        // Reload recent searches dropdown (function is defined in DOMContentLoaded)
        if (typeof window.loadRecentSearches === 'function') {
            await window.loadRecentSearches();
        }

        // Enable share button now that data is loaded
        updateShareButtonState();

        // Draw day markers if enabled in gear popovers (EMIC mode)
        drawDayMarkers();

        // Initialize scroll-to-zoom (EMIC mode, gated by checkbox)
        initScrollZoom();

        console.log(`🎉 ${logTime()} Complete!`);
        console.log('════════════════════');
        console.log('📌 v2.0 (2026-02-12) Three.js GPU-accelerated rendering');
        console.log('════════════════════');

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

// console.log('🟢 LINE 630 - After startStreaming function');

// LEGACY CODE REMOVED - old volcano fetching system replaced with CDAWeb
// See git history for reference if needed

/**
 * Update the participant ID display in the top panel
 */
async function updateParticipantIdDisplay() {
    const participantId = getParticipantId();
    const displayElement = document.getElementById('participantIdDisplay');
    const valueElement = document.getElementById('participantIdValue');
    
    // Always show the participant ID display (even if no ID set)
    // This allows users to see and click to enter their ID
    if (displayElement) displayElement.style.display = 'block';
    if (valueElement) valueElement.textContent = participantId || '--';
}

// console.log('🟢 LINE 650 - After startStreaming function');

// ═══════════════════════════════════════════════════════════
// 🎯 MODE INITIALIZATION FUNCTIONS
// ═══════════════════════════════════════════════════════════

/**
 * PERSONAL MODE: Direct access, no tutorial, no surveys
 */
async function initializePersonalMode() {
    console.log('👤 PERSONAL MODE: Direct access');
    
    // 🧹 Set proper tutorial flags for personal mode (skip tutorial, go straight to analysis)
    localStorage.setItem('study_tutorial_in_progress', 'false');
    localStorage.setItem('study_tutorial_completed', 'true');
    localStorage.setItem('study_has_seen_tutorial', 'true');
    localStorage.removeItem('study_begin_analysis_clicked_this_session'); // Reset so user can click Begin Analysis
    
    if (!isStudyMode()) {
        console.log('🧹 Set personal mode tutorial flags: completed=true, in_progress=false');
    }
    
    // Enable all features immediately
    const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
    enableAllTutorialRestrictedFeatures();
    
    console.log('✅ Personal mode ready - all features enabled');
}

/**
 * DEV MODE: Tutorial EVERY TIME (for testing/development)
 * Perfect for iterating on the tutorial experience
 */
async function initializeDevMode() {
    console.log('🔧 DEV MODE: Tutorial runs every time (for testing)');
    
    // 🔥 ALWAYS run tutorial in DEV mode (no caching)
    console.log('🎓 Running tutorial (DEV mode always shows it)');
    
    const { runInitialTutorial } = await import('./tutorial.js');
    await runInitialTutorial();
    
    console.log('✅ Tutorial completed');
    console.log('✅ Dev mode ready');
}

/**
 * EMIC STUDY MODE: Clean research interface, no modals, no tutorial
 */
async function initializeEmicStudyMode() {
    // Hide unnecessary UI elements
    const completeBtn = document.getElementById('completeBtn');
    if (completeBtn) completeBtn.style.display = 'none';
    const simulatePanel = document.querySelector('.panel-simulate');
    if (simulatePanel) simulatePanel.style.display = 'none';

    // Skip tutorial entirely
    localStorage.setItem('study_tutorial_in_progress', 'false');
    localStorage.setItem('study_tutorial_completed', 'true');
    localStorage.setItem('study_has_seen_tutorial', 'true');

    // Enable all features immediately
    const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
    enableAllTutorialRestrictedFeatures();

    // Enable region creation (normally gated behind "Begin Analysis")
    const { setRegionCreationEnabled } = await import('./audio-state.js');
    setRegionCreationEnabled(true);

    // Persist all navigation panel controls to localStorage
    const navControls = [
        { id: 'viewingMode', key: 'emic_viewing_mode', type: 'select' },
        { id: 'navBarClick', key: 'emic_navbar_click', type: 'select' },
        { id: 'mainWindowClick', key: 'emic_main_click_mode', type: 'select' },
        { id: 'mainWindowRelease', key: 'emic_main_release', type: 'select' },
        { id: 'mainWindowDrag', key: 'emic_main_drag', type: 'select' },
        { id: 'navBarScroll', key: 'emic_navbar_scroll', type: 'select' },
        { id: 'mainWindowScroll', key: 'emic_main_scroll', type: 'select' },
        { id: 'miniMapView', key: 'emic_minimap_view', type: 'select' },
        { id: 'mainWindowView', key: 'emic_main_view', type: 'select' },
        { id: 'navBarMarkers', key: 'emic_navbar_markers', type: 'select' },
        { id: 'mainWindowMarkers', key: 'emic_main_markers', type: 'select' },
        { id: 'mainWindowXAxis', key: 'emic_main_xaxis', type: 'select' },
        { id: 'mainWindowNumbers', key: 'emic_main_numbers', type: 'select' },
        { id: 'mainWindowNumbersLoc', key: 'emic_main_numbers_loc', type: 'select' },
        { id: 'skipLoginWelcome', key: 'emic_skip_login_welcome', type: 'checkbox' },
        { id: 'arrowZoomStep', key: 'emic_arrow_zoom_step', type: 'select' },
        { id: 'arrowPanStep', key: 'emic_arrow_pan_step', type: 'select' },
    ];
    for (const ctrl of navControls) {
        const el = document.getElementById(ctrl.id);
        if (!el) continue;
        const saved = localStorage.getItem(ctrl.key);
        if (ctrl.type === 'checkbox') {
            if (saved !== null) el.checked = saved === 'true';
            el.addEventListener('change', () => localStorage.setItem(ctrl.key, el.checked));
        } else {
            if (saved !== null) {
                el.value = saved;
                // If stored value doesn't match any option (e.g. options changed), reset to default
                if (el.value !== saved) {
                    localStorage.removeItem(ctrl.key);
                    el.selectedIndex = 0;
                }
            }
            el.addEventListener('change', () => {
                localStorage.setItem(ctrl.key, el.value);
                el.blur(); // Remove focus so dropdown doesn't stay highlighted
            });
        }
    }

    // Minimap mode change: re-render waveform with new mode
    const miniMapViewEl = document.getElementById('miniMapView');
    if (miniMapViewEl) {
        miniMapViewEl.addEventListener('change', () => {
            drawWaveformFromMinMax();
        });
    }

    // Main window mode change: re-render spectrogram/waveform with new mode
    const mainWindowViewEl = document.getElementById('mainWindowView');
    if (mainWindowViewEl) {
        mainWindowViewEl.addEventListener('change', () => {
            updateSpectrogramViewport(State.currentPlaybackRate || 1.0);
        });
    }

    // Main window x-axis toggle: show/hide spectrogram ticks + margin
    const mainWindowXAxisEl = document.getElementById('mainWindowXAxis');
    if (mainWindowXAxisEl) {
        const applyXAxisVisibility = () => {
            const show = mainWindowXAxisEl.value !== 'hide';
            const xAxisCanvas = document.getElementById('spectrogram-x-axis');
            const spectrogramCanvas = document.getElementById('spectrogram');
            if (xAxisCanvas) xAxisCanvas.style.display = show ? '' : 'none';
            if (spectrogramCanvas) spectrogramCanvas.style.marginBottom = show ? '30px' : '0';
            if (show) {
                positionSpectrogramXAxisCanvas();
                drawSpectrogramXAxis();
            }
        };
        applyXAxisVisibility(); // Apply on load
        mainWindowXAxisEl.addEventListener('change', applyXAxisVisibility);
    }

    // --- Settings drawer (hamburger menu, push layout) ---
    const drawerEl = document.getElementById('settingsDrawer');
    const hamburgerBtn = document.getElementById('hamburgerBtn');
    const drawerCloseBtn = document.getElementById('drawerClose');

    function openSettingsDrawer() {
        if (drawerEl) drawerEl.classList.add('open');
        document.body.classList.add('drawer-open');
    }
    function closeSettingsDrawer() {
        if (drawerEl) drawerEl.classList.remove('open');
        document.body.classList.remove('drawer-open');
    }

    // --- Advanced mode toggle: controls visibility of gear icons ---
    const advancedCheckbox = document.getElementById('advancedMode');
    function applyAdvancedMode(enabled) {
        const gearContainers = document.querySelectorAll('.panel-gear');
        gearContainers.forEach(g => g.style.display = enabled ? 'block' : 'none');
        const hamburgerBtn = document.getElementById('hamburgerBtn');
        if (hamburgerBtn) hamburgerBtn.style.display = enabled ? 'block' : 'none';
        const questionnairesPanel = document.getElementById('questionnairesPanel');
        if (questionnairesPanel) questionnairesPanel.style.display = enabled ? '' : 'none';
        // Close drawer if Advanced is turned off while drawer is open
        if (!enabled) closeSettingsDrawer();
    }
    if (advancedCheckbox) {
        const savedAdvanced = localStorage.getItem('emic_advanced_mode');
        if (savedAdvanced !== null) advancedCheckbox.checked = savedAdvanced === 'true';
        applyAdvancedMode(advancedCheckbox.checked);
        advancedCheckbox.addEventListener('change', () => {
            localStorage.setItem('emic_advanced_mode', advancedCheckbox.checked);
            applyAdvancedMode(advancedCheckbox.checked);
            updateRegionsPanelVisibility();
        });
    }
    if (hamburgerBtn) hamburgerBtn.addEventListener('click', () => {
        if (drawerEl?.classList.contains('open')) closeSettingsDrawer();
        else openSettingsDrawer();
    });
    if (drawerCloseBtn) drawerCloseBtn.addEventListener('click', closeSettingsDrawer);

    // --- Panel height inputs in settings drawer ---
    const heightMinimapInput = document.getElementById('heightMinimap');
    const heightSpectrogramInput = document.getElementById('heightSpectrogram');

    // Pre-load current heights
    const wfEl_ = document.getElementById('waveform');
    const specEl_ = document.getElementById('spectrogram');
    if (heightMinimapInput && wfEl_) heightMinimapInput.value = wfEl_.offsetHeight;
    if (heightSpectrogramInput && specEl_) heightSpectrogramInput.value = specEl_.offsetHeight;

    function applyPanelHeight(input, canvasId, axisId, buttonsId) {
        const h = parseInt(input.value);
        if (isNaN(h) || h < parseInt(input.min) || h > parseInt(input.max)) return;
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        canvas.style.height = h + 'px';
        canvas.height = h;
        // Update companion canvases (axis, buttons) buffer height
        const companions = [axisId, buttonsId].filter(Boolean);
        for (const id of companions) {
            const el = document.getElementById(id);
            if (el) el.height = h;
        }
        window.dispatchEvent(new Event('resize'));
    }

    if (heightMinimapInput) {
        heightMinimapInput.addEventListener('change', () =>
            applyPanelHeight(heightMinimapInput, 'waveform', 'waveform-axis', 'waveform-buttons'));
    }
    if (heightSpectrogramInput) {
        heightSpectrogramInput.addEventListener('change', () =>
            applyPanelHeight(heightSpectrogramInput, 'spectrogram', 'spectrogram-axis', null));
    }

    // Position gear icons over their respective canvases (top-right corner, inside the canvas)
    function positionGearIcons() {
        const wfCanvas = document.getElementById('waveform');
        const navGear = document.getElementById('navBarGear');
        if (wfCanvas && navGear) {
            navGear.style.top = (wfCanvas.offsetTop + 2) + 'px';
            navGear.style.right = 'auto';
            navGear.style.left = (wfCanvas.offsetLeft + wfCanvas.offsetWidth - 32) + 'px';
        }
        const specCanvas = document.getElementById('spectrogram');
        const mainGear = document.getElementById('mainWindowGear');
        if (specCanvas && mainGear) {
            mainGear.style.top = (specCanvas.offsetTop + 2) + 'px';
            mainGear.style.right = 'auto';
            mainGear.style.left = (specCanvas.offsetLeft + specCanvas.offsetWidth - 32) + 'px';
        }
    }
    positionGearIcons();
    const wfEl = document.getElementById('waveform');
    const specEl = document.getElementById('spectrogram');
    if (wfEl) new ResizeObserver(positionGearIcons).observe(wfEl);
    if (specEl) new ResizeObserver(positionGearIcons).observe(specEl);

    // Toggle popover on gear click, close on click-outside
    document.querySelectorAll('.gear-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const popover = btn.nextElementSibling;
            const wasOpen = popover.classList.contains('open');
            // Close all popovers first & reset z-index
            document.querySelectorAll('.gear-popover').forEach(p => {
                p.classList.remove('open');
                p.closest('.panel-gear').style.zIndex = '30';
            });
            if (!wasOpen) {
                popover.classList.add('open');
                // Boost this gear above others so popover isn't covered
                popover.closest('.panel-gear').style.zIndex = '35';
            }
        });
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.gear-popover') && !e.target.closest('.gear-btn')) {
            document.querySelectorAll('.gear-popover').forEach(p => {
                p.classList.remove('open');
                p.closest('.panel-gear').style.zIndex = '30';
            });
        }
    });
    // Blur selects after change so the native focus highlight drops immediately
    document.querySelectorAll('.gear-select').forEach(sel => {
        sel.addEventListener('change', () => sel.blur());
    });

    const skipLogin = localStorage.getItem('emic_skip_login_welcome') === 'true';

    if (!skipLogin) {
        // Show participant setup immediately
        openParticipantModal();
    } else {
        // Hide overlay, go straight to app
        const overlay = document.getElementById('permanentOverlay');
        if (overlay) { overlay.style.display = 'none'; overlay.style.opacity = '0'; }
    }

    // Wire per-panel day markers dropdowns to redraw
    const navBarMarkersEl = document.getElementById('navBarMarkers');
    const mainWindowMarkersEl = document.getElementById('mainWindowMarkers');
    if (navBarMarkersEl) navBarMarkersEl.addEventListener('change', () => drawDayMarkers());
    if (mainWindowMarkersEl) mainWindowMarkersEl.addEventListener('change', () => drawDayMarkers());
    // Draw immediately if either panel has markers enabled
    if ((navBarMarkersEl && navBarMarkersEl.value !== 'none') ||
        (mainWindowMarkersEl && mainWindowMarkersEl.value !== 'none')) {
        drawDayMarkers();
    }

    // Wire Numbers dropdowns to redraw feature boxes
    const mainWindowNumbersEl = document.getElementById('mainWindowNumbers');
    const mainWindowNumbersLocEl = document.getElementById('mainWindowNumbersLoc');
    if (mainWindowNumbersEl) mainWindowNumbersEl.addEventListener('change', () => redrawAllCanvasFeatureBoxes());
    if (mainWindowNumbersLocEl) mainWindowNumbersLocEl.addEventListener('change', () => redrawAllCanvasFeatureBoxes());

    // Toggle regions panel + top bar controls visibility based on viewing mode
    function updateRegionsPanelVisibility() {
        const mode = document.getElementById('viewingMode')?.value;
        const isWindowed = mode === 'static' || mode === 'scroll' || mode === 'pageTurn';
        const panel = document.getElementById('trackedRegionsPanel');
        if (panel) {
            panel.style.display = isWindowed ? 'none' : '';
        }
        // Hide Component and De-trend controls in windowed modes (unless Advanced is on)
        // Use visibility:hidden (not display:none) so they still occupy space and the status bar stays put
        const advanced = document.getElementById('advancedMode')?.checked;
        const hideControls = isWindowed && !advanced;
        const comp = document.getElementById('componentSelectorContainer');
        const detrend = document.getElementById('detrendContainer');
        if (comp) comp.style.visibility = hideControls ? 'hidden' : '';
        if (detrend) detrend.style.visibility = hideControls ? 'hidden' : '';
        // Hide the spacer divs between controls (siblings before/after comp and detrend)
        if (comp?.previousElementSibling) comp.previousElementSibling.style.visibility = hideControls ? 'hidden' : '';
        if (comp?.nextElementSibling && comp.nextElementSibling.id !== 'detrendContainer') {
            comp.nextElementSibling.style.visibility = hideControls ? 'hidden' : '';
        }
        if (detrend?.nextElementSibling && detrend.nextElementSibling.id !== 'status') {
            detrend.nextElementSibling.style.visibility = hideControls ? 'hidden' : '';
        }
    }

    // When switching to a windowed mode, reset waveform to full view and re-render
    const viewingModeSelect = document.getElementById('viewingMode');
    if (viewingModeSelect) {
        // Set initial visibility after localStorage restore
        updateRegionsPanelVisibility();

        viewingModeSelect.addEventListener('change', () => {
            const mode = viewingModeSelect.value;
            if (mode === 'static' || mode === 'scroll' || mode === 'pageTurn') {
                // Reset zoom to full view so waveform minimap shows everything
                zoomState.setViewportToFull();
            }
            updateRegionsPanelVisibility();
            // Re-render waveform, x-axis, buttons, and day markers for the new mode
            drawWaveformFromMinMax();
            drawWaveformXAxis();
            drawSpectrogramXAxis();
            drawRegionButtons();
            drawDayMarkers();
            viewingModeSelect.blur();
        });
    }

    console.log('🔬 EMIC Study mode initialized (skipLogin:', skipLogin, ')');
}

/**
 * SOLAR PORTAL MODE: Participant setup only, no study workflow
 */
async function initializeSolarPortalMode() {
    
    // Hide Begin Analysis button permanently
    const completeBtn = document.getElementById('completeBtn');
    if (completeBtn) {
        completeBtn.style.display = 'none';
        // console.log('✅ Begin Analysis button hidden');
    }
    
    // Hide simulate panel
    const simulatePanel = document.querySelector('.panel-simulate');
    if (simulatePanel) {
        simulatePanel.style.display = 'none';
        // console.log('✅ Simulate panel hidden');
    }
    
    // Set tutorial flags (skip tutorial, go straight to analysis)
    localStorage.setItem('study_tutorial_in_progress', 'false');
    localStorage.setItem('study_tutorial_completed', 'true');
    localStorage.setItem('study_has_seen_tutorial', 'true');
    
    // Enable all features immediately
    const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
    enableAllTutorialRestrictedFeatures();
    
    // Check if user has a username set - if not, show participant setup
    const { getParticipantId } = await import('./qualtrics-api.js');
    const participantId = getParticipantId();
    const hasUsername = participantId && participantId.trim() !== '';

    if (!hasUsername) {
        console.log('👤 No username found - opening participant setup');
        // Wait a bit for modals to initialize, then open participant modal
        setTimeout(() => {
            openParticipantModal();
        }, 500);
    } else {
        console.log(`✅ Welcome back, ${participantId}`);
        // Show instruction to click Fetch Data (only if not a shared session)
        const isSharedSession = sessionStorage.getItem('isSharedSession') === 'true';
        if (!isSharedSession) {
            setTimeout(async () => {
                const { typeText } = await import('./tutorial-effects.js');
                const statusEl = document.getElementById('status');
                if (statusEl) {
                    statusEl.className = 'status info';
                    const msg = State.isMobileScreen() ? 'Click Fetch Data to begin' : '👈 click Fetch Data to begin';
                    typeText(statusEl, msg, 30, 10);
                }
            }, 500);
        }
    }

    console.log('✅ Solar Portal mode ready');
}

/**
 * STUDY MODE: Full workflow with surveys
 */
async function initializeStudyMode() {
    console.log('🎓 STUDY MODE: Full research workflow');
    
    // Check if we should skip workflow (e.g., just opening participant modal)
    const skipWorkflow = localStorage.getItem('skipStudyWorkflow') === 'true';
    if (skipWorkflow) {
        console.log('⏭️ Skipping study workflow (participant modal only)');
        localStorage.removeItem('skipStudyWorkflow'); // Clean up
        return;
    }
    
    // Check if we should start at end flow (for testing)
    const urlParams = new URLSearchParams(window.location.search);
    const startAt = urlParams.get('startAt') || localStorage.getItem('workflow_start_at');
    
    if (startAt === 'end') {
        console.log('🏁 Starting at END FLOW (Activity Level → AWE-SF → Post-Survey → End)');
        localStorage.removeItem('workflow_start_at'); // Clear flag after use
        
        // Enable features and go straight to submit workflow
        const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
        await enableAllTutorialRestrictedFeatures();
        
        const { setRegionCreationEnabled } = await import('./audio-state.js');
        setRegionCreationEnabled(true);
        
        // Wait a bit for modals to be fully initialized, then start the end flow
        setTimeout(async () => {
            const { handleStudyModeSubmit } = await import('./study-workflow.js');
            await handleStudyModeSubmit();
        }, 500);
    } else {
        const { startStudyWorkflow } = await import('./study-workflow.js');
        await startStudyWorkflow();
    }
    
    console.log('✅ Production mode initialized');
}


/**
 * Route to appropriate workflow based on mode
 */
async function initializeApp() {
    const { CURRENT_MODE, AppMode } = await import('./master-modes.js');
    
    if (!isStudyMode()) {
        console.groupCollapsed(`🎯 [MODE] ${CURRENT_MODE} Initialization`);
    }
    console.log(`🚀 Initializing app in ${CURRENT_MODE} mode`);
    
    switch (CURRENT_MODE) {
        case AppMode.PERSONAL:
            await initializePersonalMode();
            break;
            
        case AppMode.DEV:
            await initializeDevMode();
            break;
            
        case AppMode.SOLAR_PORTAL:
            await initializeSolarPortalMode();
            break;

        case AppMode.EMIC_STUDY:
            await initializeEmicStudyMode();
            break;
            
        case AppMode.PRODUCTION:
        case AppMode.STUDY_CLEAN:
        case AppMode.STUDY_W2_S1:
        case AppMode.STUDY_W2_S1_RETURNING:
        case AppMode.STUDY_W2_S2:
            await initializeStudyMode();
            break;
            
        case AppMode.TUTORIAL_END:
            // Tutorial End mode: Debug mode to test tutorial end walkthrough
            // Don't initialize any mode - just wait for user to load data then trigger debug jump
            console.log('🎬 Tutorial End Mode: Ready. Load data, then type "testend" or it will auto-trigger.');
            break;

        default:
            console.error(`❌ Unknown mode: ${CURRENT_MODE}`);
            await initializeDevMode(); // Fallback to dev
    }
    
    if (!isStudyMode()) {
        console.groupEnd(); // End Mode Initialization
    }
}

/**
 * Update spacecraft dropdown labels to show which spacecraft has loaded data
 * @param {string|null} loadedSpacecraft - Spacecraft with loaded data (null to clear all flags)
 * @param {string} selectedSpacecraft - Currently selected spacecraft
 */
function updateSpacecraftDropdownLabels(loadedSpacecraft, selectedSpacecraft) {
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

// console.log('🟢 REACHED LINE 1289 - About to define initialization');

// =============================================================================
// 🔄 VERSION CHECK - Auto-refresh when new code is deployed
// GitHub Action updates version.json on every push - fully automatic!
// =============================================================================
async function checkAppVersion() {
    console.log('🔍 Checking for app updates...');
    try {
        // Fetch version.json with cache-busting
        const res = await fetch(`/version.json?_=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) {
            console.log('⚠️ Version check: Could not fetch version.json');
            return false;
        }

        // Read version from JSON content (updated automatically by GitHub Action on every push)
        const data = await res.json();
        const serverVersion = data.version;
        if (!serverVersion) {
            console.log('⚠️ Version check: No version found in version.json');
            return false;
        }

        const localVersion = localStorage.getItem('app_version');
        // Parse version string (YYYYMMDD.HHMMSS) into a readable date
        const versionParts = serverVersion.match(/(\d{4})(\d{2})(\d{2})\.(\d{2})(\d{2})(\d{2})/);
        const serverTime = versionParts
            ? new Date(Date.UTC(versionParts[1], versionParts[2]-1, versionParts[3], versionParts[4], versionParts[5], versionParts[6])).toLocaleString()
            : serverVersion;
        console.log(`📋 Version check: Local="${localVersion || '(first visit)'}" vs Server="${serverVersion}"`);

        if (localVersion && localVersion !== serverVersion) {
            console.log('%c🔄 NEW VERSION DETECTED - Refreshing page...', 'color: #FF9800; font-weight: bold; font-size: 14px');
            localStorage.setItem('app_version', serverVersion);
            location.reload();
            return true; // Will reload
        }

        localStorage.setItem('app_version', serverVersion);
        console.log(`%c✅ App is up to date (built ${serverTime})`, 'color: #4CAF50; font-weight: bold');
    } catch (e) {
        // Silently fail - version check is non-critical
        console.log('⚠️ Version check skipped (offline or error)', e.message);
    }
    return false;
}

// Main initialization function
async function initializeMainApp() {
    console.log('════════════════════');
    console.log('☀️ SOLAR AUDIFICATION PORTAL - INITIALIZING!');
    console.log('════════════════════');

    // Check for new version first (will reload page if update available)
    if (await checkAppVersion()) return;

    // Group core system initialization
    console.groupCollapsed('🔧 [INIT] Core Systems');
    
    // ═══════════════════════════════════════════════════════════
    // 📏 STATUS AUTO-RESIZE - Shrink font when text overflows
    // ═══════════════════════════════════════════════════════════
    const { setupStatusAutoResize } = await import('./status-auto-resize.js');
    setupStatusAutoResize();
    
    // ═══════════════════════════════════════════════════════════
    // 🎯 MASTER MODE - Initialize and check configuration
    // ═══════════════════════════════════════════════════════════
    const { initializeMasterMode, shouldSkipTutorial, isStudyMode, isPersonalMode, isDevMode, isTutorialEndMode, CURRENT_MODE, AppMode } = await import('./master-modes.js');
    initializeMasterMode();
    
    // Initialize error reporter early (catches errors during initialization)
    initErrorReporter();
    
    // Initialize silent error reporter (tracks metadata mismatches quietly)
    initSilentErrorReporter();

    // Initialize share modal (for sharing analysis sessions)
    initShareModal();

    // Start heartbeat tracking (updates last_active_at for logged-in users)
    const { startHeartbeatTracking } = await import('./session-management.js');
    startHeartbeatTracking();

    console.groupEnd(); // End Core Systems
    
    // Group UI setup
    console.groupCollapsed('🎨 [INIT] UI Setup');

    // Don't hide Begin Analysis button initially - let updateCompleteButtonState() handle visibility
    // Tutorial will hide it when needed, returning visits will keep it visible
    
    // Initialize mode selector dropdown
    const modeSelectorContainer = document.getElementById('modeSelectorContainer');
    const modeSelector = document.getElementById('modeSelector');
    
    // Detect if running locally
    const isLocal = window.location.hostname === 'localhost' || 
                    window.location.hostname === '127.0.0.1' || 
                    window.location.hostname === '' ||
                    window.location.protocol === 'file:';
    
    // Mode selector visibility logic:
    // - Production (not local): Always hidden
    // - Solar Portal mode: Always hidden (clean UI for end users)
    // - Other local modes: Visible for dev/testing

    if (!isLocal || CURRENT_MODE === AppMode.SOLAR_PORTAL) {
        // Hide mode selector in production or Solar Portal mode
        if (modeSelectorContainer) {
            modeSelectorContainer.style.visibility = 'hidden';
            modeSelectorContainer.style.opacity = '0';
        }
    }

    // 🐛 DEBUG: Secret key sequence to jump to study end walkthrough
    // Useful for testing the tail end of the tutorial
    const debugJumpSecret = 'testend';
    let debugKeySequence = '';
    let debugKeySequenceTimeout = null;

    function handleDebugJumpListener(e) {
        // Skip if key is undefined (can happen with some special keys)
        if (!e.key) {
            return;
        }

        // Reset sequence if too much time passes (2 seconds)
        if (debugKeySequenceTimeout) {
            clearTimeout(debugKeySequenceTimeout);
        }
        debugKeySequenceTimeout = setTimeout(() => {
            debugKeySequence = '';
        }, 2000);

        // Add current key to sequence
        debugKeySequence += e.key.toLowerCase();

        // Keep only last N characters
        const secretLength = debugJumpSecret.length;
        if (debugKeySequence.length > secretLength) {
            debugKeySequence = debugKeySequence.slice(-secretLength);
        }

        // Check if sequence matches
        if (debugKeySequence === debugJumpSecret.toLowerCase()) {
            console.log('🐛 DEBUG: Jumping to study end walkthrough...');
            debugKeySequence = ''; // Reset
            if (debugKeySequenceTimeout) {
                clearTimeout(debugKeySequenceTimeout);
                debugKeySequenceTimeout = null;
            }

            // Import and run the debug function
            import('./tutorial-coordinator.js').then(module => {
                module.debugJumpToStudyEnd();
            });
        }
    }

    // Add debug key listener (only in local environment)
    if (isLocal) {
        window.addEventListener('keydown', handleDebugJumpListener);
        console.log('🐛 DEBUG: Type "testend" to jump to study end walkthrough');
    }

    // (Mode selector key listener stays active - no need to disable it)
    
    if (modeSelector) {
        // Set current mode as selected
        modeSelector.value = CURRENT_MODE;
        
        // Only allow mode changes in local environment
        // Production: Disable dropdown and prevent mode switching
        if (!isLocal) {
            modeSelector.disabled = true;
            modeSelector.style.opacity = '0.5';
            modeSelector.style.cursor = 'not-allowed';
            modeSelector.title = 'Mode switching disabled in production (Study Mode enforced)';
        } else {
            // Add change listener to switch modes (local only)
            modeSelector.addEventListener('change', (e) => {
                const newMode = e.target.value;
                console.log(`🔄 Switching mode to: ${newMode}`);
                
                // Save to localStorage
                localStorage.setItem('selectedMode', newMode);
                
                // Show confirmation
                const confirmed = confirm(`Switch to ${newMode.toUpperCase()} mode? The page will reload.`);
                if (confirmed) {
                    // Reload page to apply new mode
                    window.location.reload();
                } else {
                    // Reset dropdown to current mode
                    e.target.value = CURRENT_MODE;
                    localStorage.removeItem('selectedMode');
                }
            });
        }
    }
    
    // Hide simulate panel in Study Mode (surveys are controlled by workflow)
    // Also hide in Solar Portal mode
    // But exclude TUTORIAL_END mode - it behaves differently (no initial modals)
    if (isStudyMode() || CURRENT_MODE === AppMode.SOLAR_PORTAL) {
        const simulatePanel = document.querySelector('.panel-simulate');
        if (simulatePanel) {
            simulatePanel.style.display = 'none';
            if (CURRENT_MODE === AppMode.SOLAR_PORTAL) {
                console.log('☀️ Solar Portal Mode: Simulate panel hidden');
            } else {
                console.log('🎓 Production Mode: Simulate panel hidden (surveys controlled by workflow)');
            }
        }
        
        // Permanent overlay in Production Mode (fully controlled by modal system)
        // Modal system checks flags and decides whether to show overlay
        console.log('🎓 Production Mode: Modal system controls overlay (based on workflow flags)');
    } else {
        // Hide permanent overlay in non-Study modes (Dev, Personal, TUTORIAL_END)
        const permanentOverlay = document.getElementById('permanentOverlay');
        if (permanentOverlay) {
            permanentOverlay.style.display = 'none';
            if (isTutorialEndMode()) {
                console.log('🎬 Tutorial End Mode: Permanent overlay hidden (no initial modals)');
            } else if (!isStudyMode()) {
                console.log(`✅ ${CURRENT_MODE.toUpperCase()} Mode: Permanent overlay hidden`);
            }
        }
    }
    
    // Initialize tutorial system (includes Enter key skip functionality)
    // Skip if in Personal Mode
    if (!shouldSkipTutorial()) {
        initTutorial();
    }

    // 🐛 DEBUG: Test Study End Mode - Auto-run debug jump after a delay
    if (isTutorialEndMode()) {
        console.log('🐛 Test Study End Mode: Auto-trigger in 1 second (then 4s wait for data load)...');
        console.log('🐛 (Or type "testend" to trigger manually)');
        setTimeout(async () => {
            const { debugJumpToStudyEnd } = await import('./tutorial-coordinator.js');
            debugJumpToStudyEnd();
        }, 1000);
    }

    // Parse participant ID from URL parameters on page load
    // Qualtrics redirects with: ?ResponseID=${e://Field/ResponseID}
    // This automatically captures the ResponseID and stores it for survey submissions
    const urlParticipantId = getParticipantIdFromURL();
    if (urlParticipantId) {
        storeParticipantId(urlParticipantId);
        console.log('🔗 ResponseID detected from Qualtrics redirect:', urlParticipantId);
        console.log('💾 Stored ResponseID for use in survey submissions');
    }
    
    // Check if we should open participant modal from URL parameter (for simulator)
    // This should ONLY open the modal, not trigger study workflow
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('openParticipant') === 'true') {
        // Prevent study workflow from auto-starting
        localStorage.setItem('skipStudyWorkflow', 'true');
        // Small delay to ensure modals are initialized
        setTimeout(() => {
            openParticipantModal();
        }, 500);
    }

    // Default isSharedSession to false - will be set true only if share link found
    sessionStorage.setItem('isSharedSession', 'false');

    // Check for shared session in URL (?share=xxx)
    const sharedSessionData = await checkAndLoadSharedSession();
    if (sharedSessionData) {
        console.log('🔗 Loading shared session...');
        const result = applySharedSession(sharedSessionData);

        // 🔗 CONSUME the share link: Remove ?share= from URL so future refreshes
        // load from localStorage (user's own work) instead of the shared session.
        // This is standard UX for share links (Figma, Google Docs, Notion do the same)
        history.replaceState({}, '', window.location.pathname);
        console.log('🔗 Share link consumed - URL cleaned for future sessions');

        if (result.shouldFetch) {
            // Auto-fetch the shared data after a small delay for UI to update
            setTimeout(() => {
                const fetchBtn = document.getElementById('startBtn');
                if (fetchBtn) fetchBtn.click();
            }, 500);
        }
    }

    // Update participant ID display
    updateParticipantIdDisplay();

    // Memory monitoring is started after recent-searches cache loads (see below)
    
    // ═══════════════════════════════════════════════════════════
    // 🚨 STUDY MODE: Show overlay IMMEDIATELY to prevent UI interaction
    // ═══════════════════════════════════════════════════════════
    if (isStudyMode() && localStorage.getItem('emic_skip_login_welcome') !== 'true') {
        const overlay = document.getElementById('permanentOverlay');
        if (overlay) {
            overlay.style.display = 'flex';
            overlay.style.opacity = '1';
            console.log('🌋 Solar Audio - LIVE Production');
        }
    }
    
    // Initialize modals first (all modes need them)
    try {
        await initializeModals();
        console.log('✅ Modals initialized successfully');
    } catch (error) {
        console.error('❌ CRITICAL: Failed to initialize modals:', error);
        // Don't proceed if modals failed - this will cause dark screen
        throw error;
    }
    
    // Setup UI controls (all modes need them)
    setupModalEventListeners();
    
    // Initialize region tracker
    initRegionTracker();
    
    // Initialize complete button state (disabled until first feature is identified)
    // During tutorial (first visit), button state is handled by tutorial coordinator
    if (!isTutorialActive()) {
        updateCompleteButtonState(); // Begin Analysis button
    }
    updateCmpltButtonState(); // Complete button
    
    // Setup spectrogram frequency selection
    setupSpectrogramSelection();
    
    // Initialize oscilloscope visualization immediately (don't wait for audio)
    import('./oscilloscope-renderer.js').then(({ initOscilloscope }) => {
        initOscilloscope();
        console.log('🎨 Oscilloscope initialized on UI load');
    });
    
    // Initialize keyboard shortcuts
    initKeyboardShortcuts();
    
    // Initialize admin mode (applies user mode by default)
    initAdminMode();
    
    // Load saved preferences immediately to avoid visual jumps
    // (Must be done before other initialization that might trigger change handlers)
    loadFrequencyScale();
    loadColormap();
    loadFftSize();

    initWaveformWorker();
    
    const sliderValueFor1x = calculateSliderForSpeed(1.0);
    document.getElementById('playbackSpeed').value = sliderValueFor1x;
    if (!isStudyMode()) {
        console.log(`Initialized playback speed slider at position ${sliderValueFor1x} for 1.0x speed`);
    }
    
    // Load saved spacecraft selection (or use default)
    await loadSavedSpacecraft();
    
    console.groupEnd(); // End UI Setup
    
    // ═══════════════════════════════════════════════════════════
    // 🎯 MODE-AWARE ROUTING
    // ═══════════════════════════════════════════════════════════
    
    // Small delay to let page settle before starting workflows
    setTimeout(async () => {
        await initializeApp();
        if (logGroup('init', 'v2.0 App Ready')) {
            console.log('📌 v2.0 (2026-02-12) Three.js GPU-accelerated rendering');
            console.log('✅ App ready');
            logGroupEnd();
        }
        loadRecentSearches();
    }, 100);

    // Group event listeners setup
    console.groupCollapsed('⌨️ [INIT] Event Listeners');
    
    // Add event listeners
    document.getElementById('spacecraft').addEventListener('change', async (e) => {
        // Remove pulsing glow when user selects a spacecraft
        const spacecraftSelect = document.getElementById('spacecraft');
        if (spacecraftSelect) {
            spacecraftSelect.classList.remove('pulse-glow');
        }
        const selectedSpacecraft = e.target.value;
        const spacecraftWithData = State.spacecraftWithData;

        // 💾 Save spacecraft selection to localStorage for persistence
        localStorage.setItem('selectedSpacecraft', selectedSpacecraft);
        console.log('💾 Saved spacecraft selection:', selectedSpacecraft);

        // 🛰️ Update the Data dropdown to show datasets for the selected spacecraft
        updateDatasetOptions();

        // 🔧 FIX: Don't switch regions here! The user is still viewing old data.
        // Regions will switch when "Fetch Data" is clicked (via startStreaming → switchSpacecraftRegions)
        // The dropdown just selects WHICH spacecraft to fetch next, doesn't change current data/regions

        // 🎨 Visual reminder: If there's loaded data from a different spacecraft, mark it as "(Currently Loaded)"
        if (spacecraftWithData && selectedSpacecraft !== spacecraftWithData) {
            updateSpacecraftDropdownLabels(spacecraftWithData, selectedSpacecraft);
        } else if (spacecraftWithData && selectedSpacecraft === spacecraftWithData) {
            // User switched back to the loaded spacecraft - clear the flag
            updateSpacecraftDropdownLabels(null, selectedSpacecraft);
        }

        // 🎯 In STUDY mode: prevent re-fetching same spacecraft (one spacecraft per session)
        // 👤 In PERSONAL/DEV modes: allow re-fetching any spacecraft anytime
        if (isStudyMode() && spacecraftWithData && selectedSpacecraft === spacecraftWithData) {
            const fetchBtn = document.getElementById('startBtn');
            fetchBtn.disabled = true;
            fetchBtn.title = 'This spacecraft already has data loaded. Select a different spacecraft to fetch new data.';
            console.log(`🚫 Fetch button disabled - ${selectedSpacecraft} already has data`);
        } else {
            // Switching to a different spacecraft - enable fetch button
            enableFetchButton();
            const fetchBtn = document.getElementById('startBtn');
            if (fetchBtn) {
                fetchBtn.title = '';
            }
        }

        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    document.getElementById('dataType').addEventListener('change', (e) => {
        // 💾 Save data type selection to localStorage for persistence
        localStorage.setItem('selectedDataType', e.target.value);
        console.log('💾 Saved data type selection:', e.target.value);
        enableFetchButton();
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    document.getElementById('station').addEventListener('change', (e) => {
        enableFetchButton();
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    document.getElementById('duration').addEventListener('change', (e) => {
        enableFetchButton();
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });

    // 💾 Save date/time selections to localStorage for persistence
    ['startDate', 'startTime', 'endDate', 'endTime'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', () => {
                console.log(`📅 ${id} changed`);
                saveDateTime();
                enableFetchButton();
            });
            // Also save on input for immediate feedback
            el.addEventListener('input', () => saveDateTime());
        } else {
            console.warn(`⚠️ Could not find element: ${id}`);
        }
    });
    console.log('✅ Date/time persistence listeners attached');
    document.getElementById('highpassFreq').addEventListener('change', (e) => {
        enableFetchButton();
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    document.getElementById('enableNormalize').addEventListener('change', (e) => {
        enableFetchButton();
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    document.getElementById('bypassCache').addEventListener('change', (e) => {
        enableFetchButton();
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    document.getElementById('baseSampleRate').addEventListener('change', (e) => {
        changeBaseSampleRate();
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    
    updatePlaybackSpeed();
    
    document.getElementById('speedLabel').addEventListener('click', resetSpeedTo1);
    document.getElementById('volumeLabel').addEventListener('click', resetVolumeTo1);
    
    document.getElementById('frequencyScale').addEventListener('change', changeFrequencyScale);
    document.getElementById('colormap').addEventListener('change', changeColormap);
    document.getElementById('fftSize').addEventListener('change', changeFftSize);

    // Min frequency multiplier control
    const minFreqInput = document.getElementById('minFreqMultiplier');
    if (minFreqInput) {
        // Restore saved value
        const savedMultiplier = localStorage.getItem('minFreqMultiplier');
        if (savedMultiplier) {
            const value = parseFloat(savedMultiplier);
            minFreqInput.value = value;
            setMinFreqMultiplier(value);
        }

        // Handle changes
        minFreqInput.addEventListener('change', () => {
            const value = parseFloat(minFreqInput.value);
            if (!isNaN(value) && value > 0) {
                setMinFreqMultiplier(value);
                localStorage.setItem('minFreqMultiplier', value);
                // Redraw spectrogram and axis
                drawFrequencyAxis();
                import('./spectrogram-three-renderer.js').then(module => {
                    // Clear cached spectrogram to force re-render with new minFreq
                    module.resetSpectrogramState();
                    module.renderCompleteSpectrogram();
                });
            }
        });
    }

    document.getElementById('waveformFilterLabel').addEventListener('click', resetWaveformFilterToDefault);
    
    setupWaveformInteraction();
    
    // Spacebar to toggle play/pause (but not when focused on interactive elements)
    document.addEventListener('keydown', (event) => {
        if (event.code === 'Space') {
            // Don't capture spacebar in text inputs, textareas, selects, or buttons
            const isTextInput = event.target.tagName === 'INPUT' && event.target.type !== 'range' && event.target.type !== 'checkbox';
            const isTextarea = event.target.tagName === 'TEXTAREA';
            const isSelect = event.target.tagName === 'SELECT';
            const isButton = event.target.tagName === 'BUTTON';
            const isZoomButton = isButton && event.target.classList.contains('zoom-btn');
            const isContentEditable = event.target.isContentEditable;
            
            // Return early (don't handle) if user is interacting with any form element
            // BUT allow spacebar to work with zoom buttons (hourglass buttons)
            if (isTextInput || isTextarea || isSelect || (isButton && !isZoomButton) || isContentEditable) {
                return; // Let browser handle spacebar normally
            }
            
            // Only prevent default and handle play/pause if not in an interactive element
            event.preventDefault();
            
            const playPauseBtn = document.getElementById('playPauseBtn');
            
            // 🔥 FIX: Copy State values to local variables to break closure chain
            const playbackState = State.playbackState;
            const allReceivedData = State.allReceivedData;
            
            if (!playPauseBtn.disabled && (playbackState !== PlaybackState.STOPPED || (allReceivedData && allReceivedData.length > 0))) {
                // Mirror the play/pause button exactly - just toggle, no selection logic
                togglePlayPause();
            }
        }
        
        // Enter key handler - handles multiple actions based on context
        if (event.key === 'Enter' || event.keyCode === 13) {
            // Don't capture Enter in text inputs, textareas, or contenteditable elements
            const isTextInput = event.target.tagName === 'INPUT' && event.target.type !== 'range' && event.target.type !== 'checkbox';
            const isTextarea = event.target.tagName === 'TEXTAREA';
            const isContentEditable = event.target.isContentEditable;
            
            // Don't handle Enter if user is typing in a field
            if (isTextInput || isTextarea || isContentEditable) {
                return; // Let browser handle Enter normally
            }
            
            // Check if any modal is open - if so, let the modal handle Enter
            const modalIds = ['welcomeModal', 'participantModal', 'preSurveyModal', 'postSurveyModal', 
                             'activityLevelModal', 'awesfModal', 'endModal', 'beginAnalysisModal', 
                             'missingStudyIdModal', 'completeConfirmationModal'];
            const isModalOpen = modalIds.some(modalId => {
                const modal = document.getElementById(modalId);
                return modal && modal.style.display !== 'none';
            });
            
            if (isModalOpen) {
                return; // Let modal handle Enter
            }
            
            // Priority 1: Check if "Begin Analysis" button is visible and enabled
            const completeBtn = document.getElementById('completeBtn');
            if (completeBtn && 
                completeBtn.textContent === 'Begin Analysis' && 
                !completeBtn.disabled &&
                completeBtn.style.display !== 'none' &&
                window.getComputedStyle(completeBtn).display !== 'none') {
                event.preventDefault();
                console.log('⌨️ Enter key pressed - triggering Begin Analysis button');
                completeBtn.click();
                return;
            }
            
            // Priority 2: In Personal Mode, trigger fetch data if fetch button is enabled (only on first load)
            if ((isPersonalMode() || isEmicStudyMode() || CURRENT_MODE === AppMode.SOLAR_PORTAL) && !hasPerformedFirstFetch) {
                const fetchBtn = document.getElementById('startBtn');
                if (fetchBtn && 
                    !fetchBtn.disabled &&
                    fetchBtn.style.display !== 'none' &&
                    window.getComputedStyle(fetchBtn).display !== 'none') {
                    event.preventDefault();
                    console.log('⌨️ Enter key pressed - triggering fetch data (Personal Mode, first load)');
                    fetchBtn.click();
                    return;
                }
            }
            
        }
    });
    
    // Blur sliders after interaction
    const playbackSpeedSlider = document.getElementById('playbackSpeed');
    const volumeSliderForBlur = document.getElementById('volumeSlider');
    [playbackSpeedSlider, volumeSliderForBlur].forEach(slider => {
        slider.addEventListener('mouseup', () => slider.blur());
        slider.addEventListener('change', () => slider.blur());
    });
    
    // Blur dropdowns
    const dropdowns = ['volcano', 'dataType', 'station', 'duration', 'frequencyScale'];
    dropdowns.forEach(id => {
        const dropdown = document.getElementById(id);
        if (dropdown) {
            dropdown.addEventListener('change', () => dropdown.blur());
        }
    });
    
    // Blur checkboxes
    const checkboxes = ['enableNormalize', 'bypassCache'];
    checkboxes.forEach(id => {
        const checkbox = document.getElementById(id);
        if (checkbox) {
            checkbox.addEventListener('change', () => checkbox.blur());
            checkbox.addEventListener('click', () => setTimeout(() => checkbox.blur(), 10));
        }
    });
    
    if (!isStudyMode()) {
        console.log('✅ Event listeners added for fetch button re-enabling');
    }
    
    // Handle window resize to reposition axis canvases - optimized for performance
    let resizeRAF = null;
    let waveformXAxisResizeTimer = null; // Timer for debouncing x-axis redraw on horizontal resize
    let waveformResizeTimer = null; // Timer for debouncing waveform redraw on resize
    let lastWaveformXAxisWidth = null; // Track waveform canvas width for x-axis horizontal resize detection
    let lastSpectrogramWidth = 0;
    let lastSpectrogramHeight = 0;
    let lastWaveformWidth = 0;
    let lastWaveformHeight = 0;
    
    // Initialize dimensions on page load
    setTimeout(() => {
        const spectrogramCanvas = document.getElementById('spectrogram');
        const waveformCanvas = document.getElementById('waveform');
        if (spectrogramCanvas) {
            lastSpectrogramWidth = spectrogramCanvas.width;
            lastSpectrogramHeight = spectrogramCanvas.height;
        }
        if (waveformCanvas) {
            lastWaveformWidth = waveformCanvas.offsetWidth;
            lastWaveformXAxisWidth = waveformCanvas.offsetWidth; // Update x-axis width tracker
            lastWaveformHeight = waveformCanvas.offsetHeight;
        }
    }, 0);
    
    // Handle orientation change on mobile - trigger resize logic
    window.addEventListener('orientationchange', () => {
        // Small delay to let the browser finish orientation change
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 100);
    });

    window.addEventListener('resize', () => {
        if (resizeRAF) return; // Already scheduled

        resizeRAF = requestAnimationFrame(() => {
            // 🔥 FIX: Check document connection before DOM manipulation
            if (!document.body || !document.body.isConnected) {
                resizeRAF = null;
                return;
            }
            
            // 🔥 FIX: Store resizeRAF reference for cleanup
            setResizeRAFRef(resizeRAF);
            
            const spectrogramCanvas = document.getElementById('spectrogram');
            const spectrogramAxisCanvas = document.getElementById('spectrogram-axis');
            const waveformCanvas = document.getElementById('waveform');
            const waveformAxisCanvas = document.getElementById('waveform-axis');
            
            // Handle spectrogram axis
            if (spectrogramCanvas && spectrogramAxisCanvas) {
                // Always reposition during resize (fast - no redraw)
                positionAxisCanvas();
                
                // Only redraw if canvas dimensions actually changed (expensive operation)
                const currentWidth = spectrogramCanvas.width;
                const currentHeight = spectrogramCanvas.height;
                
                if (currentWidth !== lastSpectrogramWidth || currentHeight !== lastSpectrogramHeight) {
                    spectrogramAxisCanvas.width = 60; // Always 60px width
                    spectrogramAxisCanvas.height = currentHeight;
                    drawFrequencyAxis();
                    lastSpectrogramWidth = currentWidth;
                    lastSpectrogramHeight = currentHeight;
                }
            }
            
            // Handle waveform axis
            if (waveformCanvas && waveformAxisCanvas) {
                // Always reposition during resize (fast - no redraw)
                positionWaveformAxisCanvas();
                
                // Only redraw if canvas dimensions actually changed (expensive operation)
                // Use display dimensions (offsetHeight) not internal canvas dimensions
                const currentWidth = waveformCanvas.offsetWidth;
                const currentHeight = waveformCanvas.offsetHeight;
                
                if (currentWidth !== lastWaveformWidth || currentHeight !== lastWaveformHeight) {
                    waveformAxisCanvas.width = 60; // Always 60px width
                    waveformAxisCanvas.height = currentHeight; // Use display height
                    drawWaveformAxis();
                    lastWaveformWidth = currentWidth;
                    lastWaveformHeight = currentHeight;
                }
            }
            
            // Handle waveform x-axis
            const waveformXAxisCanvas = document.getElementById('waveform-x-axis');
            if (waveformCanvas && waveformXAxisCanvas) {
                // Always reposition during resize (fast - no redraw)
                positionWaveformXAxisCanvas();
                positionSpectrogramXAxisCanvas();

                // Check if canvas width changed (horizontal resize)
                const currentWidth = waveformCanvas.offsetWidth;
                if (currentWidth !== lastWaveformXAxisWidth) {
                    // Clear any existing timer
                    if (waveformXAxisResizeTimer !== null) {
                        clearTimeout(waveformXAxisResizeTimer);
                        waveformXAxisResizeTimer = null;
                    }

                    // Set new timer to wait 100ms after last resize event
                    waveformXAxisResizeTimer = setTimeout(() => {
                        // 🔥 FIX: Check document connection before DOM manipulation
                        if (!document.body || !document.body.isConnected) {
                            waveformXAxisResizeTimer = null;
                            return;
                        }

                        // Resize and redraw x-axis ticks after resize is complete
                        resizeWaveformXAxisCanvas();
                        resizeSpectrogramXAxisCanvas();
                        waveformXAxisResizeTimer = null;
                    }, 100);

                    lastWaveformXAxisWidth = currentWidth;
                }
            }
            
            // Handle waveform date panel
            const waveformDateCanvas = document.getElementById('waveform-date');
            if (waveformCanvas && waveformDateCanvas) {
                // Always reposition during resize
                positionWaveformDateCanvas();
                
                // Redraw if canvas dimensions changed
                const currentWidth = waveformCanvas.offsetWidth;
                if (currentWidth !== lastWaveformWidth) {
                    resizeWaveformDateCanvas();
                }
            }
            
            // Handle buttons canvas resize
            resizeWaveformButtonsCanvas();
            
            // Handle waveform canvas resize - trigger redraw to update button positions
            if (waveformCanvas) {
                const currentWidth = waveformCanvas.offsetWidth;
                const currentHeight = waveformCanvas.offsetHeight;
                
                // Check if canvas dimensions changed
                if (currentWidth !== lastWaveformWidth || currentHeight !== lastWaveformHeight) {
                    // Update canvas internal dimensions (device pixels)
                    const dpr = window.devicePixelRatio || 1;
                    waveformCanvas.width = currentWidth * dpr;
                    waveformCanvas.height = currentHeight * dpr;
                    
                    // 🔥 CRITICAL: Clear cache immediately to prevent stretching!
                    // During the debounce period, any RAF or draw call would use the OLD cached canvas
                    // (at old size) drawn onto the NEW canvas (at new size) = STRETCHED WAVEFORM!
                    State.setCachedWaveformCanvas(null);
                    
                    // Then regenerate with debounce
                    if (waveformResizeTimer !== null) {
                        clearTimeout(waveformResizeTimer);
                    }
                    waveformResizeTimer = setTimeout(() => {
                        // 🔥 FIX: Check document connection before DOM manipulation
                        if (!document.body || !document.body.isConnected) {
                            waveformResizeTimer = null;
                            return;
                        }
                        
                        // Re-render waveform at correct size
                        if (State.getCompleteSamplesLength() > 0) {
                            drawWaveformFromMinMax();
                            drawWaveformWithSelection();
                        }
                        
                        waveformResizeTimer = null;
                    }, 100);
                    
                    lastWaveformWidth = currentWidth;
                    lastWaveformHeight = currentHeight;
                }
            }

            // Update feature box positions after resize (boxes need to reposition for new canvas dimensions)
            updateAllFeatureBoxPositions();

            // Redraw day markers (overlay canvas buffer gets cleared on resize)
            drawDayMarkers();

            resizeRAF = null;
        });
    });
    
    // Initial axis positioning and drawing on page load
    // Use setTimeout to ensure DOM is fully ready
    setTimeout(() => {
        positionAxisCanvas();
        initializeAxisPlaybackRate();
        positionWaveformAxisCanvas();
        drawWaveformAxis();
        // Initialize maxCanvasWidth baseline (1200px) for tick spacing logic
        initializeMaxCanvasWidth();
        positionWaveformXAxisCanvas();
        drawWaveformXAxis();
        positionSpectrogramXAxisCanvas();
        drawSpectrogramXAxis();
        drawDayMarkers();
        positionWaveformDateCanvas();
        drawWaveformDate();
        positionWaveformButtonsCanvas();
        drawRegionButtons();
        // Update dimensions after initial draw
        const spectrogramCanvas = document.getElementById('spectrogram');
        const waveformCanvas = document.getElementById('waveform');
        if (spectrogramCanvas) {
            lastSpectrogramWidth = spectrogramCanvas.width;
            lastSpectrogramHeight = spectrogramCanvas.height;
        }
        if (waveformCanvas) {
            lastWaveformWidth = waveformCanvas.offsetWidth;
            lastWaveformXAxisWidth = waveformCanvas.offsetWidth; // Update x-axis width tracker
            lastWaveformHeight = waveformCanvas.offsetHeight;
        }
    }, 100);
    
    // 🔍 RECENT SEARCHES SYSTEM (using IndexedDB cache)
    
    /**
     * Load recent searches from IndexedDB cache and populate dropdown
     */
    async function loadRecentSearches() {
        const dropdown = document.getElementById('recentSearches');
        if (!dropdown) return;
        
        // Clear existing options (except placeholder)
        dropdown.innerHTML = '<option value="">-- Select Recent Search --</option>';
        
        try {
            // Get recent searches from IndexedDB cache
            const { listRecentSearches, formatCacheEntryForDisplay } = await import('./cdaweb-cache.js');
            const recentSearches = await listRecentSearches();
            
            // Add each search as an option
            recentSearches.forEach((entry, index) => {
                const option = document.createElement('option');
                option.value = entry.id; // Use cache ID as value
                option.textContent = formatCacheEntryForDisplay(entry);
                option.dataset.cacheEntry = JSON.stringify({
                    spacecraft: entry.spacecraft,
                    dataset: entry.dataset,
                    startTime: entry.startTime,
                    endTime: entry.endTime
                });
                dropdown.appendChild(option);
            });
            
            console.log(`📋 Loaded ${recentSearches.length} recent searches from cache`);
            startMemoryMonitoring();
        } catch (e) {
            console.warn('Could not load recent searches:', e);
            startMemoryMonitoring();
        }
    }

    // Expose loadRecentSearches globally so startStreaming can call it
    window.loadRecentSearches = loadRecentSearches;
    
    /**
     * Restore a search from recent searches by loading from cache
     */
    async function restoreRecentSearch(selectedOption) {
        try {
            if (!selectedOption.dataset.cacheEntry) return;

            // Bump this search to the top of the recent list
            const { touchCacheEntry } = await import('./cdaweb-cache.js');
            await touchCacheEntry(selectedOption.value);

            const cacheData = JSON.parse(selectedOption.dataset.cacheEntry);

            // Parse start/end times to populate form fields
            const startDate = new Date(cacheData.startTime);
            const endDate = new Date(cacheData.endTime);

            // Format for date inputs (YYYY-MM-DD)
            const startDateStr = startDate.toISOString().split('T')[0];
            const endDateStr = endDate.toISOString().split('T')[0];

            // Format for time inputs (HH:MM:SS.mmm)
            const startTimeStr = startDate.toISOString().split('T')[1].replace('Z', '');
            const endTimeStr = endDate.toISOString().split('T')[1].replace('Z', '');

            // Populate form fields - ORDER MATTERS!
            // 1. Set spacecraft first
            document.getElementById('spacecraft').value = cacheData.spacecraft;
            // 2. Update dataset dropdown options for the selected spacecraft
            updateDatasetOptions();
            // 3. Now set the dataset (after options are populated)
            document.getElementById('dataType').value = cacheData.dataset;
            // 4. Set date/time fields
            document.getElementById('startDate').value = startDateStr;
            document.getElementById('startTime').value = startTimeStr;
            document.getElementById('endDate').value = endDateStr;
            document.getElementById('endTime').value = endTimeStr;

            // 5. Save all restored values to localStorage for persistence
            localStorage.setItem('selectedSpacecraft', cacheData.spacecraft);
            localStorage.setItem('selectedDataType', cacheData.dataset);
            saveDateTime();

            console.log(`🔍 Restored recent search: ${selectedOption.textContent}`);
            
            // Automatically fetch the data from cache
            const startBtn = document.getElementById('startBtn');
            if (startBtn && !startBtn.disabled) {
                console.log(`🚀 Auto-fetching restored search data...`);
                startBtn.click();
            } else {
                console.warn('⚠️ Cannot auto-fetch: startBtn disabled or not found');
            }
            
        } catch (e) {
            console.warn('Could not restore recent search:', e);
        }
    }
    
    /**
     * Save current search - handled automatically by fetchCDAWebAudio caching
     * This function is kept for backward compatibility but does nothing
     */
    function saveRecentSearch() {
        // Searches are now automatically saved to IndexedDB cache by fetchCDAWebAudio
        // This function is intentionally empty
    }
    
    // 🎯 SETUP EVENT LISTENERS (replaces onclick handlers to prevent memory leaks)
    // All event listeners are properly scoped and don't create permanent closures on window.*
    
    // Cache & Download & Share
    document.getElementById('purgeCacheBtn').addEventListener('click', purgeCloudflareCache);
    document.getElementById('downloadBtn').addEventListener('click', downloadAudio);
    document.getElementById('shareBtn').addEventListener('click', openShareModal);
    
    // Spacecraft Selection
    document.getElementById('spacecraft').addEventListener('change', (e) => {
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    document.getElementById('dataType').addEventListener('change', (e) => {
        updateStationList();
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    
    // Recent Searches
    document.getElementById('recentSearches').addEventListener('change', (e) => {
        const selectedOption = e.target.options[e.target.selectedIndex];
        if (selectedOption && selectedOption.value) {
            restoreRecentSearch(selectedOption);
            // Reset dropdown to placeholder after restoring
            e.target.value = '';
        }
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    
    console.log('🟢 LINE 2180 - About to attach startBtn event listener');
    
    // Data Fetching
    const startBtn = document.getElementById('startBtn');
    console.log('🟢 startBtn element:', startBtn ? 'FOUND' : 'NOT FOUND');
    if (startBtn) {
        startBtn.addEventListener('click', async (e) => {
            console.log('🔵 Fetch Data button clicked!');
            // Cancel any typing animation immediately
            const { cancelTyping } = await import('./tutorial-effects.js');
            cancelTyping();
            saveRecentSearch(); // Save search before fetching (no-op now, handled by cache)
            // EMIC mode: use config defined in emic_study.html
            const { isEmicStudyMode } = await import('./master-modes.js');
            if (isEmicStudyMode()) {
                await startStreaming(e, window.__EMIC_CONFIG);
            } else {
                await startStreaming(e);
            }
            e.target.blur(); // Blur so spacebar can toggle play/pause
        });
        console.log('🟢 startBtn event listener attached successfully!');
    } else {
        console.error('❌ startBtn NOT FOUND - cannot attach event listener!');
    }
    document.getElementById('forceIrisBtn').addEventListener('click', toggleForceIris);
    
    // Playback Controls
    document.getElementById('playPauseBtn').addEventListener('click', (e) => {
        togglePlayPause();
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    document.getElementById('loopBtn').addEventListener('click', toggleLoop);
    document.getElementById('playbackSpeed').addEventListener('input', () => {
        changePlaybackSpeed();
        // Remove glow when user interacts with speed slider
        const speedSlider = document.getElementById('playbackSpeed');
        if (speedSlider) {
            speedSlider.classList.remove('speed-slider-glow');
        }
    });
    // Stretch algorithm selector
    const stretchAlgoSelect = document.getElementById('stretchAlgorithm');
    if (stretchAlgoSelect) {
        stretchAlgoSelect.addEventListener('change', (e) => {
            switchStretchAlgorithm(e.target.value);
        });
    }
    const volumeSlider = document.getElementById('volumeSlider');
    if (volumeSlider) {
        // Remove glow on mousedown/touchstart (when user clicks down, not on release)
        volumeSlider.addEventListener('mousedown', removeVolumeSliderGlow);
        volumeSlider.addEventListener('touchstart', removeVolumeSliderGlow);
        volumeSlider.addEventListener('input', changeVolume);
    }
    
    // Waveform Filters
    document.getElementById('removeDCOffset').addEventListener('change', handleWaveformFilterChange);
    document.getElementById('waveformFilterSlider').addEventListener('input', handleWaveformFilterChange);
    
    // Anti-aliasing
    document.getElementById('antiAliasingBtn').addEventListener('click', toggleAntiAliasing);
    
    // Survey/Modal Buttons
    document.getElementById('participantModalBtn').addEventListener('click', openParticipantModal);
    document.getElementById('welcomeModalBtn').addEventListener('click', openWelcomeModal);
    document.getElementById('preSurveyModalBtn').addEventListener('click', openPreSurveyModal);
    document.getElementById('activityLevelModalBtn').addEventListener('click', openActivityLevelModal);
    document.getElementById('awesfModalBtn').addEventListener('click', openAwesfModal);
    document.getElementById('postSurveyModalBtn').addEventListener('click', openPostSurveyModal);
    document.getElementById('endModalBtn').addEventListener('click', () => {
        // Show end modal with test data
        const participantId = getParticipantId() || 'TEST123';
        openEndModal(participantId, 1);
    });
    // Test submit button (admin panel) - direct submission for testing
    // Hide when zoomed out, show when zoomed in
    const submitBtn = document.getElementById('submitBtn');
    if (submitBtn) {
        submitBtn.addEventListener('click', attemptSubmission);
        
        // Function to update submit button visibility based on zoom state
        // Export to window so zoom functions can call it
        window.updateSubmitButtonVisibility = () => {
            if (zoomState.isInRegion()) {
                submitBtn.style.display = 'inline-block';
            } else {
                submitBtn.style.display = 'none';
            }
        };
        
        // Initial state
        window.updateSubmitButtonVisibility();
    }
    
    // Complete button (Begin Analysis) - shows confirmation modal first
    const completeBtn = document.getElementById('completeBtn');
    if (completeBtn) {
        completeBtn.addEventListener('click', (e) => {
            // 🔒 Prevent clicks when button is disabled (during tutorial)
            if (completeBtn.disabled) {
                e.preventDefault();
                e.stopPropagation();
                console.log('🔒 Begin Analysis button click blocked - button is disabled');
                return;
            }
            
            e.preventDefault();
            e.stopPropagation();
            console.log('🔵 Begin Analysis button clicked');

            // Check if tutorial is waiting for this click
            if (State.waitingForBeginAnalysisClick && State._beginAnalysisClickResolve) {
                console.log('✅ Tutorial waiting - skipping modal and transitioning to analysis mode');
                State.setWaitingForBeginAnalysisClick(false);

                // Fire the beginAnalysisConfirmed event to transition into analysis mode
                window.dispatchEvent(new CustomEvent('beginAnalysisConfirmed'));

                // Resolve the tutorial promise
                State._beginAnalysisClickResolve();
                State.setBeginAnalysisClickResolve(null);
            } else {
                // Normal flow - show confirmation modal
                openBeginAnalysisModal();
            }
        });
    } else {
        console.warn('⚠️ Begin Analysis button (completeBtn) not found in DOM');
    }
    
    // Listen for confirmation to proceed with workflow
    window.addEventListener('beginAnalysisConfirmed', async () => {
        // Mark tutorial as completed (Begin Analysis was clicked) - PERSISTENT flag
        const { markTutorialAsCompleted, markBeginAnalysisClickedThisSession } = await import('./study-workflow.js');
        markTutorialAsCompleted();
        
        // Mark Begin Analysis as clicked THIS SESSION - SESSION flag (cleared each new session)
        markBeginAnalysisClickedThisSession();
        
        // Disable auto play checkbox after Begin Analysis is confirmed
        const autoPlayCheckbox = document.getElementById('autoPlay');
        if (autoPlayCheckbox) {
            autoPlayCheckbox.checked = false;
            autoPlayCheckbox.disabled = true;
            console.log('✅ Auto play disabled after Begin Analysis confirmation');
        }
        
        // Configure interaction dropdowns for analysis mode after Begin Analysis
        const mainDragSelect = document.getElementById('mainWindowDrag');
        if (mainDragSelect) {
            mainDragSelect.value = 'drawFeature';
            localStorage.setItem('emic_main_drag', 'drawFeature');
        }
        const mainReleaseSelect = document.getElementById('mainWindowRelease');
        if (mainReleaseSelect) {
            mainReleaseSelect.value = 'playAudio';
            localStorage.setItem('emic_main_release', 'playAudio');
        }
        console.log('✅ Main window interaction set for analysis: drag=drawFeature, release=playAudio');
        // Also disable the hidden playOnClick checkbox
        const playOnClickCheckbox = document.getElementById('playOnClick');
        if (playOnClickCheckbox) {
            playOnClickCheckbox.checked = false;
            playOnClickCheckbox.disabled = true;
        }
        
        // Enable region creation after "Begin Analysis" is confirmed
        const { setRegionCreationEnabled } = await import('./audio-state.js');
        setRegionCreationEnabled(true);
        console.log('✅ Region creation ENABLED after Begin Analysis confirmation');
        
        // If a region has already been selected, show the "Add Region" button
        // This puts the user in the mode where they can click 'r' to select that region
        if (State.selectionStart !== null && State.selectionEnd !== null && !zoomState.isInRegion()) {
            showAddRegionButton(State.selectionStart, State.selectionEnd);
            console.log('🎯 Showing Add Region button for existing selection');
        }
        
        // Disable spacecraft switching after confirmation
        const volcanoSelect = document.getElementById('spacecraft');
        if (volcanoSelect) {
            volcanoSelect.disabled = true;
            volcanoSelect.style.opacity = '0.6';
            volcanoSelect.style.cursor = 'not-allowed';
            console.log('🔒 Spacecraft switching disabled after Begin Analysis confirmation');
        }
        
        // Transform Begin Analysis button into Complete button
        const completeBtn = document.getElementById('completeBtn');
        if (completeBtn) {
            // Update button text and styling
            completeBtn.textContent = 'Complete';
            completeBtn.style.background = '#28a745';
            completeBtn.style.borderColor = '#28a745';
            completeBtn.style.border = '2px solid #28a745';
            completeBtn.style.color = 'white';
            completeBtn.className = ''; // Remove begin-analysis-btn class to remove sparkle effect
            completeBtn.removeAttribute('onmouseover');
            completeBtn.removeAttribute('onmouseout');
            
            // Remove old click handler and add new one
            const newBtn = completeBtn.cloneNode(true);
            completeBtn.parentNode.replaceChild(newBtn, completeBtn);
            
            // Add Complete button click handler
            newBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('✅ Complete button clicked');
                openCompleteConfirmationModal();
            });
            
            // Initially disable until features are identified
            newBtn.disabled = true;
            newBtn.style.opacity = '0.5';
            newBtn.style.cursor = 'not-allowed';
            
            // Update state based on features AND visibility
            // updateCompleteButtonState() handles visibility (checks hasData && !isTutorialActive())
            // updateCmpltButtonState() handles enable/disable based on features
            const { updateCompleteButtonState } = await import('./region-tracker.js');
            updateCompleteButtonState();
            updateCmpltButtonState();
            
            console.log('🔄 Begin Analysis button transformed into Complete button');
        }
    });
    
    document.getElementById('adminModeBtn').addEventListener('click', toggleAdminMode);

    // Start event listeners setup group
    const listenersGroupOpen = logGroup('ui', 'Setting up UI event listeners');

    // Participant ID display click handler
    const participantIdText = document.getElementById('participantIdText');
    if (participantIdText) {
        participantIdText.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('👤 Participant ID display clicked - opening modal');
            openParticipantModal();
        });
        // Add hover effect - keep dark background theme with reddish tint
        participantIdText.addEventListener('mouseenter', function() {
            this.style.backgroundColor = 'rgba(80, 50, 50, 0.6)';
        });
        participantIdText.addEventListener('mouseleave', function() {
            this.style.backgroundColor = 'rgba(40, 40, 40, 0.4)';
        });
    }
    
    // Tutorial help button click handler (only show in study mode)
    const tutorialHelpBtn = document.getElementById('tutorialHelpBtn');
    if (tutorialHelpBtn) {
        // Show button only in study mode
        if (isStudyMode()) {
            tutorialHelpBtn.style.display = 'flex';
        }
        
        tutorialHelpBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('❓ Tutorial help button clicked');
            const { openTutorialRevisitModal } = await import('./ui-controls.js');
            openTutorialRevisitModal();
        });
        
        // Add hover effect
        tutorialHelpBtn.addEventListener('mouseenter', function() {
            this.style.backgroundColor = 'rgba(255, 255, 255, 0.15)';
            this.style.borderColor = '#ddd';
            this.style.color = '#ddd';
        });
        tutorialHelpBtn.addEventListener('mouseleave', function() {
            this.style.backgroundColor = 'transparent';
            this.style.borderColor = '#aaa';
            this.style.color = '#aaa';
        });
    }
    
    // About info button click handler
    const aboutInfoBtn = document.getElementById('aboutInfoBtn');
    if (aboutInfoBtn) {
        aboutInfoBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const modalId = window.__EMIC_STUDY_MODE ? 'emicAboutModal' : 'aboutModal';
            await modalManager.openModal(modalId);
        });

        // Wire up close button inside the about modal
        const aboutModal = document.getElementById('aboutModal');
        if (aboutModal) {
            const aboutCloseBtn = aboutModal.querySelector('.modal-close');
            if (aboutCloseBtn) {
                aboutCloseBtn.addEventListener('click', () => {
                    modalManager.closeModal('aboutModal');
                });
            }
        }

        // Wire up close button inside the EMIC about modal
        const emicAboutModal = document.getElementById('emicAboutModal');
        if (emicAboutModal) {
            const emicAboutCloseBtn = emicAboutModal.querySelector('.modal-close');
            if (emicAboutCloseBtn) {
                emicAboutCloseBtn.addEventListener('click', () => {
                    modalManager.closeModal('emicAboutModal');
                });
            }
        }
    }

    // Post-study questionnaire: Background question button + modal
    const backgroundQuestionBtn = document.getElementById('backgroundQuestionBtn');
    const bgModal = document.getElementById('backgroundQuestionModal');
    if (backgroundQuestionBtn && bgModal) {
        backgroundQuestionBtn.addEventListener('click', async () => {
            await modalManager.openModal('backgroundQuestionModal');
        });

        const bgSubmit = bgModal.querySelector('.modal-submit');
        bgModal.querySelectorAll('input[type="radio"]').forEach(radio => {
            radio.addEventListener('change', () => { bgSubmit.disabled = false; });
        });

        const bgClose = bgModal.querySelector('.modal-close');
        if (bgClose) {
            bgClose.addEventListener('click', () => modalManager.closeModal('backgroundQuestionModal'));
        }

        bgSubmit.addEventListener('click', () => {
            const value = document.querySelector('input[name="backgroundLevel"]:checked')?.value;
            console.log('📋 Background level:', value);
            modalManager.closeModal('backgroundQuestionModal');
        });
    }

    // Post-study questionnaire: Data analysis experience button + modal
    const dataAnalysisQuestionBtn = document.getElementById('dataAnalysisQuestionBtn');
    const daModal = document.getElementById('dataAnalysisQuestionModal');
    if (dataAnalysisQuestionBtn && daModal) {
        dataAnalysisQuestionBtn.addEventListener('click', async () => {
            await modalManager.openModal('dataAnalysisQuestionModal');
        });

        const daSubmit = daModal.querySelector('.modal-submit');
        daModal.querySelectorAll('input[type="radio"]').forEach(radio => {
            radio.addEventListener('change', () => { daSubmit.disabled = false; });
        });

        const daClose = daModal.querySelector('.modal-close');
        if (daClose) {
            daClose.addEventListener('click', () => modalManager.closeModal('dataAnalysisQuestionModal'));
        }

        daSubmit.addEventListener('click', () => {
            const value = document.querySelector('input[name="dataAnalysisLevel"]:checked')?.value;
            console.log('📋 Data analysis level:', value);
            modalManager.closeModal('dataAnalysisQuestionModal');
        });
    }

    // Post-study questionnaire: Feedback (free response) button + modal
    const feedbackQuestionBtn = document.getElementById('feedbackQuestionBtn');
    const fbModal = document.getElementById('feedbackQuestionModal');
    if (feedbackQuestionBtn && fbModal) {
        feedbackQuestionBtn.addEventListener('click', async () => {
            await modalManager.openModal('feedbackQuestionModal');
        });

        const fbSubmit = fbModal.querySelector('.modal-submit');
        const fbTextarea = fbModal.querySelector('#feedbackText');

        // Toggle button text between Skip and Submit based on textarea content
        fbTextarea.addEventListener('input', () => {
            fbSubmit.textContent = fbTextarea.value.trim() ? '✓ Submit' : 'Skip';
        });

        const fbClose = fbModal.querySelector('.modal-close');
        if (fbClose) {
            fbClose.addEventListener('click', () => modalManager.closeModal('feedbackQuestionModal'));
        }

        fbSubmit.addEventListener('click', () => {
            const value = fbTextarea.value.trim();
            console.log('📋 Feedback:', value || '(skipped)');
            modalManager.closeModal('feedbackQuestionModal');
        });
    }

    // Post-study questionnaire: Referral (free response) button + modal
    const referralQuestionBtn = document.getElementById('referralQuestionBtn');
    const refModal = document.getElementById('referralQuestionModal');
    if (referralQuestionBtn && refModal) {
        referralQuestionBtn.addEventListener('click', async () => {
            await modalManager.openModal('referralQuestionModal');
        });

        const refSubmit = refModal.querySelector('.modal-submit');
        const refTextarea = refModal.querySelector('#referralText');

        refTextarea.addEventListener('input', () => {
            refSubmit.textContent = refTextarea.value.trim() ? '✓ Submit' : 'Skip';
        });

        const refClose = refModal.querySelector('.modal-close');
        if (refClose) {
            refClose.addEventListener('click', () => modalManager.closeModal('referralQuestionModal'));
        }

        refSubmit.addEventListener('click', () => {
            const value = refTextarea.value.trim();
            console.log('📋 Referral:', value || '(skipped)');
            modalManager.closeModal('referralQuestionModal');
        });
    }

    // Set up component selector listener
    const { setupComponentSelectorListener } = await import('./component-selector.js');
    setupComponentSelectorListener();
    
    // Set up download audio button (floating button below Selected Regions)
    const downloadAudioBtn = document.getElementById('downloadAudioBtn');
    if (downloadAudioBtn) {
        downloadAudioBtn.addEventListener('click', async () => {
            // Get current metadata
            if (!State.currentMetadata || State.getCompleteSamplesLength() === 0) {
                alert('No audio data loaded. Please fetch data first.');
                return;
            }
            
            const metadata = State.currentMetadata;
            const samples = State.completeSamplesArray || State.getCompleteSamplesArray();
            
            // Create filename from metadata (include component if known)
            const spacecraft = metadata.spacecraft || 'PSP';
            const dataset = metadata.dataset || 'MAG';
            const startTime = State.dataStartTime?.toISOString().replace(/:/g, '-').replace(/\./g, '-') || 'unknown';
            const endTime = State.dataEndTime?.toISOString().replace(/:/g, '-').replace(/\./g, '-') || 'unknown';
            
            // Get current component from selector if available
            const componentSelector = document.getElementById('componentSelector');
            const componentLabel = componentSelector && componentSelector.selectedIndex >= 0 
                ? componentSelector.options[componentSelector.selectedIndex].text.split(' ')[0] // Get "br" from "br (Radial)"
                : 'audio';
            
            const filename = `${spacecraft}_${dataset}_${componentLabel}_${startTime}_${endTime}.wav`;
            
            // completeSamplesArray is at 44100 Hz (AudioContext's native sample rate)
            const sampleRate = 44100;
            console.log(`📥 Downloading audio: ${filename}`);
            console.log(`   Samples: ${samples.length.toLocaleString()}, Sample rate: ${sampleRate} Hz`);

            // Create WAV file at 44.1kHz (our resampled playback version)
            const wavBlob = createWAVBlob(samples, sampleRate);
            
            // Trigger download
            const url = URL.createObjectURL(wavBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            console.log(`✅ Downloaded: ${filename} (${(wavBlob.size / 1024 / 1024).toFixed(2)} MB)`);
        });
    }

    // Set up audio recording button (records live audio output as WAV)
    const recordAudioBtn = document.getElementById('recordAudioBtn');
    if (recordAudioBtn) {
        let isRecording = false;
        let recordedSamples = [];
        let recordingStartTime = null;
        let recorderNode = null;

        recordAudioBtn.addEventListener('click', async () => {
            if (!State.audioContext || !State.gainNode) {
                alert('No audio context available. Please load audio data first.');
                return;
            }

            // Toggle recording state
            if (isRecording) {
                // Stop recording
                isRecording = false;

                // Disconnect and clean up recorder node
                if (recorderNode) {
                    State.gainNode.disconnect(recorderNode);
                    recorderNode.disconnect();
                    recorderNode = null;
                }

                recordAudioBtn.textContent = '🔴 Begin Recording';
                recordAudioBtn.style.background = 'linear-gradient(135deg, #e74c3c 0%, #c0392b 100%)';
                recordAudioBtn.style.animation = 'none';
                console.log(`⏹️ Recording stopped: ${recordedSamples.length.toLocaleString()} samples captured`);

                // Convert recorded samples to Float32Array
                const samples = new Float32Array(recordedSamples);
                recordedSamples = []; // Clear memory

                // Generate filename with volcano and timestamp
                const volcano = document.getElementById('spacecraft')?.value || 'audio';
                const timestamp = recordingStartTime.toISOString()
                    .replace(/:/g, '-')
                    .replace(/\./g, '-')
                    .slice(0, 19); // YYYY-MM-DDTHH-MM-SS
                const filename = `${volcano}_recording_${timestamp}.wav`;

                // Create WAV file at 44.1kHz
                const wavBlob = createWAVBlob(samples, 44100);

                // Trigger download
                const url = URL.createObjectURL(wavBlob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                console.log(`✅ Recording saved: ${filename} (${(wavBlob.size / 1024 / 1024).toFixed(2)} MB)`);
            } else {
                // Start recording
                recordedSamples = [];
                recordingStartTime = new Date();
                isRecording = true;

                // Create a ScriptProcessorNode to capture raw audio samples
                // Note: ScriptProcessorNode is deprecated but widely supported
                // AudioWorklet would be cleaner but requires more setup
                const bufferSize = 4096;
                recorderNode = State.audioContext.createScriptProcessor(bufferSize, 1, 1);

                recorderNode.onaudioprocess = (e) => {
                    if (!isRecording) return;
                    const inputData = e.inputBuffer.getChannelData(0);
                    // Copy samples to our recording buffer
                    for (let i = 0; i < inputData.length; i++) {
                        recordedSamples.push(inputData[i]);
                    }
                };

                // Connect: gain -> recorder -> destination (pass-through)
                State.gainNode.connect(recorderNode);
                recorderNode.connect(State.audioContext.destination);

                recordAudioBtn.textContent = '⏹️ Stop Recording';
                recordAudioBtn.style.background = 'linear-gradient(135deg, #c0392b 0%, #922b21 100%)';
                recordAudioBtn.style.animation = 'recording-pulse 1s ease-in-out infinite';
                console.log('🔴 Recording started (WAV format)');
            }
        });
    }

    // Set up download ALL components button (creates a zip with all 3 WAV files)
    const downloadAllBtn = document.getElementById('downloadAllComponentsBtn');
    if (downloadAllBtn) {
        downloadAllBtn.addEventListener('click', async () => {
            const { getAllComponentBlobs, getComponentLabels, getCurrentDataIdentifiers, getComponentCount } = await import('./component-selector.js');

            const componentCount = getComponentCount();
            if (componentCount < 2) {
                alert('Only one component available. Use "Download Audio" instead.');
                return;
            }

            const allBlobs = await getAllComponentBlobs();
            if (!allBlobs || allBlobs.length === 0) {
                alert('Component data not yet loaded. Please wait for all components to download.');
                return;
            }

            // Show loading state
            const originalText = downloadAllBtn.textContent;
            downloadAllBtn.textContent = '⏳ Creating ZIP...';
            downloadAllBtn.disabled = true;

            try {
                const labels = getComponentLabels();
                const ids = getCurrentDataIdentifiers();
                const startTimeStr = ids.startTime?.replace(/:/g, '-').replace(/\./g, '-') || 'unknown';
                const endTimeStr = ids.endTime?.replace(/:/g, '-').replace(/\./g, '-') || 'unknown';
                const baseFilename = `${ids.spacecraft}_${ids.dataset}_${startTimeStr}_${endTimeStr}`;

                console.log(`📦 Creating ZIP with ${allBlobs.length} components...`);

                // Create ZIP file
                const zip = new JSZip();

                for (let i = 0; i < allBlobs.length; i++) {
                    const blob = allBlobs[i];
                    const label = labels[i]?.split(' ')[0] || `component${i}`; // Get "br" from "br (Radial)"
                    const filename = `${baseFilename}_${label}.wav`;
                    zip.file(filename, blob);
                    console.log(`   Added: ${filename} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
                }

                // Generate the ZIP blob
                const zipBlob = await zip.generateAsync({
                    type: 'blob',
                    compression: 'DEFLATE',
                    compressionOptions: { level: 6 }
                });

                // Trigger download
                const url = URL.createObjectURL(zipBlob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${baseFilename}_all_components.zip`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);

                console.log(`✅ Downloaded: ${baseFilename}_all_components.zip (${(zipBlob.size / 1024 / 1024).toFixed(2)} MB)`);
            } catch (err) {
                console.error('❌ Failed to create ZIP:', err);
                alert('Failed to create ZIP file. See console for details.');
            } finally {
                downloadAllBtn.textContent = originalText;
                downloadAllBtn.disabled = false;
            }
        });
    }

    // Close the event listeners group
    if (listenersGroupOpen) logGroupEnd();
    
    // 🔥 FIX: Cancel all RAF callbacks on page unload to prevent detached document leaks
    // This ensures RAF callbacks scheduled before page unload are cancelled
    // 🔥 FIX: Use static imports instead of dynamic imports to prevent Context leaks
    // Dynamic imports create new Context instances each time, causing massive memory leaks
    // Since waveform-x-axis-renderer.js is already imported statically at the top, use it directly
    if (!window._solarAudioCleanupHandlers) {
        window._solarAudioCleanupHandlers = {};
        
        // Import only modules that aren't already statically imported
    import('./audio-player.js').then(audioPlayerModule => {
        import('./spectrogram-axis-renderer.js').then(axisModule => {
                // 🔥 FIX: Use statically imported functions instead of dynamic import
                // This prevents creating new Context instances (147k+ Context leak!)
                const cleanupOnUnload = () => {
                    // Cancel all animation loops
                    audioPlayerModule.cancelAllRAFLoops();
                    axisModule.cancelScaleTransitionRAF();
                    cancelZoomTransitionRAF();

                    // Cleanup event listeners
                    cleanupSpectrogramSelection();
                    cleanupKeyboardShortcuts();

                    // Dispose GPU resources (Three.js textures, materials, geometry)
                    clearCompleteSpectrogram();
                    clearWaveformRenderer();

                    // Terminate waveform worker
                    if (State.waveformWorker) {
                        State.waveformWorker.terminate();
                        State.setWaveformWorker(null);
                    }

                    // Close AudioContext (releases system audio resources)
                    if (State.audioContext && State.audioContext.state !== 'closed') {
                        State.audioContext.close().catch(() => {});
                    }

                    // Null large data arrays to help GC
                    aggressiveCleanup();
                    window.rawWaveformData = null;
                    window.displayWaveformData = null;
                };
                window._solarAudioCleanupHandlers.cleanupOnUnload = cleanupOnUnload;
            
                // 🔥 FIX: Only set window.stopZoomTransition once to prevent function accumulation
                // Use statically imported function instead of dynamic import
                if (!window.stopZoomTransition) {
                    window.stopZoomTransition = stopZoomTransition;
                }
            
                // 🔥 FIX: Remove old listeners before adding new ones to prevent accumulation
                // Use stored reference so removeEventListener can match
                if (window._solarAudioCleanupHandlers.beforeunload) {
                    window.removeEventListener('beforeunload', window._solarAudioCleanupHandlers.beforeunload);
                }
                if (window._solarAudioCleanupHandlers.pagehide) {
                    window.removeEventListener('pagehide', window._solarAudioCleanupHandlers.pagehide);
                }
                window.addEventListener('beforeunload', cleanupOnUnload);
                window._solarAudioCleanupHandlers.beforeunload = cleanupOnUnload;
                
                // Also handle pagehide (more reliable than beforeunload in some browsers)
                window.addEventListener('pagehide', cleanupOnUnload);
                window._solarAudioCleanupHandlers.pagehide = cleanupOnUnload;
                
                // 🔥 FIX: Store visibility change handler reference for cleanup
                const visibilityChangeHandler = () => {
                    if (document.hidden) {
                        // Aggressive cleanup when hidden - save memory, stop animations
                        console.log('💤 Page hidden - aggressive cleanup');
                        audioPlayerModule.cancelAllRAFLoops();
                        axisModule.cancelScaleTransitionRAF();
                        cleanupSpectrogramSelection(); // Destroy canvas overlay
                    } else {
                        // Page visible again - recreate everything and restore state
                        console.log('👁️ Page visible again - recreating canvas and restoring state');
                        
                        // Recreate spectrogram selection canvas
                        setupSpectrogramSelection();
                        
                        // Redraw all feature boxes on fresh canvas
                        redrawAllCanvasFeatureBoxes();
                        
                        // Restart playhead if playing when tab becomes visible again
                        if (State.playbackState === PlaybackState.PLAYING) {
                            startPlaybackIndicator();
                        }
                    }
                };
                if (window._solarAudioCleanupHandlers.visibilitychange) {
                    document.removeEventListener('visibilitychange', window._solarAudioCleanupHandlers.visibilitychange);
                }
                document.addEventListener('visibilitychange', visibilityChangeHandler);
                window._solarAudioCleanupHandlers.visibilitychange = visibilityChangeHandler;
        });
    });
    } // End if (!window._solarAudioCleanupHandlers)
    
    console.groupEnd(); // End Event Listeners
} // End initializeMainApp

// Call initialization when DOM is ready
if (document.readyState === 'loading') {
    // DOM is still loading, wait for DOMContentLoaded
    console.log('⏳ Waiting for DOMContentLoaded...');
    document.addEventListener('DOMContentLoaded', () => {
        console.log('🔵 DOMContentLoaded FIRED - calling initializeMainApp');
        initializeMainApp();
    });
} else {
    // DOM is already loaded (interactive or complete), initialize immediately
    // console.log('✅ DOM already loaded, initializing immediately');
    initializeMainApp();
}

console.log('🟢 LINE 2545 - END OF MODULE - All code parsed successfully!');
