/**
 * spectrogram-three-renderer.js - THREE.JS GPU RENDERER
 * Replaces Canvas 2D spectrogram rendering with WebGPU via Three.js.
 * One quad, one shader, zero temp canvases.
 *
 * The fragment shader handles: FFT magnitude → dB → colormap lookup,
 * frequency scale mapping (linear/sqrt/log), viewport slicing, and
 * playback rate stretching — all in a single GPU pass.
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.webgpu.js';
import { texture as tslTexture, vec2, vec4, uniform, float, select, uv, log2 as tslLog2, pow as tslPow } from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.webgpu.js';

import * as State from './audio-state.js';
import { drawFrequencyAxis, positionAxisCanvas, initializeAxisPlaybackRate, getLogScaleMinFreq } from './spectrogram-axis-renderer.js';
import { SpectrogramWorkerPool } from './spectrogram-worker-pool.js';
import { zoomState } from './zoom-state.js';
import { getInterpolatedTimeRange, getZoomDirection, getZoomTransitionProgress, getOldTimeRange, isZoomTransitionInProgress, getRegionOpacityProgress } from './waveform-x-axis-renderer.js';
import { isStudyMode } from './master-modes.js';
import { getColorLUT } from './colormaps.js';
import { initPyramid, renderBaseTiles, pickLevel, pickContinuousLevel, getVisibleTiles as getPyramidVisibleTiles, getTileTexture, setOnTileReady, disposePyramid, tilesReady, TILE_COLS, detectBC4Support, setCompressionMode, getCompressionMode, isBC4Supported, throttleWorkers, resumeWorkers, updateAllTileTextureFilters, setPyramidReduceMode, setTileDuration, getBaseTileDuration, setSuppressPyramidReady } from './spectrogram-pyramid.js';
import { initScrollZoom } from './scroll-zoom.js';
import { uploadMainWaveformData, uploadWaveformSamples, drawWaveformFromMinMax, renderMainWaveform, hideMainWaveform, rebuildMainWaveformColormap, disposeMainWaveform } from './waveform-renderer.js';

// ─── Module state ───────────────────────────────────────────────────────────

let completeSpectrogramRendered = false;
let renderingInProgress = false;
let activeRenderRegionId = null;
let activeRenderAbortController = null;
let workerPool = null;

// Three.js objects
let threeRenderer = null;
let scene = null;
let camera = null;
let material = null;
let mesh = null;

// Textures
let fullMagnitudeTexture = null;     // Full-view FFT magnitudes
let regionMagnitudeTexture = null;   // Region FFT magnitudes (HQ)
let colormapTexture = null;

// Magnitude dimensions (data lives in texture.image.data — no duplicate refs)
let fullMagnitudeWidth = 0;
let fullMagnitudeHeight = 0;
let regionMagnitudeWidth = 0;
let regionMagnitudeHeight = 0;

// Track which texture the shader is currently using
let activeTexture = 'full'; // 'full' or 'region'

// Pyramid-only mode: full texture exists for mini-map but is never shown in main view
let pyramidOnlyMode = false;

// Actual time coverage (FFT column center times, in seconds from data start)
// Full texture:
let fullTextureFirstColSec = 0;
let fullTextureLastColSec = 0;
// Region texture (always set during renderCompleteSpectrogramForRegion):
let regionTextureActualStartSec = 0;
let regionTextureActualEndSec = 0;

// Render context tracking
let renderContext = {
    startSample: null,
    endSample: null,
    frequencyScale: null
};

// Smart render bounds for HQ region crossfade
let smartRenderBounds = {
    expandedStart: null,
    expandedEnd: null,
    targetStart: null,
    targetEnd: null,
    renderComplete: false
};

// Scroll-zoom hi-res viewport texture tracking (separate from region zoom)
let scrollZoomHiRes = {
    startSeconds: null,  // expanded render start (with padding)
    endSeconds: null,    // expanded render end (with padding)
    ready: false
};

// ─── TSL shared uniform nodes ────────────────────────────────────────────────
// Shared between main material + all 32 tile materials.
// Updating .value on these affects every material simultaneously.
let uStretchFactor = null;   // playback rate stretch
let uFreqScale = null;       // 0=linear, 1=sqrt, 2=log
let uMinFreq = null;
let uMaxFreq = null;
let uDbFloor = null;
let uDbRange = null;
let uBgR = null, uBgG = null, uBgB = null;  // background color components

// Per-material swappable texture node references
let mainMagTexNode = null;   // TextureNode for main spectrogram (swap via .value)
let cmapTexNode = null;      // TextureNode for main colormap (swap via .value)

// ─── GPU texture swap queue (Phase 2: zero-readback pipeline) ────────────────
// Tiles arrive as raw GPUTextures from compute. After Three.js creates its internal
// backend entry (first render), we swap the internal texture pointer to our GPUTexture.
let pendingGPUTextureSwaps = [];

/**
 * Get the WebGPU device from the Three.js renderer (shared with compute).
 * Returns null if renderer not initialized or not WebGPU.
 */
export function getWebGPUDevice() {
    return threeRenderer?.backend?.device || null;
}

/**
 * Check if the renderer is a WebGPU renderer with backend access.
 */
export function isWebGPURenderer() {
    return !!(threeRenderer?.backend?.device);
}

/**
 * Queue a GPU texture copy: after Three.js creates its internal GPUTexture from the
 * DataTexture shell, we copy our compute data into it via copyTextureToTexture.
 * No internal swapping — Three.js keeps its own texture, we just fill it with our data.
 */
export function queueGPUTextureSwap(threeTexture, gpuTexture) {
    pendingGPUTextureSwaps.push({ threeTexture, gpuTexture });
}

/**
 * Process pending GPU texture copies. Called after renderAsync() uploads shells.
 * Copies compute GPUTexture contents into Three.js's own GPUTexture via GPU copy.
 * Returns true if any copies were performed (caller should re-render).
 */
function processPendingGPUTextureSwaps() {
    if (pendingGPUTextureSwaps.length === 0 || !threeRenderer?.backend?.get) return false;

    const device = threeRenderer.backend.device;
    if (!device) return false;

    let copied = 0;
    const remaining = [];
    const encoder = device.createCommandEncoder({ label: 'gpu-texture-copy' });

    for (const swap of pendingGPUTextureSwaps) {
        const props = threeRenderer.backend.get(swap.threeTexture);
        if (props?.texture) {
            // GPU-to-GPU copy: our compute texture → Three.js's own texture.
            // Three.js keeps its bind groups, views, everything intact.
            const src = swap.gpuTexture;
            const dst = props.texture;
            const w = Math.min(src.width, dst.width);
            const h = Math.min(src.height, dst.height);
            encoder.copyTextureToTexture(
                { texture: src },
                { texture: dst },
                [w, h]
            );
            swap.threeTexture.needsUpdate = false;
            copied++;
        } else {
            // Not yet uploaded by Three.js — keep in queue for next frame
            remaining.push(swap);
        }
    }

    if (copied > 0) {
        device.queue.submit([encoder.finish()]);
        console.log(`%c[GPU Copy] ${copied} textures filled from compute GPUTextures`, 'color: #4CAF50');
    }

    pendingGPUTextureSwaps = remaining;
    return copied > 0;
}

// ─── Interaction throttle (defer tile-ready updates during zoom/pan) ─────────
let interactionActive = false;
let interactionSettleTimer = null;
let pendingTileUpdates = false;  // true if tiles arrived during interaction
const INTERACTION_SETTLE_MS = 150;

export function notifyInteractionStart() {
    interactionActive = true;
    throttleWorkers();
    if (interactionSettleTimer) {
        clearTimeout(interactionSettleTimer);
        interactionSettleTimer = null;
    }
}

export function notifyInteractionEnd() {
    // Debounce: wait for interaction to truly settle before flushing
    if (interactionSettleTimer) clearTimeout(interactionSettleTimer);
    interactionSettleTimer = setTimeout(() => {
        interactionActive = false;
        interactionSettleTimer = null;
        resumeWorkers();
        if (pendingTileUpdates) {
            pendingTileUpdates = false;
            updateSpectrogramViewportFromZoom();
            renderFrame();
        }
    }, INTERACTION_SETTLE_MS);
}

// ─── World-space positioning helper ──────────────────────────────────────────
// PlaneGeometry(2,2) spans [-1,1]. Scale + translate to cover [startX, endX] × [0, 1].
function positionMeshWorldSpace(targetMesh, startX, endX) {
    const width = endX - startX;
    const centerX = startX + width / 2;
    targetMesh.scale.set(width / 2, 0.5, 1);  // half-extents (geometry is 2 wide, 2 tall)
    targetMesh.position.set(centerX, 0.5, 0);  // center Y at 0.5 for [0,1] range
}

// ─── Tile rendering (pyramid LOD system) ─────────────────────────────────────
const TILE_CROSSFADE_MS = 0; // disabled — tiles appear instantly
let tileMeshes = [];            // Array of { mesh, material } — up to 32 slots for pyramid tiles
let tileReadyTimes = new Map(); // key -> performance.now() when tile became ready (for crossfade)
let lastDisplayedLevel = -1;    // Track which level was displayed last frame (for re-fade prevention)
let tileFadeRAF = null;         // Coalescing guard for tile fade-in animation RAF

// ─── Level transition (crossfade between pyramid levels) ─────────────────────
let levelTransitionMode = 'crossfade';  // 'stepped' | 'crossfade'
let crossfadePower = 1.0;             // 1=linear (trilinear), 2=S-curve, 4+=sharp

export function setLevelTransitionMode(mode) { levelTransitionMode = mode; }
export function setCrossfadePower(power) { crossfadePower = power; }

// Waveform (time series) — TSL mesh kept for scene structure, rendering done via WebGL overlay
let waveformMesh = null;
let waveformMaterial = null;

// Grey overlay for zoomed-out mode
let spectrogramOverlay = null;
let spectrogramOverlayResizeObserver = null;
const MAX_PLAYBACK_RATE = 15.0;

// WebGPU device loss handled via device.lost promise in initThreeScene

// Track frequency scale for zoomed cache validation
let cachedZoomedFrequencyScale = null;

// Memory monitoring
let memoryMonitorInterval = null;
let memoryBaseline = null;
let memoryHistory = [];
const MEMORY_HISTORY_SIZE = 20;

// ─── TSL shader builders ────────────────────────────────────────────────────
// WebGPURenderer requires TSL node materials — GLSL ShaderMaterial is not supported.
// These functions build node graphs for colorNode on MeshBasicNodeMaterial.

/**
 * Build frequency-remapped texV from screen UV.y.
 * Supports linear (0), sqrt (1), and logarithmic (2) frequency scales.
 * References the shared TSL uniform nodes (uStretchFactor, uFreqScale, etc.).
 */
function buildFreqRemapNodes() {
    const vuv = uv();
    const effectiveY = vuv.y.div(uStretchFactor);
    const freqRange = uMaxFreq.sub(uMinFreq);

    // Linear: freq = minFreq + y * range
    const texVLinear = uMinFreq.add(effectiveY.mul(freqRange))
        .div(uMaxFreq).clamp(0, 1);

    // Sqrt: freq = minFreq + y² * range
    const texVSqrt = uMinFreq.add(effectiveY.mul(effectiveY).mul(freqRange))
        .div(uMaxFreq).clamp(0, 1);

    // Log: freq = 10^(logMin + y * (logMax - logMin))
    const LOG2_10 = float(Math.log2(10));
    const logMin = tslLog2(uMinFreq.max(0.001)).div(LOG2_10);
    const logMax = tslLog2(uMaxFreq).div(LOG2_10);
    const logFreq = logMin.add(effectiveY.mul(logMax.sub(logMin)));
    const texVLog = tslPow(float(10.0), logFreq).div(uMaxFreq).clamp(0, 1);

    const texV = select(uFreqScale.lessThan(0.5), texVLinear,
                 select(uFreqScale.lessThan(1.5), texVSqrt, texVLog));

    return { texU: vuv.x, texV, effectiveY };
}

// ─── GLSL shaders removed — TSL node materials used instead ─────────────────
// Tile shader: built inline in initThreeScene (TSL MeshBasicNodeMaterial)
// Waveform shader: deferred to Phase 3 (TSL conversion)

// ─── Main window view mode ──────────────────────────────────────────────────

function getMainWindowMode() {
    const el = document.getElementById('mainWindowView');
    return el ? el.value : 'spectrogram';
}

// ─── Three.js initialization ────────────────────────────────────────────────

async function initThreeScene() {
    if (material) return; // Already initialized (renderer may persist across cleanup cycles)

    const canvas = document.getElementById('spectrogram');
    if (!canvas) {
        console.error('spectrogram-three-renderer: No #spectrogram canvas found');
        return;
    }

    const width = canvas.width;
    const height = canvas.height;

    // Reuse existing renderer if available, otherwise create new one
    if (!threeRenderer) {
        threeRenderer = new THREE.WebGPURenderer({
            canvas,
            antialias: false,
            alpha: false,
            preserveDrawingBuffer: true,
            // Request higher compute limits for shared device with GPU FFT compute
            // Stockham FFT needs two shared arrays for ping-pong: 2 × 4096 f32 = 32768 bytes
            requiredLimits: {
                maxComputeWorkgroupStorageSize: 32768,
                maxComputeWorkgroupSizeX: 256,
                maxComputeInvocationsPerWorkgroup: 256,
            }
        });
        await threeRenderer.init();
    }
    threeRenderer.setSize(width, height, false);

    // Detect BC4 support for pyramid tile compression
    detectBC4Support(threeRenderer);

    // Orthographic camera in world-space: X = seconds, Y = 0→1
    camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0, 10);
    camera.position.z = 1;

    scene = new THREE.Scene();
    colormapTexture = buildColormapTexture();

    // ─── Create shared TSL uniform nodes ─────────────────────────────
    uStretchFactor = uniform(1.0);
    uFreqScale = uniform(0.0);
    uMinFreq = uniform(0.1);
    uMaxFreq = uniform(50.0);
    uDbFloor = uniform(-100.0);
    uDbRange = uniform(100.0);
    uBgR = uniform(0.0);
    uBgG = uniform(0.0);
    uBgB = uniform(0.0);

    // ─── Main spectrogram material (Float32 → dB → colormap) ─────────
    material = new THREE.MeshBasicNodeMaterial();
    {
        const { texU, texV, effectiveY } = buildFreqRemapNodes();
        const magUV = vec2(texU, texV);

        const placeholderMag = new THREE.DataTexture(
            new Float32Array(1), 1, 1, THREE.RedFormat, THREE.FloatType
        );
        placeholderMag.needsUpdate = true;
        mainMagTexNode = tslTexture(placeholderMag, magUV);

        const LOG2_10 = float(Math.log2(10));
        const mag = mainMagTexNode.r;
        const db = tslLog2(mag.add(1e-10)).div(LOG2_10).mul(20.0);
        const normalized = db.sub(uDbFloor).div(uDbRange).clamp(0, 1);

        cmapTexNode = tslTexture(colormapTexture, vec2(normalized, float(0.5)));
        const bgColor = vec4(uBgR, uBgG, uBgB, 1.0);

        material.colorNode = select(
            effectiveY.greaterThan(1.0), bgColor,
            vec4(cmapTexNode.r, cmapTexNode.g, cmapTexNode.b, float(1.0))
        );
    }

    const geometry = new THREE.PlaneGeometry(2, 2);
    mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 0;
    scene.add(mesh);

    // ─── Waveform placeholder mesh (rendering done via WebGL overlay) ──────────
    waveformMaterial = new THREE.MeshBasicNodeMaterial();
    waveformMaterial.transparent = true;
    waveformMaterial.colorNode = vec4(0, 0, 0, 0);
    waveformMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), waveformMaterial);
    waveformMesh.renderOrder = 1;
    waveformMesh.visible = false;
    scene.add(waveformMesh);

    // ─── 32 tile meshes (Uint8 pre-normalized → colormap) ────────────
    tileMeshes = [];
    for (let i = 0; i < 32; i++) {
        const tileMat = new THREE.MeshBasicNodeMaterial();
        tileMat.transparent = true;

        const tileOpacity = uniform(1.0);
        const { texU: tTexU, texV: tTexV, effectiveY: tEffY } = buildFreqRemapNodes();
        const tileMagUV = vec2(tTexU, tTexV);

        const tilePlaceholder = new THREE.DataTexture(
            new Uint8Array(1), 1, 1, THREE.RedFormat, THREE.UnsignedByteType
        );
        tilePlaceholder.needsUpdate = true;
        const tileMagTex = tslTexture(tilePlaceholder, tileMagUV);

        // Uint8 tiles: R channel IS the normalized value → direct colormap
        const tileNormalized = tileMagTex.r;
        const tileCmapTex = tslTexture(colormapTexture, vec2(tileNormalized, float(0.5)));

        const tileBgColor = vec4(uBgR, uBgG, uBgB, tileOpacity);
        tileMat.colorNode = select(
            tEffY.greaterThan(1.0), tileBgColor,
            vec4(tileCmapTex.r, tileCmapTex.g, tileCmapTex.b, tileOpacity)
        );

        const tileGeom = new THREE.PlaneGeometry(2, 2);
        const tileMesh = new THREE.Mesh(tileGeom, tileMat);
        tileMesh.renderOrder = 0.5;
        tileMesh.visible = false;
        scene.add(tileMesh);

        tileMeshes.push({
            mesh: tileMesh,
            material: tileMat,
            tsl: {
                magTex: tileMagTex,      // .value to swap magnitude texture
                cmapTex: tileCmapTex,    // .value to swap colormap texture
                opacity: tileOpacity,    // .value to set opacity
            }
        });
    }

    // WebGPU device loss handler
    if (threeRenderer.backend?.device) {
        threeRenderer.backend.device.lost.then((info) => {
            console.warn(`WebGPU device lost: ${info.message} (reason: ${info.reason})`);
        });
    }

    console.log(`Three.js WebGPU spectrogram renderer initialized (${canvas.width}x${canvas.height})`);
}

function buildColormapTexture() {
    const lut = getColorLUT();
    if (!lut) return null;

    // getColorLUT() returns Uint8ClampedArray(256*3) — convert to RGBA (RGBFormat removed in Three.js r137)
    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
        data[i * 4]     = lut[i * 3];
        data[i * 4 + 1] = lut[i * 3 + 1];
        data[i * 4 + 2] = lut[i * 3 + 2];
        data[i * 4 + 3] = 255;
    }

    const tex = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
}

function rebuildColormapTexture() {
    if (colormapTexture) colormapTexture.dispose();
    colormapTexture = buildColormapTexture();

    // Swap on main material
    if (cmapTexNode) cmapTexNode.value = colormapTexture;

    // Swap on all tile materials
    for (const tm of tileMeshes) {
        if (tm.tsl?.cmapTex) tm.tsl.cmapTex.value = colormapTexture;
    }

    // Main window waveform overlay colormap
    rebuildMainWaveformColormap();
}

// ─── Helper: create magnitude texture from Float32Array ─────────────────────

function createMagnitudeTexture(data, width, height) {
    const tex = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.FloatType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
}

// ─── Helper: update shader uniforms for current state ───────────────────────

function updateFrequencyUniforms() {
    if (!uFreqScale) return;
    const originalSampleRate = State.currentMetadata?.original_sample_rate || 100;
    const originalNyquist = originalSampleRate / 2;
    const minFreq = getLogScaleMinFreq();

    uMaxFreq.value = originalNyquist;
    uMinFreq.value = minFreq;

    if (State.frequencyScale === 'logarithmic') uFreqScale.value = 2.0;
    else if (State.frequencyScale === 'sqrt') uFreqScale.value = 1.0;
    else uFreqScale.value = 0.0;

    const lut = getColorLUT();
    if (lut) {
        uBgR.value = lut[0] / 255;
        uBgG.value = lut[1] / 255;
        uBgB.value = lut[2] / 255;
    }
}

function calculateStretchFactor(playbackRate, frequencyScale) {
    if (frequencyScale === 'linear') {
        return playbackRate;
    } else if (frequencyScale === 'sqrt') {
        return Math.sqrt(playbackRate);
    } else if (frequencyScale === 'logarithmic') {
        const originalSampleRate = State.currentMetadata?.original_sample_rate || 100;
        const originalNyquist = originalSampleRate / 2;
        const minFreq = getLogScaleMinFreq();

        const logMin = Math.log10(minFreq);
        const logMax = Math.log10(originalNyquist);
        const logRange = logMax - logMin;

        const targetMaxFreq = originalNyquist / playbackRate;
        const logTargetMax = Math.log10(Math.max(targetMaxFreq, minFreq));
        const targetLogRange = logTargetMax - logMin;
        const fraction = targetLogRange / logRange;

        return 1 / fraction;
    }
    return playbackRate;
}

// ─── Resize renderer to match current canvas display size ───────────────────
export function resizeRendererToDisplaySize() {
    if (!threeRenderer) return;
    const canvas = document.getElementById('spectrogram');
    if (!canvas) return;
    const displayHeight = canvas.offsetHeight;
    const displayWidth = canvas.offsetWidth;
    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
        canvas.width = displayWidth;
        canvas.height = displayHeight;
        threeRenderer.setSize(displayWidth, displayHeight, false);
        renderFrame();
    }
}

// ─── Helper: render one frame ───────────────────────────────────────────────

let renderPending = false;

async function renderFrame() {
    if (!threeRenderer || !scene || !camera) return;
    if (renderPending) return;
    renderPending = true;

    try {
        const mode = getMainWindowMode();
        const showSpectrogram = (mode === 'spectrogram' || mode === 'both');

        if (!showSpectrogram) {
            if (mesh) mesh.visible = false;
            for (const tm of tileMeshes) tm.mesh.visible = false;
        } else {
            tryUseTiles(camera.left, camera.right);
        }

        // TSL waveform mesh always hidden (waveform rendered via WebGL overlay)
        if (waveformMesh) waveformMesh.visible = false;

        await threeRenderer.renderAsync(scene, camera);

        // Process GPU texture swaps (zero-readback pipeline)
        if (processPendingGPUTextureSwaps()) {
            await threeRenderer.renderAsync(scene, camera);
        }

        // Main window waveform overlay (WebGL, independent from WebGPU spectrogram)
        const showWaveform = (mode === 'timeSeries' || mode === 'both');
        if (showWaveform && State.dataStartTime && State.dataEndTime) {
            const dataDurationSec = (State.dataEndTime.getTime() - State.dataStartTime.getTime()) / 1000;
            if (dataDurationSec > 0) {
                const vpStart = Math.max(0, camera.left / dataDurationSec);
                const vpEnd = Math.min(1, camera.right / dataDurationSec);
                renderMainWaveform(vpStart, vpEnd, mode === 'both');
            }
        } else {
            hideMainWaveform();
        }
    } finally {
        renderPending = false;
    }
}

// ─── Waveform sample upload (for time series mode) ──────────────────────────

/**
 * Upload audio waveform samples for time series rendering.
 * Delegates to WebGL overlay in waveform-renderer.js (same shader as minimap).
 */
function uploadMainWaveformSamples(expectedTotalSamples = 0) {
    const samples = State.completeSamplesArray || State.getCompleteSamplesArray();
    if (!samples || samples.length === 0) return;
    uploadMainWaveformData(samples, expectedTotalSamples);
}

// ─── Diagnostic functions ───────────────────────────────────────────────────

export function getInfiniteCanvasStatus() {
    if (!fullMagnitudeTexture) return 'No magnitude texture';
    return `Three.js: ${fullMagnitudeWidth}x${fullMagnitudeHeight} magnitude texture, active=${activeTexture}`;
}

export function getCachedFullStatus() {
    return fullMagnitudeTexture ? `${fullMagnitudeWidth}x${fullMagnitudeHeight}` : 'null';
}

export function getCachedZoomedStatus() {
    return regionMagnitudeTexture ? `${regionMagnitudeWidth}x${regionMagnitudeHeight}` : 'null';
}

// ─── Memory monitoring (same as original) ───────────────────────────────────

function logMemory(label) {
    if (performance.memory) {
        const used = (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1);
        const total = (performance.memory.totalJSHeapSize / 1024 / 1024).toFixed(1);
        const limit = (performance.memory.jsHeapSizeLimit / 1024 / 1024).toFixed(1);
        const percent = ((performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit) * 100).toFixed(1);
        console.log(`\u{1F4BE} ${label}: ${used}MB / ${total}MB (limit: ${limit}MB, ${percent}% used)`);
    }
}

function memoryHealthCheck() {
    if (!performance.memory) return;
    const used = performance.memory.usedJSHeapSize / 1024 / 1024;
    const limit = performance.memory.jsHeapSizeLimit / 1024 / 1024;
    const percent = ((performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit) * 100).toFixed(1);

    if (memoryBaseline === null || used < memoryBaseline) {
        memoryBaseline = used;
    }

    memoryHistory.push({ time: Date.now(), used, percent: parseFloat(percent) });
    if (memoryHistory.length > MEMORY_HISTORY_SIZE) {
        memoryHistory.shift();
    }

    let trend = 'stable';
    if (memoryHistory.length >= 10) {
        const oldBaseline = Math.min(...memoryHistory.slice(0, 5).map(h => h.used));
        const newBaseline = Math.min(...memoryHistory.slice(-5).map(h => h.used));
        const growth = newBaseline - oldBaseline;
        if (growth > 200) {
            trend = 'increasing';
            console.warn(`Potential memory leak: Baseline grew ${growth.toFixed(0)}MB`);
        } else if (growth > 100) {
            trend = 'rising';
        }
    }

    const avgPercent = (memoryHistory.reduce((sum, h) => sum + h.percent, 0) / memoryHistory.length).toFixed(1);
    console.log(`🏥 Memory health: ${used.toFixed(0)}MB (${percent}%) | Baseline: ${memoryBaseline.toFixed(0)}MB | Avg: ${avgPercent}% | Limit: ${limit.toFixed(0)}MB | Trend: ${trend}`);
}

export function startMemoryMonitoring() {
    if (memoryMonitorInterval) return;
    console.log('Starting memory health monitoring (30s intervals, switching to 60s after 5 min)');
    const startTime = Date.now();
    const FIVE_MINUTES = 5 * 60 * 1000;
    memoryMonitorInterval = setInterval(() => {
        memoryHealthCheck();
        // After 5 minutes, switch from 30s to 60s interval
        if (Date.now() - startTime >= FIVE_MINUTES && memoryMonitorInterval) {
            clearInterval(memoryMonitorInterval);
            memoryMonitorInterval = setInterval(memoryHealthCheck, 60000);
            console.log('Memory monitoring: switching to 60s interval');
        }
    }, 30000);
    memoryHealthCheck();
}

export function stopMemoryMonitoring() {
    if (memoryMonitorInterval) {
        clearInterval(memoryMonitorInterval);
        memoryMonitorInterval = null;
        if (!isStudyMode()) {
            console.log('Stopped memory health monitoring');
        }
    }
    memoryBaseline = null;
    memoryHistory = [];
}

// ─── Core FFT → texture pipeline ────────────────────────────────────────────

/**
 * Run FFT workers and pack magnitudes into a Float32Array texture.
 * Returns { data: Float32Array, width: numTimeSlices, height: frequencyBinCount }
 */
async function computeFFTToTexture(audioData, fftSize, numTimeSlices, hopSize, signal) {
    const frequencyBinCount = fftSize / 2;

    // Pre-compute Hann window
    const hannWindow = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
        hannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / fftSize));
    }

    // Initialize worker pool
    if (!workerPool) {
        workerPool = new SpectrogramWorkerPool();
        await workerPool.initialize();
    }

    // Create batches
    const batchSize = 50;
    const batches = [];
    for (let batchStart = 0; batchStart < numTimeSlices; batchStart += batchSize) {
        const batchEnd = Math.min(batchStart + batchSize, numTimeSlices);
        batches.push({ start: batchStart, end: batchEnd });
    }

    // Allocate magnitude buffer: width=numTimeSlices, height=frequencyBinCount
    const magnitudeData = new Float32Array(numTimeSlices * frequencyBinCount);

    // Callback: pack magnitudes into texture buffer (no pixel loop!)
    // Texture layout: width=numTimeSlices (U=time), height=frequencyBinCount (V=frequency)
    // Row y=bin contains that frequency bin's magnitude across all time slices
    // So: data[bin * numTimeSlices + sliceIdx] = magnitude
    const drawResults = (results) => {
        for (const result of results) {
            const { sliceIdx, magnitudes } = result;
            for (let bin = 0; bin < frequencyBinCount; bin++) {
                magnitudeData[bin * numTimeSlices + sliceIdx] = magnitudes[bin];
            }
            result.magnitudes = null; // Free worker memory
        }
    };

    // Process all batches
    await workerPool.processBatches(
        audioData,
        batches,
        fftSize,
        hopSize,
        hannWindow,
        drawResults
    );

    if (signal && signal.aborted) return null;

    return {
        data: magnitudeData,
        width: numTimeSlices,
        height: frequencyBinCount
    };
}

// ─── Main render function: full view ────────────────────────────────────────

export async function renderCompleteSpectrogram(skipViewportUpdate = false, forceFullView = false) {
    if (!isStudyMode()) {
        console.groupCollapsed('[RENDER] Three.js Spectrogram');
        console.log('renderCompleteSpectrogram called:', { skipViewportUpdate, forceFullView });
    }

    if (State.getCompleteSamplesLength() === 0) {
        if (!isStudyMode()) {
            console.log('No audio data available');
            console.groupEnd();
        }
        return;
    }

    if (renderingInProgress) {
        if (!isStudyMode()) {
            console.log('Rendering already in progress');
            console.groupEnd();
        }
        return;
    }

    // If inside a region, render that instead (unless forceFullView)
    if (!forceFullView && zoomState.isInRegion()) {
        const regionRange = zoomState.getRegionRange();
        if (!isStudyMode()) console.groupEnd();
        const dataStartMs = State.dataStartTime ? State.dataStartTime.getTime() : 0;
        const startSeconds = (regionRange.startTime.getTime() - dataStartMs) / 1000;
        const endSeconds = (regionRange.endTime.getTime() - dataStartMs) / 1000;
        return await renderCompleteSpectrogramForRegion(startSeconds, endSeconds);
    }

    // Skip if already rendered (unless forcing full view)
    if (!forceFullView && completeSpectrogramRendered) {
        if (!isStudyMode()) {
            console.log('Already rendered');
            console.groupEnd();
        }
        return;
    }

    // Check if re-render needed
    const audioData = State.completeSamplesArray || State.getCompleteSamplesArray();
    const totalSamples = audioData ? audioData.length : 0;
    const needsRerender = fullMagnitudeTexture &&
        (renderContext.startSample !== 0 ||
         renderContext.endSample !== totalSamples ||
         renderContext.frequencyScale !== State.frequencyScale);

    if (needsRerender) {
        // Dispose old texture
        if (fullMagnitudeTexture) {
            fullMagnitudeTexture.dispose();
            fullMagnitudeTexture = null;
        }
    }

    renderingInProgress = true;
    logMemory('Before FFT computation');

    // Initialize Three.js scene if needed
    await initThreeScene();

    const canvas = threeRenderer?.domElement;
    if (!canvas) {
        console.error('Three.js renderer not initialized');
        renderingInProgress = false;
        if (!isStudyMode()) console.groupEnd();
        return;
    }

    const width = canvas.width;
    const height = canvas.height;

    try {
        const startTime = performance.now();
        const sampleRate = 44100;

        if (!isStudyMode()) {
            console.log(`Rendering spectrogram: ${totalSamples.toLocaleString()} samples (${(totalSamples / sampleRate).toFixed(2)}s)`);
        }

        const fftSize = State.fftSize || 2048;
        const renderOrderEl = document.getElementById('renderOrder');
        const pyramidOnly = renderOrderEl?.value === 'pyramid-only';
        pyramidOnlyMode = pyramidOnly;

        // Helper: compute full FFT texture and wire it up
        const computeFullFFT = async () => {
            const maxTimeSlices = width;
            const hopSize = Math.floor((totalSamples - fftSize) / maxTimeSlices);
            const numTimeSlices = Math.min(maxTimeSlices, Math.floor((totalSamples - fftSize) / hopSize));

            const result = await computeFFTToTexture(audioData, fftSize, numTimeSlices, hopSize);
            if (!result) return false;

            fullMagnitudeWidth = result.width;
            fullMagnitudeHeight = result.height;

            const sr = zoomState.sampleRate;
            fullTextureFirstColSec = (fftSize / 2) / sr;
            fullTextureLastColSec = ((numTimeSlices - 1) * hopSize + fftSize / 2) / sr;
            console.log(`🎯 [RENDER] fullTex: ${fullTextureFirstColSec.toFixed(3)}s → ${fullTextureLastColSec.toFixed(3)}s | sr: ${sr} | fft: ${fftSize} | hop: ${hopSize} | slices: ${numTimeSlices} | canvas: ${width}x${height} | totalSamples: ${totalSamples}`);

            if (fullMagnitudeTexture) fullMagnitudeTexture.dispose();
            fullMagnitudeTexture = createMagnitudeTexture(result.data, result.width, result.height);
            return true;
        };

        // Helper: initialize pyramid and start rendering base tiles
        const startPyramid = () => {
            const zoomOutEl = document.getElementById('mainWindowZoomOut');
            if (zoomOutEl) setPyramidReduceMode(zoomOutEl.value);
            const dataDurationSec = (State.dataEndTime.getTime() - State.dataStartTime.getTime()) / 1000;
            const pyramidSampleRate = zoomState.sampleRate;
            const chunkEl = document.getElementById('tileChunkSize');
            const chunkMode = chunkEl?.value || 'adaptive';
            setTileDuration(chunkMode === 'adaptive' ? 'adaptive' : parseInt(chunkMode), dataDurationSec, totalSamples);
            initPyramid(dataDurationSec, pyramidSampleRate);

            setOnTileReady((level, tileIndex) => {
                const key = `L${level}:${tileIndex}`;
                if (!tileReadyTimes.has(key)) tileReadyTimes.set(key, performance.now());
                if (interactionActive) {
                    pendingTileUpdates = true;
                    return;
                }
                updateSpectrogramViewportFromZoom();
                renderFrame();
            });

            const viewCenterSec = zoomState.isInitialized()
                ? ((zoomState.currentViewStartTime.getTime() + zoomState.currentViewEndTime.getTime()) / 2 - State.dataStartTime.getTime()) / 1000
                : dataDurationSec / 2;

            const tileStartTime = performance.now();
            renderBaseTiles(State.completeSamplesArray, pyramidSampleRate, fftSize, viewCenterSec, (done, total) => {
                if (done === total) {
                    const elapsed = ((performance.now() - tileStartTime) / 1000).toFixed(1);
                    console.log(`🔺 All ${total} base tiles rendered in ${elapsed}s`);
                    (window.requestIdleCallback || (cb => setTimeout(cb, 200)))(() => {
                        State.compressSamplesArray();
                    });
                }
            });
        };

        // Helper: finalize render state (axes, viewport, monitoring)
        const finalizeRender = () => {
            updateFrequencyUniforms();
            renderContext = {
                startSample: 0,
                endSample: totalSamples,
                frequencyScale: State.frequencyScale
            };

            completeSpectrogramRendered = true;
            State.setSpectrogramInitialized(true);
            uploadMainWaveformSamples();
            startMemoryMonitoring();
            positionAxisCanvas();
            initializeAxisPlaybackRate();
            drawFrequencyAxis();

            if (!skipViewportUpdate) {
                updateSpectrogramViewportFromZoom();
                createSpectrogramOverlay();
                const progress = getZoomTransitionProgress();
                updateSpectrogramOverlay(progress);
            }

            console.log(`🔎 [RENDER-STATE] camera: ${camera.left.toFixed(1)}→${camera.right.toFixed(1)} | mesh: ${mesh?.visible} pos=(${mesh?.position.x.toFixed(1)},${mesh?.scale.x.toFixed(1)}) | canvas: ${canvas.width}x${canvas.height} → ${canvas.offsetWidth}x${canvas.offsetHeight} | texture: ${activeTexture} ${fullMagnitudeTexture ? fullMagnitudeWidth+'x'+fullMagnitudeHeight : 'NONE'} | scene.children: ${scene?.children.length}`);
        };

        if (pyramidOnly) {
            // Pyramid-only: set time bounds, start pyramid first, then compute FFT for mini-map
            const sr = zoomState.sampleRate;
            const dataDurationSec = totalSamples / sr;
            fullTextureFirstColSec = 0;
            fullTextureLastColSec = dataDurationSec;
            if (mesh) mesh.visible = false;

            finalizeRender();
            startPyramid();

            console.log(`🔺 Pyramid-only mode: pyramid started, computing full FFT for mini-map...`);
            const elapsed = performance.now() - startTime;
            if (!isStudyMode()) {
                console.log(`Spectrogram (pyramid init) in ${elapsed.toFixed(0)}ms`);
            }

            // Compute full FFT in background for the mini-map
            computeFullFFT().then(ok => {
                if (ok) {
                    console.log(`🔺 Pyramid-only: mini-map FFT ready`);
                    window.dispatchEvent(new Event('spectrogram-ready'));
                }
            });
        } else {
            // All → Pyramid: compute full FFT first, show as backdrop, then start pyramid
            const ok = await computeFullFFT();
            if (!ok) {
                renderingInProgress = false;
                if (!isStudyMode()) console.groupEnd();
                return;
            }

            mainMagTexNode.value = fullMagnitudeTexture;
            activeTexture = 'full';
            if (mesh) {
                positionMeshWorldSpace(mesh, fullTextureFirstColSec, fullTextureLastColSec);
            }

            const elapsed = performance.now() - startTime;
            if (!isStudyMode()) {
                console.log(`Spectrogram rendered in ${elapsed.toFixed(0)}ms (Three.js GPU)`);
            }

            finalizeRender();
            window.dispatchEvent(new Event('spectrogram-ready'));
            startPyramid();
        }

    } catch (error) {
        console.error('Error rendering spectrogram:', error);
    } finally {
        renderingInProgress = false;
        if (!isStudyMode()) console.groupEnd();
    }
}

// ─── Hi-res full texture upgrade (background) ──────────────────────────────

let hiResAbortController = null;

/**
 * Re-render the full data range at higher resolution (4x canvas width) in the background.
 * When done, swaps the fullMagnitudeTexture so all UV-crop zooming is sharper.
 * Safe to call multiple times — cancels any in-progress upgrade.
 */
export async function upgradeFullTextureToHiRes(multiplier = 4) {
    if (State.getCompleteSamplesLength() === 0) return;
    if (!threeRenderer || !material) return;

    // Cancel any in-progress upgrade
    if (hiResAbortController) {
        hiResAbortController.abort();
        hiResAbortController = null;
    }

    hiResAbortController = new AbortController();
    const signal = hiResAbortController.signal;

    try {
        const audioData = State.completeSamplesArray || State.getCompleteSamplesArray();
        const totalSamples = audioData.length;
        const fftSize = State.fftSize || 2048;
        const canvas = threeRenderer.domElement;
        const baseWidth = canvas.width;
        const maxTimeSlices = baseWidth * multiplier;
        const hopSize = Math.max(1, Math.floor((totalSamples - fftSize) / maxTimeSlices));
        const numTimeSlices = Math.min(maxTimeSlices, Math.floor((totalSamples - fftSize) / hopSize));

        console.log(`🔬 Upgrading spectrogram to hi-res: ${numTimeSlices} columns (${multiplier}x)`);
        const startTime = performance.now();

        const result = await computeFFTToTexture(audioData, fftSize, numTimeSlices, hopSize, signal);
        if (!result || signal.aborted) {
            return;
        }

        // Replace full texture with hi-res version
        if (fullMagnitudeTexture) fullMagnitudeTexture.dispose();
        fullMagnitudeTexture = createMagnitudeTexture(result.data, result.width, result.height);
        fullMagnitudeWidth = result.width;
        fullMagnitudeHeight = result.height;

        // Update actual time coverage for the upgraded texture
        const sr = zoomState.sampleRate;
        fullTextureFirstColSec = (fftSize / 2) / sr;
        fullTextureLastColSec = ((numTimeSlices - 1) * hopSize + fftSize / 2) / sr;

        const elapsed = performance.now() - startTime;
        console.log(`🔬 Hi-res upgrade complete: ${numTimeSlices} columns in ${elapsed.toFixed(0)}ms`);

        // Reposition mesh for updated full texture coverage
        if (mesh) {
            positionMeshWorldSpace(mesh, fullTextureFirstColSec, fullTextureLastColSec);
        }

        // Only activate if the full texture is currently in use.
        if (activeTexture === 'full') {
            mainMagTexNode.value =fullMagnitudeTexture;
            renderFrame();
        }
    } catch (error) {
        if (!signal.aborted) {
            console.error('Error upgrading to hi-res texture:', error);
        }
    } finally {
        hiResAbortController = null;
    }
}

// Old tile rendering functions removed — replaced by pyramid LOD system in spectrogram-pyramid.js

/**
 * Check if pyramid tiles outresolve a region render for the given viewport.
 * Pyramid tiles at the optimal level provide TILE_COLS columns per tile duration.
 */
export function tilesOutresolveRegion(viewStartSec, viewEndSec) {
    const canvasWidth = threeRenderer?.domElement?.width || 1200;
    const optimalLevel = pickLevel(viewStartSec, viewEndSec, canvasWidth);
    if (!tilesReady(optimalLevel, viewStartSec, viewEndSec)) return false;

    // Region render produces ~canvasWidth columns for the viewport
    // Pyramid provides TILE_COLS cols per tile at this level
    const visibleTiles = getPyramidVisibleTiles(optimalLevel, viewStartSec, viewEndSec);
    if (visibleTiles.length === 0) return false;

    // Total pyramid columns visible vs region columns
    const totalPyramidCols = visibleTiles.length * TILE_COLS;
    return totalPyramidCols >= canvasWidth;
}

/**
 * Position tile meshes to cover their portion of the screen.
 * Each tile mesh is a 2×2 quad in NDC space (-1 to 1).
 * Scale and translate X to cover only the tile's screen fraction.
 * 
 * visibleTiles: array of { tile, key, blendFrac?, ceilTile?, ceilKey?, ceilUvStart?, ceilUvEnd? }
 */
function updateTileMeshPositions(visibleTiles) {
    let anyFading = false;
    const now = performance.now();

    for (let i = 0; i < tileMeshes.length; i++) {
        const tm = tileMeshes[i];
        if (i < visibleTiles.length) {
            const vt = visibleTiles[i];

            // Get texture from pyramid LRU cache (Uint8, no factory fn needed)
            const texture = getTileTexture(vt.tile, vt.key);
            if (!texture) {
                tm.mesh.visible = false;
                continue;
            }

            // Set tile magnitude texture via TSL node swap
            tm.tsl.magTex.value = texture;

            // Box filter + crossfade deferred to Phase 3 (uniforms not present in TSL material)

            // Tile fade-in opacity (time-based, for newly loaded tiles)
            const readyTime = tileReadyTimes.get(vt.key) || 0;
            const elapsed = now - readyTime;
            const fadeInOpacity = TILE_CROSSFADE_MS > 0 ? Math.min(1, elapsed / TILE_CROSSFADE_MS) : 1;
            tm.tsl.opacity.value = fadeInOpacity;
            if (fadeInOpacity < 1) anyFading = true;

            // Shared TSL uniform nodes — no per-tile sync needed

            positionMeshWorldSpace(tm.mesh, vt.tile.startSec, vt.tile.endSec);
            tm.mesh.visible = true;
        } else {
            tm.mesh.visible = false;
        }
    }

    // If any tile is still fading in, schedule another frame for opacity animation.
    // Note: crossfade between levels is driven by viewport changes (not time),
    // so it does NOT need a continuous rAF loop here.
    if (anyFading && !tileFadeRAF) {
        tileFadeRAF = requestAnimationFrame(() => {
            tileFadeRAF = null;
            updateTileMeshPositions(visibleTiles);
            renderFrame();
        });
    }
}

// ─── Region render (zoomed in, HQ) ─────────────────────────────────────────

export async function renderCompleteSpectrogramForRegion(startSeconds, endSeconds, renderInBackground = false, regionId = null, smartRenderOptions = null) {
    if (State.getCompleteSamplesLength() === 0) {
        console.log('No audio data for region render');
        return;
    }

    const useSmartRender = smartRenderOptions && smartRenderOptions.expandedStart !== undefined;

    // Cancel any previous render
    cancelActiveRender();
    activeRenderAbortController = new AbortController();
    activeRenderRegionId = regionId;
    renderingInProgress = true;
    const signal = activeRenderAbortController.signal;
    let renderSucceeded = false;

    await initThreeScene();
    const canvas = threeRenderer?.domElement;
    if (!canvas) {
        renderingInProgress = false;
        activeRenderAbortController = null;
        activeRenderRegionId = null;
        return;
    }

    const width = canvas.width;
    const height = canvas.height;

    // Sample rate for converting seconds to samples
    const originalSampleRate = zoomState.sampleRate;

    // Determine actual render bounds
    let renderStartSeconds, renderEndSeconds;
    if (useSmartRender) {
        renderStartSeconds = smartRenderOptions.expandedStart;
        renderEndSeconds = smartRenderOptions.expandedEnd;
    } else {
        renderStartSeconds = startSeconds;
        renderEndSeconds = endSeconds;
    }

    const startSample = Math.floor(renderStartSeconds * originalSampleRate);
    const endSample = Math.floor(renderEndSeconds * originalSampleRate);

    // Store smart render bounds
    if (useSmartRender) {
        smartRenderBounds = {
            expandedStart: renderStartSeconds,
            expandedEnd: renderEndSeconds,
            targetStart: startSeconds,
            targetEnd: endSeconds,
            renderComplete: false
        };
    }

    try {
        if (signal.aborted) {
            renderingInProgress = false;
            activeRenderAbortController = null;
            activeRenderRegionId = null;
            return;
        }

        const startTime = performance.now();

        // Extract region samples
        const resampledStartSample = zoomState.originalToResampledSample(startSample);
        const resampledEndSample = zoomState.originalToResampledSample(endSample);
        const regionSamples = State.completeSamplesArray 
            ? State.completeSamplesArray.slice(resampledStartSample, resampledEndSample)
            : State.getCompleteSamplesSlice(resampledStartSample, resampledEndSample);
        const totalSamples = regionSamples.length;

        const fftSize = State.fftSize || 2048;
        const frequencyBinCount = fftSize / 2;

        if (totalSamples <= fftSize) {
            console.warn('Region too small for FFT');
            renderingInProgress = false;
            activeRenderAbortController = null;
            activeRenderRegionId = null;
            return;
        }

        const maxTimeSlices = width;
        const hopSize = Math.max(1, Math.floor((totalSamples - fftSize) / maxTimeSlices));
        const numTimeSlices = Math.min(maxTimeSlices, Math.floor((totalSamples - fftSize) / hopSize));

        // Compute FFT
        const result = await computeFFTToTexture(regionSamples, fftSize, numTimeSlices, hopSize, signal);
        if (!result || signal.aborted) {
            // Only clean up singleton state if it still belongs to this render
            // (a newer render may have already claimed it)
            if (activeRenderRegionId === regionId) {
                renderingInProgress = false;
                activeRenderAbortController = null;
                activeRenderRegionId = null;
            }
            return;
        }

        regionMagnitudeWidth = result.width;
        regionMagnitudeHeight = result.height;

        // Store actual FFT column center times (always, for any region render)
        regionTextureActualStartSec = renderStartSeconds + (fftSize / 2) / originalSampleRate;
        regionTextureActualEndSec = renderStartSeconds + ((numTimeSlices - 1) * hopSize + fftSize / 2) / originalSampleRate;

        // Create region texture
        if (regionMagnitudeTexture) regionMagnitudeTexture.dispose();
        regionMagnitudeTexture = createMagnitudeTexture(result.data, result.width, result.height);
        renderSucceeded = true;

        // Mark smart render as complete
        smartRenderBounds.renderComplete = true;

        if (!renderInBackground) {
            // Switch to region texture for display
            mainMagTexNode.value =regionMagnitudeTexture;
            activeTexture = 'region';

            // Position region mesh in world space
            if (mesh) {
                positionMeshWorldSpace(mesh, regionTextureActualStartSec, regionTextureActualEndSec);
            }

            updateFrequencyUniforms();

            // Record context
            renderContext = {
                startSample: startSample,
                endSample: endSample,
                frequencyScale: State.frequencyScale
            };

            completeSpectrogramRendered = true;
            State.setSpectrogramInitialized(true);

            positionAxisCanvas();
            initializeAxisPlaybackRate();
            drawFrequencyAxis();

            updateSpectrogramViewport(State.currentPlaybackRate || 1.0);
        }

        const elapsed = performance.now() - startTime;
        if (!isStudyMode()) {
            console.log(`Region spectrogram rendered in ${elapsed.toFixed(0)}ms (Three.js GPU)${renderInBackground ? ' [background]' : ''}`);
        }

    } catch (error) {
        if (!signal.aborted) {
            console.error('Error rendering region spectrogram:', error);
        }
    } finally {
        if (activeRenderRegionId === regionId) {
            renderingInProgress = false;
        }
    }

    return renderSucceeded;
}

// ─── Viewport update (playback rate stretch) ────────────────────────────────

export function updateSpectrogramViewport(playbackRate) {
    // Block during zoom-out (drawInterpolatedSpectrogram handles it)
    if (isZoomTransitionInProgress() && !getZoomDirection()) {
        return;
    }

    if (!material || !threeRenderer) {
        if (!isStudyMode()) {
            console.log('updateSpectrogramViewport: Not initialized');
        }
        return;
    }

    // Update overlay
    updateSpectrogramOverlay();

    // Update stretch factor
    const stretchFactor = calculateStretchFactor(playbackRate, State.frequencyScale);
    uStretchFactor.value =stretchFactor;

    // Update frequency uniforms (in case scale changed)
    updateFrequencyUniforms();

    // Render
    renderFrame();
}

// ─── Zoom transition animation (per-frame) ─────────────────────────────────

export function drawInterpolatedSpectrogram() {
    if (!isZoomTransitionInProgress()) {
        window._drawInterpLastProgress = undefined;
        return;
    }

    if (!material || !threeRenderer) return;

    const currentProgress = getZoomTransitionProgress();

    // Skip duplicate frames
    if (window._drawInterpLastProgress !== undefined &&
        Math.abs(window._drawInterpLastProgress - currentProgress) < 0.0001) {
        return;
    }
    window._drawInterpLastProgress = currentProgress;

    // Get interpolated time range from the easing system
    const interpolatedRange = getInterpolatedTimeRange();
    if (!interpolatedRange || !State.dataStartTime || !State.dataEndTime) return;

    const dataStartMs = State.dataStartTime.getTime();
    const dataEndMs = State.dataEndTime.getTime();
    const dataDurationMs = dataEndMs - dataStartMs;
    if (dataDurationMs <= 0) return;

    const interpStartMs = interpolatedRange.startTime.getTime();
    const interpEndMs = interpolatedRange.endTime.getTime();

    const interpStartSec = (interpStartMs - dataStartMs) / 1000;
    const interpEndSec = (interpEndMs - dataStartMs) / 1000;

    // ─── World-space camera: move camera to interpolated viewport ───
    camera.left = interpStartSec;
    camera.right = interpEndSec;
    camera.updateProjectionMatrix();

    // Mid-animation swap: if zooming IN and the region texture is ready,
    // switch to it as soon as the interpolated viewport fits within the
    // expanded render bounds.
    const zoomingIn = getZoomDirection();
    const regionReady = zoomingIn && regionMagnitudeTexture
        && smartRenderBounds.renderComplete
        && smartRenderBounds.expandedStart !== null;

    if (regionReady) {
        const expandedStartSec = smartRenderBounds.expandedStart;
        const expandedEndSec = smartRenderBounds.expandedEnd;

        if (interpStartSec >= expandedStartSec && interpEndSec <= expandedEndSec) {
            // Switch to high-res region texture — position mesh at its world-space location
            if (activeTexture !== 'region') {
                mainMagTexNode.value =regionMagnitudeTexture;
                activeTexture = 'region';
            }
            if (mesh) {
                positionMeshWorldSpace(mesh, regionTextureActualStartSec, regionTextureActualEndSec);
                mesh.visible = true;
            }
            for (const tm of tileMeshes) tm.mesh.visible = false;
        } else {
            useInterpFallback(interpStartSec, interpEndSec);
        }
    } else {
        useInterpFallback(interpStartSec, interpEndSec);
    }

    // Update stretch + frequency (shared TSL uniforms — affects all materials)
    const playbackRate = State.currentPlaybackRate || 1.0;
    uStretchFactor.value = calculateStretchFactor(playbackRate, State.frequencyScale);
    updateFrequencyUniforms();

    // Update overlay
    updateSpectrogramOverlay();

    // One render call does everything
    renderFrame();
}

/**
 * Fallback for drawInterpolatedSpectrogram: try pyramid tiles, then full texture.
 */
function useInterpFallback(viewStartSec, viewEndSec) {
    // Delegate to tryUseTiles — same progressive tile logic
    tryUseTiles(viewStartSec, viewEndSec);
}

/**
 * Update spectrogram viewport from zoomState directly (no animation).
 * Used by scroll-to-zoom for instant viewport slicing.
 */
export function updateSpectrogramViewportFromZoom() {
    if (!material || !threeRenderer) return;
    if (!State.dataStartTime || !State.dataEndTime) return;

    const dataStartMs = State.dataStartTime.getTime();
    const dataEndMs = State.dataEndTime.getTime();
    const dataDurationMs = dataEndMs - dataStartMs;
    if (dataDurationMs <= 0) return;

    // Read current viewport from zoomState timestamps directly
    const viewStartMs = zoomState.isInitialized() ? zoomState.currentViewStartTime.getTime() : dataStartMs;
    const viewEndMs = zoomState.isInitialized() ? zoomState.currentViewEndTime.getTime() : dataEndMs;
    const viewStartSec = (viewStartMs - dataStartMs) / 1000;
    const viewEndSec = (viewEndMs - dataStartMs) / 1000;

    // ─── World-space camera: just move the camera ───
    camera.left = viewStartSec;
    camera.right = viewEndSec;
    camera.updateProjectionMatrix();

    // ─── Tile visibility + LOD selection ───
    const canvasWidth = threeRenderer.domElement.width;
    const tilesWin = tilesOutresolveRegion(viewStartSec, viewEndSec);

    if (!tilesWin && scrollZoomHiRes.ready && regionMagnitudeTexture && scrollZoomHiRes.startSeconds !== null) {
        const fitsInBounds = viewStartSec >= scrollZoomHiRes.startSeconds - 0.001
            && viewEndSec <= scrollZoomHiRes.endSeconds + 0.001;

        if (fitsInBounds) {
            // Use hi-res region texture — position its mesh in world space
            mainMagTexNode.value =regionMagnitudeTexture;
            activeTexture = 'region';
            if (mesh) {
                positionMeshWorldSpace(mesh, regionTextureActualStartSec, regionTextureActualEndSec);
                mesh.visible = true;
            }
            for (const tm of tileMeshes) tm.mesh.visible = false;
        } else {
            tryUseTiles(viewStartSec, viewEndSec);
        }
    } else {
        tryUseTiles(viewStartSec, viewEndSec);
    }

    // Update stretch + frequency (shared TSL uniforms — affects all materials)
    const playbackRate = State.currentPlaybackRate || 1.0;
    uStretchFactor.value = calculateStretchFactor(playbackRate, State.frequencyScale);
    updateFrequencyUniforms();

    // Hide the dimming overlay during scroll zoom
    if (spectrogramOverlay) {
        spectrogramOverlay.style.opacity = '0';
    }

    renderFrame();
}

/**
 * Try to use pyramid tiles for the viewport.
 *
 * Design: tiles (renderOrder 0.5) always render IN FRONT of the full texture
 * (renderOrder 0). The full texture is the blurry backdrop; tiles are the sharp
 * detail that progressively replaces it — like a progressive JPEG.
 *
 * - Full texture stays visible as backdrop until tiles fully cover the viewport.
 * - Tile level is chosen by walking down from the optimal level until we find
 *   one with ready tiles that fit our mesh pool (32 slots).
 * - renderFrame() never overrides these visibility decisions.
 */
function tryUseTiles(viewStartSec, viewEndSec) {
    const canvasWidth = threeRenderer?.domElement?.width || 1200;
    const maxSlots = tileMeshes.length; // 32

    let visibleTiles = [];
    let usedLevel = -1;
    let blendFrac = 0; // shader-level crossfade fraction

    if (levelTransitionMode === 'crossfade') {
        // ── Crossfade mode: floor-level tiles blend with ceil in shader ──
        const continuous = pickContinuousLevel(viewStartSec, viewEndSec, canvasWidth);
        const floorLevel = Math.floor(continuous);
        const ceilLevel = Math.min(floorLevel + 1, Math.ceil(continuous));
        const frac = continuous - floorLevel;

        // Normalized power curve: s = t^p / (t^p + (1-t)^p)
        if (frac < 0.001) {
            blendFrac = 0;
        } else if (frac > 0.999) {
            blendFrac = 1;
        } else {
            const tp = Math.pow(frac, crossfadePower);
            const tp1 = Math.pow(1 - frac, crossfadePower);
            blendFrac = tp / (tp + tp1);
        }

        // Use floor level's tile grid as the mesh basis
        const floorTiles = getPyramidVisibleTiles(floorLevel, viewStartSec, viewEndSec);
        // Get ceil tiles for matching (only if actually blending)
        const ceilTiles = (blendFrac > 0.001 && ceilLevel !== floorLevel)
            ? getPyramidVisibleTiles(ceilLevel, viewStartSec, viewEndSec) : [];

        if (floorTiles.length > 0 && floorTiles.length <= maxSlots) {
            // For each floor tile, find the matching ceil tile and compute UV remapping
            for (const vt of floorTiles) {
                vt.blendFrac = blendFrac;
                vt.ceilTile = null;
                vt.ceilKey = null;
                vt.ceilUvStart = 0;
                vt.ceilUvEnd = 1;

                if (blendFrac > 0.001) {
                    // Find the ceil tile whose time range contains this floor tile
                    for (const ct of ceilTiles) {
                        if (ct.tile.startSec <= vt.tile.startSec && ct.tile.endSec >= vt.tile.endSec) {
                            vt.ceilTile = ct.tile;
                            vt.ceilKey = ct.key;
                            // UV remapping: floor tile maps to a sub-region of ceil tile
                            const ceilDur = ct.tile.endSec - ct.tile.startSec;
                            vt.ceilUvStart = (vt.tile.startSec - ct.tile.startSec) / ceilDur;
                            vt.ceilUvEnd = (vt.tile.endSec - ct.tile.startSec) / ceilDur;
                            break;
                        }
                    }
                    // No matching ceil tile? Fall back to no blend for this tile
                    if (!vt.ceilTile) vt.blendFrac = 0;
                }
            }
            visibleTiles = floorTiles;
            usedLevel = floorLevel;

            // Stamp new tile keys with instant opacity (prevent re-fade)
            for (const vt of visibleTiles) {
                if (!tileReadyTimes.has(vt.key)) tileReadyTimes.set(vt.key, 0);
            }
        }
        // Fall through to stepped if floor tiles don't fit
    }

    if (visibleTiles.length === 0) {
        // ── Stepped mode (or crossfade fallback) ──
        const optimalLevel = pickLevel(viewStartSec, viewEndSec, canvasWidth);

        for (let level = 0; level <= optimalLevel; level++) {
            const tiles = getPyramidVisibleTiles(level, viewStartSec, viewEndSec);
            if (tiles.length > 0 && tiles.length <= maxSlots) {
                visibleTiles = tiles;
                usedLevel = level;
            }
        }

        // When displayed level changes, stamp new tile keys with instant opacity
        if (usedLevel >= 0 && usedLevel !== lastDisplayedLevel) {
            for (const vt of visibleTiles) {
                if (!tileReadyTimes.has(vt.key)) tileReadyTimes.set(vt.key, 0);
            }
        }
    }

    if (usedLevel >= 0) lastDisplayedLevel = usedLevel;

    // Place tile meshes at fixed world-space positions
    if (visibleTiles.length > 0) {
        if (activeTexture !== 'tiles') {
            for (const vt of visibleTiles) {
                if (!tileReadyTimes.has(vt.key)) tileReadyTimes.set(vt.key, 0);
            }
        }
        updateTileMeshPositions(visibleTiles);
    } else {
        for (const tm of tileMeshes) tm.mesh.visible = false;
    }

    // Full texture backdrop: visible unless tiles fully cover the viewport
    // or we're in pyramid-only mode (full texture reserved for mini-map only).
    const primaryLevel = usedLevel >= 0 ? usedLevel : -1;
    const tilesFullyCover = primaryLevel >= 0 && tilesReady(primaryLevel, viewStartSec, viewEndSec);

    if (tilesFullyCover || pyramidOnlyMode) {
        if (mesh) mesh.visible = false;
    } else if (fullMagnitudeTexture) {
        mainMagTexNode.value =fullMagnitudeTexture;
        if (mesh) {
            positionMeshWorldSpace(mesh, fullTextureFirstColSec, fullTextureLastColSec);
            mesh.visible = true;
        }
    } else {
        if (mesh) mesh.visible = false;
    }

    activeTexture = visibleTiles.length > 0 ? 'tiles' : 'full';
    return visibleTiles.length > 0;
}

/**
 * Mark the scroll-zoom hi-res viewport texture as ready with its bounds.
 * Called after renderCompleteSpectrogramForRegion completes in background.
 */
export function setScrollZoomHiRes(startSeconds, endSeconds) {
    scrollZoomHiRes = { startSeconds, endSeconds, ready: true };
}

/**
 * Clear scroll-zoom hi-res state (e.g. on FFT size change or mode switch).
 */
export function clearScrollZoomHiRes() {
    scrollZoomHiRes = { startSeconds: null, endSeconds: null, ready: false };
}

// ─── State management ───────────────────────────────────────────────────────

export function resetSpectrogramState() {
    completeSpectrogramRendered = false;
    renderingInProgress = false;
    State.setSpectrogramInitialized(false);

    renderContext = { startSample: null, endSample: null, frequencyScale: null };

    // Clear scroll-zoom hi-res state
    scrollZoomHiRes = { startSeconds: null, endSeconds: null, ready: false };

    // Don't dispose full texture during transitions — we need it
    // Dispose region texture
    if (regionMagnitudeTexture) {
        regionMagnitudeTexture.dispose();
        regionMagnitudeTexture = null;
    }
}

export function restoreInfiniteCanvasFromCache() {
    if (!fullMagnitudeTexture || !material) {
        console.warn('Cannot restore - no full magnitude texture');
        return;
    }

    // Switch back to full texture
    mainMagTexNode.value =fullMagnitudeTexture;
    activeTexture = 'full';

    // Restore full-texture world-space position
    if (mesh) {
        positionMeshWorldSpace(mesh, fullTextureFirstColSec, fullTextureLastColSec);
    }

    completeSpectrogramRendered = true;
    State.setSpectrogramInitialized(true);
}

export function clearCompleteSpectrogram() {
    if (!isStudyMode()) {
        console.groupCollapsed('[CLEANUP] Three.js Spectrogram');
    }

    logMemory('Before cleanup');

    // Dispose textures
    if (fullMagnitudeTexture) {
        fullMagnitudeTexture.dispose();
        fullMagnitudeTexture = null;
    }
    if (regionMagnitudeTexture) {
        regionMagnitudeTexture.dispose();
        regionMagnitudeTexture = null;
    }
    if (colormapTexture) {
        colormapTexture.dispose();
        colormapTexture = null;
    }

    // Dispose Three.js scene objects (geometry, material)
    if (mesh) {
        mesh.geometry.dispose();
        scene.remove(mesh);
        mesh = null;
    }
    if (material) {
        material.dispose();
        material = null;
    }

    // Null out TSL uniform/texture node references
    uStretchFactor = null;
    uFreqScale = null;
    uMinFreq = null;
    uMaxFreq = null;
    uDbFloor = null;
    uDbRange = null;
    uBgR = null; uBgG = null; uBgB = null;
    mainMagTexNode = null;
    cmapTexNode = null;

    // Dispose waveform mesh/material/textures
    if (waveformMesh) {
        waveformMesh.geometry.dispose();
        if (scene) scene.remove(waveformMesh);
        waveformMesh = null;
    }
    if (waveformMaterial) {
        waveformMaterial.dispose();
        waveformMaterial = null;
    }
    // Dispose main window waveform WebGL overlay
    disposeMainWaveform();

    // Dispose pyramid and tile meshes
    disposePyramid();
    tileReadyTimes.clear();
    lastDisplayedLevel = -1;
    for (const tm of tileMeshes) {
        tm.mesh.geometry.dispose();
        tm.material.dispose();
        if (scene) scene.remove(tm.mesh);
    }
    tileMeshes = [];

    // Clear the renderer (keep it alive — reused across loads)
    if (threeRenderer) {
        threeRenderer.clear();
    }

    // Disconnect overlay ResizeObserver and remove overlay DOM element
    if (spectrogramOverlayResizeObserver) {
        spectrogramOverlayResizeObserver.disconnect();
        spectrogramOverlayResizeObserver = null;
    }
    if (spectrogramOverlay) {
        spectrogramOverlay.remove();
        spectrogramOverlay = null;
    }

    // WebGPU device loss handled via device.lost promise in initThreeScene

    // Stop memory monitoring
    stopMemoryMonitoring();

    completeSpectrogramRendered = false;
    renderingInProgress = false;
    State.setSpectrogramInitialized(false);
    renderContext = { startSample: null, endSample: null, frequencyScale: null };

    // Terminate worker pool
    if (workerPool) {
        workerPool.terminate();
        workerPool = null;
    }

    if (typeof window !== 'undefined' && window.gc) {
        window.gc();
    }

    logMemory('After cleanup');
    if (!isStudyMode()) {
        console.log('Three.js spectrogram cleanup complete');
        console.groupEnd();
    }
}

export function isCompleteSpectrogramRendered() {
    return completeSpectrogramRendered;
}

export function getCachedSpectrogramCanvas() {
    // For backward compatibility — return the renderer's canvas
    return threeRenderer?.domElement || null;
}

// ─── Cache functions (simplified for Three.js) ─────────────────────────────

export function cacheFullSpectrogram() {
    // No-op: the full magnitude texture IS the cache
    if (fullMagnitudeTexture) {
        console.log('Full magnitude texture already cached');
    }
}

export function clearCachedFullSpectrogram() {
    // No-op during transitions — texture stays alive
}

export function cacheZoomedSpectrogram() {
    // Remember frequency scale for validation during zoom-out
    cachedZoomedFrequencyScale = State.frequencyScale;
    // The region texture (if available) serves as the cached zoomed version
}

export function clearCachedZoomedSpectrogram() {
    if (regionMagnitudeTexture) {
        regionMagnitudeTexture.dispose();
        regionMagnitudeTexture = null;
        // Region magnitude texture cleared
    }
}

export async function updateElasticFriendInBackground() {
    if (!isStudyMode()) {
        console.log(`Updating elastic friend in background with ${State.frequencyScale} scale...`);
    }
    const startTime = performance.now();

    // Save current active texture state
    const savedActiveTexture = activeTexture;
    const savedRegionTexture = regionMagnitudeTexture;

    try {
        // Render full view in background (skip viewport update, force full view)
        await renderCompleteSpectrogram(true, true);

        if (!isStudyMode()) {
            const elapsed = performance.now() - startTime;
            console.log(`Elastic friend updated in ${elapsed.toFixed(0)}ms`);
        }
    } catch (error) {
        console.error('Error updating elastic friend:', error);
    } finally {
        // Restore previous display if we were showing region or tiles
        if (savedActiveTexture === 'region' && savedRegionTexture && material) {
            mainMagTexNode.value =savedRegionTexture;
            activeTexture = 'region';
        } else if (savedActiveTexture === 'tiles') {
            activeTexture = 'tiles';
        }
    }
}

/**
 * Switch from full texture to region texture after background render completes.
 * Called when both the zoom animation and background region render are done.
 * Without this, the spectrogram stays on the low-res full texture forever.
 */
export function activateRegionTexture(playbackRate) {
    if (!regionMagnitudeTexture || !material) return;

    // Switch to high-res region texture
    mainMagTexNode.value =regionMagnitudeTexture;
    activeTexture = 'region';

    // Position mesh at region's world-space location
    if (mesh) {
        positionMeshWorldSpace(mesh, regionTextureActualStartSec, regionTextureActualEndSec);
    }

    updateFrequencyUniforms();

    const stretchFactor = calculateStretchFactor(playbackRate, State.frequencyScale);
    uStretchFactor.value =stretchFactor;

    updateSpectrogramOverlay();
    renderFrame();
}

export function clearSmartRenderBounds() {
    smartRenderBounds = {
        expandedStart: null,
        expandedEnd: null,
        targetStart: null,
        targetEnd: null,
        renderComplete: false
    };
}

// ─── Viewport snapshot (for crossfade transitions) ──────────────────────────

export function restoreViewportState() {
    if (material && threeRenderer) {
        const playbackRate = State.currentPlaybackRate || 1.0;
        updateSpectrogramViewport(playbackRate);
    }
}

export function getSpectrogramViewport(playbackRate) {
    // Phase 1: WebGLRenderTarget readback not available with WebGPU.
    // Zoom transitions use tile LOD system instead.
    console.warn('getSpectrogramViewport: WebGPU readback not yet implemented');
    return null;
}

// ─── Render control ─────────────────────────────────────────────────────────

export function cancelActiveRender() {
    if (activeRenderAbortController) {
        activeRenderAbortController.abort();
        activeRenderAbortController = null;
        activeRenderRegionId = null;
        renderingInProgress = false;
    }
}

export function shouldCancelActiveRender(newRegionId) {
    if (!activeRenderRegionId || !activeRenderAbortController) return false;
    return activeRenderRegionId !== newRegionId;
}

export function isRenderingInProgress() {
    return renderingInProgress;
}

export function isRegionRenderComplete(regionId) {
    if (!regionId) return smartRenderBounds.renderComplete;
    if (activeRenderRegionId !== regionId) return true;
    return false;
}

// ─── Overlay management ─────────────────────────────────────────────────────

function createSpectrogramOverlay() {
    return; // Overlay removed — no dimming needed

    const parent = canvas.parentElement;
    if (parent) {
        const canvasRect = canvas.getBoundingClientRect();
        const parentRect = parent.getBoundingClientRect();

        spectrogramOverlay.style.position = 'absolute';
        spectrogramOverlay.style.top = (canvasRect.top - parentRect.top) + 'px';
        spectrogramOverlay.style.left = (canvasRect.left - parentRect.left) + 'px';
        spectrogramOverlay.style.width = canvasRect.width + 'px';
        spectrogramOverlay.style.height = canvasRect.height + 'px';

        parent.appendChild(spectrogramOverlay);

        if (spectrogramOverlayResizeObserver) spectrogramOverlayResizeObserver.disconnect();
        let overlayResizeRAF = null;
        spectrogramOverlayResizeObserver = new ResizeObserver(() => {
            if (overlayResizeRAF) return; // coalesce into one RAF
            overlayResizeRAF = requestAnimationFrame(() => {
                overlayResizeRAF = null;
                if (spectrogramOverlay && canvas) {
                    const canvasRect = canvas.getBoundingClientRect();
                    const parentRect = parent.getBoundingClientRect();
                    spectrogramOverlay.style.top = (canvasRect.top - parentRect.top) + 'px';
                    spectrogramOverlay.style.left = (canvasRect.left - parentRect.left) + 'px';
                    spectrogramOverlay.style.width = canvasRect.width + 'px';
                    spectrogramOverlay.style.height = canvasRect.height + 'px';
                }
            });
        });
        spectrogramOverlayResizeObserver.observe(canvas);
    }
}

function updateSpectrogramOverlay(progress) {
    if (!spectrogramOverlay) {
        createSpectrogramOverlay();
    }
    if (!spectrogramOverlay) return;

    // In EMIC study mode, never dim the spectrogram
    if (window.__EMIC_STUDY_MODE) {
        spectrogramOverlay.style.opacity = '0';
        return;
    }

    // If zooming TO a region (including region-to-region), overlay should stay transparent.
    // The overlay only dims when zooming OUT from a region to full view.
    if (getZoomDirection() && isZoomTransitionInProgress()) {
        spectrogramOverlay.style.opacity = '0';
        return;
    }

    const opacityProgress = typeof progress === 'number' ? progress : getRegionOpacityProgress();
    const overlayOpacity = 1.0 - opacityProgress;
    spectrogramOverlay.style.opacity = overlayOpacity.toFixed(3);
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function startCompleteVisualization() {
    await new Promise(resolve => setTimeout(resolve, 100));

    if (State.getCompleteSamplesLength() === 0) {
        console.log('Cannot start visualization - no audio data');
        return;
    }

    console.log('Starting Three.js spectrogram visualization');
    await renderCompleteSpectrogram();
}

// ─── Progressive spectrogram rendering (Cloudflare streaming) ───────────────
//
// Purpose-built for progressive loading: call with growing audioData each chunk.
// First call initializes scene + pyramid structure (once).
// Every call recomputes minimap FFT + renders new tiles (additive).
// Standard path (renderCompleteSpectrogram) is completely untouched.

let progressiveInitDone = false;
let progressiveLastRenderedSamples = 0; // track to avoid reprocessing same data

/**
 * Render spectrogram progressively as audio data streams in.
 * Handles its own initialization — caller just passes growing audio buffer.
 *
 * @param {Float32Array} audioData - The growing audio buffer (all samples so far)
 * @param {Object} [opts]
 * @param {boolean} [opts.isComplete=false] - True on final call when all data is loaded
 */
export async function renderProgressiveSpectrogram(audioData, { isComplete = false, skipMinimapFFT = false } = {}) {
    if (!audioData || audioData.length === 0) return;

    const fftSize = State.fftSize || 2048;
    const totalSamples = audioData.length;

    // ── First call: initialize scene, pyramid, viewport (once) ──
    if (!progressiveInitDone) {
        await initThreeScene();
        if (!threeRenderer?.domElement) return;

        const dataDurationSec = (State.dataEndTime.getTime() - State.dataStartTime.getTime()) / 1000;
        const sr = zoomState.sampleRate;

        // Time bounds for the full data range (known before data arrives)
        fullTextureFirstColSec = 0;
        fullTextureLastColSec = dataDurationSec;
        pyramidOnlyMode = true;
        if (mesh) mesh.visible = false;

        // Frequency uniforms, render context, state flags
        updateFrequencyUniforms();
        const expectedSamples = State.currentMetadata?.playback_total_samples || totalSamples;
        renderContext = {
            startSample: 0,
            endSample: expectedSamples,
            frequencyScale: State.frequencyScale,
        };
        completeSpectrogramRendered = true;
        State.setSpectrogramInitialized(true);
        startMemoryMonitoring();

        // Initialize zoom with expected total samples BEFORE viewport setup
        // so "start at beginning" and other zoom preferences take effect immediately
        zoomState.initialize(expectedSamples);
        zoomState.applyInitialViewport();

        // Axes
        positionAxisCanvas();
        initializeAxisPlaybackRate();
        drawFrequencyAxis();

        // Viewport (now uses correct zoom state from above)
        updateSpectrogramViewportFromZoom();
        createSpectrogramOverlay();
        const progress = getZoomTransitionProgress();
        updateSpectrogramOverlay(progress);

        // Pyramid structure — ONCE (never wiped)
        const zoomOutEl = document.getElementById('mainWindowZoomOut');
        if (zoomOutEl) setPyramidReduceMode(zoomOutEl.value);
        const chunkEl = document.getElementById('tileChunkSize');
        const chunkMode = chunkEl?.value || 'adaptive';
        setTileDuration(chunkMode === 'adaptive' ? 'adaptive' : parseInt(chunkMode), dataDurationSec, expectedSamples);
        initPyramid(dataDurationSec, sr);

        setOnTileReady((level, tileIndex) => {
            const key = `L${level}:${tileIndex}`;
            if (!tileReadyTimes.has(key)) tileReadyTimes.set(key, performance.now());
            if (interactionActive) {
                pendingTileUpdates = true;
                return;
            }
            updateSpectrogramViewportFromZoom();
            renderFrame();
        });

        // Suppress pyramid-ready events during progressive loading
        // (feature boxes should only appear after all data is loaded)
        setSuppressPyramidReady(true);

        // Enable scroll-zoom interaction immediately (normally deferred until after await completes)
        initScrollZoom();

        progressiveInitDone = true;
        console.log(`🎨 [Progressive] Scene + pyramid initialized (${dataDurationSec.toFixed(0)}s, ${sr} sr)`);
    }

    // ── Every call: update minimap FFT, waveform, and pyramid tiles ──
    State.setCompleteSamplesArraySilent(audioData);

    const expectedTotalSamples = State.currentMetadata?.playback_total_samples || totalSamples;
    const sr = zoomState.sampleRate;
    const hasNewData = totalSamples > progressiveLastRenderedSamples;

    // Minimap FFT + waveform — only recompute when new data has arrived
    if (hasNewData && totalSamples > fftSize) {
        progressiveLastRenderedSamples = totalSamples;

        // Minimap FFT — expensive full rebuild, only run when caller allows it
        // (throttled separately from tile rendering — every ~5s vs every ~500ms)
        if (!skipMinimapFFT || isComplete) {
            const canvas = threeRenderer.domElement;
            const width = canvas.width;
            const maxTimeSlices = width;
            const hopSize = Math.max(1, Math.floor((expectedTotalSamples - fftSize) / maxTimeSlices));
            const numTimeSlices = Math.min(maxTimeSlices, Math.floor((totalSamples - fftSize) / hopSize));

            if (numTimeSlices > 0) {
                const result = await computeFFTToTexture(audioData, fftSize, numTimeSlices, hopSize);
                if (result) {
                    const freqBins = result.height;
                    const fullData = new Float32Array(maxTimeSlices * freqBins);
                    for (let bin = 0; bin < freqBins; bin++) {
                        const srcOffset = bin * result.width;
                        const dstOffset = bin * maxTimeSlices;
                        fullData.set(result.data.subarray(srcOffset, srcOffset + result.width), dstOffset);
                    }
                    fullMagnitudeWidth = maxTimeSlices;
                    fullMagnitudeHeight = freqBins;
                    if (fullMagnitudeTexture) fullMagnitudeTexture.dispose();
                    fullMagnitudeTexture = createMagnitudeTexture(fullData, maxTimeSlices, freqBins);
                }
            }
        }

        // Main window waveform overlay
        uploadMainWaveformSamples(expectedTotalSamples);

        // Minimap waveform GPU texture — must be uploaded so drawWaveformFromMinMax
        // uses the GPU path (not the fallback drawWaveform which overrides totalAudioDuration)
        uploadWaveformSamples(audioData, expectedTotalSamples);
        drawWaveformFromMinMax();
    }

    // Yield to browser between minimap work and tile rendering
    // This lets the event loop process scroll/click/playhead events
    await new Promise(r => setTimeout(r, 0));

    // Pyramid tiles — incremental (tile.ready flags preserved, only new tiles render)
    await renderBaseTiles(audioData, sr, fftSize, 0);
    renderFrame();

    // ── Completion extras ──
    if (isComplete) {
        setSuppressPyramidReady(false);
        window.dispatchEvent(new Event('spectrogram-ready'));
        window.dispatchEvent(new Event('pyramid-ready'));
        (window.requestIdleCallback || (cb => setTimeout(cb, 200)))(() => {
            State.compressSamplesArray();
        });
        console.log(`🎨 [Progressive] Complete — minimap FFT + waveform + tiles rendered`);
    }
}

/**
 * Reset progressive rendering state (called when starting a new data load).
 */
export function resetProgressiveSpectrogram() {
    progressiveInitDone = false;
    progressiveLastRenderedSamples = 0;
}

// ─── Minimap spectrogram access ─────────────────────────────────────────────

/**
 * Get the full-view magnitude texture for use in the minimap waveform renderer.
 * Returns { texture, width, height } or null if not yet computed.
 */
export function getFullMagnitudeTexture() {
    if (!fullMagnitudeTexture) return null;
    return { texture: fullMagnitudeTexture, width: fullMagnitudeWidth, height: fullMagnitudeHeight };
}

/**
 * Get current spectrogram rendering parameters for minimap use.
 */
export function getSpectrogramParams() {
    const originalSampleRate = State.currentMetadata?.original_sample_rate || 100;
    const originalNyquist = originalSampleRate / 2;
    const minFreq = getLogScaleMinFreq();
    let freqScaleInt = 0;
    if (State.frequencyScale === 'logarithmic') freqScaleInt = 2;
    else if (State.frequencyScale === 'sqrt') freqScaleInt = 1;
    return {
        maxFreq: originalNyquist,
        minFreq,
        frequencyScale: freqScaleInt,
        dbFloor: -100.0,
        dbRange: 100.0
    };
}

// ─── Colormap change support ────────────────────────────────────────────────

// ─── Tile Shader Mode Control ───────────────────────────────────────────────
// 'box' = NearestFilter + box filter shader (anti-shimmer, default)
// 'linear' = LinearFilter, no box filter (original GPU bilinear — shimmers)
// 'nearest' = NearestFilter, no box filter (raw pixels)

let tileShaderMode = 'box';

export function setTileShaderMode(mode) {
    if (mode !== 'box' && mode !== 'linear' && mode !== 'nearest') return;
    tileShaderMode = mode;
    // Update minFilter on all cached tile textures
    const filter = mode === 'linear' ? THREE.LinearFilter : THREE.NearestFilter;
    updateAllTileTextureFilters(filter);
    updateSpectrogramViewportFromZoom();
    renderFrame();
}

export function getTileShaderMode() {
    return tileShaderMode;
}


// ─── Tile Compression Control ───────────────────────────────────────────────

export function setTileCompression(mode) {
    setCompressionMode(mode);
    updateSpectrogramViewportFromZoom();
    renderFrame();
}

export function getTileCompression() {
    return getCompressionMode();
}

export function isTileBC4Supported() {
    return isBC4Supported();
}

/**
 * Aggressive cleanup for beforeunload — frees all GPU and audio memory.
 */
export function aggressiveCleanup() {
    disposePyramid();
    if (fullMagnitudeTexture) { fullMagnitudeTexture.dispose(); fullMagnitudeTexture = null; }
    if (regionMagnitudeTexture) { regionMagnitudeTexture.dispose(); regionMagnitudeTexture = null; }
    if (threeRenderer) { threeRenderer.dispose(); }
    State.setCompleteSamplesArray(null);
    State.setCompressedSamplesBuffer(null);
}

/**
 * Call this when the colormap changes to rebuild the LUT texture.
 */
export function onColormapChanged() {
    rebuildColormapTexture();
    if (material && threeRenderer) {
        renderFrame();
    }
}
