/**
 * audio-player.js
 * Playback controls: play/pause, speed, volume, loop, seek
 */

import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { drawWaveformWithSelection, updatePlaybackIndicator, startPlaybackIndicator } from './waveform-renderer.js';
import { updateAxisForPlaybackSpeed } from './spectrogram-axis-renderer.js';
import { drawSpectrogram, startVisualization } from './spectrogram-renderer.js';
import { updateActiveRegionPlayButton } from './region-tracker.js';

// ===== RAF CLEANUP HELPER =====

/**
 * Cancel all active animation frame loops
 * Prevents memory leaks from closure chains
 */
export function cancelAllRAFLoops() {
    if (State.playbackIndicatorRAF !== null) {
        cancelAnimationFrame(State.playbackIndicatorRAF);
        State.setPlaybackIndicatorRAF(null);
        console.log('🧹 Cancelled playback indicator RAF');
    }
    if (State.spectrogramRAF !== null) {
        cancelAnimationFrame(State.spectrogramRAF);
        State.setSpectrogramRAF(null);
        console.log('🧹 Cancelled spectrogram RAF');
    }
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
    document.getElementById('status').className = 'status info';
    document.getElementById('status').textContent = 'Playing...';
    
    // Resume AudioContext if needed
    if (State.audioContext?.state === 'suspended') {
        console.log('▶️ Resuming suspended AudioContext');
        State.audioContext.resume();
    }
    
    // Tell worklet to resume
    State.workletNode?.port.postMessage({ type: 'resume' });
    
    // Fade volume back to target level
    if (State.gainNode && State.audioContext) {
        const targetVolume = parseFloat(document.getElementById('volumeSlider').value) / 100;
        State.gainNode.gain.cancelScheduledValues(State.audioContext.currentTime);
        State.gainNode.gain.setValueAtTime(State.gainNode.gain.value, State.audioContext.currentTime);
        State.gainNode.gain.exponentialRampToValueAtTime(Math.max(0.01, targetVolume), State.audioContext.currentTime + 0.05);
        console.log(`🔊 Fade-in on resume: ${State.gainNode.gain.value.toFixed(4)} → ${targetVolume.toFixed(2)} over 50ms`);
    }
    
    // Restart playback indicator
    if (State.audioContext && State.totalAudioDuration > 0) {
        State.setLastUpdateTime(State.audioContext.currentTime);
        startPlaybackIndicator();
    }
    
    // COMMENTED OUT: Using complete spectrogram renderer instead of streaming
    // // Restart spectrogram if needed
    // if (State.analyserNode && !State.visualizationStarted) {
    //     startVisualization();
    // }
    
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
    
    // Fade volume
    if (State.gainNode && State.audioContext) {
        State.gainNode.gain.cancelScheduledValues(State.audioContext.currentTime);
        State.gainNode.gain.setValueAtTime(State.gainNode.gain.value, State.audioContext.currentTime);
        State.gainNode.gain.exponentialRampToValueAtTime(0.0001, State.audioContext.currentTime + 0.05);
    }
    
    // Tell worklet to pause
    setTimeout(() => {
        State.workletNode?.port.postMessage({ type: 'pause' });
    }, 50);
    
    // Update master button
    const btn = document.getElementById('playPauseBtn');
    btn.textContent = '▶️ Resume';
    btn.classList.remove('pause-active', 'pulse-play');
    btn.classList.add('play-active', 'pulse-resume');
    
    // Update status
    document.getElementById('status').className = 'status';
    document.getElementById('status').textContent = 'Paused';
    
    // Update active region button
    updateActiveRegionPlayButton(false);
}

// ===== SIMPLIFIED TOGGLEPLAYPAUSE =====

export function togglePlayPause() {
    const currentState = `playbackState=${State.playbackState}, position=${State.currentAudioPosition?.toFixed(2) || 0}s`;
    console.log(`🎵 Master play/pause button clicked - ${currentState}`);
    
    if (!State.audioContext) return;
    
    switch (State.playbackState) {
        case PlaybackState.STOPPED:
            // Determine start position
            let startPosition;
            if (State.selectionStart !== null && State.selectionEnd !== null) {
                startPosition = State.selectionStart;
            } else {
                // If we're at/near the end (within last 0.1s), restart from beginning
                startPosition = (State.currentAudioPosition >= State.totalAudioDuration - 0.1) 
                    ? 0 
                    : State.currentAudioPosition;
            }
            
            console.log(`▶️ Starting playback from ${startPosition.toFixed(2)}s`);
            seekToPosition(startPosition, true);
            break;
            
        case PlaybackState.PLAYING:
            console.log(`⏸️ Pausing playback`);
            pausePlayback();
            break;
            
        case PlaybackState.PAUSED:
            // Check if we're at the end of the selection - if so, restart from beginning
            if (State.selectionStart !== null && State.selectionEnd !== null) {
                const atEnd = Math.abs(State.currentAudioPosition - State.selectionEnd) < 0.1;
                if (atEnd) {
                    console.log(`▶️ At selection end, restarting from ${State.selectionStart.toFixed(2)}s`);
                    seekToPosition(State.selectionStart, true);
                    break;
                }
            } else {
                // No selection - check if at end of full audio
                const atEnd = State.currentAudioPosition >= State.totalAudioDuration - 0.1;
                if (atEnd) {
                    console.log(`▶️ At audio end, restarting from beginning`);
                    seekToPosition(0, true);
                    break;
                }
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
}

export function updateWorkletSelection() {
    if (!State.workletNode) return;
    
    State.workletNode.port.postMessage({
        type: 'set-selection',
        start: State.selectionStart,
        end: State.selectionEnd,
        loop: State.isLooping
    });
    
    console.log(`📤 Sent to worklet: selection=${State.selectionStart !== null ? State.selectionStart.toFixed(2) : 'null'}-${State.selectionEnd !== null ? State.selectionEnd.toFixed(2) : 'null'}, loop=${State.isLooping}`);
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
}

export function changePlaybackSpeed() {
    updatePlaybackSpeed();
    updatePlaybackDuration();
}

export function changeVolume() {
    const slider = document.getElementById('volumeSlider');
    const volume = parseFloat(slider.value) / 100;
    
    document.getElementById('volumeValue').textContent = volume.toFixed(2);
    
    if (State.gainNode && State.audioContext) {
        // Linear ramp for volume slider (direct user control)
        State.gainNode.gain.setValueAtTime(State.gainNode.gain.value, State.audioContext.currentTime);
        State.gainNode.gain.linearRampToValueAtTime(volume, State.audioContext.currentTime + 0.05);
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
    
    // Clamp position to selection bounds if selection exists, otherwise full range
    if (State.selectionStart !== null && State.selectionEnd !== null) {
        targetPosition = Math.max(State.selectionStart, Math.min(targetPosition, State.selectionEnd));
    } else {
        targetPosition = Math.max(0, Math.min(targetPosition, State.totalAudioDuration));
    }
    
    console.log(`🎯 Seeking to ${targetPosition.toFixed(2)}s (shouldStartPlayback=${shouldStartPlayback})`);
    
    // Set flag to prevent race condition in region finish detection
    State.setJustSeeked(true);
    
    const targetSample = Math.floor(targetPosition * 44100);
    const CROSSFADE_TIME = 0.020;
    const now = State.audioContext.currentTime;
    const wasPlaying = State.playbackState === PlaybackState.PLAYING;
    
    // Crossfade out if playing
    if (State.gainNode && wasPlaying) {
        const currentGain = State.gainNode.gain.value;
        State.gainNode.gain.cancelScheduledValues(now);
        State.gainNode.gain.setValueAtTime(currentGain, now);
        State.gainNode.gain.linearRampToValueAtTime(0.0001, now + CROSSFADE_TIME);
    }
    
    const performSeek = () => {
        // Update position tracking
        State.setCurrentAudioPosition(targetPosition);
        State.setLastWorkletPosition(targetPosition);
        State.setLastWorkletUpdateTime(State.audioContext.currentTime);
        State.setLastUpdateTime(State.audioContext.currentTime);
        
        // Send seek command to worklet
        State.workletNode.port.postMessage({ 
            type: 'seek',
            samplePosition: targetSample,
            forceResume: shouldStartPlayback  // Tell seek-ready handler if we want to start playback
        });
        
        // Crossfade back in if playing or should start
        if (State.gainNode && (wasPlaying || shouldStartPlayback)) {
            const targetVolume = parseFloat(document.getElementById('volumeSlider').value) / 100;
            const fadeStart = State.audioContext.currentTime;
            State.gainNode.gain.cancelScheduledValues(fadeStart);
            State.gainNode.gain.setValueAtTime(0.0001, fadeStart);
            State.gainNode.gain.linearRampToValueAtTime(Math.max(0.01, targetVolume), fadeStart + CROSSFADE_TIME);
        }
        
        // NOTE: No need to call startPlayback() here!
        // The forceResume flag in the seek message will trigger auto-resume 
        // once the buffer has samples (via the seek-ready handler)
        
        // Update playback state if starting
        if (shouldStartPlayback) {
            State.setPlaybackState(PlaybackState.PLAYING);
            
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
    
    // Delay seek if we need to crossfade out first
    if (wasPlaying) {
        setTimeout(performSeek, CROSSFADE_TIME * 1000);
    } else {
        performSeek();
    }
    
    // Update status text
    const targetMinutes = Math.floor(targetPosition / 60);
    const targetSeconds = (targetPosition % 60).toFixed(1);
    const status = document.getElementById('status');
    status.className = 'status info';
    status.textContent = `✅ Seeking to ${targetMinutes}:${targetSeconds.padStart(4, '0')}`;
}

// Helper functions
function getBaseSampleRateMultiplier() {
    const baseSampleRateSelect = document.getElementById('baseSampleRate');
    const selectedRate = parseFloat(baseSampleRateSelect.value);
    return selectedRate / 44100;
}

function updatePlaybackDuration() {
    if (!State.currentMetadata || !State.allReceivedData || State.allReceivedData.length === 0) {
        document.getElementById('playbackDuration').textContent = '--';
        return;
    }
    
    const totalSamples = State.currentMetadata.npts || State.allReceivedData.reduce((sum, chunk) => sum + chunk.length, 0);
    const originalSampleRate = State.currentMetadata.original_sample_rate;
    
    if (!totalSamples || !originalSampleRate) {
        document.getElementById('playbackDuration').textContent = '--';
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
    
    document.getElementById('playbackDuration').textContent = durationText;
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

