/**
 * audio-worklet-init.js
 * AudioWorklet initialization: creates AudioContext, loads worklet processors,
 * wires up the audio graph, and handles worklet port messages.
 */

import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { updatePlaybackSpeed, primeStretchProcessors, cancelAllRAFLoops } from './audio-player.js';
import { drawWaveformWithSelection, startPlaybackIndicator } from './minimap-window-renderer.js';
import { isStudyMode } from './master-modes.js';
import { setStatusText } from './tutorial-effects.js';

// Helper functions
function formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}m ${secs}s`;
}

function updateCurrentPositionFromSamples(samplesConsumed, totalSamples) {
    // Check document connection first to prevent detached document leaks
    if (!document.body || !document.body.isConnected) {
        return;
    }

    // Access State.currentMetadata only when needed, don't retain reference
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
    // Check document connection first to prevent detached document leaks
    if (!document.body || !document.body.isConnected) {
        return;
    }

    // Access State only when needed, don't retain reference
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
    // console.log('Started oscilloscope data collection from analyser node (post-volume)');
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


// Initialize AudioWorklet
export async function initAudioWorklet() {
    // Clear old worklet message handler before creating new one
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

    // Disconnect old analyser node to prevent memory leak
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
            // console.log('Oscilloscope visualization initialized');
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
            // Buffer status report from worklet
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

            // Use accessor that handles both Float32 and compressed Int16
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
            // FAST LOOP: Worklet wrapped readIndex without clearing buffer
            // Fades are now handled inside worklet (sample-accurate, no jitter!)
            const { position } = event.data;
            State.setCurrentAudioPosition(position);
            State.setLastWorkletPosition(position);
            State.setLastWorkletUpdateTime(State.audioContext.currentTime);
        } else if (type === 'loop-ready') {
            // Worklet has cleared buffer and is ready to loop from target position
            const { targetSample } = event.data;
            // console.log(`[LOOP-READY] Re-sending samples from ${targetSample.toLocaleString()} (loop restart)`);

            // Use accessor that handles both Float32 and compressed Int16
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

                // console.log(`[LOOP-READY] Sent ${(totalSamplesCount - targetSample).toLocaleString()} samples from ${newPositionSeconds.toFixed(2)}s, will auto-resume`);
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
            // console.log(`[FINISHED] Buffer empty: ${finishedTotalSamples.toLocaleString()} samples @ ${speed.toFixed(2)}x speed`);

            // Copy State values to local variables to break closure chain
            const isLooping = State.isLooping;
            const allReceivedData = State.allReceivedData;

            if (isLooping && allReceivedData && allReceivedData.length > 0) {
                // AUTONOMOUS: Loop is handled by worklet, but if we get 'finished' it means
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

                // Notify oscilloscope that playback started (for flame effect fade)
                import('./oscilloscope-renderer.js').then(({ setPlayingState }) => {
                    setPlayingState(true);
                });

                if (State.totalAudioDuration > 0) {
                    startPlaybackIndicator();
                }
            } else {
                // Playback finished - worklet already handled fade-out
                // Cancel animation frame loops to prevent memory leaks
                cancelAllRAFLoops();

                State.setPlaybackState(PlaybackState.STOPPED);

                // Notify oscilloscope that playback stopped (for flame effect fade)
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
