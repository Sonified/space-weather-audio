/**
 * waveform-renderer.js
 * Waveform drawing, interaction (scrubbing, selection), and playback indicator
 */

import * as State from './audio-state.js';
import { PlaybackState, isTouchDevice } from './audio-state.js';
import { seekToPosition, updateWorkletSelection, getCurrentPosition, pausePlayback } from './audio-player.js';
import { positionMinimapAxisCanvas, drawMinimapAxis } from './minimap-axis-renderer.js';
import { positionMinimapXAxisCanvas, drawMinimapXAxis, positionMinimapDateCanvas, drawMinimapDate, getInterpolatedTimeRange, isZoomTransitionInProgress } from './minimap-x-axis-renderer.js';
import { drawSpectrogramXAxis, positionSpectrogramXAxisCanvas } from './spectrogram-x-axis-renderer.js';
import { getStandaloneFeatures } from './feature-tracker.js';
import { drawRegionButtons } from './minimap-buttons-renderer.js';
import { printSelectionDiagnostics } from './selection-diagnostics.js';
import { drawSpectrogramPlayhead, drawSpectrogramScrubPreview, clearSpectrogramScrubPreview, cleanupPlayheadOverlay } from './spectrogram-playhead.js';
import { zoomState } from './zoom-state.js';
import { isStudyMode } from './master-modes.js';
import { updateAllFeatureBoxPositions } from './spectrogram-feature-boxes.js';
import { restoreViewportState, updateSpectrogramViewportFromZoom, getFullMagnitudeTexture, getSpectrogramParams, notifyInteractionStart, notifyInteractionEnd } from './main-window-renderer.js';
import { drawDayMarkers } from './day-markers.js';
import { getColorLUT } from './colormaps.js';
import { updateLiveAnnotations } from './spectrogram-live-annotations.js';
import { updateCanvasAnnotations, isFeaturePopupOpen, isFeatureBoxReadyToShow } from './spectrogram-renderer.js';
import { getYPositionForFrequencyScaled } from './spectrogram-axis-renderer.js';
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.webgpu.js';
import { texture as tslTexture, vec2, vec4, uniform, float, select, uv, Fn, Loop, If, Break, min as tslMin, max as tslMax, floor as tslFloor, ceil as tslCeil, clamp as tslClamp, abs as tslAbs, log2 as tslLog2, pow as tslPow } from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.webgpu.js';

// Debug flag for waveform logs (set to true to enable detailed logging)
const DEBUG_WAVEFORM = false;

// ─── Three.js GPU waveform renderer ─────────────────────────────────────────

let wfRenderer = null;
let wfScene = null;
let wfCamera = null;
let wfMaterial = null;
let wfMesh = null;
let wfSampleTexture = null;
let wfMipTexture = null;
let wfColormapTexture = null;
let wfTotalSamples = 0;
let wfTextureWidth = 0;
let wfTextureHeight = 0;
const WF_MIP_BIN_SIZE = 256;
let wfOverlayCanvas = null;
let wfOverlayCtx = null;
let wfCachedWidth = 0;   // Cached device-pixel dimensions (avoid offsetWidth in render path)
let wfCachedHeight = 0;
let wfResizeObserver = null;
let wfOverlayResizeObserver = null;

// ─── Minimap spectrogram (second mesh in same WebGPU scene) ─────────────────
let wfSpectroMaterial = null;
let wfSpectroMesh = null;

// TSL uniform nodes for minimap waveform shader
let wfUViewportStart = null;
let wfUViewportEnd = null;
let wfUTotalSamples = null;
let wfUCanvasWidth = null;
let wfUCanvasHeight = null;
let wfUTexWidth = null;
let wfUTexHeight = null;
let wfUMipTexWidth = null;
let wfUMipTexHeight = null;
let wfUMipTotalBins = null;
let wfUMipBinSize = null;
let wfUTransparentBg = null;
let wfUBgR = null;
let wfUBgG = null;
let wfUBgB = null;
// TSL texture nodes
let wfSampleTexNode = null;
let wfMipTexNode = null;
let wfCmapTexNode = null;
// Minimap spectrogram TSL nodes
let wfSpectroMagTexNode = null;
let wfSpectroCmapTexNode = null;
let wfSpectroUViewportStart = null;
let wfSpectroUViewportEnd = null;
let wfSpectroUStretch = null;
let wfSpectroUFreqScale = null;
let wfSpectroUMinFreq = null;
let wfSpectroUMaxFreq = null;
let wfSpectroUDbFloor = null;
let wfSpectroUDbRange = null;

let wfInitPromise = null; // WebGPU renderer init is async

async function initWaveformThreeScene() {
    if (wfRenderer) return;

    const canvas = document.getElementById('minimap');
    if (!canvas) return;

    wfCachedWidth = Math.round(canvas.offsetWidth * window.devicePixelRatio);
    wfCachedHeight = Math.round(canvas.offsetHeight * window.devicePixelRatio);
    canvas.width = wfCachedWidth;
    canvas.height = wfCachedHeight;

    wfRenderer = new THREE.WebGPURenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true });
    wfRenderer.setSize(wfCachedWidth, wfCachedHeight, false);
    await wfRenderer.init();

    wfCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
    wfCamera.position.z = 1;

    wfScene = new THREE.Scene();

    // ─── TSL uniform nodes ────────────────────────────────────────────────
    wfUViewportStart = uniform(0.0);
    wfUViewportEnd = uniform(1.0);
    wfUTotalSamples = uniform(0.0);
    wfUCanvasWidth = uniform(parseFloat(wfCachedWidth));
    wfUCanvasHeight = uniform(parseFloat(wfCachedHeight));
    wfUTexWidth = uniform(4096.0);
    wfUTexHeight = uniform(1.0);
    wfUMipTexWidth = uniform(4096.0);
    wfUMipTexHeight = uniform(1.0);
    wfUMipTotalBins = uniform(0.0);
    wfUMipBinSize = uniform(parseFloat(WF_MIP_BIN_SIZE));
    wfUTransparentBg = uniform(0.0);
    const lut = getColorLUT();
    wfUBgR = uniform(lut ? lut[0] / 255 : 0);
    wfUBgG = uniform(lut ? lut[1] / 255 : 0);
    wfUBgB = uniform(lut ? lut[2] / 255 : 0);

    // ─── Placeholder textures ─────────────────────────────────────────────
    wfSampleTexture = new THREE.DataTexture(
        new Float32Array(1), 1, 1, THREE.RedFormat, THREE.FloatType
    );
    wfSampleTexture.minFilter = THREE.NearestFilter;
    wfSampleTexture.magFilter = THREE.NearestFilter;
    wfSampleTexture.needsUpdate = true;

    wfMipTexture = new THREE.DataTexture(
        new Float32Array(2), 1, 1, THREE.RGFormat, THREE.FloatType
    );
    wfMipTexture.minFilter = THREE.NearestFilter;
    wfMipTexture.magFilter = THREE.NearestFilter;
    wfMipTexture.needsUpdate = true;

    wfColormapTexture = buildWaveformColormapTexture();

    wfSampleTexNode = tslTexture(wfSampleTexture);
    wfMipTexNode = tslTexture(wfMipTexture);
    wfCmapTexNode = tslTexture(wfColormapTexture);

    // ─── TSL waveform shader (per-pixel min/max, single-level mip fast path) ─
    const getSampleTSL = Fn(([index]) => {
        const row = tslFloor(index.div(wfUTexWidth));
        const col = index.sub(row.mul(wfUTexWidth));
        const sUV = vec2(col.add(0.5).div(wfUTexWidth), row.add(0.5).div(wfUTexHeight));
        return wfSampleTexNode.uv(sUV).r;
    });

    const getMipBinTSL = Fn(([index]) => {
        const row = tslFloor(index.div(wfUMipTexWidth));
        const col = index.sub(row.mul(wfUMipTexWidth));
        const mUV = vec2(col.add(0.5).div(wfUMipTexWidth), row.add(0.5).div(wfUMipTexHeight));
        return wfMipTexNode.uv(mUV);
    });

    // ─── Catmull-Rom interpolation for smooth waveform curves ───────────
    // Evaluates waveform amplitude at a fractional sample position using
    // 4-point cubic spline (passes through every sample, smooth between them)
    const catmullRomTSL = Fn(([samplePos]) => {
        const lastIdx = wfUTotalSamples.sub(1.0);
        const idx = tslFloor(tslClamp(samplePos, float(0.0), lastIdx));
        const frac = tslClamp(samplePos.sub(idx), float(0.0), float(1.0));

        const s0 = getSampleTSL(tslClamp(idx.sub(1.0), float(0.0), lastIdx));
        const s1 = getSampleTSL(tslClamp(idx,          float(0.0), lastIdx));
        const s2 = getSampleTSL(tslClamp(idx.add(1.0), float(0.0), lastIdx));
        const s3 = getSampleTSL(tslClamp(idx.add(2.0), float(0.0), lastIdx));

        const t = frac;
        const t2 = t.mul(t);
        const t3 = t2.mul(t);

        // Catmull-Rom: 0.5 * ((2·s1) + (-s0+s2)·t + (2·s0-5·s1+4·s2-s3)·t² + (-s0+3·s1-3·s2+s3)·t³)
        return float(0.5).mul(
            float(2.0).mul(s1)
            .add(s2.sub(s0).mul(t))
            .add(s0.mul(2.0).sub(s1.mul(5.0)).add(s2.mul(4.0)).sub(s3).mul(t2))
            .add(s0.negate().add(s1.mul(3.0)).sub(s2.mul(3.0)).add(s3).mul(t3))
        );
    });

    const waveformColorFn = Fn(() => {
        const vuv = uv();
        const viewStart = wfUViewportStart.mul(wfUTotalSamples);
        const viewEnd = wfUViewportEnd.mul(wfUTotalSamples);
        const spp = viewEnd.sub(viewStart).div(wfUCanvasWidth);
        const pixelStart = viewStart.add(vuv.x.mul(viewEnd.sub(viewStart)));
        const pixelEnd = pixelStart.add(spp);

        const minVal = float(1.0).toVar();
        const maxVal = float(-1.0).toVar();

        If(spp.greaterThan(wfUMipBinSize).and(wfUMipTotalBins.greaterThan(0.0)), () => {
            // Zoomed out: use pre-computed min/max mip bins
            const binStart = tslFloor(tslMax(pixelStart.div(wfUMipBinSize).add(0.5), float(0.0)));
            const binEnd = tslMax(binStart.add(1.0), tslFloor(pixelEnd.div(wfUMipBinSize).add(0.5)));
            const binEndClamped = tslMin(binEnd, wfUMipTotalBins);
            const binCount = binEndClamped.sub(binStart);
            Loop(512, ({ i }) => {
                If(float(i).greaterThanEqual(binCount), () => { Break(); });
                const mm = getMipBinTSL(binStart.add(float(i)));
                minVal.assign(tslMin(minVal, mm.r));
                maxVal.assign(tslMax(maxVal, mm.g));
            });
        }).ElseIf(spp.greaterThan(float(2.0)), () => {
            // Medium zoom: scan raw samples in pixel range
            const startIdx = tslFloor(tslMax(pixelStart, float(0.0)));
            const endIdx = tslCeil(tslMin(pixelEnd, wfUTotalSamples));
            const count = endIdx.sub(startIdx);
            Loop(8192, ({ i }) => {
                If(float(i).greaterThanEqual(count), () => { Break(); });
                const s = getSampleTSL(startIdx.add(float(i)));
                minVal.assign(tslMin(minVal, s));
                maxVal.assign(tslMax(maxVal, s));
            });
        }).Else(() => {
            // Zoomed in (< 2 spp): Catmull-Rom smooth curve
            // Interpolate at pixel left & right edges → min/max covers the curve segment
            const valLeft = catmullRomTSL(pixelStart);
            const valRight = catmullRomTSL(pixelEnd);
            minVal.assign(tslMin(valLeft, valRight));
            maxVal.assign(tslMax(valLeft, valRight));
        });

        const amplitude = vuv.y.sub(0.5).mul(2.0);
        const yMin = minVal.mul(0.9).toVar();
        const yMax = maxVal.mul(0.9).toVar();

        const minThickness = float(2.0).div(wfUCanvasHeight);
        If(yMax.sub(yMin).lessThan(minThickness), () => {
            const center = yMin.add(yMax).mul(0.5);
            yMin.assign(center.sub(minThickness.mul(0.5)));
            yMax.assign(center.add(minThickness.mul(0.5)));
        });

        const inBand = amplitude.greaterThanEqual(yMin).and(amplitude.lessThanEqual(yMax));

        const peakAmp = tslMax(tslAbs(minVal), tslAbs(maxVal));
        const normalized = tslClamp(peakAmp, 0, 1);
        const cmapColor = wfCmapTexNode.uv(vec2(normalized, float(0.5)));

        const centerThickness = float(1.0).div(wfUCanvasHeight);
        const isCenterLine = tslAbs(vuv.y.sub(0.5)).lessThan(centerThickness);
        const centerAlpha = select(wfUTransparentBg.greaterThan(0.5), float(0.6), float(1.0));

        const bgAlpha = select(wfUTransparentBg.greaterThan(0.5), float(0.0), float(1.0));
        const bgColor = vec4(wfUBgR, wfUBgG, wfUBgB, bgAlpha);

        return select(isCenterLine,
            vec4(float(0.4), float(0.4), float(0.4), centerAlpha),
            select(inBand,
                vec4(cmapColor.r, cmapColor.g, cmapColor.b, float(1.0)),
                bgColor
            )
        );
    });

    wfMaterial = new THREE.MeshBasicNodeMaterial();
    wfMaterial.transparent = true;
    wfMaterial.colorNode = waveformColorFn();
    wfMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), wfMaterial);
    wfMesh.renderOrder = 1;
    wfScene.add(wfMesh);

    // ─── Minimap spectrogram TSL material ─────────────────────────────────
    wfSpectroColormapTexture = buildSpectroColormapTexture();

    const magPlaceholder = new THREE.DataTexture(
        new Float32Array(1), 1, 1, THREE.RedFormat, THREE.FloatType
    );
    magPlaceholder.needsUpdate = true;

    wfSpectroUViewportStart = uniform(0.0);
    wfSpectroUViewportEnd = uniform(1.0);
    wfSpectroUStretch = uniform(1.0);
    wfSpectroUFreqScale = uniform(0.0);
    wfSpectroUMinFreq = uniform(0.1);
    wfSpectroUMaxFreq = uniform(50.0);
    wfSpectroUDbFloor = uniform(-100.0);
    wfSpectroUDbRange = uniform(100.0);
    wfSpectroMagTexNode = tslTexture(magPlaceholder);
    wfSpectroCmapTexNode = tslTexture(wfSpectroColormapTexture);

    const spectroColorFn = Fn(() => {
        const vuv = uv();
        const effectiveY = vuv.y.div(wfSpectroUStretch);
        const freqRange = wfSpectroUMaxFreq.sub(wfSpectroUMinFreq);

        // Frequency scale remapping (linear / sqrt / log)
        const texVLinear = wfSpectroUMinFreq.add(effectiveY.mul(freqRange))
            .div(wfSpectroUMaxFreq).clamp(0, 1);
        const texVSqrt = wfSpectroUMinFreq.add(effectiveY.mul(effectiveY).mul(freqRange))
            .div(wfSpectroUMaxFreq).clamp(0, 1);
        const LOG2_10 = float(Math.log2(10));
        const logMin = tslLog2(wfSpectroUMinFreq.max(0.001)).div(LOG2_10);
        const logMax = tslLog2(wfSpectroUMaxFreq).div(LOG2_10);
        const logFreq = logMin.add(effectiveY.mul(logMax.sub(logMin)));
        const texVLog = tslPow(float(10.0), logFreq).div(wfSpectroUMaxFreq).clamp(0, 1);

        const texV = select(wfSpectroUFreqScale.lessThan(0.5), texVLinear,
                     select(wfSpectroUFreqScale.lessThan(1.5), texVSqrt, texVLog));

        const texU = wfSpectroUViewportStart.add(vuv.x.mul(wfSpectroUViewportEnd.sub(wfSpectroUViewportStart)));
        const mag = wfSpectroMagTexNode.uv(vec2(texU, texV)).r;

        const db = tslLog2(mag.add(1e-10)).div(LOG2_10).mul(20.0);
        const normalized = db.sub(wfSpectroUDbFloor).div(wfSpectroUDbRange).clamp(0, 1);
        const color = wfSpectroCmapTexNode.uv(vec2(normalized, float(0.5)));

        const bgColor = vec4(wfUBgR, wfUBgG, wfUBgB, float(1.0));
        return select(effectiveY.greaterThan(1.0), bgColor,
            vec4(color.r, color.g, color.b, float(1.0)));
    });

    wfSpectroMaterial = new THREE.MeshBasicNodeMaterial();
    wfSpectroMaterial.colorNode = spectroColorFn();
    wfSpectroMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), wfSpectroMaterial);
    wfSpectroMesh.renderOrder = 0;
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

    // Re-render minimap when spectrogram texture becomes available
    window.addEventListener('spectrogram-ready', () => {
        if (getMinimapMode() !== 'linePlot') {
            drawWaveformFromMinMax();
        }
    });

    if (window.pm?.rendering) console.log(`Three.js WebGPU waveform renderer initialized (${wfCachedWidth}x${wfCachedHeight})`);
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

export async function uploadWaveformSamples(samples, expectedTotalSamples = 0) {
    if (!samples || samples.length === 0) return;

    // Skip re-upload if the same sample array is already on the GPU
    if (samples === wfLastUploadedSamples && wfSampleTexture) return;

    if (!wfInitPromise) wfInitPromise = initWaveformThreeScene();
    await wfInitPromise;
    if (!wfMaterial) return;

    // Use expected total if provided (progressive loading: allocate for full duration)
    const effectiveTotal = expectedTotalSamples > samples.length ? expectedTotalSamples : samples.length;
    wfTotalSamples = effectiveTotal;
    wfTextureWidth = 4096;
    wfTextureHeight = Math.ceil(wfTotalSamples / wfTextureWidth);

    // Pad to fill the texture rectangle (zeros = silence for unfilled right portion)
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

    if (wfSampleTexNode) wfSampleTexNode.value = wfSampleTexture;
    wfUTotalSamples.value = parseFloat(wfTotalSamples);
    wfUTexWidth.value = parseFloat(wfTextureWidth);
    wfUTexHeight.value = parseFloat(wfTextureHeight);

    // Single-level min/max mip: each bin covers WF_MIP_BIN_SIZE (256) samples
    const numBins = Math.ceil(wfTotalSamples / WF_MIP_BIN_SIZE);
    const mipData = new Float32Array(numBins * 2);
    const actualLen = samples.length;
    for (let bin = 0; bin < numBins; bin++) {
        const start = bin * WF_MIP_BIN_SIZE;
        const end = Math.min(start + WF_MIP_BIN_SIZE, actualLen);
        if (start >= actualLen) { mipData[bin * 2] = 0; mipData[bin * 2 + 1] = 0; continue; }
        let mn = Infinity, mx = -Infinity;
        for (let j = start; j < end; j++) {
            const v = samples[j];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
        }
        mipData[bin * 2] = mn;
        mipData[bin * 2 + 1] = mx;
    }

    const mipTexWidth = 4096;
    const mipTexHeight = Math.ceil(numBins / mipTexWidth);
    const mipPadded = new Float32Array(mipTexWidth * mipTexHeight * 2);
    mipPadded.set(mipData);

    if (wfMipTexture) wfMipTexture.dispose();
    wfMipTexture = new THREE.DataTexture(mipPadded, mipTexWidth, mipTexHeight, THREE.RGFormat, THREE.FloatType);
    wfMipTexture.minFilter = THREE.NearestFilter;
    wfMipTexture.magFilter = THREE.NearestFilter;
    wfMipTexture.wrapS = THREE.ClampToEdgeWrapping;
    wfMipTexture.wrapT = THREE.ClampToEdgeWrapping;
    wfMipTexture.needsUpdate = true;
    if (wfMipTexNode) wfMipTexNode.value = wfMipTexture;

    wfUMipTexWidth.value = parseFloat(mipTexWidth);
    wfUMipTexHeight.value = parseFloat(mipTexHeight);
    wfUMipTotalBins.value = parseFloat(numBins);

    wfLastUploadedSamples = samples;
    if (window.pm?.rendering) console.log(`Minimap waveform uploaded: ${wfTotalSamples.toLocaleString()} samples, mip: ${numBins.toLocaleString()} bins (${WF_MIP_BIN_SIZE} samples/bin)`);
}

/**
 * Render waveform via WebGPU with current viewport
 */
async function renderWaveformGPU(viewportStart = 0.0, viewportEnd = 1.0) {
    if (!wfRenderer || !wfScene || !wfCamera || !wfSampleTexture) return;

    // Handle canvas resize using cached dimensions (no layout-forcing offsetWidth reads)
    const canvas = wfRenderer.domElement;
    if (wfCachedWidth > 0 && wfCachedHeight > 0 &&
        (canvas.width !== wfCachedWidth || canvas.height !== wfCachedHeight)) {
        canvas.width = wfCachedWidth;
        canvas.height = wfCachedHeight;
        wfRenderer.setSize(wfCachedWidth, wfCachedHeight, false);
        wfUCanvasWidth.value = parseFloat(wfCachedWidth);
        wfUCanvasHeight.value = parseFloat(wfCachedHeight);
        if (wfOverlayCanvas) {
            wfOverlayCanvas.width = wfCachedWidth;
            wfOverlayCanvas.height = wfCachedHeight;
        }
    }

    wfUViewportStart.value = viewportStart;
    wfUViewportEnd.value = viewportEnd;

    // Update background color from colormap
    const lut = getColorLUT();
    if (lut) {
        wfUBgR.value = lut[0] / 255;
        wfUBgG.value = lut[1] / 255;
        wfUBgB.value = lut[2] / 255;
    }

    await wfRenderer.renderAsync(wfScene, wfCamera);
}

/**
 * Render the minimap with the appropriate mode (spectrogram, linePlot, or both).
 * - spectrogram: render spectrogram pass only (reusing main spectrogram FFT texture)
 * - linePlot: render waveform amplitude pass only (existing GPU shader)
 * - both: render spectrogram first, then waveform on top with transparent background
 */
async function renderMinimapWithMode(mode, viewportStart, viewportEnd) {
    if (!wfRenderer || !wfScene || !wfCamera) return;

    const showSpectrogram = (mode === 'spectrogram' || mode === 'both');
    const showWaveform = (mode === 'linePlot' || mode === 'both');

    // Update spectrogram mesh with current magnitude texture
    if (showSpectrogram && wfSpectroMaterial) {
        const magData = getFullMagnitudeTexture();
        if (magData) {
            // The minimap's WebGPU renderer can't directly share the main renderer's texture.
            // Create a new DataTexture from the same Float32Array data.
            if (wfSpectroMagTexNode) wfSpectroMagTexNode.value = magData.texture;
            wfSpectroUViewportStart.value = viewportStart;
            wfSpectroUViewportEnd.value = viewportEnd;

            // Sync frequency scale params from main spectrogram
            const params = getSpectrogramParams();
            wfSpectroUFreqScale.value = params.frequencyScale;
            wfSpectroUMinFreq.value = params.minFreq;
            wfSpectroUMaxFreq.value = params.maxFreq;
            wfSpectroUDbFloor.value = params.dbFloor;
            wfSpectroUDbRange.value = params.dbRange;
            wfSpectroUStretch.value = 1.0; // minimap always 1x

            const lut = getColorLUT();
            if (lut) {
                wfUBgR.value = lut[0] / 255;
                wfUBgG.value = lut[1] / 255;
                wfUBgB.value = lut[2] / 255;
            }
        }
        wfSpectroMesh.visible = !!magData;
    } else if (wfSpectroMesh) {
        wfSpectroMesh.visible = false;
    }

    // Configure waveform mesh
    if (showWaveform && wfSampleTexture) {
        wfMesh.visible = true;
        wfUTransparentBg.value = mode === 'both' ? 1.0 : 0.0;
        wfUViewportStart.value = viewportStart;
        wfUViewportEnd.value = viewportEnd;
        const lut = getColorLUT();
        if (lut) {
            wfUBgR.value = lut[0] / 255;
            wfUBgG.value = lut[1] / 255;
            wfUBgB.value = lut[2] / 255;
        }
    } else {
        wfMesh.visible = false;
    }

    // Handle canvas resize
    const canvas = wfRenderer.domElement;
    if (wfCachedWidth > 0 && wfCachedHeight > 0 &&
        (canvas.width !== wfCachedWidth || canvas.height !== wfCachedHeight)) {
        canvas.width = wfCachedWidth;
        canvas.height = wfCachedHeight;
        wfRenderer.setSize(wfCachedWidth, wfCachedHeight, false);
        wfUCanvasWidth.value = parseFloat(wfCachedWidth);
        wfUCanvasHeight.value = parseFloat(wfCachedHeight);
        if (wfOverlayCanvas) {
            wfOverlayCanvas.width = wfCachedWidth;
            wfOverlayCanvas.height = wfCachedHeight;
        }
    }

    await wfRenderer.renderAsync(wfScene, wfCamera);
}

/**
 * Rebuild waveform colormap texture (call after colormap change)
 */
export function rebuildWaveformColormapTexture() {
    if (wfColormapTexture) wfColormapTexture.dispose();
    wfColormapTexture = buildWaveformColormapTexture();
    if (wfCmapTexNode) wfCmapTexNode.value = wfColormapTexture;

    if (wfSpectroColormapTexture) wfSpectroColormapTexture.dispose();
    wfSpectroColormapTexture = buildSpectroColormapTexture();
    if (wfSpectroCmapTexNode) wfSpectroCmapTexNode.value = wfSpectroColormapTexture;
}

/**
 * Dispose all waveform Three.js resources (textures, material, geometry, observers)
 * Called during dataset switch to prevent memory leaks.
 */
/**
 * Visual-only clear — hide meshes and render one black frame.
 * Does NOT dispose textures or scene objects. Used for section transitions.
 */
export async function clearMinimapDisplay() {
    if (wfMesh) wfMesh.visible = false;
    if (wfSpectroMesh) wfSpectroMesh.visible = false;
    if (wfRenderer && wfScene && wfCamera) {
        await wfRenderer.renderAsync(wfScene, wfCamera);
    }
    // Clear overlay canvases (viewport box, day markers, x-axis ticks)
    if (wfOverlayCanvas) {
        const ctx = wfOverlayCanvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, wfOverlayCanvas.width, wfOverlayCanvas.height);
    }
    const overlayIds = ['minimap-buttons', 'minimap-x-axis', 'minimap-axis'];
    for (const id of overlayIds) {
        const c = document.getElementById(id);
        if (c) { const ctx = c.getContext('2d'); if (ctx) ctx.clearRect(0, 0, c.width, c.height); }
    }
}

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
    // Null renderer + init promise so initWaveformThreeScene can re-create on next load
    wfRenderer = null;
    wfInitPromise = null;
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

// Main window waveform now rendered via TSL in spectrogram-three-renderer.js


/**
 * Check if we're in an EMIC windowed mode (scroll or page-turn, NOT region creation)
 */
function isEmicWindowedMode() {
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
let minimapResizeEdge = null;     // null = pan, 'left' = resize left edge, 'right' = resize right edge
let minimapDragStartMs = 0;       // timestamp under cursor at drag start
let minimapViewStartMsAtDrag = 0; // viewport start at drag start
let minimapViewEndMsAtDrag = 0;   // viewport end at drag start
let minimapRafPending = false;
const MINIMAP_EDGE_THRESHOLD_PX = 8; // pixels from edge to trigger resize cursor/drag
const MINIMAP_MIN_WINDOW_MS = 60000; // minimum window width: 1 minute

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
    drawMinimapXAxis();
    drawSpectrogramXAxis();
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

    const totalSamples = State.getCompleteSamplesLength() || 1;
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
    const fbCheckbox = document.getElementById('featureBoxesVisible');
    if (fbCheckbox && !fbCheckbox.checked) return;
    if (!State.dataStartTime || !State.dataEndTime) return;

    const standalone = getStandaloneFeatures();
    if (standalone.length === 0) return;

    const dataStartMs = State.dataStartTime.getTime();
    const dataEndMs = State.dataEndTime.getTime();
    const dataSpanMs = dataEndMs - dataStartMs;
    if (dataSpanMs <= 0) return;

    const originalNyquist = State.originalDataFrequencyRange?.max || 50;
    const playbackRate = State.getPlaybackRate();
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

        ctx.strokeStyle = 'rgba(200, 50, 50, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x, y, w, h);
        ctx.fillStyle = 'rgba(220, 60, 60, 0.15)';
        ctx.fillRect(x, y, w, h);

        // No number labels on minimap — too small to be useful
    }

    // Draw standalone features
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
    // Gate behind featureBoxReadyToShow so minimap and spectrogram boxes appear together
    const navFeatBoxes = document.getElementById('navBarFeatureBoxes');
    if (isFeatureBoxReadyToShow() && (!navFeatBoxes || navFeatBoxes.value !== 'hide')) {
        drawMinimapFeatureBoxes(wfOverlayCtx, width, height);
    }

    // Region buttons: hide entirely in windowed modes (scroll/pageTurn), show in region creation mode
    if (!isEmicWindowedMode()) {
        drawRegionButtons();
    }

    // Selection box
    if (State.selectionStart !== null && State.selectionEnd !== null) {
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

    const waveformCanvas = document.getElementById('minimap');
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
export function removeDCOffset(data, alpha = 0.995) {
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

export function normalize(data) {
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

export async function drawWaveform() {
    const samplesLength = State.getCompleteSamplesLength();
    if (samplesLength === 0) {
        console.log(`⚠️ drawWaveform() aborted: no data`);
        return;
    }

    const canvas = document.getElementById('minimap');
    if (!canvas) {
        console.log(`⚠️ drawWaveform() aborted: canvas not found`);
        return;
    }

    // Use original sample rate from metadata, NOT AudioContext rate
    const sampleRate = State.currentMetadata?.original_sample_rate || 50;
    // Only set duration if it hasn't been set yet (during progressive loading,
    // the fetcher sets the correct expected duration early — don't override with partial data)
    if (!State.totalAudioDuration || State.totalAudioDuration <= 0) {
        State.setTotalAudioDuration(samplesLength / sampleRate);
    }

    // Upload samples to GPU texture (the shader handles everything)
    const samples = State.completeSamplesArray || State.getCompleteSamplesArray();
    await uploadWaveformSamples(samples);

    // Compute viewport from zoom state and render with current minimap mode
    const viewport = getWaveformViewport();
    const mode = getMinimapMode();
    await renderMinimapWithMode(mode, viewport.start, viewport.end);

    // Draw axes
    positionMinimapAxisCanvas();
    drawMinimapAxis();
    positionMinimapXAxisCanvas();
    drawMinimapXAxis();
    positionSpectrogramXAxisCanvas();
    drawSpectrogramXAxis();
    positionMinimapDateCanvas();
    drawMinimapDate();

    // Draw overlays (playhead, selection)
    drawWaveformOverlays();

    // Mobile tap hint
    showMobileTapHint();
}

export async function drawWaveformFromMinMax() {
    // GPU path: just re-render with current viewport
    if (!wfRenderer || !wfSampleTexture) {
        // Fallback: if GPU not initialized yet, trigger full drawWaveform
        if (State.getCompleteSamplesLength() > 0) {
            await drawWaveform();
        }
        return;
    }

    const viewport = getWaveformViewport();
    const mode = getMinimapMode();
    await renderMinimapWithMode(mode, viewport.start, viewport.end);

    // Draw axes
    positionMinimapAxisCanvas();
    drawMinimapAxis();
    positionMinimapXAxisCanvas();
    drawMinimapXAxis();
    positionSpectrogramXAxisCanvas();
    drawSpectrogramXAxis();
    positionMinimapDateCanvas();
    drawMinimapDate();

    // Overlays
    drawWaveformOverlays();
    showMobileTapHint();
}

/**
 * Draw waveform with smooth zoom interpolation during transitions.
 * GPU path: compute interpolated viewport from timestamp range, render.
 */
export async function drawInterpolatedWaveform() {
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
    await renderMinimapWithMode(mode, viewportStart, viewportEnd);

    // Overlays track the same interpolated range
    drawWaveformOverlays();
}

export function drawWaveformWithSelection() {
    // GPU waveform is already rendered — just redraw overlays
    drawWaveformOverlays();
}

export function setupWaveformInteraction() {
    const canvas = document.getElementById('minimap');
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
        if (State.getCompleteSamplesLength() === 0 || !State.totalAudioDuration) return;

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
        if (State.getCompleteSamplesLength() === 0 || !State.totalAudioDuration) {
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
        if (State.getCompleteSamplesLength() === 0 || State.totalAudioDuration === 0) return;
        
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
        const waveformContainer = document.getElementById('minimap');
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
                    const { typeText } = await import('./status-text.js');
                    typeText(statusDiv, 'Now click and drag to create a new region.', 30, 10);
                }
            }, 2000);
        }
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
        const waveformCanvas = document.getElementById('minimap');
        const buttonsCanvas = document.getElementById('minimap-buttons');
        
        // console.log('🖱️ CLICK DIAGNOSTICS:');
        // console.log(`  Click position: (${startX.toFixed(1)}, ${startY.toFixed(1)}) CSS pixels`);
        // console.log(`  Click % across: ${((startX / rect.width) * 100).toFixed(1)}%`);
        // console.log(`  Waveform canvas: ${waveformCanvas.offsetWidth}px × ${waveformCanvas.offsetHeight}px (CSS)`);
        // console.log(`  Waveform canvas: ${waveformCanvas.width}px × ${waveformCanvas.height}px (device)`);
        // if (buttonsCanvas) {
        //     console.log(`  Buttons canvas: ${buttonsCanvas.width}px × ${buttonsCanvas.height}px (device)`);
        // }
        // console.log(`  DPR: ${window.devicePixelRatio}`);
        
        // --- Minimap viewport drag/resize: intercept in windowed mode when zoomed ---
        if (isMinimapZoomed()) {
            minimapDragging = true;
            minimapResizeEdge = null; // default: pan mode
            notifyInteractionStart();
            pageTurnUserDragged = true; // User manually moved viewport — break page-turn catch
            pageTurnPlayheadWasInView = false; // Reset — must see playhead enter viewport before re-engaging
            const dataStartMs = State.dataStartTime.getTime();
            const dataEndMs = State.dataEndTime.getTime();
            const dataSpanMs = dataEndMs - dataStartMs;
            const frac = Math.max(0, Math.min(1, startX / rect.width));
            const clickMs = dataStartMs + frac * dataSpanMs;

            const viewStartMs = zoomState.currentViewStartTime.getTime();
            const viewEndMs = zoomState.currentViewEndTime.getTime();

            // Check if click is near a viewport edge (resize) vs interior (pan)
            const viewStartFrac = (viewStartMs - dataStartMs) / dataSpanMs;
            const viewEndFrac = (viewEndMs - dataStartMs) / dataSpanMs;
            const leftEdgePx = viewStartFrac * rect.width;
            const rightEdgePx = viewEndFrac * rect.width;
            const nearLeftEdge = Math.abs(startX - leftEdgePx) < MINIMAP_EDGE_THRESHOLD_PX;
            const nearRightEdge = Math.abs(startX - rightEdgePx) < MINIMAP_EDGE_THRESHOLD_PX;

            if (nearLeftEdge && !nearRightEdge) {
                minimapResizeEdge = 'left';
                canvas.style.cursor = 'ew-resize';
            } else if (nearRightEdge && !nearLeftEdge) {
                minimapResizeEdge = 'right';
                canvas.style.cursor = 'ew-resize';
            } else if (nearLeftEdge && nearRightEdge) {
                // Both edges close (very narrow window) — pick the closer one
                minimapResizeEdge = (Math.abs(startX - leftEdgePx) <= Math.abs(startX - rightEdgePx)) ? 'left' : 'right';
                canvas.style.cursor = 'ew-resize';
            } else {
                // Not near edges — pan mode
                canvas.style.cursor = 'grabbing';

                // If click is outside the current viewport box, snap-center on click point
                if (clickMs < viewStartMs || clickMs > viewEndMs) {
                    const viewSpanMs = viewEndMs - viewStartMs;
                    let newStart = clickMs - viewSpanMs / 2;
                    let newEnd = clickMs + viewSpanMs / 2;
                    if (newStart < dataStartMs) { newStart = dataStartMs; newEnd = dataStartMs + viewSpanMs; }
                    if (newEnd > dataEndMs) { newEnd = dataEndMs; newStart = dataEndMs - viewSpanMs; }
                    zoomState.currentViewStartTime = new Date(newStart);
                    zoomState.currentViewEndTime = new Date(newEnd);
                    if (!minimapRafPending) {
                        minimapRafPending = true;
                        requestAnimationFrame(renderMinimapDragFrame);
                    }
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

                if (minimapResizeEdge) {
                    // --- Edge resize mode ---
                    let ns = minimapViewStartMsAtDrag;
                    let ne = minimapViewEndMsAtDrag;
                    if (minimapResizeEdge === 'left') {
                        ns = minimapViewStartMsAtDrag + delta;
                        if (ns < dStartMs) ns = dStartMs;
                        if (ne - ns < MINIMAP_MIN_WINDOW_MS) ns = ne - MINIMAP_MIN_WINDOW_MS;
                    } else {
                        ne = minimapViewEndMsAtDrag + delta;
                        if (ne > dEndMs) ne = dEndMs;
                        if (ne - ns < MINIMAP_MIN_WINDOW_MS) ne = ns + MINIMAP_MIN_WINDOW_MS;
                    }
                    zoomState.currentViewStartTime = new Date(ns);
                    zoomState.currentViewEndTime = new Date(ne);
                } else {
                    // --- Pan mode (existing behavior) ---
                    const vSpan = minimapViewEndMsAtDrag - minimapViewStartMsAtDrag;
                    let ns = minimapViewStartMsAtDrag + delta;
                    let ne = minimapViewEndMsAtDrag + delta;
                    if (ns < dStartMs) { ns = dStartMs; ne = dStartMs + vSpan; }
                    if (ne > dEndMs) { ne = dEndMs; ns = dEndMs - vSpan; }
                    zoomState.currentViewStartTime = new Date(ns);
                    zoomState.currentViewEndTime = new Date(ne);
                }

                if (!minimapRafPending) {
                    minimapRafPending = true;
                    requestAnimationFrame(renderMinimapDragFrame);
                }
            }
            function onDocMouseUp(ev) {
                minimapDragging = false;
                minimapResizeEdge = null;
                notifyInteractionEnd();
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

        // Minimap edge hover: show ew-resize cursor when near viewport edges
        if (!State.isDragging && isMinimapZoomed()) {
            const rect = canvas.getBoundingClientRect();
            const hoverX = e.clientX - rect.left;
            const dataStartMs = State.dataStartTime.getTime();
            const dataEndMs = State.dataEndTime.getTime();
            const dataSpanMs = dataEndMs - dataStartMs;
            const viewStartFrac = (zoomState.currentViewStartTime.getTime() - dataStartMs) / dataSpanMs;
            const viewEndFrac = (zoomState.currentViewEndTime.getTime() - dataStartMs) / dataSpanMs;
            const leftEdgePx = viewStartFrac * rect.width;
            const rightEdgePx = viewEndFrac * rect.width;
            if (Math.abs(hoverX - leftEdgePx) < MINIMAP_EDGE_THRESHOLD_PX ||
                Math.abs(hoverX - rightEdgePx) < MINIMAP_EDGE_THRESHOLD_PX) {
                canvas.style.cursor = 'ew-resize';
            } else {
                canvas.style.cursor = 'pointer';
            }
        }

        if (State.isDragging && State.selectionStartX !== null) {
            const rect = canvas.getBoundingClientRect();
            const currentX = e.clientX - rect.left;
            const dragDistance = Math.abs(currentX - State.selectionStartX);
            
            if (dragDistance > 3 && !State.isSelecting) {
                State.setIsSelecting(true);
                canvas.style.cursor = 'col-resize';
                console.log('📏 Selection drag detected');
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

        const rect = canvas.getBoundingClientRect();

        if (State.isDragging) {
            State.setIsDragging(false);
            canvas.style.cursor = 'pointer';
            
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

                updateWorkletSelection();

                // Redraw overlays after clearing selection
                drawWaveformOverlays();

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
            canvas.style.cursor = State.getCompleteSamplesLength() > 0 && State.totalAudioDuration > 0 ? 'pointer' : 'default';
            
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
        if (State.getCompleteSamplesLength() > 0 && State.totalAudioDuration > 0) {
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

        if (State.getCompleteSamplesLength() === 0 || State.totalAudioDuration === 0) {
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

        // For drag/selection interactions, prevent default to avoid scrolling
        e.preventDefault();

        // Hide mobile tap hint on first tap
        hideMobileTapHint();

        // Resolve tutorial promise if waiting
        if (State._waveformClickResolve) {
            console.log('🎯 Waveform touched: Resolving promise');
            State._waveformClickResolve();
            State.setWaveformClickResolve(null);
        }

        // Clear pulse classes
        canvas.classList.remove('pulse');
        const waveformContainer = document.getElementById('minimap');
        if (waveformContainer) {
            waveformContainer.classList.remove('pulse');
        }
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

        const wasSelecting = State.isSelecting;
        const wasDragging = State.isDragging;

        State.setIsDragging(false);
        State.setIsSelecting(false);

        if (State.selectionStartX !== null) {
            if (wasSelecting && State.selectionStart !== null && State.selectionEnd !== null) {
                // Finished creating a selection
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

/**
 * Feature-box playback edge check.
 * When standalone features exist on screen and the playhead reaches the
 * right edge of the current viewport, honour the Master Settings choice:
 *   "continue" → do nothing (default)
 *   "stop"     → pause playback
 *   "clamp"    → prevent the viewport from scrolling past the current page
 * Returns true if the RAF loop should stop (i.e. playback was paused).
 */
function checkFeaturePlaybackEdge() {
    const modeEl = document.getElementById('featurePlaybackMode');
    if (!modeEl || modeEl.value === 'continue') return false;

    // Only act when a feature info popup is actively open
    if (!isFeaturePopupOpen()) return false;

    if (!zoomState.isInitialized() || !State.dataStartTime || !State.dataEndTime) return false;
    if (State.totalAudioDuration <= 0) return false;

    const playheadMs = State.dataStartTime.getTime() +
        (State.currentAudioPosition / State.totalAudioDuration) *
        (State.dataEndTime.getTime() - State.dataStartTime.getTime());
    const viewEndMs = zoomState.currentViewEndTime.getTime();

    if (playheadMs < viewEndMs) return false;  // not at edge yet

    if (modeEl.value === 'stop') {
        pausePlayback();
        // Final render so playhead shows at the edge
        drawWaveformWithSelection();
        drawSpectrogramPlayhead();
        updateCanvasAnnotations();
        return true;  // stop RAF loop
    }

    if (modeEl.value === 'clamp') {
        // Keep audio playing but prevent page-turn from advancing the viewport.
        // The playhead will move off-screen while the display stays on this page.
        return 'clamp';
    }

    return false;
}

function checkPageTurnAdvance() {
    const modeEl = document.getElementById('viewingMode');
    if (!modeEl || modeEl.value !== 'pageTurn') return;
    if (!zoomState.isInitialized() || !State.dataStartTime || !State.dataEndTime) return;
    if (State.totalAudioDuration <= 0) return;
    // Don't advance while user is actively dragging the minimap viewport
    if (minimapDragging) return;
    // Don't advance while feature info popup is open — keep the page in view
    if (isFeaturePopupOpen()) return;

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
        drawMinimapXAxis();
        drawSpectrogramXAxis();
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
        // When stretch is active, update position from wall-clock calculation
        // (source worklet is paused so it won't send position updates)
        if (State.stretchActive) {
            State.setCurrentAudioPosition(getCurrentPosition());
        }

        // Feature box playback mode: stop or clamp when playhead reaches page edge
        // Must run BEFORE checkPageTurnAdvance so it can intercept before the viewport advances
        const featureEdge = checkFeaturePlaybackEdge();
        if (featureEdge === true) return;  // 'stop' mode — halt RAF loop

        // Page Turn mode: advance viewport when playhead reaches window edge
        // Skip if 'clamp' mode is active — keep display locked, let playhead keep going
        if (featureEdge !== 'clamp') checkPageTurnAdvance();

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
    
    worker.onmessage = async (e) => {
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
            
            // 🔥 FIX: Clear waveformData references after use to allow GC of transferred ArrayBuffers
            // The mins/maxs buffers were transferred from worker - clearing helps GC
            // Note: We've already copied the data to State, so it's safe to clear here
            e.data.waveformData = null;
        } else if (type === 'reset-complete') {
            // Clear old waveform so stale data doesn't flash on next render
            State.setWaveformMinMaxData(null);
            State.setIsShowingFinalWaveform(false);
            wfLastUploadedSamples = null;
            wfTotalSamples = 0;
            // Clear the GPU texture so old waveform doesn't show
            if (wfSampleTexture) {
                const zeros = new Float32Array(wfSampleTexture.image.width * wfSampleTexture.image.height);
                wfSampleTexture.image.data.set(zeros);
                wfSampleTexture.needsUpdate = true;
            }
            if (wfRenderer && wfScene && wfCamera) {
                await wfRenderer.renderAsync(wfScene, wfCamera);
            }
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
    if (!window.rawWaveformData && State.getCompleteSamplesLength() > 0) {
        const samples = State.completeSamplesArray || State.getCompleteSamplesArray();
        window.rawWaveformData = new Float32Array(samples);
    }

    if (window.rawWaveformData && window.rawWaveformData.length > 0) {
        const removeDC = document.getElementById('removeDCOffset').checked;
        
        if (window.pm?.audio) console.log(`🎛️ changeWaveformFilter called: removeDC=${removeDC}, alpha=${alpha.toFixed(4)}`);
        
        let processedData = window.rawWaveformData;
        
        if (removeDC) {
            if (window.pm?.audio) console.log(`🎛️ Removing drift with alpha=${alpha.toFixed(4)}...`);
            processedData = removeDCOffset(processedData, alpha);
            
            let minProc = processedData[0], maxProc = processedData[0];
            for (let i = 1; i < processedData.length; i++) {
                if (processedData[i] < minProc) minProc = processedData[i];
                if (processedData[i] > maxProc) maxProc = processedData[i];
            }
            if (window.pm?.audio) console.log(`  📊 Drift-removed range: [${minProc.toFixed(1)}, ${maxProc.toFixed(1)}]`);
        } else {
            if (window.pm?.audio) console.log(`🎛️ No drift removal (showing raw data)`);
        }
        
        const normalized = normalize(processedData);
        // 🔥 FIX: Clear old displayWaveformData before setting new one to prevent memory leak
        // The old Float32Array might be retained if we don't explicitly clear it
        if (window.displayWaveformData) {
            window.displayWaveformData = null;
        }
        window.displayWaveformData = normalized;
        State.setCompleteSamplesArray(normalized);

        // Also swap the AudioProcessor worklet's buffer so resampled playback uses detrended audio
        if (State.workletNode) {
            const copy = new Float32Array(normalized);
            State.workletNode.port.postMessage(
                { type: 'swap-buffer', samples: copy },
                [copy.buffer]
            );
            if (window.pm?.audio) console.log(`  🔄 Swapped AudioProcessor buffer with detrended audio`);
        }

        if (window.pm?.render) console.log(`  🎨 Redrawing waveform...`);
        drawWaveform();

        // Re-render spectrogram pyramid tiles from de-trended samples
        // Only if spectrogram was already rendered (avoid interfering with initial load)
        if (State.spectrogramInitialized) {
            if (window.pm?.render) console.log(`  🔺 Rebuilding spectrogram from de-trended data...`);
            import('./spectrogram-pyramid.js').then(({ disposePyramid }) => {
                import('./main-window-renderer.js').then(({ resetSpectrogramState, renderCompleteSpectrogram }) => {
                    disposePyramid();
                    resetSpectrogramState();
                    renderCompleteSpectrogram();
                });
            });
        }
    } else if (State.waveformWorker) {
        // Data still loading progressively — tell the worker to rebuild with current settings
        const removeDC = document.getElementById('removeDCOffset').checked;
        const canvas = document.getElementById('minimap');
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

