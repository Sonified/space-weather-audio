/**
 * main.js
 * Main orchestration: initialization, startStreaming, event handlers
 */

import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { togglePlayPause, toggleLoop, changePlaybackSpeed, changeVolume, resetSpeedTo1, resetVolumeTo1, updatePlaybackSpeed, downloadAudio } from './audio-player.js';
import { initWaveformWorker, setupWaveformInteraction, drawWaveform, drawWaveformWithSelection, changeWaveformFilter, updatePlaybackIndicator } from './waveform-renderer.js';
import { changeSpectrogramScrollSpeed, loadSpectrogramScrollSpeed, changeFrequencyScale, startVisualization, setupSpectrogramSelection } from './spectrogram-renderer.js';
import { clearCompleteSpectrogram, startMemoryMonitoring } from './spectrogram-complete-renderer.js';
import { loadStations, loadSavedVolcano, updateStationList, enableFetchButton, purgeCloudflareCache, openParticipantModal, closeParticipantModal, submitParticipantSetup, openPreSurveyModal, closePreSurveyModal, submitPreSurvey, openPostSurveyModal, closePostSurveyModal, submitPostSurvey, openAwesfModal, closeAwesfModal, submitAwesfSurvey, changeBaseSampleRate, handleWaveformFilterChange, resetWaveformFilterToDefault, setupModalEventListeners, attemptSubmission } from './ui-controls.js';
import { getParticipantIdFromURL, storeParticipantId, getParticipantId } from './qualtrics-api.js';
import { initAdminMode, isAdminMode, toggleAdminMode } from './admin-mode.js';
import { fetchFromR2Worker, fetchFromRailway } from './data-fetcher.js';
import { trackUserAction } from '../Qualtrics/participant-response-manager.js';
import { initializeModals } from './modal-templates.js';
import { positionAxisCanvas, resizeAxisCanvas, drawFrequencyAxis, initializeAxisPlaybackRate } from './spectrogram-axis-renderer.js';
import { positionWaveformAxisCanvas, resizeWaveformAxisCanvas, drawWaveformAxis } from './waveform-axis-renderer.js';
import { positionWaveformXAxisCanvas, resizeWaveformXAxisCanvas, drawWaveformXAxis, positionWaveformDateCanvas, resizeWaveformDateCanvas, drawWaveformDate } from './waveform-x-axis-renderer.js';
import { initRegionTracker, toggleRegion, toggleRegionPlay, addFeature, updateFeature, deleteRegion, startFrequencySelection, createTestRegion, setSelectionFromActiveRegionIfExists, resetRegionPlayButtonIfFinished, getActivePlayingRegionIndex } from './region-tracker.js';

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
    if (!State.currentMetadata || !totalSamples || totalSamples <= 0 || samplesConsumed < 0) {
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
    
    document.getElementById('currentPosition').textContent = formatDuration(playbackPositionSeconds);
}

function stopPositionTracking() {
    if (State.playbackPositionInterval) {
        clearInterval(State.playbackPositionInterval);
        State.setPlaybackPositionInterval(null);
    }
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
    gain.gain.value = 0.0001;
    State.setGainNode(gain);
    
    worklet.connect(gain);
    gain.connect(analyser);
    gain.connect(State.audioContext.destination);
    
    updatePlaybackSpeed();
    
    // Log audio output latency for debugging sync issues
    console.log(`🔊 Audio latency: output=${State.audioContext.outputLatency ? (State.audioContext.outputLatency * 1000).toFixed(1) : 'undefined'}ms, base=${(State.audioContext.baseLatency * 1000).toFixed(1)}ms`);
    
    // The outputLatency might be 0 or undefined on some browsers
    // The real latency is often the render quantum (128 samples) plus base latency
    const estimatedLatency = State.audioContext.baseLatency || (128 / 44100);
    console.log(`🔊 Estimated total latency: ${(estimatedLatency * 1000).toFixed(1)}ms`);
    
    worklet.port.onmessage = (event) => {
        const { type, bufferSize, samplesConsumed, totalSamples, positionSeconds, samplePosition } = event.data;
        
        if (type === 'position') {
            // Use worklet's reported position directly - no latency adjustment
            // The playhead should show where the audio actually is, matching the coordinate system used for clicks
            State.setCurrentAudioPosition(positionSeconds);
            State.setLastWorkletPosition(positionSeconds);
            State.setLastWorkletUpdateTime(State.audioContext.currentTime);
        } else if (type === 'selection-end-approaching') {
            const { secondsToEnd, isLooping: workletIsLooping, loopDuration } = event.data;
            
            if (!workletIsLooping && State.gainNode && State.audioContext) {
                const currentGain = State.gainNode.gain.value;
                const fadeTime = 0.020;
                State.gainNode.gain.cancelScheduledValues(State.audioContext.currentTime);
                State.gainNode.gain.setValueAtTime(currentGain, State.audioContext.currentTime);
                State.gainNode.gain.linearRampToValueAtTime(0.0001, State.audioContext.currentTime + fadeTime);
            } else if (workletIsLooping && State.gainNode && State.audioContext) {
                if (loopDuration < 0.050) {
                    // Audio-rate loop - no fade
                } else {
                    const currentGain = State.gainNode.gain.value;
                    let fadeTime;
                    
                    if (loopDuration < 0.200) {
                        fadeTime = Math.min(secondsToEnd, 0.002);
                    } else {
                        fadeTime = Math.min(secondsToEnd, 0.005);
                    }
                    
                    State.gainNode.gain.cancelScheduledValues(State.audioContext.currentTime);
                    State.gainNode.gain.setValueAtTime(currentGain, State.audioContext.currentTime);
                    State.gainNode.gain.linearRampToValueAtTime(0.0001, State.audioContext.currentTime + fadeTime);
                }
            }
        } else if (type === 'selection-loop') {
            const { newPosition } = event.data;
            
            State.setCurrentAudioPosition(newPosition);
            State.setLastWorkletPosition(newPosition);
            State.setLastWorkletUpdateTime(State.audioContext.currentTime);
            
            if (State.gainNode && State.audioContext && State.selectionStart !== null && State.selectionEnd !== null) {
                const loopDuration = State.selectionEnd - State.selectionStart;
                
                if (loopDuration < 0.050) {
                    // Audio-rate loop - no fade-in
                } else {
                    const targetVolume = parseFloat(document.getElementById('volumeSlider').value) / 100;
                    let fadeTime;
                    
                    if (loopDuration < 0.200) {
                        fadeTime = 0.002;
                    } else {
                        fadeTime = 0.005;
                    }
                    
                    State.gainNode.gain.cancelScheduledValues(State.audioContext.currentTime);
                    State.gainNode.gain.setValueAtTime(0.0001, State.audioContext.currentTime);
                    State.gainNode.gain.linearRampToValueAtTime(Math.max(0.01, targetVolume), State.audioContext.currentTime + fadeTime);
                }
            }
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
            document.getElementById('status').className = 'status';
            document.getElementById('status').textContent = '⏸️ Paused at selection end';
            
            drawWaveformWithSelection();
        } else if (type === 'metrics') {
            if (samplesConsumed !== undefined && totalSamples && totalSamples > 0) {
                updateCurrentPositionFromSamples(samplesConsumed, totalSamples);
            }
        } else if (type === 'started') {
            const ttfa = performance.now() - window.streamingStartTime;
            document.getElementById('ttfa').textContent = `${ttfa.toFixed(0)}ms`;
            console.log(`⏱️ [${ttfa.toFixed(0)}ms] Worklet confirmed playback`);
        } else if (type === 'loop-soon') {
            const { samplesRemaining, secondsRemaining, speed } = event.data;
            
            if (State.isLooping) {
                const LOOP_FADE_TIME = 0.005;
                if (State.gainNode && State.audioContext) {
                    const currentGain = State.gainNode.gain.value;
                    State.gainNode.gain.cancelScheduledValues(State.audioContext.currentTime);
                    State.gainNode.gain.setValueAtTime(currentGain, State.audioContext.currentTime);
                    State.gainNode.gain.linearRampToValueAtTime(0.0001, State.audioContext.currentTime + LOOP_FADE_TIME);
                }
            } else {
                const realTimeRemaining = secondsRemaining / speed;
                const fadeDuration = Math.min(realTimeRemaining, 0.1);
                if (State.gainNode && State.audioContext) {
                    const currentGain = State.gainNode.gain.value;
                    State.gainNode.gain.cancelScheduledValues(State.audioContext.currentTime);
                    State.gainNode.gain.setValueAtTime(currentGain, State.audioContext.currentTime);
                    State.gainNode.gain.linearRampToValueAtTime(0.0001, State.audioContext.currentTime + fadeDuration);
                }
            }
        } else if (type === 'seek-ready') {
            // Worklet has cleared its buffer and is ready for samples at seek position
            const { targetSample, wasPlaying, forceResume } = event.data;
            console.log(`🎯 [SEEK-READY] Re-sending samples from ${targetSample.toLocaleString()}, wasPlaying=${wasPlaying}, forceResume=${forceResume}`);
            
            if (State.completeSamplesArray && targetSample >= 0 && targetSample < State.completeSamplesArray.length) {
                // Tell worklet whether to auto-resume after buffering
                const shouldAutoResume = wasPlaying || forceResume;
                
                // Send samples in chunks to avoid blocking
                const chunkSize = 44100 * 10; // 10 seconds per chunk
                const totalSamples = State.completeSamplesArray.length;
                
                for (let i = targetSample; i < totalSamples; i += chunkSize) {
                    const end = Math.min(i + chunkSize, totalSamples);
                    const chunk = State.completeSamplesArray.slice(i, end);
                    
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
        } else if (type === 'loop-ready') {
            // Worklet has cleared buffer and is ready to loop from target position
            const { targetSample } = event.data;
            console.log(`🔄 [LOOP-READY] Re-sending samples from ${targetSample.toLocaleString()} (loop restart)`);
            
            if (State.completeSamplesArray && State.completeSamplesArray.length > 0) {
                // Update position tracking to loop target
                const newPositionSeconds = targetSample / 44100;
                State.setCurrentAudioPosition(newPositionSeconds);
                State.setLastWorkletPosition(newPositionSeconds);
                State.setLastWorkletUpdateTime(State.audioContext.currentTime);
                
                // Send samples from target position onwards with auto-resume
                const chunkSize = 44100 * 10; // 10 seconds per chunk
                const totalSamples = State.completeSamplesArray.length;
                
                for (let i = targetSample; i < totalSamples; i += chunkSize) {
                    const end = Math.min(i + chunkSize, totalSamples);
                    const chunk = State.completeSamplesArray.slice(i, end);
                    
                    State.workletNode.port.postMessage({
                        type: 'audio-data',
                        data: chunk,
                        autoResume: true  // Auto-resume when buffer is ready
                    });
                }
                
                console.log(`🔄 [LOOP-READY] Sent ${(totalSamples - targetSample).toLocaleString()} samples from ${newPositionSeconds.toFixed(2)}s, will auto-resume`);
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
            console.log(`🏁 [FINISHED] Buffer empty: ${finishedTotalSamples.toLocaleString()} samples @ ${speed.toFixed(2)}x speed`);
            
            if (State.isLooping && State.allReceivedData && State.allReceivedData.length > 0) {
                State.setPlaybackState(PlaybackState.PLAYING);
                State.setCurrentAudioPosition(0);
                State.setLastUpdateTime(State.audioContext.currentTime);
                
                State.workletNode.port.postMessage({ type: 'loop' });
                
                if (State.gainNode) {
                    const targetVolume = parseFloat(document.getElementById('volumeSlider').value) / 100;
                    State.gainNode.gain.cancelScheduledValues(State.audioContext.currentTime);
                    State.gainNode.gain.setValueAtTime(0.0001, State.audioContext.currentTime);
                    State.gainNode.gain.linearRampToValueAtTime(Math.max(0.01, targetVolume), State.audioContext.currentTime + 0.005);
                }
                
                if (State.totalAudioDuration > 0) {
                    requestAnimationFrame(updatePlaybackIndicator);
                }
            } else {
                State.setPlaybackState(PlaybackState.STOPPED);
                
                if (finishedTotalSamples && State.totalAudioDuration > 0) {
                    const finalPosition = finishedTotalSamples / 44100;
                    State.setCurrentAudioPosition(Math.min(finalPosition, State.totalAudioDuration));
                    drawWaveformWithSelection();
                }
                
                // Check if we were playing a region and reset its play button if finished
                resetRegionPlayButtonIfFinished();
                
                stopPositionTracking();
                const playBtn = document.getElementById('playPauseBtn');
                playBtn.disabled = false;
                playBtn.textContent = '▶️ Play';
                playBtn.classList.add('pulse-play');
                document.getElementById('status').className = 'status success';
                document.getElementById('status').textContent = '✅ Playback finished! Click Play to replay or enable Loop.';
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
        
        // Clear complete spectrogram when loading new data
        clearCompleteSpectrogram();
        
        // Terminate and recreate waveform worker to free memory
        if (State.waveformWorker) {
            State.waveformWorker.terminate();
            console.log('🧹 Terminated waveform worker');
        }
        initWaveformWorker();
        
        State.setIsShowingFinalWaveform(false);
        
        window.streamingStartTime = performance.now();
        const logTime = () => `[${Math.round(performance.now() - window.streamingStartTime)}ms]`;
        
        console.log('🎬 [0ms] startStreaming() called');
        
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
        
        // Log what we're fetching
        const stationLabel = `${stationData.network}.${stationData.station}.${stationData.location || '--'}.${stationData.channel}`;
        console.log(`🌋 Fetching data for ${volcano} from station ${stationLabel}`);
        
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
        
        console.log(`🕐 ${logTime()} Estimated latest chunk ends at: ${estimatedEndTime.toISOString()}`);
        
        console.log(`🚀 ${logTime()} Starting parallel: worker + audioContext + station check`);
        
        // 1. Worker creation
        if (window.audioWorker) {
            console.log('🧹 Terminating old audio worker...');
            window.audioWorker.terminate();
            window.audioWorker = null; // 🧹 Clear reference before creating new worker
        }
        window.audioWorker = new Worker('workers/audio-processor-worker.js');
        const workerReadyPromise = new Promise(resolve => {
            window.audioWorker.addEventListener('message', function onReady(e) {
                if (e.data === 'ready') {
                    window.audioWorker.removeEventListener('message', onReady);
                    console.log(`🏭 ${logTime()} Worker ready!`);
                    resolve();
                }
            });
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
                console.log(`🎵 ${logTime()} AudioContext ready (latency: playback)`);
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
            
            console.log(`📋 ${logTime()} Station ${stationData.network}.${stationData.station}: active=${isActiveStation}`);
            return isActiveStation;
        })();
        
        await Promise.all([workerReadyPromise, audioContextPromise]);
        console.log(`✅ ${logTime()} Worker + AudioContext ready!`);
        
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
        
        const baseMessage = forceIrisFetch 
            ? `📡 Fetching data for station ${stationLabel} (${stationData.distance_km}km) from IRIS Server`
            : (isActiveStation ? `📡 Fetching data for station ${stationLabel} (${stationData.distance_km}km) from R2 Server` : `📡 Fetching data for station ${stationLabel} (${stationData.distance_km}km) from Railway Server`);
        document.getElementById('status').className = 'status info loading';
        document.getElementById('status').textContent = baseMessage;
        
        if (State.workletNode) {
            console.log('🧹 Starting AGGRESSIVE memory cleanup...');
            State.workletNode.port.onmessage = null;
            if (State.gainNode && State.audioContext && State.playbackState === PlaybackState.PLAYING) {
                State.gainNode.gain.cancelScheduledValues(State.audioContext.currentTime);
                State.gainNode.gain.setValueAtTime(State.gainNode.gain.value, State.audioContext.currentTime);
                State.gainNode.gain.exponentialRampToValueAtTime(0.0001, State.audioContext.currentTime + 0.05);
            }
            State.workletNode.disconnect();
            State.setWorkletNode(null);
            if (State.gainNode) {
                State.gainNode.disconnect();
                State.setGainNode(null);
            }
            
            // 🧹 AGGRESSIVE CLEANUP: Explicitly null out large arrays
            const oldDataLength = State.allReceivedData?.length || 0;
            const oldSamplesLength = State.completeSamplesArray?.length || 0;
            console.log(`🧹 Clearing old audio data: ${oldDataLength} chunks, ${oldSamplesLength.toLocaleString()} samples`);
            
            State.setAllReceivedData([]);
            State.setCompleteSamplesArray(null);
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
        
        const loopBtn = document.getElementById('loopBtn');
        loopBtn.disabled = true;
        loopBtn.classList.remove('loop-active');
        
        State.setPlaybackState(PlaybackState.PLAYING);
        State.setStreamStartTime(performance.now());
        
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
        
        if (forceIrisFetch) {
            console.log(`🌐 ${logTime()} Force IRIS Fetch ENABLED - Using Railway backend`);
            await fetchFromRailway(stationData, startTime, duration, highpassFreq, enableNormalize);
        } else if (isActiveStation) {
            console.log(`🌐 ${logTime()} Using CDN direct (active station)`);
            await fetchFromR2Worker(stationData, startTime, estimatedEndTime, duration, highpassFreq, realisticChunkPromise, firstChunkStart);
        } else {
            console.log(`🚂 ${logTime()} Using Railway backend (inactive station)`);
            await fetchFromRailway(stationData, startTime, duration, highpassFreq, enableNormalize);
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
        document.getElementById('status').textContent = `Error: ${error.message}`;
        
        const startBtn = document.getElementById('startBtn');
        startBtn.disabled = false;
        startBtn.classList.remove('streaming');
        
        document.getElementById('playPauseBtn').disabled = true;
        document.getElementById('loopBtn').disabled = true;
        document.getElementById('downloadBtn').disabled = true;
    }
}

// DOMContentLoaded initialization
window.addEventListener('DOMContentLoaded', async () => {
    // Parse participant ID from URL parameters on page load
    // Qualtrics redirects with: ?ResponseID=${e://Field/ResponseID}
    // This automatically captures the ResponseID and stores it for survey submissions
    const urlParticipantId = getParticipantIdFromURL();
    if (urlParticipantId) {
        storeParticipantId(urlParticipantId);
        console.log('🔗 ResponseID detected from Qualtrics redirect:', urlParticipantId);
        console.log('💾 Stored ResponseID for use in survey submissions');
    }
    console.log('🌋 [0ms] volcano-audio v1.92 - Memory Health Monitoring & Audio Buffer Optimization');
    console.log('📦 [0ms] v1.92 Perf: Changed AudioContext latencyHint to "playback" - eliminated ALL buffer underruns with imperceptible 30ms latency');
    console.log('📦 [0ms] v1.92 Feat: Added memory health monitoring system - tracks baseline, trends, and detects leaks every 10 seconds');
    
    // Start memory health monitoring
    startMemoryMonitoring();
    
    // Initialize modals (inject into DOM)
    initializeModals();
    
    // Attach event listeners to modals
    setupModalEventListeners();
    
    // Initialize region tracker
    initRegionTracker();
    
    // Setup spectrogram frequency selection
    setupSpectrogramSelection();
    
    // Initialize admin mode (applies user mode by default)
    initAdminMode();
    
    // Load saved preferences immediately to avoid visual jumps
    // (Must be done before other initialization that might trigger change handlers)
    loadSpectrogramScrollSpeed();
    
    initWaveformWorker();
    
    const sliderValueFor1x = calculateSliderForSpeed(1.0);
    document.getElementById('playbackSpeed').value = sliderValueFor1x;
    console.log(`Initialized playback speed slider at position ${sliderValueFor1x} for 1.0x speed`);
    
    // Load saved volcano selection (or use default)
    loadSavedVolcano();
    
    // Add event listeners
    document.getElementById('volcano').addEventListener('change', enableFetchButton);
    document.getElementById('dataType').addEventListener('change', enableFetchButton);
    document.getElementById('station').addEventListener('change', enableFetchButton);
    document.getElementById('duration').addEventListener('change', enableFetchButton);
    document.getElementById('highpassFreq').addEventListener('change', enableFetchButton);
    document.getElementById('enableNormalize').addEventListener('change', enableFetchButton);
    document.getElementById('bypassCache').addEventListener('change', enableFetchButton);
    document.getElementById('baseSampleRate').addEventListener('change', changeBaseSampleRate);
    
    updatePlaybackSpeed();
    
    document.getElementById('speedLabel').addEventListener('click', resetSpeedTo1);
    document.getElementById('volumeLabel').addEventListener('click', resetVolumeTo1);
    
    document.getElementById('spectrogramScrollSpeed').addEventListener('input', changeSpectrogramScrollSpeed);
    // Note: loadSpectrogramScrollSpeed() is called earlier in initialization to avoid visual jump
    
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
            const isContentEditable = event.target.isContentEditable;
            
            // Return early (don't handle) if user is interacting with any form element
            if (isTextInput || isTextarea || isSelect || isButton || isContentEditable) {
                return; // Let browser handle spacebar normally
            }
            
            // Only prevent default and handle play/pause if not in an interactive element
            event.preventDefault();
            
            const playPauseBtn = document.getElementById('playPauseBtn');
            if (!playPauseBtn.disabled && (State.playbackState !== PlaybackState.STOPPED || State.allReceivedData.length > 0)) {
                // If there's an active region, set selection to that region before playing
                if (setSelectionFromActiveRegionIfExists()) {
                    // Selection is now set to the active region, togglePlayPause will use it
                }
                togglePlayPause();
            }
        }
    });
    
    // Blur sliders after interaction
    const playbackSpeedSlider = document.getElementById('playbackSpeed');
    const volumeSlider = document.getElementById('volumeSlider');
    
    [playbackSpeedSlider, volumeSlider].forEach(slider => {
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
    
    console.log('✅ Event listeners added for fetch button re-enabling');
    
    // Handle window resize to reposition axis canvases - optimized for performance
    let resizeRAF = null;
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
            lastWaveformHeight = waveformCanvas.offsetHeight;
        }
    }, 0);
    
    window.addEventListener('resize', () => {
        if (resizeRAF) return; // Already scheduled
        
        resizeRAF = requestAnimationFrame(() => {
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
                // Always reposition during resize
                positionWaveformXAxisCanvas();
                
                // Only redraw if canvas dimensions changed
                const currentWidth = waveformCanvas.offsetWidth;
                if (currentWidth !== lastWaveformWidth) {
                    resizeWaveformXAxisCanvas();
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
        positionWaveformXAxisCanvas();
        drawWaveformXAxis();
        positionWaveformDateCanvas();
        drawWaveformDate();
        // Update dimensions after initial draw
        const spectrogramCanvas = document.getElementById('spectrogram');
        const waveformCanvas = document.getElementById('waveform');
        if (spectrogramCanvas) {
            lastSpectrogramWidth = spectrogramCanvas.width;
            lastSpectrogramHeight = spectrogramCanvas.height;
        }
        if (waveformCanvas) {
            lastWaveformWidth = waveformCanvas.offsetWidth;
            lastWaveformHeight = waveformCanvas.offsetHeight;
        }
    }, 100);
    
    // 🎯 SETUP EVENT LISTENERS (replaces onclick handlers to prevent memory leaks)
    // All event listeners are properly scoped and don't create permanent closures on window.*
    
    // Cache & Download
    document.getElementById('purgeCacheBtn').addEventListener('click', purgeCloudflareCache);
    document.getElementById('downloadBtn').addEventListener('click', downloadAudio);
    
    // Station Selection
    document.getElementById('volcano').addEventListener('change', loadStations);
    document.getElementById('dataType').addEventListener('change', updateStationList);
    
    // Data Fetching
    document.getElementById('startBtn').addEventListener('click', startStreaming);
    document.getElementById('forceIrisBtn').addEventListener('click', toggleForceIris);
    
    // Playback Controls
    document.getElementById('playPauseBtn').addEventListener('click', togglePlayPause);
    document.getElementById('loopBtn').addEventListener('click', toggleLoop);
    document.getElementById('playbackSpeed').addEventListener('input', changePlaybackSpeed);
    document.getElementById('volumeSlider').addEventListener('input', changeVolume);
    
    // Waveform Filters
    document.getElementById('removeDCOffset').addEventListener('change', handleWaveformFilterChange);
    document.getElementById('waveformFilterSlider').addEventListener('input', handleWaveformFilterChange);
    
    // Anti-aliasing
    document.getElementById('antiAliasingBtn').addEventListener('click', toggleAntiAliasing);
    
    // Survey/Modal Buttons
    document.getElementById('participantModalBtn').addEventListener('click', openParticipantModal);
    document.getElementById('preSurveyModalBtn').addEventListener('click', openPreSurveyModal);
    document.getElementById('awesfModalBtn').addEventListener('click', openAwesfModal);
    document.getElementById('postSurveyModalBtn').addEventListener('click', openPostSurveyModal);
    document.getElementById('submitBtn').addEventListener('click', attemptSubmission);
    document.getElementById('adminModeBtn').addEventListener('click', toggleAdminMode);
    
    console.log('✅ Event listeners setup complete - memory leak prevention active!');
});

