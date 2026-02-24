// ========== GOES CLOUDFLARE PROGRESSIVE FETCHER ==========
// Fetches pre-chunked GOES magnetometer data from Cloudflare R2
// with tiered progressive streaming: 15m → 1h → 6h → 24h
//
// Mirrors the volcano progressive pipeline in data-fetcher.js:
//   1. Set up state/axes BEFORE downloading (time range is known)
//   2. Download chunks sequentially, decompress with fzstd, normalize
//   3. Feed each chunk to worklet + waveform worker progressively
//   4. First chunk triggers immediate playback
//   5. At completion: stitch, startCompleteVisualization, cleanup

import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { updatePlaybackIndicator, drawWaveform, startPlaybackIndicator } from './waveform-renderer.js';
import { updatePlaybackSpeed } from './audio-player.js';
import { updatePlaybackDuration } from './ui-controls.js';
import { drawFrequencyAxis, positionAxisCanvas, initializeAxisPlaybackRate } from './spectrogram-axis-renderer.js';
import { drawWaveformAxis, positionWaveformAxisCanvas } from './waveform-axis-renderer.js';
import { positionWaveformXAxisCanvas, drawWaveformXAxis, positionWaveformDateCanvas, drawWaveformDate } from './waveform-x-axis-renderer.js';
import { drawSpectrogramXAxis, positionSpectrogramXAxisCanvas } from './spectrogram-x-axis-renderer.js';
import { startCompleteVisualization, clearCompleteSpectrogram } from './spectrogram-three-renderer.js';
import { zoomState } from './zoom-state.js';
import { updateCompleteButtonState, loadRegionsAfterDataFetch } from './region-tracker.js';
import { isTutorialActive } from './tutorial-state.js';

const WORKER_BASE = 'https://spaceweather.now.audio/emic';
const INSTRUMENT_SAMPLE_RATE = 10; // Hz — GOES mag high-res cadence

// Dataset → satellite name mapping (mirrors goes_to_r2.py)
const DATASET_TO_SATELLITE = {
    'DN_MAGN-L2-HIRES_G16': 'GOES-16',
    'DN_MAGN-L2-HIRES_G19': 'GOES-19',
};

// Component index → R2 component name
const COMPONENT_MAP = ['bx', 'by', 'bz'];

// =============================================================================
// fzstd dynamic loader
// =============================================================================

let fzstdModule = null;

async function ensureFzstd() {
    if (fzstdModule) return fzstdModule;

    // Check if already loaded globally (e.g. via <script> tag)
    if (typeof fzstd !== 'undefined') {
        fzstdModule = fzstd;
        return fzstdModule;
    }

    // Dynamic load
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/fzstd@0.1.1/umd/index.min.js';
        script.onload = () => {
            if (typeof fzstd !== 'undefined') {
                fzstdModule = fzstd;
                resolve(fzstdModule);
            } else {
                reject(new Error('fzstd failed to load'));
            }
        };
        script.onerror = () => reject(new Error('Failed to load fzstd from CDN'));
        document.head.appendChild(script);
    });
}

// =============================================================================
// Metadata fetching
// =============================================================================

/**
 * Fetch metadata.json for each day in range, for a given component.
 * @returns {Promise<Object[]>} Array of metadata objects (null for missing days)
 */
async function fetchAllDayMetadata(startDate, endDate, satellite, component) {
    const days = [];
    const current = new Date(startDate);
    const end = new Date(endDate);

    while (current < end) {
        days.push(current.toISOString().split('T')[0]);
        current.setUTCDate(current.getUTCDate() + 1);
    }

    console.log(`📋 Fetching metadata for ${days.length} days: ${days[0]} → ${days[days.length - 1]}`);

    const results = await Promise.all(days.map(async (dateStr) => {
        const [year, month, day] = dateStr.split('-');
        const url = `${WORKER_BASE}/data/${year}/${month}/${day}/${satellite}/mag/${component}/metadata.json`;
        try {
            const resp = await fetch(url);
            if (!resp.ok) {
                console.warn(`⚠️ No metadata for ${dateStr}: ${resp.status}`);
                return null;
            }
            return await resp.json();
        } catch (e) {
            console.warn(`⚠️ Metadata fetch failed for ${dateStr}:`, e.message);
            return null;
        }
    }));

    const valid = results.filter(m => m !== null);
    console.log(`✅ Got metadata for ${valid.length}/${days.length} days`);
    return results;
}

// =============================================================================
// Tiered chunk schedule builder
// =============================================================================

/**
 * Build progressive chunk schedule:
 *   First 2 hours:    15m chunks (8 chunks)
 *   Hours 2-6:        1h chunks  (4 chunks)
 *   Hours 6-24:       6h chunks  (3 chunks)
 *   Days 2+:          24h chunks (1 per day)
 *
 * @param {Date} startTime
 * @param {Date} endTime
 * @param {Object[]} allDayMetadata - metadata per day (from fetchAllDayMetadata)
 * @returns {Object[]} Array of { type, date, chunkMeta, url } objects
 */
function buildChunkSchedule(startTime, endTime, allDayMetadata, satellite, component) {
    const chunks = [];
    let currentTime = new Date(startTime);

    // Helper: find a chunk in metadata by date, type, and start time
    function findChunk(dateStr, chunkType, startTimeStr) {
        const dayMeta = allDayMetadata.find(m => m && m.date === dateStr);
        if (!dayMeta || !dayMeta.chunks[chunkType]) return null;
        return dayMeta.chunks[chunkType].find(c => c.start === startTimeStr);
    }

    // Helper: build URL for a chunk
    function buildUrl(dateStr, chunkType, filename) {
        const [year, month, day] = dateStr.split('-');
        return `${WORKER_BASE}/data/${year}/${month}/${day}/${satellite}/mag/${component}/${chunkType}/${filename}`;
    }

    let minutesElapsed = 0;

    while (currentTime < endTime) {
        const dateStr = currentTime.toISOString().split('T')[0];
        const hour = currentTime.getUTCHours();
        const minute = currentTime.getUTCMinutes();
        const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
        const remainingMinutes = (endTime - currentTime) / 1000 / 60;

        // Determine chunk type based on elapsed time
        let chunkType, chunkDurationMinutes;

        if (minutesElapsed < 120) {
            // First 2 hours: 15m chunks
            chunkType = '15m';
            chunkDurationMinutes = 15;
        } else if (minutesElapsed < 360) {
            // Hours 2-6: 1h chunks (must be at hour boundary)
            if (minute === 0 && remainingMinutes >= 60) {
                chunkType = '1h';
                chunkDurationMinutes = 60;
            } else {
                chunkType = '15m';
                chunkDurationMinutes = 15;
            }
        } else if (minutesElapsed < 1440) {
            // Hours 6-24: 6h chunks (must be at 6h boundary)
            if (hour % 6 === 0 && minute === 0 && remainingMinutes >= 360) {
                chunkType = '6h';
                chunkDurationMinutes = 360;
            } else if (minute === 0 && remainingMinutes >= 60) {
                chunkType = '1h';
                chunkDurationMinutes = 60;
            } else {
                chunkType = '15m';
                chunkDurationMinutes = 15;
            }
        } else {
            // Day 2+: 24h chunks (must be at day boundary)
            if (hour === 0 && minute === 0 && remainingMinutes >= 1440) {
                chunkType = '24h';
                chunkDurationMinutes = 1440;
            } else if (hour % 6 === 0 && minute === 0 && remainingMinutes >= 360) {
                chunkType = '6h';
                chunkDurationMinutes = 360;
            } else if (minute === 0 && remainingMinutes >= 60) {
                chunkType = '1h';
                chunkDurationMinutes = 60;
            } else {
                chunkType = '15m';
                chunkDurationMinutes = 15;
            }
        }

        // Look up chunk in metadata
        const chunkMeta = findChunk(dateStr, chunkType, timeStr);
        if (chunkMeta) {
            chunks.push({
                type: chunkType,
                date: dateStr,
                startTime: timeStr,
                samples: chunkMeta.samples,
                min: chunkMeta.min,
                max: chunkMeta.max,
                url: buildUrl(dateStr, chunkType, chunkMeta.filename),
                isMissing: false,
            });
        } else {
            // Missing chunk — fill with zeros
            const expectedSamples = chunkDurationMinutes * 60 * INSTRUMENT_SAMPLE_RATE;
            console.warn(`⚠️ Missing ${chunkType} chunk: ${dateStr} ${timeStr} — will fill ${expectedSamples} zeros`);
            chunks.push({
                type: chunkType,
                date: dateStr,
                startTime: timeStr,
                samples: expectedSamples,
                min: 0,
                max: 0,
                url: null,
                isMissing: true,
            });
        }

        // Advance time
        currentTime = new Date(currentTime.getTime() + chunkDurationMinutes * 60 * 1000);
        minutesElapsed += chunkDurationMinutes;
    }

    // Log chunk plan
    const typeCounts = chunks.reduce((acc, c) => {
        acc[c.type] = (acc[c.type] || 0) + 1;
        return acc;
    }, {});
    console.log(`📋 Chunk schedule: ${chunks.length} total — ${Object.entries(typeCounts).map(([t, n]) => `${n}×${t}`).join(', ')}`);

    return chunks;
}

// =============================================================================
// Main entry point — Progressive streaming pipeline
// =============================================================================

/**
 * Fetch GOES data from Cloudflare R2 with progressive streaming.
 * Mirrors the volcano progressive pipeline in data-fetcher.js:
 *   - State/axes set up BEFORE downloading
 *   - Each chunk feeds audio worklet + waveform worker progressively
 *   - First chunk triggers immediate playback
 *   - Spectrogram renders after all data via startCompleteVisualization()
 */
export async function fetchAndLoadCloudflareData(spacecraft, dataset, startTimeISO, endTimeISO) {
    const logTime = () => `[${Math.round(performance.now() - window.streamingStartTime)}ms]`;
    const statusEl = document.getElementById('status');

    console.log(`☁️ [CLOUDFLARE] Progressive fetch: ${spacecraft} ${dataset}`);
    console.log(`☁️ ${logTime()} Time range: ${startTimeISO} → ${endTimeISO}`);

    // Determine satellite and component
    const satellite = DATASET_TO_SATELLITE[dataset] || 'GOES-16';
    const componentIdx = parseInt(document.getElementById('componentSelector')?.value || '0');
    const component = COMPONENT_MAP[componentIdx] || 'bx';

    console.log(`☁️ Satellite: ${satellite}, Component: ${component}`);

    // Step 1: Load fzstd for zstd decompression
    if (statusEl) statusEl.textContent = 'Loading decompression library...';
    const zstd = await ensureFzstd();
    console.log(`✅ ${logTime()} fzstd loaded`);

    // Step 2: Fetch metadata for all days
    const startDate = new Date(startTimeISO);
    const endDate = new Date(endTimeISO);

    if (statusEl) statusEl.textContent = 'Fetching chunk metadata...';
    const allDayMetadata = await fetchAllDayMetadata(
        startTimeISO, endTimeISO, satellite, component
    );

    const validMetadata = allDayMetadata.filter(m => m !== null);
    if (validMetadata.length === 0) {
        throw new Error('No metadata available for any day in the requested range');
    }
    console.log(`✅ ${logTime()} Metadata loaded: ${validMetadata.length} days`);

    // Step 3: Build tiered chunk schedule
    const chunkSchedule = buildChunkSchedule(startDate, endDate, allDayMetadata, satellite, component);

    if (chunkSchedule.length === 0) {
        throw new Error('No chunks available for this time range');
    }

    // Calculate total expected samples and global min/max for normalization
    let totalExpectedSamples = 0;
    let normMin = Infinity;
    let normMax = -Infinity;
    for (const chunk of chunkSchedule) {
        totalExpectedSamples += chunk.samples;
        if (chunk.min < normMin) normMin = chunk.min;
        if (chunk.max > normMax) normMax = chunk.max;
    }
    const normRange = normMax - normMin;

    console.log(`📊 ${logTime()} Expected: ${totalExpectedSamples.toLocaleString()} samples (${(totalExpectedSamples / INSTRUMENT_SAMPLE_RATE / 3600).toFixed(1)}h at ${INSTRUMENT_SAMPLE_RATE}Hz)`);
    console.log(`📊 Normalization range: ${normMin.toFixed(2)} → ${normMax.toFixed(2)}`);

    // =========================================================================
    // Step 4: Set up state/axes BEFORE downloading (we know the full time range)
    // This mirrors the volcano pipeline — axes, metadata, and duration are set
    // early so the UI is ready for progressive data as it arrives.
    // =========================================================================

    const realWorldSpanSeconds = (endDate - startDate) / 1000;
    const playbackSamplesPerRealSecond = totalExpectedSamples / realWorldSpanSeconds;
    const instrumentNyquist = INSTRUMENT_SAMPLE_RATE / 2;

    // Set metadata (used by axes, playback speed, etc.)
    State.setCurrentMetadata({
        playback_sample_rate: 44100, // nominal — worklet outputs at AudioContext rate
        playback_total_samples: totalExpectedSamples,
        playback_samples_per_real_second: playbackSamplesPerRealSecond,
        startTime: startTimeISO,
        endTime: endTimeISO,
        real_world_time_span: realWorldSpanSeconds,
        instrument_sampling_rate: INSTRUMENT_SAMPLE_RATE,
        instrument_nyquist: instrumentNyquist,
        original_sample_rate: playbackSamplesPerRealSecond,
        spacecraft: spacecraft,
        dataset: dataset,
    });

    // Set time range for axes
    State.setDataStartTime(startDate);
    State.setDataEndTime(endDate);

    // Load saved regions now that time range is known
    loadRegionsAfterDataFetch();

    // Frequency range for Y-axis
    State.setOriginalDataFrequencyRange({
        min: 0,
        max: instrumentNyquist,
    });

    // Set expected duration early (refined with actual count at completion)
    const expectedDuration = totalExpectedSamples / playbackSamplesPerRealSecond;
    State.setTotalAudioDuration(expectedDuration);
    State.setPlaybackDurationSeconds(expectedDuration);
    updatePlaybackDuration(expectedDuration);
    console.log(`📊 ${logTime()} Set EXPECTED totalAudioDuration: ${expectedDuration.toFixed(2)}s`);

    // Update sample count UI early
    document.getElementById('sampleCount').textContent = totalExpectedSamples.toLocaleString();

    // Frequency scale default
    const frequencyScaleSelect = document.getElementById('frequencyScale');
    if (frequencyScaleSelect) {
        const hasUserPreference = localStorage.getItem('frequencyScale') !== null;
        if (!hasUserPreference) {
            frequencyScaleSelect.value = 'logarithmic';
            State.setFrequencyScale('logarithmic');
            localStorage.setItem('frequencyScale', 'logarithmic');
        }
    }

    // Draw axes with metadata (before data arrives — they're ready now)
    positionAxisCanvas();
    initializeAxisPlaybackRate();
    positionWaveformXAxisCanvas();
    drawWaveformXAxis();
    positionSpectrogramXAxisCanvas();
    drawSpectrogramXAxis();
    positionWaveformDateCanvas();
    drawWaveformDate();

    // Component selector — 3 components (bx, by, bz)
    const allFileUrls = COMPONENT_MAP.map(c => `${satellite}/mag/${c}`);
    if (allFileUrls.length > 1) {
        const { initializeComponentSelector } = await import('./component-selector.js');
        initializeComponentSelector(allFileUrls, {
            spacecraft, dataset, startTime: startTimeISO, endTime: endTimeISO,
        });
    }

    // =========================================================================
    // Step 5: Progressive download + decompress + feed
    // Each chunk is fetched sequentially, decompressed with fzstd, normalized,
    // then fed to the audio worklet and waveform worker progressively.
    // =========================================================================

    const processedChunks = [];
    let chunksReceived = 0;
    let firstChunkSent = false;
    let totalBytesDownloaded = 0;
    const progressiveT0 = performance.now();

    // Initialize worklet data tracking
    State.setAllReceivedData([]);

    // Track ordered sending to worklet (mirrors volcano's sendChunksInOrder)
    let nextChunkToSend = 0;
    let nextWaveformChunk = 0;

    // WORKLET_CHUNK_SIZE matches the volcano pipeline
    const WORKLET_CHUNK_SIZE = 1024;

    // Smooth boundary samples (eliminates clicks between real data and silence)
    const SMOOTH_SAMPLES = 1000;

    // Set first-play flag BEFORE any audio data reaches the worklet
    // This ensures the worklet uses a long 250ms fade-in on first playback
    if (State.workletNode) {
        State.workletNode.port.postMessage({ type: 'set-first-play-flag' });
    }

    /**
     * Send chunks to worklet in temporal order, maintaining ordering guarantee.
     * Mirrors sendChunksInOrder() from data-fetcher.js volcano pipeline.
     */
    function sendChunksInOrder() {
        while (processedChunks[nextChunkToSend]) {
            let { samples, rawSamples } = processedChunks[nextChunkToSend];
            const currentChunkIndex = nextChunkToSend;
            const currentChunkInfo = chunkSchedule[currentChunkIndex];

            // Smooth boundaries between real data and missing chunks
            const isMissing = currentChunkInfo?.isMissing || false;
            const nextChunkInfo = chunkSchedule[nextChunkToSend + 1];
            const nextIsMissing = nextChunkInfo?.isMissing || false;

            // Copy to avoid modifying original
            samples = new Float32Array(samples);

            // Smooth start: transition into missing chunk from previous real data
            if (isMissing && nextChunkToSend > 0 && processedChunks[nextChunkToSend - 1]) {
                const prevSamples = processedChunks[nextChunkToSend - 1].samples;
                if (prevSamples && prevSamples.length > 0) {
                    const prevValue = prevSamples[prevSamples.length - 1];
                    const smoothLength = Math.min(SMOOTH_SAMPLES, samples.length);
                    for (let i = 0; i < smoothLength; i++) {
                        samples[i] = prevValue * (1 - i / smoothLength);
                    }
                }
            }

            // Smooth end: transition from real chunk into next missing chunk
            if (!isMissing && nextIsMissing) {
                const smoothLength = Math.min(SMOOTH_SAMPLES, samples.length);
                const startIdx = samples.length - smoothLength;
                const startValue = samples[startIdx];
                for (let i = 0; i < smoothLength; i++) {
                    samples[startIdx + i] = startValue * (1 - i / smoothLength);
                }
            }

            // Feed to worklet in 1024-sample sub-chunks
            for (let i = 0; i < samples.length; i += WORKLET_CHUNK_SIZE) {
                const size = Math.min(WORKLET_CHUNK_SIZE, samples.length - i);
                const workletChunk = samples.slice(i, i + size);

                State.workletNode.port.postMessage({
                    type: 'audio-data',
                    data: workletChunk,
                    autoResume: true,
                });

                State.allReceivedData.push(workletChunk);

                // First chunk = start playback immediately
                if (!firstChunkSent && i === 0 && currentChunkIndex === 0) {
                    firstChunkSent = true;
                    const ttfa = performance.now() - progressiveT0;
                    console.log(`⚡ FIRST CHUNK SENT in ${ttfa.toFixed(0)}ms — starting playback!`);

                    const isSharedSession = sessionStorage.getItem('isSharedSession') === 'true';
                    const autoPlayEnabled = !isSharedSession && document.getElementById('autoPlay')?.checked;

                    if (autoPlayEnabled) {
                        State.workletNode.port.postMessage({ type: 'start-immediately' });
                        State.setPlaybackState(PlaybackState.PLAYING);

                        if (State.gainNode && State.audioContext) {
                            const targetVolume = parseFloat(document.getElementById('volumeSlider').value) / 100;
                            State.gainNode.gain.cancelScheduledValues(State.audioContext.currentTime);
                            State.gainNode.gain.setValueAtTime(0.0001, State.audioContext.currentTime);
                            State.gainNode.gain.exponentialRampToValueAtTime(
                                Math.max(0.01, targetVolume),
                                State.audioContext.currentTime + 0.05
                            );
                        }

                        State.setCurrentAudioPosition(0);
                        State.setLastWorkletPosition(0);
                        State.setLastWorkletUpdateTime(State.audioContext.currentTime);
                        State.setLastUpdateTime(State.audioContext.currentTime);

                        const playPauseBtn = document.getElementById('playPauseBtn');
                        if (playPauseBtn) {
                            playPauseBtn.disabled = false;
                            playPauseBtn.textContent = '⏸️ Pause';
                            playPauseBtn.classList.remove('play-active', 'pulse-play', 'pulse-resume', 'pulse-attention');
                            playPauseBtn.classList.add('pause-active');
                        }

                        startPlaybackIndicator();
                    } else {
                        State.setPlaybackState(PlaybackState.STOPPED);
                        const playPauseBtn = document.getElementById('playPauseBtn');
                        if (playPauseBtn) {
                            playPauseBtn.disabled = false;
                            playPauseBtn.textContent = '▶️ Play';
                            playPauseBtn.classList.remove('pause-active');
                            playPauseBtn.classList.add('play-active');
                        }
                        if (isSharedSession) {
                            playPauseBtn?.classList.add('pulse-attention');
                        }
                    }
                }
            }

            nextChunkToSend++;
        }

        // Progressive memory cleanup: free chunks already sent to both worklet and waveform worker
        for (let i = 0; i < nextChunkToSend; i++) {
            if (processedChunks[i] && processedChunks[i].samples !== null && i < nextWaveformChunk) {
                processedChunks[i].samples = null;
            }
        }
    }

    /**
     * Send chunks to waveform worker in order, trigger progressive draw.
     */
    function sendToWaveformInOrder() {
        while (nextWaveformChunk < chunkSchedule.length && processedChunks[nextWaveformChunk]) {
            const chunk = processedChunks[nextWaveformChunk];
            State.waveformWorker.postMessage({
                type: 'add-samples',
                samples: chunk.samples,
                rawSamples: chunk.rawSamples,
            });
            nextWaveformChunk++;

            // Progressive waveform draw every 3 chunks (or first/last)
            if (nextWaveformChunk === 1 || nextWaveformChunk === chunkSchedule.length || nextWaveformChunk % 3 === 0) {
                const canvas = document.getElementById('waveform');
                const width = canvas.offsetWidth * window.devicePixelRatio;
                const height = canvas.offsetHeight * window.devicePixelRatio;
                const removeDC = document.getElementById('removeDCOffset')?.checked || false;
                const filterSlider = document.getElementById('waveformFilterSlider');
                const filterAlpha = filterSlider
                    ? 0.95 + (parseInt(filterSlider.value) / 100) * (0.9999 - 0.95)
                    : 0.99;

                State.waveformWorker.postMessage({
                    type: 'build-waveform',
                    canvasWidth: width,
                    canvasHeight: height,
                    removeDC: removeDC,
                    alpha: filterAlpha,
                    totalExpectedSamples: totalExpectedSamples,
                });
            }
        }
    }

    // =========================================================================
    // Step 6: Sequential chunk download loop
    // =========================================================================

    for (let i = 0; i < chunkSchedule.length; i++) {
        const chunk = chunkSchedule[i];
        const progress = `${i + 1}/${chunkSchedule.length}`;

        if (statusEl) {
            statusEl.textContent = `Downloading ${chunk.type} chunk ${progress} (${chunk.date} ${chunk.startTime})...`;
        }

        let samples, rawSamples;

        if (chunk.url && !chunk.isMissing) {
            try {
                const resp = await fetch(chunk.url);
                if (!resp.ok) {
                    console.warn(`⚠️ Chunk ${progress} failed: ${resp.status} — filling zeros`);
                    const zeroSamples = new Float32Array(chunk.samples);
                    samples = zeroSamples;
                    rawSamples = zeroSamples;
                } else {
                    const compressed = new Uint8Array(await resp.arrayBuffer());
                    totalBytesDownloaded += compressed.byteLength;

                    // Decompress zstd → raw Float32Array
                    const decompressed = zstd.decompress(compressed);
                    rawSamples = new Float32Array(
                        decompressed.buffer,
                        decompressed.byteOffset,
                        decompressed.byteLength / 4
                    );

                    // Normalize to [-1, 1] using global min/max
                    samples = new Float32Array(rawSamples.length);
                    if (normRange > 0) {
                        for (let s = 0; s < rawSamples.length; s++) {
                            samples[s] = 2 * (rawSamples[s] - normMin) / normRange - 1;
                        }
                    }

                    console.log(`✅ ${logTime()} Chunk ${progress} [${chunk.type}]: ${(compressed.byteLength / 1024).toFixed(1)} KB → ${rawSamples.length.toLocaleString()} samples`);
                }
            } catch (e) {
                console.warn(`⚠️ Chunk ${progress} error: ${e.message} — filling zeros`);
                const zeroSamples = new Float32Array(chunk.samples);
                samples = zeroSamples;
                rawSamples = zeroSamples;
            }
        } else {
            // Missing chunk — zeros
            const zeroSamples = new Float32Array(chunk.samples);
            samples = zeroSamples;
            rawSamples = zeroSamples;
        }

        // Store processed chunk
        processedChunks[i] = { samples, rawSamples };
        chunksReceived++;

        // Feed to worklet in order (audio playback)
        sendChunksInOrder();

        // Feed to waveform worker in order (progressive waveform drawing)
        sendToWaveformInOrder();

        // Update download size display
        const downloadSizeEl = document.getElementById('downloadSize');
        if (downloadSizeEl) {
            downloadSizeEl.textContent = `${(totalBytesDownloaded / 1024 / 1024).toFixed(2)} MB`;
        }
    }

    // =========================================================================
    // Step 7: All chunks received — completion
    // Mirrors the volcano completion handler in data-fetcher.js
    // =========================================================================

    const totalTime = performance.now() - progressiveT0;
    console.log(`✅ All ${chunkSchedule.length} chunks processed in ${totalTime.toFixed(0)}ms total`);

    // Calculate total from worklet data (most reliable)
    const totalWorkletSamples = State.allReceivedData.reduce((sum, c) => sum + c.length, 0);
    console.log(`📊 ${logTime()} Total worklet samples: ${totalWorkletSamples.toLocaleString()}`);

    // Update duration with actual sample count
    const originalSampleRate = State.currentMetadata?.original_sample_rate || playbackSamplesPerRealSecond;
    State.setTotalAudioDuration(totalWorkletSamples / originalSampleRate);
    document.getElementById('sampleCount').textContent = totalWorkletSamples.toLocaleString();
    console.log(`📊 ${logTime()} Updated totalAudioDuration to ${(totalWorkletSamples / originalSampleRate).toFixed(2)}s`);

    // Initialize zoom with actual sample count
    zoomState.initialize(totalWorkletSamples);

    // Kill loading animation
    if (State.loadingInterval) {
        clearInterval(State.loadingInterval);
        State.setLoadingInterval(null);
    }

    // Signal data complete to worklet
    State.workletNode.port.postMessage({
        type: 'data-complete',
        totalSamples: totalWorkletSamples,
        sampleRate: originalSampleRate,
    });

    // Final waveform build with DC removal
    console.log(`🎨 ${logTime()} Requesting final waveform (${totalWorkletSamples.toLocaleString()} samples)`);
    const canvas = document.getElementById('waveform');
    const removeDC = document.getElementById('removeDCOffset')?.checked || false;
    const slider = document.getElementById('waveformFilterSlider');
    const alpha = slider ? 0.9 + (parseInt(slider.value) / 1000) : 0.99;

    State.waveformWorker.postMessage({
        type: 'build-waveform',
        canvasWidth: canvas.offsetWidth * window.devicePixelRatio,
        canvasHeight: canvas.offsetHeight * window.devicePixelRatio,
        removeDC: removeDC,
        alpha: alpha,
        isComplete: true,
        totalExpectedSamples: totalWorkletSamples,
    });

    // Draw waveform axis
    positionWaveformAxisCanvas();
    drawWaveformAxis();

    // Stitch samples into completeSamplesArray for spectrogram + download
    console.log(`📦 ${logTime()} Stitching ${State.allReceivedData.length} chunks...`);
    const stitched = new Float32Array(totalWorkletSamples);
    let offset = 0;
    for (const c of State.allReceivedData) {
        stitched.set(c, offset);
        offset += c.length;
    }
    State.setCompleteSamplesArray(stitched);
    console.log(`📦 ${logTime()} completeSamplesArray ready: ${stitched.length.toLocaleString()} samples`);

    // Free allReceivedData and processedChunks (memory cleanup)
    for (let i = 0; i < State.allReceivedData.length; i++) {
        State.allReceivedData[i] = null;
    }
    State.setAllReceivedData([]);

    for (let i = 0; i < processedChunks.length; i++) {
        if (processedChunks[i]) {
            processedChunks[i].samples = null;
            processedChunks[i].rawSamples = null;
            processedChunks[i] = null;
        }
    }
    processedChunks.length = 0;
    console.log(`🧹 ${logTime()} Memory cleaned up`);

    // Enable download button
    const downloadContainer = document.getElementById('downloadAudioContainer');
    if (downloadContainer) downloadContainer.style.display = 'flex';
    const downloadBtn = document.getElementById('downloadBtn');
    if (downloadBtn) downloadBtn.disabled = false;

    // Enable analysis button
    if (!isTutorialActive()) {
        updateCompleteButtonState();
    }

    // Render complete spectrogram (progressive tile rendering via pyramid)
    console.log(`🎨 ${logTime()} Triggering spectrogram rendering...`);
    await startCompleteVisualization();

    // Update playback controls
    updatePlaybackSpeed();
    updatePlaybackDuration();

    // Stop fetch button pulse
    const startBtn = document.getElementById('startBtn');
    if (startBtn) startBtn.classList.add('fetched');

    State.setIsFetchingNewData(false);

    console.log(`✅ ${logTime()} Cloudflare progressive pipeline complete!`);
}
