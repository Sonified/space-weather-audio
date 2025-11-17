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
import { drawSpectrogram, startVisualization } from './spectrogram-renderer.js';
import { updateActiveRegionPlayButton, getActivePlayingRegionIndex, getCurrentRegions } from './region-tracker.js';
import { zoomState } from './zoom-state.js';
import { getCurrentPlaybackBoundaries, isAtBoundaryEnd, getRestartPosition, formatBoundaries } from './playback-boundaries.js';

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
export function startPlayback() {
    State.setPlaybackState(PlaybackState.PLAYING);
    
    console.log('▶️ Starting playback');
    
    // Update master button
    const btn = document.getElementById('playPauseBtn');
    btn.textContent = '⏸️ Pause';
    btn.classList.remove('play-active', 'pulse-play', 'pulse-resume');
    btn.classList.add('pause-active');
    
    // Update status
    import('./tutorial.js').then(({ setStatusText }) => {
        setStatusText('Click on the waveform and drag with your mouse to make a selection.', 'status info');
    });
    
    // Resume AudioContext if needed
    if (State.audioContext?.state === 'suspended') {
        console.log('▶️ Resuming suspended AudioContext');
        State.audioContext.resume();
    }
    
    // 🏎️ AUTONOMOUS: Just tell worklet to play - it handles fade-in automatically
    State.workletNode?.port.postMessage({ type: 'play' });
    
    // Restart playback indicator
    if (State.audioContext && State.totalAudioDuration > 0) {
        State.setLastUpdateTime(State.audioContext.currentTime);
        startPlaybackIndicator();
    }
    
    // Update active region button
    updateActiveRegionPlayButton(true);
}

/**
 * Pause playback
 * This is THE function for pausing
 */
export function pausePlayback() {
    State.setPlaybackState(PlaybackState.PAUSED);
    
    console.log('⏸️ Pausing playback');
    
    // 🔥 FIX: Cancel animation frame loops to prevent memory leaks
    cancelAllRAFLoops();
    
    // 🏎️ AUTONOMOUS: Just tell worklet to pause - it handles fade-out automatically
    // UI will update when worklet sends 'fade-complete' message
    State.workletNode?.port.postMessage({ type: 'pause' });
    
    // Update master button
    const btn = document.getElementById('playPauseBtn');
    btn.textContent = '▶️ Resume';
    btn.classList.remove('pause-active', 'pulse-play');
    btn.classList.add('play-active', 'pulse-resume');
    
    // Update status
    import('./tutorial.js').then(({ setStatusText }) => {
        setStatusText('Paused', 'status');
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
    if (DEBUG_LOOP_FADES) console.log(`🎵 Master play/pause button clicked - ${currentState}`);
    
    if (!State.audioContext) return;
    
    switch (State.playbackState) {
        case PlaybackState.STOPPED:
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
            console.log(`⏸️ Pausing playback`);
            pausePlayback();
            break;
            
        case PlaybackState.PAUSED:
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
    
    if (State.workletNode) {
        State.workletNode.port.postMessage({
            type: 'set-speed',
            speed: finalSpeed
        });
    }
    
    // Update spectrogram axis to reflect new playback speed
    updateAxisForPlaybackSpeed();
    
    // Update spectrogram viewport (works for both full and temple - GPU stretching!)
    // Import dynamically to avoid circular dependency
    import('./spectrogram-complete-renderer.js').then(module => {
        if (module.updateSpectrogramViewport) {
            module.updateSpectrogramViewport(finalSpeed);
        }
    }).catch(() => {
        // Module not loaded yet, that's okay - will be called after rendering completes
    });
}

export function changePlaybackSpeed() {
    updatePlaybackSpeed();
    updatePlaybackDuration();
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
    
    // if (DEBUG_LOOP_FADES) console.log(`🎯 Seeking to ${targetPosition.toFixed(2)}s (shouldStartPlayback=${shouldStartPlayback})`);
    
    // Set flag to prevent race condition in region finish detection
    State.setJustSeeked(true);
    
    const targetSample = Math.floor(targetPosition * 44100);
    const wasPlaying = State.playbackState === PlaybackState.PLAYING;
    
    const performSeek = () => {
        // Update position tracking
        State.setCurrentAudioPosition(targetPosition);
        State.setLastWorkletPosition(targetPosition);
        State.setLastWorkletUpdateTime(State.audioContext.currentTime);
        State.setLastUpdateTime(State.audioContext.currentTime);
        
        // 🏎️ AUTONOMOUS: Just tell worklet to seek - it handles crossfade automatically if playing
        State.workletNode.port.postMessage({ 
            type: 'seek',
            position: targetPosition  // Send position in seconds, worklet converts to samples
        });
        
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
            State.workletNode.port.postMessage({ type: 'play' });
            
            // Update play/pause button to show "Pause"
            const btn = document.getElementById('playPauseBtn');
            btn.textContent = '⏸️ Pause';
            btn.classList.remove('play-active', 'pulse-play', 'pulse-resume');
            btn.classList.add('pause-active');
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

// Download audio as WAV file
export function downloadAudio() {
    if (!State.completeSamplesArray || State.completeSamplesArray.length === 0) {
        console.warn('No audio data to download');
        return;
    }
    
    console.log('📥 Preparing audio download...');
    
    const sampleRate = 44100;
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
    let filename = 'volcano-audio';
    if (metadata && metadata.network && metadata.station) {
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
    
    console.log(`✅ Downloaded ${filename}.wav (${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB)`);
}

