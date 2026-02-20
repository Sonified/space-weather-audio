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
import { initPyramid, renderBaseTiles, pickLevel, getVisibleTiles as getPyramidVisibleTiles, getTileTexture, setOnTileReady, disposePyramid, tilesReady, TILE_COLS, detectBC4Support, setCompressionMode, getCompressionMode, isBC4Supported, throttleWorkers, resumeWorkers } from './spectrogram-pyramid.js';

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
function positionMeshWorldSpace(mesh, startX, endX) {
    const width = endX - startX;
    const centerX = startX + width / 2;
    mesh.scale.set(width / 2, 0.5, 1);  // half-extents (geometry is 2 wide, 2 tall)
    mesh.position.set(centerX, 0.5, 0);  // center Y at 0.5 for [0,1] range
}

// ─── Tile rendering (pyramid LOD system) ─────────────────────────────────────
const TILE_CROSSFADE_MS = 300; // crossfade duration when tiles appear (ms)
let tileMeshes = [];            // Array of { mesh, material } — up to 32 slots for pyramid tiles
let tileReadyTimes = new Map(); // key -> performance.now() when tile became ready (for crossfade)
let lastDisplayedLevel = -1;    // Track which level was displayed last frame (for re-fade prevention)

// Waveform (time series) overlay mesh for main window view modes
let waveformMesh = null;
let waveformMaterial = null;
let wfSampleTexture = null;
let wfMipTexture = null;
let wfColormapTexture = null;
let wfTotalSamples = 0;
let wfTextureWidth = 1;
let wfTextureHeight = 1;
let wfLastUploadedSamples = null;
const WF_MIP_BIN_SIZE = 256;

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

    // World-space camera handles viewport — UV is always 0→1
    float texU = vUv.x;

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

// ─── Tile fragment shader (same as spectrogram but with opacity for crossfade) ─

const tileFragmentShaderSource = /* glsl */ `
uniform sampler2D uMagnitudes;
uniform sampler2D uColormap;
uniform float uStretchFactor;
uniform int uFrequencyScale;
uniform float uMinFreq;
uniform float uMaxFreq;
uniform vec3 uBackgroundColor;
uniform float uOpacity;

varying vec2 vUv;

void main() {
    float effectiveY = vUv.y / uStretchFactor;
    if (effectiveY > 1.0) {
        gl_FragColor = vec4(uBackgroundColor, uOpacity);
        return;
    }

    float freq;
    if (uFrequencyScale == 0) {
        freq = uMinFreq + effectiveY * (uMaxFreq - uMinFreq);
    } else if (uFrequencyScale == 1) {
        float normalized = effectiveY * effectiveY;
        freq = uMinFreq + normalized * (uMaxFreq - uMinFreq);
    } else {
        float logMin = log2(max(uMinFreq, 0.001)) / log2(10.0);
        float logMax = log2(uMaxFreq) / log2(10.0);
        float logFreq = logMin + effectiveY * (logMax - logMin);
        freq = pow(10.0, logFreq);
    }

    float texV = clamp(freq / uMaxFreq, 0.0, 1.0);
    float texU = vUv.x;  // World-space camera handles viewport — UV is always 0→1

    float normalized = texture2D(uMagnitudes, vec2(texU, texV)).r;  // Already 0-1 from Uint8
    vec3 color = texture2D(uColormap, vec2(normalized, 0.5)).rgb;

    gl_FragColor = vec4(color, uOpacity);
}
`;

// ─── Waveform (time series) shader ──────────────────────────────────────────

const wfFragmentShaderSource = /* glsl */ `
uniform sampler2D uSamples;
uniform sampler2D uMipMinMax;
uniform sampler2D uColormap;
uniform float uTotalSamples;
uniform float uTextureWidth;
uniform float uTextureHeight;
uniform float uMipTextureWidth;
uniform float uMipTextureHeight;
uniform float uMipTotalBins;
uniform float uMipBinSize;
uniform float uSamplesPerPixel;
uniform float uCanvasWidth;
uniform float uCanvasHeight;
uniform vec3 uBackgroundColor;
uniform float uTransparentBg;

varying vec2 vUv;

float getSample(float index) {
    float row = floor(index / uTextureWidth);
    float col = index - row * uTextureWidth;
    vec2 uv = vec2(
        (col + 0.5) / uTextureWidth,
        (row + 0.5) / uTextureHeight
    );
    return texture2D(uSamples, uv).r;
}

vec2 getMipBin(float index) {
    float row = floor(index / uMipTextureWidth);
    float col = index - row * uMipTextureWidth;
    vec2 uv = vec2(
        (col + 0.5) / uMipTextureWidth,
        (row + 0.5) / uMipTextureHeight
    );
    return texture2D(uMipMinMax, uv).rg;
}

void main() {
    // World-space camera: vUv.x maps 0→1 across full data range
    float pixelStart = vUv.x * uTotalSamples;
    float samplesPerPixel = uSamplesPerPixel;
    float pixelEnd = pixelStart + samplesPerPixel;

    float minVal = 1.0;
    float maxVal = -1.0;

    if (samplesPerPixel > uMipBinSize && uMipTotalBins > 0.0) {
        float binStart = floor(max(pixelStart / uMipBinSize, 0.0));
        float binEnd = ceil(min(pixelEnd / uMipBinSize, uMipTotalBins));
        float binCount = binEnd - binStart;
        for (int i = 0; i < 512; i++) {
            if (float(i) >= binCount) break;
            vec2 mm = getMipBin(binStart + float(i));
            minVal = min(minVal, mm.r);
            maxVal = max(maxVal, mm.g);
        }
    } else {
        float startIdx = floor(max(pixelStart, 0.0));
        float endIdx = ceil(min(pixelEnd, uTotalSamples));
        float count = endIdx - startIdx;
        for (int i = 0; i < 8192; i++) {
            if (float(i) >= count) break;
            float s = getSample(startIdx + float(i));
            minVal = min(minVal, s);
            maxVal = max(maxVal, s);
        }
    }

    float amplitude = (vUv.y - 0.5) * 2.0;
    float yMin = minVal * 0.9;
    float yMax = maxVal * 0.9;

    float minThickness = 2.0 / uCanvasHeight;
    if (yMax - yMin < minThickness) {
        float center = (yMin + yMax) * 0.5;
        yMin = center - minThickness * 0.5;
        yMax = center + minThickness * 0.5;
    }

    float centerThickness = 1.0 / uCanvasHeight;
    if (abs(vUv.y - 0.5) < centerThickness) {
        gl_FragColor = vec4(0.4, 0.4, 0.4, uTransparentBg > 0.5 ? 0.6 : 1.0);
        return;
    }

    if (amplitude >= yMin && amplitude <= yMax) {
        float peakAmplitude = max(abs(minVal), abs(maxVal));
        float normalized = clamp(peakAmplitude, 0.0, 1.0);
        vec3 color = texture2D(uColormap, vec2(normalized, 0.5)).rgb;
        gl_FragColor = vec4(color, 1.0);
    } else {
        gl_FragColor = vec4(uBackgroundColor, uTransparentBg > 0.5 ? 0.0 : 1.0);
    }
}
`;

// ─── Main window view mode ──────────────────────────────────────────────────

function getMainWindowMode() {
    const el = document.getElementById('mainWindowView');
    return el ? el.value : 'spectrogram';
}

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

    // Detect BC4 support for pyramid tile compression
    detectBC4Support(threeRenderer);

    // Orthographic camera in world-space: X = seconds, Y = 0→1
    // camera.left/right are updated by updateSpectrogramViewportFromZoom() before each render
    camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0, 10);
    camera.position.z = 1;

    scene = new THREE.Scene();

    // Build colormap texture
    colormapTexture = buildColormapTexture();

    // Create shader material with default uniforms
    material = new THREE.ShaderMaterial({
        uniforms: {
            uMagnitudes: { value: null },
            uColormap: { value: colormapTexture },
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

    // Full-screen quad (spectrogram)
    const geometry = new THREE.PlaneGeometry(2, 2);
    mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 0;
    scene.add(mesh);

    // Waveform (time series) mesh — overlaid on spectrogram for combination mode
    wfColormapTexture = buildWaveformColormapTexture();

    const bgR = 0, bgG = 0, bgB = 0;
    waveformMaterial = new THREE.ShaderMaterial({
        uniforms: {
            uSamples: { value: null },
            uMipMinMax: { value: null },
            uColormap: { value: wfColormapTexture },
            uTotalSamples: { value: 0.0 },
            uTextureWidth: { value: 1.0 },
            uTextureHeight: { value: 1.0 },
            uMipTextureWidth: { value: 1.0 },
            uMipTextureHeight: { value: 1.0 },
            uMipTotalBins: { value: 0.0 },
            uMipBinSize: { value: parseFloat(WF_MIP_BIN_SIZE) },
            uSamplesPerPixel: { value: 1.0 },
            uCanvasWidth: { value: parseFloat(width) },
            uCanvasHeight: { value: parseFloat(height) },
            uBackgroundColor: { value: new THREE.Vector3(bgR, bgG, bgB) },
            uTransparentBg: { value: 0.0 }
        },
        vertexShader: vertexShaderSource,
        fragmentShader: wfFragmentShaderSource,
        transparent: true
    });
    waveformMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), waveformMaterial);
    waveformMesh.renderOrder = 1;
    waveformMesh.visible = false;
    scene.add(waveformMesh);

    // Tile meshes — up to 32 slots for pyramid LOD tiles
    // Rendered IN FRONT of the main spectrogram mesh so tiles progressively replace
    // the low-res full texture as they complete (with crossfade via uOpacity)
    tileMeshes = [];
    for (let i = 0; i < 32; i++) {
        const tileMat = new THREE.ShaderMaterial({
            uniforms: {
                uMagnitudes: { value: null },
                uColormap: { value: colormapTexture },
                uStretchFactor: { value: 1.0 },
                uFrequencyScale: { value: 0 },
                uMinFreq: { value: 0.1 },
                uMaxFreq: { value: 50.0 },
                uBackgroundColor: { value: new THREE.Vector3(0, 0, 0) },
                uOpacity: { value: 1.0 }
            },
            vertexShader: vertexShaderSource,
            fragmentShader: tileFragmentShaderSource,
            transparent: true
        });
        const tileGeom = new THREE.PlaneGeometry(2, 2);
        const tileMesh = new THREE.Mesh(tileGeom, tileMat);
        tileMesh.renderOrder = 0.5;  // in front of full texture (0), behind waveform (1)
        tileMesh.visible = false;
        scene.add(tileMesh);
        tileMeshes.push({ mesh: tileMesh, material: tileMat });
    }

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
        if (wfSampleTexture) wfSampleTexture.needsUpdate = true;
        if (wfMipTexture) wfMipTexture.needsUpdate = true;
        // Tile textures managed by pyramid LRU cache — will recreate on demand
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
    // Rebuild tile mesh colormaps
    for (const tm of tileMeshes) {
        tm.material.uniforms.uColormap.value = colormapTexture;
    }
    // Rebuild waveform colormap too
    if (waveformMaterial) {
        if (wfColormapTexture) wfColormapTexture.dispose();
        wfColormapTexture = buildWaveformColormapTexture();
        waveformMaterial.uniforms.uColormap.value = wfColormapTexture;
    }
}

/**
 * Build brightness-boosted colormap for waveform rendering.
 * Makes waveform visible on dark backgrounds and when overlaid on spectrogram.
 */
function buildWaveformColormapTexture() {
    const spectrogramLUT = getColorLUT();
    if (!spectrogramLUT) return null;

    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
        let r = spectrogramLUT[i * 3];
        let g = spectrogramLUT[i * 3 + 1];
        let b = spectrogramLUT[i * 3 + 2];

        // Brightness boost (same algorithm as waveform-renderer)
        const boost = 0.4;
        const minBrightness = 150;
        r = Math.min(255, Math.round(r + (255 - r) * boost));
        g = Math.min(255, Math.round(g + (255 - g) * boost));
        b = Math.min(255, Math.round(b + (255 - b) * boost));

        const brightness = (r + g + b) / 3;
        if (brightness < minBrightness) {
            const factor = minBrightness / Math.max(brightness, 1);
            r = Math.min(255, Math.round(r * factor));
            g = Math.min(255, Math.round(g * factor));
            b = Math.min(255, Math.round(b * factor));
        }

        data[i * 4]     = r;
        data[i * 4 + 1] = g;
        data[i * 4 + 2] = b;
        data[i * 4 + 3] = 255;
    }

    const tex = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
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

    const mode = getMainWindowMode();
    const showSpectrogram = (mode === 'spectrogram' || mode === 'both');
    const showWaveform = (mode === 'timeSeries' || mode === 'both');

    // Mode gating only — hide everything when spectrogram isn't shown.
    // Visibility of main mesh vs tile meshes is controlled by tryUseTiles/useInterpFallback.
    // renderFrame never overrides those decisions.
    if (!showSpectrogram) {
        if (mesh) mesh.visible = false;
        for (const tm of tileMeshes) tm.mesh.visible = false;
    }

    // Toggle waveform mesh visibility (only if samples uploaded)
    if (waveformMesh) {
        waveformMesh.visible = showWaveform && !!wfSampleTexture;
        if (waveformMaterial) {
            waveformMaterial.uniforms.uTransparentBg.value = mode === 'both' ? 1.0 : 0.0;
        }
    }

    // Update waveform uniforms (mesh is positioned in world space, camera handles viewport)
    if (showWaveform && waveformMaterial) {
        // Compute samplesPerPixel from camera view width
        const canvas = threeRenderer.domElement;
        const viewDurationSec = camera.right - camera.left;
        const totalSamples = waveformMaterial.uniforms.uTotalSamples.value;
        if (viewDurationSec > 0 && State.dataStartTime && State.dataEndTime) {
            const dataDurationSec = (State.dataEndTime.getTime() - State.dataStartTime.getTime()) / 1000;
            if (dataDurationSec > 0) {
                const viewFrac = viewDurationSec / dataDurationSec;
                const viewSamples = viewFrac * totalSamples;
                waveformMaterial.uniforms.uSamplesPerPixel.value = viewSamples / canvas.width;
            }
        }

        // Update background color
        const lut = getColorLUT();
        if (lut) {
            waveformMaterial.uniforms.uBackgroundColor.value.set(lut[0] / 255, lut[1] / 255, lut[2] / 255);
        }

        // Handle canvas resize
        waveformMaterial.uniforms.uCanvasWidth.value = parseFloat(canvas.width);
        waveformMaterial.uniforms.uCanvasHeight.value = parseFloat(canvas.height);
    }

    threeRenderer.render(scene, camera);
}

// ─── Waveform sample upload (for time series mode) ──────────────────────────

/**
 * Upload audio waveform samples to GPU textures for time series rendering.
 * Called after spectrogram render completes (same sample data, separate textures).
 */
function uploadMainWaveformSamples() {
    const samples = State.completeSamplesArray || State.getCompleteSamplesArray();
    if (!samples || samples.length === 0) return;
    if (!waveformMaterial) return;

    // Skip re-upload if same data
    if (samples === wfLastUploadedSamples && wfSampleTexture) return;

    wfTotalSamples = samples.length;
    wfTextureWidth = 4096;
    wfTextureHeight = Math.ceil(wfTotalSamples / wfTextureWidth);

    // Pad to fill texture rectangle
    const paddedLength = wfTextureWidth * wfTextureHeight;
    const data = new Float32Array(paddedLength);
    data.set(samples);

    if (wfSampleTexture) wfSampleTexture.dispose();
    wfSampleTexture = new THREE.DataTexture(data, wfTextureWidth, wfTextureHeight, THREE.RedFormat, THREE.FloatType);
    wfSampleTexture.minFilter = THREE.NearestFilter;
    wfSampleTexture.magFilter = THREE.NearestFilter;
    wfSampleTexture.wrapS = THREE.ClampToEdgeWrapping;
    wfSampleTexture.wrapT = THREE.ClampToEdgeWrapping;
    wfSampleTexture.needsUpdate = true;

    waveformMaterial.uniforms.uSamples.value = wfSampleTexture;
    waveformMaterial.uniforms.uTotalSamples.value = parseFloat(wfTotalSamples);
    waveformMaterial.uniforms.uTextureWidth.value = parseFloat(wfTextureWidth);
    waveformMaterial.uniforms.uTextureHeight.value = parseFloat(wfTextureHeight);

    // Build min/max mip texture
    const mipBins = Math.ceil(wfTotalSamples / WF_MIP_BIN_SIZE);
    const mipTexWidth = 4096;
    const mipTexHeight = Math.ceil(mipBins / mipTexWidth);
    const mipPadded = mipTexWidth * mipTexHeight;
    const mipData = new Float32Array(mipPadded * 2);

    for (let bin = 0; bin < mipBins; bin++) {
        const start = bin * WF_MIP_BIN_SIZE;
        const end = Math.min(start + WF_MIP_BIN_SIZE, wfTotalSamples);
        let mn = Infinity, mx = -Infinity;
        for (let j = start; j < end; j++) {
            const v = samples[j];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
        }
        mipData[bin * 2]     = mn;
        mipData[bin * 2 + 1] = mx;
    }

    if (wfMipTexture) wfMipTexture.dispose();
    wfMipTexture = new THREE.DataTexture(mipData, mipTexWidth, mipTexHeight, THREE.RGFormat, THREE.FloatType);
    wfMipTexture.minFilter = THREE.NearestFilter;
    wfMipTexture.magFilter = THREE.NearestFilter;
    wfMipTexture.wrapS = THREE.ClampToEdgeWrapping;
    wfMipTexture.wrapT = THREE.ClampToEdgeWrapping;
    wfMipTexture.needsUpdate = true;

    waveformMaterial.uniforms.uMipMinMax.value = wfMipTexture;
    waveformMaterial.uniforms.uMipTextureWidth.value = parseFloat(mipTexWidth);
    waveformMaterial.uniforms.uMipTextureHeight.value = parseFloat(mipTexHeight);
    waveformMaterial.uniforms.uMipTotalBins.value = parseFloat(mipBins);

    wfLastUploadedSamples = samples;

    // Position waveform mesh in world space (covers full data duration)
    if (waveformMesh && State.dataStartTime && State.dataEndTime) {
        const dataDurationSec = (State.dataEndTime.getTime() - State.dataStartTime.getTime()) / 1000;
        if (dataDurationSec > 0) {
            positionMeshWorldSpace(waveformMesh, 0, dataDurationSec);
        }
    }

    console.log(`Main window waveform uploaded: ${wfTotalSamples.toLocaleString()} samples`);
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

        fullMagnitudeWidth = result.width;
        fullMagnitudeHeight = result.height;

        // Store actual FFT column center times (seconds from data start)
        const sr = zoomState.sampleRate;
        fullTextureFirstColSec = (fftSize / 2) / sr;
        fullTextureLastColSec = ((numTimeSlices - 1) * hopSize + fftSize / 2) / sr;

        // Create GPU texture
        if (fullMagnitudeTexture) fullMagnitudeTexture.dispose();
        fullMagnitudeTexture = createMagnitudeTexture(result.data, result.width, result.height);

        // Set as active texture
        material.uniforms.uMagnitudes.value = fullMagnitudeTexture;
        activeTexture = 'full';

        // Update frequency-related uniforms
        updateFrequencyUniforms();

        // Position full-texture mesh at fixed world-space location (set once, never moved)
        if (mesh) {
            positionMeshWorldSpace(mesh, fullTextureFirstColSec, fullTextureLastColSec);
        }

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

        // Upload waveform samples for time series mode
        uploadMainWaveformSamples();

        // Notify minimap that spectrogram texture is ready
        window.dispatchEvent(new Event('spectrogram-ready'));

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

        // Initialize pyramid and render base tiles
        const dataDurationSec = (State.dataEndTime.getTime() - State.dataStartTime.getTime()) / 1000;
        const pyramidSampleRate = zoomState.sampleRate;
        initPyramid(dataDurationSec, pyramidSampleRate);

        // Set callback for tile readiness → triggers viewport update
        // During active zoom/pan, defer expensive updates to avoid jank
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

        // Get current viewport center for render priority
        const viewCenterSec = zoomState.isInitialized()
            ? ((zoomState.currentViewStartTime.getTime() + zoomState.currentViewEndTime.getTime()) / 2 - State.dataStartTime.getTime()) / 1000
            : dataDurationSec / 2;

        // Render base tiles (fire-and-forget, progressive)
        const tileStartTime = performance.now();
        renderBaseTiles(State.completeSamplesArray, pyramidSampleRate, fftSize, viewCenterSec, (done, total) => {
            if (!isStudyMode()) console.log(`🔺 Tiles: ${done}/${total}`);
            // All base tiles rendered — compress audio buffer to save memory
            if (done === total) {
                const elapsed = ((performance.now() - tileStartTime) / 1000).toFixed(1);
                console.log(`🔺 All ${total} base tiles rendered in ${elapsed}s`);
                requestIdleCallback(() => {
                    State.compressSamplesArray();
                }, { timeout: 5000 });
            }
        });

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
            material.uniforms.uMagnitudes.value = fullMagnitudeTexture;
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
 * visibleTiles: array of { tile, key }
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

            // Set texture (UV is always 0→1 now — shader uses vUv.x directly)
            tm.material.uniforms.uMagnitudes.value = texture;

            // Crossfade: compute opacity based on time since tile became ready
            const readyTime = tileReadyTimes.get(vt.key) || 0;
            const elapsed = now - readyTime;
            const opacity = TILE_CROSSFADE_MS > 0 ? Math.min(1, elapsed / TILE_CROSSFADE_MS) : 1;
            tm.material.uniforms.uOpacity.value = opacity;
            if (opacity < 1) anyFading = true;

            // Sync frequency/stretch uniforms with main material
            if (material) {
                tm.material.uniforms.uStretchFactor.value = material.uniforms.uStretchFactor.value;
                tm.material.uniforms.uFrequencyScale.value = material.uniforms.uFrequencyScale.value;
                tm.material.uniforms.uMinFreq.value = material.uniforms.uMinFreq.value;
                tm.material.uniforms.uMaxFreq.value = material.uniforms.uMaxFreq.value;
                tm.material.uniforms.uBackgroundColor.value.copy(material.uniforms.uBackgroundColor.value);
            }

            // Position tile at fixed world-space location (seconds)
            positionMeshWorldSpace(tm.mesh, vt.tile.startSec, vt.tile.endSec);
            tm.mesh.visible = true;
        } else {
            tm.mesh.visible = false;
        }
    }

    // If any tile is still fading in, schedule another frame that
    // updates opacities (positions are fixed, only opacity changes)
    if (anyFading) {
        requestAnimationFrame(() => {
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
            material.uniforms.uMagnitudes.value = regionMagnitudeTexture;
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
                material.uniforms.uMagnitudes.value = regionMagnitudeTexture;
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

    // Update stretch
    const playbackRate = State.currentPlaybackRate || 1.0;
    material.uniforms.uStretchFactor.value = calculateStretchFactor(playbackRate, State.frequencyScale);

    // Update frequency uniforms
    updateFrequencyUniforms();

    // Sync tile mesh uniforms
    for (const tm of tileMeshes) {
        if (tm.mesh.visible) {
            tm.material.uniforms.uStretchFactor.value = material.uniforms.uStretchFactor.value;
            tm.material.uniforms.uFrequencyScale.value = material.uniforms.uFrequencyScale.value;
            tm.material.uniforms.uMinFreq.value = material.uniforms.uMinFreq.value;
            tm.material.uniforms.uMaxFreq.value = material.uniforms.uMaxFreq.value;
            tm.material.uniforms.uBackgroundColor.value.copy(material.uniforms.uBackgroundColor.value);
        }
    }

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
            material.uniforms.uMagnitudes.value = regionMagnitudeTexture;
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

    // Update stretch + frequency
    const playbackRate = State.currentPlaybackRate || 1.0;
    material.uniforms.uStretchFactor.value = calculateStretchFactor(playbackRate, State.frequencyScale);
    updateFrequencyUniforms();

    // Sync tile mesh frequency uniforms
    for (const tm of tileMeshes) {
        if (tm.mesh.visible) {
            tm.material.uniforms.uStretchFactor.value = material.uniforms.uStretchFactor.value;
            tm.material.uniforms.uFrequencyScale.value = material.uniforms.uFrequencyScale.value;
            tm.material.uniforms.uMinFreq.value = material.uniforms.uMinFreq.value;
            tm.material.uniforms.uMaxFreq.value = material.uniforms.uMaxFreq.value;
            tm.material.uniforms.uBackgroundColor.value.copy(material.uniforms.uBackgroundColor.value);
        }
    }

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
    const optimalLevel = pickLevel(viewStartSec, viewEndSec, canvasWidth);
    const maxSlots = tileMeshes.length; // 32

    // "Park and fill" strategy:
    // Find the LOWEST level that fits in 32 mesh slots — that's the display level.
    let visibleTiles = [];
    let usedLevel = -1;

    for (let level = 0; level <= optimalLevel; level++) {
        const tiles = getPyramidVisibleTiles(level, viewStartSec, viewEndSec);
        if (tiles.length > 0 && tiles.length <= maxSlots) {
            visibleTiles = tiles;
            usedLevel = level;
            break;
        }
    }

    // When displayed level changes, stamp new tile keys with instant opacity
    // so they don't re-fade from 0%. Only fade-in tiles that are genuinely new.
    if (usedLevel >= 0 && usedLevel !== lastDisplayedLevel) {
        for (const vt of visibleTiles) {
            if (!tileReadyTimes.has(vt.key)) tileReadyTimes.set(vt.key, 0);
        }
        lastDisplayedLevel = usedLevel;
    }

    // Diagnostic
    if (visibleTiles.length > 0) {
        console.log(`🎯 L${usedLevel}, ${visibleTiles.length} tiles, backdrop=${fullMagnitudeTexture ? 'YES' : 'NULL'}`);
    }

    // Place tile meshes at fixed world-space positions (slots beyond visibleTiles.length get hidden)
    if (visibleTiles.length > 0) {
        if (activeTexture !== 'tiles') {
            // Transitioning TO tiles: existing tiles appear at full opacity (no flash)
            for (const vt of visibleTiles) {
                if (!tileReadyTimes.has(vt.key)) tileReadyTimes.set(vt.key, 0);
            }
        }
        updateTileMeshPositions(visibleTiles);
    } else {
        for (const tm of tileMeshes) tm.mesh.visible = false;
    }

    // Full texture backdrop: always visible unless tiles fully cover the viewport.
    // Mesh is already positioned in world space (set once when texture was uploaded).
    const tilesFullyCover = usedLevel >= 0 && tilesReady(usedLevel, viewStartSec, viewEndSec);

    if (tilesFullyCover) {
        if (mesh) mesh.visible = false;
    } else if (fullMagnitudeTexture) {
        material.uniforms.uMagnitudes.value = fullMagnitudeTexture;
        if (mesh) {
            // Ensure mesh is at full-texture world position (may have been moved for region)
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
    material.uniforms.uMagnitudes.value = fullMagnitudeTexture;
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
    if (wfSampleTexture) { wfSampleTexture.dispose(); wfSampleTexture = null; }
    if (wfMipTexture) { wfMipTexture.dispose(); wfMipTexture = null; }
    if (wfColormapTexture) { wfColormapTexture.dispose(); wfColormapTexture = null; }
    wfLastUploadedSamples = null;

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
            material.uniforms.uMagnitudes.value = savedRegionTexture;
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
    material.uniforms.uMagnitudes.value = regionMagnitudeTexture;
    activeTexture = 'region';

    // Position mesh at region's world-space location
    if (mesh) {
        positionMeshWorldSpace(mesh, regionTextureActualStartSec, regionTextureActualEndSec);
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
