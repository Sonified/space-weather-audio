// ⚠️ When in any doubt, use Edit to surgically fix mistakes — never git checkout this file.
// ========== GOES CLOUDFLARE FETCHER ==========
// Decomposed into two layers:
//   1. Download Engine — fetches chunks, decompresses, caches to IndexedDB
//   2. Render Pipeline — subscribes to download engine, feeds worklet + spectrogram
//
// The download engine runs as a "session" that the render pipeline can attach to
// mid-stream. Preload starts a session silently; when analysis begins, it attaches
// a renderer that replays cached chunks instantly and streams the rest live.

import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { updatePlaybackIndicator, drawWaveform, startPlaybackIndicator } from './minimap-window-renderer.js';
import { updatePlaybackSpeed } from './audio-player.js';
import { updatePlaybackDuration } from './ui-controls.js';
import { drawFrequencyAxis, positionAxisCanvas, initializeAxisPlaybackRate } from './spectrogram-axis-renderer.js';
import { drawMinimapAxis, positionMinimapAxisCanvas } from './minimap-axis-renderer.js';
import { positionMinimapXAxisCanvas, drawMinimapXAxis, positionMinimapDateCanvas, drawMinimapDate } from './minimap-x-axis-renderer.js';
import { drawSpectrogramXAxis, positionSpectrogramXAxisCanvas } from './spectrogram-x-axis-renderer.js';
import { renderProgressiveSpectrogram, resetProgressiveSpectrogram } from './main-window-renderer.js';
import { zoomState } from './zoom-state.js';
import { updateCompleteButtonState, loadRegionsAfterDataFetch } from './feature-tracker.js';
import { storeChunk, getChunk } from './goes-data-cache.js';

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
let activeAbortController = null; // cancels in-flight render pipeline

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
async function fetchAllDayMetadata(startDate, endDate, satellite, component, signal) {
    const days = [];
    const current = new Date(startDate);
    const end = new Date(endDate);

    while (current < end) {
        days.push(current.toISOString().split('T')[0]);
        current.setUTCDate(current.getUTCDate() + 1);
    }

    if (window.pm?.data) console.log(`📋 Fetching metadata for ${days.length} days: ${days[0]} → ${days[days.length - 1]}`);

    const results = await Promise.all(days.map(async (dateStr) => {
        const [year, month, day] = dateStr.split('-');
        const url = `${WORKER_BASE}/data/${year}/${month}/${day}/${satellite}/mag/${component}/metadata.json`;
        try {
            const resp = await fetch(url, { signal });
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
    if (window.pm?.data) console.log(`✅ Got metadata for ${valid.length}/${days.length} days`);
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
    if (window.pm?.data) console.log(`📋 Chunk schedule: ${chunks.length} total — ${Object.entries(typeCounts).map(([t, n]) => `${n}×${t}`).join(', ')}`);

    return chunks;
}

// =============================================================================
// Download Session System
// =============================================================================
//
// A download session fetches chunks from R2, decompresses them, normalizes them,
// and caches raw data to IndexedDB. A renderer can attach at any time —
// already-downloaded chunks replay instantly, future chunks stream live.

const activeSessions = new Map();

function sessionKey(spacecraft, dataset, startTime, endTime) {
    return `${spacecraft}_${dataset}_${startTime}_${endTime}`;
}

/**
 * Get an existing download session or create a new one.
 * If a session exists for this exact data range, returns it (may be in-progress or done).
 */
export async function getOrCreateDownloadSession(spacecraft, dataset, startTimeISO, endTimeISO) {
    const key = sessionKey(spacecraft, dataset, startTimeISO, endTimeISO);
    const existing = activeSessions.get(key);
    if (existing && !existing.abortController.signal.aborted) {
        // Don't reuse sessions whose chunk data was freed by onComplete cleanup —
        // a fresh session will re-read from IndexedDB cache (fast, no network)
        const chunksFreed = existing.done && existing.processedChunks.every(c => c === null);
        if (!chunksFreed) {
            if (window.pm?.data) console.log(`📦 [SESSION] Reusing existing session: ${key} (${existing.completedCount}/${existing.chunkSchedule?.length || '?'} chunks done)`);
            return existing;
        }
        if (window.pm?.data) console.log(`📦 [SESSION] Session chunks freed — creating fresh session: ${key}`);
        activeSessions.delete(key);
    }
    return await createDownloadSession(spacecraft, dataset, startTimeISO, endTimeISO);
}

async function createDownloadSession(spacecraft, dataset, startTimeISO, endTimeISO) {
    const key = sessionKey(spacecraft, dataset, startTimeISO, endTimeISO);

    let metadataResolve;
    const metadataPromise = new Promise(r => { metadataResolve = r; });

    const session = {
        key,
        spacecraft, dataset, startTimeISO, endTimeISO,
        chunkSchedule: null,
        metadata: null,
        metadataPromise,
        metadataResolve,
        processedChunks: [],   // { normalized, raw } per chunk index
        completedCount: 0,
        done: false,
        renderer: null,        // attached by render pipeline
        rendererStartIndex: 0, // download loop only notifies for chunks >= this
        abortController: new AbortController(),
        promise: null,
        totalBytesDownloaded: 0,
    };

    session.promise = runDownloadSession(session);
    activeSessions.set(key, session);

    if (window.pm?.data) console.log(`📦 [SESSION] Created new session: ${key}`);
    return session;
}

/**
 * Attach a renderer to a session.
 * Replays all already-downloaded chunks through onChunkReady,
 * then sets the renderer so future chunks stream live.
 */
async function attachRendererToSession(session, callbacks) {
    const catchUpTo = session.completedCount;
    session.rendererStartIndex = catchUpTo;
    session.renderer = callbacks;

    if (window.pm?.data) console.log(`🎨 [RENDER] Attaching renderer — replaying ${catchUpTo} cached chunks`);

    // Replay all already-downloaded chunks
    for (let i = 0; i < catchUpTo; i++) {
        const chunk = session.processedChunks[i];
        if (chunk) {
            callbacks.onChunkReady(i, chunk.normalized, chunk.raw);
        }
    }

    // If session already done, fire completion immediately
    if (session.done) {
        if (window.pm?.data) console.log(`🎨 [RENDER] Session already complete — firing onComplete`);
        await callbacks.onComplete();
    }
}

/**
 * Core download engine. Runs the session: fetches metadata, builds chunk schedule,
 * downloads + decompresses + normalizes + caches each chunk.
 */
async function runDownloadSession(session) {
    const { abortController, startTimeISO, endTimeISO } = session;
    const signal = abortController.signal;

    try {
        // Load fzstd for zstd decompression
        const zstd = await ensureFzstd();
        if (signal.aborted) return;

        // Determine satellite and component
        const satellite = DATASET_TO_SATELLITE[session.dataset] || 'GOES-16';
        const componentIdx = parseInt(document.getElementById('componentSelector')?.value || '0');
        const component = COMPONENT_MAP[componentIdx] || 'bx';

        if (window.pm?.data) console.log(`📦 [SESSION] Satellite: ${satellite}, Component: ${component}`);

        // Fetch metadata for all days
        const allDayMetadata = await fetchAllDayMetadata(
            startTimeISO, endTimeISO, satellite, component, signal
        );
        if (signal.aborted) return;

        const validMetadata = allDayMetadata.filter(m => m !== null);
        if (validMetadata.length === 0) {
            throw new Error('No metadata available for any day in the requested range');
        }

        // Build tiered chunk schedule
        const startDate = new Date(startTimeISO);
        const endDate = new Date(endTimeISO);
        const chunkSchedule = buildChunkSchedule(startDate, endDate, allDayMetadata, satellite, component);

        if (chunkSchedule.length === 0) {
            throw new Error('No chunks available for this time range');
        }

        // Calculate total expected samples and global normalization range
        let totalExpectedSamples = 0;
        let normMin = Infinity;
        let normMax = -Infinity;
        for (const chunk of chunkSchedule) {
            totalExpectedSamples += chunk.samples;
            if (chunk.min < normMin) normMin = chunk.min;
            if (chunk.max > normMax) normMax = chunk.max;
        }
        const normRange = normMax - normMin;

        const realWorldSpanSeconds = (endDate - startDate) / 1000;
        const playbackSamplesPerRealSecond = totalExpectedSamples / realWorldSpanSeconds;

        // Store metadata on session and resolve the promise
        session.chunkSchedule = chunkSchedule;
        session.metadata = {
            satellite, component, normMin, normMax, normRange,
            totalExpectedSamples, startDate, endDate,
            realWorldSpanSeconds,
            instrumentNyquist: INSTRUMENT_SAMPLE_RATE / 2,
            playbackSamplesPerRealSecond,
        };
        session.metadataResolve(session.metadata);

        if (window.pm?.data) {
            console.log(`📦 [SESSION] Metadata ready: ${chunkSchedule.length} chunks, ${totalExpectedSamples.toLocaleString()} samples`);
            console.log(`📦 [SESSION] Normalization range: ${normMin.toFixed(2)} → ${normMax.toFixed(2)}`);
        }

        // =====================================================================
        // Sequential chunk download loop
        // =====================================================================

        for (let i = 0; i < chunkSchedule.length; i++) {
            if (signal.aborted) return;
            const chunk = chunkSchedule[i];

            let rawSamples;

            if (chunk.isMissing || !chunk.url) {
                // Missing chunk — zeros
                rawSamples = new Float32Array(chunk.samples);
            } else {
                // Check IndexedDB cache first (unless bypass is enabled)
                const bypassCache = document.getElementById('drawerBypassCache')?.checked;
                const cached = !bypassCache ? await getChunk(satellite, component, chunk.date, chunk.type, chunk.startTime) : null;
                if (cached) {
                    rawSamples = cached;
                    if (window.pm?.data) console.log(`💾 [CACHE HIT] chunk ${i + 1}/${chunkSchedule.length} [${chunk.type}]`);
                } else {
                    // Fetch from R2
                    try {
                        const resp = await fetch(chunk.url, { signal });
                        if (!resp.ok) {
                            console.warn(`⚠️ Chunk ${i + 1}/${chunkSchedule.length} failed: ${resp.status} — filling zeros`);
                            rawSamples = new Float32Array(chunk.samples);
                        } else {
                            const compressed = new Uint8Array(await resp.arrayBuffer());
                            session.totalBytesDownloaded += compressed.byteLength;

                            // Decompress zstd → raw Float32Array
                            const decompressed = zstd.decompress(compressed);
                            rawSamples = new Float32Array(
                                decompressed.buffer,
                                decompressed.byteOffset,
                                decompressed.byteLength / 4
                            );

                            // Cache for next time (fire-and-forget)
                            storeChunk(satellite, component, chunk.date, chunk.type, chunk.startTime, rawSamples).catch(() => {});

                            if (window.pm?.data) console.log(`☁️ [DOWNLOAD] chunk ${i + 1}/${chunkSchedule.length} [${chunk.type}]: ${(compressed.byteLength / 1024).toFixed(1)} KB → ${rawSamples.length.toLocaleString()} samples`);
                        }
                    } catch (e) {
                        if (signal.aborted) return;
                        console.warn(`⚠️ Chunk ${i + 1}/${chunkSchedule.length} error: ${e.message} — filling zeros`);
                        rawSamples = new Float32Array(chunk.samples);
                    }
                }
            }

            // Normalize to [-1, 1] using global min/max
            const normalized = new Float32Array(rawSamples.length);
            if (normRange > 0) {
                for (let s = 0; s < rawSamples.length; s++) {
                    normalized[s] = 2 * (rawSamples[s] - normMin) / normRange - 1;
                }
            }

            // Store on session
            session.processedChunks[i] = { normalized, raw: rawSamples };
            session.completedCount = i + 1;

            // Notify renderer if attached (only for chunks past the replay point)
            if (session.renderer && i >= session.rendererStartIndex) {
                session.renderer.onChunkReady(i, normalized, rawSamples);
            }

            // Yield to browser event loop
            await new Promise(r => setTimeout(r, 0));
        }

        if (signal.aborted) return;

        // All chunks downloaded
        session.done = true;
        if (window.pm?.data) {
            const dl = session.totalBytesDownloaded;
            console.log(`📦 [SESSION] Complete: ${chunkSchedule.length} chunks, ${dl ? (dl / 1024 / 1024).toFixed(2) + ' MB downloaded' : 'all from cache'}`);
        }

        // Notify renderer of completion
        if (session.renderer?.onComplete) {
            await session.renderer.onComplete();
        }

    } catch (e) {
        if (e.name === 'AbortError') {
            if (window.pm?.data) console.log('📦 [SESSION] Aborted');
            return;
        }
        throw e;
    }
}

/**
 * Prefetch data without rendering. Used by study preload queue.
 * Creates a download session that fetches + caches all chunks silently.
 */
export async function prefetchCloudflareData(spacecraft, dataset, startTimeISO, endTimeISO) {
    if (window.pm?.data) console.log(`📦 [PREFETCH] Starting silent prefetch: ${spacecraft} ${dataset} ${startTimeISO} → ${endTimeISO}`);
    const session = await getOrCreateDownloadSession(spacecraft, dataset, startTimeISO, endTimeISO);
    return session.promise;
}

/**
 * Get stitched audio buffer from a completed prefetch session.
 * Returns null if session doesn't exist or has no data.
 * Used by the pre-render compute pipeline (HS25).
 */
export function getSessionAudioBuffer(spacecraft, dataset, startTimeISO, endTimeISO) {
    const key = sessionKey(spacecraft, dataset, startTimeISO, endTimeISO);
    const session = activeSessions.get(key);
    if (!session || session.completedCount === 0) return null;

    // Stitch all completed normalized chunks into one buffer
    let totalSamples = 0;
    for (const chunk of session.processedChunks) {
        if (chunk?.normalized) totalSamples += chunk.normalized.length;
    }
    if (totalSamples === 0) return null;

    const buffer = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of session.processedChunks) {
        if (chunk?.normalized) {
            buffer.set(chunk.normalized, offset);
            offset += chunk.normalized.length;
        }
    }

    return { buffer, metadata: session.metadata };
}

// =============================================================================
// Render Pipeline — subscribes to a download session
// =============================================================================
//
// fetchAndLoadCloudflareData sets up audio state, axes, and worklet,
// then attaches renderer callbacks to a download session. Chunks that
// were preloaded replay instantly; the rest stream live.

/**
 * Full fetch + render pipeline. Gets or creates a download session,
 * sets up the render environment, and attaches renderer callbacks.
 */
export async function fetchAndLoadCloudflareData(spacecraft, dataset, startTimeISO, endTimeISO) {
    // Cancel any in-flight render pipeline (NOT prefetch sessions — those continue)
    if (activeAbortController) {
        activeAbortController.abort();
        if (window.pm?.data) console.log('🎨 [RENDER] Cancelled previous render pipeline');
    }
    activeAbortController = new AbortController();
    const renderSignal = activeAbortController.signal;

    try {

    const logTime = () => `[${Math.round(performance.now() - window.streamingStartTime)}ms]`;
    const statusEl = document.getElementById('status');

    // Reset waveform worker so old data doesn't bleed into new fetch
    if (State.waveformWorker) {
        State.waveformWorker.postMessage({ type: 'reset' });
    }

    if (window.pm?.data) {
        console.log(`🎨 [RENDER] Starting render pipeline: ${spacecraft} ${dataset}`);
        console.log(`🎨 ${logTime()} Time range: ${startTimeISO} → ${endTimeISO}`);
    }

    // =========================================================================
    // Get or create download session — may already be running from preload
    // =========================================================================

    const session = await getOrCreateDownloadSession(spacecraft, dataset, startTimeISO, endTimeISO);

    // Wait for session metadata (resolves instantly if preload already fetched it)
    const silentEarly = document.getElementById('silentDownload')?.checked;
    if (statusEl && !silentEarly) statusEl.textContent = 'Preparing data...';
    await session.metadataPromise;

    if (renderSignal.aborted) return;

    const { satellite, component, normMin, normMax, normRange,
            totalExpectedSamples, startDate, endDate,
            realWorldSpanSeconds, instrumentNyquist,
            playbackSamplesPerRealSecond } = session.metadata;
    const chunkSchedule = session.chunkSchedule;

    if (window.pm?.data) {
        console.log(`🎨 ${logTime()} Metadata ready (${session.completedCount}/${chunkSchedule.length} chunks already cached)`);
    }

    // =========================================================================
    // State/axes setup — identical to previous implementation
    // =========================================================================

    // Set metadata (used by axes, playback speed, etc.)
    State.setCurrentMetadata({
        playback_sample_rate: 44100,
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

    // Load saved regions now that time range is known (await needed for review mode D1 fetch)
    await loadRegionsAfterDataFetch();

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
    if (window.pm?.data) console.log(`📊 ${logTime()} Set EXPECTED totalAudioDuration: ${expectedDuration.toFixed(2)}s`);

    // Update sample count UI early
    const sampleCountEl = document.getElementById('sampleCount');
    if (sampleCountEl) sampleCountEl.textContent = totalExpectedSamples.toLocaleString();

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

    // Position axis canvases
    positionAxisCanvas();
    positionMinimapXAxisCanvas();
    positionSpectrogramXAxisCanvas();
    positionMinimapDateCanvas();

    // Draw axis ticks — skip in triggered mode
    const initRenderMode = document.getElementById('dataRendering')?.value || 'progressive';
    if (initRenderMode !== 'triggered') {
        initializeAxisPlaybackRate();
        drawMinimapXAxis();
        drawSpectrogramXAxis();
        drawMinimapDate();
    }

    // Component selector — 3 components (bx, by, bz)
    const allFileUrls = COMPONENT_MAP.map(c => `${satellite}/mag/${c}`);
    if (allFileUrls.length > 1) {
        const { initializeComponentSelector } = await import('./component-selector.js');
        initializeComponentSelector(allFileUrls, {
            spacecraft, dataset, startTime: startTimeISO, endTime: endTimeISO,
        });
    }

    // =========================================================================
    // Progressive rendering state
    // =========================================================================

    const processedChunks = [];
    let chunksReceived = 0;
    let playbackTriggered = false;
    let totalSamplesSentToWorklet = 0;
    const BUFFER_THRESHOLD = 44100;
    let spectrogramRenderInProgress = false;
    const dataRenderingEl = document.getElementById('dataRendering');
    let renderTriggered = false;
    window.triggerDataRender = () => { renderTriggered = true; };
    let lastRenderTime = 0;
    const RENDER_THROTTLE_MS = 100;
    let lastMinimapFFTTime = 0;
    const MINIMAP_FFT_THROTTLE_MS = 100;

    // Running buffer: grows as chunks arrive
    let progressiveSamplesBuffer = null;
    let progressiveSamplesOffset = 0;
    let progressiveBufferChunkIndex = 0;

    // Reset progressive spectrogram state
    resetProgressiveSpectrogram();

    // Initialize worklet data tracking
    State.setAllReceivedData([]);

    // Track ordered sending to worklet
    let nextChunkToSend = 0;
    let nextWaveformChunk = 0;

    const WORKLET_CHUNK_SIZE = 1024;
    const SMOOTH_SAMPLES = 1000;

    // Set first-play flag and sample rate on worklet
    if (State.workletNode) {
        State.workletNode.port.postMessage({ type: 'set-first-play-flag' });
        State.workletNode.port.postMessage({
            type: 'set-sample-rate',
            sampleRate: playbackSamplesPerRealSecond,
        });
    }

    // Kill the dot-animation interval
    if (State.loadingInterval) {
        clearInterval(State.loadingInterval);
        State.setLoadingInterval(null);
    }

    const silentDownload = document.getElementById('silentDownload')?.checked;

    // =========================================================================
    // Render helper functions (closures over local state)
    // =========================================================================

    /**
     * Grow the running samples buffer with newly sent chunks.
     */
    function growProgressiveBuffer() {
        if (!progressiveSamplesBuffer) {
            progressiveSamplesBuffer = new Float32Array(totalExpectedSamples || 1024 * 1024);
        }
        const chunks = State.allReceivedData;
        while (progressiveBufferChunkIndex < chunks.length) {
            const chunk = chunks[progressiveBufferChunkIndex];
            if (chunk) {
                if (progressiveSamplesOffset + chunk.length > progressiveSamplesBuffer.length) {
                    const newBuf = new Float32Array(Math.max(progressiveSamplesBuffer.length * 2, progressiveSamplesOffset + chunk.length));
                    newBuf.set(progressiveSamplesBuffer);
                    progressiveSamplesBuffer = newBuf;
                }
                progressiveSamplesBuffer.set(chunk, progressiveSamplesOffset);
                progressiveSamplesOffset += chunk.length;
            }
            progressiveBufferChunkIndex++;
        }
        return progressiveSamplesOffset > 0 ? progressiveSamplesBuffer.subarray(0, progressiveSamplesOffset) : null;
    }

    /**
     * Send chunks to worklet in temporal order.
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

                const userPaused = State.playbackState === PlaybackState.PAUSED;
                const isPlaying = State.playbackState === PlaybackState.PLAYING;

                if (renderSignal.aborted) return;
                if (!State.workletNode) return;
                State.workletNode.port.postMessage({
                    type: 'audio-data',
                    data: workletChunk,
                    autoResume: isPlaying && !userPaused,
                });

                State.allReceivedData.push(workletChunk);
                totalSamplesSentToWorklet += size;

                // Start playback when buffer threshold reached
                if (!playbackTriggered && totalSamplesSentToWorklet >= BUFFER_THRESHOLD) {
                    playbackTriggered = true;
                    if (window.pm?.audio) console.log(`⚡ BUFFER THRESHOLD reached (${totalSamplesSentToWorklet.toLocaleString()} samples)`);

                    const isSharedSession = sessionStorage.getItem('isSharedSession') === 'true';
                    const autoPlayEnabled = !isSharedSession && document.getElementById('autoPlay')?.checked;

                    if (autoPlayEnabled && State.workletNode) {
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

        // Progressive memory cleanup
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
                const canvas = document.getElementById('minimap');
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
    // Renderer callbacks — attached to the download session
    // =========================================================================

    const rendererCallbacks = {
        /**
         * Called for each chunk (from replay or live download).
         * Feeds worklet, waveform worker, and progressive spectrogram.
         */
        onChunkReady: (i, normalized, raw) => {
            if (renderSignal.aborted) return;

            const chunk = chunkSchedule[i];
            const progress = `${i + 1}/${chunkSchedule.length}`;

            if (statusEl && !silentDownload) {
                statusEl.textContent = `Loading chunk ${progress} (${chunk.date} ${chunk.startTime})...`;
            }

            // Store for ordered worklet/waveform feeding
            processedChunks[i] = { samples: normalized, rawSamples: raw };
            chunksReceived++;

            // Feed to worklet (audio playback)
            sendChunksInOrder();

            // Feed to waveform worker (progressive waveform drawing)
            const renderMode = dataRenderingEl?.value || 'progressive';
            const allowMidStreamRender = renderMode === 'progressive' || (renderMode === 'triggered' && renderTriggered);
            if (allowMidStreamRender) sendToWaveformInOrder();

            // Progressive spectrogram render (throttled)
            const now = performance.now();
            const shouldRender = allowMidStreamRender && (now - lastRenderTime) >= RENDER_THROTTLE_MS;

            if (shouldRender) {
                lastRenderTime = now;
                const partialSamples = growProgressiveBuffer();
                const shouldDoMinimapFFT = (now - lastMinimapFFTTime) >= MINIMAP_FFT_THROTTLE_MS;
                if (shouldDoMinimapFFT) lastMinimapFFTTime = now;

                if (!spectrogramRenderInProgress && partialSamples) {
                    spectrogramRenderInProgress = true;
                    renderProgressiveSpectrogram(partialSamples, { skipMinimapFFT: !shouldDoMinimapFFT })
                        .catch(e => console.warn('Progressive spectrogram failed:', e))
                        .finally(() => { spectrogramRenderInProgress = false; });
                }
            }

            // Update download size display
            if (!silentDownload) {
                const downloadSizeEl = document.getElementById('downloadSize');
                if (downloadSizeEl) {
                    downloadSizeEl.textContent = `${(session.totalBytesDownloaded / 1024 / 1024).toFixed(2)} MB`;
                }
            }
        },

        /**
         * Called when all chunks are downloaded and processed.
         * Handles final render, memory cleanup, and UI updates.
         */
        onComplete: async () => {
            if (renderSignal.aborted) return;

            // Fallback playback trigger for short time ranges
            if (!playbackTriggered && totalSamplesSentToWorklet > 0) {
                playbackTriggered = true;
                if (window.pm?.data) console.log(`⚡ FALLBACK: All chunks received (${totalSamplesSentToWorklet.toLocaleString()} samples < threshold ${BUFFER_THRESHOLD}) — starting playback now`);

                const isSharedSession = sessionStorage.getItem('isSharedSession') === 'true';
                const autoPlayEnabled = !isSharedSession && document.getElementById('autoPlay')?.checked;

                if (autoPlayEnabled && State.workletNode) {
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

            // Wait for any in-progress spectrogram render
            if (spectrogramRenderInProgress) {
                await new Promise(resolve => {
                    const check = setInterval(() => {
                        if (!spectrogramRenderInProgress) { clearInterval(check); resolve(); }
                    }, 50);
                });
            }

            if (window.pm?.data) console.log(`🎨 [RENDER] All ${chunkSchedule.length} chunks processed`);

            // Calculate total from worklet data
            const totalWorkletSamples = State.allReceivedData.reduce((sum, c) => sum + c.length, 0);
            if (window.pm?.data) console.log(`📊 ${logTime()} Total worklet samples: ${totalWorkletSamples.toLocaleString()}`);

            // Update duration with actual sample count
            const originalSampleRate = State.currentMetadata?.original_sample_rate || playbackSamplesPerRealSecond;
            State.setTotalAudioDuration(totalWorkletSamples / originalSampleRate);
            const sampleCountEl2 = document.getElementById('sampleCount');
            if (sampleCountEl2) sampleCountEl2.textContent = totalWorkletSamples.toLocaleString();

            // Refine zoom with actual sample count
            zoomState.initialize(totalWorkletSamples);

            // Kill loading animation
            if (State.loadingInterval) {
                clearInterval(State.loadingInterval);
                State.setLoadingInterval(null);
            }

            // Signal data complete to worklet
            if (State.workletNode) {
                State.workletNode.port.postMessage({
                    type: 'data-complete',
                    totalSamples: totalWorkletSamples,
                    sampleRate: originalSampleRate,
                });
            }

            // Position waveform axis canvas
            positionMinimapAxisCanvas();
            const completeRenderMode = dataRenderingEl?.value || 'progressive';
            if (completeRenderMode !== 'triggered' || renderTriggered) {
                drawMinimapAxis();
            }

            // Use running buffer for completeSamplesArray
            growProgressiveBuffer();
            const stitched = progressiveSamplesBuffer
                ? progressiveSamplesBuffer.subarray(0, progressiveSamplesOffset)
                : new Float32Array(0);
            State.setCompleteSamplesArray(stitched);
            if (window.pm?.data) console.log(`📦 ${logTime()} completeSamplesArray ready: ${stitched.length.toLocaleString()} samples`);

            // Free allReceivedData and processedChunks
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
            progressiveSamplesBuffer = null;
            progressiveSamplesOffset = 0;
            progressiveBufferChunkIndex = 0;

            // Also free session processedChunks (no longer needed)
            for (let i = 0; i < session.processedChunks.length; i++) {
                if (session.processedChunks[i]) {
                    session.processedChunks[i].normalized = null;
                    session.processedChunks[i].raw = null;
                    session.processedChunks[i] = null;
                }
            }

            if (window.pm?.data) console.log(`🧹 ${logTime()} Memory cleaned up`);

            // Enable download button
            const downloadContainer = document.getElementById('downloadAudioContainer');
            if (downloadContainer) downloadContainer.style.display = 'flex';
            const downloadBtn = document.getElementById('downloadBtn');
            if (downloadBtn) downloadBtn.disabled = false;

            // Enable analysis button
            updateCompleteButtonState();

            // Final spectrogram render with complete data
            const finalRenderMode = dataRenderingEl?.value || 'progressive';
            if (finalRenderMode === 'triggered' && !renderTriggered) {
                await new Promise(resolve => {
                    window.triggerDataRender = () => { renderTriggered = true; resolve(); };
                });
            }
            delete window.triggerDataRender;

            // Send any unsent waveform chunks
            sendToWaveformInOrder();

            // Final waveform build with DC removal
            const canvas = document.getElementById('minimap');
            const removeDC = document.getElementById('removeDCOffset')?.checked || false;
            const slider = document.getElementById('waveformFilterSlider');
            const alpha = slider
                ? 0.95 + (parseInt(slider.value) / 100) * (0.9999 - 0.95)
                : 0.99;

            State.waveformWorker.postMessage({
                type: 'build-waveform',
                canvasWidth: canvas.offsetWidth * window.devicePixelRatio,
                canvasHeight: canvas.offsetHeight * window.devicePixelRatio,
                removeDC: removeDC,
                alpha: alpha,
                isComplete: true,
                totalExpectedSamples: totalWorkletSamples,
            });

            if (window.pm?.render) console.log(`🎨 ${logTime()} Final spectrogram render with complete data...`);
            await renderProgressiveSpectrogram(State.completeSamplesArray, { isComplete: true });

            // Update playback controls
            updatePlaybackSpeed();
            updatePlaybackDuration();

            // Stop fetch button pulse
            const startBtn = document.getElementById('startBtn');
            if (startBtn) startBtn.classList.add('fetched');

            State.setIsFetchingNewData(false);

            // Auto-apply de-trending if checkbox is checked (updates completeSamplesArray,
            // worklet buffer, and spectrogram so downloads and playback use de-trended data)
            console.log(`🎛️ Auto-detrend check: removeDC=${removeDC}, completeSamples=${State.getCompleteSamplesLength()}`);
            if (removeDC) {
                const { changeWaveformFilter } = await import('./minimap-window-renderer.js');
                console.log(`🎛️ Calling changeWaveformFilter() for auto-detrend...`);
                changeWaveformFilter();
                console.log(`🎛️ changeWaveformFilter() returned`);
            }

            if (window.pm?.data) console.log(`🎨 ${logTime()} Render pipeline complete!`);
        },
    };

    // =========================================================================
    // Attach renderer to session — replays cached chunks, streams the rest
    // =========================================================================

    await attachRendererToSession(session, rendererCallbacks);

    // If session is still running, wait for it to complete
    if (!session.done) {
        await session.promise;
    }

    } catch (e) {
        if (e.name === 'AbortError') {
            if (window.pm?.data) console.log('🎨 [RENDER] Aborted');
            return;
        }
        throw e;
    }
}
