// ========== CDAWEB AUDIO FETCHER ==========
// Fetches pre-audified WAV files from NASA CDAWeb and decodes them for visualization

import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { updatePlaybackIndicator, drawWaveform, startPlaybackIndicator } from './waveform-renderer.js';
import { updatePlaybackSpeed } from './audio-player.js';
import { updatePlaybackDuration } from './ui-controls.js';
import { drawFrequencyAxis, positionAxisCanvas, initializeAxisPlaybackRate } from './spectrogram-axis-renderer.js';
import { drawWaveformAxis, positionWaveformAxisCanvas } from './waveform-axis-renderer.js';
import { positionWaveformXAxisCanvas, drawWaveformXAxis, positionWaveformDateCanvas, drawWaveformDate } from './waveform-x-axis-renderer.js';
import { startCompleteVisualization, clearCompleteSpectrogram } from './spectrogram-complete-renderer.js';
import { zoomState } from './zoom-state.js';
import { showTutorialOverlay, shouldShowPulse, markPulseShown, setStatusText, addSpectrogramGlow, removeSpectrogramGlow, disableWaveformClicks, enableWaveformClicks } from './tutorial.js';
import { updateCompleteButtonState, loadRegionsAfterDataFetch } from './region-tracker.js';
import { isStudyMode } from './master-modes.js';
import { isTutorialActive } from './tutorial-state.js';
import { storeAudioData, getAudioData } from './cdaweb-cache.js';

// ========== CONSOLE DEBUG FLAGS ==========
// Centralized reference for all debug flags across the codebase
// Set to true to enable detailed logging for each category
//
// Available flags:
//   DEBUG_CHUNKS (data-fetcher.js) - Chunk loading, downloading, and processing logs
//   DEBUG_WAVEFORM (waveform-renderer.js, waveform-worker.js) - Waveform building and rendering logs
//   DEBUG_AXIS (waveform-x-axis-renderer.js) - Axis drawing and tick rendering logs

// Debug flag for chunk loading logs (set to true to enable detailed logging)
const DEBUG_CHUNKS = false;

// CDAWeb API Configuration
const CDASWS_BASE_URL = 'https://cdaweb.gsfc.nasa.gov/WS/cdasr/1';
const DATAVIEW = 'sp_phys';  // Space Physics dataview
const CDAWEB_AUDIO_SAMPLE_RATE = 22000; // CDAWeb produces 22kHz audio

// Dataset to variable mapping
const DATASET_VARIABLES = {
    'PSP_FLD_L2_MAG_RTN': 'psp_fld_l2_mag_RTN',
    'PSP_FLD_L2_MAG_RTN_4_SA_PER_CYC': 'psp_fld_l2_mag_RTN_4_Sa_per_Cyc',
    'WI_H2_MFI': 'BGSE', // Wind uses component names
    'MMS1_FGM_SRVY_L2': 'mms1_fgm_b_gse_srvy_l2',
    'MMS1_FGM_BRST_L2': 'mms1_fgm_b_gse_brst_l2'
};

/**
 * Fetch audio data from CDAWeb API
 * @param {string} spacecraft - Spacecraft name (e.g., 'PSP', 'Wind', 'MMS')
 * @param {string} dataset - Dataset ID
 * @param {string} startTime - ISO 8601 start time (e.g., '2025-07-31T22:00:00.000Z')
 * @param {string} endTime - ISO 8601 end time
 * @returns {Promise<Object>} Object containing decoded audio samples and metadata
 */
export async function fetchCDAWebAudio(spacecraft, dataset, startTime, endTime) {
    console.log(`🛰️ Fetching CDAWeb audio: ${spacecraft} ${dataset} ${startTime} to ${endTime}`);
    
    // Check cache first
    console.log(`🔍 Checking cache for: ${spacecraft} ${dataset} ${startTime} → ${endTime}`);
    const cached = await getAudioData(spacecraft, dataset, startTime, endTime);
    if (cached) {
        console.log('✅ Loading from cache (local IndexedDB)');
        console.log(`   📊 WAV blob size: ${(cached.wavBlob.size / 1024).toFixed(2)} KB`);
        console.log(`   📊 Cache metadata:`, cached.metadata);
        console.log(`   📊 Cache allFileUrls:`, cached.metadata?.allFileUrls);
        // Decode cached WAV blob
        const decoded = await decodeWAVBlob(cached.wavBlob, cached);
        console.log(`   ✅ Cache load complete: ${decoded.numSamples.toLocaleString()} samples decoded`);
        console.log(`   📊 Decoded allFileUrls:`, decoded.allFileUrls);
        return decoded;
    }
    
    console.log('🌐 Cache miss - fetching from CDAWeb API');
    
    // Convert to basic ISO 8601 format (required by CDASWS)
    const startTimeBasic = toBasicISO8601(startTime);
    const endTimeBasic = toBasicISO8601(endTime);
    
    // Get variable name for dataset
    const variable = DATASET_VARIABLES[dataset] || dataset;
    
    // Build API URL
    const apiUrl = `${CDASWS_BASE_URL}/dataviews/${DATAVIEW}/datasets/${dataset}/data/${startTimeBasic},${endTimeBasic}/${variable}?format=audio`;
    
    console.log(`📡 CDAWeb API: ${apiUrl}`);
    
    const fetchStartTime = performance.now();
    
    try {
        // Fetch from CDAWeb API
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`CDAWeb API error (HTTP ${response.status}): ${errorText.substring(0, 200)}`);
        }
        
        const result = await response.json();
        const apiFetchTime = performance.now() - fetchStartTime;
        
        // Validate response
        if (!result || !result.FileDescription || result.FileDescription.length === 0) {
            throw new Error('No audio file created by CDAWeb API');
        }
        
        console.log(`📊 CDAWeb returned ${result.FileDescription.length} file(s):`, result.FileDescription.map(f => f.Name));
        
        // Store all file URLs for component switching (PSP returns [br, bt, bn])
        const allFileUrls = result.FileDescription.map(f => f.Name);
        const allFileInfo = result.FileDescription;
        
        // Get first audio file for initial playback
        const fileInfo = result.FileDescription[0];
        const audioFileUrl = fileInfo.Name;
        
        console.log(`📥 Downloading WAV file: ${audioFileUrl}`);
        console.log(`📊 CDAWeb FileInfo:`, fileInfo);
        
        // Download WAV file
        const wavResponse = await fetch(audioFileUrl);
        if (!wavResponse.ok) {
            throw new Error(`Failed to download WAV file (HTTP ${wavResponse.status})`);
        }
        
        const wavBlob = await wavResponse.blob();
        const totalFetchTime = performance.now() - fetchStartTime;
        
        console.log(`✅ WAV downloaded: ${(wavBlob.size / 1024).toFixed(2)} KB in ${totalFetchTime.toFixed(0)}ms`);
        
        // Prepare metadata for caching
        const metadata = {
            fileSize: wavBlob.size,
            fileInfo: fileInfo,
            apiFetchTime,
            totalFetchTime,
            component: 'first', // TODO: Handle multi-component selection
            allFileUrls: allFileUrls, // All component URLs
            allFileInfo: allFileInfo  // All file info objects
        };
        
        // Cache for future use
        await storeAudioData({
            spacecraft,
            dataset,
            startTime,
            endTime,
            wavBlob,
            metadata
        });
        
        // Decode and return
        return await decodeWAVBlob(wavBlob, { spacecraft, dataset, startTime, endTime, metadata });
        
    } catch (error) {
        console.error('❌ CDAWeb fetch error:', error);
        throw error;
    }
}

/**
 * Decode WAV blob to audio samples using Web Audio API
 * @param {Blob} wavBlob - WAV file blob
 * @param {Object} cacheEntry - Cache entry with metadata
 * @returns {Promise<Object>} Decoded audio data
 */
async function decodeWAVBlob(wavBlob, cacheEntry) {
    console.log(`🎵 Decoding WAV file (${(wavBlob.size / 1024).toFixed(2)} KB)...`);
    
    const decodeStartTime = performance.now();
    
    // Read blob as ArrayBuffer
    const arrayBuffer = await wavBlob.arrayBuffer();
    
    // Create AudioContext for decoding (we'll close it after)
    const offlineContext = new (window.AudioContext || window.webkitAudioContext)();
    
    try {
        // Decode WAV file
        const audioBuffer = await offlineContext.decodeAudioData(arrayBuffer);
        
        const decodeTime = performance.now() - decodeStartTime;
        console.log(`✅ WAV decoded in ${decodeTime.toFixed(0)}ms: ${audioBuffer.numberOfChannels} channel(s), ${audioBuffer.sampleRate} Hz, ${audioBuffer.length} samples`);
        
        // Extract samples from first channel (mono audio from CDAWeb)
        const samples = audioBuffer.getChannelData(0); // Float32Array, already normalized -1 to 1
        
        // Calculate original spacecraft data frequency
        // Time span in seconds
        const startDate = new Date(cacheEntry.startTime);
        const endDate = new Date(cacheEntry.endTime);
        const timeSpanSeconds = (endDate - startDate) / 1000;
        
        // Original data frequency = (number of samples / time span) / 2 (Nyquist)
        // But this is the AUDIO sample rate, not the original data rate
        // CDAWeb audifies at 22050 Hz, so the original data was sampled at a much lower rate
        // We need to calculate what the original data frequency range was
        
        // For now, we'll use a simplified approach:
        // The audio represents the full frequency content of the original data
        // The audio sample rate is 22050 Hz, so Nyquist is 11025 Hz
        // But the original data was much slower - we need to derive this from the time span
        
        // If we have X samples over Y seconds, the original sampling rate was X/Y Hz
        const originalSamplingRate = audioBuffer.length / timeSpanSeconds;
        const originalNyquistFrequency = originalSamplingRate / 2;
        
        // 🔬 TODO: INVESTIGATE - CDAWeb may encode 2 audio samples per data point
        // For now, divide Y-axis max by 2 to match expected magnetometer frequencies
        // This needs further investigation with CDAWeb documentation
        const yAxisMaxFrequency = originalNyquistFrequency / 2;
        
        console.log(`📊 ⭐ SAMPLING RATE CALCULATION:`);
        console.log(`   Audio file properties:`);
        console.log(`     - Sample rate: ${audioBuffer.sampleRate} Hz (audio encoding rate)`);
        console.log(`     - Duration: ${audioBuffer.duration.toFixed(2)} seconds (audio playback time)`);
        console.log(`     - Samples: ${audioBuffer.length.toLocaleString()} samples`);
        console.log(`   Real-world data span:`);
        console.log(`     - Start: ${startDate.toISOString()}`);
        console.log(`     - End: ${endDate.toISOString()}`);
        console.log(`     - Duration: ${timeSpanSeconds.toFixed(2)} seconds`);
        console.log(`   📐 CALCULATION: ${audioBuffer.length.toLocaleString()} samples ÷ ${timeSpanSeconds.toFixed(2)} sec = ${originalSamplingRate.toFixed(2)} Hz`);
        console.log(`   → Original sampling rate: ${originalSamplingRate.toFixed(2)} Hz`);
        console.log(`   → Nyquist frequency: ${originalNyquistFrequency.toFixed(2)} Hz`);
        console.log(`   🔬 Y-axis max (÷2 adjustment): ${yAxisMaxFrequency.toFixed(2)} Hz`);
        
        // Close the offline context
        await offlineContext.close();
        
        return {
            samples: samples, // Float32Array, already normalized
            sampleRate: audioBuffer.sampleRate, // Audio sample rate (22050 Hz)
            numSamples: audioBuffer.length,
            duration: audioBuffer.duration, // Audio duration in seconds
            startTime: startDate,
            endTime: endDate,
            originalSamplingRate: originalSamplingRate, // Original data sampling rate (Hz)
            originalDataFrequencyRange: {
                min: 0,
                max: yAxisMaxFrequency  // Using adjusted frequency for Y-axis (Nyquist ÷ 2)
            },
            metadata: cacheEntry.metadata || {},
            allFileUrls: cacheEntry.metadata?.allFileUrls || [], // All component URLs from CDAWeb
            allFileInfo: cacheEntry.metadata?.allFileInfo || [],  // All file info objects
            originalBlob: wavBlob  // Original WAV blob from CDAWeb (for direct download!)
        };
        
    } catch (error) {
        await offlineContext.close();
        console.error('❌ WAV decode error:', error);
        throw new Error(`Failed to decode WAV file: ${error.message}`);
    }
}

/**
 * Convert ISO 8601 extended format to basic format
 * e.g., "2025-07-31T22:00:00.000Z" -> "20250731T220000Z"
 */
function toBasicISO8601(isoString) {
    // Remove milliseconds if present
    let cleaned = isoString.replace(/\.\d{3}/g, '');
    // Remove all dashes and colons, keep T and Z
    cleaned = cleaned.replace(/-/g, '').replace(/:/g, '');
    return cleaned;
}

/**
 * Fetch and load CDAWeb audio data into application state
 * This is the main entry point called from startStreaming
 * @param {string} spacecraft - Spacecraft name
 * @param {string} dataset - Dataset ID
 * @param {string} startTimeISO - ISO 8601 start time
 * @param {string} endTimeISO - ISO 8601 end time
 */
export async function fetchAndLoadCDAWebData(spacecraft, dataset, startTimeISO, endTimeISO) {
    const logTime = () => `[${Math.round(performance.now() - window.streamingStartTime)}ms]`;
    
    try {
        console.log(`📡 ${logTime()} Fetching CDAWeb audio data...`);
        
        // Fetch and decode audio from CDAWeb (includes caching)
        const audioData = await fetchCDAWebAudio(spacecraft, dataset, startTimeISO, endTimeISO);
        
        console.log(`✅ ${logTime()} Audio decoded: ${audioData.numSamples.toLocaleString()} samples, ${audioData.duration.toFixed(2)}s`);
        console.log(`🔍 [PIPELINE] Samples array type: ${audioData.samples?.constructor?.name}, length: ${audioData.samples?.length}, originalSamplingRate: ${audioData.originalSamplingRate}`);
        
        // Set metadata (needed by waveform renderer)
        State.setCurrentMetadata({
            original_sample_rate: audioData.originalSamplingRate,
            spacecraft: spacecraft,
            dataset: dataset,
            startTime: startTimeISO,
            endTime: endTimeISO
        });
        console.log(`🔍 [PIPELINE] Metadata set: original_sample_rate=${State.currentMetadata?.original_sample_rate}`);
        
        // Set state variables (matching the old pattern)
        State.setCompleteSamplesArray(audioData.samples); // Float32Array, already normalized
        console.log(`🔍 [PIPELINE] State.completeSamplesArray set: length=${State.completeSamplesArray?.length}, type=${State.completeSamplesArray?.constructor?.name}`);
        State.setOriginalAudioBlob(audioData.originalBlob); // Original WAV blob from CDAWeb (for direct download!)
        State.setDataStartTime(audioData.startTime); // UTC Date object
        State.setDataEndTime(audioData.endTime); // UTC Date object
        State.setOriginalDataFrequencyRange(audioData.originalDataFrequencyRange); // { min, max }
        State.setTotalAudioDuration(audioData.duration); // seconds
        
        // 🎯 CDAWeb: Default to logarithmic scale for space physics data
        // (unless user has explicitly changed it before)
        const frequencyScaleSelect = document.getElementById('frequencyScale');
        if (frequencyScaleSelect) {
            // Only change if currently on default sqrt scale (not if user manually selected linear/log before)
            const hasUserPreference = localStorage.getItem('frequencyScale') !== null;
            if (!hasUserPreference || State.frequencyScale === 'sqrt') {
                console.log('📊 CDAWeb data: Setting frequency scale to logarithmic (default for space physics)');
                frequencyScaleSelect.value = 'logarithmic';
                State.setFrequencyScale('logarithmic');
                localStorage.setItem('frequencyScale', 'logarithmic');
            }
        }
        
        // Initialize component selector if multiple files available
        console.log(`🔍 [COMPONENT SELECTOR] allFileUrls:`, audioData.allFileUrls);
        console.log(`🔍 [COMPONENT SELECTOR] Number of files: ${audioData.allFileUrls?.length || 0}`);
        if (audioData.allFileUrls && audioData.allFileUrls.length > 1) {
            console.log(`🔍 [COMPONENT SELECTOR] Multiple files detected - initializing selector`);
            const { initializeComponentSelector } = await import('./component-selector.js');
            initializeComponentSelector(audioData.allFileUrls);
        } else {
            console.log(`🔍 [COMPONENT SELECTOR] Single file or no files - hiding selector`);
            const { hideComponentSelector } = await import('./component-selector.js');
            hideComponentSelector();
        }
        
        // Show download button after audio loads
        const downloadContainer = document.getElementById('downloadAudioContainer');
        if (downloadContainer) {
            downloadContainer.style.display = 'block';
        }
        console.log(`🔍 [PIPELINE] State.totalAudioDuration set: ${State.totalAudioDuration}s`);
        
        // Set playback duration (for UI display)
        State.setPlaybackDurationSeconds(audioData.duration);
        updatePlaybackDuration(audioData.duration);
        
        // Enable Begin Analysis/Complete button after data loads (skip during tutorial)
        if (!isTutorialActive()) {
            updateCompleteButtonState();
        }
        
        // Send samples to waveform worker BEFORE building waveform
        console.log(`🔍 [PIPELINE] Sending samples to waveform worker: ${audioData.samples.length} samples`);
        if (State.waveformWorker) {
            State.waveformWorker.postMessage({
                type: 'add-samples',
                samples: audioData.samples,
                rawSamples: audioData.samples // For CDAWeb, samples are already normalized, use same for raw
            });
            console.log(`🔍 [PIPELINE] Samples sent to waveform worker`);
        } else {
            console.error(`❌ [PIPELINE] Cannot send samples: State.waveformWorker is null!`);
        }
        
        // Draw waveform
        console.log(`🎨 ${logTime()} Drawing waveform...`);
        positionWaveformAxisCanvas();
        drawWaveformAxis();
        drawWaveform();
        
        // Draw x-axis
        positionWaveformXAxisCanvas();
        drawWaveformXAxis();
        
        // Draw frequency axis with new frequency range
        positionAxisCanvas();
        drawFrequencyAxis();
        
        // Start complete visualization (spectrogram)
        console.log(`📊 ${logTime()} Starting spectrogram visualization...`);
        await startCompleteVisualization();
        
        // Load regions after data fetch (if any)
        await loadRegionsAfterDataFetch();
        
        // Send samples to AudioWorklet for playback
        if (State.workletNode && State.audioContext) {
            console.log(`🔍 [PIPELINE] Sending samples to AudioWorklet: ${audioData.samples.length} samples`);
            
            // 🎚️ CRITICAL: Set first-play flag BEFORE sending samples
            // This ensures auto-resume uses the long fade when it triggers
            State.workletNode.port.postMessage({
                type: 'set-first-play-flag'
            });
            console.log(`🎚️ PIPELINE: Set first-play flag BEFORE sending samples (for long fade-in)`);
            
            const WORKLET_CHUNK_SIZE = 1024;
            State.setAllReceivedData([]);
            
            for (let i = 0; i < audioData.samples.length; i += WORKLET_CHUNK_SIZE) {
                const chunkSize = Math.min(WORKLET_CHUNK_SIZE, audioData.samples.length - i);
                // Copy slice to new ArrayBuffer for independent GC
                const slice = audioData.samples.slice(i, i + chunkSize);
                const chunk = new Float32Array(slice);
                
                State.workletNode.port.postMessage({
                    type: 'audio-data',
                    data: chunk,
                    autoResume: true
                });
                
                State.allReceivedData.push(chunk);
            }
            
            console.log(`🔍 [PIPELINE] Sent ${State.allReceivedData.length} chunks to AudioWorklet`);
            
            // Send data-complete message with sample rate
            State.workletNode.port.postMessage({
                type: 'data-complete',
                totalSamples: audioData.samples.length,
                sampleRate: audioData.originalSamplingRate // Original data sample rate, not audio sample rate
            });
            
            console.log(`🔍 [PIPELINE] Sent data-complete: totalSamples=${audioData.samples.length}, sampleRate=${audioData.originalSamplingRate}`);
            
            // Initialize zoom state with total sample count
            zoomState.initialize(audioData.samples.length);
            
            // Update playback speed (needed for worklet)
            updatePlaybackSpeed();
            
            // Check if autoPlay is enabled
            const autoPlayEnabled = document.getElementById('autoPlay')?.checked || false;
            if (autoPlayEnabled) {
                // Start playback immediately
                State.workletNode.port.postMessage({ type: 'start-immediately' });
                console.log(`🚀 Sent 'start-immediately' to worklet`);
                
                // Update playback state
                State.setPlaybackState(PlaybackState.PLAYING);
                
                // Notify oscilloscope that playback started
                const { setPlayingState } = await import('./oscilloscope-renderer.js');
                setPlayingState(true);
                
                // Note: Fade-in is handled by worklet's startFade() in startImmediately()
                
                // Reset position tracking
                State.setCurrentAudioPosition(0);
                State.setLastWorkletPosition(0);
                State.setLastWorkletUpdateTime(State.audioContext.currentTime);
                State.setLastUpdateTime(State.audioContext.currentTime);
                
                // Update play/pause button
                const playPauseBtn = document.getElementById('playPauseBtn');
                if (playPauseBtn) {
                    playPauseBtn.disabled = false;
                    playPauseBtn.textContent = '⏸️ Pause';
                    playPauseBtn.classList.remove('play-active', 'secondary');
                    playPauseBtn.classList.add('pause-active');
                }
            } else {
                console.log(`⏸️ Auto Play disabled - waiting for user to click Play`);
                State.setPlaybackState(PlaybackState.STOPPED);
                
                // Enable play button
                const playPauseBtn = document.getElementById('playPauseBtn');
                if (playPauseBtn) {
                    playPauseBtn.disabled = false;
                    playPauseBtn.textContent = '▶️ Play';
                    playPauseBtn.classList.remove('pause-active', 'secondary');
                    playPauseBtn.classList.add('play-active');
                }
            }
        } else {
            console.warn(`⚠️ [PIPELINE] Cannot send samples to worklet: workletNode=${!!State.workletNode}, audioContext=${!!State.audioContext}`);
        }
        
        console.log(`✅ ${logTime()} CDAWeb data loaded and visualized!`);
        
        // Update recent searches dropdown (called from startStreaming instead)
        
        return audioData;
        
    } catch (error) {
        console.error('❌ Failed to load CDAWeb data:', error);
        alert(`Failed to load audio data: ${error.message}`);
        throw error;
    }
}

// Helper: Normalize data to [-1, 1] range (LEGACY - not needed for WAV files)
function normalize(data) {
    let min = data[0];
    let max = data[0];
    for (let i = 1; i < data.length; i++) {
        if (data[i] < min) min = data[i];
        if (data[i] > max) max = data[i];
    }
    
    if (max === min) {
        return new Float32Array(data.length);
    }
    
    const normalized = new Float32Array(data.length);
    const range = max - min;
    for (let i = 0; i < data.length; i++) {
        normalized[i] = 2 * (data[i] - min) / range - 1;
    }
    
    return normalized;
}

// Calculate which chunks are needed using progressive algorithm
function calculateChunksNeededMultiDay(startTime, endTime, allDayMetadata) {
    const chunks = [];
    
    // Helper to format time as HH:MM:SS
    const formatTime = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
    
    // Helper to find chunk in metadata
    const findChunk = (date, time, type) => {
        const dayMeta = allDayMetadata.find(m => m && m.date === date);
        if (!dayMeta || !dayMeta.chunks[type]) return null;
        return dayMeta.chunks[type].find(c => c.start === time);
    };
    
    // Helper to check alignment
    const isHourAligned = (minute) => minute === 0;
    const is6hAligned = (hour, minute) => hour % 6 === 0 && minute === 0;
    
    // Start from rounded 10m boundary
    let currentTime = new Date(startTime);
    currentTime.setUTCMinutes(Math.floor(currentTime.getUTCMinutes() / 10) * 10, 0, 0);
    
    let minutesElapsed = 0;
    let hasUsed1h = false;
    
    while (currentTime < endTime) {
        const currentDate = currentTime.toISOString().split('T')[0];
        const currentHour = currentTime.getUTCHours();
        const currentMinute = currentTime.getUTCMinutes();
        const timeStr = formatTime(currentHour, currentMinute);
        const remainingMinutes = (endTime - currentTime) / 1000 / 60;
        
        // FIRST 60 MINUTES: MUST use 10m chunks
        if (minutesElapsed < 60) {
            const chunkData = findChunk(currentDate, timeStr, '10m');
            if (chunkData) {
                chunks.push({
                    type: '10m',
                    start: chunkData.start,
                    end: chunkData.end,
                    min: chunkData.min,
                    max: chunkData.max,
                    samples: chunkData.samples,
                    date: currentDate
                });
                if (DEBUG_CHUNKS) console.log(`✅ Found 10m chunk: ${currentDate} ${timeStr} (${chunkData.samples.toLocaleString()} samples)`);
            } else {
                // Calculate expected end time for missing chunk
                const endTime = new Date(currentTime);
                endTime.setUTCMinutes(endTime.getUTCMinutes() + 10);
                const endTimeStr = formatTime(endTime.getUTCHours(), endTime.getUTCMinutes());
                
                // Get sample rate from first available metadata
                const firstDayMeta = allDayMetadata.find(m => m && m.sample_rate);
                const sampleRate = firstDayMeta ? firstDayMeta.sample_rate : 50; // Default to 50 Hz if not found
                const expectedSamples = 10 * 60 * sampleRate; // 10 minutes worth
                
                chunks.push({
                    type: '10m',
                    start: timeStr,
                    end: endTimeStr,
                    min: 0,
                    max: 0,
                    samples: expectedSamples,
                    date: currentDate,
                    isMissing: true // 🆕 Flag for missing data
                });
                console.warn(`⚠️ MISSING 10m chunk: ${currentDate} ${timeStr} - will fill with ${expectedSamples.toLocaleString()} zeros`);
            }
            currentTime.setUTCMinutes(currentTime.getUTCMinutes() + 10);
            minutesElapsed += 10;
            continue;
        }
        
        // AFTER 60 MINUTES: Use LARGEST chunk available at this boundary
        // Priority: 6h > 1h > 10m
        
        // Try 6h chunk (must have used 1h first, be at 6h boundary, have enough time)
        if (hasUsed1h && is6hAligned(currentHour, currentMinute) && remainingMinutes >= 360) {
            const chunkData = findChunk(currentDate, timeStr, '6h');
            if (chunkData) {
                chunks.push({
                    type: '6h',
                    start: chunkData.start,
                    end: chunkData.end,
                    min: chunkData.min,
                    max: chunkData.max,
                    samples: chunkData.samples,
                    date: currentDate
                });
                currentTime.setUTCHours(currentTime.getUTCHours() + 6);
                minutesElapsed += 360;
                continue;
            }
        }
        
        // Try 1h chunk (at hour boundary, have enough time)
        if (isHourAligned(currentMinute) && remainingMinutes >= 60) {
            const chunkData = findChunk(currentDate, timeStr, '1h');
            if (chunkData) {
                chunks.push({
                    type: '1h',
                    start: chunkData.start,
                    end: chunkData.end,
                    min: chunkData.min,
                    max: chunkData.max,
                    samples: chunkData.samples,
                    date: currentDate
                });
                currentTime.setUTCHours(currentTime.getUTCHours() + 1);
                minutesElapsed += 60;
                hasUsed1h = true; // Mark that we've used a 1h chunk
                continue;
            }
        }
        
        // Use 10m chunk
        const chunkData = findChunk(currentDate, timeStr, '10m');
        if (chunkData) {
            chunks.push({
                type: '10m',
                start: chunkData.start,
                end: chunkData.end,
                min: chunkData.min,
                max: chunkData.max,
                samples: chunkData.samples,
                date: currentDate
            });
            if (DEBUG_CHUNKS) console.log(`✅ Found 10m chunk: ${currentDate} ${timeStr} (${chunkData.samples.toLocaleString()} samples)`);
        } else {
            // Calculate expected end time for missing chunk
            const endTime = new Date(currentTime);
            endTime.setUTCMinutes(endTime.getUTCMinutes() + 10);
            const endTimeStr = formatTime(endTime.getUTCHours(), endTime.getUTCMinutes());
            
            // Get sample rate from first available metadata
            const firstDayMeta = allDayMetadata.find(m => m && m.sample_rate);
            const sampleRate = firstDayMeta ? firstDayMeta.sample_rate : 50; // Default to 50 Hz if not found
            const expectedSamples = 10 * 60 * sampleRate; // 10 minutes worth
            
            chunks.push({
                type: '10m',
                start: timeStr,
                end: endTimeStr,
                min: 0,
                max: 0,
                samples: expectedSamples,
                date: currentDate,
                isMissing: true // 🆕 Flag for missing data
            });
            console.warn(`⚠️ MISSING 10m chunk: ${currentDate} ${timeStr} - will fill with ${expectedSamples.toLocaleString()} zeros`);
        }
        currentTime.setUTCMinutes(currentTime.getUTCMinutes() + 10);
        minutesElapsed += 10;
    }
    
    return chunks;
}

// Create progressive download batches
function createDownloadBatches(chunks) {
    if (chunks.length === 0) return [];
    
    const batches = [];
    let currentType = null;
    let batchSize = 1; // Start at 1 for each type
    let remainingInType = [];
    let chunksOfTypeProcessed = 0; // Track chunks processed in current type
    
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        
        // Type change → flush and reset
        if (chunk.type !== currentType) {
            // Flush any remaining from previous type
            if (remainingInType.length > 0) {
                batches.push([...remainingInType]);
                remainingInType = [];
            }
            
            currentType = chunk.type;
            batchSize = 1; // RESET to 1
            chunksOfTypeProcessed = 0; // RESET counter
        }
        
        remainingInType.push(i);
        
        // 🎯 SPECIAL: First 3 ten-minute chunks download individually for runway
        const isFirst3TenMinute = (currentType === '10m' && chunksOfTypeProcessed < 3);
        
        if (isFirst3TenMinute) {
            // Always flush after 1 chunk for first 3 ten-minute chunks
            batches.push([...remainingInType]);
            remainingInType = [];
            chunksOfTypeProcessed++;
            // Keep batchSize = 1 for first 3
        } else {
            // Normal batching logic
            if (remainingInType.length === batchSize) {
                batches.push([...remainingInType]);
                remainingInType = [];
                chunksOfTypeProcessed += batchSize;
                
                // Increment batch size for next batch (with cap for 6h)
                if (currentType === '6h') {
                    batchSize = Math.min(batchSize + 1, 4); // CAP at 4 for 6h chunks
                } else {
                    batchSize++; // No cap for 10m and 1h
                }
            }
        }
    }
    
    // Flush any remaining chunks
    if (remainingInType.length > 0) {
        batches.push(remainingInType);
    }
    
    return batches;
}

// ===== MODE 1: CDN DIRECT STREAMING (7.8x faster than worker!) =====
export async function fetchFromR2Worker(stationData, startTime, estimatedEndTime, duration, highpassFreq, realisticChunkPromise, firstChunkStart) {
    const formatTime = (date) => {
        return date.toISOString().slice(0, 19);
    };
    
    // CDN URL (direct R2 access via Cloudflare CDN - 7.8x faster than worker!)
    const CDN_BASE_URL = 'https://cdn.now.audio/data';
    
    // Check if cache bypass is enabled
    const bypassCache = document.getElementById('bypassCache').checked;
    const cacheBuster = bypassCache ? `?t=${Date.now()}` : '';
    
    // Get high-pass filter setting from UI (same as Railway)
    const highpassValue = highpassFreq === 'none' ? 0 : parseFloat(highpassFreq);
    
    const durationMinutes = duration * 60; // Convert hours to minutes
    
    const logTime = () => `[${Math.round(performance.now() - window.streamingStartTime)}ms]`;
    // Only log in dev/personal modes, not study mode
    if (!isStudyMode()) {
        console.log(`📡 ${logTime()} Fetching from CDN (direct):`, {
            network: stationData.network,
            station: stationData.station,
            location: stationData.location || '--',
            channel: stationData.channel,
            start_time: startTime.toISOString(),
            duration_minutes: durationMinutes
        });
    }
        
        // STEP 1: Fetch metadata (realistic chunk already running!)
        if (!isStudyMode()) {
            console.log(`📋 ${logTime()} Fetching metadata from CDN...`);
        }
        
        // Map station codes to volcano names for CDN URL
        const volcanoMap = {
            'kilauea': 'kilauea',
            'maunaloa': 'maunaloa',
            'greatsitkin': 'greatsitkin',
            'shishaldin': 'shishaldin',
            'spurr': 'spurr'
        };
        const volcanoName = volcanoMap[document.getElementById('volcano').value] || 'kilauea';
        
        // Determine which days we need (request might span midnight UTC!)
        const startDate = startTime.toISOString().split('T')[0]; // YYYY-MM-DD
        const endDate = estimatedEndTime.toISOString().split('T')[0];
        const daysNeeded = [];
        
        // Generate list of dates between start and end
        let currentDate = new Date(startTime);
        currentDate.setUTCHours(0, 0, 0, 0); // Start of day
        
        while (currentDate <= estimatedEndTime) {
            daysNeeded.push(currentDate.toISOString().split('T')[0]);
            currentDate.setUTCDate(currentDate.getUTCDate() + 1); // Next day
        }
        
        // Check if we're too close to UTC midnight for today's metadata to exist
        const now = new Date();
        const todayUTC = now.toISOString().split('T')[0];
        const minutesSinceMidnight = now.getUTCHours() * 60 + now.getUTCMinutes();
        
        // If the most recent day is today AND we're within 12 minutes of midnight, remove it
        // (Collector needs time to generate daily metadata file)
        if (daysNeeded.length > 1 && daysNeeded[daysNeeded.length - 1] === todayUTC && minutesSinceMidnight < 12) {
            daysNeeded.pop();
            console.log(`🌙 ${logTime()} UTC midnight grace period! Only ${minutesSinceMidnight} min since midnight - skipping today's metadata (${todayUTC}) to avoid 404s. Collector needs time to wake up! 😊`);
        }
        
        if (!isStudyMode()) {
            console.log(`📋 ${logTime()} Days needed: ${daysNeeded.join(', ')}`);
        }
        
        // Helper to build CDN chunk URL (NEW format: no sample rate)
        function buildChunkUrl(date, startTime, endTime, chunkType) {
            const location = stationData.location || '--';
            const [year, month, day] = date.split('-');
            const datePath = `${year}/${month}/${day}`;
            const startFormatted = startTime.replace(/:/g, '-');
            const endFormatted = endTime.replace(/:/g, '-');
            const filename = `${stationData.network}_${stationData.station}_${location}_${stationData.channel}_${chunkType}_${date}-${startFormatted}_to_${date}-${endFormatted}.bin.zst`;
            return `${CDN_BASE_URL}/${datePath}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/${chunkType}/${filename}`;
        }
        
        // Fetch metadata (in parallel with realistic chunk that's already running!)
        // Try NEW format first (no sample rate), fallback to OLD format (with sample rate)
        const metadataPromises = daysNeeded.map(async (date) => {
            const [year, month, day] = date.split('-');
            const datePath = `${year}/${month}/${day}`;
            const location = stationData.location || '--';
            
            // NEW format (without sample rate)
            const newMetadataUrl = `${CDN_BASE_URL}/${datePath}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/${stationData.network}_${stationData.station}_${location}_${stationData.channel}_${date}.json${cacheBuster}`;
            
            let response = await fetch(newMetadataUrl);
            
            // If NEW format not found, try OLD format (with sample rate)
            if (!response.ok) {
                const oldMetadataUrl = `${CDN_BASE_URL}/${datePath}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/${stationData.network}_${stationData.station}_${location}_${stationData.channel}_${Math.round(stationData.sample_rate || 100)}Hz_${date}.json${cacheBuster}`;
                response = await fetch(oldMetadataUrl);
                
                if (!response.ok) {
                    console.warn(`⚠️ Metadata for ${date} not found in NEW or OLD format (${response.status})`);
                    return null;
                }
                console.log(`📋 Using OLD format metadata for ${date} (will auto-migrate on next collection)`);
            }
            
            return response.json();
        });
        
        // WAIT FOR BOTH: metadata + realistic chunk (passed in as promise)
        const [allDayMetadata, realisticFirstChunk] = await Promise.all([
            Promise.all(metadataPromises),
            realisticChunkPromise
        ]);
        
        const validMetadata = allDayMetadata.filter(m => m !== null);
        if (DEBUG_CHUNKS) console.log(`📋 ${logTime()} Metadata + realistic chunk complete (${validMetadata.length}/${daysNeeded.length} days)`);
        
        // Use our calculated estimatedEndTime as THE TRUTH
        // Metadata is only for min/max normalization, not for determining time range!
        const endTime = estimatedEndTime;
        const adjustedStartTime = startTime;
        
        console.log(`✅ ${logTime()} Using calculated time range: ${adjustedStartTime.toISOString()} to ${endTime.toISOString()}`);
        
        // Log most recent chunk in metadata for debugging
        let actualMostRecentChunk = null;
        for (const dayMeta of validMetadata) {
            if (dayMeta.chunks['10m']) {
                for (const chunk of dayMeta.chunks['10m']) {
                    const chunkTime = new Date(`${dayMeta.date}T${chunk.start}Z`);
                    if (!actualMostRecentChunk || chunkTime > actualMostRecentChunk.time) {
                        actualMostRecentChunk = { time: chunkTime, chunk: chunk, date: dayMeta.date };
                    }
                }
            }
        }
        if (actualMostRecentChunk) {
            if (DEBUG_CHUNKS) console.log(`📋 ${logTime()} Most recent chunk in metadata: ${actualMostRecentChunk.date} ${actualMostRecentChunk.chunk.start}`);
        }
        
        // Calculate which chunks we need across all days
        const chunksNeeded = calculateChunksNeededMultiDay(adjustedStartTime, endTime, validMetadata);
        if (DEBUG_CHUNKS) console.log(`📋 ${logTime()} Calculated chunks needed: ${chunksNeeded.length} chunks`);
        if (DEBUG_CHUNKS) console.log(`📋 ${logTime()} Chunk types: ${chunksNeeded.map(c => c.type).join(', ')}`);
        
        if (chunksNeeded.length === 0) {
            throw new Error('No data available for this time range!');
        }
        
        // Calculate total samples from duration and sample rate (MUCH simpler!)
        const firstDayMeta = validMetadata[0];
        if (!firstDayMeta.sample_rate) {
            throw new Error('Metadata file missing sample_rate!');
        }
        const sampleRate = firstDayMeta.sample_rate; // From CDN metadata file (e.g., 100 Hz for HV.OBL)
        const durationSeconds = (endTime - adjustedStartTime) / 1000; // Convert ms to seconds
        const totalSamples = Math.floor(durationSeconds * sampleRate); // Use actual sample rate!
        console.log(`📊 ${logTime()} Total samples: ${totalSamples.toLocaleString()} (${durationSeconds.toFixed(1)}s × ${sampleRate} Hz)`);
        
        // Update sample count UI early (will update with actual count at completion)
        document.getElementById('sampleCount').textContent = totalSamples.toLocaleString();
        
        // Calculate global min/max from all chunks we're fetching
        let normMin = Infinity;
        let normMax = -Infinity;
        for (const chunk of chunksNeeded) {
            if (chunk.min < normMin) normMin = chunk.min;
            if (chunk.max > normMax) normMax = chunk.max;
        }
        
        console.log(`📊 ${logTime()} Normalization range: ${normMin} to ${normMax}`);
        
        // Store metadata for duration calculation
        State.setCurrentMetadata({
            original_sample_rate: firstDayMeta.sample_rate,
            npts: totalSamples
        });
        
        // Store start/end times for x-axis rendering
        State.setDataStartTime(adjustedStartTime);
        State.setDataEndTime(endTime);
        
        // 🔥 Load saved regions now that time range is known
        loadRegionsAfterDataFetch();
        
        // Draw frequency axis with new metadata
        positionAxisCanvas();
        initializeAxisPlaybackRate();
        
        // Draw x-axis with new time data
        positionWaveformXAxisCanvas();
        drawWaveformXAxis();
        positionWaveformDateCanvas();
        drawWaveformDate();
        
        // 🎯 Set totalAudioDuration early so red scan line appears immediately
        // (This is the EXPECTED duration - we'll update with actual samples at completion)
        // 👑 CRITICAL: Use original sample rate from metadata, NOT AudioContext rate!
        const originalSampleRate = State.currentMetadata?.original_sample_rate || 50;
        const expectedDuration = totalSamples / originalSampleRate;
        State.setTotalAudioDuration(expectedDuration);
        console.log(`📊 ${logTime()} Set EXPECTED totalAudioDuration: ${expectedDuration.toFixed(2)}s (will update with actual at completion)`);
        
        const chunksToFetch = chunksNeeded; // Use our calculated chunks!
        
        if (DEBUG_CHUNKS) console.log(`🚀 ${logTime()} Starting CDN DIRECT streaming (${chunksToFetch.length} chunks)...`);
        
        // 🎯 USE WORKER CREATED AT START OF startStreaming()
        const worker = window.audioWorker;
        
        // Track chunks and state
        const processedChunks = [];
        let chunksReceived = 0;
        let firstChunkSent = false;
        let ttfaTime = null;
        const progressiveT0 = performance.now();
        let totalBytesDownloaded = 0;
        let realisticChunkIndex = null; // Track which chunk the realistic fetch got
        let completionHandled = false; // Prevent multiple completion checks
        
        // 🚀 Match realistic chunk to actual chunks needed!
        if (realisticFirstChunk) {
            // Extract the actual chunk time from the realistic result
            const realisticChunkTime = realisticFirstChunk.time; // HH:MM:SS from successful fetch
            const realisticChunkDate = realisticFirstChunk.date; // YYYY-MM-DD from successful fetch
            const realisticCompressed = realisticFirstChunk.compressed; // The actual data
            
            // Find which chunk index this corresponds to in chunksNeeded
            const matchIndex = chunksToFetch.findIndex(chunk => 
                chunk.date === realisticChunkDate && chunk.start === realisticChunkTime
            );
            
            if (matchIndex >= 0) {
                if (DEBUG_CHUNKS) console.log(`⚡ ${logTime()} Realistic chunk matched chunk ${matchIndex}! (${realisticChunkDate} ${realisticChunkTime})`);
                realisticChunkIndex = matchIndex;
                
                // Send it to worker with correct index
                worker.postMessage({
                    type: 'process-chunk',
                    compressed: realisticCompressed,
                    normMin: normMin,
                    normMax: normMax,
                    chunkIndex: matchIndex
                }, [realisticCompressed]);
                
                if (DEBUG_CHUNKS) console.log(`📥 ${logTime()} Sent realistic chunk ${matchIndex} to worker`);
            } else {
                console.log(`⚠️ ${logTime()} Realistic chunk (${realisticChunkDate} ${realisticChunkTime}) not in chunks needed - discarding`);
                realisticChunkIndex = null;
            }
        } else {
            console.log(`⚠️ ${logTime()} Realistic chunk failed - will fetch all chunks normally`);
        }
        
        // Initialize arrays
        State.setAllReceivedData([]);
        
        // Promise to wait for first chunk to be processed
        let firstChunkProcessedResolve = null;
        const firstChunkProcessed = new Promise(resolve => {
            firstChunkProcessedResolve = resolve;
        });
        
        // Track next chunk to send (to maintain order)
        let nextChunkToSend = 0;
        
        // Helper to send chunks to worklet in order
        function sendChunksInOrder() {
            // Send all sequential chunks that are ready
            while (processedChunks[nextChunkToSend]) {
                let { samples } = processedChunks[nextChunkToSend];
                const currentChunkIndex = nextChunkToSend;
                const currentChunkInfo = chunksToFetch[currentChunkIndex];
                
                // 🎵 SMOOTH BOUNDARIES: If this or adjacent chunks are missing, apply linear interpolation
                // This eliminates clicks when transitioning between real data and silence
                const SMOOTH_SAMPLES = 1000; // ~23ms at 44.1kHz = 1000 samples
                
                // Check if current chunk is missing
                const isMissing = currentChunkInfo?.isMissing || false;
                
                // Check if next chunk is missing (to smooth END of current real chunk)
                const nextChunkInfo = chunksToFetch[nextChunkToSend + 1];
                const nextIsMissing = nextChunkInfo?.isMissing || false;
                
                // Copy samples so we don't modify the original
                samples = new Float32Array(samples);
                
                // SMOOTH START: Transition from previous chunk into this missing chunk
                if (isMissing && nextChunkToSend > 0 && processedChunks[nextChunkToSend - 1]) {
                    const prevSamples = processedChunks[nextChunkToSend - 1].samples;
                    if (prevSamples && prevSamples.length > 0) {
                        const prevValue = prevSamples[prevSamples.length - 1];
                        const targetValue = 0; // Current chunk is silent
                        const smoothLength = Math.min(SMOOTH_SAMPLES, samples.length);
                        
                        for (let i = 0; i < smoothLength; i++) {
                            const alpha = i / smoothLength; // 0 to 1
                            samples[i] = prevValue * (1 - alpha) + targetValue * alpha;
                        }
                    }
                }
                
                // SMOOTH END: Transition from this real chunk into next missing chunk
                if (!isMissing && nextIsMissing) {
                    const smoothLength = Math.min(SMOOTH_SAMPLES, samples.length);
                    const startIdx = samples.length - smoothLength;
                    const startValue = samples[startIdx];
                    const targetValue = 0; // Next chunk is silent
                    
                    for (let i = 0; i < smoothLength; i++) {
                        const alpha = i / smoothLength; // 0 to 1
                        samples[startIdx + i] = startValue * (1 - alpha) + targetValue * alpha;
                    }
                }
                
                // 🎯 SEND TO WORKLET IN ORDER
                const WORKLET_CHUNK_SIZE = 1024;
                for (let i = 0; i < samples.length; i += WORKLET_CHUNK_SIZE) {
                    const size = Math.min(WORKLET_CHUNK_SIZE, samples.length - i);
                    // 🔥 FIX: Copy slice to new ArrayBuffer instead of sharing buffer
                    // This allows GC of individual chunks independently
                    const slice = samples.slice(i, i + size);
                    const workletChunk = new Float32Array(slice); // Copy to new ArrayBuffer
                    
                    State.workletNode.port.postMessage({
                        type: 'audio-data',
                        data: workletChunk,
                        autoResume: true  // 🎯 Enable graceful auto-resume if playback stopped due to buffer underrun
                    });
                    
                    State.allReceivedData.push(workletChunk);
                    
                    // 🎯 FIRST CHUNK (chunk 0) = START FADE-IN
                    // Only start playback when chunk 0 is ready!
                    if (!firstChunkSent && i === 0 && currentChunkIndex === 0) {
                        firstChunkSent = true;
                        ttfaTime = performance.now() - progressiveT0;
                        if (DEBUG_CHUNKS) console.log(`⚡ FIRST CHUNK SENT in ${ttfaTime.toFixed(0)}ms - starting playback!`);
                        
                        const autoPlayEnabled = document.getElementById('autoPlay').checked;
                        
                        if (autoPlayEnabled) {
                            // 🎯 FORCE IMMEDIATE PLAYBACK
                            State.workletNode.port.postMessage({
                                type: 'start-immediately'
                            });
                            console.log(`🚀 Sent 'start-immediately' to worklet`);
                            
                            // Update playback state
                            State.setPlaybackState(PlaybackState.PLAYING);
                            
                            if (State.gainNode && State.audioContext) {
                                const targetVolume = parseFloat(document.getElementById('volumeSlider').value) / 100;
                                State.gainNode.gain.cancelScheduledValues(State.audioContext.currentTime);
                                State.gainNode.gain.setValueAtTime(0.0001, State.audioContext.currentTime);
                                State.gainNode.gain.exponentialRampToValueAtTime(
                                    Math.max(0.01, targetVolume), 
                                    State.audioContext.currentTime + 0.05
                                );
                                console.log(`🔊 Fade-in scheduled: 0.0001 → ${targetVolume.toFixed(2)} over 50ms`);
                            }
                            
                            State.setCurrentAudioPosition(0);
                            State.setLastWorkletPosition(0);
                            State.setLastWorkletUpdateTime(State.audioContext.currentTime);
                            State.setLastUpdateTime(State.audioContext.currentTime);
                            
                            // Enable play button immediately when playback starts
                            const playPauseBtn = document.getElementById('playPauseBtn');
                            playPauseBtn.disabled = false;
                            playPauseBtn.textContent = '⏸️ Pause';
                            playPauseBtn.classList.remove('play-active', 'pulse-play', 'pulse-resume');
                            playPauseBtn.classList.add('pause-active');
                            
                            // Update status (removed "Playing..." message per user request)
                            
                            // Start playback indicator (will draw when waveform is ready)
                            startPlaybackIndicator();
                        } else {
                            console.log(`⏸️ Auto Play disabled - waiting for user to click Play`);
                            // Don't start playback, but keep state ready
                            State.setPlaybackState(PlaybackState.STOPPED);
                            // Enable play button so user can start playback
                            const playPauseBtn = document.getElementById('playPauseBtn');
                            playPauseBtn.disabled = false;
                            playPauseBtn.textContent = '▶️ Play';
                            playPauseBtn.classList.remove('pause-active');
                            playPauseBtn.classList.add('play-active');
                        }
                        
                        // 🎯 RESOLVE PROMISE - fetch loop can now continue to chunk 2!
                        if (firstChunkProcessedResolve) {
                            firstChunkProcessedResolve();
                            if (DEBUG_CHUNKS) console.log(`✅ First chunk processed and sent - allowing fetch of chunk 2+`);
                        }
                    }
                }
                
                nextChunkToSend++;
            }
            
            // 🧹 PROGRESSIVE MEMORY CLEANUP: Free chunks that have been sent to both worklet AND waveform worker
            // Clear from the oldest sent chunk up to the current send position
            // This frees memory progressively as chunks are processed
            for (let i = 0; i < nextChunkToSend; i++) {
                if (processedChunks[i] && processedChunks[i].samples !== null) {
                    // Only clear if this chunk has also been sent to waveform worker
                    if (i < nextWaveformChunk) {
                        // 🔥 FIX: Explicitly null out ArrayBuffer references to allow GC
                        // The samples Float32Array holds a reference to its ArrayBuffer
                        // Setting samples to null breaks the reference chain
                        processedChunks[i].samples = null; // Free main thread memory (rawSamples kept for final waveform)
                        // Note: rawSamples is kept for final waveform build, will be cleared later
                        if (DEBUG_CHUNKS && i % 10 === 0) console.log(`🧹 Freed chunk ${i} samples from main thread memory`);
                    }
                }
            }
        }
        
        // Track which chunks to send to waveform worker in order
        let nextWaveformChunk = 0;
        
        // 🎯 WORKER MESSAGE HANDLER (runs on main thread, but doesn't block!)
        worker.onmessage = (e) => {
            if (e.data.type === 'chunk-ready') {
                const { chunkIndex, samples, rawSamples, sampleCount } = e.data;
                
                chunksReceived++;
                processedChunks[chunkIndex] = { samples, rawSamples };
                
                // 🔍 DEBUG: Log each chunk's sample count
                const chunkInfo = chunksToFetch[chunkIndex];
                if (DEBUG_CHUNKS) console.log(`📊 ${logTime()} Chunk ${chunkIndex} (${chunkInfo?.date} ${chunkInfo?.start}): ${samples.length.toLocaleString()} samples (total received: ${chunksReceived}/${chunksToFetch.length})`);
                
                // 🎨 PROGRESSIVE WAVEFORM: Send chunks to waveform worker IN ORDER (left to right temporally)
                // Send all consecutive chunks that are ready, starting from nextWaveformChunk
                while (nextWaveformChunk < chunksToFetch.length && processedChunks[nextWaveformChunk]) {
                    const chunk = processedChunks[nextWaveformChunk];
                    State.waveformWorker.postMessage({
                        type: 'add-samples',
                        samples: chunk.samples,
                        rawSamples: chunk.rawSamples
                    });
                    nextWaveformChunk++;
                    
                    // Trigger progressive waveform draw every 3 chunks (or first/last)
                    if (nextWaveformChunk === 1 || nextWaveformChunk === chunksToFetch.length || nextWaveformChunk % 3 === 0) {
                        const canvas = document.getElementById('waveform');
                        const width = canvas.offsetWidth * window.devicePixelRatio;
                        const height = canvas.offsetHeight * window.devicePixelRatio;
                        
                        // Duration will be set once all chunks are complete (line 607-608)
                        // Don't set it early with estimated value - causes mismatch during progressive loading
                        
                        State.waveformWorker.postMessage({
                            type: 'build-waveform',
                            canvasWidth: width,
                            canvasHeight: height,
                            removeDC: false,  // No DC removal until complete
                            alpha: 0.995,
                            totalExpectedSamples: totalSamples  // For progressive left-to-right filling
                        });
                        
                        if (DEBUG_CHUNKS) console.log(`🎨 Progressive waveform: ${nextWaveformChunk}/${chunksToFetch.length} chunks sent to worker (${(nextWaveformChunk/chunksToFetch.length*100).toFixed(0)}%)`);
                    }
                }
                
                // Send chunks in order (holds chunks until previous ones are ready)
                const beforeSend = nextChunkToSend;
                sendChunksInOrder();
                const afterSend = nextChunkToSend;
                
                if (DEBUG_CHUNKS) {
                    if (afterSend > beforeSend) {
                        console.log(`📤 Sent chunks ${beforeSend}-${afterSend-1} to worklet (in order)`);
                    } else if (chunkIndex > nextChunkToSend - 1) {
                        console.log(`⏸️ Holding chunk ${chunkIndex} (waiting for chunk ${nextChunkToSend})`);
                    }
                }
                
                // 🎯 ALL CHUNKS RECEIVED = SIGNAL COMPLETE
                // CRITICAL: Check that ALL chunks are actually in processedChunks on EVERY message
                // This prevents race conditions and handles cases where chunksReceived exceeds expected count
                const allChunksPresent = chunksToFetch.every((_, idx) => processedChunks[idx] !== undefined);
                
                // 🔍 DEBUG: Log completion check status
                if (chunksReceived >= chunksToFetch.length) {
                    const missingChunks = [];
                    for (let i = 0; i < chunksToFetch.length; i++) {
                        if (!processedChunks[i]) {
                            missingChunks.push(i);
                        }
                    }
                    if (DEBUG_CHUNKS) console.log(`🔍 ${logTime()} Completion check: allChunksPresent=${allChunksPresent}, isFetchingNewData=${State.isFetchingNewData}, completionHandled=${completionHandled}, missingChunks=[${missingChunks.join(', ')}]`);
                }
                
                // Only check for completion if all chunks are present (regardless of chunksReceived count)
                // This handles race conditions where chunksReceived might exceed chunksToFetch.length
                // Also prevent multiple completion checks with completionHandled flag
                // NOTE: Removed !isFetchingNewData check - it was preventing completion (catch-22)
                if (allChunksPresent && !completionHandled) {
                    completionHandled = true; // Mark as handled immediately to prevent race conditions
                    const totalTime = performance.now() - progressiveT0;
                    console.log(`✅ All ${chunksToFetch.length} chunks processed in ${totalTime.toFixed(0)}ms total`);
                    
                    // 🔍 DEBUG: Calculate actual total samples from processed chunks
                    // Note: Some chunks may have samples=null due to progressive memory cleanup
                    let actualTotalSamples = 0;
                    const chunkSampleCounts = [];
                    for (let i = 0; i < processedChunks.length; i++) {
                        if (processedChunks[i]) {
                            // Check if samples still exist (not freed by progressive cleanup)
                            if (processedChunks[i].samples) {
                                const count = processedChunks[i].samples.length;
                                actualTotalSamples += count;
                                chunkSampleCounts.push(`chunk ${i}: ${count.toLocaleString()}`);
                            } else {
                                chunkSampleCounts.push(`chunk ${i}: freed`);
                            }
                        } else {
                            chunkSampleCounts.push(`chunk ${i}: MISSING`);
                        }
                    }
                    if (DEBUG_CHUNKS) console.log(`📊 ${logTime()} Chunk sample counts: ${chunkSampleCounts.join(', ')}`);
                    if (DEBUG_CHUNKS && actualTotalSamples > 0) console.log(`📊 ${logTime()} Actual samples from non-freed chunks: ${actualTotalSamples.toLocaleString()}`);
                    
                    // Calculate total from worklet data (most reliable - includes all chunks)
                    const totalWorkletSamples = State.allReceivedData.reduce((sum, chunk) => sum + chunk.length, 0);
                    console.log(`📊 ${logTime()} Total worklet samples: ${totalWorkletSamples.toLocaleString()} (from allReceivedData)`);
                    
                    // 🎯 UPDATE: Use ACTUAL sample count for duration (refining expected duration)
                    // 👑 CRITICAL: Use original sample rate from metadata, NOT AudioContext rate!
                    const originalSampleRate = State.currentMetadata?.original_sample_rate || 50;
                    State.setTotalAudioDuration(totalWorkletSamples / originalSampleRate);
                    document.getElementById('sampleCount').textContent = totalWorkletSamples.toLocaleString(); // Update with actual
                    console.log(`📊 ${logTime()} Updated totalAudioDuration to ${(totalWorkletSamples / originalSampleRate).toFixed(2)}s (actual samples: ${totalWorkletSamples.toLocaleString()}, expected: ${totalSamples.toLocaleString()})`);
                    
                    // 🏛️ Initialize zoom state with total sample count
                    zoomState.initialize(totalWorkletSamples);
                    
                    // 🎯 CRITICAL FIX: Wait for worklet to confirm it has buffered all samples
                    // Set up one-time listener for buffer confirmation
                    const bufferStatusHandler = (event) => {
                        if (event.data.type === 'buffer-status') {
                            const { samplesInBuffer, totalSamplesWritten } = event.data;
                            console.log(`📊 ${logTime()} Worklet buffer status: ${totalSamplesWritten.toLocaleString()} written, ${samplesInBuffer.toLocaleString()} buffered (expecting ${totalWorkletSamples.toLocaleString()} total)`);
                            
                            if (totalSamplesWritten >= totalWorkletSamples) {
                                // All samples buffered! Now send data-complete
                                console.log(`✅ ${logTime()} Worklet confirmed all samples buffered - sending data-complete`);
                                
                                // 🔥 KILL THE LOADING ANIMATION IMMEDIATELY - all samples received!
                                if (State.loadingInterval) {
                                    clearInterval(State.loadingInterval);
                                    State.setLoadingInterval(null);
                                }
                                
                                State.workletNode.port.postMessage({
                                    type: 'data-complete',
                                    totalSamples: totalWorkletSamples,
                                    sampleRate: originalSampleRate  // 🔥 CRITICAL: Send actual sample rate (50 Hz), not 44100!
                                });
                                
                                // Remove this handler
                                if (State.workletNode && State.workletBufferStatusHandler) {
                                    State.workletNode.port.removeEventListener('message', State.workletBufferStatusHandler);
                                    State.setWorkletBufferStatusHandler(null);
                                }
                                
                                // 🔥 FIX: Clear processedChunks array to release Float32Array and ArrayBuffer references
                                // This prevents the worker closure from retaining old audio data
                                // Explicitly null out each ArrayBuffer reference to allow GC
                                for (let i = 0; i < processedChunks.length; i++) {
                                    if (processedChunks[i]) {
                                        // Null out Float32Array references (which hold ArrayBuffer references)
                                        processedChunks[i].samples = null;
                                        processedChunks[i].rawSamples = null;
                                        // Clear the object itself
                                        processedChunks[i] = null;
                                    }
                                }
                                // 🔥 FIX: Clear the array length after nulling all elements
                                // Setting length to 0 helps GC reclaim the array structure
                                processedChunks.length = 0;
                                
                                // Terminate worker (we're done!)
                                worker.onmessage = null;  // Break closure chain
                                worker.terminate();
                                window.audioWorker = null; // 🧹 Clear global reference for GC
                                console.log('🏭 Worker terminated and cleared');
                                
                                // Update download size
                                document.getElementById('downloadSize').textContent = `${(totalBytesDownloaded / 1024 / 1024).toFixed(2)} MB`;
                                
                                // 🎯 FINAL WAVEFORM WITH DC REMOVAL (run in worker - no main thread blocking!)
                                // The waveform worker already has all samples accumulated progressively
                                // Just tell it to rebuild with DC removal OFF-THREAD
                                console.log(`🎨 ${logTime()} Requesting final detrended waveform (worker has all ${totalWorkletSamples.toLocaleString()} samples)`);
                                
                                const canvas = document.getElementById('waveform');
                                const removeDC = document.getElementById('removeDCOffset').checked;
                                const slider = document.getElementById('waveformFilterSlider');
                                const alpha = 0.9 + (parseInt(slider.value) / 1000); // 0.9 to 0.999
                                
                                State.waveformWorker.postMessage({
                                    type: 'build-waveform',
                                    canvasWidth: canvas.offsetWidth * window.devicePixelRatio,
                                    canvasHeight: canvas.offsetHeight * window.devicePixelRatio,
                                    removeDC: removeDC,  // Apply DC removal for final waveform
                                    alpha: alpha,
                                    isComplete: true,    // Flag this as the final complete waveform
                                    totalExpectedSamples: totalWorkletSamples
                                });
                                
                                console.log(`🎨 ${logTime()} Final waveform build requested (off-thread, won't block audio!)`);
                                
                                // Stitch samples for download button (lightweight operation)
                                const stitched = new Float32Array(totalWorkletSamples);
                                let offset = 0;
                                const chunkCount = State.allReceivedData.length;
                                for (const chunk of State.allReceivedData) {
                                    stitched.set(chunk, offset);
                                    offset += chunk.length;
                                }
                                State.setCompleteSamplesArray(stitched);
                                console.log(`📦 ${logTime()} Stitched ${chunkCount} chunks into completeSamplesArray for download`);
                                
                                // 🔥 FIX: Clear allReceivedData after stitching to free 3,685+ Float32Array chunks and their ArrayBuffers
                                // This breaks the closure chain: RAF callback → State → allReceivedData → chunks → ArrayBuffers
                                // Explicitly null out each chunk's ArrayBuffer reference before clearing
                                if (State.allReceivedData && State.allReceivedData.length > 0) {
                                    for (let i = 0; i < State.allReceivedData.length; i++) {
                                        State.allReceivedData[i] = null; // Break ArrayBuffer reference
                                    }
                                }
                                State.setAllReceivedData([]);
                                console.log(`🧹 ${logTime()} Cleared allReceivedData (${chunkCount} chunks) - ArrayBuffers freed`);
                                
                                // Enable Begin Analysis/Complete button after data download completes (skip during tutorial)
                                if (!isTutorialActive()) {
                                    updateCompleteButtonState(); // Handles both "Begin Analysis" and "Complete" modes
                                }
                                
                                // 🎨 Render complete spectrogram now that all data is ready
                                console.log(`🎨 ${logTime()} Triggering complete spectrogram rendering...`);
                                startCompleteVisualization().catch(err => {
                                    console.error('❌ Error rendering complete spectrogram:', err);
                                });
                                
                                // Update UI
                                updatePlaybackSpeed();
                                updatePlaybackDuration();
                                State.setIsFetchingNewData(false);
                                
                                // Enable volume slider if tutorial is in progress (speed gets enabled during speed tutorial step)
                                (async () => {
                                    const { isTutorialInProgress } = await import('./study-workflow.js');
                                    if (isTutorialInProgress()) {
                                        const volumeSlider = document.getElementById('volumeSlider');
                                        const volumeLabel = document.getElementById('volumeLabel');
                                        if (volumeSlider) volumeSlider.disabled = false;
                                        if (volumeLabel) volumeLabel.style.opacity = '1';
                                        console.log('🔓 Volume slider ENABLED after fetch (tutorial in progress)');
                                    }
                                })();
                                
                                // Set completion message immediately (loading animation already stopped above)
                                const statusEl = document.getElementById('status');
                                if (statusEl) {
                                    statusEl.classList.remove('loading');
                                }
                                
                                // Note: Features are enabled by default - only tutorial disables them
                                // Tutorial is now managed by runInitialTutorial() which waits for data to be fetched
                                // No need to call runMainTutorial() here - it will be called automatically
                                
                                setTimeout(async () => {
                                    const statusEl = document.getElementById('status');
                                    if (statusEl) {
                                        statusEl.classList.remove('loading');
                                        statusEl.className = 'status success';
                                        
                                        // Check if tutorial is active - if so, let tutorial control messages
                                        const { isTutorialActive } = await import('./tutorial-state.js');
                                        if (isTutorialActive()) {
                                            return; // Tutorial controls its own messages
                                        }
                                        
                                        // Check if returning to mid-session (Begin Analysis already clicked)
                                        const { hasBegunAnalysisThisSession } = await import('./study-workflow.js');
                                        const { setStatusText } = await import('./tutorial-effects.js');
                                        
                                        if (hasBegunAnalysisThisSession()) {
                                            setStatusText('Click and drag on the waveform to select a new region.', 'status info');
                                        } else {
                                            // New session - guide user to Begin Analysis
                                            setStatusText('Click Begin Analysis to start your session.', 'status info');
                                        }
                                    }
                                }, 200);
                                
                                // Only update button if it's still disabled (wasn't enabled when playback started)
                                const playPauseBtn = document.getElementById('playPauseBtn');
                                if (playPauseBtn && playPauseBtn.disabled) {
                                    playPauseBtn.disabled = false;
                                    const autoPlayEnabled = document.getElementById('autoPlay').checked;
                                    if (autoPlayEnabled && State.playbackState === PlaybackState.PLAYING) {
                                        // Auto play is on and playback is active - show Pause button
                                        playPauseBtn.textContent = '⏸️ Pause';
                                        playPauseBtn.classList.remove('play-active');
                                        playPauseBtn.classList.add('pause-active');
                                        // Status message removed per user request - no "Playing..." message
                                        if (statusEl) {
                                            statusEl.classList.remove('loading');
                                            statusEl.textContent = ''; // Clear status when playing
                                        }
                                    } else {
                                        // Auto play is off or playback not started - show Play button
                                        playPauseBtn.textContent = '▶️ Play';
                                        playPauseBtn.classList.remove('pause-active');
                                        playPauseBtn.classList.add('play-active');
                                        // Message will be shown after tutorial overlay appears
                                    }
                                } else {
                                    // Button already enabled - just update status if needed
                                    if (State.playbackState === PlaybackState.PLAYING) {
                                        // Status message removed per user request - no "Playing..." message
                                        if (statusEl) {
                                            statusEl.classList.remove('loading');
                                            statusEl.textContent = ''; // Clear status when playing
                                        }
                                    }
                                    // Message will be shown after tutorial overlay appears if not playing
                                }
                                // Enable loop button if tutorial is skipped (Personal mode or Study mode after first session)
                                import('./master-modes.js').then(({ shouldSkipTutorial, isStudyMode }) => {
                                    const loopBtn = document.getElementById('loopBtn');
                                    if (loopBtn) {
                                        if (shouldSkipTutorial()) {
                                            // Personal mode - enable immediately
                                            loopBtn.disabled = false;
                                        } else if (isStudyMode()) {
                                            // Study mode - check if tutorial already seen
                                            const hasSeenTutorial = localStorage.getItem('study_has_seen_tutorial') === 'true';
                                            if (hasSeenTutorial) {
                                                loopBtn.disabled = false;
                                            }
                                            // If not seen, tutorial will enable it
                                        } else {
                                            // Dev mode - tutorial will enable it
                                        }
                                    }
                                });
                                document.getElementById('downloadBtn').disabled = false;
                            } else {
                                // Not all samples written yet - wait a bit and check again
                                console.log(`⏳ ${logTime()} Waiting for more samples (${totalSamplesWritten}/${totalWorkletSamples})...`);
                                setTimeout(() => {
                                    State.workletNode.port.postMessage({ type: 'get-buffer-status' });
                                }, 50);
                            }
                        }
                    };
                    
                    // 🔥 FIX: Store handler reference so it can be removed during cleanup
                    State.setWorkletBufferStatusHandler(bufferStatusHandler);
                    State.workletNode.port.addEventListener('message', bufferStatusHandler);
                    
                    // Request initial buffer status
                    console.log(`🔍 ${logTime()} Requesting worklet buffer status...`);
                    State.workletNode.port.postMessage({ type: 'get-buffer-status' });
                }
            }
        };
        
        // Helper function to build complete waveform (called in idle callback)
        function buildCompleteWaveform(processedChunks, chunksToFetch, normMin, normMax, totalSamples) {
            console.log('🎨 Building complete waveform...');
            const t0 = performance.now();
            
            // Stitch all chunks together
            // Note: Some chunks may have samples=null due to progressive memory cleanup
            let totalLength = 0;
            for (let i = 0; i < processedChunks.length; i++) {
                if (processedChunks[i] && processedChunks[i].samples) {
                    totalLength += processedChunks[i].samples.length;
                }
            }
            
            const stitchedFloat32 = new Float32Array(totalLength);
            const stitchedRaw = new Float32Array(totalLength);
            
            let offset = 0;
            for (let i = 0; i < processedChunks.length; i++) {
                if (processedChunks[i] && processedChunks[i].samples) {
                    const { samples, rawSamples } = processedChunks[i];
                    stitchedFloat32.set(samples, offset);
                    stitchedRaw.set(rawSamples, offset);
                    offset += samples.length;
                }
            }
            
            // Store for waveform drawing
            State.setCompleteSamplesArray(stitchedFloat32);
            window.rawWaveformData = stitchedRaw;
            
            // Enable Begin Analysis/Complete button after data download completes (skip during tutorial)
            if (!isTutorialActive()) {
                updateCompleteButtonState(); // Handles both "Begin Analysis" and "Complete" modes
            }
            
            // 🔥 FIX: Clear allReceivedData after stitching to free Float32Array chunks and their ArrayBuffers
            // This breaks the closure chain: RAF callback → State → allReceivedData → chunks → ArrayBuffers
            // Explicitly null out each chunk's ArrayBuffer reference before clearing
            if (State.allReceivedData && State.allReceivedData.length > 0) {
                for (let i = 0; i < State.allReceivedData.length; i++) {
                    State.allReceivedData[i] = null; // Break ArrayBuffer reference
                }
            }
            State.setAllReceivedData([]);
            
            // Update UI metrics
            document.getElementById('sampleCount').textContent = stitchedFloat32.length.toLocaleString();
            // 👑 CRITICAL: Use original sample rate from metadata, NOT AudioContext rate!
            const originalSampleRate = State.currentMetadata?.original_sample_rate || 50;
            State.setTotalAudioDuration(stitchedFloat32.length / originalSampleRate);
            
            // 🎨 DON'T re-send samples - worker already has them!
            // Just trigger final waveform build with DC removal
            drawWaveform();
            
            const stitchTime = performance.now() - t0;
            console.log(`✅ Samples stitched in ${stitchTime.toFixed(0)}ms, triggering final detrended waveform`);
        }
        
        // ========== PROGRESSIVE BATCH DOWNLOADING ==========
        // Create download batches using our validated algorithm
        const downloadBatches = createDownloadBatches(chunksToFetch);
        
        // Log chunk breakdown
        const typeCount = chunksToFetch.reduce((acc, c) => {
            acc[c.type] = (acc[c.type] || 0) + 1;
            return acc;
        }, {});
        if (DEBUG_CHUNKS) console.log(`📋 ${logTime()} Progressive chunks: ${chunksToFetch.length} total`);
        if (DEBUG_CHUNKS) console.log(`📋 ${logTime()} Breakdown: ${Object.entries(typeCount).map(([t, c]) => `${c}×${t}`).join(', ')}`);
        
        // Show batch plan
        const batchPlan = downloadBatches.map((batch, i) => {
            const type = chunksToFetch[batch[0]].type;
            return batch.length === 1 ? `1×${type}` : `${batch.length}×${type}`;
        }).join(' → ');
        if (DEBUG_CHUNKS) {
            console.log(`🚀 ${logTime()} Download plan: ${batchPlan}`);
            console.log(`📦 ${logTime()} Total batches: ${downloadBatches.length}`);
        }
        
        // Fetch function - DIRECT FROM CDN
        async function fetchChunk(chunkData) {
            const { chunk, index } = chunkData;
            
            // Build CDN URL
            const location = stationData.location || '--';
            const sampleRate = Math.round(stationData.sample_rate || 100);
            
            // Convert YYYY-MM-DD to YYYY/MM/DD for CDN path
            const [year, month, day] = chunk.date.split('-');
            const datePath = `${year}/${month}/${day}`;
            
            // Calculate NEW format end date (might be next day if chunk crosses midnight)
            const startDateTime = new Date(`${chunk.date}T${chunk.start}Z`);
            const chunkDurationMinutes = {
                '10m': 10,
                '1h': 60,
                '6h': 360
            }[chunk.type];
            const endDateTime = new Date(startDateTime.getTime() + chunkDurationMinutes * 60 * 1000);
            const endDate = endDateTime.toISOString().split('T')[0]; // YYYY-MM-DD
            
            // Check if chunk crosses midnight
            const crossesMidnight = chunk.date !== endDate;
            
            // If crossing midnight, also prepare end date path
            let endDatePath = null;
            if (crossesMidnight) {
                const [endYear, endMonth, endDay] = endDate.split('-');
                endDatePath = `${endYear}/${endMonth}/${endDay}`;
            }
            
            // Calculate OLD format end date/time (1 second before, for :59 suffix)
            const oldEndDateTime = new Date(startDateTime.getTime() + chunkDurationMinutes * 60 * 1000 - 1000);
            const oldEndDate = oldEndDateTime.toISOString().split('T')[0]; // YYYY-MM-DD
            const oldEndTime = oldEndDateTime.toISOString().split('T')[1].substring(0, 8); // HH:MM:SS
            
            // Convert start/end times to filename format
            const startFormatted = chunk.start.replace(/:/g, '-');
            // Use calculated endDateTime instead of chunk.end (handles midnight crossing correctly)
            const endTime = endDateTime.toISOString().split('T')[1].substring(0, 8); // HH:MM:SS
            const endFormatted = endTime.replace(/:/g, '-');
            const oldEndFormatted = oldEndTime.replace(/:/g, '-');
            
            // Try NEW format first (no sample rate, :00 ending)
            const newFilename = `${stationData.network}_${stationData.station}_${location}_${stationData.channel}_${chunk.type}_${chunk.date}-${startFormatted}_to_${endDate}-${endFormatted}.bin.zst`;
            
            // Try start date path first
            let newChunkUrl = `${CDN_BASE_URL}/${datePath}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/${chunk.type}/${newFilename}${cacheBuster}`;
            let response = await fetch(newChunkUrl);
            
            // If not found and crosses midnight, try end date path
            if (!response.ok && crossesMidnight && endDatePath) {
                newChunkUrl = `${CDN_BASE_URL}/${endDatePath}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/${chunk.type}/${newFilename}${cacheBuster}`;
                response = await fetch(newChunkUrl);
            }
            
            // If NEW format with :00 ending not found, try NEW format with :59 ending (hybrid format - some stations use this)
            if (!response.ok) {
                const hybridFilename = `${stationData.network}_${stationData.station}_${location}_${stationData.channel}_${chunk.type}_${chunk.date}-${startFormatted}_to_${oldEndDate}-${oldEndFormatted}.bin.zst`;
                
                // Try start date path first
                let hybridChunkUrl = `${CDN_BASE_URL}/${datePath}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/${chunk.type}/${hybridFilename}${cacheBuster}`;
                response = await fetch(hybridChunkUrl);
                
                // If not found and crosses midnight, try end date path
                if (!response.ok && crossesMidnight && endDatePath) {
                    hybridChunkUrl = `${CDN_BASE_URL}/${endDatePath}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/${chunk.type}/${hybridFilename}${cacheBuster}`;
                    response = await fetch(hybridChunkUrl);
                }
            }
            
            // If NEW format (both variants) not found, try OLD format (with sample rate + :59 end time)
            if (!response.ok) {
                const oldFilename = `${stationData.network}_${stationData.station}_${location}_${stationData.channel}_${sampleRate}Hz_${chunk.type}_${chunk.date}-${startFormatted}_to_${oldEndDate}-${oldEndFormatted}.bin.zst`;
                
                // Try start date path first
                let oldChunkUrl = `${CDN_BASE_URL}/${datePath}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/${chunk.type}/${oldFilename}${cacheBuster}`;
                response = await fetch(oldChunkUrl);
                
                // If not found and crosses midnight, try end date path
                if (!response.ok && crossesMidnight && endDatePath) {
                    oldChunkUrl = `${CDN_BASE_URL}/${endDatePath}/${stationData.network}/${volcanoName}/${stationData.station}/${location}/${stationData.channel}/${chunk.type}/${oldFilename}${cacheBuster}`;
                    response = await fetch(oldChunkUrl);
                }
                
                if (!response.ok) {
                    throw new Error(`Chunk ${index + 1} fetch failed in NEW format (:00), NEW format (:59), and OLD format (tried start date path${crossesMidnight ? ' and end date path' : ''}): ${response.status}`);
                }
            }
            
            const compressed = await response.arrayBuffer();
            const chunkSize = compressed.byteLength;
            totalBytesDownloaded += chunkSize;
            
            // Update download size display incrementally as each chunk arrives
            document.getElementById('downloadSize').textContent = `${(totalBytesDownloaded / 1024 / 1024).toFixed(2)} MB`;
            
            return { compressed, chunkSize, index };
        }
        
        let chunksDownloaded = 0;
        
        // Helper to send chunk to worker
        const sendToWorker = (result) => {
            const { compressed, chunkSize, index, isMissing, expectedSamples } = result;
            chunksDownloaded++;
            
            // 🆕 Handle missing chunks - send flag to worker to generate zeros
            if (isMissing) {
                worker.postMessage({
                    type: 'process-chunk',
                    compressed: null,
                    normMin: normMin,
                    normMax: normMax,
                    chunkIndex: index,
                    isMissing: true,
                    expectedSamples: expectedSamples
                });
                
                const chunkType = chunksToFetch[index].type;
                if (DEBUG_CHUNKS) console.log(`🔇 ${logTime()} Generated silence for chunk ${index + 1}/${chunksToFetch.length} (${chunkType}) - ${expectedSamples.toLocaleString()} samples (${chunksDownloaded}/${chunksToFetch.length})`);
            } else {
                worker.postMessage({
                    type: 'process-chunk',
                    compressed: compressed,
                    normMin: normMin,
                    normMax: normMax,
                    chunkIndex: index
                }, [compressed]);
                
                const chunkType = chunksToFetch[index].type;
                if (DEBUG_CHUNKS) console.log(`📥 ${logTime()} Downloaded chunk ${index + 1}/${chunksToFetch.length} (${chunkType}) - ${(chunkSize / 1024).toFixed(1)} KB (${chunksDownloaded}/${chunksToFetch.length})`);
            }
        };
        
        // Execute batches sequentially, chunks within batch in parallel
        for (let batchIdx = 0; batchIdx < downloadBatches.length; batchIdx++) {
            const batchIndices = downloadBatches[batchIdx];
            const chunkType = chunksToFetch[batchIndices[0]].type;
            const batchLabel = batchIndices.length === 1 ? 
                `1×${chunkType} alone` : 
                `${batchIndices.length}×${chunkType} parallel`;
            
            if (DEBUG_CHUNKS) console.log(`📦 ${logTime()} Batch ${batchIdx + 1}/${downloadBatches.length}: ${batchLabel} (chunks ${batchIndices.map(i => i + 1).join(', ')})`);
            
            // Download all chunks in this batch IN PARALLEL (or generate zeros for missing)
            const batchPromises = batchIndices.map(idx => {
                const chunk = chunksToFetch[idx];
                
                // 🆕 Check if chunk is missing - generate zeros instead of fetching
                if (chunk.isMissing) {
                    return Promise.resolve({
                        compressed: null,
                        chunkSize: 0,
                        index: idx,
                        isMissing: true,
                        expectedSamples: chunk.samples
                    });
                }
                
                // Normal fetch for existing chunks
                return fetchChunk({ chunk: chunk, index: idx });
            });
            const batchResults = await Promise.all(batchPromises);
            
            // Send to worker
            batchResults.forEach(sendToWorker);
            
            // Wait for first batch (chunk 0) to be processed before continuing
            if (batchIdx === 0) {
                if (DEBUG_CHUNKS) console.log(`⏳ ${logTime()} Waiting for chunk 0 to process...`);
                await firstChunkProcessed;
                if (DEBUG_CHUNKS) console.log(`✅ ${logTime()} Chunk 0 ready - AUDIO PLAYING! Continuing with next batches...`);
            }
        }
        
        console.log(`📡 ${logTime()} All ${chunksToFetch.length} chunks downloaded and sent to worker`);
        
        // Worker will handle:
        // 1. Decompression (off main thread)
        // 2. Normalization (off main thread)
        // 3. Sending to AudioWorklet (with immediate fade-in)
        // 4. Building waveform (in idle callback)
        // All UI updates happen in worker.onmessage handler above!
        
}

// ===== MODE 2: RAILWAY BACKEND (ORIGINAL PATH) =====
// ⚠️ DEPRECATED CODE - DO NOT UPDATE EVER. DO NOT TOUCH THIS CODE.
// This code path is deprecated and should not be modified.
// 🚫 COMMENTED OUT - Railway fetch path disabled
/* export async function fetchFromRailway(stationData, startTime, duration, highpassFreq, enableNormalize) {
    const formatTime = (date) => {
        return date.toISOString().slice(0, 19);
    };
    
    // Request data from backend (backend will apply high-pass filter)
    const highpassValue = highpassFreq === 'none' ? 0 : parseFloat(highpassFreq);
    const requestBody = {
        network: stationData.network,
        station: stationData.station,
        location: stationData.location || '',
        channel: stationData.channel,
        starttime: formatTime(startTime),
        duration: duration * 3600,
        highpass_hz: highpassValue,  // Backend will apply high-pass filter
        normalize: false,  // NO server-side normalization (done in browser)
        send_raw: false  // Send float32
    };
    
    console.log('📡 Requesting from Railway:', requestBody);
    
    // Determine backend URL (unified collector service has both scheduled collection + on-demand streaming)
    const backendUrl = 'https://volcano-audio-collector-production.up.railway.app/api/stream-audio';
    console.log(`🌐 Using Railway backend: ${backendUrl}`);
    
    const response = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        mode: 'cors',
        credentials: 'omit'
    });
    
    console.log('✅ Fetch succeeded, response:', response);
    
    if (!response.ok) {
        let errorMsg = `HTTP ${response.status}`;
        try {
            const errorData = await response.json();
            if (errorData.error) {
                errorMsg = errorData.error;
            }
        } catch (e) {
            errorMsg = response.statusText || `HTTP ${response.status}`;
        }
        throw new Error(errorMsg);
    }
    
    // Get response
    const receivedBlob = await response.arrayBuffer();
    const downloadSize = (receivedBlob.byteLength / 1024 / 1024).toFixed(2);
    document.getElementById('downloadSize').textContent = `${downloadSize} MB`;
    console.log(`📦 Received: ${downloadSize} MB`);
    
    // Decompress if needed
    let decompressed;
    const compression = response.headers.get('X-Compression');
    if (compression === 'zstd') {
        console.log('🗜️ Decompressing with zstd...');
        // 🔥 FIX: Use local reference to avoid potential closure retention
        // fzstd is a global library, but using a local const helps ensure no closure capture
        const decompressFn = fzstd.decompress;
        decompressed = decompressFn(new Uint8Array(receivedBlob));
        console.log(`✅ Decompressed: ${(decompressed.length / 1024 / 1024).toFixed(2)} MB`);
    } else {
        console.log('⏭️ No compression');
        decompressed = new Uint8Array(receivedBlob);
    }
    
    // Parse: [metadata_length (4 bytes)] [metadata_json] [float32_samples]
    const view = new DataView(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
    const metadataLength = view.getUint32(0, true);
    const metadataBytes = decompressed.slice(4, 4 + metadataLength);
    const metadataJson = new TextDecoder().decode(metadataBytes);
    const metadata = JSON.parse(metadataJson);
    
    console.log('📋 Metadata:', metadata);
    
    // Store metadata for duration calculation
    State.setCurrentMetadata(metadata);
    
    // Calculate and store start/end times for x-axis rendering
    const endTime = new Date(startTime.getTime() + duration * 3600 * 1000);
    State.setDataStartTime(startTime);
    State.setDataEndTime(endTime);
    
    // 🔥 Load saved regions now that time range is known
    loadRegionsAfterDataFetch();
    
    // Draw frequency axis with new metadata
    positionAxisCanvas();
    initializeAxisPlaybackRate();
    
    // Draw x-axis with new time data
    positionWaveformXAxisCanvas();
    drawWaveformXAxis();
    positionWaveformDateCanvas();
    drawWaveformDate();
    
    // Extract samples
    const samplesOffset = 4 + metadataLength;
    const samplesBytes = decompressed.slice(samplesOffset);
    let samples = new Float32Array(samplesBytes.buffer, samplesBytes.byteOffset, samplesBytes.length / 4);
    
    // 🔥 FIX: Explicitly null out decompressed to allow GC of original buffer
    // The Float32Array we created above shares the buffer, but we've copied what we need
    decompressed = null;
    
    console.log(`✅ Got ${samples.length.toLocaleString()} samples @ ${metadata.original_sample_rate} Hz`);
    
    // Calculate min/max
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < samples.length; i++) {
        if (samples[i] < min) min = samples[i];
        if (samples[i] > max) max = samples[i];
    }
    console.log(`🔍 Sample range: [${min.toFixed(3)}, ${max.toFixed(3)}]`);
    document.getElementById('sampleCount').textContent = samples.length.toLocaleString();
    
    // Keep raw samples for waveform drift removal
    const rawSamples = new Float32Array(samples);
    
    // Normalize if enabled
    if (enableNormalize) {
        console.log('📏 Normalizing...');
        samples = normalize(samples);
    }
    
    // Store complete samples array for waveform drawing
    State.setCompleteSamplesArray(samples);
    
    // Enable Begin Analysis/Complete button after data download completes (skip during tutorial)
    if (!isTutorialActive()) {
        updateCompleteButtonState(); // Handles both "Begin Analysis" and "Complete" modes
    }
    
    // Send samples to waveform worker BEFORE building waveform
    State.waveformWorker.postMessage({
        type: 'add-samples',
        samples: samples,
        rawSamples: rawSamples
    });
    
    // Send to AudioWorklet in chunks
    console.log('🎵 Sending to AudioWorklet in 1024-sample chunks...');
    const WORKLET_CHUNK_SIZE = 1024;
    State.setAllReceivedData([]);
    
    for (let i = 0; i < samples.length; i += WORKLET_CHUNK_SIZE) {
        const chunkSize = Math.min(WORKLET_CHUNK_SIZE, samples.length - i);
        // 🔥 FIX: Copy slice to new ArrayBuffer instead of sharing buffer
        // This allows GC of individual chunks independently
        const slice = samples.slice(i, i + chunkSize);
        const chunk = new Float32Array(slice); // Copy to new ArrayBuffer
        
        State.workletNode.port.postMessage({
            type: 'audio-data',
            data: chunk,
            autoResume: true  // 🎯 Enable graceful auto-resume if playback stopped due to buffer underrun
        });
        
        State.allReceivedData.push(chunk);
    }
    
    // Draw complete waveform
    drawWaveform();
    
    console.log(`✅ Sent ${State.allReceivedData.length} chunks to AudioWorklet`);
    
    const autoPlayEnabled = document.getElementById('autoPlay').checked;
    
    if (autoPlayEnabled) {
        // 🎯 FORCE IMMEDIATE PLAYBACK
        State.workletNode.port.postMessage({
            type: 'start-immediately'
        });
        console.log(`🚀 Sent 'start-immediately' to worklet`);
        
        // Fade-in audio
        if (State.gainNode && State.audioContext) {
            const targetVolume = parseFloat(document.getElementById('volumeSlider').value) / 100;
            State.gainNode.gain.cancelScheduledValues(State.audioContext.currentTime);
            State.gainNode.gain.setValueAtTime(0.0001, State.audioContext.currentTime);
            State.gainNode.gain.exponentialRampToValueAtTime(
                Math.max(0.01, targetVolume), 
                State.audioContext.currentTime + 0.05
            );
            console.log(`🔊 Fade-in scheduled: 0.0001 → ${targetVolume.toFixed(2)} over 50ms`);
        }
        
        // Reset position tracking
        State.setCurrentAudioPosition(0);
        State.setLastWorkletPosition(0);
        State.setLastWorkletUpdateTime(State.audioContext.currentTime);
        State.setLastUpdateTime(State.audioContext.currentTime);
        
        // Enable play button immediately when playback starts
        const playPauseBtn = document.getElementById('playPauseBtn');
        playPauseBtn.disabled = false;
        playPauseBtn.textContent = '⏸️ Pause';
        playPauseBtn.classList.remove('play-active', 'secondary');
        playPauseBtn.classList.add('pause-active');
        
        // Start playback indicator
        startPlaybackIndicator();
    } else {
        console.log(`⏸️ Auto Play disabled - waiting for user to click Play`);
        // Don't start playback, but keep state ready
        State.setPlaybackState(PlaybackState.STOPPED);
        // Enable play button so user can start playback
        const playPauseBtn = document.getElementById('playPauseBtn');
        playPauseBtn.disabled = false;
        playPauseBtn.textContent = '▶️ Play';
        playPauseBtn.classList.remove('pause-active', 'secondary');
        playPauseBtn.classList.add('play-active');
    }
    
    // 🎯 CRITICAL FIX: Wait for worklet to confirm it has buffered all samples (Railway path)
    const totalRailwaySamples = samples.length;
    
    // 🏛️ Initialize zoom state with total sample count (Railway path)
    zoomState.initialize(totalRailwaySamples);
    
    const railwayBufferStatusHandler = (event) => {
        if (event.data.type === 'buffer-status') {
            const { samplesInBuffer, totalSamplesWritten } = event.data;
            console.log(`📊 [Railway] Worklet buffer status: ${totalSamplesWritten.toLocaleString()} written, ${samplesInBuffer.toLocaleString()} buffered (expecting ${totalRailwaySamples.toLocaleString()} total)`);
            
            if (totalSamplesWritten >= totalRailwaySamples) {
                // All samples buffered! Now send data-complete
                console.log(`✅ [Railway] Worklet confirmed all samples buffered - sending data-complete`);
                
                // 🔥 KILL THE LOADING ANIMATION IMMEDIATELY - all samples received!
                if (State.loadingInterval) {
                    clearInterval(State.loadingInterval);
                    State.setLoadingInterval(null);
                }
                
                const railwaySampleRate = State.currentMetadata?.original_sample_rate || 50;
                State.workletNode.port.postMessage({ 
                    type: 'data-complete',
                    totalSamples: totalRailwaySamples,
                    sampleRate: railwaySampleRate  // 🔥 CRITICAL: Send actual sample rate (50 Hz), not 44100!
                });
                
                // Remove this handler
                if (State.workletNode && State.workletRailwayBufferStatusHandler) {
                    State.workletNode.port.removeEventListener('message', State.workletRailwayBufferStatusHandler);
                    State.setWorkletRailwayBufferStatusHandler(null);
                }
                
                // Set playback speed
                updatePlaybackSpeed();
                
                // Set anti-aliasing filter
                if (State.workletNode) {
                    State.workletNode.port.postMessage({
                        type: 'set-anti-aliasing',
                        enabled: true  // Always enabled
                    });
                }
                
                // Update playback duration
                updatePlaybackDuration();
                
                // Enable volume slider if tutorial is in progress (speed gets enabled during speed tutorial step)
                (async () => {
                    const { isTutorialInProgress } = await import('./study-workflow.js');
                    if (isTutorialInProgress()) {
                        const volumeSlider = document.getElementById('volumeSlider');
                        const volumeLabel = document.getElementById('volumeLabel');
                        if (volumeSlider) volumeSlider.disabled = false;
                        if (volumeLabel) volumeLabel.style.opacity = '1';
                        console.log('🔓 Volume slider ENABLED after fetch (tutorial in progress)');
                    }
                })();
                
                // Note: Features are enabled by default - only tutorial disables them
                // Tutorial is now managed by runInitialTutorial() which waits for data to be fetched
                // No need to call runMainTutorial() here - it will be called automatically
                setTimeout(() => {
                    const statusEl = document.getElementById('status');
                    if (statusEl) {
                        statusEl.classList.remove('loading');
                        statusEl.className = 'status success';
                    }
                }, 200);
            } else {
                // Not all samples written yet - wait a bit and check again
                console.log(`⏳ [Railway] Waiting for more samples (${totalSamplesWritten}/${totalRailwaySamples})...`);
                setTimeout(() => {
                    State.workletNode.port.postMessage({ type: 'get-buffer-status' });
                }, 50);
            }
        }
    };
    
    // 🔥 FIX: Store handler reference so it can be removed during cleanup
    State.setWorkletRailwayBufferStatusHandler(railwayBufferStatusHandler);
    State.workletNode.port.addEventListener('message', railwayBufferStatusHandler);
    
    // Request initial buffer status
    console.log(`🔍 [Railway] Requesting worklet buffer status...`);
    State.workletNode.port.postMessage({ type: 'get-buffer-status' });
    
    // Clear fetching flag
    State.setIsFetchingNewData(false);
    
    // Stop loading animation and immediately set completion message (no gap!)
    const statusEl = document.getElementById('status');
    if (State.loadingInterval) {
        clearInterval(State.loadingInterval);
        State.setLoadingInterval(null);
    }
    
    // Only update button if it's still disabled (wasn't enabled when playback started)
    const playPauseBtn = document.getElementById('playPauseBtn');
    if (playPauseBtn.disabled) {
        playPauseBtn.disabled = false;
        const autoPlayEnabled = document.getElementById('autoPlay').checked;
        if (autoPlayEnabled && State.playbackState === PlaybackState.PLAYING) {
            // Auto play is on and playback is active - show Pause button
            playPauseBtn.textContent = '⏸️ Pause';
            playPauseBtn.classList.remove('play-active', 'secondary');
            playPauseBtn.classList.add('pause-active');
            if (statusEl) {
                statusEl.classList.remove('loading');
                statusEl.textContent = ''; // Clear status when playing - no "Playing..." message
            }
        } else {
            // Auto play is off or playback not started - show Play button
            playPauseBtn.textContent = '▶️ Play';
            playPauseBtn.classList.remove('pause-active', 'secondary');
            playPauseBtn.classList.add('play-active');
            if (statusEl) {
                statusEl.classList.remove('loading');
                statusEl.className = 'status success';
                setStatusText('👇 Click on the waveform below to move the playhead.', 'status success');
            }
        }
    } else {
        // Button already enabled - just update status if needed
        if (State.playbackState === PlaybackState.PLAYING) {
            if (statusEl) {
                statusEl.classList.remove('loading');
                statusEl.textContent = ''; // Clear status when playing - no "Playing..." message
            }
        } else {
            if (statusEl) {
                statusEl.classList.remove('loading');
                statusEl.className = 'status success';
                setStatusText('👇 Click on the waveform below to move the playhead.', 'status success');
            }
        }
    }
    document.getElementById('downloadBtn').disabled = false;
    
    // Enable loop button if tutorial is skipped (Personal mode or Study mode after first session)
    import('./master-modes.js').then(({ shouldSkipTutorial, isStudyMode }) => {
        const loopBtn = document.getElementById('loopBtn');
        if (loopBtn) {
            if (shouldSkipTutorial()) {
                // Personal mode - enable immediately
                loopBtn.disabled = false;
            } else if (isStudyMode()) {
                // Study mode - check if tutorial already seen
                const hasSeenTutorial = localStorage.getItem('study_has_seen_tutorial') === 'true';
                if (hasSeenTutorial) {
                    loopBtn.disabled = false;
                }
                // If not seen, tutorial will enable it
            } else {
                // Dev mode - tutorial will enable it
            }
        }
    });
    
    console.log('✅ Streaming complete from Railway backend');
} */

