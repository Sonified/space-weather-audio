/**
 * audio-player.js
 * Playback controls: play/pause, speed, volume, loop, seek
 */

import * as State from './audio-state.js';
import { drawWaveformWithSelection, updatePlaybackIndicator } from './waveform-renderer.js';
import { drawSpectrogram, startVisualization } from './spectrogram-renderer.js';

export function togglePlayPause() {
    if (!State.audioContext) return;
    
    const btn = document.getElementById('playPauseBtn');
    
    // If playback has finished and we have data, "Play" means replay
    if (!State.isPlaying && State.allReceivedData && State.allReceivedData.length > 0) {
        // Determine replay position: selection start if selection exists, otherwise 0
        const replayPosition = (State.selectionStart !== null && State.selectionEnd !== null) ? State.selectionStart : 0;
        console.log(`▶️ PLAY AGAIN: Replaying from ${replayPosition.toFixed(2)}s (selection=${State.selectionStart !== null ? 'yes' : 'no'})`);
        
        // Remove pulse animations
        btn.classList.remove('pulse-play', 'pulse-resume');
        
        // Update button state
        State.setIsPlaying(true);
        State.setIsPaused(false);
        btn.textContent = '⏸️ Pause';
        btn.classList.remove('play-active', 'pulse-play', 'pulse-resume');
        btn.classList.add('pause-active');
        document.getElementById('status').className = 'status info';
        document.getElementById('status').textContent = 'Replaying audio...';
        
        // Just seek to replay position - seekToPosition handles everything!
        seekToPosition(replayPosition);
        
        return;
    }
    
    // Normal pause/resume behavior during active playback
    State.setIsPaused(!State.isPaused);
    
    if (State.isPaused) {
        // Fade to near-zero with exponential ramp (don't suspend AudioContext!)
        if (State.gainNode) {
            State.gainNode.gain.cancelScheduledValues(State.audioContext.currentTime);
            State.gainNode.gain.setValueAtTime(State.gainNode.gain.value, State.audioContext.currentTime);
            State.gainNode.gain.exponentialRampToValueAtTime(0.0001, State.audioContext.currentTime + 0.05);
        }
        
        // Tell worklet to stop consuming samples
        setTimeout(() => {
            if (State.workletNode) {
                State.workletNode.port.postMessage({ type: 'pause' });
            }
        }, 50);
        
        btn.textContent = '▶️ Resume';
        btn.classList.remove('pause-active', 'pulse-play');
        btn.classList.add('play-active', 'pulse-resume');
        document.getElementById('status').className = 'status';
        document.getElementById('status').textContent = 'Paused';
    } else {
        // Remove pulse animations if present
        btn.classList.remove('pulse-play', 'pulse-resume');
        
        btn.textContent = '⏸️ Pause';
        btn.classList.remove('play-active');
        btn.classList.add('pause-active');
        document.getElementById('status').className = 'status info';
        document.getElementById('status').textContent = 'Playing...';
        
        // Tell worklet to resume consuming samples
        if (State.workletNode) {
            State.workletNode.port.postMessage({ type: 'resume' });
        }
        
        // Fade back to target volume with exponential ramp
        if (State.gainNode) {
            const targetVolume = parseFloat(document.getElementById('volumeSlider').value) / 100;
            State.gainNode.gain.cancelScheduledValues(State.audioContext.currentTime);
            State.gainNode.gain.setValueAtTime(State.gainNode.gain.value, State.audioContext.currentTime);
            State.gainNode.gain.exponentialRampToValueAtTime(Math.max(0.01, targetVolume), State.audioContext.currentTime + 0.05);
        }
        
        // Restart playback indicator
        if (State.audioContext && State.totalAudioDuration > 0) {
            State.setLastUpdateTime(State.audioContext.currentTime);
            requestAnimationFrame(updatePlaybackIndicator);
            console.log('🎬 Playback indicator restarted');
        }
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

export function seekToPosition(targetPosition) {
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
    
    const targetMinutes = Math.floor(targetPosition / 60);
    const targetSeconds = (targetPosition % 60).toFixed(1);
    console.log(`🎯 Seeking to ${targetMinutes}:${targetSeconds.padStart(4, '0')} (${targetPosition.toFixed(2)}s / ${State.totalAudioDuration.toFixed(2)}s)`);
    
    // Calculate sample position
    const sampleRate = 44100;
    const targetSample = Math.floor(targetPosition * sampleRate);
    
    const SEEK_CROSSFADE_TIME = 0.020;
    const now = State.audioContext.currentTime;
    const seekTime = now + SEEK_CROSSFADE_TIME;
    
    const wasPlaying = State.isPlaying && !State.isPaused;
    
    // If we're paused OR playback has finished, seeking should resume playback
    if (!State.isPlaying || State.isPaused) {
        console.log(`▶️ Seeking while paused - auto-resuming playback`);
        State.setIsPaused(false);
        State.setIsPlaying(true);
        
        const btn = document.getElementById('playPauseBtn');
        btn.textContent = '⏸️ Pause';
        btn.classList.remove('play-active', 'secondary');
        btn.classList.add('pause-active');
        
        if (State.audioContext.state === 'suspended') {
            console.log('▶️ Resuming suspended AudioContext');
            State.audioContext.resume();
        }
        
        if (State.workletNode) {
            State.workletNode.port.postMessage({ type: 'resume' });
        }
        
        if (State.analyserNode) {
            drawSpectrogram();
            console.log('🎨 Restarting spectrogram');
        }
        
        State.setCurrentAudioPosition(targetPosition);
        State.setLastWorkletPosition(targetPosition);
        State.setLastWorkletUpdateTime(State.audioContext.currentTime);
        State.setLastUpdateTime(State.audioContext.currentTime);
        requestAnimationFrame(updatePlaybackIndicator);
        
        if (!State.visualizationStarted && State.analyserNode) {
            startVisualization();
        }
        
        console.log('✅ Auto-resume complete: isPlaying=true, isPaused=false');
    }
    
    if (State.gainNode && wasPlaying) {
        const currentGain = State.gainNode.gain.value;
        State.gainNode.gain.cancelScheduledValues(now);
        State.gainNode.gain.setValueAtTime(currentGain, now);
        State.gainNode.gain.linearRampToValueAtTime(0.0001, seekTime);
    }
    
    const performSeekOperation = () => {
        State.setCurrentAudioPosition(targetPosition);
        State.setLastWorkletPosition(targetPosition);
        State.setLastWorkletUpdateTime(State.audioContext.currentTime);
        State.setLastUpdateTime(State.audioContext.currentTime);
        
        State.workletNode.port.postMessage({ 
            type: 'seek',
            samplePosition: targetSample
        });
        
        if (State.gainNode) {
            const targetVolume = parseFloat(document.getElementById('volumeSlider').value) / 100;
            const fadeInStart = State.audioContext.currentTime;
            State.gainNode.gain.cancelScheduledValues(fadeInStart);
            State.gainNode.gain.setValueAtTime(0.0001, fadeInStart);
            State.gainNode.gain.linearRampToValueAtTime(Math.max(0.01, targetVolume), fadeInStart + SEEK_CROSSFADE_TIME);
        }
        
        if (State.isPlaying && !State.isPaused) {
            requestAnimationFrame(updatePlaybackIndicator);
        }
    };
    
    if (wasPlaying) {
        setTimeout(performSeekOperation, SEEK_CROSSFADE_TIME * 1000);
    } else {
        performSeekOperation();
    }
    
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

