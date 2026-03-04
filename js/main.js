/**
 * main.js
 * Main orchestration: initialization, startStreaming, event handlers
 */


import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { togglePlayPause, toggleLoop, changePlaybackSpeed, changeVolume, resetSpeedTo1, resetVolumeTo1, updatePlaybackSpeed, downloadAudio, cancelAllRAFLoops, switchStretchAlgorithm, primeStretchProcessors } from './audio-player.js';
import { initWaveformWorker, setupWaveformInteraction, drawWaveform, drawWaveformWithSelection, changeWaveformFilter, updatePlaybackIndicator, startPlaybackIndicator, clearWaveformRenderer } from './minimap-window-renderer.js';
import { changeFrequencyScale, loadFrequencyScale, changeColormap, loadColormap, changeFftSize, loadFftSize, startVisualization, setupSpectrogramSelection, clearAllCanvasFeatureBoxes } from './spectrogram-renderer.js';
import { clearCompleteSpectrogram } from './main-window-renderer.js';
import { loadSavedSpacecraft, saveDateTime, updateStationList, updateDatasetOptions, enableFetchButton, purgeCloudflareCache, openParticipantModal, closeParticipantModal, submitParticipantSetup, openWelcomeModal, closeWelcomeModal, changeBaseSampleRate, handleWaveformFilterChange, resetWaveformFilterToDefault, setupModalEventListeners, openParticipantInfoModal } from './ui-controls.js';
import { getParticipantIdFromURL, storeParticipantId } from './participant-id.js';
import { initAdminMode, isAdminMode, toggleAdminMode } from './admin-mode.js';
import { initializeModals } from './modal-templates.js';
import { modalManager } from './modal-manager.js';
import { initErrorReporter } from './error-reporter.js';
import { initSilentErrorReporter } from './silent-error-reporter.js';
import { resizeAxisCanvas, drawFrequencyAxis, setMinFreqMultiplier, getMinFreqMultiplier } from './spectrogram-axis-renderer.js';
import { startFrequencySelection, updateCompleteButtonState, updateCmpltButtonState } from './region-tracker.js';
import { zoomState } from './zoom-state.js';
import { initKeyboardShortcuts } from './keyboard-shortcuts.js';
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
    initializeMasterMode
} from './master-modes.js';
import { initShareModal, openShareModal, checkAndLoadSharedSession, applySharedSession, updateShareButtonState } from './share-modal.js';
import { log, logGroup, logGroupEnd } from './logger.js';
import { initializeAdvancedControls } from './advanced-controls.js';
import { checkAppVersion } from './version-check.js';
import { setupAudioDownloadHandlers } from './audio-download.js';
import { setupLifecycleHandlers } from './lifecycle-cleanup.js';
import { loadRecentSearches, restoreRecentSearch, saveRecentSearch } from './recent-searches.js';
import { setupResizeHandler } from './resize-handler.js';
import { detectGPUCapability } from './gpu-detection.js';
import { initializeApp, updateParticipantIdDisplay } from './mode-initializers.js';

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

// Mode initialization functions extracted to ./mode-initializers.js

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
    await detectGPUCapability();

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
    
    // Window resize handler and canvas layout (extracted to resize-handler.js)
    setupResizeHandler();
    
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
    
    // Set up download, recording, and ZIP export handlers
    setupAudioDownloadHandlers();

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

