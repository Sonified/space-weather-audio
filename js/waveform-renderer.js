/**
 * waveform-renderer.js
 * Waveform drawing, interaction (scrubbing, selection), and playback indicator
 */

import * as State from './audio-state.js';
import { PlaybackState } from './audio-state.js';
import { seekToPosition, updateWorkletSelection } from './audio-player.js';
import { positionWaveformAxisCanvas, drawWaveformAxis } from './waveform-axis-renderer.js';
import { positionWaveformXAxisCanvas, drawWaveformXAxis, positionWaveformDateCanvas, drawWaveformDate, getInterpolatedTimeRange, isZoomTransitionInProgress } from './waveform-x-axis-renderer.js';
import { drawRegionHighlights, showAddRegionButton, hideAddRegionButton, clearActiveRegion, resetAllRegionPlayButtons, getActiveRegionIndex, isPlayingActiveRegion, checkCanvasZoomButtonClick, checkCanvasPlayButtonClick, zoomToRegion, zoomToFull, getRegions, toggleRegionPlay, renderRegionsAfterCrossfade } from './region-tracker.js';
import { drawRegionButtons } from './waveform-buttons-renderer.js';
import { printSelectionDiagnostics } from './selection-diagnostics.js';
import { drawSpectrogramPlayhead, drawSpectrogramScrubPreview, clearSpectrogramScrubPreview } from './spectrogram-playhead.js';
import { zoomState } from './zoom-state.js';
import { hideTutorialOverlay, setStatusText } from './tutorial.js';
import { isStudyMode } from './master-modes.js';
import { updateAllFeatureBoxPositions } from './spectrogram-feature-boxes.js';
import { restoreViewportState } from './spectrogram-complete-renderer.js';

// Debug flag for waveform logs (set to true to enable detailed logging)
const DEBUG_WAVEFORM = false;

// Playhead log throttling (log every 500ms unless forced by user interaction)
let lastPlayheadLogTime = 0;
let lastDrawWaveformLogTime = 0;
let forceNextPlayheadLog = false;

// Color LUT (same as spectrogram) - maps intensity to RGB
let waveformColorLUT = null;

function hslToRgb(h, s, l) {
    h = h / 360;
    s = s / 100;
    l = l / 100;
    
    let r, g, b;
    
    if (s === 0) {
        r = g = b = l;
    } else {
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1/6) return p + (q - p) * 6 * t;
            if (t < 1/2) return q;
            if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        };
        
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
    }
    
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function initializeWaveformColorLUT() {
    if (waveformColorLUT !== null) return; // Already initialized
    
    waveformColorLUT = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
        const normalized = i / 255;
        const hue = normalized * 30; // Reduced range: red to orange (0-30 degrees) - less variation
        const saturation = 40 + (normalized * 20); // Muted: 40-60% saturation (was 100%)
        const lightness = 60 + (normalized * 35); // Brighter: 60-95% lightness (more white/yellow)
        
        const rgb = hslToRgb(hue, saturation, lightness);
        waveformColorLUT[i * 3] = rgb[0];
        waveformColorLUT[i * 3 + 1] = rgb[1];
        waveformColorLUT[i * 3 + 2] = rgb[2];
    }
}

// Initialize color LUT on module load
initializeWaveformColorLUT();

// Helper functions
function removeDCOffset(data, alpha = 0.995) {
    let mean = data[0];
    const y = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
        mean = alpha * mean + (1 - alpha) * data[i];
        y[i] = data[i] - mean;
    }
    return y;
}

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

export function drawWaveform() {
    console.log(`🔍 [PIPELINE] drawWaveform() called`);
    console.log(`🔍 [PIPELINE] State.completeSamplesArray: ${State.completeSamplesArray ? `exists, length=${State.completeSamplesArray.length}` : 'null/undefined'}`);
    console.log(`🔍 [PIPELINE] State.currentMetadata: ${State.currentMetadata ? `exists, original_sample_rate=${State.currentMetadata.original_sample_rate}` : 'null/undefined'}`);
    
    if (!State.completeSamplesArray || State.completeSamplesArray.length === 0) {
        console.log(`⚠️ drawWaveform() aborted: no data`);
        return;
    }
    
    const canvas = document.getElementById('waveform');
    if (!canvas) {
        console.log(`⚠️ drawWaveform() aborted: canvas not found`);
        return;
    }
    console.log(`🔍 [PIPELINE] Canvas found: ${canvas.offsetWidth}x${canvas.offsetHeight}`);
    
    const width = canvas.offsetWidth * window.devicePixelRatio;
    const height = canvas.offsetHeight * window.devicePixelRatio;
    console.log(`🔍 [PIPELINE] Canvas dimensions: ${width}x${height} (DPR=${window.devicePixelRatio})`);

    // 👑 CRITICAL: Use original sample rate from metadata, NOT AudioContext rate!
    // completeSamplesArray is at original rate (50 Hz), not resampled yet
    const sampleRate = State.currentMetadata?.original_sample_rate || 50;
    console.log(`🔍 [PIPELINE] Using sampleRate: ${sampleRate} Hz`);
    State.setTotalAudioDuration(State.completeSamplesArray.length / sampleRate);
    
    const removeDC = document.getElementById('removeDCOffset').checked;
    const slider = document.getElementById('waveformFilterSlider');
    const sliderValue = parseInt(slider.value);
    const alpha = 0.95 + (sliderValue / 100) * (0.9999 - 0.95);
    
    // 🏛️ Check if we're zoomed into a region
    let startSample = 0;
    let endSample = State.completeSamplesArray.length;
    let zoomInfo = 'full view';
    
    // 🏛️ Check if we're inside a region (within the temple walls)
    if (zoomState.isInRegion()) {
        const regionRange = zoomState.getRegionRange();
        // 🔥 CRITICAL: Convert original sample indices to resampled indices
        // getRegionRange() returns indices in original coordinate system (292 Hz)
        // but completeSamplesArray is resampled (44100 Hz), so we need to convert
        startSample = zoomState.originalToResampledSample(regionRange.startSample);
        endSample = zoomState.originalToResampledSample(regionRange.endSample);
        const zoomLevel = zoomState.getZoomLevel();
        zoomInfo = `zoomed ${zoomLevel.toFixed(1)}x (original samples ${regionRange.startSample.toLocaleString()}-${regionRange.endSample.toLocaleString()}, resampled ${startSample.toLocaleString()}-${endSample.toLocaleString()})`;
    }
    
    console.log(`🔍 [PIPELINE] Sending to waveform worker: width=${width}, height=${height}, samples=${State.completeSamplesArray.length}, ${zoomInfo}`);
    console.log(`🔍 [PIPELINE] State.waveformWorker exists: ${!!State.waveformWorker}`);
    
    if (!State.waveformWorker) {
        console.error(`❌ [PIPELINE] Cannot send to worker: State.waveformWorker is null!`);
        return;
    }
    
    State.waveformWorker.postMessage({
        type: 'build-waveform',
        canvasWidth: width,
        canvasHeight: height,
        removeDC: removeDC,
        alpha: alpha,
        isComplete: true,
        totalExpectedSamples: State.completeSamplesArray.length,
        // 🏛️ NEW: Send zoom range to worker
        startSample: startSample,
        endSample: endSample
    });
    console.log(`🔍 [PIPELINE] Message sent to waveform worker`);
}

export function drawWaveformFromMinMax() {
    console.log(`🔍 [PIPELINE] drawWaveformFromMinMax() called`);
    console.log(`🔍 [PIPELINE] waveformMinMaxData exists: ${!!State.waveformMinMaxData}, isShowingFinalWaveform: ${State.isShowingFinalWaveform}, cachedWaveformCanvas: ${!!State.cachedWaveformCanvas}`);
    
    if (!State.waveformMinMaxData) {
        console.log(`⚠️ drawWaveformFromMinMax() aborted: no min/max data`);
        return;
    }
    
    const canvas = document.getElementById('waveform');
    if (!canvas) {
        console.log(`⚠️ drawWaveformFromMinMax() aborted: canvas not found`);
        return;
    }
    console.log(`🔍 [PIPELINE] Canvas found: ${canvas.offsetWidth}x${canvas.offsetHeight}`);
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width = canvas.offsetWidth * window.devicePixelRatio;
    const height = canvas.height = canvas.offsetHeight * window.devicePixelRatio;
    console.log(`🔍 [PIPELINE] Canvas dimensions set: ${width}x${height}`);
    
    if (State.isShowingFinalWaveform && State.cachedWaveformCanvas) {
        console.log(`🔍 [PIPELINE] Using cached waveform canvas`);
        const oldCanvas = document.createElement('canvas');
        oldCanvas.width = width;
        oldCanvas.height = height;
        oldCanvas.getContext('2d').drawImage(State.cachedWaveformCanvas, 0, 0);
        
        const newCanvas = document.createElement('canvas');
        newCanvas.width = width;
        newCanvas.height = height;
        const newCtx = newCanvas.getContext('2d');
        
        // Dark red background (like spectrogram but red instead of black)
        newCtx.fillStyle = '#1a0000'; // Deeper dark red
        newCtx.fillRect(0, 0, width, height);
        
        const mid = height / 2;
        const { mins, maxs } = State.waveformMinMaxData;
        
        // Use pre-computed max amplitude (cached when waveformMinMaxData was set)
        const maxAmplitude = State.waveformMaxAmplitude || 0;
        
        // Pre-compute color indices with horizontal smoothing (low-pass filter)
        const colorIndices = new Float32Array(mins.length);
        for (let x = 0; x < mins.length; x++) {
            const amplitude = Math.max(Math.abs(mins[x]), Math.abs(maxs[x]));
            const normalizedAmplitude = maxAmplitude > 0 ? amplitude / maxAmplitude : 0;
            colorIndices[x] = normalizedAmplitude * 255;
        }
        
        // Apply horizontal smoothing (simple moving average)
        const smoothedIndices = new Float32Array(mins.length);
        const smoothingRadius = 3; // Smooth over 7 pixels (3 on each side)
        for (let x = 0; x < mins.length; x++) {
            let sum = 0;
            let count = 0;
            for (let dx = -smoothingRadius; dx <= smoothingRadius; dx++) {
                const idx = x + dx;
                if (idx >= 0 && idx < mins.length) {
                    sum += colorIndices[idx];
                    count++;
                }
            }
            smoothedIndices[x] = sum / count;
        }
        
        // Draw waveform with smoothed, muted colors
        for (let x = 0; x < mins.length && x < width; x++) {
            const min = mins[x];
            const max = maxs[x];
            // Canvas Y: 0 at top, increases downward
            // Data: positive values should go UP (smaller Y), negative DOWN (larger Y)
            const yMin = mid - (max * mid * 0.9);  // max value → top of bar (smaller Y)
            const yMax = mid - (min * mid * 0.9);  // min value → bottom of bar (larger Y)
            const lineHeight = Math.max(1, yMax - yMin);
            
            // Use smoothed color index
            const colorIndex = Math.floor(smoothedIndices[x]);
            
            // Get color from pre-computed LUT
            const r = waveformColorLUT[colorIndex * 3];
            const g = waveformColorLUT[colorIndex * 3 + 1];
            const b = waveformColorLUT[colorIndex * 3 + 2];
            
            newCtx.fillStyle = `rgb(${r}, ${g}, ${b})`;
            newCtx.fillRect(x, yMin, 1, lineHeight);
        }
        
        newCtx.strokeStyle = '#666';
        newCtx.lineWidth = 1;
        newCtx.beginPath();
        newCtx.moveTo(0, mid);
        newCtx.lineTo(width, mid);
        newCtx.stroke();
        
        if (State.crossfadeAnimation) cancelAnimationFrame(State.crossfadeAnimation);
        const startTime = performance.now();
        const duration = 300;
        
        const animate = () => {
            // 🔥 FIX: Check document connection before executing RAF callback
            // This prevents RAF callbacks from retaining references to detached documents
            if (!document.body || !document.body.isConnected) {
                State.setCrossfadeAnimation(null);
                return; // Document is detached, stop the animation
            }
            
            const elapsed = performance.now() - startTime;
            const progress = Math.min(elapsed / duration, 1.0);
            
            // Dark red background (like spectrogram but red instead of black)
            ctx.fillStyle = '#1a0000'; // Deeper dark red
            ctx.fillRect(0, 0, width, height);
            
            ctx.globalAlpha = 1.0 - progress;
            ctx.drawImage(oldCanvas, 0, 0);
            
            ctx.globalAlpha = progress;
            ctx.drawImage(newCanvas, 0, 0);
            
            ctx.globalAlpha = 1.0;
            
            if (State.totalAudioDuration > 0 && State.currentAudioPosition >= 0) {
                const playheadProgress = Math.min(State.currentAudioPosition / State.totalAudioDuration, 1.0);
                const playheadX = playheadProgress * width;
                
                // Cool playhead with glow and gradient
                const time = performance.now() * 0.001;
                const pulseIntensity = 0.3 + Math.sin(time * 3) * 0.1;
                
                // 🔥 PROTECTION: Ensure playheadX is finite before creating gradient
                if (isFinite(playheadX) && playheadX >= 0 && playheadX <= width) {
                    ctx.shadowBlur = 8;
                    ctx.shadowColor = 'rgba(255, 0, 0, 0.54)'; // 0.6 * 0.9
                    ctx.shadowOffsetX = 0;
                    
                    const gradient = ctx.createLinearGradient(playheadX, 0, playheadX, height);
                    gradient.addColorStop(0, `rgba(255, 100, 100, ${(0.9 + pulseIntensity) * 0.9})`);
                    gradient.addColorStop(0.5, `rgba(255, 0, 0, ${(0.95 + pulseIntensity) * 0.9})`);
                    gradient.addColorStop(1, `rgba(255, 100, 100, ${(0.9 + pulseIntensity) * 0.9})`);
                    
                    ctx.strokeStyle = gradient;
                    ctx.lineWidth = 3;
                    ctx.beginPath();
                    ctx.moveTo(playheadX, 0);
                    ctx.lineTo(playheadX, height);
                    ctx.stroke();
                }
            
                ctx.shadowBlur = 0;
                ctx.strokeStyle = `rgba(220, 220, 220, ${(0.25 + pulseIntensity * 0.15) * 0.648})`;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(playheadX, 0);
                ctx.lineTo(playheadX, height);
                ctx.stroke();
                
                ctx.shadowBlur = 0;
                ctx.shadowColor = 'transparent';
            }
            
            // 🔥 Draw regions during crossfade so they stay visible throughout the transition
            drawRegionHighlights(ctx, canvas.width, canvas.height);
            drawRegionButtons(); // Draw buttons on overlay canvas
            
            if (progress < 1.0) {
                State.setCrossfadeAnimation(requestAnimationFrame(animate));
            } else {
                const cachedCanvas = document.createElement('canvas');
                cachedCanvas.width = width;
                cachedCanvas.height = height;
                cachedCanvas.getContext('2d').drawImage(newCanvas, 0, 0);
                State.setCachedWaveformCanvas(cachedCanvas);
                
                // Draw waveform axis after crossfade completes
                positionWaveformAxisCanvas();
                drawWaveformAxis();
                positionWaveformXAxisCanvas();
                drawWaveformXAxis();
                positionWaveformDateCanvas();
                drawWaveformDate();
                
                if (!isStudyMode()) {
                    // console.log(`✅ Waveform crossfade complete - pink detrended waveform`);
                }
                
                if (State.totalAudioDuration > 0) {
                    drawWaveformWithSelection();
                }
                
                // 🔧 Render regions after crossfade completes (if they were delayed)
                // This ensures regions don't appear before the waveform crossfade finishes
                renderRegionsAfterCrossfade();
            }
        };
        animate();
        
    } else {
        console.log(`🔍 [PIPELINE] Drawing waveform directly (no cached canvas)`);
        // Dark red background (like spectrogram but red instead of black)
        ctx.fillStyle = '#1a0000'; // Deeper dark red
        ctx.fillRect(0, 0, width, height);
        
        const mid = height / 2;
        const { mins, maxs } = State.waveformMinMaxData;
        console.log(`🔍 [PIPELINE] Drawing ${mins.length} waveform pixels`);
        
        // Use pre-computed max amplitude (cached when waveformMinMaxData was set)
        const maxAmplitude = State.waveformMaxAmplitude || 0;
        
        // Pre-compute color indices with horizontal smoothing (low-pass filter)
        const colorIndices = new Float32Array(mins.length);
        for (let x = 0; x < mins.length; x++) {
            const amplitude = Math.max(Math.abs(mins[x]), Math.abs(maxs[x]));
            const normalizedAmplitude = maxAmplitude > 0 ? amplitude / maxAmplitude : 0;
            colorIndices[x] = normalizedAmplitude * 255;
        }
        
        // Apply horizontal smoothing (simple moving average)
        const smoothedIndices = new Float32Array(mins.length);
        const smoothingRadius = 3; // Smooth over 7 pixels (3 on each side)
        for (let x = 0; x < mins.length; x++) {
            let sum = 0;
            let count = 0;
            for (let dx = -smoothingRadius; dx <= smoothingRadius; dx++) {
                const idx = x + dx;
                if (idx >= 0 && idx < mins.length) {
                    sum += colorIndices[idx];
                    count++;
                }
            }
            smoothedIndices[x] = sum / count;
        }
        
        // Draw waveform with smoothed, muted colors
        for (let x = 0; x < mins.length && x < width; x++) {
            const min = mins[x];
            const max = maxs[x];

            // Canvas Y: 0 at top, increases downward
            // Data: positive values should go UP (smaller Y), negative DOWN (larger Y)
            const yMin = mid - (max * mid * 0.9);  // max value → top of bar (smaller Y)
            const yMax = mid - (min * mid * 0.9);  // min value → bottom of bar (larger Y)
            
            const lineHeight = Math.max(1, yMax - yMin);
            
            // Use smoothed color index
            const colorIndex = Math.floor(smoothedIndices[x]);
            
            // Get color from pre-computed LUT
            const r = waveformColorLUT[colorIndex * 3];
            const g = waveformColorLUT[colorIndex * 3 + 1];
            const b = waveformColorLUT[colorIndex * 3 + 2];
            
            ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
            ctx.fillRect(x, yMin, 1, lineHeight);
        }
        
        ctx.strokeStyle = '#666';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, mid);
        ctx.lineTo(width, mid);
        ctx.stroke();
        
        const cachedCanvas = document.createElement('canvas');
        cachedCanvas.width = width;
        cachedCanvas.height = height;
        const cacheCtx = cachedCanvas.getContext('2d');
        cacheCtx.drawImage(canvas, 0, 0);
        State.setCachedWaveformCanvas(cachedCanvas);
        console.log(`🔍 [PIPELINE] Waveform cached, canvas dimensions: ${width}x${height}`);
        
        // Draw waveform axis after waveform is drawn
        positionWaveformAxisCanvas();
        drawWaveformAxis();
        positionWaveformXAxisCanvas();
        drawWaveformXAxis();
        positionWaveformDateCanvas();
        drawWaveformDate();
        
        // 🔧 Render regions after waveform is drawn (same as crossfade completion)
        // This ensures regions appear whether or not there was a crossfade animation
        renderRegionsAfterCrossfade();
        
        console.log(`✅ [PIPELINE] Waveform drawing complete!`);
        if (DEBUG_WAVEFORM) console.log(`✅ Waveform drawn from min/max data (${mins.length} pixels) - progressive`);
    }
}

/**
 * Draw waveform with smooth zoom interpolation during transitions
 * Stretches the cached waveform to match the interpolating time range
 */
export function drawInterpolatedWaveform() {
    const canvas = document.getElementById('waveform');
    if (!canvas || !State.cachedWaveformCanvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    // Get the interpolated time range (same range the ticks are using)
    const interpolatedRange = getInterpolatedTimeRange();

    // Calculate what portion of the cached canvas to draw
    const dataStartMs = State.dataStartTime.getTime();
    const dataEndMs = State.dataEndTime.getTime();
    const dataDurationMs = dataEndMs - dataStartMs;

    const interpStartMs = interpolatedRange.startTime.getTime();
    const interpEndMs = interpolatedRange.endTime.getTime();

    // Calculate source rectangle in the cached canvas
    const startProgress = (interpStartMs - dataStartMs) / dataDurationMs;
    const endProgress = (interpEndMs - dataStartMs) / dataDurationMs;

    const cachedWidth = State.cachedWaveformCanvas.width;
    const sourceX = startProgress * cachedWidth;
    const sourceWidth = (endProgress - startProgress) * cachedWidth;

    // Clear and draw stretched portion
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(
        State.cachedWaveformCanvas,
        sourceX, 0, sourceWidth, State.cachedWaveformCanvas.height,  // source
        0, 0, width, height  // destination (stretched to fill)
    );

    // Draw region highlights on top (they use the same interpolated range)
    drawRegionHighlights(ctx, canvas.width, canvas.height);
    drawRegionButtons(); // Draw buttons on overlay canvas

    // Draw playhead (also using interpolated time range for smooth positioning)
    if (State.currentAudioPosition !== null && State.totalAudioDuration > 0 && State.currentAudioPosition >= 0) {
        // Convert playhead position to timestamp
        const playheadSample = zoomState.timeToSample(State.currentAudioPosition);
        const playheadTimestamp = zoomState.sampleToRealTimestamp(playheadSample);

        if (playheadTimestamp) {
            const playheadMs = playheadTimestamp.getTime();

            // Calculate playhead position within the interpolated time range
            const timeDiff = interpEndMs - interpStartMs;
            
            // Guard against division by zero or invalid time ranges
            if (timeDiff <= 0) {
                return; // Skip playhead drawing if time range is invalid
            }
            
            const progress = (playheadMs - interpStartMs) / timeDiff;
            const x = progress * width;
            
            // Guard against non-finite values (NaN, Infinity) and ensure x is within bounds
            if (!isFinite(x) || !isFinite(height) || height <= 0 || x < 0 || x > width) {
                return; // Skip playhead drawing if coordinates are invalid
            }

            // Cool playhead with glow and gradient
            const time = performance.now() * 0.001;
            const pulseIntensity = 0.3 + Math.sin(time * 3) * 0.1;
            
            ctx.shadowBlur = 8;
            ctx.shadowColor = 'rgba(255, 0, 0, 0.54)'; // 0.6 * 0.9
            
            const gradient = ctx.createLinearGradient(x, 0, x, height);
            gradient.addColorStop(0, `rgba(255, 100, 100, ${(0.9 + pulseIntensity) * 0.9})`);
            gradient.addColorStop(0.5, `rgba(255, 0, 0, ${(0.95 + pulseIntensity) * 0.9})`);
            gradient.addColorStop(1, `rgba(255, 100, 100, ${(0.9 + pulseIntensity) * 0.9})`);
            
            ctx.strokeStyle = gradient;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
            
            ctx.shadowBlur = 0;
            ctx.strokeStyle = `rgba(220, 220, 220, ${(0.25 + pulseIntensity * 0.15) * 0.648})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
            
            ctx.shadowColor = 'transparent';
        }
    }
}

export function drawWaveformWithSelection() {
    const canvas = document.getElementById('waveform');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    // Throttle logs to once per 500ms (unless forced by user interaction)
    // Throttled debug logging (disabled to reduce noise)
    // const now = performance.now();
    // if (forceNextPlayheadLog || (now - lastDrawWaveformLogTime) > 500) {
    //     console.log(`🎨 drawWaveformWithSelection called: currentPos=${State.currentAudioPosition?.toFixed(2)}s, cachedCanvas=${!!State.cachedWaveformCanvas}`);
    //     lastDrawWaveformLogTime = now;
    // }

    if (!State.cachedWaveformCanvas) {
        // No cached canvas - draw playhead only if needed
        if (State.totalAudioDuration > 0 && State.currentAudioPosition >= 0) {
            // 🏛️ Use zoom-aware conversion
            let x;
            if (zoomState.isInitialized()) {
                const sample = zoomState.timeToSample(State.currentAudioPosition);
                x = zoomState.sampleToPixel(sample, width);
            } else {
                // Fallback to old behavior if zoom state not initialized
            const progress = Math.min(State.currentAudioPosition / State.totalAudioDuration, 1.0);
                x = progress * width;
            }
            
            // Cool playhead with glow and gradient
            const time = performance.now() * 0.001;
            const pulseIntensity = 0.3 + Math.sin(time * 3) * 0.1;
            
            // 🔥 PROTECTION: Ensure x is finite before creating gradient
            if (isFinite(x) && x >= 0 && x <= width) {
                ctx.shadowBlur = 8;
                ctx.shadowColor = 'rgba(255, 0, 0, 0.54)'; // 0.6 * 0.9
                
                const gradient = ctx.createLinearGradient(x, 0, x, height);
                gradient.addColorStop(0, `rgba(255, 100, 100, ${(0.9 + pulseIntensity) * 0.9})`);
                gradient.addColorStop(0.5, `rgba(255, 0, 0, ${(0.95 + pulseIntensity) * 0.9})`);
                gradient.addColorStop(1, `rgba(255, 100, 100, ${(0.9 + pulseIntensity) * 0.9})`);
                
                ctx.strokeStyle = gradient;
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, height);
                ctx.stroke();
            }
            
            ctx.shadowBlur = 0;
            ctx.strokeStyle = `rgba(220, 220, 220, ${(0.25 + pulseIntensity * 0.15) * 0.648})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
            
            ctx.shadowColor = 'transparent';
        }
        return;
    }
    
    // Now proceed with drawing - cache is guaranteed to match canvas size
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(State.cachedWaveformCanvas, 0, 0);  // ✅ Sizes match now!
    
    // Draw region highlights (before selection box)
    drawRegionHighlights(ctx, canvas.width, canvas.height);
    drawRegionButtons(); // Draw buttons on overlay canvas
    
    // Only draw yellow selection box if NOT playing an active region
    // When playing a region, we only want the blue region highlight, not the yellow selection box
    if (State.selectionStart !== null && State.selectionEnd !== null && !isPlayingActiveRegion()) {
        // 🏛️ Use zoom-aware conversion
        let startX, endX;
        if (zoomState.isInitialized()) {
            const startSample = zoomState.timeToSample(State.selectionStart);
            const endSample = zoomState.timeToSample(State.selectionEnd);
            startX = zoomState.sampleToPixel(startSample, width);
            endX = zoomState.sampleToPixel(endSample, width);
        } else {
            // Fallback to old behavior if zoom state not initialized
        const startProgress = State.selectionStart / State.totalAudioDuration;
        const endProgress = State.selectionEnd / State.totalAudioDuration;
            startX = startProgress * width;
            endX = endProgress * width;
        }
        const selectionWidth = endX - startX;
        
        ctx.fillStyle = 'rgba(255, 220, 120, 0.25)'; // Softer, less intense yellow
        ctx.fillRect(startX, 0, selectionWidth, height);
        
        ctx.strokeStyle = 'rgba(255, 180, 100, 0.6)'; // Softer, less intense yellow-orange
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(startX, 0);
        ctx.lineTo(startX, height);
        ctx.moveTo(endX, 0);
        ctx.lineTo(endX, height);
        ctx.stroke();
    }
    
    let playheadPosition = null;
    
    if (State.isSelecting && State.selectionStart !== null) {
        playheadPosition = State.selectionStart;
    } else {
        playheadPosition = State.currentAudioPosition;
    }
    
    if (playheadPosition !== null && State.totalAudioDuration > 0 && playheadPosition >= 0) {
        // Throttle logs to once per 500ms (unless forced by user interaction)
        // Throttled debug logging (disabled to reduce noise)
        // const now = performance.now();
        // if (forceNextPlayheadLog || (now - lastPlayheadLogTime) > 500) {
        //     console.log(`🎨 Drawing playhead: position=${playheadPosition.toFixed(2)}s, duration=${State.totalAudioDuration.toFixed(1)}s, zoom=${zoomState.isInitialized()}`);
        //     lastPlayheadLogTime = now;
        //     forceNextPlayheadLog = false;
        // }
        
        // 🏛️ Use zoom-aware conversion with interpolated time range during transitions
        let x;
        // Debug logging disabled to reduce noise
        // const shouldLog = forceNextPlayheadLog || ((now - lastPlayheadLogTime) < 100);
        
        // 🔥 FIX: During transitions, use interpolated time range (like drawInterpolatedWaveform)
        if (isZoomTransitionInProgress && zoomState.isInitialized()) {
            const sample = zoomState.timeToSample(playheadPosition);
            const playheadTimestamp = zoomState.sampleToRealTimestamp(sample);
            if (playheadTimestamp) {
                const interpolatedRange = getInterpolatedTimeRange();
                const interpStartMs = interpolatedRange.startTime.getTime();
                const interpEndMs = interpolatedRange.endTime.getTime();
                const playheadMs = playheadTimestamp.getTime();
                const timeDiff = interpEndMs - interpStartMs;
                
                if (timeDiff > 0) {
                    const progress = (playheadMs - interpStartMs) / timeDiff;
                    x = progress * width;
                } else {
                    x = 0; // Fallback if time range is invalid
                }
            } else {
                x = 0; // Fallback if timestamp conversion fails
            }
        } else if (zoomState.isInitialized()) {
            const sample = zoomState.timeToSample(playheadPosition);
            x = zoomState.sampleToPixel(sample, width);
            // if (shouldLog) {
            //     console.log(`   → sample=${sample.toLocaleString()}, x=${x.toFixed(1)}px, width=${width}px`);
            // }
        } else {
            // Fallback to old behavior if zoom state not initialized
            const progress = Math.min(playheadPosition / State.totalAudioDuration, 1.0);
            x = progress * width;
            // if (shouldLog) {
            //     console.log(`   → progress=${(progress*100).toFixed(1)}%, x=${x.toFixed(1)}px (fallback mode)`);
            // }
        }
        
        // Cool playhead with glow and gradient
        const time = performance.now() * 0.001; // For pulse animation
        const pulseIntensity = 0.3 + Math.sin(time * 3) * 0.1; // Subtle pulse
        
        // Draw glow/shadow effect
        ctx.shadowBlur = 8;
        ctx.shadowColor = 'rgba(255, 0, 0, 0.6)';
        ctx.shadowOffsetX = 0;
        
        // 🔥 PROTECTION: Ensure x is finite before creating gradient
        if (isFinite(x) && x >= 0 && x <= width) {
            // Create gradient for playhead
            const gradient = ctx.createLinearGradient(x, 0, x, height);
            gradient.addColorStop(0, `rgba(255, 100, 100, ${0.9 + pulseIntensity})`);
            gradient.addColorStop(0.5, `rgba(255, 0, 0, ${0.95 + pulseIntensity})`);
            gradient.addColorStop(1, `rgba(255, 100, 100, ${0.9 + pulseIntensity})`);
            
            // Draw main line with gradient
            ctx.strokeStyle = gradient;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }
        
        // Draw inner bright line
        ctx.shadowBlur = 0;
        ctx.strokeStyle = `rgba(220, 220, 220, ${(0.25 + pulseIntensity * 0.15) * 0.72})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
        
        // Reset shadow
        ctx.shadowBlur = 0;
        ctx.shadowColor = 'transparent';
    }
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
        if (zoomState.isInitialized()) {
            const timestamp = zoomState.pixelToTimestamp(x, rect.width);
            targetPosition = zoomState.timestampToSeconds(timestamp);

            // 🔍 DIAGNOSTIC: Show COMPLETE click path
            // console.log('🖱️ CLICK:', {
            //     pixel: x.toFixed(1) + 'px',
            //     viewport: `${zoomState.currentViewStartTime?.toISOString()} → ${zoomState.currentViewEndTime?.toISOString()}`,
            //     clickTimestamp: timestamp.toISOString(),
            //     targetSeconds: targetPosition.toFixed(3) + 's',
            //     totalDuration: State.totalAudioDuration?.toFixed(1) + 's',
            //     sampleRate: zoomState.sampleRate + 'Hz',
            //     wouldCalculateSample: Math.floor(targetPosition * zoomState.sampleRate).toLocaleString()
            // });
        } else {
            // Fallback to old behavior if zoom state not initialized
            targetPosition = progress * State.totalAudioDuration;
        }

        return { targetPosition, progress, x, width: rect.width };
    }
    
    function updateScrubPreview(event) {
        if (!State.completeSamplesArray || !State.totalAudioDuration) return;
        
        const { targetPosition, progress } = getPositionFromMouse(event);
        State.setScrubTargetPosition(targetPosition);
        
        const ctx = canvas.getContext('2d');
        const canvasHeight = canvas.height;
        const canvasX = progress * canvas.width;
        
        if (State.cachedWaveformCanvas) {
            ctx.clearRect(0, 0, canvas.width, canvasHeight);
            ctx.drawImage(State.cachedWaveformCanvas, 0, 0);
            
            // Draw region highlights during scrub preview
            drawRegionHighlights(ctx, canvas.width, canvas.height);
            drawRegionButtons(); // Draw buttons on overlay canvas
        }
        
        // 🔥 PROTECTION: Ensure canvasX is finite before creating gradient
        if (isFinite(canvasX) && canvasX >= 0 && canvasX <= canvas.width) {
            // Cool scrub preview playhead
            const time = performance.now() * 0.001;
            const pulseIntensity = State.isDragging ? 0.1 : 0.2 + Math.sin(time * 3) * 0.1;
            
            ctx.shadowBlur = State.isDragging ? 4 : 6;
            ctx.shadowColor = State.isDragging ? 'rgba(187, 187, 187, 0.36)' : 'rgba(255, 0, 0, 0.45)'; // * 0.9
            
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
        }
        
        ctx.globalAlpha = 1.0;
        ctx.shadowColor = 'transparent';
        
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
        if (!State.waveformHasBeenClicked) {
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
        
        // Normal waveform interaction - start selection/drag
        State.setSelectionStartX(startX);
        State.setIsDragging(true);
        canvas.style.cursor = 'grabbing';
        updateScrubPreview(e);
        // console.log('🖱️ Mouse down - waiting to detect drag vs click');
    });
    
    canvas.addEventListener('mousemove', (e) => {
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
            } else {
                updateScrubPreview(e);
            }
        }
    });
    
    canvas.addEventListener('mouseup', (e) => {
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
                
                const ctx = canvas.getContext('2d');
                if (State.cachedWaveformCanvas) {
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    ctx.drawImage(State.cachedWaveformCanvas, 0, 0);
                    
                    // Draw region highlights after clearing selection
                    drawRegionHighlights(ctx, canvas.width, canvas.height);
                    drawRegionButtons(); // Draw buttons on overlay canvas
                }
                
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
}

// Diagnostic logging state
let lastDiagnosticTime = 0;

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
        // Region button reset is handled by 'selection-end-reached' message from worklet
        // The worklet is the single source of truth for when boundaries are reached

        drawWaveformWithSelection();
        drawSpectrogramPlayhead();  // Draw playhead on spectrogram too

        // Update feature box positions every frame (glued to pixels like axis ticks!)
        updateAllFeatureBoxPositions();
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
        console.log(`🔍 [PIPELINE] Worker message received: type=${type}`);
        
        if (type === 'waveform-ready') {
            const { waveformData, totalSamples, buildTime, isComplete } = e.data;
            console.log(`🔍 [PIPELINE] waveform-ready: totalSamples=${totalSamples}, waveformData.mins.length=${waveformData?.mins?.length}, isComplete=${isComplete}`);
            
            if (isComplete) {
                State.setIsShowingFinalWaveform(true);
            }
            
            if (DEBUG_WAVEFORM) console.log(`🎨 Waveform ready: ${totalSamples.toLocaleString()} samples → ${waveformData.mins.length} pixels in ${buildTime.toFixed(0)}ms`);
            
            State.setWaveformMinMaxData(waveformData);
            console.log(`🔍 [PIPELINE] Calling drawWaveformFromMinMax()`);
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
    } else {
        console.log(`⚠️ No raw waveform data available yet - load data first`);
    }
}

