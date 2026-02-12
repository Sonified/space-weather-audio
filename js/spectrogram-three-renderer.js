/**
 * spectrogram-three-renderer.js - THREE.JS GPU RENDERER
 * Replaces Canvas 2D spectrogram rendering with WebGL via Three.js.
 * One quad, one shader, zero temp canvases.
 *
 * The fragment shader handles: FFT magnitude → dB → colormap lookup,
 * frequency scale mapping (linear/sqrt/log), viewport slicing, and
 * playback rate stretching — all in a single GPU pass.
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';

import * as State from './audio-state.js';
import { drawFrequencyAxis, positionAxisCanvas, initializeAxisPlaybackRate, getLogScaleMinFreq } from './spectrogram-axis-renderer.js';
import { SpectrogramWorkerPool } from './spectrogram-worker-pool.js';
import { zoomState } from './zoom-state.js';
import { getInterpolatedTimeRange, getZoomDirection, getZoomTransitionProgress, getOldTimeRange, isZoomTransitionInProgress, getRegionOpacityProgress } from './waveform-x-axis-renderer.js';
import { isStudyMode } from './master-modes.js';
import { getColorLUT } from './colormaps.js';

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

// Raw magnitude data (kept for texture rebuilds on colormap/scale changes)
let fullMagnitudeData = null;
let fullMagnitudeWidth = 0;
let fullMagnitudeHeight = 0;
let regionMagnitudeData = null;
let regionMagnitudeWidth = 0;
let regionMagnitudeHeight = 0;

// Track which texture the shader is currently using
let activeTexture = 'full'; // 'full' or 'region'

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

// Grey overlay for zoomed-out mode
let spectrogramOverlay = null;
let spectrogramOverlayResizeObserver = null;
const MAX_PLAYBACK_RATE = 15.0;

// WebGL context event handler refs (for removal)
let onContextLost = null;
let onContextRestored = null;

// Track frequency scale for zoomed cache validation
let cachedZoomedFrequencyScale = null;

// Memory monitoring
let memoryMonitorInterval = null;
let memoryBaseline = null;
let memoryHistory = [];
const MEMORY_HISTORY_SIZE = 20;

// ─── Shader source ──────────────────────────────────────────────────────────

const vertexShaderSource = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShaderSource = /* glsl */ `
uniform sampler2D uMagnitudes;
uniform sampler2D uColormap;
uniform float uViewportStart;
uniform float uViewportEnd;
uniform float uStretchFactor;
uniform int uFrequencyScale;
uniform float uMinFreq;
uniform float uMaxFreq;
uniform float uDbFloor;
uniform float uDbRange;
uniform vec3 uBackgroundColor;

varying vec2 vUv;

void main() {
    // Apply playback rate stretch: effectiveY maps screen position to frequency space
    float effectiveY = vUv.y / uStretchFactor;

    // If above content (stretchFactor < 1), show background padding
    if (effectiveY > 1.0) {
        gl_FragColor = vec4(uBackgroundColor, 1.0);
        return;
    }

    // Map screen Y through frequency scale to get texture V coordinate
    float freq;
    if (uFrequencyScale == 0) {
        // LINEAR: screen Y maps linearly from minFreq to maxFreq
        freq = uMinFreq + effectiveY * (uMaxFreq - uMinFreq);
    } else if (uFrequencyScale == 1) {
        // SQRT: screen Y = sqrt(normalized), so invert: normalized = Y^2
        float normalized = effectiveY * effectiveY;
        freq = uMinFreq + normalized * (uMaxFreq - uMinFreq);
    } else {
        // LOGARITHMIC: screen Y = (log(freq) - log(min)) / (log(max) - log(min))
        float logMin = log2(max(uMinFreq, 0.001)) / log2(10.0);
        float logMax = log2(uMaxFreq) / log2(10.0);
        float logFreq = logMin + effectiveY * (logMax - logMin);
        freq = pow(10.0, logFreq);
    }

    // Convert frequency to texture V coordinate (bin position)
    float texV = clamp(freq / uMaxFreq, 0.0, 1.0);

    // Map screen X through viewport to get texture U coordinate
    float texU = uViewportStart + vUv.x * (uViewportEnd - uViewportStart);

    // Sample magnitude from FFT texture
    float magnitude = texture2D(uMagnitudes, vec2(texU, texV)).r;

    // Convert to dB and normalize to [0, 1]
    float db = 20.0 * log(magnitude + 1.0e-10) / log(10.0);
    float normalized = clamp((db - uDbFloor) / uDbRange, 0.0, 1.0);

    // Look up color from colormap LUT texture
    vec3 color = texture2D(uColormap, vec2(normalized, 0.5)).rgb;

    gl_FragColor = vec4(color, 1.0);
}
`;

// ─── Three.js initialization ────────────────────────────────────────────────

function initThreeScene() {
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
        threeRenderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true });
    }
    threeRenderer.setSize(width, height, false);

    // Orthographic camera: maps [-1,1] to canvas
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
    camera.position.z = 1;

    scene = new THREE.Scene();

    // Build colormap texture
    colormapTexture = buildColormapTexture();

    // Create shader material with default uniforms
    material = new THREE.ShaderMaterial({
        uniforms: {
            uMagnitudes: { value: null },
            uColormap: { value: colormapTexture },
            uViewportStart: { value: 0.0 },
            uViewportEnd: { value: 1.0 },
            uStretchFactor: { value: 1.0 },
            uFrequencyScale: { value: 0 }, // 0=linear, 1=sqrt, 2=log
            uMinFreq: { value: 0.1 },
            uMaxFreq: { value: 50.0 },
            uDbFloor: { value: -100.0 },
            uDbRange: { value: 100.0 },
            uBackgroundColor: { value: new THREE.Vector3(0, 0, 0) }
        },
        vertexShader: vertexShaderSource,
        fragmentShader: fragmentShaderSource
    });

    // Full-screen quad
    const geometry = new THREE.PlaneGeometry(2, 2);
    mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    // WebGL context loss/restore handlers (Chromium can drop contexts under GPU pressure)
    // Remove previous handlers if any (defensive against double-init)
    if (onContextLost) canvas.removeEventListener('webglcontextlost', onContextLost);
    if (onContextRestored) canvas.removeEventListener('webglcontextrestored', onContextRestored);

    onContextLost = (e) => {
        e.preventDefault();
        console.warn('Spectrogram WebGL context lost — will restore on next render');
    };
    onContextRestored = () => {
        console.log('Spectrogram WebGL context restored — re-uploading textures');
        rebuildColormapTexture();
        if (fullMagnitudeTexture) fullMagnitudeTexture.needsUpdate = true;
        if (regionMagnitudeTexture) regionMagnitudeTexture.needsUpdate = true;
    };
    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);

    console.log(`Three.js spectrogram renderer initialized (${width}x${height})`);
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
    if (colormapTexture) {
        colormapTexture.dispose();
    }
    colormapTexture = buildColormapTexture();
    if (material) {
        material.uniforms.uColormap.value = colormapTexture;
    }
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
    if (!material) return;

    const originalSampleRate = State.currentMetadata?.original_sample_rate || 100;
    const originalNyquist = originalSampleRate / 2;
    const minFreq = getLogScaleMinFreq();

    material.uniforms.uMaxFreq.value = originalNyquist;
    material.uniforms.uMinFreq.value = minFreq;

    if (State.frequencyScale === 'logarithmic') {
        material.uniforms.uFrequencyScale.value = 2;
    } else if (State.frequencyScale === 'sqrt') {
        material.uniforms.uFrequencyScale.value = 1;
    } else {
        material.uniforms.uFrequencyScale.value = 0;
    }

    // Background color from colormap floor
    const lut = getColorLUT();
    if (lut) {
        material.uniforms.uBackgroundColor.value.set(lut[0] / 255, lut[1] / 255, lut[2] / 255);
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

// ─── Helper: render one frame ───────────────────────────────────────────────

function renderFrame() {
    if (!threeRenderer || !scene || !camera) return;
    threeRenderer.render(scene, camera);
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
        if (!isStudyMode()) {
            console.log(`\u{1F4BE} ${label}: ${used}MB / ${total}MB (limit: ${limit}MB, ${percent}% used)`);
        }
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

    if (!isStudyMode()) {
        const avgPercent = (memoryHistory.reduce((sum, h) => sum + h.percent, 0) / memoryHistory.length).toFixed(1);
        console.log(`Memory health: ${used.toFixed(0)}MB (${percent}%) | Baseline: ${memoryBaseline.toFixed(0)}MB | Avg: ${avgPercent}% | Limit: ${limit.toFixed(0)}MB | Trend: ${trend}`);
    }
}

export function startMemoryMonitoring() {
    if (memoryMonitorInterval) return;
    if (!isStudyMode()) {
        console.log('Starting memory health monitoring (every 10 seconds)');
    }
    memoryMonitorInterval = setInterval(memoryHealthCheck, 10000);
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

    if (!State.completeSamplesArray || State.completeSamplesArray.length === 0) {
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
    const audioData = State.completeSamplesArray;
    const totalSamples = audioData.length;
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
    initThreeScene();

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
        const maxTimeSlices = width;
        const hopSize = Math.floor((totalSamples - fftSize) / maxTimeSlices);
        const numTimeSlices = Math.min(maxTimeSlices, Math.floor((totalSamples - fftSize) / hopSize));

        // Compute FFT and pack into magnitude texture
        const result = await computeFFTToTexture(audioData, fftSize, numTimeSlices, hopSize);
        if (!result) {
            renderingInProgress = false;
            if (!isStudyMode()) console.groupEnd();
            return;
        }

        // Store raw data for later texture rebuilds
        fullMagnitudeData = result.data;
        fullMagnitudeWidth = result.width;
        fullMagnitudeHeight = result.height;

        // Create GPU texture
        if (fullMagnitudeTexture) fullMagnitudeTexture.dispose();
        fullMagnitudeTexture = createMagnitudeTexture(result.data, result.width, result.height);

        // Set as active texture
        material.uniforms.uMagnitudes.value = fullMagnitudeTexture;
        activeTexture = 'full';

        // Update frequency-related uniforms
        updateFrequencyUniforms();

        // Set viewport to full view
        material.uniforms.uViewportStart.value = 0.0;
        material.uniforms.uViewportEnd.value = 1.0;

        // Record context
        renderContext = {
            startSample: 0,
            endSample: totalSamples,
            frequencyScale: State.frequencyScale
        };

        const elapsed = performance.now() - startTime;
        if (!isStudyMode()) {
            console.log(`Spectrogram rendered in ${elapsed.toFixed(0)}ms (Three.js GPU)`);
        }

        completeSpectrogramRendered = true;
        State.setSpectrogramInitialized(true);

        // Restart memory monitoring (stopped during cleanup)
        startMemoryMonitoring();

        // Draw frequency axis
        positionAxisCanvas();
        initializeAxisPlaybackRate();
        drawFrequencyAxis();

        // Update display
        if (!skipViewportUpdate) {
            updateSpectrogramViewport(State.currentPlaybackRate || 1.0);
            createSpectrogramOverlay();
            const progress = getZoomTransitionProgress();
            updateSpectrogramOverlay(progress);
        }

    } catch (error) {
        console.error('Error rendering spectrogram:', error);
    } finally {
        renderingInProgress = false;
        if (!isStudyMode()) console.groupEnd();
    }
}

// ─── Region render (zoomed in, HQ) ─────────────────────────────────────────

export async function renderCompleteSpectrogramForRegion(startSeconds, endSeconds, renderInBackground = false, regionId = null, smartRenderOptions = null) {
    if (!State.completeSamplesArray || State.completeSamplesArray.length === 0) {
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

    initThreeScene();
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
        const regionSamples = State.completeSamplesArray.slice(resampledStartSample, resampledEndSample);
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
            renderingInProgress = false;
            activeRenderAbortController = null;
            activeRenderRegionId = null;
            return;
        }

        // Store region magnitude data
        regionMagnitudeData = result.data;
        regionMagnitudeWidth = result.width;
        regionMagnitudeHeight = result.height;

        // Create region texture
        if (regionMagnitudeTexture) regionMagnitudeTexture.dispose();
        regionMagnitudeTexture = createMagnitudeTexture(result.data, result.width, result.height);

        // Mark smart render as complete
        smartRenderBounds.renderComplete = true;

        if (!renderInBackground) {
            // Switch to region texture for display
            material.uniforms.uMagnitudes.value = regionMagnitudeTexture;
            activeTexture = 'region';

            // Region data fills the full viewport
            material.uniforms.uViewportStart.value = 0.0;
            material.uniforms.uViewportEnd.value = 1.0;

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
    material.uniforms.uStretchFactor.value = stretchFactor;

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

    // Mid-animation swap: if zooming IN and the region texture is ready,
    // switch to it as soon as the interpolated viewport fits within the
    // expanded render bounds. The expanded texture (2-3x region width)
    // was designed exactly for this — coverage during the transition.
    const zoomingIn = getZoomDirection();
    const regionReady = zoomingIn && regionMagnitudeTexture
        && smartRenderBounds.renderComplete
        && smartRenderBounds.expandedStart !== null;

    if (regionReady) {
        const expandedStartMs = dataStartMs + smartRenderBounds.expandedStart * 1000;
        const expandedEndMs = dataStartMs + smartRenderBounds.expandedEnd * 1000;
        const expandedDurationMs = expandedEndMs - expandedStartMs;

        // Check if current interpolated viewport fits within the expanded texture
        if (interpStartMs >= expandedStartMs && interpEndMs <= expandedEndMs && expandedDurationMs > 0) {
            // Switch to high-res region texture
            if (activeTexture !== 'region') {
                material.uniforms.uMagnitudes.value = regionMagnitudeTexture;
                activeTexture = 'region';
            }
            // Map viewport to the expanded texture's coordinate space
            material.uniforms.uViewportStart.value = (interpStartMs - expandedStartMs) / expandedDurationMs;
            material.uniforms.uViewportEnd.value = (interpEndMs - expandedStartMs) / expandedDurationMs;
        } else {
            // Viewport still extends beyond expanded bounds — stay on full texture
            if (activeTexture !== 'full' && fullMagnitudeTexture) {
                material.uniforms.uMagnitudes.value = fullMagnitudeTexture;
                activeTexture = 'full';
            }
            material.uniforms.uViewportStart.value = (interpStartMs - dataStartMs) / dataDurationMs;
            material.uniforms.uViewportEnd.value = (interpEndMs - dataStartMs) / dataDurationMs;
        }
    } else {
        // No region texture yet or zooming out — use full texture
        if (fullMagnitudeTexture && activeTexture !== 'full') {
            material.uniforms.uMagnitudes.value = fullMagnitudeTexture;
            activeTexture = 'full';
        }
        material.uniforms.uViewportStart.value = (interpStartMs - dataStartMs) / dataDurationMs;
        material.uniforms.uViewportEnd.value = (interpEndMs - dataStartMs) / dataDurationMs;
    }

    // Update stretch
    const playbackRate = State.currentPlaybackRate || 1.0;
    material.uniforms.uStretchFactor.value = calculateStretchFactor(playbackRate, State.frequencyScale);

    // Update frequency uniforms
    updateFrequencyUniforms();

    // Update overlay
    updateSpectrogramOverlay();

    // One render call does everything
    renderFrame();
}

// ─── State management ───────────────────────────────────────────────────────

export function resetSpectrogramState() {
    completeSpectrogramRendered = false;
    renderingInProgress = false;
    State.setSpectrogramInitialized(false);

    renderContext = { startSample: null, endSample: null, frequencyScale: null };

    // Don't dispose full texture during transitions — we need it
    // Dispose region texture
    if (regionMagnitudeTexture) {
        regionMagnitudeTexture.dispose();
        regionMagnitudeTexture = null;
        regionMagnitudeData = null;
    }
}

export function restoreInfiniteCanvasFromCache() {
    if (!fullMagnitudeTexture || !material) {
        console.warn('Cannot restore - no full magnitude texture');
        return;
    }

    // Switch back to full texture
    material.uniforms.uMagnitudes.value = fullMagnitudeTexture;
    activeTexture = 'full';

    // Reset viewport to full view
    material.uniforms.uViewportStart.value = 0.0;
    material.uniforms.uViewportEnd.value = 1.0;

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
        fullMagnitudeData = null;
    }
    if (regionMagnitudeTexture) {
        regionMagnitudeTexture.dispose();
        regionMagnitudeTexture = null;
        regionMagnitudeData = null;
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

    // Remove WebGL context handlers from canvas
    if (threeRenderer && onContextLost) {
        threeRenderer.domElement.removeEventListener('webglcontextlost', onContextLost);
        threeRenderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
        onContextLost = null;
        onContextRestored = null;
    }

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
        regionMagnitudeData = null;
        console.log('Cleared region magnitude texture');
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
        // Restore region display if we were showing it
        if (savedActiveTexture === 'region' && savedRegionTexture && material) {
            material.uniforms.uMagnitudes.value = savedRegionTexture;
            activeTexture = 'region';
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
    material.uniforms.uMagnitudes.value = regionMagnitudeTexture;
    activeTexture = 'region';

    // If smart render was used, the texture covers an expanded range.
    // Set viewport to show only the target region within the expanded texture.
    if (smartRenderBounds.expandedStart !== null && smartRenderBounds.targetStart !== null) {
        const expandedDuration = smartRenderBounds.expandedEnd - smartRenderBounds.expandedStart;
        if (expandedDuration > 0) {
            material.uniforms.uViewportStart.value =
                (smartRenderBounds.targetStart - smartRenderBounds.expandedStart) / expandedDuration;
            material.uniforms.uViewportEnd.value =
                (smartRenderBounds.targetEnd - smartRenderBounds.expandedStart) / expandedDuration;
        } else {
            material.uniforms.uViewportStart.value = 0.0;
            material.uniforms.uViewportEnd.value = 1.0;
        }
    } else {
        // No smart render — texture covers exactly the target region
        material.uniforms.uViewportStart.value = 0.0;
        material.uniforms.uViewportEnd.value = 1.0;
    }

    updateFrequencyUniforms();

    const stretchFactor = calculateStretchFactor(playbackRate, State.frequencyScale);
    material.uniforms.uStretchFactor.value = stretchFactor;

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
    if (!material || !threeRenderer) return null;

    const canvas = threeRenderer.domElement;
    const width = canvas.width;
    const height = canvas.height;

    // Set up stretch for this viewport
    const stretchFactor = calculateStretchFactor(playbackRate, State.frequencyScale);
    material.uniforms.uStretchFactor.value = stretchFactor;
    updateFrequencyUniforms();

    // Render to a render target
    const renderTarget = new THREE.WebGLRenderTarget(width, height);
    threeRenderer.setRenderTarget(renderTarget);
    threeRenderer.render(scene, camera);

    // Read pixels back
    const pixels = new Uint8Array(width * height * 4);
    threeRenderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, pixels);
    threeRenderer.setRenderTarget(null);
    renderTarget.dispose();

    // Create a 2d canvas (WebGL pixels are bottom-to-top, flip for canvas)
    const viewportCanvas = document.createElement('canvas');
    viewportCanvas.width = width;
    viewportCanvas.height = height;
    const ctx = viewportCanvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);

    for (let y = 0; y < height; y++) {
        const srcRow = (height - 1 - y) * width * 4;
        const dstRow = y * width * 4;
        imageData.data.set(pixels.subarray(srcRow, srcRow + width * 4), dstRow);
    }

    ctx.putImageData(imageData, 0, 0);
    return viewportCanvas;
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
    if (spectrogramOverlay) return;

    const canvas = threeRenderer?.domElement || document.getElementById('spectrogram');
    if (!canvas) return;

    spectrogramOverlay = document.createElement('div');
    spectrogramOverlay.id = 'spectrogram-overlay';
    spectrogramOverlay.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.3);
        pointer-events: none;
        z-index: 10;
        transition: none;
        will-change: opacity;
    `;

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
        spectrogramOverlayResizeObserver = new ResizeObserver(() => {
            if (spectrogramOverlay && canvas) {
                const canvasRect = canvas.getBoundingClientRect();
                const parentRect = parent.getBoundingClientRect();
                spectrogramOverlay.style.top = (canvasRect.top - parentRect.top) + 'px';
                spectrogramOverlay.style.left = (canvasRect.left - parentRect.left) + 'px';
                spectrogramOverlay.style.width = canvasRect.width + 'px';
                spectrogramOverlay.style.height = canvasRect.height + 'px';
            }
        });
        spectrogramOverlayResizeObserver.observe(canvas);
    }
}

function updateSpectrogramOverlay(progress) {
    if (!spectrogramOverlay) {
        createSpectrogramOverlay();
    }
    if (!spectrogramOverlay) return;

    const opacityProgress = typeof progress === 'number' ? progress : getRegionOpacityProgress();
    const overlayOpacity = 1.0 - opacityProgress;
    spectrogramOverlay.style.opacity = overlayOpacity.toFixed(3);
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function startCompleteVisualization() {
    await new Promise(resolve => setTimeout(resolve, 100));

    if (!State.completeSamplesArray || State.completeSamplesArray.length === 0) {
        console.log('Cannot start visualization - no audio data');
        return;
    }

    console.log('Starting Three.js spectrogram visualization');
    await renderCompleteSpectrogram();
}

// ─── Colormap change support ────────────────────────────────────────────────

/**
 * Call this when the colormap changes to rebuild the LUT texture.
 */
export function onColormapChanged() {
    rebuildColormapTexture();
    if (material && threeRenderer) {
        renderFrame();
    }
}
