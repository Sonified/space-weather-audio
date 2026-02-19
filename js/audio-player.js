/**
 * audio-player.js
 * Playback controls: play/pause, speed, volume, loop, seek
 */

// ===== DEBUG FLAGS =====
const DEBUG_LOOP_FADES = true; // Enable loop fade logging

import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { drawWaveformWithSelection, updatePlaybackIndicator, startPlaybackIndicator } from './waveform-renderer.js';
import { updateAxisForPlaybackSpeed } from './spectrogram-axis-renderer.js';
import { drawSpectrogram, startVisualization, redrawAllCanvasFeatureBoxes } from './spectrogram-renderer.js';
import { updateActiveRegionPlayButton, getActivePlayingRegionIndex, getCurrentRegions } from './region-tracker.js';
import { zoomState } from './zoom-state.js';
import { getCurrentPlaybackBoundaries, isAtBoundaryEnd, getRestartPosition, formatBoundaries } from './playback-boundaries.js';
import { setPlayingState } from './oscilloscope-renderer.js';
import { updateSpectrogramViewport } from './spectrogram-three-renderer.js';
import { updateAllFeatureBoxPositions } from './spectrogram-feature-boxes.js';

// ===== RAF CLEANUP HELPER =====

/**
 * Cancel all active animation frame loops
 * Prevents memory leaks from closure chains
 */
// 🔥 FIX: Store resizeRAF reference so it can be cancelled
let resizeRAFRef = null;

export function setResizeRAFRef(raf) {
    resizeRAFRef = raf;
}

export function cancelAllRAFLoops() {
    if (State.playbackIndicatorRAF !== null) {
        cancelAnimationFrame(State.playbackIndicatorRAF);
        State.setPlaybackIndicatorRAF(null);
        // console.log('🧹 Cancelled playback indicator RAF');
    }
    if (State.spectrogramRAF !== null) {
        cancelAnimationFrame(State.spectrogramRAF);
        State.setSpectrogramRAF(null);
        console.log('🧹 Cancelled spectrogram RAF');
    }
    // 🔥 FIX: Cancel resize RAF to prevent detached callback leaks
    if (resizeRAFRef !== null) {
        cancelAnimationFrame(resizeRAFRef);
        resizeRAFRef = null;
        console.log('🧹 Cancelled resize RAF');
    }
    // 🔥 FIX: Cancel crossfade animation RAF if active
    if (State.crossfadeAnimation !== null) {
        cancelAnimationFrame(State.crossfadeAnimation);
        State.setCrossfadeAnimation(null);
        // console.log('🧹 Cancelled crossfade animation RAF');
    }
    
    // 🔥 FIX: Cancel scale transition RAF if active
    // Note: This is handled separately via direct import in main.js unload handlers
    // to avoid async import issues during page unload
}

// ===== CENTRALIZED PLAYBACK CONTROL =====

/**
 * Start playback (or resume if paused)
 * This is THE function for starting/resuming playback
 */
export async function startPlayback() {
    console.log(`🔊 [startPlayback] ENTER - AudioContext state: ${State.audioContext?.state}, workletNode: ${State.workletNode ? 'exists' : 'null'}`);

    State.setPlaybackState(PlaybackState.PLAYING);

    console.log('▶️ Starting playback');

    // 🔥 Notify oscilloscope that playback started (for flame effect fade)
    setPlayingState(true);

    // 🎓 Tutorial: Resolve promise if waiting for region play or resume
    if (State.waitingForRegionPlayOrResume && State._regionPlayOrResumeResolve) {
        State.setWaitingForRegionPlayOrResume(false);
        State.setWaitingForRegionPlayClick(false);
        const resolve = State._regionPlayOrResumeResolve;
        State.setRegionPlayOrResumeResolve(null);
        State.setRegionPlayClickResolve(null);
        resolve();
    }

    // Update master button
    const btn = document.getElementById('playPauseBtn');
    btn.textContent = '⏸️ Pause';
    btn.classList.remove('play-active', 'pulse-play', 'pulse-resume', 'pulse-attention');
    btn.classList.add('pause-active');

    // 🔗 FIX: Resume AudioContext BEFORE telling worklet to play
    // audioContext.resume() is async - must await it or worklet won't process!
    if (State.audioContext?.state === 'suspended') {
        console.log('🔊 [startPlayback] AudioContext is SUSPENDED - awaiting resume...');
        await State.audioContext.resume();
        console.log(`🔊 [startPlayback] AudioContext RESUMED - state: ${State.audioContext.state}`);
    } else {
        console.log(`🔊 [startPlayback] AudioContext already running - state: ${State.audioContext?.state}`);
    }

    // 🏎️ AUTONOMOUS: Just tell worklet/stretch to play - it handles fade-in automatically
    console.log('🔊 [startPlayback] Sending play message to worklet');
    if (State.stretchActive && State.stretchNode) {
        State.stretchNode.port.postMessage({ type: 'play' });
        State.setStretchStartTime(State.audioContext.currentTime);
    } else {
        State.workletNode?.port.postMessage({ type: 'play' });
    }

    // Restart playback indicator
    if (State.audioContext && State.totalAudioDuration > 0) {
        State.setLastUpdateTime(State.audioContext.currentTime);
        startPlaybackIndicator();
    }

    // Update active region button
    updateActiveRegionPlayButton(true);

    // 🔗 Shared session: Show zoom hint on first play (only once)
    const isSharedSession = sessionStorage.getItem('isSharedSession') === 'true';
    const sharedSessionHintShown = sessionStorage.getItem('sharedSessionHintShown') === 'true';
    if (isSharedSession && !sharedSessionHintShown) {
        sessionStorage.setItem('sharedSessionHintShown', 'true');
        setTimeout(async () => {
            const statusDiv = document.getElementById('status');
            if (statusDiv) {
                statusDiv.className = 'status';
                const { typeText } = await import('./tutorial-effects.js');
                typeText(statusDiv, 'Press the region # on your keyboard or click the 🔍 to ZOOM IN', 30, 10);
            }
        }, 2000);
    }

    console.log('🔊 [startPlayback] EXIT');
}

/**
 * Pause playback
 * This is THE function for pausing
 */
export function pausePlayback() {
    State.setPlaybackState(PlaybackState.PAUSED);
    
    console.log('⏸️ Pausing playback');
    
    // 🔥 Notify oscilloscope that playback paused (for flame effect fade)
    setPlayingState(false);
    
    // 🔥 FIX: Cancel animation frame loops to prevent memory leaks
    cancelAllRAFLoops();
    
    // 🏎️ AUTONOMOUS: Just tell worklet/stretch to pause - it handles fade-out automatically
    if (State.stretchActive && State.stretchNode) {
        State.stretchNode.port.postMessage({ type: 'pause' });
        // Lock in current position for resume using getCurrentPosition()
        if (State.audioContext) {
            State.setStretchStartPosition(getCurrentPosition());
        }
    } else {
        State.workletNode?.port.postMessage({ type: 'pause' });
    }
    
    // Update master button
    const btn = document.getElementById('playPauseBtn');
    btn.textContent = '▶️ Resume';
    btn.classList.remove('pause-active', 'pulse-play');
    btn.classList.add('play-active', 'pulse-resume');
    
    // Update status
    import('./tutorial.js').then(({ setStatusText }) => {
        setStatusText('Audio playback paused', 'status');
    });
    
    // Update active region button
    updateActiveRegionPlayButton(false);
}

// ===== SIMPLIFIED TOGGLEPLAYPAUSE =====

/**
 * Check if playhead is outside region boundaries when zoomed into a region
 * Returns the region start position if outside, null if inside or not zoomed in
 */
function getRegionStartIfOutside() {
    // Only check if zoomed into a region
    if (!zoomState.isInRegion()) {
        return null;
    }
    
    const b = getCurrentPlaybackBoundaries();
    const currentPos = State.currentAudioPosition;
    
    // Check if playhead is outside region boundaries
    if (currentPos < b.start || currentPos > b.end) {
        return b.start;
    }
    
    return null;
}

export function togglePlayPause() {
    const currentState = `playbackState=${State.playbackState}, position=${State.currentAudioPosition?.toFixed(2) || 0}s`;
    console.log(`🎵 [togglePlayPause] ENTER - ${currentState}, AudioContext: ${State.audioContext?.state}`);

    if (!State.audioContext) {
        console.log('🎵 [togglePlayPause] EXIT - No AudioContext!');
        return;
    }

    switch (State.playbackState) {
        case PlaybackState.STOPPED:
            console.log('🎵 [togglePlayPause] Case: STOPPED');
            // Check if zoomed into region and playhead is outside
            const regionStart = getRegionStartIfOutside();
            if (regionStart !== null) {
                console.log(`▶️ Playhead outside region, jumping to region start at ${regionStart.toFixed(2)}s`);
                seekToPosition(regionStart, true);
                break;
            }

            const startPosition = isAtBoundaryEnd() ? getRestartPosition() : State.currentAudioPosition;
            console.log(`▶️ Starting playback from ${startPosition.toFixed(2)}s`);
            seekToPosition(startPosition, true);
            break;

        case PlaybackState.PLAYING:
            console.log('🎵 [togglePlayPause] Case: PLAYING → pause');
            console.log(`⏸️ Pausing playback`);
            pausePlayback();
            break;

        case PlaybackState.PAUSED:
            console.log('🎵 [togglePlayPause] Case: PAUSED → resume');
            // Check if zoomed into region and playhead is outside
            const regionStartPaused = getRegionStartIfOutside();
            if (regionStartPaused !== null) {
                console.log(`▶️ Playhead outside region, jumping to region start at ${regionStartPaused.toFixed(2)}s`);
                seekToPosition(regionStartPaused, true);
                break;
            }

            // Check if at end of current boundaries
            if (isAtBoundaryEnd()) {
                const restartPos = getRestartPosition();
                console.log(`▶️ At boundary end, restarting from ${restartPos.toFixed(2)}s`);
                seekToPosition(restartPos, true);
                break;
            }

            console.log(`▶️ Resuming playback from ${State.currentAudioPosition.toFixed(2)}s`);
            startPlayback();
            break;
    }
}

export function toggleLoop() {
    State.setIsLooping(!State.isLooping);
    const btn = document.getElementById('loopBtn');
    
    // 🎓 Tutorial: Resolve promise if waiting for loop button click
    if (State.waitingForLoopButtonClick && State._loopButtonClickResolve) {
        State.setWaitingForLoopButtonClick(false);
        const resolve = State._loopButtonClickResolve;
        State.setLoopButtonClickResolve(null);
        resolve();
    }
    
    if (State.isLooping) {
        btn.classList.remove('secondary');
        btn.classList.add('loop-active');
        btn.textContent = '🔁 Loop ON';
        console.log('🔁 Looping enabled');
    } else {
        btn.classList.remove('loop-active');
        btn.textContent = '🔁 Loop';
        console.log('🔁 Looping disabled');
    }
    
    // Update worklet with new loop state
    updateWorkletSelection();
    
    // Blur button so spacebar can still toggle play/pause
    btn.blur();
}

export function updateWorkletSelection() {
    if (!State.workletNode) return;
    
    const b = getCurrentPlaybackBoundaries();
    
    State.workletNode.port.postMessage({
        type: 'set-selection',
        start: b.start,
        end: b.end,
        loop: b.loop
    });
    
    // if (DEBUG_LOOP_FADES) {
    //     console.log(`📤 Sent to worklet: ${formatBoundaries(b)}`);
    // }
}

export function updatePlaybackSpeed() {
    const slider = document.getElementById('playbackSpeed');
    const value = parseFloat(slider.value);

    // Logarithmic mapping: 0-1000 -> 0.1-15, with 667 = 1.0
    let baseSpeed;
    if (value <= 667) {
        const normalized = value / 667;
        baseSpeed = 0.1 * Math.pow(10, normalized);
    } else {
        const normalized = (value - 667) / 333;
        baseSpeed = Math.pow(15, normalized);
    }

    // Display shows ONLY the slider value (not multiplied)
    document.getElementById('speedValue').textContent = baseSpeed.toFixed(2) + 'x';

    // Apply base sample rate multiplier to actual playback speed
    const multiplier = getBaseSampleRateMultiplier();
    const finalSpeed = baseSpeed * multiplier;

    // Store final speed for worklet and loop logic
    State.setCurrentPlaybackRate(finalSpeed);

    // Show/hide stretch algorithm dropdown based on speed
    const stretchContainer = document.getElementById('stretchAlgorithmContainer');
    if (stretchContainer) {
        stretchContainer.style.display = baseSpeed < 1.0 ? 'flex' : 'none';
    }

    // Stretch switching: sub-1x speed uses stretch processor, >= 1x uses seismic
    if (baseSpeed < 1.0 && State.completeSamplesArray) {
        const stretchFactor = 1 / baseSpeed;

        if (!State.stretchActive) {
            // Engage stretch processor
            engageStretch(stretchFactor);
        } else {
            // Already stretching — lock in position using OLD factor, then update
            if (State.playbackState === PlaybackState.PLAYING && State.audioContext) {
                const lockedPosition = getCurrentPosition(); // Uses State.stretchFactor (old value)
                State.setStretchStartPosition(lockedPosition);
                State.setStretchStartTime(State.audioContext.currentTime);
            }
            // Now update the factor in state and worklet
            State.setStretchFactor(stretchFactor);
            if (State.stretchNode) {
                State.stretchNode.port.postMessage({ type: 'set-stretch', data: { factor: stretchFactor } });
            }
        }
    } else if (baseSpeed >= 1.0 && State.stretchActive) {
        // Disengage stretch, return to seismic
        disengageStretch(finalSpeed);
    } else {
        // Normal seismic path (speed >= 1.0, no stretch active)
        if (State.workletNode) {
            State.workletNode.port.postMessage({
                type: 'set-speed',
                speed: finalSpeed
            });
        }
    }

    // Update spectrogram axis to reflect new playback speed
    updateAxisForPlaybackSpeed();

    // Update spectrogram viewport (works for both full and temple - GPU stretching!)
    updateSpectrogramViewport(finalSpeed);

    // Update feature box positions for new playback speed (horizontal stretching)
    updateAllFeatureBoxPositions();

    // Update canvas feature boxes too!
    redrawAllCanvasFeatureBoxes();
}

export function changePlaybackSpeed() {
    updatePlaybackSpeed();
    updatePlaybackDuration();
}

// ===== STRETCH PROCESSOR MANAGEMENT =====

const STRETCH_CROSSFADE_DURATION = 0.15; // 150ms crossfade

/**
 * Create a stretch AudioWorkletNode for the given algorithm.
 * Connects it to stretchGainNode (which is already wired to masterGain).
 */
function createStretchNode(algorithm) {
    // Disconnect old stretch node if exists
    if (State.stretchNode) {
        State.stretchNode.port.postMessage({ type: 'pause' });
        State.stretchNode.disconnect();
    }

    const processorName = algorithm === 'paul' ? 'paul-stretch-processor' : 'granular-stretch-processor';
    const stretchFactor = 1 / getBaseSpeed();
    const windowSize = 4096;

    let options;
    if (algorithm === 'paul') {
        options = {
            processorOptions: {
                windowSize,
                stretchFactor
            }
        };
    } else {
        options = {
            processorOptions: {
                stretchFactor,
                grainSize: windowSize,
                overlap: 0.75,
                scatter: 0.1
            }
        };
    }

    const node = new AudioWorkletNode(State.audioContext, processorName, options);
    node.connect(State.stretchGainNode);
    State.setStretchNode(node);

    // Listen for messages from stretch processor
    node.port.onmessage = (event) => {
        const { type } = event.data;
        if (type === 'loaded') {
            console.log('🎛️ Stretch processor: audio loaded');
            // If we have a pending seek + play, do it now
            if (node._pendingResume) {
                const { position, shouldPlay } = node._pendingResume;
                node.port.postMessage({ type: 'seek', data: { position } });
                State.setStretchStartPosition(position);
                if (shouldPlay) {
                    node.port.postMessage({ type: 'play' });
                    State.setStretchStartTime(State.audioContext.currentTime);
                }
                node._pendingResume = null;
            }
        } else if (type === 'ended') {
            console.log('🎛️ Stretch processor: playback ended');
            // Reset to beginning
            node.port.postMessage({ type: 'seek', data: { position: 0 } });
            State.setStretchStartPosition(0);

            if (State.isLooping) {
                node.port.postMessage({ type: 'play' });
                State.setStretchStartTime(State.audioContext.currentTime);
            } else {
                State.setPlaybackState(PlaybackState.STOPPED);
                setPlayingState(false);
                cancelAllRAFLoops();
                const btn = document.getElementById('playPauseBtn');
                btn.textContent = '▶️ Play';
                btn.classList.remove('pause-active');
                btn.classList.add('play-active');
            }
        }
    };

    return node;
}

/**
 * Get current baseSpeed from slider (without multiplier).
 */
function getBaseSpeed() {
    const slider = document.getElementById('playbackSpeed');
    const value = parseFloat(slider.value);
    if (value <= 667) {
        const normalized = value / 667;
        return 0.1 * Math.pow(10, normalized);
    } else {
        const normalized = (value - 667) / 333;
        return Math.pow(15, normalized);
    }
}

/**
 * Get the current playback position in seconds.
 * Works for both seismic and stretch paths.
 */
export function getCurrentPosition() {
    if (State.stretchActive && State.audioContext) {
        const elapsed = State.audioContext.currentTime - State.stretchStartTime;
        return State.stretchStartPosition + elapsed / State.stretchFactor;
    }
    return State.currentAudioPosition;
}

/**
 * Engage stretch processor (speed dropped below 1.0).
 * Crossfades from seismic to stretch.
 */
function engageStretch(stretchFactor) {
    if (!State.audioContext || !State.completeSamplesArray) return;

    const wasPlaying = State.playbackState === PlaybackState.PLAYING;
    const currentPosition = State.currentAudioPosition;

    console.log(`🎛️ Engaging stretch: factor=${stretchFactor.toFixed(1)}x, position=${currentPosition.toFixed(2)}s, playing=${wasPlaying}`);

    // Create stretch node for selected algorithm
    const algorithm = State.stretchAlgorithm;
    const node = createStretchNode(algorithm);

    // Send audio data to stretch processor
    node.port.postMessage({
        type: 'load-audio',
        data: { samples: Array.from(State.completeSamplesArray) }
    });

    // Queue seek + play after 'loaded' message arrives
    node._pendingResume = { position: currentPosition, shouldPlay: wasPlaying };

    // Crossfade: seismic out, stretch in
    const now = State.audioContext.currentTime;

    State.seismicGainNode.gain.setValueAtTime(1, now);
    State.seismicGainNode.gain.linearRampToValueAtTime(0, now + STRETCH_CROSSFADE_DURATION);

    State.stretchGainNode.gain.setValueAtTime(0, now);
    State.stretchGainNode.gain.linearRampToValueAtTime(1, now + STRETCH_CROSSFADE_DURATION);

    // Pause seismic after crossfade completes
    setTimeout(() => {
        if (State.stretchActive) {
            State.workletNode?.port.postMessage({ type: 'pause' });
        }
    }, STRETCH_CROSSFADE_DURATION * 1000 + 50);

    State.setStretchActive(true);
    State.setStretchFactor(stretchFactor);
    State.setStretchStartPosition(currentPosition);
    State.setStretchStartTime(State.audioContext.currentTime);
}

/**
 * Disengage stretch processor (speed returned to >= 1.0).
 * Crossfades from stretch back to seismic.
 */
function disengageStretch(finalSpeed) {
    if (!State.audioContext) return;

    // Calculate where the stretch processor currently is
    const currentPosition = getCurrentPosition();

    console.log(`🎛️ Disengaging stretch: position=${currentPosition.toFixed(2)}s, speed=${finalSpeed.toFixed(2)}`);

    // Seek seismic to the stretch processor's current position and resume
    const samplesPerRealSecond = State.currentMetadata?.playback_samples_per_real_second
                               || State.currentMetadata?.original_sample_rate
                               || 1200;
    // Set seismic speed first
    State.workletNode?.port.postMessage({ type: 'set-speed', speed: finalSpeed });

    // Seek seismic processor
    State.workletNode?.port.postMessage({
        type: 'seek',
        data: { position: currentPosition }
    });

    // Resume seismic if we were playing
    if (State.playbackState === PlaybackState.PLAYING) {
        State.workletNode?.port.postMessage({ type: 'play' });
    }

    // Crossfade: stretch out, seismic in
    const now = State.audioContext.currentTime;

    State.stretchGainNode.gain.setValueAtTime(1, now);
    State.stretchGainNode.gain.linearRampToValueAtTime(0, now + STRETCH_CROSSFADE_DURATION);

    State.seismicGainNode.gain.setValueAtTime(0, now);
    State.seismicGainNode.gain.linearRampToValueAtTime(1, now + STRETCH_CROSSFADE_DURATION);

    // Pause stretch processor after crossfade completes
    const stretchNode = State.stretchNode;
    setTimeout(() => {
        if (stretchNode && !State.stretchActive) {
            stretchNode.port.postMessage({ type: 'pause' });
        }
    }, STRETCH_CROSSFADE_DURATION * 1000 + 50);

    State.setStretchActive(false);
    State.setCurrentAudioPosition(currentPosition);
}

/**
 * Switch stretch algorithm while stretch is active.
 * Called when user changes the algorithm dropdown.
 */
export function switchStretchAlgorithm(algorithm) {
    State.setStretchAlgorithm(algorithm);

    // If stretch is currently active, swap to new algorithm with crossfade
    if (State.stretchActive && State.audioContext && State.completeSamplesArray) {
        const currentPosition = getCurrentPosition();
        const wasPlaying = State.playbackState === PlaybackState.PLAYING;
        const stretchFactor = 1 / getBaseSpeed();

        console.log(`🎛️ Switching stretch algorithm to ${algorithm}, position=${currentPosition.toFixed(2)}s`);

        // Store old node for crossfade
        const oldNode = State.stretchNode;

        // Create new node (connects to stretchGainNode)
        const newNode = createStretchNode(algorithm);
        newNode.port.postMessage({ type: 'set-stretch', data: { factor: stretchFactor } });

        // Send audio to new node
        newNode.port.postMessage({
            type: 'load-audio',
            data: { samples: Array.from(State.completeSamplesArray) }
        });

        // Queue resume after loaded
        newNode._pendingResume = { position: currentPosition, shouldPlay: wasPlaying };

        // Pause and disconnect old node
        if (oldNode) {
            setTimeout(() => {
                oldNode.port.postMessage({ type: 'pause' });
                oldNode.disconnect();
            }, 100);
        }

        State.setStretchStartPosition(currentPosition);
        State.setStretchStartTime(State.audioContext.currentTime);
    }
}

export function changeVolume() {
    const slider = document.getElementById('volumeSlider');
    const volume = parseFloat(slider.value) / 100;
    
    document.getElementById('volumeValue').textContent = volume.toFixed(2);
    
    if (State.gainNode) {
        // 🏎️ FERRARI: Direct volume control (constant gain, no time-based fades)
        // GainNode is ONLY for master volume, worklet handles all time-based fades
        State.gainNode.gain.value = volume;
    }
}


export function resetSpeedTo1() {
    const slider = document.getElementById('playbackSpeed');
    slider.value = 667;
    updatePlaybackSpeed();
    updatePlaybackDuration();
}

export function resetVolumeTo1() {
    const slider = document.getElementById('volumeSlider');
    slider.value = 100;
    changeVolume();
}

export function seekToPosition(targetPosition, shouldStartPlayback = false) {
    if (!State.audioContext || !State.workletNode || !State.completeSamplesArray || State.totalAudioDuration === 0) {
        console.log('❌ Cannot seek: audio not ready');
        return;
    }
    
    // Clamp position to current playback boundaries
    const b = getCurrentPlaybackBoundaries();
    targetPosition = Math.max(b.start, Math.min(targetPosition, b.end));
    
    // ============================================
    // THE FIX: Use playback_samples_per_real_second
    // ============================================
    // This tells us how many playback samples (44.1kHz) represent one real-world second
    const samplesPerRealSecond = State.currentMetadata?.playback_samples_per_real_second 
                               || State.currentMetadata?.original_sample_rate  // Legacy fallback
                               || 1200;  // Reasonable default
    
    console.log(`🎯 SEEK: Target=${targetPosition.toFixed(2)}s`);
    console.log(`   samplesPerRealSecond: ${samplesPerRealSecond.toFixed(2)}`);
    console.log(`   totalAudioDuration: ${State.totalAudioDuration.toFixed(2)}s`);
    
    // Convert real-world seconds to playback sample index
    const targetSample = Math.floor(targetPosition * samplesPerRealSecond);
    console.log(`   targetSample: ${targetSample.toLocaleString()} (${targetPosition.toFixed(2)}s × ${samplesPerRealSecond.toFixed(2)})`);
    
    // Set flag to prevent race condition in region finish detection
    State.setJustSeeked(true);
    
    const wasPlaying = State.playbackState === PlaybackState.PLAYING;
    
    const performSeek = () => {
        // Update position tracking
        State.setCurrentAudioPosition(targetPosition);
        State.setLastWorkletPosition(targetPosition);
        State.setLastWorkletUpdateTime(State.audioContext.currentTime);
        State.setLastUpdateTime(State.audioContext.currentTime);
        
        // 🏎️ AUTONOMOUS: Tell the active processor to seek
        if (State.stretchActive && State.stretchNode) {
            State.stretchNode.port.postMessage({ type: 'seek', data: { position: targetPosition } });
            State.setStretchStartPosition(targetPosition);
            State.setStretchStartTime(State.audioContext.currentTime);
        } else {
            State.workletNode.port.postMessage({
                type: 'seek',
                position: targetPosition  // Send position in seconds, worklet converts to samples
            });
        }
        
        // if (DEBUG_LOOP_FADES) {
        //     console.log(`🎯 SEEK: Position ${targetPosition.toFixed(2)}s (${targetSample.toLocaleString()} samples), wasPlaying=${wasPlaying}`);
        // }
        
        // Check audio flow after a delay for debugging
        if (DEBUG_LOOP_FADES) {
            setTimeout(() => {
                // Double-check audio is actually flowing
                if (State.analyserNode) {
                    const dataArray = new Float32Array(State.analyserNode.fftSize);
                    State.analyserNode.getFloatTimeDomainData(dataArray);
                    let nonZero = 0;
                    for (let i = 0; i < dataArray.length; i++) {
                        if (Math.abs(dataArray[i]) > 0.001) nonZero++;
                    }
                    // console.log(`🔊 ANALYSER CHECK: ${nonZero}/${dataArray.length} non-zero samples in analyser`);
                }
            }, 15); // Check 15ms later
        }
        
        // 🏎️ AUTONOMOUS: If we want to start playback, tell worklet to play
        // (It will handle fade-in automatically if needed)
        if (shouldStartPlayback) {
            State.setPlaybackState(PlaybackState.PLAYING);

            // 🔥 Notify oscilloscope that playback started (for flame effect fade)
            setPlayingState(true);

            // Update play/pause button to show "Pause"
            const btn = document.getElementById('playPauseBtn');
            btn.textContent = '⏸️ Pause';
            btn.classList.remove('play-active', 'pulse-play', 'pulse-resume', 'pulse-attention');
            btn.classList.add('pause-active');

            // 🔗 FIX: Resume AudioContext BEFORE telling worklet to play!
            if (State.audioContext?.state === 'suspended') {
                console.log('🔊 [seekToPosition] AudioContext SUSPENDED - resuming...');
                State.audioContext.resume().then(() => {
                    console.log('🔊 [seekToPosition] AudioContext RESUMED, sending play');
                    if (State.stretchActive && State.stretchNode) {
                        State.stretchNode.port.postMessage({ type: 'play' });
                        State.setStretchStartTime(State.audioContext.currentTime);
                    } else {
                        State.workletNode.port.postMessage({ type: 'play' });
                    }
                });
            } else {
                console.log('🔊 [seekToPosition] AudioContext already running, sending play');
                if (State.stretchActive && State.stretchNode) {
                    State.stretchNode.port.postMessage({ type: 'play' });
                    State.setStretchStartTime(State.audioContext.currentTime);
                } else {
                    State.workletNode.port.postMessage({ type: 'play' });
                }
            }
        }
        
        // Ensure playback indicator continues if playing
        if (State.playbackState === PlaybackState.PLAYING) {
            startPlaybackIndicator();
        }
        
        // Clear the justSeeked flag after a brief delay to allow position to update
        setTimeout(() => {
            State.setJustSeeked(false);
        }, 100);
    };
    
    // 🏎️ FERRARI: Perform seek immediately - worklet handles fades internally!
    performSeek();
    
    // Update status text (disabled per user request)
    // const targetMinutes = Math.floor(targetPosition / 60);
    // const targetSeconds = (targetPosition % 60).toFixed(1);
    // const status = document.getElementById('status');
    // status.className = 'status info';
    // status.textContent = `✅ Seeking to ${targetMinutes}:${targetSeconds.padStart(4, '0')}`;
}

// Helper functions
function getBaseSampleRateMultiplier() {
    const baseSampleRateSelect = document.getElementById('baseSampleRate');
    const selectedRate = parseFloat(baseSampleRateSelect.value);
    return selectedRate / 44100;
}

function updatePlaybackDuration() {
    // 🔥 FIX: Check document connection before DOM manipulation
    if (!document.body || !document.body.isConnected) {
        return;
    }
    
    // 🔥 FIX: Copy State values to local variables to avoid closure retention
    // Access State only once and copy values immediately
    const currentMetadata = State.currentMetadata;
    const allReceivedData = State.allReceivedData;
    
    if (!currentMetadata || !allReceivedData || allReceivedData.length === 0) {
        const playbackDurationEl = document.getElementById('playbackDuration');
        if (playbackDurationEl && playbackDurationEl.isConnected) {
            playbackDurationEl.textContent = '--';
        }
        return;
    }
    
    // 🔥 FIX: Use npts from metadata if available, otherwise calculate from array
    // Copy array reference to local variable to avoid retaining State reference
    const totalSamples = currentMetadata.npts || allReceivedData.reduce((sum, chunk) => sum + (chunk ? chunk.length : 0), 0);
    const originalSampleRate = currentMetadata.original_sample_rate;
    
    if (!totalSamples || !originalSampleRate) {
        const playbackDurationEl = document.getElementById('playbackDuration');
        if (playbackDurationEl && playbackDurationEl.isConnected) {
            playbackDurationEl.textContent = '--';
        }
        return;
    }
    
    const slider = document.getElementById('playbackSpeed');
    const sliderValue = parseFloat(slider.value);
    
    let baseSpeed;
    if (sliderValue <= 667) {
        const normalized = sliderValue / 667;
        baseSpeed = 0.1 * Math.pow(10, normalized);
    } else {
        const normalized = (sliderValue - 667) / 333;
        baseSpeed = Math.pow(15, normalized);
    }
    
    const multiplier = getBaseSampleRateMultiplier();
    const finalSpeed = baseSpeed * multiplier;
    
    const AUDIO_CONTEXT_SAMPLE_RATE = 44100;
    const originalDuration = totalSamples / originalSampleRate;
    const baseSpeedup = AUDIO_CONTEXT_SAMPLE_RATE / originalSampleRate;
    const totalSpeed = baseSpeedup * multiplier * baseSpeed;
    const playbackDurationSeconds = originalDuration / totalSpeed;
    
    window.playbackDurationSeconds = playbackDurationSeconds;
    
    const minutes = Math.floor(playbackDurationSeconds / 60);
    const seconds = Math.floor(playbackDurationSeconds % 60);
    
    let durationText;
    if (minutes > 0) {
        durationText = `${minutes}m ${seconds}s`;
    } else {
        durationText = `0m ${seconds}s`;
    }
    
    // 🔥 FIX: Check element connection before updating DOM
    const playbackDurationEl = document.getElementById('playbackDuration');
    if (playbackDurationEl && playbackDurationEl.isConnected) {
        playbackDurationEl.textContent = durationText;
    }
}

// Download audio as WAV file at 44.1kHz (our resampled playback version)
export function downloadAudio() {
    console.log('🔥 downloadAudio() called - VERSION 2 (44.1kHz)');

    // Always use completeSamplesArray which is resampled to 44.1kHz by the AudioContext
    if (!State.completeSamplesArray || State.completeSamplesArray.length === 0) {
        console.warn('No audio data to download');
        return;
    }

    // completeSamplesArray is at 44100 Hz (AudioContext's native sample rate)
    const sampleRate = 44100;
    console.log(`📥 Preparing WAV download: ${State.completeSamplesArray.length} samples @ ${sampleRate} Hz`);
    const numChannels = 1; // Mono
    const bytesPerSample = 2; // 16-bit
    const samples = State.completeSamplesArray;
    
    // Create WAV file
    const dataLength = samples.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);
    
    // Write WAV header
    const writeString = (offset, string) => {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    };
    
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // ByteRate
    view.setUint16(32, numChannels * bytesPerSample, true); // BlockAlign
    view.setUint16(34, bytesPerSample * 8, true); // BitsPerSample
    writeString(36, 'data');
    view.setUint32(40, dataLength, true);
    
    // Convert Float32 to Int16 and write samples
    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
        const sample = Math.max(-1, Math.min(1, samples[i])); // Clamp
        const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(offset, int16, true);
        offset += 2;
    }
    
    // Create blob and download
    const blob = new Blob([buffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    
    // Generate filename from metadata
    const metadata = State.currentMetadata;
    let filename = 'solar-audio';
    if (metadata && metadata.spacecraft && metadata.dataset) {
        // Solar/spacecraft mode
        const startDate = new Date(metadata.startTime);
        const dateStr = startDate.toISOString().split('T')[0];
        const timeStr = startDate.toISOString().split('T')[1].substring(0, 5).replace(':', '-');
        filename = `${metadata.spacecraft}_${metadata.dataset}_${dateStr}_${timeStr}`;
    } else if (metadata && metadata.network && metadata.station) {
        // Volcano mode
        const startDate = new Date(metadata.starttime);
        const dateStr = startDate.toISOString().split('T')[0];
        const timeStr = startDate.toISOString().split('T')[1].substring(0, 5).replace(':', '-');
        filename = `${metadata.network}_${metadata.station}_${dateStr}_${timeStr}`;
    }
    a.download = `${filename}.wav`;
    
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    const durationSeconds = samples.length / sampleRate;
    console.log(`✅ Downloaded ${filename}.wav (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB, ${sampleRate} Hz, ${durationSeconds.toFixed(1)}s duration)`);
}

