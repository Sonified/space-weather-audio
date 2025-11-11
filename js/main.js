/**
 * main.js
 * Main orchestration: initialization, startStreaming, event handlers
 */

import * as State from './audio-state.js';
import { togglePlayPause, toggleLoop, changePlaybackSpeed, changeVolume, resetSpeedTo1, resetVolumeTo1, updatePlaybackSpeed } from './audio-player.js';
import { initWaveformWorker, setupWaveformInteraction, drawWaveform, drawWaveformWithSelection, changeWaveformFilter, updatePlaybackIndicator } from './waveform-renderer.js';
import { changeSpectrogramScrollSpeed, startVisualization } from './spectrogram-renderer.js';
import { loadStations, updateStationList, enableFetchButton, purgeCloudflareCache, openParticipantModal, closeParticipantModal, submitParticipantSetup, openPrePostSurveyModal, closePrePostSurveyModal, submitPrePostSurvey, changeBaseSampleRate, handleWaveformFilterChange, resetWaveformFilterToDefault } from './ui-controls.js';
import { fetchFromR2Worker, fetchFromRailway } from './data-fetcher.js';

// Make functions available globally (for inline onclick handlers)
window.loadStations = loadStations;
window.updateStationList = updateStationList;
window.startStreaming = startStreaming;
window.togglePlayPause = togglePlayPause;
window.toggleLoop = toggleLoop;
window.changePlaybackSpeed = changePlaybackSpeed;
window.changeVolume = changeVolume;
window.purgeCloudflareCache = purgeCloudflareCache;
window.openParticipantModal = openParticipantModal;
window.closeParticipantModal = closeParticipantModal;
window.submitParticipantSetup = submitParticipantSetup;
window.openPrePostSurveyModal = openPrePostSurveyModal;
window.closePrePostSurveyModal = closePrePostSurveyModal;
window.submitPrePostSurvey = submitPrePostSurvey;
window.changeWaveformFilter = handleWaveformFilterChange;
window.toggleAntiAliasing = toggleAntiAliasing;

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
        const ctx = new AudioContext({ sampleRate: 44100 });
        State.setAudioContext(ctx);
        await ctx.audioWorklet.addModule('workers/audio-worklet.js');
        console.log(`🎵 [${Math.round(performance.now() - window.streamingStartTime)}ms] Created new AudioContext (sampleRate: 44100 Hz)`);
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
    
    worklet.port.onmessage = (event) => {
        const { type, bufferSize, samplesConsumed, totalSamples, positionSeconds, samplePosition } = event.data;
        
        if (type === 'position') {
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
            const { position } = event.data;
            
            State.setIsPlaying(false);
            State.setIsPaused(true);
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
        } else if (type === 'finished') {
            if (State.isFetchingNewData) {
                console.log('⚠️ [FINISHED] Ignoring - new data being fetched');
                return;
            }
            
            const { totalSamples: finishedTotalSamples, speed } = event.data;
            console.log(`🏁 [FINISHED] Buffer empty: ${finishedTotalSamples.toLocaleString()} samples @ ${speed.toFixed(2)}x speed`);
            
            if (State.isLooping && State.allReceivedData && State.allReceivedData.length > 0) {
                State.setIsPlaying(true);
                State.setIsPaused(false);
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
                State.setIsPlaying(false);
                
                if (finishedTotalSamples && State.totalAudioDuration > 0) {
                    const finalPosition = finishedTotalSamples / 44100;
                    State.setCurrentAudioPosition(Math.min(finalPosition, State.totalAudioDuration));
                    drawWaveformWithSelection();
                }
                
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
    
    startVisualization();
}

// Main streaming function
export async function startStreaming(event) {
    try {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        
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
            window.audioWorker.terminate();
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
                const ctx = new AudioContext({ sampleRate: 44100 });
                State.setAudioContext(ctx);
                await ctx.audioWorklet.addModule('workers/audio-worklet.js');
                console.log(`🎵 ${logTime()} AudioContext ready`);
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
        
        // 4. Build realistic chunk fetch for active stations
        let realisticChunkPromise = Promise.resolve(null);
        let firstChunkStart = null;
        
        if (isActiveStation) {
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
                    
                    const endMinute = minute + 10;
                    const endHour = hour + Math.floor(endMinute / 60);
                    const endTime = `${String(endHour % 24).padStart(2, '0')}:${String(endMinute % 60).padStart(2, '0')}:00`;
                    
                    const [y, m, d] = date.split('-');
                    const path = `${y}/${m}/${d}`;
                    
                    const newFname = `${stationData.network}_${stationData.station}_${location}_${stationData.channel}_10m_${date}-${startTimeStr.replace(/:/g, '-')}_to_${date}-${endTime.replace(/:/g, '-')}.bin.zst`;
                    const oldFname = `${stationData.network}_${stationData.station}_${location}_${stationData.channel}_${sampleRate}Hz_10m_${date}-${startTimeStr.replace(/:/g, '-')}_to_${date}-${endTime.replace(/:/g, '-')}.bin.zst`;
                    
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
                            console.log(`📥 ${logTime()} Realistic chunk SUCCESS (${attempt.label}): ${date} ${time} - ${(compressed.byteLength / 1024).toFixed(1)} KB`);
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
        
        const baseMessage = isActiveStation ? 'Fetching data from R2 via progressive streaming' : 'Fetching data from Railway backend';
        document.getElementById('status').className = 'status info loading';
        document.getElementById('status').textContent = baseMessage;
        
        if (State.workletNode) {
            State.workletNode.port.onmessage = null;
            if (State.gainNode && State.audioContext && State.isPlaying) {
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
            State.setAllReceivedData([]);
            State.setCompleteSamplesArray(null);
            State.setCachedWaveformCanvas(null);
            State.setWaveformMinMaxData(null);
            State.setCurrentMetadata(null);
            State.setTotalAudioDuration(0);
            State.setCurrentAudioPosition(0);
            document.getElementById('playbackDuration').textContent = '--';
            window.playbackDurationSeconds = null;
            stopPositionTracking();
            document.getElementById('currentPosition').textContent = '0m 0s';
            if (State.waveformWorker) {
                State.waveformWorker.postMessage({ type: 'reset' });
            }
            const waveformCanvas = document.getElementById('waveform');
            if (waveformCanvas) {
                const ctx = waveformCanvas.getContext('2d');
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, waveformCanvas.width, waveformCanvas.height);
            }
            State.setIsPlaying(false);
            State.setIsPaused(false);
        }
        
        await initAudioWorklet();
        
        const startBtn = document.getElementById('startBtn');
        const playPauseBtn = document.getElementById('playPauseBtn');
        
        startBtn.classList.add('streaming');
        startBtn.disabled = true;
        
        playPauseBtn.disabled = true;
        playPauseBtn.textContent = '⏸️ Pause';
        playPauseBtn.classList.remove('pause-active', 'play-active', 'loop-active', 'pulse-play', 'pulse-resume');
        
        const loopBtn = document.getElementById('loopBtn');
        loopBtn.disabled = true;
        loopBtn.classList.remove('loop-active');
        
        State.setIsPlaying(true);
        State.setIsPaused(false);
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
        
        if (isActiveStation) {
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
    }
}

// DOMContentLoaded initialization
window.addEventListener('DOMContentLoaded', () => {
    console.log('🌋 [0ms] volcano-audio v1.74 - Progressive Waveform Drawing');
    console.log('📦 [0ms] v1.74 Feature: Unified collector service now handles both R2 collection + on-demand streaming');
    
    initWaveformWorker();
    
    const sliderValueFor1x = calculateSliderForSpeed(1.0);
    document.getElementById('playbackSpeed').value = sliderValueFor1x;
    console.log(`Initialized playback speed slider at position ${sliderValueFor1x} for 1.0x speed`);
    
    loadStations();
    
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
    changeSpectrogramScrollSpeed();
    
    document.getElementById('waveformFilterLabel').addEventListener('click', resetWaveformFilterToDefault);
    
    setupWaveformInteraction();
    
    // Spacebar to toggle play/pause
    document.addEventListener('keydown', (event) => {
        if (event.code === 'Space') {
            const isTextInput = event.target.tagName === 'INPUT' && event.target.type !== 'range';
            const isTextarea = event.target.tagName === 'TEXTAREA';
            const isSelect = event.target.tagName === 'SELECT';
            
            if (isTextInput || isTextarea || isSelect) {
                return;
            }
            
            event.preventDefault();
            
            const playPauseBtn = document.getElementById('playPauseBtn');
            if (!playPauseBtn.disabled && (State.isPlaying || State.allReceivedData.length > 0)) {
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
    const dropdowns = ['volcano', 'dataType', 'station', 'duration'];
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
});

