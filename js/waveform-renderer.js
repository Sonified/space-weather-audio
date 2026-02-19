/**
 * waveform-renderer.js
 * Waveform drawing, interaction (scrubbing, selection), and playback indicator
 */

import * as State from './audio-state.js';
import { PlaybackState, isTouchDevice } from './audio-state.js';
import { seekToPosition, updateWorkletSelection } from './audio-player.js';
import { positionWaveformAxisCanvas, drawWaveformAxis } from './waveform-axis-renderer.js';
import { positionWaveformXAxisCanvas, drawWaveformXAxis, positionWaveformDateCanvas, drawWaveformDate, getInterpolatedTimeRange, isZoomTransitionInProgress } from './waveform-x-axis-renderer.js';
import { drawRegionHighlights, showAddRegionButton, hideAddRegionButton, clearActiveRegion, resetAllRegionPlayButtons, getActiveRegionIndex, isPlayingActiveRegion, checkCanvasZoomButtonClick, checkCanvasPlayButtonClick, zoomToRegion, zoomToFull, getRegions, toggleRegionPlay, renderRegionsAfterCrossfade, getStandaloneFeatures } from './region-tracker.js';
import { drawRegionButtons } from './waveform-buttons-renderer.js';
import { printSelectionDiagnostics } from './selection-diagnostics.js';
import { drawSpectrogramPlayhead, drawSpectrogramScrubPreview, clearSpectrogramScrubPreview, cleanupPlayheadOverlay } from './spectrogram-playhead.js';
import { zoomState } from './zoom-state.js';
import { hideTutorialOverlay, setStatusText } from './tutorial.js';
import { isStudyMode } from './master-modes.js';
import { updateAllFeatureBoxPositions } from './spectrogram-feature-boxes.js';
import { restoreViewportState, updateSpectrogramViewportFromZoom, getFullMagnitudeTexture, getSpectrogramParams } from './spectrogram-three-renderer.js';
import { drawDayMarkers } from './day-markers.js';
import { getColorLUT } from './colormaps.js';
import { updateLiveAnnotations } from './spectrogram-live-annotations.js';
import { updateCanvasAnnotations } from './spectrogram-renderer.js';
import { getYPositionForFrequencyScaled } from './spectrogram-axis-renderer.js';
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';

// Debug flag for waveform logs (set to true to enable detailed logging)
const DEBUG_WAVEFORM = false;

// ─── Three.js GPU waveform renderer ─────────────────────────────────────────

let wfRenderer = null;
let wfScene = null;
let wfCamera = null;
let wfMaterial = null;
let wfMesh = null;
let wfSampleTexture = null;
let wfMipTexture = null;       // Min/max mip texture for zoomed-out rendering
let wfColormapTexture = null;
let wfTotalSamples = 0;
let wfTextureWidth = 0;
let wfTextureHeight = 0;
const WF_MIP_BIN_SIZE = 256;  // Each mip texel covers 256 raw samples
let wfOverlayCanvas = null;
let wfOverlayCtx = null;
let wfCachedWidth = 0;   // Cached device-pixel dimensions (avoid offsetWidth in render path)
let wfCachedHeight = 0;
let wfResizeObserver = null;
let wfOverlayResizeObserver = null;
let wfOnContextLost = null;
let wfOnContextRestored = null;

// ─── Minimap spectrogram (second GPU pass) ───────────────────────────────────
let wfSpectroMaterial = null;
let wfSpectroMesh = null;

const wfVertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const wfFragmentShader = /* glsl */ `
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
uniform float uViewportStart;
uniform float uViewportEnd;
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
    float viewStartSample = uViewportStart * uTotalSamples;
    float viewEndSample = uViewportEnd * uTotalSamples;
    float samplesPerPixel = (viewEndSample - viewStartSample) / uCanvasWidth;

    float pixelStart = viewStartSample + vUv.x * (viewEndSample - viewStartSample);
    float pixelEnd = pixelStart + samplesPerPixel;

    float minVal = 1.0;
    float maxVal = -1.0;

    if (samplesPerPixel > uMipBinSize && uMipTotalBins > 0.0) {
        // Zoomed out: use pre-computed min/max bins
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
        // Zoomed in: scan raw samples
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

    // Y mapping: vUv.y 0=bottom, 1=top → amplitude -1 to +1
    float amplitude = (vUv.y - 0.5) * 2.0;

    float yMin = minVal * 0.9;
    float yMax = maxVal * 0.9;

    // Enforce minimum band thickness so the waveform doesn't vanish when zoomed in
    // (when minVal == maxVal, the band is zero pixels wide)
    float minThickness = 2.0 / uCanvasHeight;
    if (yMax - yMin < minThickness) {
        float center = (yMin + yMax) * 0.5;
        yMin = center - minThickness * 0.5;
        yMax = center + minThickness * 0.5;
    }

    // Center line (~1px thick)
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

function initWaveformThreeScene() {
    if (wfRenderer) return;

    const canvas = document.getElementById('waveform');
    if (!canvas) return;

    wfCachedWidth = Math.round(canvas.offsetWidth * window.devicePixelRatio);
    wfCachedHeight = Math.round(canvas.offsetHeight * window.devicePixelRatio);
    canvas.width = wfCachedWidth;
    canvas.height = wfCachedHeight;

    wfRenderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true });
    wfRenderer.setSize(wfCachedWidth, wfCachedHeight, false);

    wfCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
    wfCamera.position.z = 1;

    wfScene = new THREE.Scene();

    // Build waveform colormap texture (brightened version)
    wfColormapTexture = buildWaveformColormapTexture();

    const lut = getColorLUT();
    const bgR = lut ? lut[0] / 255 : 0;
    const bgG = lut ? lut[1] / 255 : 0;
    const bgB = lut ? lut[2] / 255 : 0;

    wfMaterial = new THREE.ShaderMaterial({
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
            uViewportStart: { value: 0.0 },
            uViewportEnd: { value: 1.0 },
            uCanvasWidth: { value: parseFloat(wfCachedWidth) },
            uCanvasHeight: { value: parseFloat(wfCachedHeight) },
            uBackgroundColor: { value: new THREE.Vector3(bgR, bgG, bgB) },
            uTransparentBg: { value: 0.0 }
        },
        vertexShader: wfVertexShader,
        fragmentShader: wfFragmentShader,
        transparent: true
    });

    const geometry = new THREE.PlaneGeometry(2, 2);
    wfMesh = new THREE.Mesh(geometry, wfMaterial);
    wfScene.add(wfMesh);

    // Spectrogram material for minimap mode (reuses magnitude texture from main spectrogram)
    wfSpectroColormapTexture = buildSpectroColormapTexture();
    wfSpectroMaterial = new THREE.ShaderMaterial({
        uniforms: {
            uMagnitudes: { value: null },
            uColormap: { value: wfSpectroColormapTexture },
            uViewportStart: { value: 0.0 },
            uViewportEnd: { value: 1.0 },
            uStretchFactor: { value: 1.0 },
            uFrequencyScale: { value: 0 },
            uMinFreq: { value: 0.1 },
            uMaxFreq: { value: 50.0 },
            uDbFloor: { value: -100.0 },
            uDbRange: { value: 100.0 },
            uBackgroundColor: { value: new THREE.Vector3(bgR, bgG, bgB) }
        },
        vertexShader: wfVertexShader,
        fragmentShader: /* glsl */ `
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
    float effectiveY = vUv.y / uStretchFactor;
    if (effectiveY > 1.0) {
        gl_FragColor = vec4(uBackgroundColor, 1.0);
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
    float texU = uViewportStart + vUv.x * (uViewportEnd - uViewportStart);
    float magnitude = texture2D(uMagnitudes, vec2(texU, texV)).r;
    float db = 20.0 * log(magnitude + 1.0e-10) / log(10.0);
    float normalized = clamp((db - uDbFloor) / uDbRange, 0.0, 1.0);
    vec3 color = texture2D(uColormap, vec2(normalized, 0.5)).rgb;
    gl_FragColor = vec4(color, 1.0);
}
`
    });
    wfSpectroMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), wfSpectroMaterial);
    wfSpectroMesh.visible = false;
    wfScene.add(wfSpectroMesh);

    // Create overlay canvas for 2d drawing (regions, playhead, selection)
    createWaveformOverlay(canvas);

    // Cache dimensions on resize (avoid offsetWidth reads in render path)
    if (wfResizeObserver) wfResizeObserver.disconnect();
    wfResizeObserver = new ResizeObserver(() => {
        const w = Math.round(canvas.offsetWidth * window.devicePixelRatio);
        const h = Math.round(canvas.offsetHeight * window.devicePixelRatio);
        if (w > 0 && h > 0) {
            wfCachedWidth = w;
            wfCachedHeight = h;
        }
    });
    wfResizeObserver.observe(canvas);

    // WebGL context loss/restore handlers (Chromium can drop contexts under GPU pressure)
    if (wfOnContextLost) canvas.removeEventListener('webglcontextlost', wfOnContextLost);
    if (wfOnContextRestored) canvas.removeEventListener('webglcontextrestored', wfOnContextRestored);

    wfOnContextLost = (e) => {
        e.preventDefault();
        console.warn('Waveform WebGL context lost — will restore on next render');
    };
    wfOnContextRestored = () => {
        console.log('Waveform WebGL context restored — re-uploading textures');
        if (wfColormapTexture) wfColormapTexture.dispose();
        wfColormapTexture = buildWaveformColormapTexture();
        if (wfMaterial) wfMaterial.uniforms.uColormap.value = wfColormapTexture;
        if (wfSampleTexture && wfMaterial) {
            wfSampleTexture.needsUpdate = true;
            wfMaterial.uniforms.uSamples.value = wfSampleTexture;
        }
        if (wfMipTexture && wfMaterial) {
            wfMipTexture.needsUpdate = true;
            wfMaterial.uniforms.uMipMinMax.value = wfMipTexture;
        }
    };
    canvas.addEventListener('webglcontextlost', wfOnContextLost);
    canvas.addEventListener('webglcontextrestored', wfOnContextRestored);

    // Re-render minimap when spectrogram texture becomes available
    window.addEventListener('spectrogram-ready', () => {
        if (getMinimapMode() !== 'linePlot') {
            drawWaveformFromMinMax();
        }
    });

    console.log(`Three.js waveform renderer initialized (${wfCachedWidth}x${wfCachedHeight})`);
}

function buildWaveformColormapTexture() {
    if (!waveformColorLUT) buildWaveformColorLUT();
    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
        data[i * 4]     = waveformColorLUT[i * 3];
        data[i * 4 + 1] = waveformColorLUT[i * 3 + 1];
        data[i * 4 + 2] = waveformColorLUT[i * 3 + 2];
        data[i * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
}

/** Build a colormap texture from the raw spectrogram LUT (no brightness boost) */
let wfSpectroColormapTexture = null;
function buildSpectroColormapTexture() {
    const lut = getColorLUT();
    if (!lut) return null;
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

function createWaveformOverlay(waveformCanvas) {
    if (wfOverlayCanvas) return;

    wfOverlayCanvas = document.createElement('canvas');
    wfOverlayCanvas.id = 'waveform-overlay';

    const parent = waveformCanvas.parentElement;
    if (parent) {
        // Use offsetTop/offsetLeft (already relative to offsetParent padding edge,
        // matching position:absolute reference) and clientWidth/Height (content only, no border)
        const dpr = window.devicePixelRatio || 1;

        wfOverlayCanvas.style.position = 'absolute';
        wfOverlayCanvas.style.pointerEvents = 'none';
        wfOverlayCanvas.style.zIndex = '5';
        wfOverlayCanvas.style.background = 'transparent';
        wfOverlayCanvas.style.left = (waveformCanvas.offsetLeft + waveformCanvas.clientLeft) + 'px';
        wfOverlayCanvas.style.top = (waveformCanvas.offsetTop + waveformCanvas.clientTop) + 'px';
        wfOverlayCanvas.width = Math.round(waveformCanvas.clientWidth * dpr);
        wfOverlayCanvas.height = Math.round(waveformCanvas.clientHeight * dpr);
        wfOverlayCanvas.style.width = waveformCanvas.clientWidth + 'px';
        wfOverlayCanvas.style.height = waveformCanvas.clientHeight + 'px';

        // Debug removed — fix confirmed working

        parent.appendChild(wfOverlayCanvas);

        // Keep overlay positioned on resize
        if (wfOverlayResizeObserver) wfOverlayResizeObserver.disconnect();
        wfOverlayResizeObserver = new ResizeObserver(() => {
            if (wfOverlayCanvas && waveformCanvas) {
                const rdpr = window.devicePixelRatio || 1;
                wfOverlayCanvas.style.left = (waveformCanvas.offsetLeft + waveformCanvas.clientLeft) + 'px';
                wfOverlayCanvas.style.top = (waveformCanvas.offsetTop + waveformCanvas.clientTop) + 'px';
                const newW = Math.round(waveformCanvas.clientWidth * rdpr);
                const newH = Math.round(waveformCanvas.clientHeight * rdpr);
                if (wfOverlayCanvas.width !== newW || wfOverlayCanvas.height !== newH) {
                    wfOverlayCanvas.width = newW;
                    wfOverlayCanvas.height = newH;
                    drawWaveformOverlays();
                }
                wfOverlayCanvas.style.width = waveformCanvas.clientWidth + 'px';
                wfOverlayCanvas.style.height = waveformCanvas.clientHeight + 'px';
            }
        });
        wfOverlayResizeObserver.observe(waveformCanvas);
    }
    wfOverlayCtx = wfOverlayCanvas.getContext('2d');
}

/**
 * Upload audio samples to GPU texture
 */
let wfLastUploadedSamples = null; // Track last uploaded array to skip redundant uploads

export function uploadWaveformSamples(samples) {
    if (!samples || samples.length === 0) return;

    // Skip re-upload if the same sample array is already on the GPU
    if (samples === wfLastUploadedSamples && wfSampleTexture) return;

    initWaveformThreeScene();
    if (!wfMaterial) return;

    wfTotalSamples = samples.length;
    wfTextureWidth = 4096;
    wfTextureHeight = Math.ceil(wfTotalSamples / wfTextureWidth);

    // Pad to fill the texture rectangle
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

    wfMaterial.uniforms.uSamples.value = wfSampleTexture;
    wfMaterial.uniforms.uTotalSamples.value = parseFloat(wfTotalSamples);
    wfMaterial.uniforms.uTextureWidth.value = parseFloat(wfTextureWidth);
    wfMaterial.uniforms.uTextureHeight.value = parseFloat(wfTextureHeight);

    // Build min/max mip texture: each bin covers WF_MIP_BIN_SIZE raw samples
    // Stored as RG float pairs: .r = min, .g = max
    const mipBins = Math.ceil(wfTotalSamples / WF_MIP_BIN_SIZE);
    const mipTexWidth = 4096;
    const mipTexHeight = Math.ceil(mipBins / mipTexWidth);
    const mipPadded = mipTexWidth * mipTexHeight;
    const mipData = new Float32Array(mipPadded * 2); // 2 channels: RG

    for (let bin = 0; bin < mipBins; bin++) {
        const start = bin * WF_MIP_BIN_SIZE;
        const end = Math.min(start + WF_MIP_BIN_SIZE, wfTotalSamples);
        let mn = Infinity, mx = -Infinity;
        for (let j = start; j < end; j++) {
            const v = samples[j];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
        }
        mipData[bin * 2]     = mn; // .r = min
        mipData[bin * 2 + 1] = mx; // .g = max
    }

    if (wfMipTexture) wfMipTexture.dispose();
    wfMipTexture = new THREE.DataTexture(mipData, mipTexWidth, mipTexHeight, THREE.RGFormat, THREE.FloatType);
    wfMipTexture.minFilter = THREE.NearestFilter;
    wfMipTexture.magFilter = THREE.NearestFilter;
    wfMipTexture.wrapS = THREE.ClampToEdgeWrapping;
    wfMipTexture.wrapT = THREE.ClampToEdgeWrapping;
    wfMipTexture.needsUpdate = true;

    wfMaterial.uniforms.uMipMinMax.value = wfMipTexture;
    wfMaterial.uniforms.uMipTextureWidth.value = parseFloat(mipTexWidth);
    wfMaterial.uniforms.uMipTextureHeight.value = parseFloat(mipTexHeight);
    wfMaterial.uniforms.uMipTotalBins.value = parseFloat(mipBins);

    wfLastUploadedSamples = samples;
    console.log(`Waveform uploaded: ${wfTotalSamples.toLocaleString()} samples (${wfTextureWidth}x${wfTextureHeight}), mip: ${mipBins.toLocaleString()} bins (${mipTexWidth}x${mipTexHeight})`);
}

/**
 * Render waveform via GPU with current viewport
 */
function renderWaveformGPU(viewportStart = 0.0, viewportEnd = 1.0) {
    if (!wfRenderer || !wfScene || !wfCamera || !wfSampleTexture) return;

    // Handle canvas resize using cached dimensions (no layout-forcing offsetWidth reads)
    const canvas = wfRenderer.domElement;
    if (wfCachedWidth > 0 && wfCachedHeight > 0 &&
        (canvas.width !== wfCachedWidth || canvas.height !== wfCachedHeight)) {
        canvas.width = wfCachedWidth;
        canvas.height = wfCachedHeight;
        wfRenderer.setSize(wfCachedWidth, wfCachedHeight, false);
        wfMaterial.uniforms.uCanvasWidth.value = parseFloat(wfCachedWidth);
        wfMaterial.uniforms.uCanvasHeight.value = parseFloat(wfCachedHeight);
        // Resize overlay to match
        if (wfOverlayCanvas) {
            wfOverlayCanvas.width = wfCachedWidth;
            wfOverlayCanvas.height = wfCachedHeight;
        }
    }

    wfMaterial.uniforms.uViewportStart.value = viewportStart;
    wfMaterial.uniforms.uViewportEnd.value = viewportEnd;

    // Update background color from colormap
    const lut = getColorLUT();
    if (lut) {
        wfMaterial.uniforms.uBackgroundColor.value.set(lut[0] / 255, lut[1] / 255, lut[2] / 255);
    }

    wfRenderer.render(wfScene, wfCamera);
}

/**
 * Render the minimap with the appropriate mode (spectrogram, linePlot, or both).
 * - spectrogram: render spectrogram pass only (reusing main spectrogram FFT texture)
 * - linePlot: render waveform amplitude pass only (existing GPU shader)
 * - both: render spectrogram first, then waveform on top with transparent background
 */
function renderMinimapWithMode(mode, viewportStart, viewportEnd) {
    if (!wfRenderer || !wfScene || !wfCamera) return;

    const showSpectrogram = (mode === 'spectrogram' || mode === 'both');
    const showWaveform = (mode === 'linePlot' || mode === 'both');

    // Update spectrogram mesh with current magnitude texture
    if (showSpectrogram && wfSpectroMaterial) {
        const magData = getFullMagnitudeTexture();
        if (magData) {
            wfSpectroMaterial.uniforms.uMagnitudes.value = magData.texture;
            wfSpectroMaterial.uniforms.uViewportStart.value = viewportStart;
            wfSpectroMaterial.uniforms.uViewportEnd.value = viewportEnd;

            // Sync frequency scale params from main spectrogram
            const params = getSpectrogramParams();
            wfSpectroMaterial.uniforms.uFrequencyScale.value = params.frequencyScale;
            wfSpectroMaterial.uniforms.uMinFreq.value = params.minFreq;
            wfSpectroMaterial.uniforms.uMaxFreq.value = params.maxFreq;
            wfSpectroMaterial.uniforms.uDbFloor.value = params.dbFloor;
            wfSpectroMaterial.uniforms.uDbRange.value = params.dbRange;
            wfSpectroMaterial.uniforms.uStretchFactor.value = 1.0; // minimap always 1x

            const lut = getColorLUT();
            if (lut) {
                wfSpectroMaterial.uniforms.uBackgroundColor.value.set(lut[0] / 255, lut[1] / 255, lut[2] / 255);
            }
        }
        wfSpectroMesh.visible = !!magData;
    } else if (wfSpectroMesh) {
        wfSpectroMesh.visible = false;
    }

    // Configure waveform mesh
    if (showWaveform && wfSampleTexture) {
        wfMesh.visible = true;
        wfMaterial.uniforms.uTransparentBg.value = mode === 'both' ? 1.0 : 0.0;
        wfMaterial.uniforms.uViewportStart.value = viewportStart;
        wfMaterial.uniforms.uViewportEnd.value = viewportEnd;
        const lut = getColorLUT();
        if (lut) {
            wfMaterial.uniforms.uBackgroundColor.value.set(lut[0] / 255, lut[1] / 255, lut[2] / 255);
        }
    } else {
        wfMesh.visible = false;
    }

    // Render order: spectrogram behind, waveform in front
    if (wfSpectroMesh) wfSpectroMesh.renderOrder = 0;
    wfMesh.renderOrder = 1;

    // Handle canvas resize
    const canvas = wfRenderer.domElement;
    if (wfCachedWidth > 0 && wfCachedHeight > 0 &&
        (canvas.width !== wfCachedWidth || canvas.height !== wfCachedHeight)) {
        canvas.width = wfCachedWidth;
        canvas.height = wfCachedHeight;
        wfRenderer.setSize(wfCachedWidth, wfCachedHeight, false);
        wfMaterial.uniforms.uCanvasWidth.value = parseFloat(wfCachedWidth);
        wfMaterial.uniforms.uCanvasHeight.value = parseFloat(wfCachedHeight);
        if (wfOverlayCanvas) {
            wfOverlayCanvas.width = wfCachedWidth;
            wfOverlayCanvas.height = wfCachedHeight;
        }
    }

    wfRenderer.render(wfScene, wfCamera);
}

/**
 * Rebuild waveform colormap texture (call after colormap change)
 */
export function rebuildWaveformColormapTexture() {
    if (wfColormapTexture) wfColormapTexture.dispose();
    wfColormapTexture = buildWaveformColormapTexture();
    if (wfMaterial) {
        wfMaterial.uniforms.uColormap.value = wfColormapTexture;
    }
    if (wfSpectroMaterial) {
        if (wfSpectroColormapTexture) wfSpectroColormapTexture.dispose();
        wfSpectroColormapTexture = buildSpectroColormapTexture();
        wfSpectroMaterial.uniforms.uColormap.value = wfSpectroColormapTexture;
    }
}

/**
 * Dispose all waveform Three.js resources (textures, material, geometry, observers)
 * Called during dataset switch to prevent memory leaks.
 */
export function clearWaveformRenderer() {
    // Dispose textures
    if (wfSampleTexture) { wfSampleTexture.dispose(); wfSampleTexture = null; }
    if (wfMipTexture) { wfMipTexture.dispose(); wfMipTexture = null; }
    if (wfColormapTexture) { wfColormapTexture.dispose(); wfColormapTexture = null; }

    // Dispose scene objects
    if (wfMesh) {
        wfMesh.geometry.dispose();
        if (wfScene) wfScene.remove(wfMesh);
        wfMesh = null;
    }
    if (wfMaterial) { wfMaterial.dispose(); wfMaterial = null; }

    // Dispose spectrogram minimap objects
    if (wfSpectroMesh) {
        wfSpectroMesh.geometry.dispose();
        if (wfScene) wfScene.remove(wfSpectroMesh);
        wfSpectroMesh = null;
    }
    if (wfSpectroMaterial) { wfSpectroMaterial.dispose(); wfSpectroMaterial = null; }
    if (wfSpectroColormapTexture) { wfSpectroColormapTexture.dispose(); wfSpectroColormapTexture = null; }

    // Disconnect observers
    if (wfResizeObserver) { wfResizeObserver.disconnect(); wfResizeObserver = null; }
    if (wfOverlayResizeObserver) { wfOverlayResizeObserver.disconnect(); wfOverlayResizeObserver = null; }

    // Remove WebGL context handlers
    if (wfRenderer && wfOnContextLost) {
        wfRenderer.domElement.removeEventListener('webglcontextlost', wfOnContextLost);
        wfRenderer.domElement.removeEventListener('webglcontextrestored', wfOnContextRestored);
        wfOnContextLost = null;
        wfOnContextRestored = null;
    }

    // Remove overlay canvas from DOM
    if (wfOverlayCanvas) {
        wfOverlayCanvas.remove();
        wfOverlayCanvas = null;
        wfOverlayCtx = null;
    }

    // Clean up spectrogram playhead overlay (owned by this render cycle)
    cleanupPlayheadOverlay();

    // Free raw/display waveform data copies (retained on window for de-trend filter)
    window.rawWaveformData = null;
    window.displayWaveformData = null;

    // Clear renderer but keep it (shares DOM canvas)
    if (wfRenderer) wfRenderer.clear();

    wfScene = null;
    wfCamera = null;
    wfTotalSamples = 0;
    wfTextureWidth = 0;
    wfTextureHeight = 0;
    wfCachedWidth = 0;
    wfCachedHeight = 0;
    wfLastUploadedSamples = null;
    // Null renderer so initWaveformThreeScene can re-create on next load
    wfRenderer = null;
}

/**
 * Get the waveform overlay canvas context (for regions, playhead, selection)
 */
export function getWaveformOverlayCtx() {
    return wfOverlayCtx;
}

/**
 * Get the waveform overlay canvas element
 */
export function getWaveformOverlayCanvas() {
    return wfOverlayCanvas;
}

/**
 * Check if we're in an EMIC windowed mode (scroll or page-turn, NOT region creation)
 */
function isEmicWindowedMode() {
    if (!window.__EMIC_STUDY_MODE) return false;
    const modeSelect = document.getElementById('viewingMode');
    return modeSelect && (modeSelect.value === 'static' || modeSelect.value === 'scroll' || modeSelect.value === 'pageTurn');
}

/**
 * Get the current minimap display mode ('spectrogram', 'linePlot', or 'both')
 */
function getMinimapMode() {
    const el = document.getElementById('miniMapView');
    return el ? el.value : 'linePlot';
}

// --- Minimap viewport drag state ---
let minimapDragging = false;
let minimapDragStartMs = 0;       // timestamp under cursor at drag start
let minimapViewStartMsAtDrag = 0; // viewport start at drag start
let minimapViewEndMsAtDrag = 0;   // viewport end at drag start
let minimapRafPending = false;

/**
 * Check if the minimap viewport indicator is visible (zoomed in within windowed mode)
 */
function isMinimapZoomed() {
    if (!isEmicWindowedMode()) return false;
    if (!zoomState.isInitialized() || !State.dataStartTime || !State.dataEndTime) return false;
    const dataStartMs = State.dataStartTime.getTime();
    const dataSpanMs = State.dataEndTime.getTime() - dataStartMs;
    if (dataSpanMs <= 0) return false;
    return true; // Always show viewport indicator in windowed mode
}

/**
 * Render spectrogram + overlays for minimap drag (rAF coalesced)
 */
function renderMinimapDragFrame() {
    minimapRafPending = false;
    drawWaveformFromMinMax();
    drawWaveformXAxis();
    updateSpectrogramViewportFromZoom();
    updateAllFeatureBoxPositions();
    updateCanvasAnnotations();
    drawSpectrogramPlayhead();
    drawDayMarkers();
}

/**
 * Compute viewport [0-1] range from current zoom state
 */
function getWaveformViewport() {
    // In EMIC windowed mode (scroll/page-turn), waveform is a navigation bar — always show full range
    // Region Creation mode keeps normal zoom behavior
    if (isEmicWindowedMode()) {
        return { start: 0, end: 1 };
    }

    const totalSamples = State.completeSamplesArray ? State.completeSamplesArray.length : 1;
    let startSample = 0;
    let endSample = totalSamples;

    if (zoomState.isInRegion()) {
        const regionRange = zoomState.getRegionRange();
        startSample = zoomState.originalToResampledSample(regionRange.startSample);
        endSample = zoomState.originalToResampledSample(regionRange.endSample);
    } else if (zoomState.isInitialized() && State.dataStartTime && State.dataEndTime) {
        // Support scroll-zoom: viewport timestamps may differ from full data range
        const dataStartMs = State.dataStartTime.getTime();
        const dataEndMs = State.dataEndTime.getTime();
        const dataSpanMs = dataEndMs - dataStartMs;
        if (dataSpanMs > 0) {
            const viewStartMs = zoomState.currentViewStartTime.getTime();
            const viewEndMs = zoomState.currentViewEndTime.getTime();
            const startFrac = (viewStartMs - dataStartMs) / dataSpanMs;
            const endFrac = (viewEndMs - dataStartMs) / dataSpanMs;
            startSample = Math.round(startFrac * totalSamples);
            endSample = Math.round(endFrac * totalSamples);
        }
    }

    return {
        start: startSample / totalSamples,
        end: endSample / totalSamples
    };
}

/**
 * Draw feature boxes on the minimap overlay — duplicates the red boxes from the spectrogram.
 * Maps feature time/frequency coordinates to minimap pixel space.
 */
function drawMinimapFeatureBoxes(ctx, width, height) {
    if (!window.__EMIC_STUDY_MODE) return;
    if (!State.dataStartTime || !State.dataEndTime) return;

    const regions = getRegions() || [];
    const standalone = getStandaloneFeatures();
    if (regions.length === 0 && standalone.length === 0) return;

    const dataStartMs = State.dataStartTime.getTime();
    const dataEndMs = State.dataEndTime.getTime();
    const dataSpanMs = dataEndMs - dataStartMs;
    if (dataSpanMs <= 0) return;

    const originalNyquist = State.originalDataFrequencyRange?.max || 50;
    const playbackRate = State.currentPlaybackRate || 1.0;
    const scaleType = State.frequencyScale || 'linear';

    // Determine time range for X mapping
    let mapStartMs = dataStartMs;
    let mapSpanMs = dataSpanMs;
    if (!isEmicWindowedMode() && zoomState.isInitialized()) {
        // Region Creation mode: map to current viewport
        mapStartMs = zoomState.currentViewStartTime.getTime();
        mapSpanMs = zoomState.currentViewEndTime.getTime() - mapStartMs;
        if (mapSpanMs <= 0) return;
    }

    // Helper to draw a single feature box on the minimap
    function drawOneMinimapFeature(feature) {
        if (!feature.lowFreq || !feature.highFreq || !feature.startTime || !feature.endTime) return;

        const lowFreq = parseFloat(feature.lowFreq);
        const highFreq = parseFloat(feature.highFreq);
        const fStartMs = new Date(feature.startTime).getTime();
        const fEndMs = new Date(feature.endTime).getTime();

        const leftX = ((fStartMs - mapStartMs) / mapSpanMs) * width;
        const rightX = ((fEndMs - mapStartMs) / mapSpanMs) * width;
        if (rightX < 0 || leftX > width) return;

        const lowFreqY = getYPositionForFrequencyScaled(lowFreq, originalNyquist, height, scaleType, playbackRate);
        const highFreqY = getYPositionForFrequencyScaled(highFreq, originalNyquist, height, scaleType, playbackRate);

        let x = Math.max(0, Math.min(leftX, rightX));
        let y = Math.min(highFreqY, lowFreqY);
        let w = Math.min(width, Math.max(leftX, rightX)) - x;
        let h = Math.abs(lowFreqY - highFreqY);

        if (w < 2) { x -= 1; w = 2; }
        if (h < 2) { const cy = y + h / 2; y = cy - 1; h = 2; }

        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = 'rgba(255, 68, 68, 0.2)';
        ctx.fillRect(x, y, w, h);

        // No number labels on minimap — too small to be useful
    }

    // Draw region-based features
    for (const region of regions) {
        if (!region.features) continue;
        region.features.forEach((feature) => {
            drawOneMinimapFeature(feature);
        });
    }

    // Draw standalone features (reuse variable from top of function)
    standalone.forEach((feature) => {
        drawOneMinimapFeature(feature);
    });
}

/**
 * Draw overlays (regions, playhead, selection) on the transparent overlay canvas
 */
function drawWaveformOverlays() {
    if (!wfOverlayCtx || !wfOverlayCanvas) return;
    const width = wfOverlayCanvas.width;
    const height = wfOverlayCanvas.height;
    wfOverlayCtx.clearRect(0, 0, width, height);

    // Detect if we're in EMIC windowed mode AND actually scroll-zoomed to a sub-range
    let isEmicScrollZoomed = false;
    if (isEmicWindowedMode() && zoomState.isInitialized()
        && State.dataStartTime && State.dataEndTime) {
        const dataStartMs = State.dataStartTime.getTime();
        const dataEndMs = State.dataEndTime.getTime();
        const dataSpanMs = dataEndMs - dataStartMs;
        if (dataSpanMs > 0) {
            const viewStartMs = zoomState.currentViewStartTime.getTime();
            const viewEndMs = zoomState.currentViewEndTime.getTime();
            const viewStartFrac = (viewStartMs - dataStartMs) / dataSpanMs;
            const viewEndFrac = (viewEndMs - dataStartMs) / dataSpanMs;
            isEmicScrollZoomed = true;

            // Draw viewport indicator in windowed mode
            {
                const leftX = viewStartFrac * width;
                const rightX = viewEndFrac * width;
                const r = 3; // Match canvas border-radius
                const edge = 2; // Threshold: if within 2px of canvas edge, no rounding on that side

                // Per-corner radii: [top-left, top-right, bottom-right, bottom-left]
                const rTL = leftX > edge ? r : 0;
                const rTR = (width - rightX) > edge ? r : 0;
                const rBR = (width - rightX) > edge ? r : 0;
                const rBL = leftX > edge ? r : 0;
                const radii = [rTL, rTR, rBR, rBL];

                // Dim areas outside viewport using clipping with rounded rect cutout
                wfOverlayCtx.save();
                wfOverlayCtx.beginPath();
                wfOverlayCtx.rect(0, 0, width, height);
                // Cut out rounded viewport rect (reverse winding for hole)
                wfOverlayCtx.roundRect(leftX, 0, rightX - leftX, height, radii);
                wfOverlayCtx.fillStyle = 'rgba(0, 0, 0, 0.3)';
                wfOverlayCtx.fill('evenodd');
                wfOverlayCtx.restore();

                // Light fill inside viewport (rounded)
                wfOverlayCtx.beginPath();
                wfOverlayCtx.roundRect(leftX, 0, rightX - leftX, height, radii);
                wfOverlayCtx.fillStyle = 'rgba(255, 255, 255, 0.15)';
                wfOverlayCtx.fill();

                // White border around viewport (rounded)
                wfOverlayCtx.beginPath();
                wfOverlayCtx.roundRect(leftX + 0.5, 0.5, rightX - leftX - 1, height - 1, radii);
                wfOverlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
                wfOverlayCtx.lineWidth = 1.5;
                wfOverlayCtx.stroke();
            }
        }
    }

    // Feature boxes on minimap (red boxes duplicated from spectrogram)
    drawMinimapFeatureBoxes(wfOverlayCtx, width, height);

    // Region highlights: hide entirely in windowed modes (scroll/pageTurn), show in region creation mode
    if (!isEmicWindowedMode()) {
        drawRegionHighlights(wfOverlayCtx, width, height);
        drawRegionButtons();
    }

    // Selection box
    if (State.selectionStart !== null && State.selectionEnd !== null && !isPlayingActiveRegion()) {
        let startX, endX;
        if (isEmicScrollZoomed) {
            // Minimap: always map to full range
            const startProgress = State.selectionStart / State.totalAudioDuration;
            const endProgress = State.selectionEnd / State.totalAudioDuration;
            startX = startProgress * width;
            endX = endProgress * width;
        } else if (zoomState.isInitialized()) {
            const startSample = zoomState.timeToSample(State.selectionStart);
            const endSample = zoomState.timeToSample(State.selectionEnd);
            startX = zoomState.sampleToPixel(startSample, width);
            endX = zoomState.sampleToPixel(endSample, width);
        } else {
            const startProgress = State.selectionStart / State.totalAudioDuration;
            const endProgress = State.selectionEnd / State.totalAudioDuration;
            startX = startProgress * width;
            endX = endProgress * width;
        }
        const selectionWidth = endX - startX;
        wfOverlayCtx.fillStyle = 'rgba(255, 220, 120, 0.25)';
        wfOverlayCtx.fillRect(startX, 0, selectionWidth, height);

        wfOverlayCtx.strokeStyle = 'rgba(255, 180, 100, 0.6)';
        wfOverlayCtx.lineWidth = 2;
        wfOverlayCtx.beginPath();
        wfOverlayCtx.moveTo(startX, 0);
        wfOverlayCtx.lineTo(startX, height);
        wfOverlayCtx.moveTo(endX, 0);
        wfOverlayCtx.lineTo(endX, height);
        wfOverlayCtx.stroke();
    }

    // Playhead
    let playheadPosition = State.isSelecting && State.selectionStart !== null
        ? State.selectionStart : State.currentAudioPosition;

    if (playheadPosition !== null && State.totalAudioDuration > 0 && playheadPosition >= 0) {
        let x;
        if (isEmicScrollZoomed) {
            // Minimap: always map to full range
            const progress = Math.min(playheadPosition / State.totalAudioDuration, 1.0);
            x = progress * width;
        } else if (isZoomTransitionInProgress && zoomState.isInitialized()) {
            const sample = zoomState.timeToSample(playheadPosition);
            const playheadTimestamp = zoomState.sampleToRealTimestamp(sample);
            if (playheadTimestamp) {
                const interpolatedRange = getInterpolatedTimeRange();
                const interpStartMs = interpolatedRange.startTime.getTime();
                const interpEndMs = interpolatedRange.endTime.getTime();
                const timeDiff = interpEndMs - interpStartMs;
                if (timeDiff > 0) {
                    x = ((playheadTimestamp.getTime() - interpStartMs) / timeDiff) * width;
                }
            }
        } else if (zoomState.isInitialized()) {
            const sample = zoomState.timeToSample(playheadPosition);
            x = zoomState.sampleToPixel(sample, width);
        } else {
            const progress = Math.min(playheadPosition / State.totalAudioDuration, 1.0);
            x = progress * width;
        }

        if (x !== undefined && isFinite(x) && x >= 0 && x <= width) {
            const time = performance.now() * 0.001;
            const pulseIntensity = 0.3 + Math.sin(time * 3) * 0.1;

            wfOverlayCtx.shadowBlur = 8;
            wfOverlayCtx.shadowColor = 'rgba(255, 0, 0, 0.6)';

            const gradient = wfOverlayCtx.createLinearGradient(x, 0, x, height);
            gradient.addColorStop(0, `rgba(255, 100, 100, ${0.9 + pulseIntensity})`);
            gradient.addColorStop(0.5, `rgba(255, 0, 0, ${0.95 + pulseIntensity})`);
            gradient.addColorStop(1, `rgba(255, 100, 100, ${0.9 + pulseIntensity})`);

            wfOverlayCtx.strokeStyle = gradient;
            wfOverlayCtx.lineWidth = 3;
            wfOverlayCtx.beginPath();
            wfOverlayCtx.moveTo(x, 0);
            wfOverlayCtx.lineTo(x, height);
            wfOverlayCtx.stroke();

            wfOverlayCtx.shadowBlur = 0;
            wfOverlayCtx.strokeStyle = `rgba(220, 220, 220, ${(0.25 + pulseIntensity * 0.15) * 0.72})`;
            wfOverlayCtx.lineWidth = 1;
            wfOverlayCtx.beginPath();
            wfOverlayCtx.moveTo(x, 0);
            wfOverlayCtx.lineTo(x, height);
            wfOverlayCtx.stroke();

            wfOverlayCtx.shadowBlur = 0;
            wfOverlayCtx.shadowColor = 'transparent';
        }
    }
}

// Mobile tap hint overlay
let mobileTapOverlay = null;

/**
 * Show "Tap here" overlay on waveform for mobile users who haven't tapped yet
 */
export function showMobileTapHint() {
    // Only show on touch devices and if user hasn't tapped before
    if (!isTouchDevice) return;
    if (localStorage.getItem('userHasTappedWaveformMobile') === 'true') return;

    const waveformCanvas = document.getElementById('waveform');
    if (!waveformCanvas) return;

    // Create overlay if it doesn't exist
    if (!mobileTapOverlay) {
        mobileTapOverlay = document.createElement('div');
        mobileTapOverlay.id = 'mobileTapOverlay';
        mobileTapOverlay.innerHTML = '👆 Tap here to jump';

        // Get waveform position relative to parent to position overlay correctly
        const waveformRect = waveformCanvas.getBoundingClientRect();
        const parentRect = waveformCanvas.parentElement.getBoundingClientRect();
        const topOffset = (waveformRect.top - parentRect.top) + (waveformRect.height / 2);

        mobileTapOverlay.style.cssText = `
            position: absolute;
            top: ${topOffset}px;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.7);
            color: #fff;
            padding: 12px 24px;
            border-radius: 25px;
            font-size: 16px;
            font-weight: 600;
            pointer-events: none;
            z-index: 100;
            animation: pulse-hint 2s ease-in-out infinite;
            border: 2px solid rgba(102, 126, 234, 0.5);
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.3);
        `;

        // Add to waveform's parent (panel-visualization)
        const parent = waveformCanvas.parentElement;
        if (parent) {
            parent.style.position = 'relative';
            parent.appendChild(mobileTapOverlay);
        }
    }

    mobileTapOverlay.style.display = 'block';
}

/**
 * Hide the mobile tap hint overlay
 */
export function hideMobileTapHint() {
    if (mobileTapOverlay) {
        mobileTapOverlay.style.display = 'none';
    }
    // Remember that user has tapped
    localStorage.setItem('userHasTappedWaveformMobile', 'true');
}

// Playhead log throttling (log every 500ms unless forced by user interaction)
let lastPlayheadLogTime = 0;
let lastDrawWaveformLogTime = 0;
let forceNextPlayheadLog = false;

// Color LUT for waveform - brighter version of spectrogram colormap
let waveformColorLUT = null;

/**
 * Build waveform color LUT from the current spectrogram colormap
 * Applies brightness adjustment to make waveform visible on dark background
 */
export function buildWaveformColorLUT() {
    const spectrogramLUT = getColorLUT();
    waveformColorLUT = new Uint8ClampedArray(256 * 3);

    for (let i = 0; i < 256; i++) {
        // Get the spectrogram color
        let r = spectrogramLUT[i * 3];
        let g = spectrogramLUT[i * 3 + 1];
        let b = spectrogramLUT[i * 3 + 2];

        // Apply brightness boost for waveform visibility
        // Blend toward white/brighter version (60% original + 40% boosted)
        const boost = 0.4;
        const minBrightness = 150; // Ensure minimum brightness for visibility

        r = Math.min(255, Math.round(r + (255 - r) * boost));
        g = Math.min(255, Math.round(g + (255 - g) * boost));
        b = Math.min(255, Math.round(b + (255 - b) * boost));

        // Ensure minimum brightness
        const brightness = (r + g + b) / 3;
        if (brightness < minBrightness) {
            const factor = minBrightness / Math.max(brightness, 1);
            r = Math.min(255, Math.round(r * factor));
            g = Math.min(255, Math.round(g * factor));
            b = Math.min(255, Math.round(b * factor));
        }

        waveformColorLUT[i * 3] = r;
        waveformColorLUT[i * 3 + 1] = g;
        waveformColorLUT[i * 3 + 2] = b;
    }

    // console.log('🌊 Built waveform color LUT from current colormap');
}

// Initialize color LUT on module load
buildWaveformColorLUT();

/**
 * Get background color from the current colormap (darkest value at index 0)
 * Returns a CSS color string
 */
function getWaveformBackgroundColor() {
    const lut = getColorLUT();
    // Use index 0 (darkest color in the colormap)
    const r = lut[0];
    const g = lut[1];
    const b = lut[2];
    return `rgb(${r}, ${g}, ${b})`;
}

// Helper functions
function removeDCOffset(data, alpha = 0.995) {
    const n = data.length;
    if (n === 0) return new Float32Array(0);

    // Warmup: compute local average at each edge so the EMA starts settled
    // Window = 3x time constant (tau = 1/(1-alpha))
    const warmup = Math.min(n, Math.ceil(3 / (1 - alpha)));

    let initFwd = 0;
    for (let i = 0; i < warmup; i++) initFwd += data[i];
    initFwd /= warmup;

    let initBwd = 0;
    for (let i = n - warmup; i < n; i++) initBwd += data[i];
    initBwd /= warmup;

    // Forward pass: EMA from left to right
    const fwd = new Float32Array(n);
    let mean = initFwd;
    for (let i = 0; i < n; i++) {
        mean = alpha * mean + (1 - alpha) * data[i];
        fwd[i] = mean;
    }

    // Backward pass: EMA from right to left
    const bwd = new Float32Array(n);
    mean = initBwd;
    for (let i = n - 1; i >= 0; i--) {
        mean = alpha * mean + (1 - alpha) * data[i];
        bwd[i] = mean;
    }

    // Subtract averaged forward+backward mean (zero-phase)
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        y[i] = data[i] - (fwd[i] + bwd[i]) * 0.5;
    }

    // Cosine taper at edges to kill any residual boundary artifacts
    const taperLen = Math.min(Math.ceil(n * 0.001), warmup, Math.floor(n / 2));
    for (let i = 0; i < taperLen; i++) {
        const w = 0.5 * (1 - Math.cos(Math.PI * i / taperLen));
        y[i] *= w;
        y[n - 1 - i] *= w;
    }

    return y;
}

function normalize(data) {
    // Find the peak absolute value to scale symmetrically around zero
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
        const abs = data[i] < 0 ? -data[i] : data[i];
        if (abs > peak) peak = abs;
    }

    if (peak === 0) {
        return new Float32Array(data.length);
    }

    const normalized = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
        normalized[i] = data[i] / peak;
    }

    return normalized;
}

export function drawWaveform() {
    if (!State.completeSamplesArray || State.completeSamplesArray.length === 0) {
        console.log(`⚠️ drawWaveform() aborted: no data`);
        return;
    }

    const canvas = document.getElementById('waveform');
    if (!canvas) {
        console.log(`⚠️ drawWaveform() aborted: canvas not found`);
        return;
    }

    // Use original sample rate from metadata, NOT AudioContext rate
    const sampleRate = State.currentMetadata?.original_sample_rate || 50;
    State.setTotalAudioDuration(State.completeSamplesArray.length / sampleRate);

    // Upload samples to GPU texture (the shader handles everything)
    uploadWaveformSamples(State.completeSamplesArray);

    // Compute viewport from zoom state and render with current minimap mode
    const viewport = getWaveformViewport();
    const mode = getMinimapMode();
    renderMinimapWithMode(mode, viewport.start, viewport.end);

    // Draw axes
    positionWaveformAxisCanvas();
    drawWaveformAxis();
    positionWaveformXAxisCanvas();
    drawWaveformXAxis();
    positionWaveformDateCanvas();
    drawWaveformDate();

    // Draw overlays (regions, playhead)
    drawWaveformOverlays();

    // Render regions
    renderRegionsAfterCrossfade();

    // Mobile tap hint
    showMobileTapHint();
}

export function drawWaveformFromMinMax() {
    // GPU path: just re-render with current viewport
    if (!wfRenderer || !wfSampleTexture) {
        // Fallback: if GPU not initialized yet, trigger full drawWaveform
        if (State.completeSamplesArray && State.completeSamplesArray.length > 0) {
            drawWaveform();
        }
        return;
    }

    const viewport = getWaveformViewport();
    const mode = getMinimapMode();
    renderMinimapWithMode(mode, viewport.start, viewport.end);

    // Draw axes
    positionWaveformAxisCanvas();
    drawWaveformAxis();
    positionWaveformXAxisCanvas();
    drawWaveformXAxis();
    positionWaveformDateCanvas();
    drawWaveformDate();

    // Overlays
    drawWaveformOverlays();
    renderRegionsAfterCrossfade();
    showMobileTapHint();
}

/**
 * Draw waveform with smooth zoom interpolation during transitions.
 * GPU path: compute interpolated viewport from timestamp range, render.
 */
export function drawInterpolatedWaveform() {
    if (!wfRenderer || !wfSampleTexture) return;
    if (!State.dataStartTime || !State.dataEndTime) return;

    const interpolatedRange = getInterpolatedTimeRange();
    if (!interpolatedRange) return;

    const dataStartMs = State.dataStartTime.getTime();
    const dataEndMs = State.dataEndTime.getTime();
    const dataDurationMs = dataEndMs - dataStartMs;
    if (dataDurationMs <= 0) return;

    const interpStartMs = interpolatedRange.startTime.getTime();
    const interpEndMs = interpolatedRange.endTime.getTime();

    // Map interpolated time range to [0-1] sample viewport
    const viewportStart = (interpStartMs - dataStartMs) / dataDurationMs;
    const viewportEnd = (interpEndMs - dataStartMs) / dataDurationMs;

    const mode = getMinimapMode();
    renderMinimapWithMode(mode, viewportStart, viewportEnd);

    // Overlays track the same interpolated range
    drawWaveformOverlays();
}

export function drawWaveformWithSelection() {
    // GPU waveform is already rendered — just redraw overlays
    drawWaveformOverlays();
}

export function setupWaveformInteraction() {
    const canvas = document.getElementById('waveform');
    if (!canvas) return;
    
    function getPositionFromMouse(event) {
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const progress = Math.max(0, Math.min(1, x / rect.width)); // Still needed for canvas pixel positioning

        // 🙏 Timestamps as source of truth: Convert pixel to timestamp, then to seconds
        // Flow: pixel → timestamp (source of truth) → seconds (working units)
        let targetPosition;
        if (isEmicWindowedMode() || !zoomState.isInitialized()) {
            // EMIC minimap (scroll/page-turn): waveform shows full range, click maps to full duration
            targetPosition = progress * State.totalAudioDuration;
        } else {
            const timestamp = zoomState.pixelToTimestamp(x, rect.width);
            targetPosition = zoomState.timestampToSeconds(timestamp);
        }

        return { targetPosition, progress, x, width: rect.width };
    }
    
    function updateScrubPreview(event) {
        if (!State.completeSamplesArray || !State.totalAudioDuration) return;
        
        const { targetPosition, progress } = getPositionFromMouse(event);
        State.setScrubTargetPosition(targetPosition);

        // Draw scrub preview on overlay canvas
        if (wfOverlayCtx && wfOverlayCanvas) {
            const ctx = wfOverlayCtx;
            const canvasWidth = wfOverlayCanvas.width;
            const canvasHeight = wfOverlayCanvas.height;
            const canvasX = progress * canvasWidth;

            // Clear and redraw overlays + scrub line
            drawWaveformOverlays();

            if (isFinite(canvasX) && canvasX >= 0 && canvasX <= canvasWidth) {
                const time = performance.now() * 0.001;
                const pulseIntensity = State.isDragging ? 0.1 : 0.2 + Math.sin(time * 3) * 0.1;

                ctx.shadowBlur = State.isDragging ? 4 : 6;
                ctx.shadowColor = State.isDragging ? 'rgba(187, 187, 187, 0.36)' : 'rgba(255, 0, 0, 0.45)';

                const gradient = ctx.createLinearGradient(canvasX, 0, canvasX, canvasHeight);
                if (State.isDragging) {
                    gradient.addColorStop(0, `rgba(200, 200, 200, ${(0.5 + pulseIntensity) * 0.9})`);
                    gradient.addColorStop(0.5, `rgba(187, 187, 187, ${(0.6 + pulseIntensity) * 0.9})`);
                    gradient.addColorStop(1, `rgba(200, 200, 200, ${(0.5 + pulseIntensity) * 0.9})`);
                } else {
                    gradient.addColorStop(0, `rgba(255, 100, 100, ${(0.7 + pulseIntensity) * 0.9})`);
                    gradient.addColorStop(0.5, `rgba(255, 0, 0, ${(0.8 + pulseIntensity) * 0.9})`);
                    gradient.addColorStop(1, `rgba(255, 100, 100, ${(0.7 + pulseIntensity) * 0.9})`);
                }

                ctx.strokeStyle = gradient;
                ctx.lineWidth = 2.5;
                ctx.globalAlpha = 0.9;
                ctx.beginPath();
                ctx.moveTo(canvasX, 0);
                ctx.lineTo(canvasX, canvasHeight);
                ctx.stroke();

                ctx.shadowBlur = 0;
                ctx.strokeStyle = `rgba(255, 255, 255, ${(0.3 + pulseIntensity * 0.2) * 0.9})`;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(canvasX, 0);
                ctx.lineTo(canvasX, canvasHeight);
                ctx.stroke();
                ctx.globalAlpha = 1.0;

                ctx.shadowBlur = 0;
                ctx.shadowColor = 'transparent';
            }
        }

        // Mirror on spectrogram
        drawSpectrogramScrubPreview(targetPosition, State.isDragging);
    }
    
    function performSeek() {
        if (!State.completeSamplesArray || !State.totalAudioDuration) {
            console.log('⏸️ Seeking disabled - no audio data loaded');
            return;
        }
        
        if (State.scrubTargetPosition !== null) {
            console.log(`🖱️ Mouse released - seeking to ${State.scrubTargetPosition.toFixed(2)}s`);
            forceNextPlayheadLog = true; // Force log on next playhead draw (user interaction)
            
            let clampedPosition = State.scrubTargetPosition;
            if (State.selectionStart !== null && State.selectionEnd !== null) {
                clampedPosition = Math.max(State.selectionStart, Math.min(State.scrubTargetPosition, State.selectionEnd));
            }
            State.setCurrentAudioPosition(clampedPosition);
            if (State.audioContext) {
                State.setLastUpdateTime(State.audioContext.currentTime);
            }
            
            drawWaveformWithSelection();
            drawSpectrogramPlayhead();  // Update spectrogram immediately
            seekToPosition(State.scrubTargetPosition, true); // Always start playback when clicking
            State.setScrubTargetPosition(null);
        }
    }
    
    canvas.addEventListener('mousedown', (e) => {
        if (!State.completeSamplesArray || State.totalAudioDuration === 0) return;
        
        // Hide any existing "Add Region" button when starting a new selection
        hideAddRegionButton();
        
        // 🔥 FIX: Resolve tutorial promise FIRST (before any early returns)
        // This ensures the tutorial progresses even if clicks are disabled
        if (State._waveformClickResolve) {
            console.log('🎯 Waveform clicked: Resolving promise');
            State._waveformClickResolve();
            State.setWaveformClickResolve(null);
        }
        
        // 🔒 SAFETY: Always clear pulse and overlay when canvas is clicked (regardless of flag state)
        // This prevents stuck highlighting if user skipped with Enter key first
        canvas.classList.remove('pulse');
        // Also remove pulse from waveform container (used for post-fetch guidance)
        const waveformContainer = document.getElementById('waveform');
        if (waveformContainer) {
            waveformContainer.classList.remove('pulse');
        }
        // Show next guidance message after first waveform click (2 second delay)
        // Skip for shared sessions and returning users
        const isSharedSession = sessionStorage.getItem('isSharedSession') === 'true';
        const userHasClickedWaveformOnce = localStorage.getItem('userHasClickedWaveformOnce') === 'true';
        if (!State.waveformHasBeenClicked && !isSharedSession && !userHasClickedWaveformOnce) {
            setTimeout(async () => {
                const statusDiv = document.getElementById('status');
                if (statusDiv) {
                    statusDiv.className = 'status info';
                    const { typeText } = await import('./tutorial-effects.js');
                    typeText(statusDiv, 'Now click and drag to create a new region.', 30, 10);
                }
            }, 2000);
        }
        hideTutorialOverlay();
        
        // Mark waveform as clicked (if not already marked)
        if (!State.waveformHasBeenClicked) {
            State.setWaveformHasBeenClicked(true);
        }
        // Persist for returning users (separate from tutorial State variable)
        localStorage.setItem('userHasClickedWaveformOnce', 'true');
        
        // Check if waveform clicks are disabled (during tutorial flow)
        // After resolving promise, we can return early for actual seek behavior
        if (canvas.style.pointerEvents === 'none') {
            return; // Clicks disabled during spectrogram explanation
        }
        
        const rect = canvas.getBoundingClientRect();
        const startX = e.clientX - rect.left;
        const startY = e.clientY - rect.top;
        
        // 🔍 DIAGNOSTIC: Log click context
        const waveformCanvas = document.getElementById('waveform');
        const buttonsCanvas = document.getElementById('waveform-buttons');
        
        // console.log('🖱️ CLICK DIAGNOSTICS:');
        // console.log(`  Click position: (${startX.toFixed(1)}, ${startY.toFixed(1)}) CSS pixels`);
        // console.log(`  Click % across: ${((startX / rect.width) * 100).toFixed(1)}%`);
        // console.log(`  Waveform canvas: ${waveformCanvas.offsetWidth}px × ${waveformCanvas.offsetHeight}px (CSS)`);
        // console.log(`  Waveform canvas: ${waveformCanvas.width}px × ${waveformCanvas.height}px (device)`);
        // if (buttonsCanvas) {
        //     console.log(`  Buttons canvas: ${buttonsCanvas.width}px × ${buttonsCanvas.height}px (device)`);
        // }
        // console.log(`  DPR: ${window.devicePixelRatio}`);
        
        // 🔧 FIX: Check if click is on a canvas button BEFORE starting scrub preview
        // This prevents the white playhead from appearing when clicking buttons
        // BUT: Only check if we're not already dragging/selecting (to avoid false positives)
        if (!State.isDragging && !State.isSelecting && State.selectionStartX === null) {
            const clickedZoomRegionIndex = checkCanvasZoomButtonClick(startX, startY);
            const clickedPlayRegionIndex = checkCanvasPlayButtonClick(startX, startY);
            
            // console.log(`  Zoom button hit: ${clickedZoomRegionIndex !== null ? `Region ${clickedZoomRegionIndex + 1}` : 'none'}`);
            // console.log(`  Play button hit: ${clickedPlayRegionIndex !== null ? `Region ${clickedPlayRegionIndex + 1}` : 'none'}`);
            
            // 🔥 Check if region buttons are disabled (during tutorial)
            if (State.regionButtonsDisabled && (clickedZoomRegionIndex !== null || clickedPlayRegionIndex !== null)) {
                e.stopPropagation();
                e.preventDefault();
                return; // Ignore clicks on disabled buttons
            }
            
            if (clickedZoomRegionIndex !== null || clickedPlayRegionIndex !== null) {
                // Clicked on a button - don't start dragging/scrub preview
                // The button action will be handled in mouseup, but we prevent the scrub preview here
                e.stopPropagation();
                e.preventDefault();
                return; // Don't process as normal waveform click
            }
        }
        
        // --- Minimap viewport drag: intercept in windowed mode when zoomed ---
        if (isMinimapZoomed()) {
            minimapDragging = true;
            pageTurnUserDragged = true; // User manually moved viewport — break page-turn catch
            pageTurnPlayheadWasInView = false; // Reset — must see playhead enter viewport before re-engaging
            canvas.style.cursor = 'grabbing';
            const dataStartMs = State.dataStartTime.getTime();
            const dataEndMs = State.dataEndTime.getTime();
            const dataSpanMs = dataEndMs - dataStartMs;
            const frac = Math.max(0, Math.min(1, startX / rect.width));
            const clickMs = dataStartMs + frac * dataSpanMs;

            // If click is outside the current viewport box, snap-center on click point
            const viewStartMs = zoomState.currentViewStartTime.getTime();
            const viewEndMs = zoomState.currentViewEndTime.getTime();
            if (clickMs < viewStartMs || clickMs > viewEndMs) {
                const viewSpanMs = viewEndMs - viewStartMs;
                let newStart = clickMs - viewSpanMs / 2;
                let newEnd = clickMs + viewSpanMs / 2;
                // Clamp to data bounds
                if (newStart < dataStartMs) { newStart = dataStartMs; newEnd = dataStartMs + viewSpanMs; }
                if (newEnd > dataEndMs) { newEnd = dataEndMs; newStart = dataEndMs - viewSpanMs; }
                zoomState.currentViewStartTime = new Date(newStart);
                zoomState.currentViewEndTime = new Date(newEnd);
                // Render the snap immediately
                if (!minimapRafPending) {
                    minimapRafPending = true;
                    requestAnimationFrame(renderMinimapDragFrame);
                }
            }

            minimapDragStartMs = clickMs;
            minimapViewStartMsAtDrag = zoomState.currentViewStartTime.getTime();
            minimapViewEndMsAtDrag = zoomState.currentViewEndTime.getTime();

            // Attach document-level listeners so drag continues outside canvas
            function onDocMouseMove(ev) {
                if (!minimapDragging) return;
                const r = canvas.getBoundingClientRect();
                const dStartMs = State.dataStartTime.getTime();
                const dEndMs = State.dataEndTime.getTime();
                const dSpanMs = dEndMs - dStartMs;
                const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
                const cMs = dStartMs + f * dSpanMs;
                const delta = cMs - minimapDragStartMs;

                const vSpan = minimapViewEndMsAtDrag - minimapViewStartMsAtDrag;
                let ns = minimapViewStartMsAtDrag + delta;
                let ne = minimapViewEndMsAtDrag + delta;
                if (ns < dStartMs) { ns = dStartMs; ne = dStartMs + vSpan; }
                if (ne > dEndMs) { ne = dEndMs; ns = dEndMs - vSpan; }

                zoomState.currentViewStartTime = new Date(ns);
                zoomState.currentViewEndTime = new Date(ne);

                if (!minimapRafPending) {
                    minimapRafPending = true;
                    requestAnimationFrame(renderMinimapDragFrame);
                }
            }
            function onDocMouseUp(ev) {
                minimapDragging = false;
                canvas.style.cursor = 'pointer';
                document.removeEventListener('mousemove', onDocMouseMove);
                document.removeEventListener('mouseup', onDocMouseUp);

                // "Move & play": seek playhead to release position and start playback
                const navClickEl = document.getElementById('navBarClick');
                if (navClickEl && navClickEl.value === 'moveAndPlay') {
                    const r = canvas.getBoundingClientRect();
                    const dStartMs = State.dataStartTime.getTime();
                    const dEndMs = State.dataEndTime.getTime();
                    const dSpanMs = dEndMs - dStartMs;
                    const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
                    const releaseMs = dStartMs + f * dSpanMs;
                    const positionSeconds = (releaseMs - dStartMs) / 1000;
                    seekToPosition(positionSeconds, true);
                }
            }
            document.addEventListener('mousemove', onDocMouseMove);
            document.addEventListener('mouseup', onDocMouseUp);

            e.preventDefault();
            return;
        }

        // Normal waveform interaction - start selection/drag
        State.setSelectionStartX(startX);
        State.setIsDragging(true);
        canvas.style.cursor = 'grabbing';
        updateScrubPreview(e);
        // console.log('🖱️ Mouse down - waiting to detect drag vs click');
    });
    
    canvas.addEventListener('mousemove', (e) => {
        // Minimap viewport drag is handled by document-level listeners
        if (minimapDragging) return;

        if (State.isDragging && State.selectionStartX !== null) {
            const rect = canvas.getBoundingClientRect();
            const currentX = e.clientX - rect.left;
            const dragDistance = Math.abs(currentX - State.selectionStartX);
            
            if (dragDistance > 3 && !State.isSelecting) {
                State.setIsSelecting(true);
                canvas.style.cursor = 'col-resize';
                console.log('📏 Selection drag detected');

                // 🏛️ Only clear active region if NOT inside a region (outside the temple)
                // Inside the temple, selections are within sacred walls, flag stays up
                if (!zoomState.isInRegion()) {
                    clearActiveRegion();
                }
            }
            
            if (State.isSelecting) {
                const { targetPosition } = getPositionFromMouse(e);
                const rect = canvas.getBoundingClientRect();

                // 🙏 Timestamps as source of truth: Convert start pixel to timestamp, then to seconds
                let startPos;
                if (zoomState.isInitialized()) {
                    const startTimestamp = zoomState.pixelToTimestamp(State.selectionStartX, rect.width);
                    startPos = zoomState.timestampToSeconds(startTimestamp);
                } else {
                    // Fallback to old behavior if zoom state not initialized
                    const startProgress = Math.max(0, Math.min(1, State.selectionStartX / rect.width));
                    startPos = startProgress * State.totalAudioDuration;
                }
                const endPos = targetPosition;

                State.setSelectionStart(Math.min(startPos, endPos));
                State.setSelectionEnd(Math.max(startPos, endPos));

                drawWaveformWithSelection();

                // Draw selection box directly on overlay (backup — ensures visibility during drag)
                if (wfOverlayCtx && wfOverlayCanvas) {
                    const dpr = window.devicePixelRatio || 1;
                    const ox = Math.min(State.selectionStartX, e.clientX - rect.left) * dpr;
                    const ow = Math.abs((e.clientX - rect.left) - State.selectionStartX) * dpr;
                    const oh = wfOverlayCanvas.height;
                    wfOverlayCtx.fillStyle = 'rgba(255, 220, 120, 0.25)';
                    wfOverlayCtx.fillRect(ox, 0, ow, oh);
                    wfOverlayCtx.strokeStyle = 'rgba(255, 180, 100, 0.6)';
                    wfOverlayCtx.lineWidth = 2;
                    wfOverlayCtx.beginPath();
                    wfOverlayCtx.moveTo(ox, 0);
                    wfOverlayCtx.lineTo(ox, oh);
                    wfOverlayCtx.moveTo(ox + ow, 0);
                    wfOverlayCtx.lineTo(ox + ow, oh);
                    wfOverlayCtx.stroke();
                }
            } else {
                updateScrubPreview(e);
            }
        }
    });
    
    canvas.addEventListener('mouseup', (e) => {
        // Minimap viewport drag is handled by document-level listeners
        if (minimapDragging) return;

        // 🔧 FIX: Check for button clicks even when not dragging
        // (in case we returned early from mousedown to prevent scrub preview)
        const rect = canvas.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;
        const clickedZoomRegionIndex = checkCanvasZoomButtonClick(clickX, clickY);
        const clickedPlayRegionIndex = checkCanvasPlayButtonClick(clickX, clickY);
        
        // 🔥 Check if region buttons are disabled (during tutorial)
        if (State.regionButtonsDisabled) {
            if (clickedZoomRegionIndex !== null) {
                // Check if this specific zoom button is enabled for tutorial
                if (!State.isRegionZoomButtonEnabled(clickedZoomRegionIndex)) {
                    return; // Ignore clicks on disabled buttons
                }
            }
            if (clickedPlayRegionIndex !== null) {
                // Check if this specific play button is enabled for tutorial
                if (!State.isRegionPlayButtonEnabled(clickedPlayRegionIndex)) {
                    return; // Ignore clicks on disabled buttons
                }
            }
        }
        
        if (clickedZoomRegionIndex !== null) {
            // Clicked on a zoom button - handle zoom
            e.stopPropagation();
            e.preventDefault();
            
            // Clear any dragging state
            State.setIsDragging(false);
            canvas.style.cursor = 'pointer';
            
            const regions = getRegions();
            const region = regions[clickedZoomRegionIndex];
            
            if (region) {
                // Check if we're already inside THIS temple
                if (zoomState.isInRegion() && zoomState.getCurrentRegionId() === region.id) {
                    // We're inside - exit the temple and return to full view
                    zoomToFull();
                } else {
                    // Zoom into this region
                    zoomToRegion(clickedZoomRegionIndex);
                }
            }
            
            // Clear selection state
            State.setSelectionStartX(null);
            State.setIsSelecting(false);
            State.setSelectionStart(null);
            State.setSelectionEnd(null);
            updateWorkletSelection();
            hideAddRegionButton();
            
            // Clear scrub preview if it was shown
            clearSpectrogramScrubPreview();
            
            // Redraw to update button states (canvas buttons will update via redraw)
            drawWaveformWithSelection();
            return; // Don't process as normal waveform click
        }
        
        if (clickedPlayRegionIndex !== null) {
            // Clicked on a play button - play region from start (mirrors panel play button)
            e.stopPropagation();
            e.preventDefault();
            
            // Clear all selection/dragging state to allow new selections
            State.setIsDragging(false);
            State.setIsSelecting(false);
            State.setSelectionStartX(null);
            canvas.style.cursor = 'pointer';
            
            // ✅ Call toggleRegionPlay synchronously (same logic as panel buttons)
            // This sets activePlayingRegionIndex and updates region.playing state
            // toggleRegionPlay already calls drawWaveformWithSelection() which redraws buttons
            toggleRegionPlay(clickedPlayRegionIndex);
            
            // Return early - don't process as normal waveform click
            return;
        }
        
        if (State.isDragging) {
            State.setIsDragging(false);
            canvas.style.cursor = 'pointer';
            
            // Check if click is on a canvas zoom button (only if not selecting/dragging)
            // Only check if it was a simple click, not a drag
            const startX = State.selectionStartX || 0;
            const endX = e.clientX - rect.left;
            const dragDistance = Math.abs(endX - startX);
            
            // Only check for button click if it was a simple click (not a drag)
            if (!State.isSelecting && dragDistance < 5) {
                // Already checked above, but keep this as fallback for edge cases
                const checkZoomAgain = checkCanvasZoomButtonClick(endX, clickY);
                const checkPlayAgain = checkCanvasPlayButtonClick(endX, clickY);
                
                if (checkZoomAgain !== null) {
                    // Clicked on a zoom button - handle zoom
                    e.stopPropagation();
                    e.preventDefault();
                    
                    const regions = getRegions();
                    const region = regions[checkZoomAgain];
                    
                    if (region) {
                        // Check if we're already inside THIS temple
                        if (zoomState.isInRegion() && zoomState.getCurrentRegionId() === region.id) {
                            // We're inside - exit the temple and return to full view
                            zoomToFull();
                        } else {
                            // Zoom into this region
                            zoomToRegion(checkZoomAgain);
                        }
                    }
                    
                    // Clear selection state
                    State.setSelectionStartX(null);
                    State.setIsSelecting(false);
                    State.setSelectionStart(null);
                    State.setSelectionEnd(null);
                    updateWorkletSelection();
                    hideAddRegionButton();
                    
                    // Clear scrub preview
                    clearSpectrogramScrubPreview();
                    
                    // Redraw to update button states (canvas buttons will update via redraw)
                    drawWaveformWithSelection();
                    return; // Don't process as normal waveform click
                }
                
                if (checkPlayAgain !== null) {
                    // Clicked on a play button - play region from start (mirrors panel play button)
                    e.stopPropagation();
                    e.preventDefault();
                    
                    // Clear all selection/dragging state to allow new selections
                    State.setIsDragging(false);
                    State.setIsSelecting(false);
                    State.setSelectionStartX(null);
                    
                    // ✅ Call toggleRegionPlay synchronously (same logic as panel buttons)
                    // This sets activePlayingRegionIndex and updates region.playing state
                    // toggleRegionPlay already calls drawWaveformWithSelection() which redraws buttons
                    toggleRegionPlay(checkPlayAgain);
                    
                    return; // Don't process as normal waveform click
                }
            }
            
            if (State.isSelecting) {
                const { targetPosition } = getPositionFromMouse(e);
                const rect = canvas.getBoundingClientRect();

                // 🙏 Timestamps as source of truth: Convert start pixel to timestamp, then to seconds
                let startPos;
                if (zoomState.isInitialized()) {
                    const startTimestamp = zoomState.pixelToTimestamp(State.selectionStartX || 0, rect.width);
                    startPos = zoomState.timestampToSeconds(startTimestamp);
                } else {
                    // Fallback to old behavior if zoom state not initialized
                    const startProgress = Math.max(0, Math.min(1, (State.selectionStartX || 0) / rect.width));
                    startPos = startProgress * State.totalAudioDuration;
                }
                const endPos = targetPosition;
                
                State.setIsSelecting(false);
                
                const newSelectionStart = Math.min(startPos, endPos);
                const newSelectionEnd = Math.max(startPos, endPos);
                const newIsLooping = State.isLooping;
                
                // Print comprehensive diagnostics for the selection
                const currentX = e.clientX - rect.left;
                printSelectionDiagnostics(State.selectionStartX, currentX, rect.width);
                
                State.setSelectionStartX(null);
                
                // 🏛️ Only reset region buttons if NOT inside a region (outside the temple)
                // Inside the temple, selections are within sacred walls, flag stays up
                if (!zoomState.isInRegion()) {
                    resetAllRegionPlayButtons();
                }
                
                // 🏛️ Show "Add Region" button only if NOT inside a region (outside the temple)
                // When inside the temple, we don't want to add new regions
                if (!zoomState.isInRegion()) {
                    showAddRegionButton(newSelectionStart, newSelectionEnd);
                    // Update status message
                    const statusEl = document.getElementById('status');
                    if (statusEl) {
                    // Resolve selection tutorial promise if waiting
                    if (State.waitingForSelection && State._selectionTutorialResolve) {
                        State._selectionTutorialResolve();
                        State.setSelectionTutorialResolve(null);
                        State.setWaitingForSelection(false);
                    } else {
                        // 🎓 Check if tutorial is active
                        import('./tutorial-state.js').then(({ isTutorialActive }) => {
                            // If tutorial is active, let it handle all messages
                            if (isTutorialActive()) {
                                // User got ahead or tutorial is guiding them
                                if (!State.waitingForSelection) {
                                    statusEl.className = 'status success';
                                    statusEl.textContent = 'Nice! You just created a selection! Click Add Region or type (R) to create a new region.';
                                    State.setWaveformHasBeenClicked(true);
                                    localStorage.setItem('userHasClickedWaveformOnce', 'true');
                                    State.setWaitingForRegionCreation(true);
                                }
                                // Otherwise tutorial is controlling, do nothing
                                return; // Exit early - tutorial controls messages
                            }
                            
                            // Regular non-tutorial flow
                            // Check if Begin Analysis has been clicked
                                import('./study-workflow.js').then(({ hasBegunAnalysisThisSession }) => {
                                    const hasBegunAnalysis = hasBegunAnalysisThisSession();
                                    const newMessage = hasBegunAnalysis 
                                        ? 'Type (R) or click Add Region to create a new region.'
                                        : ''; // 'Explore mode: select a volcano and click Begin Analysis when ready.';
                                    
                                    // Only update if message has changed (check beginning of text)
                                    if (newMessage && !statusEl.textContent.startsWith(newMessage.substring(0, 20))) {
                                        statusEl.className = 'status info';
                                        statusEl.textContent = newMessage;
                                    }
                                }).catch(() => {
                                    // Fallback if import fails - assume no session started
                                    // const newMessage = 'Explore mode: select a volcano and click Begin Analysis when ready.';
                                    // if (!statusEl.textContent.startsWith(newMessage.substring(0, 20))) {
                                    //     statusEl.className = 'status info';
                                    //     statusEl.textContent = newMessage;
                                    // }
                                });
                        }).catch(() => {
                            // Fallback if import fails
                            statusEl.className = 'status info';
                            statusEl.textContent = 'Type (R) or click Add Region to create a new region.';
                        });
                    }
                    }
                }
                
                // 🏠 AUTONOMOUS: Set selection state and send to worklet immediately
                // No timeout needed - worklet uses selection when making decisions, no coordination required!
                State.setSelectionStart(newSelectionStart);
                State.setSelectionEnd(newSelectionEnd);
                State.setIsLooping(newIsLooping);
                updateWorkletSelection();  // Send selection to worklet immediately
                
                // Update visuals
                State.setCurrentAudioPosition(newSelectionStart);
                if (State.audioContext) {
                    State.setLastUpdateTime(State.audioContext.currentTime);
                }
                drawWaveformWithSelection();
                clearSpectrogramScrubPreview();  // Clear scrub preview
                drawSpectrogramPlayhead();  // Update spectrogram immediately
                
                // 🔧 FIX: Restore spectrogram viewport state
                restoreViewportState();
                
                // Seek to start and optionally start playback if playOnClick is enabled
                // Worklet handles fades autonomously based on its current state
                const shouldAutoPlay = document.getElementById('playOnClick').checked;
                seekToPosition(newSelectionStart, shouldAutoPlay);
            } else {
                State.setSelectionStart(null);
                State.setSelectionEnd(null);
                State.setSelectionStartX(null);
                
                // Hide "Add Region" button when selection is cleared
                hideAddRegionButton();
                
                updateWorkletSelection();
                
                // Redraw overlays after clearing selection
                drawWaveformOverlays();
                
                // 🏛️ Only reset region buttons if NOT inside a region (outside the temple)
                // Inside the temple, clicking seeks within sacred walls, flag stays up
                if (!zoomState.isInRegion()) {
                    resetAllRegionPlayButtons();
                }
                
                const { targetPosition } = getPositionFromMouse(e);
                const zoomMode = zoomState.isInRegion() ? 'temple (zoomed)' : 'full view';
                const zoomLevel = zoomState.isInitialized() ? zoomState.getZoomLevel().toFixed(1) : 'N/A';
                // console.log(`🖱️ Waveform clicked at ${targetPosition.toFixed(2)}s - seeking to position`);
                // console.log(`   📍 Zoom mode: ${zoomMode} (${zoomLevel}x)`);
                clearSpectrogramScrubPreview();  // Clear scrub preview
                State.setScrubTargetPosition(targetPosition); // Set target before seeking
                performSeek();
                drawSpectrogramPlayhead();  // Update spectrogram immediately after seek
                
                // 🔧 FIX: Restore spectrogram viewport state
                restoreViewportState();
            }
        }
    });
    
    canvas.addEventListener('mouseleave', () => {
        // Minimap viewport drag continues via document listeners — don't cancel here
        if (State.isDragging) {
            const wasSelecting = State.isSelecting;
            State.setIsDragging(false);
            State.setIsSelecting(false);
            canvas.style.cursor = State.completeSamplesArray && State.totalAudioDuration > 0 ? 'pointer' : 'default';
            
            if (State.selectionStartX !== null) {
                if (wasSelecting && State.selectionStart !== null && State.selectionEnd !== null) {
                    updateWorkletSelection();
                    State.setCurrentAudioPosition(State.selectionStart);
                    if (State.audioContext) {
                        State.setLastUpdateTime(State.audioContext.currentTime);
                    }
                    drawWaveformWithSelection();
                    clearSpectrogramScrubPreview();  // Clear scrub preview
                    drawSpectrogramPlayhead();  // Update spectrogram immediately

                    // Show "Add Region" button (same as normal mouseup path)
                    if (!zoomState.isInRegion()) {
                        showAddRegionButton(State.selectionStart, State.selectionEnd);
                    }

                    // Seek to start and optionally start playback if playOnClick is enabled
                    const shouldAutoPlay = document.getElementById('playOnClick').checked;
                    seekToPosition(State.selectionStart, shouldAutoPlay);
                } else {
                    State.setSelectionStart(null);
                    State.setSelectionEnd(null);
                    updateWorkletSelection();
                    clearSpectrogramScrubPreview();  // Clear scrub preview
                    performSeek();
                }
            } else {
                performSeek();
            }
            
            State.setSelectionStartX(null);
            console.log('🖱️ Mouse left canvas during interaction');
        }
    });
    
    canvas.addEventListener('mouseenter', () => {
        if (State.completeSamplesArray && State.totalAudioDuration > 0) {
            canvas.style.cursor = 'pointer';
        }
    });

    // ===== TOUCH EVENT HANDLERS (for mobile devices) =====
    // These mirror the mouse handlers but use touch coordinates

    // Helper to convert touch event to mouse-like event object
    function touchToMouseEvent(touchEvent) {
        const touch = touchEvent.touches[0] || touchEvent.changedTouches[0];
        return {
            clientX: touch.clientX,
            clientY: touch.clientY,
            preventDefault: () => touchEvent.preventDefault(),
            stopPropagation: () => touchEvent.stopPropagation()
        };
    }

    canvas.addEventListener('touchstart', (e) => {
        // Only handle touch events on actual touch devices (not desktop trackpads)
        if (!isTouchDevice) return;

        console.log('📱 TOUCH EVENT RECEIVED on waveform canvas');

        if (!State.completeSamplesArray || State.totalAudioDuration === 0) {
            console.log('📱 No audio data loaded yet, ignoring touch');
            return;
        }

        // Check if touch is disabled
        if (canvas.style.pointerEvents === 'none') {
            return;
        }

        const rect = canvas.getBoundingClientRect();
        const touch = e.touches[0];
        const startX = touch.clientX - rect.left;
        const startY = touch.clientY - rect.top;

        // Check if touching a button FIRST (before preventDefault to allow button handling)
        if (!State.isDragging && !State.isSelecting && State.selectionStartX === null) {
            const clickedZoomRegionIndex = checkCanvasZoomButtonClick(startX, startY);
            const clickedPlayRegionIndex = checkCanvasPlayButtonClick(startX, startY);
            console.log(`📱 Button check: zoom=${clickedZoomRegionIndex}, play=${clickedPlayRegionIndex}, coords=(${startX.toFixed(0)}, ${startY.toFixed(0)})`);

            if (State.regionButtonsDisabled && (clickedZoomRegionIndex !== null || clickedPlayRegionIndex !== null)) {
                console.log('📱 Buttons disabled, ignoring');
                return;
            }

            if (clickedZoomRegionIndex !== null || clickedPlayRegionIndex !== null) {
                // Store button index for touchend - DON'T preventDefault for buttons
                canvas._touchedZoomButton = clickedZoomRegionIndex;
                canvas._touchedPlayButton = clickedPlayRegionIndex;
                e.preventDefault(); // Prevent scrolling but allow button handling
                console.log('📱 Button tap detected, waiting for touchend');
                return;
            }
        }

        // For drag/selection interactions, prevent default to avoid scrolling
        e.preventDefault();

        // Hide mobile tap hint on first tap
        hideMobileTapHint();

        // Hide any existing "Add Region" button when starting a new selection
        hideAddRegionButton();

        // Resolve tutorial promise if waiting
        if (State._waveformClickResolve) {
            console.log('🎯 Waveform touched: Resolving promise');
            State._waveformClickResolve();
            State.setWaveformClickResolve(null);
        }

        // Clear pulse classes
        canvas.classList.remove('pulse');
        const waveformContainer = document.getElementById('waveform');
        if (waveformContainer) {
            waveformContainer.classList.remove('pulse');
        }
        hideTutorialOverlay();

        // Mark waveform as clicked
        if (!State.waveformHasBeenClicked) {
            State.setWaveformHasBeenClicked(true);
        }
        localStorage.setItem('userHasClickedWaveformOnce', 'true');

        // Normal waveform interaction - start selection/drag
        State.setSelectionStartX(startX);
        State.setIsDragging(true);
        updateScrubPreview(touchToMouseEvent(e));
        console.log('📱 Touch start - waiting to detect drag vs tap');
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        // Only handle touch events on actual touch devices
        if (!isTouchDevice) return;
        if (!State.isDragging || State.selectionStartX === null) return;

        e.preventDefault(); // Prevent scrolling

        const rect = canvas.getBoundingClientRect();
        const touch = e.touches[0];
        const currentX = touch.clientX - rect.left;
        const dragDistance = Math.abs(currentX - State.selectionStartX);

        if (dragDistance > 10 && !State.isSelecting) { // Higher threshold for touch (10px vs 3px for mouse)
            State.setIsSelecting(true);
            console.log('📱 Selection drag detected');

            if (!zoomState.isInRegion()) {
                clearActiveRegion();
            }
        }

        if (State.isSelecting) {
            const { targetPosition } = getPositionFromMouse(touchToMouseEvent(e));

            let startPos;
            if (zoomState.isInitialized()) {
                const startTimestamp = zoomState.pixelToTimestamp(State.selectionStartX, rect.width);
                startPos = zoomState.timestampToSeconds(startTimestamp);
            } else {
                const startProgress = Math.max(0, Math.min(1, State.selectionStartX / rect.width));
                startPos = startProgress * State.totalAudioDuration;
            }
            const endPos = targetPosition;

            State.setSelectionStart(Math.min(startPos, endPos));
            State.setSelectionEnd(Math.max(startPos, endPos));

            drawWaveformWithSelection();
        } else {
            updateScrubPreview(touchToMouseEvent(e));
        }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
        // Only handle touch events on actual touch devices
        if (!isTouchDevice) return;

        // Check if we touched a button
        if (canvas._touchedZoomButton !== undefined || canvas._touchedPlayButton !== undefined) {
            const zoomIndex = canvas._touchedZoomButton;
            const playIndex = canvas._touchedPlayButton;
            canvas._touchedZoomButton = undefined;
            canvas._touchedPlayButton = undefined;

            // Handle button tap
            if (zoomIndex !== null && zoomIndex !== undefined) {
                if (!State.regionButtonsDisabled || State.isRegionZoomButtonEnabled(zoomIndex)) {
                    const regions = getRegions();
                    const region = regions[zoomIndex];
                    if (region) {
                        if (zoomState.isInRegion() && zoomState.getCurrentRegionId() === region.id) {
                            zoomToFull();
                        } else {
                            zoomToRegion(zoomIndex);
                        }
                    }
                }
                return;
            }
            if (playIndex !== null && playIndex !== undefined) {
                if (!State.regionButtonsDisabled || State.isRegionPlayButtonEnabled(playIndex)) {
                    toggleRegionPlay(playIndex);
                }
                return;
            }
        }

        const wasSelecting = State.isSelecting;
        const wasDragging = State.isDragging;

        State.setIsDragging(false);
        State.setIsSelecting(false);

        if (State.selectionStartX !== null) {
            if (wasSelecting && State.selectionStart !== null && State.selectionEnd !== null) {
                // Finished creating a selection
                const selectionDuration = Math.abs(State.selectionEnd - State.selectionStart);

                if (selectionDuration >= 1) {
                    // Show "Add Region" button
                    showAddRegionButton(State.selectionStart, State.selectionEnd);
                }

                updateWorkletSelection();
                State.setCurrentAudioPosition(State.selectionStart);
                if (State.audioContext) {
                    State.setLastUpdateTime(State.audioContext.currentTime);
                }
                drawWaveformWithSelection();
                clearSpectrogramScrubPreview();
                drawSpectrogramPlayhead();

                const shouldAutoPlay = document.getElementById('playOnClick').checked;
                seekToPosition(State.selectionStart, shouldAutoPlay);
            } else if (wasDragging) {
                // Single tap - seek to position
                State.setSelectionStart(null);
                State.setSelectionEnd(null);
                updateWorkletSelection();

                if (!zoomState.isInRegion()) {
                    resetAllRegionPlayButtons();
                }

                const touch = e.changedTouches[0];
                const { targetPosition } = getPositionFromMouse({ clientX: touch.clientX, clientY: touch.clientY });
                clearSpectrogramScrubPreview();
                State.setScrubTargetPosition(targetPosition);
                performSeek();
                drawSpectrogramPlayhead();
                restoreViewportState();
            }
        }

        State.setSelectionStartX(null);
        console.log('📱 Touch end');
    });

    canvas.addEventListener('touchcancel', () => {
        // Only handle touch events on actual touch devices
        if (!isTouchDevice) return;

        // Clean up on touch cancel (e.g., incoming call)
        State.setIsDragging(false);
        State.setIsSelecting(false);
        State.setSelectionStartX(null);
        clearSpectrogramScrubPreview();
        console.log('📱 Touch cancelled');
    });
}

// Diagnostic logging state
let lastDiagnosticTime = 0;

// ── Page Turn mode: auto-advance viewport when playhead reaches window edge ──
// When the user manually drags/scrolls the viewport away from the playhead,
// auto-advance pauses. It re-engages when the playhead naturally reaches the
// end of whatever window it's currently in.
let pageTurnUserDragged = false; // set when user manually moves viewport
let pageTurnPlayheadWasInView = false; // tracks if playhead entered viewport after user drag

function checkPageTurnAdvance() {
    const modeEl = document.getElementById('viewingMode');
    if (!modeEl || modeEl.value !== 'pageTurn') return;
    if (!zoomState.isInitialized() || !State.dataStartTime || !State.dataEndTime) return;
    if (State.totalAudioDuration <= 0) return;
    // Don't advance while user is actively dragging the minimap viewport
    if (minimapDragging) return;

    // Current playhead timestamp
    const playheadMs = State.dataStartTime.getTime() +
        (State.currentAudioPosition / State.totalAudioDuration) *
        (State.dataEndTime.getTime() - State.dataStartTime.getTime());

    const viewStartMs = zoomState.currentViewStartTime.getTime();
    const viewEndMs = zoomState.currentViewEndTime.getTime();
    const viewSpanMs = viewEndMs - viewStartMs;
    if (viewSpanMs <= 0) return;

    const dataStartMs = State.dataStartTime.getTime();
    const dataEndMs = State.dataEndTime.getTime();

    // If user dragged away, only re-engage when the playhead has been INSIDE the
    // viewport and then naturally reaches the end. This prevents snapping back when
    // the user drags the window left (away from the playhead that's already past it).
    if (pageTurnUserDragged) {
        const playheadInView = playheadMs >= viewStartMs && playheadMs < viewEndMs;
        if (playheadInView) {
            // Playhead is inside viewport — mark that we've seen it, wait for it to reach the end
            pageTurnPlayheadWasInView = true;
            return;
        }
        if (pageTurnPlayheadWasInView && playheadMs >= viewEndMs) {
            // Playhead was in view and just crossed the end — re-engage
            pageTurnUserDragged = false;
            pageTurnPlayheadWasInView = false;
        } else {
            // Playhead is outside and was never in view since drag — stay disengaged
            return;
        }
    }

    // Auto-advance: playhead is at or past the window end
    if (playheadMs >= viewEndMs) {
        let newStartMs = viewEndMs; // Next page starts where current ended
        let newEndMs = newStartMs + viewSpanMs;

        // Clamp to data bounds
        if (newEndMs > dataEndMs) {
            newEndMs = dataEndMs;
            newStartMs = Math.max(dataStartMs, dataEndMs - viewSpanMs);
        }

        zoomState.currentViewStartTime = new Date(newStartMs);
        zoomState.currentViewEndTime = new Date(newEndMs);

        // Trigger full re-render for the new page
        drawWaveformFromMinMax();
        drawWaveformXAxis();
        updateSpectrogramViewportFromZoom();
        updateAllFeatureBoxPositions();
        updateCanvasAnnotations();
        drawDayMarkers();
    }
}

/**
 * Mark that the user manually moved the viewport (breaks page-turn catch)
 */
export function notifyPageTurnUserDragged() {
    pageTurnUserDragged = true;
    pageTurnPlayheadWasInView = false;
}

// 🔥 HELPER: Start playback indicator loop (ensures cleanup before starting)
export function startPlaybackIndicator() {
    // 🔥 FIX: Check if document is connected before starting RAF
    // This prevents creating RAF callbacks that will be retained by detached documents
    if (!document.body || !document.body.isConnected) {
        return;
    }
    
    // 🔥 FIX: Prevent multiple simultaneous RAF loops
    // If RAF is already scheduled, don't create another one
    if (State.playbackIndicatorRAF !== null) {
        return;
    }
    
    // Start new loop
    State.setPlaybackIndicatorRAF(requestAnimationFrame(updatePlaybackIndicator));
}

export function updatePlaybackIndicator() {
    // 🔥 FIX: Copy State values to local variables IMMEDIATELY to break closure chain
    // This prevents RAF callbacks from capturing the entire State module
    // Access State only once at the start, then use local variables throughout
    const currentRAF = State.playbackIndicatorRAF;
    const isDragging = State.isDragging;
    const playbackState = State.playbackState;
    const totalAudioDuration = State.totalAudioDuration;
    
    // Clear RAF ID immediately to prevent duplicate scheduling
    // This must happen FIRST before any early returns to prevent accumulation
    State.setPlaybackIndicatorRAF(null);
    if (currentRAF !== null) {
        cancelAnimationFrame(currentRAF);
    }
    
    // 🔥 FIX: Check if document is still connected (not detached) before proceeding
    // This prevents RAF callbacks from retaining references to detached documents
    if (!document.body || !document.body.isConnected) {
        return; // Document is detached, stop the loop
    }
    
    // Early exit: dragging - schedule next frame but don't render
    if (isDragging) {
        // 🔥 FIX: Only schedule RAF if document is still connected and not already scheduled
        // This prevents creating RAF callbacks that will be retained by detached documents
        if (document.body && document.body.isConnected && State.playbackIndicatorRAF === null) {
            State.setPlaybackIndicatorRAF(requestAnimationFrame(updatePlaybackIndicator));
        }
        return;
    }
    
    // Early exit: not playing - stop the loop completely
    if (playbackState !== PlaybackState.PLAYING) {
        return;
    }
    
    // 🔥 FIX: Removed access to State.allReceivedData to prevent closure leak
    // The diagnostic code was accessing State.allReceivedData which contains thousands of Float32Array chunks
    // This created a closure chain: RAF callback → State module → allReceivedData → 4,237 Float32Array chunks (17MB)
    // Use State.completeSamplesArray.length instead if needed, or remove diagnostic code entirely
    
    if (totalAudioDuration > 0) {
        // Page Turn mode: advance viewport when playhead reaches window edge
        checkPageTurnAdvance();

        drawWaveformWithSelection();
        drawSpectrogramPlayhead();  // Draw playhead on spectrogram too

        // Update feature box positions every frame (glued to pixels like axis ticks!)
        updateAllFeatureBoxPositions();

        // Update live annotations (shows feature text when playhead reaches them)
        // DISABLED: Old DOM-based annotations - now using canvas annotations
        // updateLiveAnnotations();

        // Update canvas annotations every frame (timing/fade animations)
        updateCanvasAnnotations();
    }
    
    // 🔥 FIX: Store RAF ID for proper cleanup
    // Only schedule if document is still connected and not already scheduled
    // This prevents creating multiple RAF callbacks that accumulate
    if (document.body && document.body.isConnected && State.playbackIndicatorRAF === null) {
        State.setPlaybackIndicatorRAF(requestAnimationFrame(updatePlaybackIndicator));
    } else {
        // Document is detached or already scheduled - stop the loop
        State.setPlaybackIndicatorRAF(null);
    }
}

export function initWaveformWorker() {
    if (State.waveformWorker) {
        State.waveformWorker.onmessage = null;  // Break closure chain
        State.waveformWorker.terminate();
    }
    
    const worker = new Worker('workers/waveform-worker.js');
    State.setWaveformWorker(worker);
    
    worker.onmessage = (e) => {
        const { type } = e.data;
        // console.log(`🔍 [PIPELINE] Worker message received: type=${type}`);

        if (type === 'waveform-ready') {
            const { waveformData, totalSamples, buildTime, isComplete } = e.data;
            // console.log(`🔍 [PIPELINE] waveform-ready: totalSamples=${totalSamples}, waveformData.mins.length=${waveformData?.mins?.length}, isComplete=${isComplete}`);
            
            if (isComplete) {
                State.setIsShowingFinalWaveform(true);
            }
            
            if (DEBUG_WAVEFORM) console.log(`🎨 Waveform ready: ${totalSamples.toLocaleString()} samples → ${waveformData.mins.length} pixels in ${buildTime.toFixed(0)}ms`);
            
            State.setWaveformMinMaxData(waveformData);
            // console.log(`🔍 [PIPELINE] Calling drawWaveformFromMinMax()`);
            drawWaveformFromMinMax();
            
            // 🔧 FIX: Don't call drawWaveformWithSelection() here - it draws regions immediately
            // Regions will be drawn after crossfade completes (via renderRegionsAfterCrossfade)
            // drawWaveformWithSelection() is already called at the end of the crossfade animation (line 344)
            
            // 🔥 FIX: Clear waveformData references after use to allow GC of transferred ArrayBuffers
            // The mins/maxs buffers were transferred from worker - clearing helps GC
            // Note: We've already copied the data to State, so it's safe to clear here
            e.data.waveformData = null;
        } else if (type === 'reset-complete') {
            if (!isStudyMode()) {
                console.log('🎨 Waveform worker reset complete');
            }
        }
    };
    
    if (!isStudyMode()) {
        console.log('🎨 Waveform worker initialized');
    }
}

export function changeWaveformFilter() {
    const slider = document.getElementById('waveformFilterSlider');
    const value = parseInt(slider.value);
    const alpha = 0.95 + (value / 100) * (0.9999 - 0.95);
    
    document.getElementById('waveformFilterValue').textContent = `${alpha.toFixed(4)}`;
    
    // Ensure raw data backup exists (some loading paths don't set it)
    if (!window.rawWaveformData && State.completeSamplesArray && State.completeSamplesArray.length > 0) {
        window.rawWaveformData = new Float32Array(State.completeSamplesArray);
    }

    if (window.rawWaveformData && window.rawWaveformData.length > 0) {
        const removeDC = document.getElementById('removeDCOffset').checked;
        
        console.log(`🎛️ changeWaveformFilter called: removeDC=${removeDC}, alpha=${alpha.toFixed(4)}`);
        
        let processedData = window.rawWaveformData;
        
        if (removeDC) {
            console.log(`🎛️ Removing drift with alpha=${alpha.toFixed(4)}...`);
            processedData = removeDCOffset(processedData, alpha);
            
            let minProc = processedData[0], maxProc = processedData[0];
            for (let i = 1; i < processedData.length; i++) {
                if (processedData[i] < minProc) minProc = processedData[i];
                if (processedData[i] > maxProc) maxProc = processedData[i];
            }
            console.log(`  📊 Drift-removed range: [${minProc.toFixed(1)}, ${maxProc.toFixed(1)}]`);
        } else {
            console.log(`🎛️ No drift removal (showing raw data)`);
        }
        
        const normalized = normalize(processedData);
        // 🔥 FIX: Clear old displayWaveformData before setting new one to prevent memory leak
        // The old Float32Array might be retained if we don't explicitly clear it
        if (window.displayWaveformData) {
            window.displayWaveformData = null;
        }
        window.displayWaveformData = normalized;
        State.setCompleteSamplesArray(normalized);
        
        console.log(`  🎨 Redrawing waveform...`);
        drawWaveform();
    } else if (State.waveformWorker) {
        // Data still loading progressively — tell the worker to rebuild with current settings
        const removeDC = document.getElementById('removeDCOffset').checked;
        const canvas = document.getElementById('waveform');
        console.log(`🎛️ changeWaveformFilter (progressive): removeDC=${removeDC}, alpha=${alpha.toFixed(4)}`);
        State.waveformWorker.postMessage({
            type: 'build-waveform',
            canvasWidth: canvas.offsetWidth * window.devicePixelRatio,
            canvasHeight: canvas.offsetHeight * window.devicePixelRatio,
            removeDC: removeDC,
            alpha: alpha
        });
    }
}

