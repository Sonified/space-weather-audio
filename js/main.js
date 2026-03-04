/**
 * main.js
 * Main orchestration: initialization, startStreaming, event handlers
 */


import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { togglePlayPause, toggleLoop, changePlaybackSpeed, changeVolume, resetSpeedTo1, resetVolumeTo1, updatePlaybackSpeed, downloadAudio, cancelAllRAFLoops, setResizeRAFRef, switchStretchAlgorithm, primeStretchProcessors } from './audio-player.js';
import { initWaveformWorker, setupWaveformInteraction, drawWaveform, drawWaveformFromMinMax, drawWaveformWithSelection, changeWaveformFilter, updatePlaybackIndicator, startPlaybackIndicator, clearWaveformRenderer } from './minimap-window-renderer.js';
import { changeFrequencyScale, loadFrequencyScale, changeColormap, loadColormap, changeFftSize, loadFftSize, startVisualization, setupSpectrogramSelection, redrawAllCanvasFeatureBoxes, clearAllCanvasFeatureBoxes } from './spectrogram-renderer.js';
import { clearCompleteSpectrogram, updateSpectrogramViewport, updateSpectrogramViewportFromZoom, setTileShaderMode, resizeRendererToDisplaySize, setLevelTransitionMode, setCrossfadePower, setCatmullSettings, setWaveformPanMode } from './main-window-renderer.js';
import { setPyramidReduceMode, rebuildUpperLevels } from './spectrogram-pyramid.js';
import { loadSavedSpacecraft, saveDateTime, updateStationList, updateDatasetOptions, enableFetchButton, purgeCloudflareCache, openParticipantModal, closeParticipantModal, submitParticipantSetup, openWelcomeModal, closeWelcomeModal, changeBaseSampleRate, handleWaveformFilterChange, resetWaveformFilterToDefault, setupModalEventListeners, openParticipantInfoModal } from './ui-controls.js';
import { getParticipantIdFromURL, storeParticipantId, getParticipantId } from './participant-id.js';
import { initAdminMode, isAdminMode, toggleAdminMode } from './admin-mode.js';
import { initializeModals } from './modal-templates.js';
import { modalManager } from './modal-manager.js';
import { initErrorReporter } from './error-reporter.js';
import { initSilentErrorReporter } from './silent-error-reporter.js';
import { positionAxisCanvas, resizeAxisCanvas, drawFrequencyAxis, initializeAxisPlaybackRate, setMinFreqMultiplier, getMinFreqMultiplier } from './spectrogram-axis-renderer.js';
import { positionWaveformAxisCanvas, resizeWaveformAxisCanvas, drawWaveformAxis } from './waveform-axis-renderer.js';
import { positionWaveformXAxisCanvas, resizeWaveformXAxisCanvas, drawWaveformXAxis, positionWaveformDateCanvas, resizeWaveformDateCanvas, drawWaveformDate, initializeMaxCanvasWidth } from './waveform-x-axis-renderer.js';
import { positionWaveformButtonsCanvas, resizeWaveformButtonsCanvas, drawRegionButtons } from './waveform-buttons-renderer.js';
import { drawSpectrogramXAxis, positionSpectrogramXAxisCanvas, resizeSpectrogramXAxisCanvas } from './spectrogram-x-axis-renderer.js';
import { initRegionTracker, toggleRegion, toggleRegionPlay, addFeature, updateFeature, deleteRegion, startFrequencySelection, createTestRegion, setSelectionFromActiveRegionIfExists, getActivePlayingRegionIndex, clearActivePlayingRegion, switchSpacecraftRegions, updateCompleteButtonState, updateCmpltButtonState, showAddRegionButton } from './region-tracker.js';
import { updateAllFeatureBoxPositions } from './spectrogram-feature-boxes.js';
import { zoomState } from './zoom-state.js';
import { initKeyboardShortcuts } from './keyboard-shortcuts.js';
import { initDataViewer, fetchUsers } from './data-viewer.js';
import { setStatusText } from './tutorial-effects.js';
import { drawDayMarkers, clearDayMarkers } from './day-markers.js';
import { initScrollZoom } from './scroll-zoom.js';
import {
    CURRENT_MODE,
    AppMode,
    isPersonalMode,
    isDevMode,
    isStudyMode,
    isEmicStudyMode,
    isLocalEnvironment,
    initializeMasterMode
} from './master-modes.js';
import { initShareModal, openShareModal, checkAndLoadSharedSession, applySharedSession, updateShareButtonState } from './share-modal.js';
import { log, logGroup, logGroupEnd, pm } from './logger.js';
import { upgradeAllSelects } from './custom-select.js';
import { injectSettingsDrawer, injectGearPopovers } from './settings-drawer.js';
import { checkAppVersion } from './version-check.js';
import { createWAVBlob } from './wav-recording.js';
import { setupLifecycleHandlers } from './lifecycle-cleanup.js';
import { loadRecentSearches, restoreRecentSearch, saveRecentSearch } from './recent-searches.js';

// console.groupCollapsed('📦 [MODULE] Loading');
// console.log('✅ ALL IMPORTS COMPLETE');

// ===== DEBUG FLAGS =====
const DEBUG_LOOP_FADES = true; // Enable loop fade logging

// ===== FIRST FETCH TRACKING =====
let hasPerformedFirstFetch = false; // Track if first fetch has been performed

if (window.pm?.init) console.log('✅ CONSTANTS DEFINED');
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
        if (window.pm?.audio) console.log('🧹 Clearing old worklet message handler before creating new worklet...');
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
        if (window.pm?.audio) console.log('🧹 Disconnecting old analyser node...');
        State.analyserNode.disconnect();
        State.setAnalyserNode(null);
    }
    
    if (!State.audioContext) {
        // Guard against double-entry: if modules are already loading, wait for that
        if (window._audioWorkletLoading) {
            await window._audioWorkletLoading;
        } else {
            const ctx = new AudioContext({
                latencyHint: 'playback'  // 30ms buffer for stable playback (prevents dropouts)
            });
            window._audioWorkletLoading = (async () => {
                await ctx.audioWorklet.addModule('workers/audio-worklet.js');
                // Load stretch processor worklets for sub-1x speed time-stretching
                await ctx.audioWorklet.addModule('workers/resample-stretch-processor.js');
                await ctx.audioWorklet.addModule('workers/paul-stretch-processor.js');
                await ctx.audioWorklet.addModule('workers/granular-stretch-processor.js');
                await ctx.audioWorklet.addModule('workers/wavelet-stretch-processor.js');
            })();
            await window._audioWorkletLoading;
            window._audioWorkletLoading = null;
            // Set audioContext only AFTER modules are loaded — prevents race where
            // a second call sees the context, skips addModule, and fails
            State.setAudioContext(ctx);
        }

        if (!isStudyMode()) {
            console.groupCollapsed('🎵 [AUDIO] Audio Context Setup');
            console.log(`🎵 [${Math.round(performance.now() - window.streamingStartTime)}ms] Created new AudioContext (sampleRate: ${State.audioContext.sampleRate} Hz, latency: playback)`);
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
            if (State.audioContext) State.setLastWorkletUpdateTime(State.audioContext.currentTime);
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
            if (!safeIsStudyMode()) {
                console.log('🔄 Reset zoom state for new data');
            }
        }
        
        // Reset waveform click tracking when loading new data
        State.setWaveformHasBeenClicked(false);
        const waveformCanvas = document.getElementById('waveform');
        if (waveformCanvas) {
            waveformCanvas.classList.remove('pulse');
        }
        
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
            // Store so the fetcher can kill this animation once chunk downloads begin
            State.setLoadingInterval(loadingInterval);
        }

        // Fetch and load data from selected source
        try {
        if (dataSource === 'cloudflare') {
            const { fetchAndLoadCloudflareData } = await import('./goes-cloudflare-fetcher.js');
            await fetchAndLoadCloudflareData(spacecraft, dataset, startTimeISO, endTimeISO);
        } else {
            const { fetchAndLoadCDAWebData } = await import('./data-fetcher.js');
            await fetchAndLoadCDAWebData(spacecraft, dataset, startTimeISO, endTimeISO);
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
        if (statusDiv) {
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

        if (window.pm?.init) console.log(`🎉 ${logTime()} Complete!`);
        if (window.pm?.gpu) {
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

    // Enable all features immediately
    const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
    enableAllTutorialRestrictedFeatures();

    console.log('✅ Personal mode ready - all features enabled');
}

/**
 * DEV MODE: Direct access for development/testing
 */
async function initializeDevMode() {
    console.log('🔧 DEV MODE: Direct access');

    // Enable all features immediately
    const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
    enableAllTutorialRestrictedFeatures();

    console.log('✅ Dev mode ready');
}

function initializeAdvancedControls() {
    // Inject the settings drawer + hamburger button into the DOM
    injectSettingsDrawer();
    // Inject gear popover content into shell divs
    injectGearPopovers();

    // Persist all navigation panel controls to localStorage
    const navControls = [
        { id: 'viewingMode', key: 'emic_viewing_mode', type: 'select' },
        { id: 'navBarClick', key: 'emic_navbar_click', type: 'select' },
        { id: 'mainWindowClick', key: 'emic_main_click_mode', type: 'select' },
        { id: 'mainWindowRelease', key: 'emic_main_release', type: 'select' },
        { id: 'mainWindowDrag', key: 'emic_main_drag', type: 'select' },
        { id: 'navBarScroll', key: 'emic_navbar_scroll', type: 'select' },
        { id: 'navBarVSens', key: 'emic_navbar_vsens', type: 'select' },
        { id: 'navBarHScroll', key: 'emic_navbar_hscroll', type: 'select' },
        { id: 'navBarHSens', key: 'emic_navbar_hsens', type: 'select' },
        { id: 'mainWindowScroll', key: 'emic_main_scroll', type: 'select' },
        { id: 'mainWindowVSens', key: 'emic_main_vsens', type: 'select' },
        { id: 'mainWindowHScroll', key: 'emic_main_hscroll', type: 'select' },
        { id: 'mainWindowHSens', key: 'emic_main_hsens', type: 'select' },
        { id: 'miniMapView', key: 'emic_minimap_view', type: 'select' },
        { id: 'mainWindowView', key: 'emic_main_view', type: 'select' },
        { id: 'navBarMarkers', key: 'emic_navbar_markers', type: 'select' },
        { id: 'navBarFeatureBoxes', key: 'emic_navbar_feature_boxes', type: 'select' },
        { id: 'mainWindowMarkers', key: 'emic_main_markers', type: 'select' },
        { id: 'mainWindowXAxis', key: 'emic_main_xaxis', type: 'select' },
        { id: 'mainWindowNumbers', key: 'emic_main_numbers', type: 'select' },
        { id: 'mainWindowNumbersLoc', key: 'emic_main_numbers_loc', type: 'select' },
        { id: 'mainWindowNumbersWeight', key: 'emic_main_numbers_weight', type: 'select' },
        { id: 'mainWindowNumbersSize', key: 'emic_main_numbers_size', type: 'select' },
        { id: 'mainWindowNumbersShadow', key: 'emic_main_numbers_shadow', type: 'select' },
        { id: 'featureBoxesVisible', key: 'emic_feature_boxes_visible', type: 'checkbox' },
        { id: 'skipLoginWelcome', key: 'emic_skip_login_welcome', type: 'checkbox' },
        { id: 'displayOnLoad', key: 'emic_display_on_load', type: 'select' },
        { id: 'initialHours', key: 'emic_initial_hours', type: 'select' },
        { id: 'arrowZoomStep', key: 'emic_arrow_zoom_step', type: 'select' },
        { id: 'arrowPanStep', key: 'emic_arrow_pan_step', type: 'select' },
        { id: 'mainWindowBoxFilter', key: 'emic_main_box_filter', type: 'select' },
        { id: 'mainWindowZoomOut', key: 'emic_zoom_out_mode', type: 'select' },
        { id: 'levelTransition', key: 'emic_level_transition', type: 'select' },
        { id: 'crossfadePower', key: 'emic_crossfade_power', type: 'range' },
        { id: 'catmullMode', key: 'emic_catmull_mode', type: 'select' },
        { id: 'catmullThreshold', key: 'emic_catmull_threshold', type: 'select' },
        { id: 'catmullCore', key: 'emic_catmull_core', type: 'range' },
        { id: 'catmullFeather', key: 'emic_catmull_feather', type: 'range' },
        { id: 'waveformPanMode', key: 'emic_waveform_pan_mode', type: 'select' },
        { id: 'renderOrder', key: 'emic_render_order', type: 'select' },
        { id: 'audioQuality', key: 'emic_audio_quality', type: 'select' },
        { id: 'tileChunkSize', key: 'emic_tile_chunk_size', type: 'select' },
        { id: 'featurePlaybackMode', key: 'emic_feature_playback_mode', type: 'select' },
        { id: 'dataSource', key: 'emic_data_source', type: 'select' },
        { id: 'drawerBypassCache', key: 'emic_bypass_cache', type: 'checkbox' },
        { id: 'silentDownload', key: 'emic_silent_download', type: 'checkbox' },
        { id: 'autoDownload', key: 'emic_auto_download', type: 'checkbox' },
        { id: 'autoPlay', key: 'emic_auto_play', type: 'checkbox' },
        { id: 'dataRendering', key: 'emic_data_rendering', type: 'select' },
        { id: 'tickFadeInTime', key: 'emic_tick_fade_in', type: 'range' },
        { id: 'tickFadeOutTime', key: 'emic_tick_fade_out', type: 'range' },
        { id: 'tickFadeInCurve', key: 'emic_tick_fade_in_curve', type: 'select' },
        { id: 'tickFadeOutCurve', key: 'emic_tick_fade_out_curve', type: 'select' },
        { id: 'tickEdgeFadeMode', key: 'emic_tick_edge_fade_mode', type: 'select' },
        { id: 'tickEdgeFadeCurve', key: 'emic_tick_edge_fade_curve', type: 'select' },
        { id: 'tickEdgeSpatialWidth', key: 'emic_tick_edge_spatial_width', type: 'range' },
        { id: 'tickEdgeTimeIn', key: 'emic_tick_edge_time_in', type: 'range' },
        { id: 'tickEdgeTimeOut', key: 'emic_tick_edge_time_out', type: 'range' },
        { id: 'printInit', key: 'emic_print_init', type: 'checkbox' },
        { id: 'printGPU', key: 'emic_print_gpu', type: 'checkbox' },
        { id: 'printMemory', key: 'emic_print_memory', type: 'checkbox' },
        { id: 'printAudio', key: 'emic_print_audio', type: 'checkbox' },
        { id: 'printStudy', key: 'emic_print_study', type: 'checkbox' },
        { id: 'printFeatures', key: 'emic_print_features', type: 'checkbox' },
        { id: 'printData', key: 'emic_print_data', type: 'checkbox' },
        { id: 'printInteraction', key: 'emic_print_interaction', type: 'checkbox' },
    ];
    // Page-specific localStorage: emic_study keeps 'emic_*' keys, index.html uses 'main_*'
    const settingsPrefix = isStudyMode() ? 'emic_' : 'main_';
    for (const ctrl of navControls) {
        const el = document.getElementById(ctrl.id);
        if (!el) continue;
        const storageKey = ctrl.key.replace(/^emic_/, settingsPrefix);
        const saved = localStorage.getItem(storageKey);
        if (ctrl.type === 'checkbox') {
            if (saved !== null) el.checked = saved === 'true';
            el.addEventListener('change', () => localStorage.setItem(storageKey, el.checked));
        } else {
            if (saved !== null) {
                el.value = saved;
                if (ctrl.type === 'range') {
                    // Range inputs normalize values (e.g. "0.50" → "0.5"), so compare as numbers
                    if (Math.abs(parseFloat(el.value) - parseFloat(saved)) > 1e-9) {
                        localStorage.removeItem(storageKey);
                    }
                } else if (el.value !== saved) {
                    localStorage.removeItem(storageKey);
                    el.selectedIndex = 0;
                }
            }
            el.addEventListener('change', () => {
                localStorage.setItem(storageKey, el.value);
                el.blur();
            });
            if (ctrl.type === 'range') {
                el.addEventListener('input', () => localStorage.setItem(storageKey, el.value));
            }
        }
    }

    // Auto play defaults: ON for index.html, OFF for EMIC (unless user saved a preference)
    const autoPlayEl = document.getElementById('autoPlay');
    if (autoPlayEl) {
        const apKey = (isStudyMode() ? 'emic_' : 'main_') + 'auto_play';
        if (localStorage.getItem(apKey) === null) {
            autoPlayEl.checked = !isEmicStudyMode();
        }
    }

    // Sync Prints checkboxes → pm flags (restore from localStorage + live toggle)
    const printMap = { printInit: 'init', printGPU: 'gpu', printMemory: 'memory', printAudio: 'audio', printStudy: 'study_flow', printFeatures: 'features', printData: 'data', printInteraction: 'interaction' };
    for (const [id, pmKey] of Object.entries(printMap)) {
        const el = document.getElementById(id);
        if (!el) continue;
        pm[pmKey] = el.checked;
        if (pmKey === 'data') pm.cache = el.checked; // Data checkbox also controls cache logs
        el.addEventListener('change', () => {
            pm[pmKey] = el.checked;
            // Data checkbox also controls cache logs
            if (pmKey === 'data') pm.cache = el.checked;
            // Forward audio debug flag to worklet/stretch threads
            if (pmKey === 'audio') {
                const msg = { type: 'set-debug-audio', enabled: el.checked };
                State.workletNode?.port.postMessage(msg);
                State.stretchNode?.port.postMessage(msg);
                if (State.stretchNodes) {
                    for (const node of Object.values(State.stretchNodes)) {
                        node?.port.postMessage(msg);
                    }
                }
            }
        });
    }

    // Upgrade all native <select> elements to custom styled dropdowns
    const cselInstances = upgradeAllSelects();

    // Auto-download: if enabled, click Fetch Data after a brief init delay
    if (document.getElementById('autoDownload')?.checked) {
        setTimeout(() => {
            const fetchBtn = document.getElementById('startBtn');
            if (fetchBtn && !fetchBtn.disabled) {
                if (window.pm?.init) console.log('🚀 Auto-download enabled, triggering data fetch...');
                fetchBtn.click();
            }
        }, 500);
    }

    // Page-specific defaults (applied only when no saved value exists)
    if (!isStudyMode()) {
        const miniMapEl = document.getElementById('miniMapView');
        if (miniMapEl && !localStorage.getItem('main_minimap_view')) miniMapEl.value = 'both';
    }

    // Toggle feature boxes visibility immediately on change
    const fbVisCheckbox = document.getElementById('featureBoxesVisible');
    if (fbVisCheckbox) {
        fbVisCheckbox.addEventListener('change', () => {
            redrawAllCanvasFeatureBoxes();
            drawWaveformFromMinMax();
        });
    }

    // Sync mainWindowMode with viewingMode (both share the same localStorage key)
    const _mwMode = document.getElementById('mainWindowMode');
    const _vmMode = document.getElementById('viewingMode');
    if (_mwMode && _vmMode) {
        // On load, sync mainWindowMode to match viewingMode's restored value
        _mwMode.value = _vmMode.value;
        // On change of either, persist and sync
        _mwMode.addEventListener('change', () => {
            localStorage.setItem('emic_viewing_mode', _mwMode.value);
        });
    }

    // Wire up sensitivity selects: disable when paired scroll setting is off
    function updateSensPaired() {
        document.querySelectorAll('select[data-paired]').forEach(sensEl => {
            const pairedId = sensEl.dataset.paired;
            const pairedEl = document.getElementById(pairedId);
            if (!pairedEl) return;
            const isOff = pairedEl.value === 'none';
            sensEl.disabled = isOff;
            sensEl.style.opacity = isOff ? '0.4' : '1';
        });
    }
    updateSensPaired();
    ['navBarScroll', 'navBarHScroll', 'mainWindowScroll', 'mainWindowHScroll'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', updateSensPaired);
    });

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
        applyXAxisVisibility();
        mainWindowXAxisEl.addEventListener('change', applyXAxisVisibility);
    }

    // --- Settings drawer (hamburger menu, push layout) ---
    const drawerEl = document.getElementById('settingsDrawer');
    const hamburgerBtn = document.getElementById('hamburgerBtn');
    const drawerCloseBtn = document.getElementById('drawerClose');

    function openSettingsDrawer() {
        if (drawerEl) drawerEl.classList.add('open');
        document.body.classList.add('drawer-open');
        setTimeout(() => window.dispatchEvent(new Event('resize')), 260);
    }
    function closeSettingsDrawer() {
        if (drawerEl) drawerEl.classList.remove('open');
        document.body.classList.remove('drawer-open');
        setTimeout(() => window.dispatchEvent(new Event('resize')), 260);
    }

    // --- Advanced mode toggle: controls visibility of gear icons ---
    const advancedCheckbox = document.getElementById('advancedMode');
    const displayModeSelect = document.getElementById('displayMode');

    // Display mode: 'participant' | 'standard' | 'advanced' | 'dataviewer'
    function applyDisplayMode(mode) {
        const isAdvanced = mode === 'advanced';
        const isParticipant = mode === 'participant';
        const isDataViewer = mode === 'dataviewer';

        // Sync data-display-mode attribute (used by early CSS to prevent flash)
        document.documentElement.setAttribute('data-display-mode', mode);

        // Sync hidden checkbox for any code that reads advancedMode
        if (advancedCheckbox) advancedCheckbox.checked = isAdvanced;

        // Gears, hamburger, questionnaires: advanced only
        const gearContainers = document.querySelectorAll('.panel-gear');
        gearContainers.forEach(g => g.style.display = isAdvanced ? 'block' : 'none');
        const hBtn = document.getElementById('hamburgerBtn');
        if (hBtn) hBtn.style.display = isAdvanced ? 'block' : 'none';
        const questionnairesPanel = document.getElementById('questionnairesPanel');
        if (questionnairesPanel) questionnairesPanel.style.display = isAdvanced ? '' : 'none';
        if (!isAdvanced) closeSettingsDrawer();

        // Component selector + de-trend: hidden in participant mode
        const compContainer = document.getElementById('componentSelectorContainer');
        if (compContainer) compContainer.style.display = isParticipant ? 'none' : '';
        const detrendContainer = document.getElementById('detrendContainer');
        if (detrendContainer) detrendContainer.style.display = isParticipant ? 'none' : '';

        // Bottom bar viz controls (everything right of Display dropdown): hidden in participant
        // Use visibility instead of display so the Display dropdown doesn't shift position
        const vizControls = document.querySelector('.viz-controls');
        if (vizControls) {
            vizControls.style.visibility = isParticipant ? 'hidden' : 'visible';
            vizControls.style.pointerEvents = isParticipant ? 'none' : '';
        }

        // Stretch + Speed button groups: advanced only (hidden in participant + standard)
        const stretchGroup = document.getElementById('stretchGroup');
        if (stretchGroup) stretchGroup.style.display = isAdvanced ? '' : 'none';
        const speedGroup = document.getElementById('speedGroup');
        if (speedGroup) speedGroup.style.display = isParticipant ? 'none' : '';

        // Participant ID display (top right): hidden in participant mode
        const pidDisplay = document.getElementById('participantIdDisplay');
        if (pidDisplay) pidDisplay.style.display = isParticipant ? 'none' : '';

        // EMIC controls panel (Fetch Data, Component, De-trend): hidden in participant mode
        const emicControlsPanel = document.getElementById('emicControlsPanel');
        if (emicControlsPanel) emicControlsPanel.style.display = isParticipant ? 'none' : '';

        // Move #status between controls panel and playback bar based on mode
        const statusEl = document.getElementById('status');
        if (statusEl) {
            const anchor = isParticipant
                ? document.getElementById('statusAnchorPlayback')
                : document.getElementById('statusAnchorControls');
            if (anchor && statusEl.parentElement !== anchor) {
                anchor.appendChild(statusEl);
            }
        }

        // Data Viewer panel: only visible in dataviewer mode
        const dvPanel = document.getElementById('dataViewerPanel');
        if (dvPanel) {
            dvPanel.style.display = isDataViewer ? 'block' : 'none';
            if (isDataViewer) {
                fetchUsers();
            }
        }
    }

    // Legacy compat: applyAdvancedMode still works for any external callers
    function applyAdvancedMode(enabled) {
        applyDisplayMode(enabled ? 'advanced' : 'standard');
    }

    if (displayModeSelect) {
        // Add Data Viewer option on localhost only
        if (isLocalEnvironment()) {
            const dvOption = document.createElement('option');
            dvOption.value = 'dataviewer';
            dvOption.textContent = 'Data Viewer';
            displayModeSelect.appendChild(dvOption);
            if (cselInstances.has('displayMode')) cselInstances.get('displayMode').refresh();
            initDataViewer();
        }

        // Restore saved preference, default to 'standard' for new users
        const savedMode = localStorage.getItem('emic_display_mode');
        const validModes = ['participant', 'standard', 'advanced'];
        if (isLocalEnvironment()) validModes.push('dataviewer');
        if (savedMode && validModes.includes(savedMode)) {
            displayModeSelect.value = savedMode;
        }
        applyDisplayMode(displayModeSelect.value);

        displayModeSelect.addEventListener('change', () => {
            const mode = displayModeSelect.value;
            localStorage.setItem('emic_display_mode', mode);
            applyDisplayMode(mode);
            updateRegionsPanelVisibility();
            // Reposition overlay + redraw feature boxes after layout settles
            requestAnimationFrame(() => redrawAllCanvasFeatureBoxes());
        });
    } else if (advancedCheckbox) {
        // Fallback for pages without displayMode dropdown (e.g. index.html)
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

    // --- Lock page scroll checkbox ---
    const lockScrollCb = document.getElementById('lockPageScroll');
    if (lockScrollCb) {
        lockScrollCb.addEventListener('change', () => {
            if (lockScrollCb.checked) {
                const scrollY = window.pageYOffset || document.documentElement.scrollTop;
                document.documentElement.style.overflow = 'hidden';
                document.body.style.overflow = 'hidden';
                document.body.style.position = 'fixed';
                document.body.style.top = `-${scrollY}px`;
                document.body.style.width = '100%';
            } else {
                const top = Math.abs(parseInt(document.body.style.top || '0', 10));
                document.documentElement.style.overflow = '';
                document.body.style.overflow = '';
                document.body.style.position = '';
                document.body.style.top = '';
                document.body.style.width = '';
                window.scrollTo(0, top);
            }
        });
    }

    // --- Panel height inputs in settings drawer ---
    const heightMinimapInput = document.getElementById('heightMinimap');
    const heightSpectrogramInput = document.getElementById('heightSpectrogram');
    const wfEl_ = document.getElementById('waveform');
    const specEl_ = document.getElementById('spectrogram');
    if (heightMinimapInput && wfEl_) heightMinimapInput.value = wfEl_.offsetHeight;
    if (heightSpectrogramInput && specEl_) heightSpectrogramInput.value = specEl_.offsetHeight;

    function applyPanelHeight(input, canvasId, axisId, buttonsId) {
        const h = parseInt(input.value);
        const min = parseInt(input.dataset.min || 0);
        const max = parseInt(input.dataset.max || 9999);
        if (isNaN(h) || h < min || h > max) return;
        const canvas = document.getElementById(canvasId);
        if (!canvas) return;
        canvas.style.height = h + 'px';
        canvas.height = h;
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

    // Min UI width
    const MIN_UI_WIDTH_DEFAULT = 1200;
    const minUIWidthInput = document.getElementById('minUIWidth');
    const containerEl = document.querySelector('.container');
    if (minUIWidthInput && containerEl) {
        const saved = localStorage.getItem('minUIWidth');
        const val = saved ? parseInt(saved) : MIN_UI_WIDTH_DEFAULT;
        minUIWidthInput.value = val;
        if (val > 0) containerEl.style.minWidth = val + 'px';
        minUIWidthInput.addEventListener('change', () => {
            const v = parseInt(minUIWidthInput.value);
            if (isNaN(v) || v < 0) return;
            containerEl.style.minWidth = v > 0 ? v + 'px' : '';
            localStorage.setItem('minUIWidth', v);
        });
    }

    // --- Annotation width spinner ---
    const annotWidthInput = document.getElementById('annotationWidth');
    if (annotWidthInput) {
        const saved = localStorage.getItem('annotationWidth');
        annotWidthInput.value = saved ? parseInt(saved) : 325;
        annotWidthInput.addEventListener('change', () => {
            const v = parseInt(annotWidthInput.value);
            if (isNaN(v) || v < 100) return;
            localStorage.setItem('annotationWidth', v);
        });
    }

    // --- Annotation font size spinner ---
    const annotFontInput = document.getElementById('annotationFontSize');
    if (annotFontInput) {
        const saved = localStorage.getItem('annotationFontSize');
        annotFontInput.value = saved ? parseInt(saved) : 13;
        annotFontInput.addEventListener('change', () => {
            const v = parseInt(annotFontInput.value);
            if (isNaN(v) || v < 8) return;
            localStorage.setItem('annotationFontSize', v);
        });
    }

    // --- Custom spinner buttons for number inputs ---
    document.querySelectorAll('.spinner-btn').forEach(btn => {
        const inputId = btn.dataset.for;
        const input = document.getElementById(inputId);
        if (!input) return;
        const step = parseInt(input.dataset.step || 1);
        const min = parseInt(input.dataset.min || 0);
        const max = parseInt(input.dataset.max || 9999);
        const isInc = btn.classList.contains('spinner-inc');
        let holdTimer = null;
        let holdInterval = null;

        function nudge() {
            let val = parseInt(input.value) || 0;
            val = isInc ? Math.min(val + step, max) : Math.max(val - step, min);
            input.value = val;
            input.dispatchEvent(new Event('change'));
        }

        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            nudge();
            holdTimer = setTimeout(() => {
                holdInterval = setInterval(nudge, 100);
            }, 400);
        });
        btn.addEventListener('mouseup', () => { clearTimeout(holdTimer); clearInterval(holdInterval); });
        btn.addEventListener('mouseleave', () => { clearTimeout(holdTimer); clearInterval(holdInterval); });
    });

    // Position gear icons over their respective canvases (top-right corner)
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
            document.querySelectorAll('.gear-popover').forEach(p => {
                p.classList.remove('open');
                p.closest('.panel-gear').style.zIndex = '30';
            });
            if (!wasOpen) {
                popover.classList.add('open');
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
    document.querySelectorAll('.gear-select').forEach(sel => {
        sel.addEventListener('change', () => sel.blur());
    });

    // Wire per-panel day markers dropdowns to redraw
    const navBarMarkersEl = document.getElementById('navBarMarkers');
    const mainWindowMarkersEl = document.getElementById('mainWindowMarkers');
    if (navBarMarkersEl) navBarMarkersEl.addEventListener('change', () => drawDayMarkers());
    const navBarFeatBoxesEl = document.getElementById('navBarFeatureBoxes');
    if (navBarFeatBoxesEl) navBarFeatBoxesEl.addEventListener('change', () => drawWaveformFromMinMax());
    if (mainWindowMarkersEl) mainWindowMarkersEl.addEventListener('change', () => drawDayMarkers());
    if ((navBarMarkersEl && navBarMarkersEl.value !== 'none') ||
        (mainWindowMarkersEl && mainWindowMarkersEl.value !== 'none')) {
        drawDayMarkers();
    }

    // Wire Numbers dropdowns to redraw feature boxes
    const mainWindowNumbersEl = document.getElementById('mainWindowNumbers');
    const mainWindowNumbersLocEl = document.getElementById('mainWindowNumbersLoc');
    if (mainWindowNumbersEl) mainWindowNumbersEl.addEventListener('change', () => redrawAllCanvasFeatureBoxes());
    if (mainWindowNumbersLocEl) mainWindowNumbersLocEl.addEventListener('change', () => redrawAllCanvasFeatureBoxes());
    const mainWindowNumbersWeightEl = document.getElementById('mainWindowNumbersWeight');
    const mainWindowNumbersShadowEl = document.getElementById('mainWindowNumbersShadow');
    const mainWindowNumbersSizeEl = document.getElementById('mainWindowNumbersSize');
    if (mainWindowNumbersWeightEl) mainWindowNumbersWeightEl.addEventListener('change', () => redrawAllCanvasFeatureBoxes());
    if (mainWindowNumbersShadowEl) mainWindowNumbersShadowEl.addEventListener('change', () => redrawAllCanvasFeatureBoxes());
    if (mainWindowNumbersSizeEl) mainWindowNumbersSizeEl.addEventListener('change', () => redrawAllCanvasFeatureBoxes());

    // Wire box filter shader mode dropdown + apply persisted value
    const boxFilterEl = document.getElementById('mainWindowBoxFilter');
    if (boxFilterEl) {
        boxFilterEl.addEventListener('change', () => setTileShaderMode(boxFilterEl.value));
        setTileShaderMode(boxFilterEl.value);
    }

    // Wire pyramid reduce mode dropdown (average vs peak zoom-out)
    const zoomOutEl = document.getElementById('mainWindowZoomOut');
    if (zoomOutEl) {
        zoomOutEl.addEventListener('change', () => {
            setPyramidReduceMode(zoomOutEl.value);
            rebuildUpperLevels();
            updateSpectrogramViewportFromZoom();
            zoomOutEl.blur();
        });
        setPyramidReduceMode(zoomOutEl.value);
    }

    // Wire tile chunk size (adaptive vs fixed duration)
    const tileChunkEl = document.getElementById('tileChunkSize');
    if (tileChunkEl) {
        tileChunkEl.addEventListener('change', () => {
            tileChunkEl.blur();
            // Re-render spectrogram with new tile duration (old stays visible during compute)
            import('./main-window-renderer.js').then(module => {
                if (module.isCompleteSpectrogramRendered()) {
                    module.renderCompleteSpectrogram(false, true);
                }
            });
        });
    }

    // Wire level transition mode (stepped vs crossfade)
    const levelTransEl = document.getElementById('levelTransition');
    const powerRow = document.getElementById('crossfadePowerRow');
    const powerSlider = document.getElementById('crossfadePower');
    const powerLabel = document.getElementById('crossfadePowerLabel');

    function updateCrossfadeUI() {
        if (powerRow) powerRow.style.display = levelTransEl?.value === 'crossfade' ? 'flex' : 'none';
    }

    if (levelTransEl) {
        levelTransEl.addEventListener('change', () => {
            setLevelTransitionMode(levelTransEl.value);
            updateCrossfadeUI();
            levelTransEl.blur();
        });
        setLevelTransitionMode(levelTransEl.value);
        updateCrossfadeUI();
    }

    if (powerSlider) {
        powerSlider.addEventListener('input', () => {
            setCrossfadePower(parseFloat(powerSlider.value));
            if (powerLabel) powerLabel.textContent = parseFloat(powerSlider.value).toFixed(1);
        });
        setCrossfadePower(parseFloat(powerSlider.value));
        if (powerLabel) powerLabel.textContent = parseFloat(powerSlider.value).toFixed(1);
    }

    // Wire Catmull-Rom smooth curve controls
    const catmullModeEl = document.getElementById('catmullMode');
    const catmullSubControls = document.getElementById('catmullSubControls');
    const catmullThresholdEl = document.getElementById('catmullThreshold');
    const catmullCoreEl = document.getElementById('catmullCore');
    const catmullCoreLabel = document.getElementById('catmullCoreLabel');
    const catmullFeatherEl = document.getElementById('catmullFeather');
    const catmullFeatherLabel = document.getElementById('catmullFeatherLabel');

    function applyCatmullSettings() {
        const prefix = isStudyMode() ? 'emic_' : 'main_';
        const enabled = (localStorage.getItem(prefix + 'catmull_mode') || catmullModeEl?.value || 'default') === 'smooth';
        const threshold = localStorage.getItem(prefix + 'catmull_threshold') || catmullThresholdEl?.value || 128;
        const core = localStorage.getItem(prefix + 'catmull_core') || catmullCoreEl?.value || 1.0;
        const feather = localStorage.getItem(prefix + 'catmull_feather') || catmullFeatherEl?.value || 1.0;
        setCatmullSettings({ enabled, threshold, core, feather });
    }

    function updateCatmullSubControls() {
        if (catmullSubControls) {
            const prefix = isStudyMode() ? 'emic_' : 'main_';
            const mode = localStorage.getItem(prefix + 'catmull_mode') || catmullModeEl?.value || 'default';
            catmullSubControls.style.display = mode === 'smooth' ? 'block' : 'none';
        }
    }

    if (catmullModeEl) {
        catmullModeEl.addEventListener('change', () => {
            updateCatmullSubControls();
            applyCatmullSettings();
            catmullModeEl.blur();
        });
        updateCatmullSubControls();
        applyCatmullSettings();
    }
    if (catmullThresholdEl) {
        catmullThresholdEl.addEventListener('change', () => { applyCatmullSettings(); catmullThresholdEl.blur(); });
    }
    if (catmullCoreEl) {
        catmullCoreEl.addEventListener('input', () => {
            if (catmullCoreLabel) catmullCoreLabel.textContent = parseFloat(catmullCoreEl.value).toFixed(2);
            applyCatmullSettings();
        });
        if (catmullCoreLabel) catmullCoreLabel.textContent = parseFloat(catmullCoreEl.value).toFixed(2);
    }
    if (catmullFeatherEl) {
        catmullFeatherEl.addEventListener('input', () => {
            if (catmullFeatherLabel) catmullFeatherLabel.textContent = parseFloat(catmullFeatherEl.value).toFixed(1);
            applyCatmullSettings();
        });
        if (catmullFeatherLabel) catmullFeatherLabel.textContent = parseFloat(catmullFeatherEl.value).toFixed(1);
    }

    // Wire waveform pan mode
    const waveformPanModeEl = document.getElementById('waveformPanMode');
    if (waveformPanModeEl) {
        waveformPanModeEl.addEventListener('change', () => {
            setWaveformPanMode(waveformPanModeEl.value);
            waveformPanModeEl.blur();
        });
        // Apply saved setting on load
        const prefix = isStudyMode() ? 'emic_' : 'main_';
        const saved = localStorage.getItem(prefix + 'waveform_pan_mode');
        if (saved) setWaveformPanMode(saved);
    }

    // Wire Display on Load: show/hide hours row
    const displayOnLoadEl = document.getElementById('displayOnLoad');
    const initialHoursRow = document.getElementById('initialHoursRow');
    function updateInitialHoursVisibility() {
        if (initialHoursRow) initialHoursRow.style.display = displayOnLoadEl?.value === 'beginning' ? 'flex' : 'none';
    }
    if (displayOnLoadEl) {
        displayOnLoadEl.addEventListener('change', () => {
            updateInitialHoursVisibility();
            displayOnLoadEl.blur();
        });
        updateInitialHoursVisibility();
    }

    // Tick fade slider labels
    for (const { sliderId, labelId, storageKey, suffix } of [
        { sliderId: 'tickFadeInTime', labelId: 'tickFadeInLabel', storageKey: 'emic_tick_fade_in', suffix: 's' },
        { sliderId: 'tickFadeOutTime', labelId: 'tickFadeOutLabel', storageKey: 'emic_tick_fade_out', suffix: 's' },
        { sliderId: 'tickEdgeSpatialWidth', labelId: 'tickEdgeSpatialWidthLabel', storageKey: 'emic_tick_edge_spatial_width', suffix: '' },
        { sliderId: 'tickEdgeTimeIn', labelId: 'tickEdgeTimeInLabel', storageKey: 'emic_tick_edge_time_in', suffix: 's' },
        { sliderId: 'tickEdgeTimeOut', labelId: 'tickEdgeTimeOutLabel', storageKey: 'emic_tick_edge_time_out', suffix: 's' },
    ]) {
        const slider = document.getElementById(sliderId);
        const label = document.getElementById(labelId);
        if (!slider) continue;
        const update = () => { if (label) label.textContent = parseFloat(slider.value).toFixed(2) + suffix; };
        slider.addEventListener('input', () => {
            update();
            localStorage.setItem(storageKey, slider.value);
        });
        update();
    }

    // Show/hide edge fade sub-controls based on mode
    const edgeModeSelect = document.getElementById('tickEdgeFadeMode');
    const spatialControls = document.getElementById('tickEdgeSpatialControls');
    const timeControls = document.getElementById('tickEdgeTimeControls');
    function updateEdgeFadeControls() {
        const mode = edgeModeSelect?.value || 'spatial';
        if (spatialControls) spatialControls.style.display = mode === 'spatial' ? '' : 'none';
        if (timeControls) timeControls.style.display = mode === 'time' ? '' : 'none';
    }
    if (edgeModeSelect) {
        edgeModeSelect.addEventListener('change', updateEdgeFadeControls);
        updateEdgeFadeControls();
    }

    // Toggle regions panel + top bar controls visibility based on viewing mode
    function updateRegionsPanelVisibility() {
        const mode = document.getElementById('viewingMode')?.value;
        const isWindowed = mode === 'static' || mode === 'scroll' || mode === 'pageTurn';
        const panel = document.getElementById('trackedRegionsPanel');
        if (panel) {
            panel.style.display = isWindowed ? 'none' : '';
        }
        const displayMode = document.getElementById('displayMode')?.value || 'standard';
        const advanced = displayMode === 'advanced' || document.getElementById('advancedMode')?.checked;
        const hideControls = isWindowed && !advanced && displayMode === 'participant';
        const comp = document.getElementById('componentSelectorContainer');
        const detrend = document.getElementById('detrendContainer');
        if (comp) comp.style.visibility = hideControls ? 'hidden' : '';
        if (detrend) detrend.style.visibility = hideControls ? 'hidden' : '';
        if (comp?.previousElementSibling) comp.previousElementSibling.style.visibility = hideControls ? 'hidden' : '';
        if (comp?.nextElementSibling && comp.nextElementSibling.id !== 'detrendContainer') {
            comp.nextElementSibling.style.visibility = hideControls ? 'hidden' : '';
        }
        if (detrend?.nextElementSibling && detrend.nextElementSibling.id !== 'status') {
            detrend.nextElementSibling.style.visibility = hideControls ? 'hidden' : '';
        }
    }

    // When switching viewing mode, reset waveform to full view and re-render
    // Both selects (nav bar "viewingMode" and main window "mainWindowMode") stay in sync
    const viewingModeSelect = document.getElementById('viewingMode');
    const mainWindowModeSelect = document.getElementById('mainWindowMode');

    function applyViewingMode(mode, sourceSelect) {
        if (mode === 'static' || mode === 'scroll' || mode === 'pageTurn') {
            zoomState.setViewportToFull();
        }
        // Sync the other select
        if (viewingModeSelect && viewingModeSelect !== sourceSelect) viewingModeSelect.value = mode;
        if (mainWindowModeSelect && mainWindowModeSelect !== sourceSelect) mainWindowModeSelect.value = mode;
        updateRegionsPanelVisibility();
        drawWaveformFromMinMax();
        drawWaveformXAxis();
        drawSpectrogramXAxis();
        drawRegionButtons();
        drawDayMarkers();
        sourceSelect?.blur();
    }

    if (viewingModeSelect) {
        updateRegionsPanelVisibility();
        viewingModeSelect.addEventListener('change', () => {
            applyViewingMode(viewingModeSelect.value, viewingModeSelect);
        });
    }
    if (mainWindowModeSelect) {
        mainWindowModeSelect.addEventListener('change', () => {
            applyViewingMode(mainWindowModeSelect.value, mainWindowModeSelect);
        });
    }
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

    // Enable all features immediately
    const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
    enableAllTutorialRestrictedFeatures();

    // Enable region creation
    const { setRegionCreationEnabled } = await import('./audio-state.js');
    setRegionCreationEnabled(true);

    // Advanced controls already initialized early in initializeMainApp()

    const skipLogin = localStorage.getItem('emic_skip_login_welcome') === 'true';

    if (!skipLogin) {
        // Show participant setup immediately
        openParticipantModal();
    } else {
        // Hide overlay, go straight to app
        const overlay = document.getElementById('permanentOverlay');
        if (overlay) { overlay.style.display = 'none'; overlay.style.opacity = '0'; }

        // Show "click Fetch Data to begin" prompt (same as Solar Portal)
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

    if (window.pm?.study_flow) console.log('🔬 EMIC Study mode initialized (skipLogin:', skipLogin, ')');
}

/**
 * SOLAR PORTAL MODE: Participant setup only, no study workflow
 */
async function initializeSolarPortalMode() {

    // Advanced controls already initialized early in initializeMainApp()

    // Show Advanced checkbox only on localhost
    const advToggle = document.getElementById('advancedToggle');
    if (advToggle) {
        advToggle.style.display = isLocalEnvironment() ? 'flex' : 'none';
    }

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
    
    // Enable all features immediately
    const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
    enableAllTutorialRestrictedFeatures();
    
    // Check if user has a username set - if not, show participant setup
    const { getParticipantId } = await import('./participant-id.js');
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
 * STUDY MODE: Placeholder (volcano study workflow removed)
 */
async function initializeStudyMode() {
    console.log('🎓 STUDY MODE: No volcano workflow in EMIC codebase');

    // Enable all features immediately
    const { enableAllTutorialRestrictedFeatures } = await import('./tutorial-effects.js');
    enableAllTutorialRestrictedFeatures();

    console.log('✅ Study mode ready');
}


/**
 * Route to appropriate workflow based on mode
 */
async function initializeApp() {
    const { CURRENT_MODE, AppMode } = await import('./master-modes.js');
    
    if (!isStudyMode()) {
        if (window.pm?.study_flow) console.groupCollapsed(`🎯 [MODE] ${CURRENT_MODE} Initialization`);
    }
    if (window.pm?.study_flow) console.log(`🚀 Initializing app in ${CURRENT_MODE} mode`);
    
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

// Main initialization function
async function initializeMainApp() {
    if (window.pm?.gpu) {
        console.log('════════════════════');
        console.log('☀️ SOLAR AUDIFICATION PORTAL - INITIALIZING!');
        console.log('════════════════════');
    }

    // ─── GPU Capability Detection ────────────────────────────────────────
    // Detect hardware capabilities early so the right render/compute path is chosen.
    try {
        const ram = navigator.deviceMemory || 'unknown';
        const cores = navigator.hardwareConcurrency || 'unknown';

        if (navigator.gpu) {
            const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
            if (adapter) {
                const info = adapter.info || {};
                const vendor = info.vendor || 'unknown';
                const arch = info.architecture || '';
                const maxBuf = adapter.limits.maxBufferSize;
                const maxBufMB = (maxBuf / (1024 * 1024)).toFixed(0);
                const integrated = vendor.toLowerCase().includes('intel') && !arch.toLowerCase().includes('arc');

                // Decision: GPU path if maxBufferSize >= 512MB and not low-RAM integrated
                const useGPU = maxBuf >= 512 * 1024 * 1024 && !(integrated && ram < 8);

                const tier = useGPU ? '🟢 GPU' : '🟡 CPU (GPU available but constrained)';
                if (window.pm?.gpu) {
                    console.log(
                        `%c⚡ ${tier} | ${vendor} ${arch} | maxBuffer: ${maxBufMB}MB | RAM: ${ram}GB | cores: ${cores}`,
                        'color: #4CAF50; font-weight: bold; font-size: 13px'
                    );
                    console.log(
                        `%c   Render: WebGPU + Three.js TSL | Compute: ${useGPU ? 'GPU zero-copy' : 'CPU worker pool'}`,
                        'color: #90CAF9'
                    );
                }

                // Store decision for pyramid/renderer to read
                window.__gpuCapability = { useGPU, vendor, arch, maxBufMB: +maxBufMB, ram, integrated };
            } else {
                console.log(`%c⚪ CPU-only | No WebGPU adapter | RAM: ${ram}GB | cores: ${cores}`, 'color: #FFC107; font-weight: bold; font-size: 13px');
                console.log(`%c   Render: WebGPU (Three.js fallback) | Compute: CPU worker pool`, 'color: #90CAF9');
                window.__gpuCapability = { useGPU: false, vendor: 'none', ram };
            }
        } else {
            console.log(`%c⚪ CPU-only | WebGPU not available | RAM: ${ram}GB | cores: ${cores}`, 'color: #FFC107; font-weight: bold; font-size: 13px');
            console.log(`%c   Render: Canvas 2D fallback | Compute: CPU worker pool`, 'color: #90CAF9');
            window.__gpuCapability = { useGPU: false, vendor: 'none', ram };
        }
    } catch (e) {
        console.warn('GPU capability detection failed:', e.message);
        window.__gpuCapability = { useGPU: false, vendor: 'none' };
    }

    // Check for new version first (will reload page if update available)
    if (await checkAppVersion()) return;

    // Group core system initialization
    if (window.pm?.init) console.groupCollapsed('🔧 [INIT] Core Systems');
    
    // ═══════════════════════════════════════════════════════════
    // 📏 STATUS AUTO-RESIZE - Shrink font when text overflows
    // ═══════════════════════════════════════════════════════════
    const { setupStatusAutoResize } = await import('./status-auto-resize.js');
    setupStatusAutoResize();
    
    // ═══════════════════════════════════════════════════════════
    // 🎯 MASTER MODE - Initialize and check configuration
    // ═══════════════════════════════════════════════════════════
    const { initializeMasterMode, isStudyMode, isPersonalMode, isDevMode, CURRENT_MODE, AppMode } = await import('./master-modes.js');
    initializeMasterMode();
    
    // Initialize error reporter early (catches errors during initialization)
    initErrorReporter();
    
    // Initialize silent error reporter (tracks metadata mismatches quietly)
    initSilentErrorReporter();

    // Initialize share modal (for sharing analysis sessions)
    initShareModal();

    if (window.pm?.init) console.groupEnd(); // End Core Systems

    // Group UI setup
    if (window.pm?.init) console.groupCollapsed('🎨 [INIT] UI Setup');

    // ─── Advanced mode: restore state + inject controls EARLY ──────────
    // Advanced mode affects layout decisions throughout init (gear icons,
    // hamburger, control visibility in windowed mode), so set it up before
    // anything else reads it or renders dependent UI.
    const advancedCheckboxEarly = document.getElementById('advancedMode');
    if (advancedCheckboxEarly) {
        const savedAdvanced = localStorage.getItem('emic_advanced_mode');
        if (savedAdvanced !== null) advancedCheckboxEarly.checked = savedAdvanced === 'true';
    }
    if (CURRENT_MODE === AppMode.EMIC_STUDY || CURRENT_MODE === AppMode.SOLAR_PORTAL) {
        initializeAdvancedControls();
    }

    // Don't hide Begin Analysis button initially - let updateCompleteButtonState() handle visibility

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
    
    // Hide simulate panel in Study Mode and Solar Portal mode
    if (isStudyMode() || CURRENT_MODE === AppMode.SOLAR_PORTAL) {
        const simulatePanel = document.querySelector('.panel-simulate');
        if (simulatePanel) {
            simulatePanel.style.display = 'none';
            if (CURRENT_MODE === AppMode.SOLAR_PORTAL) {
                if (window.pm?.init) console.log('☀️ Solar Portal Mode: Simulate panel hidden');
            } else {
                if (window.pm?.init) console.log('🎓 Production Mode: Simulate panel hidden (surveys controlled by workflow)');
            }
        }
        
        // Permanent overlay in Production Mode (fully controlled by modal system)
        // Modal system checks flags and decides whether to show overlay
        if (window.pm?.init) console.log('🎓 Production Mode: Modal system controls overlay (based on workflow flags)');
    } else {
        // Hide permanent overlay in non-Study modes (Dev, Personal)
        const permanentOverlay = document.getElementById('permanentOverlay');
        if (permanentOverlay) {
            permanentOverlay.style.display = 'none';
            if (!isStudyMode()) {
                if (window.pm?.init) console.log(`✅ ${CURRENT_MODE.toUpperCase()} Mode: Permanent overlay hidden`);
            }
        }
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
        if (window.pm?.init) console.log('✅ Modals initialized successfully');
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
    updateCompleteButtonState(); // Begin Analysis button
    updateCmpltButtonState(); // Complete button
    
    // Setup spectrogram frequency selection
    setupSpectrogramSelection();
    
    // Initialize oscilloscope visualization immediately (don't wait for audio)
    import('./oscilloscope-renderer.js').then(({ initOscilloscope }) => {
        initOscilloscope();
        if (window.pm?.init) console.log('🎨 Oscilloscope initialized on UI load');
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
    
    if (window.pm?.init) console.groupEnd(); // End UI Setup
    
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
    if (window.pm?.init) console.groupCollapsed('⌨️ [INIT] Event Listeners');
    
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
        } else if (!isEmicStudyMode()) {
            console.warn(`⚠️ Could not find element: ${id}`);
        }
    });
    if (window.pm?.init) console.log('✅ Date/time persistence listeners attached');
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
                import('./main-window-renderer.js').then(module => {
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
    const dropdowns = ['dataType', 'station', 'duration', 'frequencyScale'];
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
            
            // Sync spectrogram canvas buffer to CSS display size (responsive vh height)
            if (spectrogramCanvas) {
                resizeRendererToDisplaySize();
            }

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
    
    // Expose loadRecentSearches globally so startStreaming can call it
    window.loadRecentSearches = loadRecentSearches;
    
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
    
    if (window.pm?.init) console.log('🟢 LINE 2180 - About to attach startBtn event listener');

    // Data Fetching
    const startBtn = document.getElementById('startBtn');
    if (window.pm?.init) console.log('🟢 startBtn element:', startBtn ? 'FOUND' : 'NOT FOUND');
    if (startBtn) {
        startBtn.addEventListener('click', async (e) => {
            if (window.pm?.interaction) console.log('🔵 Fetch Data button clicked!');
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
        if (window.pm?.init) console.log('🟢 startBtn event listener attached successfully!');
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
    document.getElementById('adminModeBtn').addEventListener('click', toggleAdminMode);

    // Start event listeners setup group
    const listenersGroupOpen = logGroup('ui', 'Setting up UI event listeners');

    // Participant ID display click handler
    const participantIdText = document.getElementById('participantIdText');
    if (participantIdText) {
        participantIdText.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('👤 Participant ID display clicked - opening info modal');
            openParticipantInfoModal();
        });
        // Add hover effect - keep dark background theme with reddish tint
        participantIdText.addEventListener('mouseenter', function() {
            this.style.backgroundColor = 'rgba(80, 50, 50, 0.6)';
        });
        participantIdText.addEventListener('mouseleave', function() {
            this.style.backgroundColor = 'rgba(40, 40, 40, 0.4)';
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

        bgSubmit.addEventListener('click', async () => {
            const value = document.querySelector('input[name="backgroundLevel"]:checked')?.value;
            console.log('📋 Background level:', value);
            if (isEmicStudyMode()) {
                const { EMIC_FLAGS, setEmicFlag } = await import('./emic-study-flags.js');
                setEmicFlag(EMIC_FLAGS.HAS_SUBMITTED_BACKGROUND);
                const { syncEmicProgress } = await import('./data-uploader.js');
                syncEmicProgress(localStorage.getItem('participantId'), 'questionnaire_background');
            }
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

        daSubmit.addEventListener('click', async () => {
            const value = document.querySelector('input[name="dataAnalysisLevel"]:checked')?.value;
            console.log('📋 Data analysis level:', value);
            if (isEmicStudyMode()) {
                const { EMIC_FLAGS, setEmicFlag } = await import('./emic-study-flags.js');
                setEmicFlag(EMIC_FLAGS.HAS_SUBMITTED_DATA_ANALYSIS);
                const { syncEmicProgress } = await import('./data-uploader.js');
                syncEmicProgress(localStorage.getItem('participantId'), 'questionnaire_data_analysis');
            }
            modalManager.closeModal('dataAnalysisQuestionModal');
        });
    }

    // Post-study questionnaire: Musical experience button + modal
    const musicalExperienceQuestionBtn = document.getElementById('musicalExperienceQuestionBtn');
    const meModal = document.getElementById('musicalExperienceQuestionModal');
    if (musicalExperienceQuestionBtn && meModal) {
        musicalExperienceQuestionBtn.addEventListener('click', async () => {
            await modalManager.openModal('musicalExperienceQuestionModal');
        });

        const meSubmit = meModal.querySelector('.modal-submit');
        meModal.querySelectorAll('input[type="radio"]').forEach(radio => {
            radio.addEventListener('change', () => { meSubmit.disabled = false; });
        });

        const meClose = meModal.querySelector('.modal-close');
        if (meClose) {
            meClose.addEventListener('click', () => modalManager.closeModal('musicalExperienceQuestionModal'));
        }

        meSubmit.addEventListener('click', async () => {
            const value = document.querySelector('input[name="musicalExperienceLevel"]:checked')?.value;
            console.log('📋 Musical experience level:', value);
            if (isEmicStudyMode()) {
                const { EMIC_FLAGS, setEmicFlag } = await import('./emic-study-flags.js');
                setEmicFlag(EMIC_FLAGS.HAS_SUBMITTED_MUSICAL);
                const { syncEmicProgress } = await import('./data-uploader.js');
                syncEmicProgress(localStorage.getItem('participantId'), 'questionnaire_musical');
            }
            modalManager.closeModal('musicalExperienceQuestionModal');
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

        fbSubmit.addEventListener('click', async () => {
            const value = fbTextarea.value.trim();
            console.log('📋 Feedback:', value || '(skipped)');
            if (isEmicStudyMode()) {
                const { EMIC_FLAGS, setEmicFlag } = await import('./emic-study-flags.js');
                setEmicFlag(EMIC_FLAGS.HAS_SUBMITTED_FEEDBACK);
                const { syncEmicProgress } = await import('./data-uploader.js');
                syncEmicProgress(localStorage.getItem('participantId'), 'questionnaire_feedback');
            }
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

        refSubmit.addEventListener('click', async () => {
            const value = refTextarea.value.trim();
            console.log('📋 Referral:', value || '(skipped)');
            if (isEmicStudyMode()) {
                const { EMIC_FLAGS, setEmicFlag } = await import('./emic-study-flags.js');
                setEmicFlag(EMIC_FLAGS.HAS_SUBMITTED_REFERRAL);
                const { syncEmicProgress } = await import('./data-uploader.js');
                syncEmicProgress(localStorage.getItem('participantId'), 'questionnaire_referral');
            }
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

                // Generate filename with spacecraft and timestamp
                const spacecraft = document.getElementById('spacecraft')?.value || 'audio';
                const timestamp = recordingStartTime.toISOString()
                    .replace(/:/g, '-')
                    .replace(/\./g, '-')
                    .slice(0, 19); // YYYY-MM-DDTHH-MM-SS
                const filename = `${spacecraft}_recording_${timestamp}.wav`;

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
    
    setupLifecycleHandlers();
    
    if (window.pm?.init) console.groupEnd(); // End Event Listeners
} // End initializeMainApp

// Call initialization when DOM is ready
if (document.readyState === 'loading') {
    // DOM is still loading, wait for DOMContentLoaded
    if (window.pm?.init) console.log('⏳ Waiting for DOMContentLoaded...');
    document.addEventListener('DOMContentLoaded', () => {
        if (window.pm?.init) console.log('🔵 DOMContentLoaded FIRED - calling initializeMainApp');
        initializeMainApp();
    });
} else {
    // DOM is already loaded (interactive or complete), initialize immediately
    // console.log('✅ DOM already loaded, initializing immediately');
    initializeMainApp();
}

