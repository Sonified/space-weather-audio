/**
 * spectrogram-pyramid.js — Bottom-Up LOD Pyramid for Spectrogram Rendering
 * 
 * Architecture:
 *   L0 (base): 15-minute tiles at 1024 FFT columns each (0.88 sec/col)
 *   L1-L9: progressively coarser, built by averaging pairs from the level below
 *   Viewport render: pixel-perfect for extreme deep zoom (<15 min)
 * 
 * Only tiles near the viewport are kept in GPU memory.
 * Upper levels are built lazily as pairs complete.
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.webgpu.js';
import * as State from './audio-state.js';
import { zoomState } from './zoom-state.js';
import { SpectrogramWorkerPool } from './spectrogram-worker-pool.js';
import { SpectrogramGPUCompute } from './spectrogram-gpu-compute.js';
import { isStudyMode } from './master-modes.js';
import { getWebGPUDevice, isWebGPURenderer, queueGPUTextureSwap } from './spectrogram-three-renderer.js';

// ─── Compression stubs (BC4 removed — Three.js lacks RGTC format support) ──

export function setCompressionMode() {}
export function getCompressionMode() { return 'uint8'; }
export function isBC4Supported() { return false; }
export function detectBC4Support() {}

// ─── Uint8 Texture Helper ──────────────────────────────────────────────────

function createUint8MagnitudeTexture(data, width, height) {
    const tex = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.UnsignedByteType);
    // minFilter set by currentMinFilter — respects shader mode (box/nearest use Nearest, linear uses Linear)
    tex.minFilter = currentMinFilter;
    tex.magFilter = THREE.LinearFilter;  // Linear for magnification (zoom in) — looks smoother
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
}

// ─── Configuration ──────────────────────────────────────────────────────────

const TARGET_SAMPLES_PER_TILE = 9000;    // ~15 min of GOES at 10 Hz
let baseTileDurationSec = 15 * 60;       // current tile duration (set before initPyramid)
const TILE_COLS = 1024;                   // FFT columns per tile

/**
 * Compute and set the base tile duration.
 * @param {'adaptive'|number} mode - 'adaptive' or fixed duration in seconds
 * @param {number} dataDurationSec - total data duration
 * @param {number} totalSamples - total audio sample count
 */
export function setTileDuration(mode, dataDurationSec, totalSamples) {
    if (mode === 'adaptive') {
        const tileCount = Math.max(1, Math.round(totalSamples / TARGET_SAMPLES_PER_TILE));
        baseTileDurationSec = dataDurationSec / tileCount;
    } else {
        baseTileDurationSec = Number(mode);
    }
}

export function getBaseTileDuration() { return baseTileDurationSec; }

// Adaptive texture cache: scale with available device memory
function getMaxCachedTiles() {
    const mem = navigator.deviceMemory || 4; // GB (defaults to 4 if unsupported)
    if (mem <= 2) return 16;
    if (mem <= 4) return 32;
    return 64;
}

// ─── Pyramid Reduce Mode ─────────────────────────────────────────────────────
// 'average' — (v0 + v1) / 2  (default, smooth zoom-out)
// 'peak'    — Math.max(v0, v1) (preserves features that averaging hides)
let pyramidReduceMode = 'average';

export function setPyramidReduceMode(mode) { pyramidReduceMode = mode; }
export function getPyramidReduceMode() { return pyramidReduceMode; }

// ─── Pyramid State ──────────────────────────────────────────────────────────

let pyramidLevels = [];        // Array of levels, each an array of tile descriptors
let tileTextureCache = new Map(); // key -> { texture, lastUsed }
let workerPool = null;
let gpuCompute = null;
let computeBackend = null;  // 'gpu' | 'cpu'
let buildAbortController = null;
let pyramidReady = false;
let onTileReady = null;        // Callback when a tile becomes ready

// Tile key format: "L{level}:{index}"
function tileKey(level, index) {
    return `L${level}:${index}`;
}

// ─── Pyramid Structure ──────────────────────────────────────────────────────

/**
 * Initialize the pyramid structure for a given data duration.
 * Does NOT render anything — just sets up the tile grid.
 * 
 * @param {number} dataDurationSec - Total data duration in seconds
 * @param {number} sampleRate - playback_samples_per_real_second
 * @returns {number} Number of levels created
 */
export function initPyramid(dataDurationSec, sampleRate) {
    pyramidLevels = [];
    tileTextureCache.clear();
    pyramidReady = false;

    if (dataDurationSec <= 0) return 0;

    // Level 0: use current baseTileDurationSec (set by setTileDuration before this call)
    let tileDuration = baseTileDurationSec;
    let level = 0;

    while (true) {
        const tileCount = Math.ceil(dataDurationSec / tileDuration);
        const tiles = [];

        for (let i = 0; i < tileCount; i++) {
            const startSec = i * tileDuration;
            const endSec = Math.min((i + 1) * tileDuration, dataDurationSec);
            tiles.push({
                level,
                index: i,
                startSec,
                endSec,
                duration: endSec - startSec,
                magnitudeData: null,  // Float32Array: TILE_COLS × freqBins
                width: 0,
                height: 0,
                ready: false,
                rendering: false,
                // Actual FFT column center times (for precise UV mapping)
                actualFirstColSec: 0,
                actualLastColSec: 0,
            });
        }

        pyramidLevels.push(tiles);

        // Stop when we have a single tile covering everything
        if (tileCount <= 1) break;

        // Next level: double the duration
        tileDuration *= 2;
        level++;
    }

    const totalTiles = pyramidLevels.reduce((sum, lvl) => sum + lvl.length, 0);
    console.log(`🔺 Pyramid initialized: ${pyramidLevels.length} levels, ${totalTiles} total tiles, base=${baseTileDurationSec.toFixed(1)}s (${(baseTileDurationSec/60).toFixed(1)}min)`);
    for (let i = 0; i < pyramidLevels.length; i++) {
        const lvl = pyramidLevels[i];
        const dur = lvl[0]?.duration || 0;
        console.log(`   L${i}: ${lvl.length} tiles × ${(dur / 60).toFixed(1)}min = ${(dur / TILE_COLS).toFixed(2)}s/col`);
    }

    return pyramidLevels.length;
}

/**
 * Get the number of pyramid levels.
 */
export function getLevelCount() {
    return pyramidLevels.length;
}

/**
 * Get tile descriptors for a level.
 */
export function getTilesAtLevel(level) {
    return pyramidLevels[level] || [];
}

/**
 * Get a specific tile.
 */
export function getTile(level, index) {
    return pyramidLevels[level]?.[index] || null;
}

// ─── Level Picker ───────────────────────────────────────────────────────────

/**
 * Pick the optimal pyramid level for a given viewport.
 * Returns the finest level where tiles have ≥ 1 col per screen pixel.
 * 
 * @param {number} viewStartSec - Viewport start in seconds
 * @param {number} viewEndSec - Viewport end in seconds  
 * @param {number} canvasWidth - Canvas width in pixels
 * @returns {number} Optimal level index
 */
export function pickLevel(viewStartSec, viewEndSec, canvasWidth) {
    const viewDuration = viewEndSec - viewStartSec;
    if (viewDuration <= 0 || canvasWidth <= 0) return 0;

    // We want the finest level where total visible columns ≥ canvasWidth
    // (i.e., cols/pixel ≥ 1, so GPU downsamples rather than upsamples)
    for (let level = 0; level < pyramidLevels.length; level++) {
        const tiles = pyramidLevels[level];
        if (tiles.length === 0) continue;

        const tileDuration = tiles[0].duration;
        // How many tiles overlap this viewport?
        const tilesInView = viewDuration / tileDuration;
        // Total columns for those tiles
        const totalCols = tilesInView * TILE_COLS;
        // Cols per pixel
        const colsPerPixel = totalCols / canvasWidth;

        if (colsPerPixel < 1.0) {
            // This level is too coarse — use the previous (finer) level
            return Math.max(0, level - 1);
        }
    }

    // All levels have enough resolution — use the coarsest (top)
    return pyramidLevels.length - 1;
}

/**
 * Pick a continuous (fractional) pyramid level for crossfade blending.
 * Returns a float: integer part = coarser level, fractional part = blend position.
 * e.g., 2.6 means 40% L2 + 60% L3.
 */
export function pickContinuousLevel(viewStartSec, viewEndSec, canvasWidth) {
    const viewDuration = viewEndSec - viewStartSec;
    if (viewDuration <= 0 || canvasWidth <= 0) return 0;
    if (pyramidLevels.length === 0) return 0;

    const baseTileDuration = pyramidLevels[0][0]?.duration || baseTileDurationSec;
    const l0ColsPerPixel = (viewDuration / baseTileDuration) * TILE_COLS / canvasWidth;

    if (l0ColsPerPixel <= 1.0) return 0;

    const continuous = Math.log2(l0ColsPerPixel);
    return Math.min(continuous, pyramidLevels.length - 1);
}

/**
 * Get visible tiles at a given level for a viewport.
 * Returns only tiles that overlap [viewStartSec, viewEndSec].
 * World-space camera handles all viewport mapping — no UV or screen fraction math needed.
 *
 * @returns {Array<{tile, key}>}
 */
export function getVisibleTiles(level, viewStartSec, viewEndSec) {
    const tiles = pyramidLevels[level];
    if (!tiles || tiles.length === 0) return [];

    const visible = [];

    for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i];

        if (tile.endSec <= viewStartSec) continue;
        if (tile.startSec >= viewEndSec) continue;

        if (!tile.ready) continue;

        visible.push({
            tile,
            key: tileKey(level, i),
        });
    }

    return visible;
}

/**
 * Check if tiles at a given level fully cover the viewport.
 */
export function tilesReady(level, viewStartSec, viewEndSec) {
    const tiles = pyramidLevels[level];
    if (!tiles) return false;

    for (const tile of tiles) {
        // Does this tile overlap the viewport?
        if (tile.endSec <= viewStartSec || tile.startSec >= viewEndSec) continue;
        if (!tile.ready) return false;
    }
    return true;
}

// ─── Base Tile Rendering (L0) ───────────────────────────────────────────────

/**
 * Render base (L0) tiles from audio data.
 * Prioritizes tiles overlapping the current viewport.
 * 
 * @param {Float32Array} audioData - Complete audio samples (resampled)
 * @param {number} sampleRate - playback_samples_per_real_second
 * @param {number} fftSize - FFT window size
 * @param {number} viewCenterSec - Current viewport center for priority ordering
 * @param {Function} onProgress - Callback(tilesComplete, tilesTotal)
 */
export async function renderBaseTiles(audioData, sampleRate, fftSize, viewCenterSec = 0, onProgress = null) {
    const baseTiles = pyramidLevels[0];
    if (!baseTiles || baseTiles.length === 0) return;

    // Cancel any in-progress build
    if (buildAbortController) {
        buildAbortController.abort();
    }
    buildAbortController = new AbortController();
    const signal = buildAbortController.signal;

    // Initialize compute backend (GPU → WASM worker pool fallback)
    // Respects capability detection from main.js (window.__gpuCapability)
    if (!computeBackend) {
        const gpuCap = window.__gpuCapability;
        const gpuAllowed = gpuCap ? gpuCap.useGPU : true;  // default to trying GPU if no detection ran
        if (gpuAllowed && SpectrogramGPUCompute.isSupported()) {
            try {
                gpuCompute = new SpectrogramGPUCompute();
                // Share device with WebGPU renderer if available (enables zero-readback)
                const sharedDevice = getWebGPUDevice();
                await gpuCompute.initialize(sharedDevice);
                computeBackend = 'gpu';
            } catch (e) {
                console.warn('[Pyramid] WebGPU init failed, falling back to CPU workers:', e.message);
                gpuCompute = null;
                computeBackend = 'cpu';
            }
        } else {
            computeBackend = 'cpu';
        }
        if (computeBackend === 'cpu' && !workerPool) {
            workerPool = new SpectrogramWorkerPool();
            await workerPool.initialize();
        }
        const zeroCopy = computeBackend === 'gpu' && isWebGPURenderer();
        console.log(`[Pyramid] Compute backend: ${computeBackend === 'gpu' ? 'WebGPU' : `CPU worker pool (${workerPool?.numWorkers} workers)`}${zeroCopy ? ' (zero-readback)' : ''}`);
    }

    const halfFFT = Math.floor(fftSize / 2);

    // Pre-compute Hann window (shared across all tiles)
    const hannWindow = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
        hannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / fftSize));
    }

    // ── Prepare all tile descriptors up front ──
    const tileJobs = [];       // jobs to send to workers
    const tileMeta = new Map(); // tileIndex → { startSample, endSample, tileSamplesLength }
    let alreadyReady = 0;

    for (let tileIdx = 0; tileIdx < baseTiles.length; tileIdx++) {
        const tile = baseTiles[tileIdx];
        if (tile.ready) {
            alreadyReady++;
            continue;
        }

        tile.rendering = true;

        // Extract samples with fftSize/2 overlap on each side
        const startSample = Math.max(0, Math.floor(tile.startSec * sampleRate) - halfFFT);
        const endSample = Math.floor(tile.endSec * sampleRate) + halfFFT;

        let resampledStart, resampledEnd;
        if (zoomState.isInitialized() && zoomState.originalToResampledSample) {
            resampledStart = zoomState.originalToResampledSample(startSample);
            resampledEnd = zoomState.originalToResampledSample(endSample);
        } else {
            resampledStart = startSample;
            resampledEnd = endSample;
        }

        let tileSamples;
        if (audioData) {
            tileSamples = audioData.slice(
                Math.max(0, resampledStart),
                Math.min(audioData.length, resampledEnd)
            );
        } else {
            tileSamples = State.getCompleteSamplesSlice(
                Math.max(0, resampledStart),
                Math.min(State.getCompleteSamplesLength(), resampledEnd)
            );
        }

        if (tileSamples.length <= fftSize) {
            console.warn(`🔺 L0 tile ${tileIdx} too small for FFT (${tileSamples.length} samples)`);
            tile.rendering = false;
            alreadyReady++;
            continue;
        }

        const maxTimeSlices = TILE_COLS;
        // Float hop so columns span edge-to-edge across the nominal tile
        const nominalSamples = tileSamples.length - fftSize;
        const exactHop = Math.max(1, nominalSamples / (maxTimeSlices - 1));
        const numTimeSlices = maxTimeSlices;

        // Store metadata for when results come back
        tileMeta.set(tileIdx, {
            startSample,
            endSample,
            tileSamplesLength: tileSamples.length,
            exactHop,
            numTimeSlices,
        });

        // Hann window: copy per tile (transferred to worker, so each needs its own)
        tileJobs.push({
            audioData: tileSamples,
            fftSize,
            exactHop,
            numTimeSlices,
            hannWindow: new Float32Array(hannWindow),
            dbFloor: -100,
            dbRange: 100,
            tileIndex: tileIdx,
        });
    }

    if (tileJobs.length === 0) {
        pyramidReady = true;
        console.log(`🔺 All ${baseTiles.length} tiles already ready`);
        return;
    }

    const useZeroCopy = computeBackend === 'gpu' && isWebGPURenderer();
    const processor = computeBackend === 'gpu' ? gpuCompute : workerPool;
    const backendLabel = useZeroCopy ? 'GPU zero-copy' : (computeBackend === 'gpu' ? 'GPU' : `${workerPool?.numWorkers} workers`);
    console.log(`🔺 Dispatching ${tileJobs.length} tiles via ${backendLabel}`);
    const startTime = performance.now();
    let tilesComplete = alreadyReady;
    const totalTiles = baseTiles.length;

    // Helper: populate tile metadata from compute results
    function finalizeTileMeta(tileIdx, width, height) {
        const tile = baseTiles[tileIdx];
        const meta = tileMeta.get(tileIdx);
        tile.width = width;
        tile.height = height;
        const tileOriginSec = meta.startSample / sampleRate;
        const tileSpanSec = (meta.endSample - meta.startSample) / sampleRate;
        const secPerResampledSample = tileSpanSec / meta.tileSamplesLength;
        tile.actualFirstColSec = tileOriginSec + halfFFT * secPerResampledSample;
        tile.actualLastColSec = tileOriginSec + ((meta.numTimeSlices - 1) * meta.exactHop + halfFFT) * secPerResampledSample;
    }

    function reportProgress(tileIdx) {
        tilesComplete++;
        const step = Math.max(1, Math.floor(totalTiles / 10));
        if (tilesComplete % step === 0 || tilesComplete === totalTiles) {
            console.log(`🔺 Tiles: ${tilesComplete}/${totalTiles} (${((tilesComplete / totalTiles) * 100).toFixed(0)}%)`);
        }
        if (onProgress) onProgress(tilesComplete, totalTiles);
        if (onTileReady) onTileReady(0, tileIdx);
    }

    if (useZeroCopy) {
        // ── ZERO-READBACK PATH: GPU textures + GPU cascade (no CPU readback!) ──
        // Callbacks fire synchronously as batches are submitted.
        // Cascade builds via GPU render passes in onTileGPUTexture callback.
        const cascadeStartTime = performance.now();
        // Reset cascade timing accumulators
        for (const k in cascadeLevelTime) delete cascadeLevelTime[k];
        for (const k in cascadeLevelBuilt) delete cascadeLevelBuilt[k];
        gpuCompute.processTilesZeroCopy(tileJobs,
            (tileIdx, gpuTexture, width, height) => {
                const tile = baseTiles[tileIdx];
                finalizeTileMeta(tileIdx, width, height);
                tile.gpuTexture = gpuTexture;
                tile.ready = true;
                tile.rendering = false;
                reportProgress(tileIdx);
                // GPU cascade: build parent levels via render passes
                cascadeUpward(0, tileIdx);
            }, signal,
            // onBatchGPUDone: trigger re-render as each batch finishes on GPU
            // (tiles display progressively, just like the old CPU worker path)
            () => {
                if (!signal.aborted && onTileReady) onTileReady(-1, -1);
            });

        if (!signal.aborted) {
            pyramidReady = true;
            const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
            const cascadeMs = (performance.now() - cascadeStartTime).toFixed(1);
            const builtLevels = pyramidLevels.filter(lvl => lvl.some(t => t.ready)).length;
            console.log(`🔺 All ${tileJobs.length} base tiles + ${builtLevels} pyramid levels in ${elapsed}s (${backendLabel}, cascade: ${cascadeMs}ms)`);
        }
    } else {
        // ── STANDARD PATH: CPU readback, cascade inline ──
        await processor.processTiles(tileJobs, (tileIdx, magnitudeData, width, height) => {
            const tile = baseTiles[tileIdx];
            finalizeTileMeta(tileIdx, width, height);
            tile.magnitudeData = magnitudeData;
            tile.ready = true;
            tile.rendering = false;
            reportProgress(tileIdx);
            cascadeUpward(0, tileIdx);
        }, signal);

        if (!signal.aborted) {
            pyramidReady = true;
            const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
            console.log(`🔺 All ${tileJobs.length} base tiles rendered in ${elapsed}s (${backendLabel})`);
        }
    }
}

// ─── Pyramid Builder (Upward Cascade) ───────────────────────────────────────

/**
 * After a tile at `level` becomes ready, check if we can build the parent.
 * Dispatches to GPU render passes when available, falls back to CPU.
 */
function cascadeUpward(level, tileIndex) {
    // GPU path: build entire chain upward in one submission
    if (gpuCompute?.cascadePipeline) {
        cascadeUpwardGPU(level, tileIndex);
        return;
    }
    // CPU fallback
    cascadeUpwardCPU(level, tileIndex);
}

// Per-level timing accumulators for GPU cascade logging
const cascadeLevelTime = {};  // level → cumulative ms
const cascadeLevelBuilt = {}; // level → count of tiles built so far

/**
 * GPU cascade: build one parent via render pass, then recurse upward.
 * Each call is one render pass (microseconds). Recursion chains L1→L2→L3→...
 */
function cascadeUpwardGPU(level, tileIndex) {
    const nextLevel = level + 1;
    if (nextLevel >= pyramidLevels.length) return;

    const parentIndex = Math.floor(tileIndex / 2);
    const currentTiles = pyramidLevels[level];
    const parentTiles = pyramidLevels[nextLevel];

    if (!parentTiles[parentIndex]) return;
    if (parentTiles[parentIndex].ready) return;

    const child0 = currentTiles[parentIndex * 2];
    const child1 = currentTiles[parentIndex * 2 + 1];

    // Need child0 with gpuTexture
    if (!child0?.ready || !child0?.gpuTexture) return;
    // child1 might not exist (odd tile count)
    if (child1 && (!child1.ready || !child1.gpuTexture)) return;

    const freqBins = child0.height;
    const halfCols0 = Math.floor(child0.width / 2);
    const halfCols1 = child1 ? Math.floor(child1.width / 2) : 0;
    const parentWidth = halfCols0 + halfCols1;

    // Single render pass for this parent
    const t0 = performance.now();
    const [parentTex] = gpuCompute.buildCascadeChain([{
        child0Tex: child0.gpuTexture,
        child1Tex: child1?.gpuTexture || null,
        parentWidth,
        freqBins,
    }], pyramidReduceMode);
    const elapsed = performance.now() - t0;

    const parent = parentTiles[parentIndex];
    parent.gpuTexture = parentTex;
    parent.width = parentWidth;
    parent.height = freqBins;
    parent.actualFirstColSec = child0.actualFirstColSec;
    parent.actualLastColSec = (child1 || child0).actualLastColSec;
    parent.ready = true;

    // Track per-level timing, log when level completes
    cascadeLevelTime[nextLevel] = (cascadeLevelTime[nextLevel] || 0) + elapsed;
    cascadeLevelBuilt[nextLevel] = (cascadeLevelBuilt[nextLevel] || 0) + 1;
    const totalInLevel = parentTiles.length;
    const readyInLevel = cascadeLevelBuilt[nextLevel];
    if (readyInLevel >= totalInLevel) {
        console.log(`🔺 L${nextLevel} complete: ${totalInLevel} tiles, ${parent.width}×${freqBins}, ${cascadeLevelTime[nextLevel].toFixed(2)}ms`);
    }

    if (onTileReady) {
        onTileReady(nextLevel, parentIndex);
    }

    // Continue cascading upward
    cascadeUpwardGPU(nextLevel, parentIndex);
}

/**
 * CPU cascade fallback: original reduce logic using magnitudeData Uint8Arrays.
 */
function cascadeUpwardCPU(level, tileIndex) {
    const nextLevel = level + 1;
    if (nextLevel >= pyramidLevels.length) return;

    const parentIndex = Math.floor(tileIndex / 2);

    const currentTiles = pyramidLevels[level];
    const parentTiles = pyramidLevels[nextLevel];

    if (!parentTiles[parentIndex]) return;
    if (parentTiles[parentIndex].ready) return;

    const child0 = currentTiles[parentIndex * 2];
    const child1 = currentTiles[parentIndex * 2 + 1];

    if (!child0?.ready || !child0?.magnitudeData) return;
    if (child1 && (!child1.ready || !child1.magnitudeData)) return;

    const parent = parentTiles[parentIndex];
    const freqBins = child0.height;
    const reduce = pyramidReduceMode === 'peak'
        ? (a, b) => Math.max(a, b)
        : pyramidReduceMode === 'balanced'
        ? (a, b) => Math.round((Math.max(a, b) + (a + b) / 2) / 2)
        : (a, b) => Math.round((a + b) / 2);

    if (child1) {
        const halfCols = Math.floor(child0.width / 2);
        const halfCols1 = Math.floor(child1.width / 2);
        const parentCols = halfCols + halfCols1;
        const parentData = new Uint8Array(parentCols * freqBins);

        for (let col = 0; col < halfCols; col++) {
            const srcCol0 = col * 2;
            const srcCol1 = col * 2 + 1;
            for (let bin = 0; bin < freqBins; bin++) {
                const v0 = child0.magnitudeData[bin * child0.width + srcCol0];
                const v1 = srcCol1 < child0.width ? child0.magnitudeData[bin * child0.width + srcCol1] : v0;
                parentData[bin * parentCols + col] = reduce(v0, v1);
            }
        }

        for (let col = 0; col < halfCols1; col++) {
            const srcCol0 = col * 2;
            const srcCol1 = col * 2 + 1;
            const destCol = halfCols + col;
            for (let bin = 0; bin < freqBins; bin++) {
                const v0 = child1.magnitudeData[bin * child1.width + srcCol0];
                const v1 = srcCol1 < child1.width ? child1.magnitudeData[bin * child1.width + srcCol1] : v0;
                parentData[bin * parentCols + destCol] = reduce(v0, v1);
            }
        }

        parent.magnitudeData = parentData;
        parent.width = parentCols;
        parent.height = freqBins;
        parent.actualFirstColSec = child0.actualFirstColSec;
        parent.actualLastColSec = child1.actualLastColSec;
    } else {
        const halfCols = Math.floor(child0.width / 2);
        const parentData = new Uint8Array(halfCols * freqBins);

        for (let col = 0; col < halfCols; col++) {
            const srcCol0 = col * 2;
            const srcCol1 = col * 2 + 1;
            for (let bin = 0; bin < freqBins; bin++) {
                const v0 = child0.magnitudeData[bin * child0.width + srcCol0];
                const v1 = srcCol1 < child0.width ? child0.magnitudeData[bin * child0.width + srcCol1] : v0;
                parentData[bin * halfCols + col] = reduce(v0, v1);
            }
        }

        parent.magnitudeData = parentData;
        parent.width = halfCols;
        parent.height = freqBins;
        parent.actualFirstColSec = child0.actualFirstColSec;
        parent.actualLastColSec = child0.actualLastColSec;
    }

    parent.ready = true;

    console.log(`🔺 Built L${nextLevel} tile ${parentIndex}: ${parent.width} cols, ${(parent.duration / 60).toFixed(1)}min`);

    if (onTileReady) {
        onTileReady(nextLevel, parentIndex);
    }

    cascadeUpwardCPU(nextLevel, parentIndex);
}

// ─── Texture Management (LRU) ──────────────────────────────────────────────

/**
 * Get or create a GPU texture for a tile.
 * Uses LRU eviction when cache exceeds adaptive limit.
 * 
 * @param {object} tile - Tile descriptor
 * @param {string} key - Tile key
 * @param {Function} createTextureFn - Function(data, width, height) → THREE.DataTexture
 * @returns {THREE.DataTexture|null}
 */
export function getTileTexture(tile, key) {
    if (!tile.ready) return null;
    // Need either CPU data or GPU texture
    if (!tile.magnitudeData && !tile.gpuTexture) return null;

    let entry = tileTextureCache.get(key);
    if (entry) {
        entry.lastUsed = performance.now();
        return entry.texture;
    }

    // Evict if over limit
    if (tileTextureCache.size >= getMaxCachedTiles()) {
        evictLRU();
    }

    let texture;
    if (tile.gpuTexture && !tile.magnitudeData) {
        // Zero-readback path: create DataTexture shell with empty data.
        // The renderer will swap its internal GPU texture on the next frame.
        const shellData = new Uint8Array(tile.width * tile.height);
        texture = createUint8MagnitudeTexture(shellData, tile.width, tile.height);
        queueGPUTextureSwap(texture, tile.gpuTexture);
    } else {
        // Standard path: create texture from CPU data
        texture = createUint8MagnitudeTexture(tile.magnitudeData, tile.width, tile.height);
    }

    tileTextureCache.set(key, {
        texture,
        lastUsed: performance.now()
    });

    return texture;
}

function evictLRU() {
    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [key, entry] of tileTextureCache) {
        if (entry.lastUsed < oldestTime) {
            oldestTime = entry.lastUsed;
            oldestKey = key;
        }
    }

    if (oldestKey) {
        const entry = tileTextureCache.get(oldestKey);
        if (entry.texture?.dispose) entry.texture.dispose();
        tileTextureCache.delete(oldestKey);
    }
}

// ─── Texture Filter Update ──────────────────────────────────────────────────

let currentMinFilter = THREE.NearestFilter;  // tracks shader mode for new textures

/**
 * Update minFilter on all cached tile textures AND set default for new ones.
 */
export function updateAllTileTextureFilters(minFilter) {
    currentMinFilter = minFilter;
    for (const [, entry] of tileTextureCache) {
        if (entry.texture) {
            entry.texture.minFilter = minFilter;
            entry.texture.needsUpdate = true;
        }
    }
}

// ─── Event Hooks ────────────────────────────────────────────────────────────

/**
 * Set callback for when any tile becomes ready.
 * @param {Function} callback - (level, tileIndex) => void
 */
export function setOnTileReady(callback) {
    onTileReady = callback;
}

/**
 * Throttle worker pool: stop assigning new tiles during user interaction.
 * In-flight workers finish naturally, freeing CPU cores for smooth rendering.
 */
export function throttleWorkers() {
    if (gpuCompute) gpuCompute.throttle();
    if (workerPool) workerPool.throttle();
}

/**
 * Resume worker pool: kick idle workers back into tile processing.
 */
export function resumeWorkers() {
    if (gpuCompute) gpuCompute.resume();
    if (workerPool) workerPool.resume();
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

/**
 * Dispose all textures and reset state.
 */
export function disposePyramid() {
    if (buildAbortController) {
        buildAbortController.abort();
        buildAbortController = null;
    }

    for (const [key, entry] of tileTextureCache) {
        if (entry.texture?.dispose) entry.texture.dispose();
    }
    tileTextureCache.clear();

    // Free magnitude data and GPU textures
    for (const level of pyramidLevels) {
        for (const tile of level) {
            tile.magnitudeData = null;
            if (tile.gpuTexture?.destroy) {
                tile.gpuTexture.destroy();
                tile.gpuTexture = null;
            }
            tile.ready = false;
            tile.rendering = false;
        }
    }

    pyramidLevels = [];
    pyramidReady = false;

    // Release GPU compute resources
    if (gpuCompute) {
        gpuCompute.terminate();
        gpuCompute = null;
    }
    computeBackend = null;

    console.log('🔺 Pyramid disposed');
}

/**
 * Rebuild L1+ pyramid levels from existing L0 tiles.
 * Called when reduce mode changes (average ↔ peak) — avoids re-running FFT.
 * Uses GPU render passes when available, CPU fallback otherwise.
 */
export function rebuildUpperLevels() {
    if (pyramidLevels.length < 2) return;

    // 1. Clear L1+ tiles, their GPU textures, and cached Three.js textures
    for (let lvl = 1; lvl < pyramidLevels.length; lvl++) {
        for (let i = 0; i < pyramidLevels[lvl].length; i++) {
            const tile = pyramidLevels[lvl][i];
            tile.magnitudeData = null;
            if (tile.gpuTexture?.destroy) {
                tile.gpuTexture.destroy();
                tile.gpuTexture = null;
            }
            tile.ready = false;

            const key = tileKey(lvl, i);
            const cached = tileTextureCache.get(key);
            if (cached?.texture?.dispose) cached.texture.dispose();
            tileTextureCache.delete(key);
        }
    }

    // Reset cascade timing accumulators
    for (const k in cascadeLevelTime) delete cascadeLevelTime[k];
    for (const k in cascadeLevelBuilt) delete cascadeLevelBuilt[k];

    // 2. Re-cascade from all ready L0 tiles
    // Suppress onTileReady during rebuild — partial cascades would trigger
    // premature renders that see incomplete tiles and show black.
    const savedCallback = onTileReady;
    onTileReady = null;

    const l0 = pyramidLevels[0];
    for (let i = 0; i < l0.length; i++) {
        if (l0[i].ready) {
            cascadeUpward(0, i);
        }
    }

    onTileReady = savedCallback;
    console.log(`🔺 Rebuilt upper levels (mode: ${pyramidReduceMode})`);
}

/**
 * Free magnitude data for tiles far from viewport (keep textures in GPU).
 * Call periodically to reduce JS heap usage.
 */
export function trimMagnitudeData(viewStartSec, viewEndSec) {
    const keepPadding = baseTileDurationSec * 4; // Keep 4 tiles of padding

    for (const level of pyramidLevels) {
        for (const tile of level) {
            if (!tile.ready || !tile.magnitudeData) continue;
            // Keep if near viewport
            if (tile.endSec >= viewStartSec - keepPadding && tile.startSec <= viewEndSec + keepPadding) continue;
            // Keep if texture is cached (GPU has it)
            const key = tileKey(tile.level, tile.index);
            if (tileTextureCache.has(key)) {
                // GPU has the texture, safe to free JS-side data
                tile.magnitudeData = null;
            }
        }
    }
}

// ─── Debug / Status ─────────────────────────────────────────────────────────

export function getStatus() {
    const levels = pyramidLevels.map((tiles, i) => {
        const ready = tiles.filter(t => t.ready).length;
        return `L${i}: ${ready}/${tiles.length}`;
    });

    return {
        levels: levels.join(', '),
        cachedTextures: tileTextureCache.size,
        pyramidReady,
        totalLevels: pyramidLevels.length
    };
}

export { TILE_COLS };
