/**
 * main.js
 * Main orchestration: initialization, startStreaming, event handlers
 */

// ===== DEBUG FLAGS =====
const DEBUG_LOOP_FADES = true; // Enable loop fade logging

// ===== FIRST FETCH TRACKING =====
let hasPerformedFirstFetch = false; // Track if first fetch has been performed

import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { togglePlayPause, toggleLoop, changePlaybackSpeed, changeVolume, resetSpeedTo1, resetVolumeTo1, updatePlaybackSpeed, downloadAudio, cancelAllRAFLoops, setResizeRAFRef } from './audio-player.js';
import { initWaveformWorker, setupWaveformInteraction, drawWaveform, drawWaveformFromMinMax, drawWaveformWithSelection, changeWaveformFilter, updatePlaybackIndicator, startPlaybackIndicator } from './waveform-renderer.js';
import { changeFrequencyScale, loadFrequencyScale, startVisualization, setupSpectrogramSelection, cleanupSpectrogramSelection } from './spectrogram-renderer.js';
import { clearCompleteSpectrogram, startMemoryMonitoring } from './spectrogram-complete-renderer.js';
import { loadStations, loadSavedVolcano, updateStationList, enableFetchButton, purgeCloudflareCache, openParticipantModal, closeParticipantModal, submitParticipantSetup, openWelcomeModal, closeWelcomeModal, openEndModal, closeEndModal, openPreSurveyModal, closePreSurveyModal, submitPreSurvey, openPostSurveyModal, closePostSurveyModal, submitPostSurvey, openActivityLevelModal, closeActivityLevelModal, submitActivityLevelSurvey, openAwesfModal, closeAwesfModal, submitAwesfSurvey, changeBaseSampleRate, handleWaveformFilterChange, resetWaveformFilterToDefault, setupModalEventListeners, attemptSubmission, openBeginAnalysisModal, openCompleteConfirmationModal, openTutorialRevisitModal } from './ui-controls.js';
import { getParticipantIdFromURL, storeParticipantId, getParticipantId } from './qualtrics-api.js';
import { initAdminMode, isAdminMode, toggleAdminMode } from './admin-mode.js';
import { fetchFromR2Worker } from './data-fetcher.js';
// fetchFromRailway is disabled
import { trackUserAction } from '../Qualtrics/participant-response-manager.js';
import { initializeModals } from './modal-templates.js';
import { initErrorReporter } from './error-reporter.js';
import { initSilentErrorReporter } from './silent-error-reporter.js';
import { positionAxisCanvas, resizeAxisCanvas, drawFrequencyAxis, initializeAxisPlaybackRate } from './spectrogram-axis-renderer.js';
import { positionWaveformAxisCanvas, resizeWaveformAxisCanvas, drawWaveformAxis } from './waveform-axis-renderer.js';
import { positionWaveformXAxisCanvas, resizeWaveformXAxisCanvas, drawWaveformXAxis, positionWaveformDateCanvas, resizeWaveformDateCanvas, drawWaveformDate, initializeMaxCanvasWidth, cancelZoomTransitionRAF, stopZoomTransition } from './waveform-x-axis-renderer.js';
import { positionWaveformButtonsCanvas, resizeWaveformButtonsCanvas, drawRegionButtons } from './waveform-buttons-renderer.js';
import { initRegionTracker, toggleRegion, toggleRegionPlay, addFeature, updateFeature, deleteRegion, startFrequencySelection, createTestRegion, setSelectionFromActiveRegionIfExists, getActivePlayingRegionIndex, clearActivePlayingRegion, switchVolcanoRegions, updateCompleteButtonState, updateCmpltButtonState, showAddRegionButton } from './region-tracker.js';
import { zoomState } from './zoom-state.js';
import { initKeyboardShortcuts, cleanupKeyboardShortcuts } from './keyboard-shortcuts.js';
import { setStatusText, appendStatusText, initTutorial, disableFrequencyScaleDropdown, removeVolumeSliderGlow } from './tutorial.js';
import { isTutorialActive } from './tutorial-state.js';
import { 
    CURRENT_MODE, 
    AppMode, 
    isPersonalMode, 
    isDevMode, 
    isStudyMode,
    initializeMasterMode 
} from './master-modes.js';

// Helper function to safely check study mode (handles cases where module isn't loaded yet)
function safeIsStudyMode() {
    try {
        return isStudyMode();
    } catch (e) {
        // If isStudyMode is not available, assume not in study mode (allows logging)
        return false;
    }
}

// Debug flag for chunk loading logs (set to true to enable detailed logging)
// See data-fetcher.js for centralized flags documentation
const DEBUG_CHUNKS = false;

// 🧹 MEMORY LEAK FIX: Use event listeners instead of window.* assignments
// This prevents closure memory leaks by avoiding permanent window references
// that capture entire module scopes including State with all audio data

// Force IRIS fetch state
let forceIrisFetch = false;

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

// Helper functions
function formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}m ${secs}s`;
}

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
    console.log('🎨 Started oscilloscope data collection from analyser node (post-volume)');
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
    
    // 🔥 FIX: Disconnect old analyser node to prevent memory leak
    if (State.analyserNode) {
        console.log('🧹 Disconnecting old analyser node...');
        State.analyserNode.disconnect();
        State.setAnalyserNode(null);
    }
    
    if (!State.audioContext) {
        const ctx = new AudioContext({ 
            sampleRate: 44100,
            latencyHint: 'playback'  // 30ms buffer for stable playback (prevents dropouts)
        });
        State.setAudioContext(ctx);
        await ctx.audioWorklet.addModule('workers/audio-worklet.js');
        console.log(`🎵 [${Math.round(performance.now() - window.streamingStartTime)}ms] Created new AudioContext (sampleRate: 44100 Hz, latency: playback)`);
    }
    
    const worklet = new AudioWorkletNode(State.audioContext, 'seismic-processor');
    State.setWorkletNode(worklet);
    
    const analyser = State.audioContext.createAnalyser();
    analyser.fftSize = 2048;
    State.setAnalyserNode(analyser);
    
    const gain = State.audioContext.createGain();
    // Set to user's volume setting (worklet now handles fades internally)
    const volumeSlider = document.getElementById('volumeSlider');
    gain.gain.value = volumeSlider ? parseFloat(volumeSlider.value) / 100 : 1.0;
    State.setGainNode(gain);
    
    worklet.connect(gain);
    gain.connect(analyser);
    gain.connect(State.audioContext.destination);
    
    updatePlaybackSpeed();
    
    // Initialize oscilloscope visualization
    import('./oscilloscope-renderer.js').then(({ initOscilloscope }) => {
        initOscilloscope();
        console.log('🎨 Oscilloscope visualization initialized');
        
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
    }
    
    worklet.port.onmessage = (event) => {
        const { type, bufferSize, samplesConsumed, totalSamples, positionSeconds, samplePosition } = event.data;
        
        if (type === 'position') {
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
            console.log(`⏱️ [${ttfa.toFixed(0)}ms] Worklet confirmed playback`);
        } else if (type === 'seek-ready') {
            // Worklet has cleared its buffer and is ready for samples at seek position
            const { targetSample, wasPlaying, forceResume } = event.data;
            console.log(`🎯 [SEEK-READY] Re-sending samples from ${targetSample.toLocaleString()}, wasPlaying=${wasPlaying}, forceResume=${forceResume}`);
            
            // 🔥 FIX: Copy completeSamplesArray to local variable to break closure chain
            // This prevents the message handler closure from retaining the entire State module
            const completeSamplesArray = State.completeSamplesArray;
            
            if (completeSamplesArray && targetSample >= 0 && targetSample < completeSamplesArray.length) {
                // Tell worklet whether to auto-resume after buffering
                const shouldAutoResume = wasPlaying || forceResume;
                
                // Send samples in chunks to avoid blocking
                const chunkSize = 44100 * 10; // 10 seconds per chunk
                const totalSamples = completeSamplesArray.length;
                
                for (let i = targetSample; i < totalSamples; i += chunkSize) {
                    const end = Math.min(i + chunkSize, totalSamples);
                    // 🔥 FIX: Copy slice to new ArrayBuffer to prevent retaining reference to completeSamplesArray's buffer
                    // Slices share the same ArrayBuffer, which prevents GC of the original buffer
                    const slice = completeSamplesArray.slice(i, end);
                    const chunk = new Float32Array(slice); // Copy to new ArrayBuffer
                    
                    State.workletNode.port.postMessage({
                        type: 'audio-data',
                        data: chunk,
                        autoResume: shouldAutoResume  // Tell worklet to auto-resume after buffering
                    });
                }
                
                console.log(`📤 [SEEK-READY] Sent ${(totalSamples - targetSample).toLocaleString()} samples from position ${targetSample.toLocaleString()}, autoResume=${shouldAutoResume}`);
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
            
            // 🔥 FIX: Copy completeSamplesArray to local variable to break closure chain
            // This prevents the message handler closure from retaining the entire State module
            const completeSamplesArray = State.completeSamplesArray;
            
            if (completeSamplesArray && completeSamplesArray.length > 0) {
                // Update position tracking to loop target
                const newPositionSeconds = targetSample / 44100;
                State.setCurrentAudioPosition(newPositionSeconds);
                State.setLastWorkletPosition(newPositionSeconds);
                State.setLastWorkletUpdateTime(State.audioContext.currentTime);
                
                // Send samples from target position onwards with auto-resume
                const chunkSize = 44100 * 10; // 10 seconds per chunk
                const totalSamples = completeSamplesArray.length;
                
                for (let i = targetSample; i < totalSamples; i += chunkSize) {
                    const end = Math.min(i + chunkSize, totalSamples);
                    // 🔥 FIX: Copy slice to new ArrayBuffer to prevent retaining reference to completeSamplesArray's buffer
                    // Slices share the same ArrayBuffer, which prevents GC of the original buffer
                    const slice = completeSamplesArray.slice(i, end);
                    const chunk = new Float32Array(slice); // Copy to new ArrayBuffer
                    
                    State.workletNode.port.postMessage({
                        type: 'audio-data',
                        data: chunk,
                        autoResume: true  // Auto-resume when buffer is ready
                    });
                }
                
                // console.log(`🔄 [LOOP-READY] Sent ${(totalSamples - targetSample).toLocaleString()} samples from ${newPositionSeconds.toFixed(2)}s, will auto-resume`);
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

// Main streaming function
export async function startStreaming(event) {
    try {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        
        // Mark that first fetch has been performed (disables Enter key shortcut)
        hasPerformedFirstFetch = true;
        
        // Remove pulsing glow from volcano selector when user starts fetching
        const volcanoSelect = document.getElementById('volcano');
        if (volcanoSelect) {
            volcanoSelect.classList.remove('pulse-glow');
        }
        
        // Clear complete spectrogram when loading new data
        clearCompleteSpectrogram();
        
        // 🔧 FIX: Reset zoom state to full view when loading new data
        // Prevents state leakage when switching volcanoes while zoomed into a region
        if (zoomState.isInitialized()) {
            zoomState.mode = 'full';
            zoomState.currentViewStartSample = 0;
            zoomState.activeRegionId = null;
            if (!isStudyMode()) {
                console.log('🔄 Reset zoom state to full view for new data');
            }
        }
        
        // Reset waveform click tracking when loading new data
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
        
        State.setIsShowingFinalWaveform(false);
        
        window.streamingStartTime = performance.now();
        const logTime = () => `[${Math.round(performance.now() - window.streamingStartTime)}ms]`;
        
        // Only log in dev/personal modes, not study mode
        if (!isStudyMode()) {
            console.log('🎬 [0ms] startStreaming() called');
        }
        
        const stationValue = document.getElementById('station').value;
        if (!stationValue) {
            alert('Please select a station');
            return;
        }
        
        const stationData = JSON.parse(stationValue);
        const duration = parseFloat(document.getElementById('duration').value);
        const highpassFreq = document.getElementById('highpassFreq').value;
        const enableNormalize = document.getElementById('enableNormalize').checked;
        const volcano = document.getElementById('volcano').value;
        
        // Switch to this volcano's regions (regions are scoped per volcano)
        // This happens when data is actually being fetched, not just when the dropdown changes
        switchVolcanoRegions(volcano);
        
        // Log what we're fetching
        const stationLabel = `${stationData.network}.${stationData.station}.${stationData.location || '--'}.${stationData.channel}`;
        if (!isStudyMode()) {
            console.log(`🌋 Fetching data for ${volcano} from station ${stationLabel}`);
        }
        
        // Track fetch data action
        const participantId = getParticipantId();
        if (participantId) {
            trackUserAction(participantId, 'fetch_data', {
                volcano: volcano,
                station: `${stationData.network}.${stationData.station}.${stationData.location || '--'}.${stationData.channel}`,
                duration: duration,
                highpassFreq: highpassFreq,
                enableNormalize: enableNormalize
            });
        }
        
        // Calculate estimated end time
        const now = new Date();
        const currentMinute = now.getUTCMinutes();
        const currentSecond = now.getUTCSeconds();
        const currentPeriodStart = Math.floor(currentMinute / 10) * 10;
        const minutesSincePeriodStart = currentMinute - currentPeriodStart;
        const secondsSincePeriodStart = minutesSincePeriodStart * 60 + currentSecond;
        
        let estimatedEndTime;
        if (secondsSincePeriodStart >= 135) {
            estimatedEndTime = new Date(now.getTime());
            estimatedEndTime.setUTCMinutes(currentPeriodStart, 0, 0);
        } else {
            estimatedEndTime = new Date(now.getTime());
            estimatedEndTime.setUTCMinutes(currentPeriodStart - 10, 0, 0);
        }
        
        const startTime = new Date(estimatedEndTime.getTime() - duration * 3600 * 1000);
        
        // Only log in dev/personal modes, not study mode
        if (!isStudyMode()) {
            console.log(`🕐 ${logTime()} Estimated latest chunk ends at: ${estimatedEndTime.toISOString()}`);
            console.log(`🚀 ${logTime()} Starting parallel: worker + audioContext + station check`);
        }
        
        // 1. Worker creation
        if (window.audioWorker) {
            if (!isStudyMode()) {
                console.log('🧹 Terminating old audio worker...');
            }
            window.audioWorker.onmessage = null;  // Break closure chain
            // 🔥 FIX: Remove all event listeners before terminating
            // Note: Terminating the worker will clean up listeners, but we do this explicitly
            // to ensure any pending promises don't hold references
            window.audioWorker.terminate();
            window.audioWorker = null; // 🧹 Clear reference before creating new worker
        }
        window.audioWorker = new Worker('workers/audio-processor-worker.js');
        // 🔥 FIX: Store reference to listener so we can clean it up if worker terminates early
        let readyListener = null;
        const workerReadyPromise = new Promise(resolve => {
            readyListener = function onReady(e) {
                if (e.data === 'ready') {
                    if (window.audioWorker && readyListener) {
                        window.audioWorker.removeEventListener('message', readyListener);
                    }
                    if (!isStudyMode()) {
                        console.log(`🏭 ${logTime()} Worker ready!`);
                    }
                    resolve();
                }
            };
            window.audioWorker.addEventListener('message', readyListener);
        });
        
        // 2. AudioContext creation
        const audioContextPromise = (async () => {
            if (!State.audioContext) {
                const ctx = new AudioContext({ 
                    sampleRate: 44100,
                    latencyHint: 'playback'  // 30ms buffer for stable playback (prevents dropouts)
                });
                State.setAudioContext(ctx);
                await ctx.audioWorklet.addModule('workers/audio-worklet.js');
                if (!isStudyMode()) {
                    console.log(`🎵 ${logTime()} AudioContext ready (latency: playback)`);
                }
            }
        })();
        
        // 3. Check if station is active
        const stationCheckPromise = (async () => {
            const configResponse = await fetch('backend/stations_config.json');
            const stationsConfig = await configResponse.json();
            
            let isActiveStation = false;
            if (stationsConfig.networks[stationData.network] && 
                stationsConfig.networks[stationData.network][volcano]) {
                const volcanoStations = stationsConfig.networks[stationData.network][volcano];
                const stationConfig = volcanoStations.find(s => 
                    s.station === stationData.station && 
                    s.location === (stationData.location || '--') &&
                    s.channel === stationData.channel
                );
                
                if (stationConfig) {
                    isActiveStation = stationConfig.active === true;
                }
            }
            
            if (!isStudyMode()) {
                console.log(`📋 ${logTime()} Station ${stationData.network}.${stationData.station}: active=${isActiveStation}`);
            }
            return isActiveStation;
        })();
        
        await Promise.all([workerReadyPromise, audioContextPromise]);
        if (!isStudyMode()) {
            console.log(`✅ ${logTime()} Worker + AudioContext ready!`);
        }
        
        const isActiveStation = await stationCheckPromise;
        
        // 4. Build realistic chunk fetch for active stations (skip if forcing IRIS fetch)
        let realisticChunkPromise = Promise.resolve(null);
        let firstChunkStart = null;
        
        if (forceIrisFetch) {
            console.log(`🌐 ${logTime()} Force IRIS Fetch ENABLED - Skipping CDN chunk fetches`);
        } else if (isActiveStation) {
            const volcanoMap = {
                'kilauea': 'kilauea',
                'maunaloa': 'maunaloa',
                'greatsitkin': 'greatsitkin',
                'shishaldin': 'shishaldin',
                'spurr': 'spurr'
            };
            const volcanoName = volcanoMap[volcano] || 'kilauea';
            const CDN_BASE_URL = 'https://cdn.now.audio/data';
            
            firstChunkStart = new Date(startTime.getTime());
            firstChunkStart.setUTCMinutes(Math.floor(firstChunkStart.getUTCMinutes() / 10) * 10, 0, 0);
            
            const location = stationData.location || '--';
            const sampleRate = Math.round(stationData.sample_rate || 100);
            
            const bypassCache = document.getElementById('bypassCache').checked;
            const cacheBuster = bypassCache ? `?t=${Date.now()}` : '';
            if (bypassCache) {
                console.log(`🚫 ${logTime()} Cache bypass ENABLED`);
            }
            
            realisticChunkPromise = (async () => {
                const buildRealisticUrl = (minuteOffset) => {
                    const attemptTime = new Date(firstChunkStart.getTime());
                    attemptTime.setUTCMinutes(attemptTime.getUTCMinutes() + minuteOffset);
                    
                    const date = attemptTime.toISOString().split('T')[0];
                    const hour = attemptTime.getUTCHours();
                    const minute = Math.floor(attemptTime.getUTCMinutes() / 10) * 10;
                    const startTimeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
                    
                    // Calculate NEW format end time (actual end: 03:40:00 for 03:30 start)
                    const endDateTime = new Date(attemptTime.getTime() + 10 * 60 * 1000); // +10 minutes
                    const endDate = endDateTime.toISOString().split('T')[0]; // YYYY-MM-DD
                    const endHour = endDateTime.getUTCHours();
                    const endMinute = endDateTime.getUTCMinutes();
                    const endTime = `${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}:00`;
                    
                    // Calculate OLD format end time (last second: 03:39:59 for 03:30 start)
                    const oldEndDateTime = new Date(attemptTime.getTime() + 10 * 60 * 1000 - 1000); // +10 min - 1 sec
                    const oldEndDate = oldEndDateTime.toISOString().split('T')[0]; // YYYY-MM-DD
                    const oldEndHour = oldEndDateTime.getUTCHours();
                    const oldEndMinute = oldEndDateTime.getUTCMinutes();
                    const oldEndSecond = oldEndDateTime.getUTCSeconds();
                    const oldEndTime = `${String(oldEndHour).padStart(2, '0')}:${String(oldEndMinute).padStart(2, '0')}:${String(oldEndSecond).padStart(2, '0')}`;
                    
                    const [y, m, d] = date.split('-');
                    const path = `${y}/${m}/${d}`;
                    
                    const newFname = `${stationData.network}_${stationData.station}_${location}_${stationData.channel}_10m_${date}-${startTimeStr.replace(/:/g, '-')}_to_${endDate}-${endTime.replace(/:/g, '-')}.bin.zst`;
                    const oldFname = `${stationData.network}_${stationData.station}_${location}_${stationData.channel}_${sampleRate}Hz_10m_${date}-${startTimeStr.replace(/:/g, '-')}_to_${oldEndDate}-${oldEndTime.replace(/:/g, '-')}.bin.zst`;
                    
                    return {
                        newUrl: `${CDN_BASE_URL}/${path}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/10m/${newFname}${cacheBuster}`,
                        oldUrl: `${CDN_BASE_URL}/${path}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/10m/${oldFname}${cacheBuster}`,
                        date: date,
                        time: startTimeStr
                    };
                };
                
                const attempts = [
                    { offset: 0, label: 'chunk 0' },
                    { offset: 10, label: 'chunk +1' },
                    { offset: 20, label: 'chunk +2' },
                    { offset: 30, label: 'chunk +3' },
                    { offset: 40, label: 'chunk +4' },
                    { offset: 50, label: 'chunk +5' }
                ];
                
                for (const attempt of attempts) {
                    const { newUrl, oldUrl, date, time } = buildRealisticUrl(attempt.offset);
                    
                    try {
                        let response = await fetch(newUrl);
                        
                        if (!response.ok) {
                            response = await fetch(oldUrl);
                        }
                        
                        if (response.ok) {
                            const compressed = await response.arrayBuffer();
                            if (DEBUG_CHUNKS) console.log(`📥 ${logTime()} Realistic chunk SUCCESS (${attempt.label}): ${date} ${time} - ${(compressed.byteLength / 1024).toFixed(1)} KB`);
                            return { compressed, date, time };
                        } else {
                            console.warn(`⚠️ ${logTime()} Realistic ${attempt.label} not found - trying next...`);
                        }
                    } catch (error) {
                        console.warn(`⚠️ ${logTime()} Realistic ${attempt.label} fetch error - trying next...`);
                    }
                }
                
                console.warn(`⚠️ ${logTime()} All realistic attempts failed`);
                return null;
            })();
        } else {
            console.log(`⏭️ ${logTime()} Skipping realistic chunk fetch (inactive station)`);
        }
        
        // Clean up old playback
        State.setIsFetchingNewData(true);
        State.setSpectrogramInitialized(false);
        
        // Clear encouragement timeout if it exists (user is fetching data)
        if (window._encouragementTimeout) {
            clearTimeout(window._encouragementTimeout);
            window._encouragementTimeout = null;
        }
        
        // 🔥 Cancel any active typing animation FIRST
        const { cancelTyping } = await import('./tutorial.js');
        cancelTyping();
        
        // Mark initial message as dismissed and ALWAYS clear status text
        window._initialMessageDismissed = true;
        const statusEl = document.getElementById('status');
        if (statusEl) {
            statusEl.textContent = '';  // Just clear it, period. No checking!
        }
        
        const baseMessage = forceIrisFetch 
            ? `📡 Fetching data for station ${stationLabel} (${stationData.distance_km}km) from IRIS Server`
            : (isActiveStation ? `📡 Fetching data for station ${stationLabel} (${stationData.distance_km}km) from R2 Server` : `📡 Fetching data for station ${stationLabel} (${stationData.distance_km}km) from Railway Server`);
        document.getElementById('status').className = 'status info loading';
        document.getElementById('status').textContent = baseMessage;
        
        if (State.workletNode) {
            console.log('🧹 Starting AGGRESSIVE memory cleanup...');
            // 🔥 FIX: Cancel RAF loops FIRST to prevent new detached callbacks
            cancelAllRAFLoops();
            
            // 🔥 FIX: Clear worklet message handlers FIRST before clearing State arrays
            // This prevents the closures from retaining references to old Float32Arrays
            State.workletNode.port.onmessage = null;
            
            // 🔥 FIX: Remove addEventListener handlers that might retain ArrayBuffer references
            // These handlers have closures that capture processedChunks and other variables
            if (State.workletBufferStatusHandler) {
                State.workletNode.port.removeEventListener('message', State.workletBufferStatusHandler);
                State.setWorkletBufferStatusHandler(null);
            }
            if (State.workletRailwayBufferStatusHandler) {
                State.workletNode.port.removeEventListener('message', State.workletRailwayBufferStatusHandler);
                State.setWorkletRailwayBufferStatusHandler(null);
            }
            
            // Worklet handles fades internally now, just disconnect
            State.workletNode.disconnect();
            State.setWorkletNode(null);
            if (State.gainNode) {
                State.gainNode.disconnect();
                State.setGainNode(null);
            }
            // 🔥 FIX: Disconnect analyser node to prevent memory leak
            if (State.analyserNode) {
                State.analyserNode.disconnect();
                State.setAnalyserNode(null);
            }
            
            // Stop oscilloscope data collection
            stopOscilloscopeDataCollection();
            
            // 🧹 AGGRESSIVE CLEANUP: Explicitly null out large arrays
            // NOTE: Worklet handler is already cleared above, so these won't be retained
            const oldDataLength = State.allReceivedData?.length || 0;
            const oldSamplesLength = State.completeSamplesArray?.length || 0;
            console.log(`🧹 Clearing old audio data: ${oldDataLength} chunks, ${oldSamplesLength.toLocaleString()} samples`);
            
            // 🔥 FIX: Explicitly null out each chunk to break references before clearing array
            if (State.allReceivedData && State.allReceivedData.length > 0) {
                for (let i = 0; i < State.allReceivedData.length; i++) {
                    State.allReceivedData[i] = null;
                }
            }
            State.setAllReceivedData([]);
            
            // 🔥 FIX: Explicitly clear completeSamplesArray to break ArrayBuffer references
            // When completeSamplesArray is sliced, the slices share the same ArrayBuffer
            // Setting to null breaks the reference, allowing GC to reclaim the 34MB buffer
            // Note: Must use setter function - direct assignment fails because ES modules are read-only
            State.setCompleteSamplesArray(null);
            
            // Disable Begin Analysis button when data is cleared
            updateCompleteButtonState();
            State.setCachedWaveformCanvas(null);
            State.setWaveformMinMaxData(null);
            State.setCurrentMetadata(null);
            State.setTotalAudioDuration(0);
            State.setCurrentAudioPosition(0);
            document.getElementById('playbackDuration').textContent = '--';
            window.playbackDurationSeconds = null;
            window.rawWaveformData = null; // 🧹 Clear raw waveform data for GC
            window.displayWaveformData = null; // 🧹 Clear display waveform data for GC
            stopPositionTracking();
            document.getElementById('currentPosition').textContent = '0m 0s';
            document.getElementById('downloadSize').textContent = '0.00 MB';
            // Waveform worker is now terminated/recreated at start of startStreaming()
            const waveformCanvas = document.getElementById('waveform');
            if (waveformCanvas) {
                const ctx = waveformCanvas.getContext('2d');
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, waveformCanvas.width, waveformCanvas.height);
            }
            
            State.setPlaybackState(PlaybackState.STOPPED);
            
            // 🔥 Notify oscilloscope that playback stopped (for flame effect fade)
            import('./oscilloscope-renderer.js').then(({ setPlayingState }) => {
                setPlayingState(false);
            });
            
            // 🔥 Hint to browser that GC would be nice (only works with --js-flags="--expose-gc")
            if (typeof window !== 'undefined' && window.gc) {
                console.log('🗑️ Requesting manual garbage collection...');
                window.gc();
            }
            
            console.log('🧹 Memory cleanup complete - old references cleared');
        }
        
        await initAudioWorklet();
        
        const startBtn = document.getElementById('startBtn');
        const playPauseBtn = document.getElementById('playPauseBtn');
        
        startBtn.classList.add('streaming');
        startBtn.disabled = true;
        
        playPauseBtn.disabled = true;
        playPauseBtn.textContent = '⏸️ Pause';
        playPauseBtn.classList.remove('pause-active', 'play-active', 'loop-active', 'pulse-play', 'pulse-resume');
        document.getElementById('downloadBtn').disabled = true;
        
        // Don't disable loop button - it should remain enabled during data loading
        
        State.setPlaybackState(PlaybackState.PLAYING);
        State.setStreamStartTime(performance.now());
        
        // 🔥 Notify oscilloscope that playback started (for flame effect fade)
        import('./oscilloscope-renderer.js').then(({ setPlayingState }) => {
            setPlayingState(true);
        });
        
        let dotCount = 0;
        const interval = setInterval(() => {
            dotCount++;
            const statusEl = document.getElementById('status');
            statusEl.textContent = baseMessage + '.'.repeat(dotCount);
            if (!statusEl.classList.contains('loading')) {
                statusEl.classList.add('loading');
            }
        }, 500);
        State.setLoadingInterval(interval);
        
        try {
        if (forceIrisFetch) {
            console.log(`🌐 ${logTime()} Force IRIS Fetch ENABLED - Railway backend DISABLED`);
            throw new Error('Railway backend is disabled');
            // await fetchFromRailway(stationData, startTime, duration, highpassFreq, enableNormalize);
        } else if (isActiveStation) {
            if (!isStudyMode()) {
                console.log(`🌐 ${logTime()} Using CDN direct (active station)`);
            }
            await fetchFromR2Worker(stationData, startTime, estimatedEndTime, duration, highpassFreq, realisticChunkPromise, firstChunkStart);
        } else {
            console.log(`🚂 ${logTime()} Railway backend disabled - inactive stations not supported`);
            throw new Error('Railway backend is disabled - inactive stations not supported');
            // await fetchFromRailway(stationData, startTime, duration, highpassFreq, enableNormalize);
            }
            
            // Data fetch completed successfully - mark this volcano as having data
            State.setVolcanoWithData(volcano);
            if (!isStudyMode()) {
                console.log(`✅ Data fetch complete - marked ${volcano} as having data`);
            }
        } catch (fetchError) {
            // Don't set volcanoWithData if fetch failed
            throw fetchError;
        }
    } catch (error) {
        State.setIsFetchingNewData(false);
        
        if (State.loadingInterval) {
            clearInterval(State.loadingInterval);
            State.setLoadingInterval(null);
        }
        
        console.error('❌ Error:', error);
        console.error('Stack:', error.stack);
        document.getElementById('status').className = 'status error';
        
        // Check if it's a fetch/network error and provide user-friendly message
        let errorMessage = error.message;
        if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError') || 
            (error.name === 'TypeError' && error.message.includes('fetch'))) {
            errorMessage = 'Data fetch unsuccessful. Please check your internet connection and try again.';
        }
        
        document.getElementById('status').textContent = errorMessage;
        
        const startBtn = document.getElementById('startBtn');
        startBtn.disabled = false;
        startBtn.classList.remove('streaming');
        
        document.getElementById('playPauseBtn').disabled = true;
        // Don't disable loop button on error - keep it enabled if it was enabled before
        document.getElementById('downloadBtn').disabled = true;
    }
}

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
    
    console.log(`🚀 Initializing app in ${CURRENT_MODE} mode`);
    
    switch (CURRENT_MODE) {
        case AppMode.PERSONAL:
            await initializePersonalMode();
            break;
            
        case AppMode.DEV:
            await initializeDevMode();
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
}

// DOMContentLoaded initialization
window.addEventListener('DOMContentLoaded', async () => {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('🌋 VOLCANO AUDIFICATION STUDY');
    console.log('═══════════════════════════════════════════════════════════');
    
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
    // - Production (not local): Always hidden (study mode enforced)
    // - Local non-study modes: Always visible (dev, personal, etc.)
    // - Local test modes: Always visible (study_clean, study_w2_s1, study_w2_s2, tutorial_end)
    // - Local production study mode only: Hidden by default, revealed by "dvdv"
    
    const isPureProductionStudy = CURRENT_MODE === AppMode.PRODUCTION;
    const isTestMode = CURRENT_MODE === AppMode.STUDY_CLEAN ||
                       CURRENT_MODE === AppMode.STUDY_W2_S1 ||
                       CURRENT_MODE === AppMode.STUDY_W2_S1_RETURNING ||
                       CURRENT_MODE === AppMode.STUDY_W2_S2 ||
                       CURRENT_MODE === AppMode.TUTORIAL_END;
    
    if (!isLocal) {
        // Production: Hide mode selector (study mode is enforced)
        if (modeSelectorContainer) {
            modeSelectorContainer.style.visibility = 'hidden';
            modeSelectorContainer.style.opacity = '0';
        }
        console.log('🔒 Mode selector hidden (production environment)');
    } else if (isLocal && !isPureProductionStudy) {
        // Local: Show for all modes EXCEPT pure production study
        // This includes: dev, personal, study_clean, study_w2_s1, study_w2_s2, tutorial_end
        if (modeSelectorContainer) {
            modeSelectorContainer.style.visibility = 'visible';
            modeSelectorContainer.style.opacity = '1';
        }
        if (isTestMode) {
            console.log('🧪 Mode selector visible (test mode)');
        } else {
            console.log('🔓 Mode selector visible (dev/personal mode)');
        }
    } else if (isPureProductionStudy && isLocal) {
        // Pure production study mode (local): Hidden by default, revealed by "dvdv"
        console.log('🔒 Mode selector hidden (type "dvdv" to reveal)');
    }

    // Secret key sequence to reveal mode selector (hardcoded, no server needed)
    // Only used for study modes
    const modeSelectorSecret = 'dvdv';
    
    // Track key sequence
    let keySequence = '';
    let keySequenceTimeout = null;
    
    // Function to show mode selector
    function showModeSelector() {
        if (modeSelectorContainer) {
            modeSelectorContainer.style.visibility = 'visible';
            modeSelectorContainer.style.opacity = '1';
            console.log('🔓 Mode selector revealed (secret sequence detected)');
        }
    }
    
    // Listen for secret key sequence (anytime, anywhere)
    function handleSecretKeyListener(e) {
        // Skip if key is undefined (can happen with some special keys)
        if (!e.key) {
            return;
        }

        // Reset sequence if too much time passes (2 seconds)
        if (keySequenceTimeout) {
            clearTimeout(keySequenceTimeout);
        }
        keySequenceTimeout = setTimeout(() => {
            keySequence = '';
        }, 2000);

        // Add current key to sequence
        keySequence += e.key.toLowerCase();

        // Keep only last N characters (where N is secret length)
        const secretLength = modeSelectorSecret.length;
        if (keySequence.length > secretLength) {
            keySequence = keySequence.slice(-secretLength);
        }

        // Check if sequence matches secret
        if (keySequence === modeSelectorSecret.toLowerCase()) {
            showModeSelector();
            keySequence = ''; // Reset sequence
            if (keySequenceTimeout) {
                clearTimeout(keySequenceTimeout);
                keySequenceTimeout = null;
            }
        }
    }
    
    // Add key listener on page load (only for pure production study mode in local environment)
    // Production (not local): Disable secret key sequence (study mode is enforced)
    // Test modes: Don't need secret sequence (mode selector already visible)
    if (isPureProductionStudy && isLocal) {
        window.addEventListener('keydown', handleSecretKeyListener);
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
    // But exclude TUTORIAL_END mode - it behaves differently (no initial modals)
    if (isStudyMode()) {
        const simulatePanel = document.querySelector('.panel-simulate');
        if (simulatePanel) {
            simulatePanel.style.display = 'none';
            console.log('🎓 Production Mode: Simulate panel hidden (surveys controlled by workflow)');
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
    
    // Update participant ID display
    updateParticipantIdDisplay();
    // Only log version info in dev/personal modes, not study mode
    if (!isStudyMode()) {
        console.log('🌋 [0ms] volcano-audio v2.57 - Corrupted State Detection: Pre-Survey Completion Edge Case');
        console.log('🛡️ [0ms] v2.57 Fix: Added detection for users who completed pre-survey but stopped before tutorial');
        console.log('🔥 [0ms] v2.57 Feat: Two corrupted state checks - Case 1: Seen participant setup but no tutorial, Case 2: Completed pre-survey but no tutorial');
        console.log('🧹 [0ms] v2.57 Fix: Both cases trigger full reset to brand new participant state for clean restart');
        console.log('🌋 [0ms] volcano-audio v2.56 - Canvas Redrawing: Aggressive Destroy/Recreate on Visibility Change');
        console.log('🎨 [0ms] v2.56 Fix: Canvas feature boxes now redraw after tab switch/sleep - implemented aggressive destroy/recreate strategy for overlay canvas');
        console.log('🔧 [0ms] v2.56 Feat: When page becomes hidden, cleanupSpectrogramSelection() destroys overlay canvas to save memory');
        console.log('🔧 [0ms] v2.56 Feat: When page becomes visible, setupSpectrogramSelection() recreates canvas and redrawAllCanvasFeatureBoxes() restores features');
        console.log('🎵 [0ms] v2.56 Note: Audio playback continues in background (cancelAllRAFLoops only stops visual animations, not audio)');
        console.log('🌋 [0ms] volcano-audio v2.55 - Critical Bug Fixes: Region Persistence & Button States');
        console.log('🐛 [0ms] v2.55 Fix: MAJOR - Regions/features now persist after page refresh (were being saved but not loaded)');
        console.log('🐛 [0ms] v2.55 Fix: CRITICAL - Timestamp filtering now uses absolute times instead of relative samples (prevented regions from loading across different time ranges)');
        console.log('🐛 [0ms] v2.55 Fix: Complete button click handler now correctly set for returning users (was opening wrong modal)');
        console.log('🔧 [0ms] v2.55 Refactor: Unified updateCompleteButtonState() to handle both Begin Analysis and Complete modes (eliminated duplicate functions)');
        console.log('🔍 [0ms] v2.55 Feat: Enhanced error logging - all errors now logged to console with full stack traces before reporting');
        console.log('🎓 [0ms] v2.55 Feat: Added study_tutorial_in_progress flag to properly track tutorial lifecycle');
        console.log('🎨 [0ms] v2.55 Feat: Added "This is a spectrogram" intro message to tutorial before time/frequency explanation');
        console.log('🔒 [0ms] v2.55 Fix: Removed "Skip" option from Tutorial Introduction modal');
        console.log('🛡️ [0ms] v2.55 Fix: Added emergency overlay canvas recovery for stuck states');
        console.log('🌋 [0ms] volcano-audio v2.54 - Stuck State Fix & UI Improvements');
        console.log('🔧 [0ms] v2.54 Fix: Fixed stuck state after sleep mode - added aggressive state reset, overlay context recovery, and safeguard message');
        console.log('🎨 [0ms] v2.54 Feat: Changed feature selection instructions from "(f) key" to "click and drag"');
        console.log('🎨 [0ms] v2.54 Feat: Pre-survey modal now shows "Welcome back!" for returning visitors');
        console.log('🌋 [0ms] volcano-audio v2.53 - Modal UX Improvements');
        console.log('🔧 [0ms] v2.53 Fix: Disabled click-outside-to-close for all modals - clicks outside modal area are now completely ignored');
        console.log('🎨 [0ms] v2.53 Feat: Dynamic participant modal text - shows different messages based on context (initial setup vs upper right corner click, Qualtrics transfer vs manual entry)');
        console.log('🌋 [0ms] volcano-audio v2.52 - Bug Fix: Keyboard Event Handlers');
        console.log('🔧 [0ms] v2.52 Fix: Added guard clauses to handleSecretKeyListener and handleDebugJumpListener to prevent TypeError when e.key is undefined');
        console.log('🌋 [0ms] volcano-audio v2.51 - UI Polish & Tutorial Improvements');
        console.log('🎨 [0ms] v2.51 UI: Fixed waveform-x-axis max-width to match other canvases, unified participant ID text box styling with dark background and reddish hover');
        console.log('🎓 [0ms] v2.51 UI: Added ↘️ emoji to volume adjustment tutorial message for better visual guidance');
        console.log('🌋 [0ms] volcano-audio v2.50 - Spectrogram Playhead Overlay & UI Polish');
        console.log('🎨 [0ms] v2.50 Refactor: Spectrogram playhead now uses dedicated transparent overlay canvas - eliminates complex background restoration, much simpler rendering, better performance');
        console.log('🎨 [0ms] v2.50 UI: Updated top panel colors - selection panel #9a9a9a, playback panel #a8a8a8 with healthy gradients');
        console.log('🎨 [0ms] v2.50 UI: Reduced waveform playhead white line opacity for subtler appearance');
        console.log('✨ [0ms] v2.50 UI: Fetch Data button now pulses brighter on load for better visibility');
        console.log('🌋 [0ms] volcano-audio v2.49 - Pure Canvas Feature Boxes');
        console.log('🎨 [0ms] v2.49 Refactor: Replaced DOM-based orange feature boxes with pure canvas rendering - eliminates appendChild() circular event issues, adds smooth interpolation during scale/zoom transitions, auto-syncs with feature array for deletion/renumbering');
        console.log('🌋 [0ms] volcano-audio v2.47 - Feature Box Positioning and Synchronization');
        console.log('🎯 [0ms] v2.47 Refactor: Feature box positioning and synchronization - achieved perfect harmony between DOM and canvas');
        console.log('🌋 [0ms] volcano-audio v2.46 - Spectrogram Feature Selection Bug Fix');
        console.log('🐛 [0ms] v2.46 Fix: Spectrogram feature selection bug - changed mouseup listener from document to canvas to prevent ghost clicks when browser loses focus');
        console.log('🌋 [0ms] volcano-audio v2.45 - Study Mode Region Creation Fix');
        console.log('🎓 [0ms] v2.45 Fix: Enable region creation BEFORE tutorial starts - allows waveform clicks during tutorial in study mode');
        console.log('🌋 [0ms] volcano-audio v2.44 - Quick-fill Button Toggle');
        console.log('🎓 [0ms] v2.44 Feat: Quick-fill button toggle function - disable in STUDY mode, enable in STUDY_CLEAN/DEV/PERSONAL modes');
        console.log('🌋 [0ms] volcano-audio v2.41 - Tutorial Region Button Enable Fix');
        console.log('🎓 [0ms] v2.41 Fix: Enable all region buttons after zoom out in tutorial - allows full interaction when creating second region');
        console.log('🌋 [0ms] volcano-audio v2.40 - Tutorial Message Improvements');
        console.log('🎓 [0ms] v2.40 UI: Added 10-second timeout for feature description submission');
        console.log('🎓 [0ms] v2.40 UI: Changed feature description detection from Enter key to change event for better reliability');
        console.log('🎓 [0ms] v2.40 UI: Updated tutorial messages - "The spectrogram now shows more detail", "let\'s explore", "Click and drag"');
        console.log('🎓 [0ms] v2.40 UI: Adjusted tutorial timing - spectrogram detail message 6s, change mind message 9s');
        console.log('🌋 [0ms] volcano-audio v2.38 - Tutorial Starts Before Fetch Data Message');
        console.log('🎓 [0ms] v2.38 Feat: Tutorial now starts immediately on page load, before "Select a volcano and click Fetch Data" message');
        console.log('🎓 [0ms] v2.38 Feat: Frequency scale dropdown disabled right at the start of tutorial before anything else');
        console.log('🎓 [0ms] v2.38 Feat: Fetching data is now part of the tutorial flow - tutorial guides user through entire process');
        console.log('🌋 [0ms] volcano-audio v2.37 - Memory Leak Fixes');
        console.log('🧹 [0ms] v2.37 Fix: Memory leak fixes - ResizeObserver cleanup, event listener accumulation prevention, setTimeout chain cleanup');
        console.log('🧹 [0ms] v2.37 Fix: ResizeObserver in tutorial overlay now properly disconnected to prevent memory leaks');
        console.log('🧹 [0ms] v2.37 Fix: Event listeners in spectrogram-renderer and keyboard-shortcuts now tracked and cleaned up');
        console.log('🧹 [0ms] v2.37 Fix: setTimeout chains in waitForPlaybackResume now properly tracked and cleaned up');
        console.log('🧹 [0ms] v2.37 Fix: Window properties cleaned up on tutorial completion');
        console.log('🌋 [0ms] volcano-audio v2.36 - Tutorial System Refactoring with Async/Await');
        console.log('🌋 [0ms] volcano-audio v2.43 - Auto-detect Environment & Force Study Mode Online');
        console.log('🌐 [0ms] v2.43 Feat: Auto-detect local vs production - force STUDY mode online, allow mode switching locally');
        console.log('🌋 [0ms] volcano-audio v2.42 - Begin Analysis Button with Sparkle Effect');
        console.log('✨ [0ms] v2.42 Feat: Begin Analysis button with sparkle effect and confirmation modal - enables after data download, disables volcano switching after confirmation');
        console.log('🎓 [0ms] v2.36 Refactor: Complete tutorial system refactored to use elegant async/await pattern with skippable waits');
        console.log('🎓 [0ms] v2.36 Feat: Pause button tutorial now uses async/await - cleaner code, skippable waits, better flow');
        console.log('🎓 [0ms] v2.36 Feat: Speed slider tutorial refactored to async/await - linear flow, skippable waits, dynamic speed updates');
        console.log('🎓 [0ms] v2.36 Feat: Spectrogram explanation expanded - "This is a spectrogram of the data", time flow, frequency explanation');
        console.log('🎓 [0ms] v2.36 Fix: Speed message updates dynamically without retyping - only speed value changes');
        console.log('🎓 [0ms] v2.36 Fix: Emoji rendering fixed - proper Unicode handling prevents bullet rendering');
        console.log('🎓 [0ms] v2.36 Fix: "Great!" message triggers immediately when crossing 1x speed threshold');
        console.log('🌋 [0ms] volcano-audio v2.28 - Keyboard Shortcuts & Performance Optimizations');
        console.log('⌨️ [0ms] v2.28 Feat: Added keyboard shortcuts - number keys (1-9) zoom/play regions, f key for features, r key to confirm region, c/v/b for frequency scales, Escape to zoom out');
        console.log('⚡ [0ms] v2.28 Perf: Optimized color LUT - computed once and cached for reuse, faster spectrogram rendering');
        console.log('⚡ [0ms] v2.28 Perf: Faster frequency scale transitions - axis ticks 400ms, spectrogram rendering starts immediately in parallel');
        console.log('🧹 [0ms] v2.28 Cleanup: Commented out verbose console logs for cleaner console output');
        console.log('🌋 [0ms] volcano-audio v2.27 - Feature Box Positioning & RAF Loop Fixes');
        console.log('🔧 [0ms] v2.27 Fix: Feature box positioning - use direct zoom state instead of interpolated time range');
        console.log('🔧 [0ms] v2.27 Fix: Infinite RAF loop - prevent multiple RAF loops when drawWaveformXAxis called from multiple places');
        console.log('🌋 [0ms] volcano-audio v2.26 - Feature Persistence Proof of Concept');
        console.log('📦 [0ms] v2.26 Proof of concept: Feature persistence - persistent DOM boxes on spectrogram using eternal coordinates');
        console.log('🌋 [0ms] volcano-audio v2.24 - X-Axis Tick Improvements & Cache Fix');
        console.log('🕐 [0ms] v2.24 Feat: Added 30-minute tick intervals for regions less than 6 hours');
        console.log('🔧 [0ms] v2.24 Fix: Clear waveform cache immediately on resize to prevent stretching');
        console.log('📏 [0ms] v2.24 Fix: Initialize maxCanvasWidth baseline (1200px) on page load for proper tick spacing');
        console.log('🌋 [0ms] volcano-audio v2.22 - Master Pause Region Button Fix');
        console.log('⏸️ [0ms] v2.22 Fix: Master pause button now toggles all region play buttons to red state');
        console.log('🌋 [0ms] volcano-audio v2.18 - Zoom State Reset Fix');
        console.log('🔄 [0ms] v2.18 Fix: Reset zoom state when loading new data - prevents playhead rendering issues when switching volcanoes while zoomed into a region');
        console.log('🌋 [0ms] volcano-audio v2.17 - Spacebar Play/Pause Fix');
        console.log('⌨️ [0ms] v2.17 Fix: Spacebar play/pause now mirrors button behavior exactly - removed auto-selection logic that was causing issues');
        console.log('🌋 [0ms] volcano-audio v2.16 - Spectrogram Regions & Selections');
        console.log('🎨 [0ms] v2.16 Feat: Spectrogram now shows regions and selections - lightweight blue highlights (15%/8% opacity) and yellow selection boxes (8%/35% opacity), fade out when zooming into regions');
        console.log('🌋 [0ms] volcano-audio v2.15 - Waveform Zoom-Out & Zoom Button Click Fix');
        console.log('🔍 [0ms] v2.15 Fix: Waveform zoom-out now uses cached full waveform (like spectrogram) for instant visual feedback');
        console.log('🖱️ [0ms] v2.15 Fix: Zoom button clicks on canvas no longer trigger scrub preview/playhead');
        console.log('🌋 [0ms] volcano-audio v2.10 - Hourglass Button Spacebar Fix');
        console.log('⌨️ [0ms] v2.10 UI: Fixed hourglass button to allow spacebar play/pause after clicking - zoom buttons no longer capture spacebar');
        console.log('🧹 [0ms] v2.09 Memory: Fixed ArrayBuffer retention by copying slices when storing in allReceivedData, clearing allReceivedData after stitching to break RAF closure chain');
        console.log('🧹 [0ms] v2.08 Memory: Added page unload/visibility handlers to cancel RAF, improved modal cleanup, added cancelScaleTransitionRAF');
        console.log('🎨 [0ms] v2.07 UI: Added 0.1Hz ticks at 10x speed, adjusted padding, semi-transparent dropdowns');
        console.log('🔇 [0ms] Commented out worklet message logging to reduce console noise');
    }
    
    // Start memory health monitoring
    startMemoryMonitoring();
    
    // ═══════════════════════════════════════════════════════════
    // 🚨 STUDY MODE: Show overlay IMMEDIATELY to prevent UI interaction
    // ═══════════════════════════════════════════════════════════
    if (isStudyMode()) {
        const overlay = document.getElementById('permanentOverlay');
        if (overlay) {
            overlay.style.display = 'flex';
            overlay.style.opacity = '1';
            console.log('🌋 Volcano Audio - LIVE Production');
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
    
    initWaveformWorker();
    
    const sliderValueFor1x = calculateSliderForSpeed(1.0);
    document.getElementById('playbackSpeed').value = sliderValueFor1x;
    if (!isStudyMode()) {
        console.log(`Initialized playback speed slider at position ${sliderValueFor1x} for 1.0x speed`);
    }
    
    // Load saved volcano selection (or use default)
    await loadSavedVolcano();
    
    // ═══════════════════════════════════════════════════════════
    // 🎯 MODE-AWARE ROUTING
    // ═══════════════════════════════════════════════════════════
    
    // Small delay to let page settle before starting workflows
    setTimeout(async () => {
        await initializeApp();
        
        console.log('═══════════════════════════════════════════════════════════');
        console.log('✅ App ready');
        console.log('═══════════════════════════════════════════════════════════');
    }, 100);
    
    // Add event listeners
    document.getElementById('volcano').addEventListener('change', async (e) => {
        // Remove pulsing glow when user selects a volcano
        const volcanoSelect = document.getElementById('volcano');
        if (volcanoSelect) {
            volcanoSelect.classList.remove('pulse-glow');
        }
        const selectedVolcano = e.target.value;
        const volcanoWithData = State.volcanoWithData;
        
        // ✅ Switch to this volcano's regions (loads from localStorage if available)
        switchVolcanoRegions(selectedVolcano);
        
        // If switching back to the volcano that already has data, disable fetch button
        if (volcanoWithData && selectedVolcano === volcanoWithData) {
            const fetchBtn = document.getElementById('startBtn');
            fetchBtn.disabled = true;
            fetchBtn.title = 'This volcano already has data loaded. Select a different volcano to fetch new data.';
            console.log(`🚫 Fetch button disabled - ${selectedVolcano} already has data`);
        } else {
            // Switching to a different volcano - enable fetch button
        enableFetchButton();
            const fetchBtn = document.getElementById('startBtn');
            if (fetchBtn) {
                fetchBtn.title = '';
            }
        }
        
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    document.getElementById('dataType').addEventListener('change', (e) => {
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
            if (isPersonalMode() && !hasPerformedFirstFetch) {
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
                        
                        // Regenerate cache at correct size
                        if (State.completeSamplesArray && State.completeSamplesArray.length > 0) {
                            if (State.waveformMinMaxData) {
                                drawWaveformFromMinMax();  // Regenerates cache at correct size
                                drawWaveformWithSelection();
                            }
                        }
                        
                        waveformResizeTimer = null;
                    }, 100);
                    
                    lastWaveformWidth = currentWidth;
                    lastWaveformHeight = currentHeight;
                }
            }

            // Update feature box positions after resize (boxes need to reposition for new canvas dimensions)
            import('./spectrogram-feature-boxes.js').then(module => {
                if (module.updateAllFeatureBoxPositions) {
                    module.updateAllFeatureBoxPositions();
                }
            }).catch(() => {
                // Module not loaded yet, that's okay
            });

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
    
    // 🎯 SETUP EVENT LISTENERS (replaces onclick handlers to prevent memory leaks)
    // All event listeners are properly scoped and don't create permanent closures on window.*
    
    // Cache & Download
    document.getElementById('purgeCacheBtn').addEventListener('click', purgeCloudflareCache);
    document.getElementById('downloadBtn').addEventListener('click', downloadAudio);
    
    // Station Selection
    document.getElementById('volcano').addEventListener('change', (e) => {
        loadStations();
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    document.getElementById('dataType').addEventListener('change', (e) => {
        updateStationList();
        e.target.blur(); // Blur so spacebar can toggle play/pause
    });
    
    // Data Fetching
    document.getElementById('startBtn').addEventListener('click', (e) => {
        startStreaming(e);
    });
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
        
        // Disable play on click checkbox after Begin Analysis is confirmed
        const playOnClickCheckbox = document.getElementById('playOnClick');
        if (playOnClickCheckbox) {
            playOnClickCheckbox.checked = false;
            playOnClickCheckbox.disabled = true;
            console.log('✅ Play on click disabled after Begin Analysis confirmation');
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
        
        // Disable volcano switching after confirmation
        const volcanoSelect = document.getElementById('volcano');
        if (volcanoSelect) {
            volcanoSelect.disabled = true;
            volcanoSelect.style.opacity = '0.6';
            volcanoSelect.style.cursor = 'not-allowed';
            console.log('🔒 Volcano switching disabled after Begin Analysis confirmation');
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
        console.log('✅ Participant ID display click handler attached');
    } else {
        console.warn('⚠️ Participant ID display element not found when attaching click handler');
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
        console.log('✅ Tutorial help button click handler attached');
    } else {
        console.warn('⚠️ Tutorial help button not found in DOM');
    }
    
    if (!isStudyMode()) {
        console.log('✅ Event listeners setup complete - memory leak prevention active!');
    }
    
    // 🔥 FIX: Cancel all RAF callbacks on page unload to prevent detached document leaks
    // This ensures RAF callbacks scheduled before page unload are cancelled
    // 🔥 FIX: Use static imports instead of dynamic imports to prevent Context leaks
    // Dynamic imports create new Context instances each time, causing massive memory leaks
    // Since waveform-x-axis-renderer.js is already imported statically at the top, use it directly
    if (!window._volcanoAudioCleanupHandlers) {
        window._volcanoAudioCleanupHandlers = {};
        
        // Import only modules that aren't already statically imported
    import('./audio-player.js').then(audioPlayerModule => {
        import('./spectrogram-axis-renderer.js').then(axisModule => {
                // 🔥 FIX: Use statically imported functions instead of dynamic import
                // This prevents creating new Context instances (147k+ Context leak!)
                const cleanupOnUnload = () => {
                    // Call synchronously - modules are already loaded
                    audioPlayerModule.cancelAllRAFLoops();
                    axisModule.cancelScaleTransitionRAF();
                    // Use statically imported function instead of dynamic import
                    cancelZoomTransitionRAF();
                    
                    // 🔥 FIX: Cleanup event listeners to prevent memory leaks
                    // Use statically imported functions to avoid creating new Context instances
                    cleanupSpectrogramSelection();
                    cleanupKeyboardShortcuts();
                };
                window._volcanoAudioCleanupHandlers.cleanupOnUnload = cleanupOnUnload;
            
                // 🔥 FIX: Only set window.stopZoomTransition once to prevent function accumulation
                // Use statically imported function instead of dynamic import
                if (!window.stopZoomTransition) {
                    window.stopZoomTransition = stopZoomTransition;
                }
            
                // 🔥 FIX: Remove old listeners before adding new ones to prevent accumulation
                // Use stored reference so removeEventListener can match
                if (window._volcanoAudioCleanupHandlers.beforeunload) {
                    window.removeEventListener('beforeunload', window._volcanoAudioCleanupHandlers.beforeunload);
                }
                if (window._volcanoAudioCleanupHandlers.pagehide) {
                    window.removeEventListener('pagehide', window._volcanoAudioCleanupHandlers.pagehide);
                }
                window.addEventListener('beforeunload', cleanupOnUnload);
                window._volcanoAudioCleanupHandlers.beforeunload = cleanupOnUnload;
                
                // Also handle pagehide (more reliable than beforeunload in some browsers)
                window.addEventListener('pagehide', cleanupOnUnload);
                window._volcanoAudioCleanupHandlers.pagehide = cleanupOnUnload;
                
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
                        import('./spectrogram-renderer.js').then(module => {
                            if (module.redrawAllCanvasFeatureBoxes) {
                                module.redrawAllCanvasFeatureBoxes();
                            }
                        }).catch(() => {
                            // Module not loaded yet
                        });
                        
                        // Restart playhead if playing when tab becomes visible again
                        if (State.playbackState === PlaybackState.PLAYING) {
                            startPlaybackIndicator();
                        }
                    }
                };
                if (window._volcanoAudioCleanupHandlers.visibilitychange) {
                    document.removeEventListener('visibilitychange', window._volcanoAudioCleanupHandlers.visibilitychange);
                }
                document.addEventListener('visibilitychange', visibilityChangeHandler);
                window._volcanoAudioCleanupHandlers.visibilitychange = visibilityChangeHandler;
                });
            });
    }
});

