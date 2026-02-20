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

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';
import * as State from './audio-state.js';
import { zoomState } from './zoom-state.js';
import { SpectrogramWorkerPool } from './spectrogram-worker-pool.js';
import { isStudyMode } from './master-modes.js';

// ─── Compression stubs (BC4 removed — Three.js lacks RGTC format support) ──

export function setCompressionMode() {}
export function getCompressionMode() { return 'uint8'; }
export function isBC4Supported() { return false; }
export function detectBC4Support() {}

// ─── Uint8 Texture Helper ──────────────────────────────────────────────────

function createUint8MagnitudeTexture(data, width, height) {
    const tex = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false; // We handle LOD via pyramid levels
    tex.needsUpdate = true;
    return tex;
}

// ─── Configuration ──────────────────────────────────────────────────────────

const BASE_TILE_DURATION_SEC = 15 * 60;  // 15 minutes
const TILE_COLS = 1024;                   // FFT columns per tile

// Adaptive texture cache: scale with available device memory
function getMaxCachedTiles() {
    const mem = navigator.deviceMemory || 4; // GB (defaults to 4 if unsupported)
    if (mem <= 2) return 16;
    if (mem <= 4) return 32;
    return 64;
}

// ─── Pyramid State ──────────────────────────────────────────────────────────

let pyramidLevels = [];        // Array of levels, each an array of tile descriptors
let tileTextureCache = new Map(); // key -> { texture, lastUsed }
let workerPool = null;
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

    // Level 0: base tiles at BASE_TILE_DURATION_SEC
    let tileDuration = BASE_TILE_DURATION_SEC;
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
    console.log(`🔺 Pyramid initialized: ${pyramidLevels.length} levels, ${totalTiles} total tiles, base=${BASE_TILE_DURATION_SEC}s`);
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
 * Get visible tiles at a given level for a viewport.
 * Returns only tiles that overlap [viewStartSec, viewEndSec].
 * 
 * @returns {Array<{tile, uvStart, uvEnd, screenFracStart, screenFracEnd}>}
 */
export function getVisibleTiles(level, viewStartSec, viewEndSec) {
    const tiles = pyramidLevels[level];
    if (!tiles || tiles.length === 0) return [];

    const viewDuration = viewEndSec - viewStartSec;
    if (viewDuration <= 0) return [];

    const visible = [];

    for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i];

        if (tile.endSec <= viewStartSec) continue;
        if (tile.startSec >= viewEndSec) continue;

        if (!tile.ready) continue;

        // UV mapping using actual FFT column times
        const actualDuration = tile.actualLastColSec - tile.actualFirstColSec;
        if (actualDuration <= 0) continue;

        // UV: map nominal tile boundaries into the texture's actual column range.
        // Screen: use nominal boundaries so tiles are edge-to-edge with no gaps.
        const uvStart = (Math.max(viewStartSec, tile.startSec) - tile.actualFirstColSec) / actualDuration;
        const uvEnd = (Math.min(viewEndSec, tile.endSec) - tile.actualFirstColSec) / actualDuration;

        const screenFracStart = Math.max(0, (tile.startSec - viewStartSec) / viewDuration);
        const screenFracEnd = Math.min(1, (tile.endSec - viewStartSec) / viewDuration);

        visible.push({
            tile,
            key: tileKey(level, i),
            uvStart,
            uvEnd,
            screenFracStart,
            screenFracEnd,
        });
    }

    return visible.sort((a, b) => a.screenFracStart - b.screenFracStart);
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

    // Initialize worker pool
    if (!workerPool) {
        workerPool = new SpectrogramWorkerPool();
        await workerPool.initialize();
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
        const hopSize = Math.max(1, Math.floor((tileSamples.length - fftSize) / maxTimeSlices));
        const numTimeSlices = Math.min(maxTimeSlices, Math.floor((tileSamples.length - fftSize) / hopSize));

        // Store metadata for when results come back
        tileMeta.set(tileIdx, {
            startSample,
            endSample,
            tileSamplesLength: tileSamples.length,
            hopSize,
            numTimeSlices,
        });

        // Hann window: copy per tile (transferred to worker, so each needs its own)
        tileJobs.push({
            audioData: tileSamples,
            fftSize,
            hopSize,
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

    console.log(`🔺 Dispatching ${tileJobs.length} tiles to ${workerPool.numWorkers} workers in parallel`);
    const startTime = performance.now();
    let tilesComplete = alreadyReady;
    const totalTiles = baseTiles.length;

    // ── Fire all tiles in parallel via work-stealing pool ──
    await workerPool.processTiles(tileJobs, (tileIdx, magnitudeData, width, height) => {
        const tile = baseTiles[tileIdx];
        const meta = tileMeta.get(tileIdx);

        tile.magnitudeData = magnitudeData;
        tile.width = width;
        tile.height = height;

        // Map FFT column indices back to real time
        const tileOriginSec = meta.startSample / sampleRate;
        const tileSpanSec = (meta.endSample - meta.startSample) / sampleRate;
        const secPerResampledSample = tileSpanSec / meta.tileSamplesLength;
        tile.actualFirstColSec = tileOriginSec + halfFFT * secPerResampledSample;
        tile.actualLastColSec = tileOriginSec + ((meta.numTimeSlices - 1) * meta.hopSize + halfFFT) * secPerResampledSample;
        tile.ready = true;
        tile.rendering = false;
        tilesComplete++;

        // Log progress every 10%
        const step = Math.max(1, Math.floor(totalTiles / 10));
        if (tilesComplete % step === 0 || tilesComplete === totalTiles) {
            console.log(`🔺 Tiles: ${tilesComplete}/${totalTiles} (${((tilesComplete / totalTiles) * 100).toFixed(0)}%)`);
        }

        if (onProgress) {
            onProgress(tilesComplete, totalTiles);
        }

        if (onTileReady) {
            onTileReady(0, tileIdx);
        }

        cascadeUpward(0, tileIdx);
    }, signal);

    if (!signal.aborted) {
        pyramidReady = true;
        const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
        console.log(`🔺 All ${tileJobs.length} base tiles rendered in ${elapsed}s (${workerPool.numWorkers} workers)`);
    }
}

// ─── Pyramid Builder (Upward Cascade) ───────────────────────────────────────

/**
 * After a tile at `level` becomes ready, check if we can build the parent.
 * Parent at level+1 covers two adjacent tiles at level.
 */
function cascadeUpward(level, tileIndex) {
    const nextLevel = level + 1;
    if (nextLevel >= pyramidLevels.length) return;

    const parentIndex = Math.floor(tileIndex / 2);
    const siblingIndex = (tileIndex % 2 === 0) ? tileIndex + 1 : tileIndex - 1;

    const currentTiles = pyramidLevels[level];
    const parentTiles = pyramidLevels[nextLevel];

    if (!parentTiles[parentIndex]) return;
    if (parentTiles[parentIndex].ready) return; // Already built

    // Check if both children are ready
    const child0 = currentTiles[parentIndex * 2];
    const child1 = currentTiles[parentIndex * 2 + 1];

    if (!child0?.ready) return;
    // child1 might not exist (odd number of tiles at this level)
    if (child1 && !child1.ready) return;

    // Build parent by averaging children
    const parent = parentTiles[parentIndex];
    const freqBins = child0.height;

    if (child1) {
        // Average two tiles into one (Uint8)
        const halfCols = Math.floor(child0.width / 2);
        const halfCols1 = Math.floor(child1.width / 2);
        const parentCols = halfCols + halfCols1;
        const parentData = new Uint8Array(parentCols * freqBins);

        // Downsample child0: take pairs, average
        for (let col = 0; col < halfCols; col++) {
            const srcCol0 = col * 2;
            const srcCol1 = col * 2 + 1;
            for (let bin = 0; bin < freqBins; bin++) {
                const v0 = child0.magnitudeData[bin * child0.width + srcCol0];
                const v1 = srcCol1 < child0.width ? child0.magnitudeData[bin * child0.width + srcCol1] : v0;
                parentData[bin * parentCols + col] = Math.round((v0 + v1) / 2);
            }
        }

        // Downsample child1: take pairs, average
        for (let col = 0; col < halfCols1; col++) {
            const srcCol0 = col * 2;
            const srcCol1 = col * 2 + 1;
            const destCol = halfCols + col;
            for (let bin = 0; bin < freqBins; bin++) {
                const v0 = child1.magnitudeData[bin * child1.width + srcCol0];
                const v1 = srcCol1 < child1.width ? child1.magnitudeData[bin * child1.width + srcCol1] : v0;
                parentData[bin * parentCols + destCol] = Math.round((v0 + v1) / 2);
            }
        }

        parent.magnitudeData = parentData;
        parent.width = parentCols;
        parent.height = freqBins;
        parent.actualFirstColSec = child0.actualFirstColSec;
        parent.actualLastColSec = child1.actualLastColSec;
    } else {
        // Only one child (odd count) — just downsample it (Uint8)
        const halfCols = Math.floor(child0.width / 2);
        const parentData = new Uint8Array(halfCols * freqBins);

        for (let col = 0; col < halfCols; col++) {
            const srcCol0 = col * 2;
            const srcCol1 = col * 2 + 1;
            for (let bin = 0; bin < freqBins; bin++) {
                const v0 = child0.magnitudeData[bin * child0.width + srcCol0];
                const v1 = srcCol1 < child0.width ? child0.magnitudeData[bin * child0.width + srcCol1] : v0;
                parentData[bin * halfCols + col] = Math.round((v0 + v1) / 2);
            }
        }

        parent.magnitudeData = parentData;
        parent.width = halfCols;
        parent.height = freqBins;
        parent.actualFirstColSec = child0.actualFirstColSec;
        parent.actualLastColSec = child0.actualLastColSec;
    }

    parent.ready = true;

    if (!isStudyMode()) {
        console.log(`🔺 Built L${nextLevel} tile ${parentIndex}: ${parent.width} cols, ${(parent.duration / 60).toFixed(1)}min`);
    }

    if (onTileReady) {
        onTileReady(nextLevel, parentIndex);
    }

    // Continue cascading
    cascadeUpward(nextLevel, parentIndex);
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
    if (!tile.ready || !tile.magnitudeData) return null;

    let entry = tileTextureCache.get(key);
    if (entry) {
        entry.lastUsed = performance.now();
        return entry.texture;
    }

    // Evict if over limit
    if (tileTextureCache.size >= getMaxCachedTiles()) {
        evictLRU();
    }

    const texture = createUint8MagnitudeTexture(tile.magnitudeData, tile.width, tile.height);
    
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

// ─── Event Hooks ────────────────────────────────────────────────────────────

/**
 * Set callback for when any tile becomes ready.
 * @param {Function} callback - (level, tileIndex) => void
 */
export function setOnTileReady(callback) {
    onTileReady = callback;
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

    // Free magnitude data
    for (const level of pyramidLevels) {
        for (const tile of level) {
            tile.magnitudeData = null;
            tile.ready = false;
            tile.rendering = false;
        }
    }

    pyramidLevels = [];
    pyramidReady = false;
    console.log('🔺 Pyramid disposed');
}

/**
 * Free magnitude data for tiles far from viewport (keep textures in GPU).
 * Call periodically to reduce JS heap usage.
 */
export function trimMagnitudeData(viewStartSec, viewEndSec) {
    const keepPadding = BASE_TILE_DURATION_SEC * 4; // Keep 4 tiles of padding

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

export { TILE_COLS, BASE_TILE_DURATION_SEC };
