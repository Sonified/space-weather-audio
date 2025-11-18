/**
 * spectrogram-complete-renderer.js - ELASTIC FRIEND VERSION 🦋
 * Complete transmission for the beautiful new world
 * 
 * KEY INSIGHT: ONE elastic friend (full spectrogram) stretches during ALL transitions
 * High-res zoomed version renders in background, crossfades when ready
 */

import * as State from './audio-state.js';

import { drawFrequencyAxis, positionAxisCanvas, resizeAxisCanvas, initializeAxisPlaybackRate } from './spectrogram-axis-renderer.js';

import { SpectrogramWorkerPool } from './spectrogram-worker-pool.js';

import { zoomState } from './zoom-state.js';

import { getInterpolatedTimeRange, getZoomDirection, getZoomTransitionProgress, getOldTimeRange, isZoomTransitionInProgress, getRegionOpacityProgress } from './waveform-x-axis-renderer.js';
import { drawSpectrogramRegionHighlights, drawSpectrogramSelection } from './region-tracker.js';
import { isStudyMode } from './master-modes.js';

// Track if we've rendered the complete spectrogram
let completeSpectrogramRendered = false;
let renderingInProgress = false;

// 🔥 PROTECTION: Track active render operation to allow cancellation
let activeRenderRegionId = null; // Track which region is currently being rendered
let activeRenderAbortController = null; // AbortController for cancelling renders

// Worker pool for parallel FFT computation
let workerPool = null;

// 🏠 THE ELASTIC FRIEND - our source of truth during transitions
let cachedFullSpectrogramCanvas = null;

// 🔬 High-res zoomed version (rendered in background, crossfaded when ready)
let cachedZoomedSpectrogramCanvas = null;

// Infinite canvas for GPU-accelerated viewport stretching
let infiniteSpectrogramCanvas = null;

// Track the context of the current infinite canvas
let infiniteCanvasContext = {
    startSample: null,
    endSample: null,
    frequencyScale: null
};

// Grey overlay for zoomed-out mode
let spectrogramOverlay = null;
const MAX_PLAYBACK_RATE = 15.0;

// Reusable temporary canvases
let tempStretchCanvas = null;
let tempShrinkCanvas = null;

// Memory monitoring
let memoryMonitorInterval = null;
let memoryBaseline = null;

// 🔍 Diagnostic helper: Track infinite canvas lifecycle
function logInfiniteCanvasState(location) {
    // Only log in dev/personal modes, not study mode
    if (!isStudyMode()) {
        console.log(`🏛️ [${location}] Infinite canvas state:`, {
            exists: !!infiniteSpectrogramCanvas,
            context: infiniteCanvasContext,
            cachedFull: !!cachedFullSpectrogramCanvas,
            cachedZoomed: !!cachedZoomedSpectrogramCanvas,
            completeRendered: completeSpectrogramRendered,
            inRegion: zoomState.isInRegion()
        });
    }
}
let memoryHistory = [];
const MEMORY_HISTORY_SIZE = 20;

/**
 * Log memory usage for monitoring
 */
function logMemory(label) {
    if (performance.memory) {
        const used = (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1);
        const total = (performance.memory.totalJSHeapSize / 1024 / 1024).toFixed(1);
        const limit = (performance.memory.jsHeapSizeLimit / 1024 / 1024).toFixed(1);
        const percent = ((performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit) * 100).toFixed(1);
        // Only log in dev/personal modes, not study mode
        if (!isStudyMode()) {
            console.log(`💾 ${label}: ${used}MB / ${total}MB (limit: ${limit}MB, ${percent}% used)`);
        }
        
        if (percent > 80) {
            console.warn('⚠️ Memory usage high!');
        }
        
        return parseFloat(used);
    }
    return null;
}

/**
 * Periodic memory health check
 */
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
            trend = '📈 increasing';
            console.warn(`🚨 POTENTIAL MEMORY LEAK: Baseline grew ${growth.toFixed(0)}MB (${oldBaseline.toFixed(0)}MB → ${newBaseline.toFixed(0)}MB)`);
        } else if (growth > 100) {
            trend = '📈 rising';
        }
    }
    
    const avgPercent = (memoryHistory.reduce((sum, h) => sum + h.percent, 0) / memoryHistory.length).toFixed(1);
    // Only log in dev/personal modes, not study mode
    if (!isStudyMode()) {
        console.log(`🏥 Memory health: ${used.toFixed(0)}MB (${percent}%) | Baseline: ${memoryBaseline.toFixed(0)}MB | Avg: ${avgPercent}% | Limit: ${limit.toFixed(0)}MB | Trend: ${trend}`);
    }
}

/**
 * Start periodic memory monitoring
 */
export function startMemoryMonitoring() {
    if (memoryMonitorInterval) return;
    
    // Only log in dev/personal modes, not study mode
    if (!isStudyMode()) {
        console.log('🏥 Starting memory health monitoring (every 10 seconds)');
    }
    memoryMonitorInterval = setInterval(memoryHealthCheck, 10000);
    memoryHealthCheck();
}

/**
 * Stop periodic memory monitoring
 */
export function stopMemoryMonitoring() {
    if (memoryMonitorInterval) {
        clearInterval(memoryMonitorInterval);
        memoryMonitorInterval = null;
        console.log('🏥 Stopped memory health monitoring');
    }
}

/**
 * Convert HSL to RGB
 */
// Pre-computed color LUT (computed once, reused for all renders)
// Maps 256 intensity levels to RGB values using HSL color space
let colorLUT = null;

function initializeColorLUT() {
    if (colorLUT !== null) return; // Already initialized
    
    colorLUT = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
        const normalized = i / 255;
        const hue = normalized * 60;
        const saturation = 100;
        const lightness = 10 + (normalized * 60);
        
        const rgb = hslToRgb(hue, saturation, lightness);
        colorLUT[i * 3] = rgb[0];
        colorLUT[i * 3 + 1] = rgb[1];
        colorLUT[i * 3 + 2] = rgb[2];
    }
    // Only log in dev/personal modes, not study mode
    if (!isStudyMode()) {
        console.log(`🎨 Pre-computed color LUT (256 levels) - cached for reuse`);
    }
}

// Initialize color LUT on module load
initializeColorLUT();

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

/**
 * Main function to render the complete spectrogram (FULL VIEW)
 * This becomes our ELASTIC FRIEND 🏠
 */
export async function renderCompleteSpectrogram(skipViewportUpdate = false) {
    // Only log in dev/personal modes, not study mode
    if (!isStudyMode()) {
        console.log(`🎨 [spectrogram-complete-renderer.js] renderCompleteSpectrogram CALLED: skipViewportUpdate=${skipViewportUpdate}`);
    }
    // console.trace('📍 Call stack:');
    
    if (!State.completeSamplesArray || State.completeSamplesArray.length === 0) {
        if (!isStudyMode()) {
            console.log('⚠️ Cannot render complete spectrogram - no audio data available');
        }
        return;
    }
    
    if (renderingInProgress) {
        if (!isStudyMode()) {
            console.log('⚠️ Spectrogram rendering already in progress');
        }
        return;
    }
    
    // If inside a region, render that instead
    if (zoomState.isInRegion()) {
        const regionRange = zoomState.getRegionRange();
        if (!isStudyMode()) {
            console.log(`🔍 Inside temple - rendering region instead`);
        }
        return await renderCompleteSpectrogramForRegion(regionRange.startTime, regionRange.endTime);
    }
    
    if (completeSpectrogramRendered) {
        if (!isStudyMode()) {
            console.log('✅ Complete spectrogram already rendered');
        }
        return;
    }
    
    // Check if we need to re-render due to context change
    const audioData = State.completeSamplesArray;
    const totalSamples = audioData ? audioData.length : 0;
    const needsRerender = infiniteSpectrogramCanvas && 
        (infiniteCanvasContext.startSample !== 0 ||
         infiniteCanvasContext.endSample !== totalSamples ||
         infiniteCanvasContext.frequencyScale !== State.frequencyScale);
    
    if (needsRerender) {
        if (!isStudyMode()) {
            console.log('🔄 Context changed - clearing old self and re-rendering');
        }
        clearInfiniteCanvas();
    }
    
    renderingInProgress = true;
    if (!isStudyMode()) {
        console.log('🎨 Starting complete spectrogram rendering...');
    }
    logInfiniteCanvasState('renderCompleteSpectrogram START');
    logMemory('Before FFT computation');
    
    const canvas = document.getElementById('spectrogram');
    if (!canvas) {
        console.error('❌ Spectrogram canvas not found');
        renderingInProgress = false;
        return;
    }
    
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    const width = canvas.width;
    const height = canvas.height;
    
    if (!skipViewportUpdate) {
        ctx.clearRect(0, 0, width, height);
    }
    
    try {
        const startTime = performance.now();
        
        const totalSamples = audioData.length;
        const sampleRate = 44100;
        
        if (!isStudyMode()) {
            console.log(`📊 Rendering spectrogram for ${totalSamples.toLocaleString()} samples (${(totalSamples / sampleRate).toFixed(2)}s)`);
        }
        
        // FFT parameters
        const fftSize = 2048;
        const frequencyBinCount = fftSize / 2;
        
        const maxTimeSlices = width;
        const hopSize = Math.floor((totalSamples - fftSize) / maxTimeSlices);
        const numTimeSlices = Math.min(maxTimeSlices, Math.floor((totalSamples - fftSize) / hopSize));
        
        // console.log(`🔧 FFT size: ${fftSize}, Hop size: ${hopSize.toLocaleString()}, Time slices: ${numTimeSlices.toLocaleString()} (optimized for ${width}px width)`);
        
        // Pre-compute Hann window
        const window = new Float32Array(fftSize);
        for (let i = 0; i < fftSize; i++) {
            window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / fftSize));
        }
        
        // Initialize worker pool if needed
        if (!workerPool) {
            workerPool = new SpectrogramWorkerPool();
            await workerPool.initialize();
        }
        
        // Helper function to calculate y position based on frequency scale
        const getYPosition = (binIndex, totalBins, canvasHeight) => {
            const originalSampleRate = State.currentMetadata?.original_sample_rate || 100;
            const originalNyquist = originalSampleRate / 2;
            
            const frequency = (binIndex / totalBins) * originalNyquist;
            
            if (State.frequencyScale === 'logarithmic') {
                const minFreq = 0.1;
                const freqSafe = Math.max(frequency, minFreq);
                const logMin = Math.log10(minFreq);
                const logMax = Math.log10(originalNyquist);
                const logFreq = Math.log10(freqSafe);
                const normalizedLog = (logFreq - logMin) / (logMax - logMin);
                
                return canvasHeight - (normalizedLog * canvasHeight);
            } else if (State.frequencyScale === 'sqrt') {
                const normalized = frequency / originalNyquist;
                const sqrtNormalized = Math.sqrt(normalized);
                return canvasHeight - (sqrtNormalized * canvasHeight);
            } else {
                const normalized = frequency / originalNyquist;
                return canvasHeight - (normalized * canvasHeight);
            }
        };
        
        // Create ImageData for direct pixel manipulation
        const imageData = ctx.createImageData(width, height);
        const pixels = imageData.data;
        
        // Use pre-computed color LUT (computed once at module load)
        // No need to recompute - it's constant!
        
        const pixelsPerSlice = width / numTimeSlices;
        
        // Create batches for parallel processing
        const batchSize = 50;
        const batches = [];
        
        for (let batchStart = 0; batchStart < numTimeSlices; batchStart += batchSize) {
            const batchEnd = Math.min(batchStart + batchSize, numTimeSlices);
            batches.push({ start: batchStart, end: batchEnd });
        }
        
        // console.log(`📦 Processing ${numTimeSlices} slices in ${batches.length} batches across worker pool`);
        
        // Function to draw results from worker
        const drawResults = (results, progress, workerIndex) => {
            for (const result of results) {
                const { sliceIdx, magnitudes } = result;
                
                const xStart = Math.floor(sliceIdx * pixelsPerSlice);
                const xEnd = Math.floor((sliceIdx + 1) * pixelsPerSlice);
                
                for (let binIdx = 0; binIdx < frequencyBinCount; binIdx++) {
                    const magnitude = magnitudes[binIdx];
                    
                    const db = 20 * Math.log10(magnitude + 1e-10);
                    const normalizedDb = Math.max(0, Math.min(1, (db + 100) / 100));
                    const colorIndex = Math.floor(normalizedDb * 255);
                    
                    const r = colorLUT[colorIndex * 3];
                    const g = colorLUT[colorIndex * 3 + 1];
                    const b = colorLUT[colorIndex * 3 + 2];
                    
                    const yStart = Math.floor(getYPosition(binIdx + 1, frequencyBinCount, height));
                    const yEnd = Math.floor(getYPosition(binIdx, frequencyBinCount, height));
                    
                    for (let x = xStart; x < xEnd; x++) {
                        for (let y = yStart; y < yEnd; y++) {
                            const pixelIndex = (y * width + x) * 4;
                            pixels[pixelIndex] = r;
                            pixels[pixelIndex + 1] = g;
                            pixels[pixelIndex + 2] = b;
                            pixels[pixelIndex + 3] = 255;
                        }
                    }
                }
                
                result.magnitudes = null;
            }
            
            // console.log(`⏳ Spectrogram rendering: ${progress}% (worker ${workerIndex})`);
        };
        
        // Process all batches in parallel
        await workerPool.processBatches(
            audioData,
            batches,
            fftSize,
            hopSize,
            window,
            drawResults
        );
        
        // Write ImageData to temp canvas (neutral 450px render)
        // console.log(`🎨 Writing ImageData to neutral render canvas...`);
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.putImageData(imageData, 0, 0);
        
        // Create infinite canvas
        const infiniteHeight = Math.floor(height * MAX_PLAYBACK_RATE);
        infiniteSpectrogramCanvas = document.createElement('canvas');
        infiniteSpectrogramCanvas.width = width;
        infiniteSpectrogramCanvas.height = infiniteHeight;
        const infiniteCtx = infiniteSpectrogramCanvas.getContext('2d');
        
        infiniteCtx.fillStyle = '#000';
        infiniteCtx.fillRect(0, 0, width, infiniteHeight);
        
        infiniteCtx.drawImage(tempCanvas, 0, infiniteHeight - height);
        
        // console.log(`🌊 Created infinite canvas: ${width} × ${infiniteHeight}px`);
        // console.log(`   Placed neutral ${width} × ${height}px render at bottom`);
        
        // Record the context
        infiniteCanvasContext = {
            startSample: 0,
            endSample: totalSamples,
            frequencyScale: State.frequencyScale
        };
        // console.log(`🏛️ New self created: Full view (0-${totalSamples.toLocaleString()}), scale=${State.frequencyScale}`);
        
        // 🏠 STORE AS ELASTIC FRIEND (our source of truth for transitions!)
        cachedFullSpectrogramCanvas = tempCanvas;
        
        // logInfiniteCanvasState('renderCompleteSpectrogram COMPLETE - infinite canvas created');
        
        const elapsed = performance.now() - startTime;
        // console.log(`✅ Complete spectrogram rendered in ${elapsed.toFixed(0)}ms`);
        // console.log(`🏠 Elastic friend ready for duty!`);
        
        // logMemory('After FFT completion');
        
        completeSpectrogramRendered = true;
        State.setSpectrogramInitialized(true);
        
        // Draw frequency axis
        positionAxisCanvas();
        initializeAxisPlaybackRate();
        drawFrequencyAxis();
        
        // Update display canvas with initial viewport
        if (!skipViewportUpdate) {
            updateSpectrogramViewport(State.currentPlaybackRate || 1.0);
            
            // Initialize overlay - create it and set initial opacity (visible when zoomed out)
            createSpectrogramOverlay();
            const progress = getZoomTransitionProgress();
            updateSpectrogramOverlay(progress);
        }
        
    } catch (error) {
        console.error('❌ Error rendering complete spectrogram:', error);
    } finally {
        renderingInProgress = false;
    }
}

/**
 * Clear the infinite canvas and its context
 */
function clearInfiniteCanvas() {
    if (infiniteSpectrogramCanvas) {
        const ctx = infiniteSpectrogramCanvas.getContext('2d');
        ctx.clearRect(0, 0, infiniteSpectrogramCanvas.width, infiniteSpectrogramCanvas.height);
        infiniteSpectrogramCanvas.width = 0;
        infiniteSpectrogramCanvas.height = 0;
        infiniteSpectrogramCanvas = null;
    }
    
    infiniteCanvasContext = {
        startSample: null,
        endSample: null,
        frequencyScale: null
    };
    
    // console.log('🧹 Infinite canvas cleared - ready for new self');
    // logInfiniteCanvasState('clearInfiniteCanvas COMPLETE');
}

/**
 * Reset spectrogram state without clearing the display canvas
 */
export function resetSpectrogramState() {
    completeSpectrogramRendered = false;
    renderingInProgress = false;
    State.setSpectrogramInitialized(false);
    
    clearInfiniteCanvas();
    
    // DON'T clear the elastic friend during transitions!
    // We need it to stretch smoothly
    
    // Clear zoomed cache
    if (cachedZoomedSpectrogramCanvas) {
        try {
            const cacheCtx = cachedZoomedSpectrogramCanvas.getContext('2d');
            cacheCtx.clearRect(0, 0, cachedZoomedSpectrogramCanvas.width, cachedZoomedSpectrogramCanvas.height);
            cachedZoomedSpectrogramCanvas.width = 0;
            cachedZoomedSpectrogramCanvas.height = 0;
        } catch (e) {
            console.warn('⚠️ Error clearing zoomed cache:', e);
        }
        cachedZoomedSpectrogramCanvas = null;
    }
    
    // Clean up temporary canvases
    if (tempStretchCanvas) {
        tempStretchCanvas.width = 0;
        tempStretchCanvas.height = 0;
        tempStretchCanvas = null;
    }
    if (tempShrinkCanvas) {
        tempShrinkCanvas.width = 0;
        tempShrinkCanvas.height = 0;
        tempShrinkCanvas = null;
    }
}

/**
 * Restore infinite canvas from cached elastic friend
 * Used when zooming back to full view - no FFT needed!
 */
export function restoreInfiniteCanvasFromCache() {
    // logInfiniteCanvasState('restoreInfiniteCanvasFromCache START');
    
    if (!cachedFullSpectrogramCanvas) {
        console.warn('⚠️ Cannot restore - no elastic friend cached!');
        return;
    }
    
    const canvas = document.getElementById('spectrogram');
    if (!canvas) return;
    
    // console.log('🏠 Restoring infinite canvas from elastic friend (no FFT!)');
    
    const width = canvas.width;
    const height = canvas.height;
    const infiniteHeight = Math.floor(height * MAX_PLAYBACK_RATE);
    
    // Recreate infinite canvas from elastic friend
    infiniteSpectrogramCanvas = document.createElement('canvas');
    infiniteSpectrogramCanvas.width = width;
    infiniteSpectrogramCanvas.height = infiniteHeight;
    const infiniteCtx = infiniteSpectrogramCanvas.getContext('2d');
    
    infiniteCtx.fillStyle = '#000';
    infiniteCtx.fillRect(0, 0, width, infiniteHeight);
    infiniteCtx.drawImage(cachedFullSpectrogramCanvas, 0, infiniteHeight - height);
    
    // Record context
    infiniteCanvasContext = {
        startSample: 0,
        endSample: State.completeSamplesArray ? State.completeSamplesArray.length : 0,
        frequencyScale: State.frequencyScale
    };
    
    // 🔥 THE FIX: Ring the doorbell! The butterfly is home!
    completeSpectrogramRendered = true;  // Mark spectrogram as rendered for animation system
    State.setSpectrogramInitialized(true);  // Ensure initialization flag is set
    
    // console.log('✅ Infinite canvas restored from cache - ready for stretching!');
    
    // logInfiniteCanvasState('restoreInfiniteCanvasFromCache COMPLETE - full view restored');
}

export function clearCompleteSpectrogram() {
    // Only log in dev/personal modes, not study mode
    if (!isStudyMode()) {
        console.log('🧹 [spectrogram-complete-renderer.js] clearCompleteSpectrogram CALLED');
        console.trace('📍 Call stack:');
        console.log('🧹 Starting aggressive spectrogram cleanup...');
    }
    
    logMemory('Before cleanup');
    
    const canvas = document.getElementById('spectrogram');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    
    // Clear elastic friend
    if (cachedFullSpectrogramCanvas) {
        try {
            const cacheCtx = cachedFullSpectrogramCanvas.getContext('2d');
            cacheCtx.clearRect(0, 0, cachedFullSpectrogramCanvas.width, cachedFullSpectrogramCanvas.height);
            cachedFullSpectrogramCanvas.width = 0;
            cachedFullSpectrogramCanvas.height = 0;
        } catch (e) {
            console.warn('⚠️ Error clearing elastic friend:', e);
        }
        cachedFullSpectrogramCanvas = null;
    }
    
    // Clear infinite canvas
    clearInfiniteCanvas();
    
    // Clear zoomed cache
    if (cachedZoomedSpectrogramCanvas) {
        try {
            const cacheCtx = cachedZoomedSpectrogramCanvas.getContext('2d');
            cacheCtx.clearRect(0, 0, cachedZoomedSpectrogramCanvas.width, cachedZoomedSpectrogramCanvas.height);
            cachedZoomedSpectrogramCanvas.width = 0;
            cachedZoomedSpectrogramCanvas.height = 0;
        } catch (e) {
            console.warn('⚠️ Error clearing zoomed cache:', e);
        }
        cachedZoomedSpectrogramCanvas = null;
    }
    
    // Clean up temporary canvases
    if (tempStretchCanvas) {
        tempStretchCanvas.width = 0;
        tempStretchCanvas.height = 0;
        tempStretchCanvas = null;
    }
    if (tempShrinkCanvas) {
        tempShrinkCanvas.width = 0;
        tempShrinkCanvas.height = 0;
        tempShrinkCanvas = null;
    }
    
    completeSpectrogramRendered = false;
    renderingInProgress = false;
    State.setSpectrogramInitialized(false);
    
    // Terminate worker pool
    if (workerPool) {
        workerPool.terminate();
        workerPool = null;
    }
    
    if (typeof window !== 'undefined' && window.gc) {
        if (!isStudyMode()) {
            console.log('🗑️ Requesting manual garbage collection...');
        }
        window.gc();
    }
    
    logMemory('After aggressive cleanup');
    
    // Only log in dev/personal modes, not study mode
    if (!isStudyMode()) {
        console.log('✅ Spectrogram cleanup complete');
    }
}

/**
 * Check if complete spectrogram has been rendered
 */
export function isCompleteSpectrogramRendered() {
    return completeSpectrogramRendered;
}

/**
 * Get the cached spectrogram canvas (for backward compatibility)
 */
export function getCachedSpectrogramCanvas() {
    return cachedFullSpectrogramCanvas; // Return elastic friend
}

/**
 * Cache the current spectrogram as the full view
 * Called before zooming in - stores our elastic friend
 */
export function cacheFullSpectrogram() {
    const canvas = document.getElementById('spectrogram');
    if (!canvas || !cachedFullSpectrogramCanvas) {
        return;
    }
    
    // Already cached - elastic friend is ready!
    console.log('💾 Elastic friend already cached and ready');
}

/**
 * Clear the cached full spectrogram
 */
export function clearCachedFullSpectrogram() {
    // Don't clear during transitions - we need it!
    // Only clear on full cleanup
    // console.log('🏠 Keeping elastic friend around');
}

/**
 * Cache the current zoomed spectrogram (before zooming out)
 */
export function cacheZoomedSpectrogram() {
    if (!infiniteSpectrogramCanvas) {
        return;
    }
    
    // Create a snapshot of the current zoomed infinite canvas
    const cachedCopy = document.createElement('canvas');
    cachedCopy.width = infiniteSpectrogramCanvas.width;
    cachedCopy.height = infiniteSpectrogramCanvas.height;
    const cachedCtx = cachedCopy.getContext('2d');
    cachedCtx.drawImage(infiniteSpectrogramCanvas, 0, 0);
    cachedZoomedSpectrogramCanvas = cachedCopy;
    
    // console.log('💾 Cached zoomed spectrogram');
}

/**
 * Clear the cached zoomed spectrogram
 */
export function clearCachedZoomedSpectrogram() {
    if (cachedZoomedSpectrogramCanvas) {
        const ctx = cachedZoomedSpectrogramCanvas.getContext('2d');
        ctx.clearRect(0, 0, cachedZoomedSpectrogramCanvas.width, cachedZoomedSpectrogramCanvas.height);
        cachedZoomedSpectrogramCanvas.width = 0;
        cachedZoomedSpectrogramCanvas.height = 0;
        cachedZoomedSpectrogramCanvas = null;
        console.log('🧹 Cleared zoomed cache');
    }
}

/**
 * 🏠 THE ELASTIC FRIEND - stretches during ALL transitions!
 * Just like the waveform and x-axis - one source, one stretch, done!
 */
export function drawInterpolatedSpectrogram() {
    // 🚨 ONLY call during transitions!
    if (!isZoomTransitionInProgress()) {
        // console.log(`⚠️ drawInterpolatedSpectrogram: NOT in transition - returning early!`);
        return; // Not in transition - don't touch the display!
    }
    
    const canvas = document.getElementById('spectrogram');
    if (!canvas || !State.dataStartTime || !State.dataEndTime) {
        return;
    }
    
    // 🏠 Trust our elastic friend!
    if (!cachedFullSpectrogramCanvas) {
        return;
    }
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    // 🎯 Use EXACT same interpolation logic as x-axis and waveform!
    const interpolatedRange = getInterpolatedTimeRange();
    
    // Calculate which slice of elastic friend to show (horizontal)
    const dataStartMs = State.dataStartTime.getTime();
    const dataEndMs = State.dataEndTime.getTime();
    const dataDurationMs = dataEndMs - dataStartMs;
    
    if (dataDurationMs <= 0) {
        return;
    }
    
    const interpStartMs = interpolatedRange.startTime.getTime();
    const interpEndMs = interpolatedRange.endTime.getTime();
    
    const startProgress = (interpStartMs - dataStartMs) / dataDurationMs;
    const endProgress = (interpEndMs - dataStartMs) / dataDurationMs;
    
    const cachedWidth = cachedFullSpectrogramCanvas.width;
    const sourceX = startProgress * cachedWidth;
    const sourceWidth = (endProgress - startProgress) * cachedWidth;
    
    // 🎨 NEW: Apply playback rate stretch (vertical) - same as updateSpectrogramViewport!
    const playbackRate = State.currentPlaybackRate || 1.0;
    const stretchFactor = calculateStretchFactor(playbackRate, State.frequencyScale);
    const stretchedHeight = Math.floor(height * stretchFactor);
    
    // console.log(`🏄‍♂️ Interpolated spectrogram: playbackRate=${playbackRate.toFixed(2)}, stretchFactor=${stretchFactor.toFixed(3)}, stretchedHeight=${stretchedHeight}px`);
    
    // Update overlay opacity (fade out when zooming in, fade in when zooming out)
    updateSpectrogramOverlay();
    
    ctx.clearRect(0, 0, width, height);
    
    if (stretchedHeight >= height) {
        // Stretching up - create temp canvas for the stretched slice
        if (!tempStretchCanvas || tempStretchCanvas.width !== width || tempStretchCanvas.height !== stretchedHeight) {
            if (tempStretchCanvas) {
                tempStretchCanvas.width = 0;
                tempStretchCanvas.height = 0;
            }
            tempStretchCanvas = document.createElement('canvas');
            tempStretchCanvas.width = width;
            tempStretchCanvas.height = stretchedHeight;
        }
        const stretchCtx = tempStretchCanvas.getContext('2d');
        
        // Draw sliced portion to temp canvas with vertical stretch
        stretchCtx.drawImage(
            cachedFullSpectrogramCanvas,
            sourceX, 0, sourceWidth, cachedFullSpectrogramCanvas.height,  // source slice
            0, 0, width, stretchedHeight  // destination (stretched vertically)
        );
        
        // Draw bottom portion of stretched canvas to viewport
        ctx.drawImage(
            tempStretchCanvas,
            0, stretchedHeight - height,  // source (bottom portion)
            width, height,
            0, 0,  // destination
            width, height
        );
    } else {
        // Shrinking down - fill top with dark background, draw shrunk portion at bottom
        const [r, g, b] = hslToRgb(0, 100, 10);
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(0, 0, width, height);
        
        if (!tempShrinkCanvas || tempShrinkCanvas.width !== width || tempShrinkCanvas.height !== stretchedHeight) {
            if (tempShrinkCanvas) {
                tempShrinkCanvas.width = 0;
                tempShrinkCanvas.height = 0;
            }
            tempShrinkCanvas = document.createElement('canvas');
            tempShrinkCanvas.width = width;
            tempShrinkCanvas.height = stretchedHeight;
        }
        const shrinkCtx = tempShrinkCanvas.getContext('2d');
        
        // Draw sliced portion to temp canvas with vertical shrink
        shrinkCtx.drawImage(
            cachedFullSpectrogramCanvas,
            sourceX, 0, sourceWidth, cachedFullSpectrogramCanvas.height,  // source slice
            0, 0, width, stretchedHeight  // destination (shrunk vertically)
        );
        
        // Draw shrunk canvas at bottom of viewport
        ctx.drawImage(
            tempShrinkCanvas,
            0, 0,  // source
            width, stretchedHeight,
            0, height - stretchedHeight,  // destination (bottom-aligned)
            width, stretchedHeight
        );
    }
    
    // Draw regions and selection on top
    // COMMENTED OUT: Don't draw bars or yellow background when in zoomed region mode
    // if (!zoomState.isInRegion()) {
    //     drawSpectrogramRegionHighlights(ctx, width, height);
    //     drawSpectrogramSelection(ctx, width, height);
    // }
}

/**
 * Restore current viewport state (playback rate stretch)
 * Call after any operation that might have cleared the canvas
 */
export function restoreViewportState() {
    if (infiniteSpectrogramCanvas) {
        const playbackRate = State.currentPlaybackRate || 1.0;
        updateSpectrogramViewport(playbackRate);
    }
}

/**
 * Calculate stretch factor based on frequency scale
 */
function calculateStretchFactor(playbackRate, frequencyScale) {
    if (frequencyScale === 'linear') {
        return playbackRate;
    } else if (frequencyScale === 'sqrt') {
        return Math.sqrt(playbackRate);
    } else if (frequencyScale === 'logarithmic') {
        const originalSampleRate = State.currentMetadata?.original_sample_rate || 100;
        const originalNyquist = originalSampleRate / 2;
        const minFreq = 0.1;
        
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

/**
 * Get the viewport image for a given playback rate
 */
export function getSpectrogramViewport(playbackRate) {
    if (!infiniteSpectrogramCanvas) {
        return null;
    }
    
    const canvas = document.getElementById('spectrogram');
    if (!canvas) return null;
    
    const width = canvas.width;
    const height = canvas.height;
    
    const viewportCanvas = document.createElement('canvas');
    viewportCanvas.width = width;
    viewportCanvas.height = height;
    const ctx = viewportCanvas.getContext('2d');
    
    const stretchFactor = calculateStretchFactor(playbackRate, State.frequencyScale);
    const stretchedHeight = Math.floor(height * stretchFactor);
    
    ctx.clearRect(0, 0, width, height);
    
    if (stretchedHeight >= height) {
        if (!tempStretchCanvas || tempStretchCanvas.width !== width || tempStretchCanvas.height !== stretchedHeight) {
            if (tempStretchCanvas) {
                tempStretchCanvas.width = 0;
                tempStretchCanvas.height = 0;
            }
            tempStretchCanvas = document.createElement('canvas');
            tempStretchCanvas.width = width;
            tempStretchCanvas.height = stretchedHeight;
        }
        const stretchCtx = tempStretchCanvas.getContext('2d');
        
        stretchCtx.drawImage(
            infiniteSpectrogramCanvas,
            0, infiniteSpectrogramCanvas.height - height,
            width, height,
            0, 0,
            width, stretchedHeight
        );
        
        ctx.drawImage(
            tempStretchCanvas,
            0, stretchedHeight - height,
            width, height,
            0, 0,
            width, height
        );
    } else {
        const [r, g, b] = hslToRgb(0, 100, 10);
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(0, 0, width, height);
        
        if (!tempShrinkCanvas || tempShrinkCanvas.width !== width || tempShrinkCanvas.height !== stretchedHeight) {
            if (tempShrinkCanvas) {
                tempShrinkCanvas.width = 0;
                tempShrinkCanvas.height = 0;
            }
            tempShrinkCanvas = document.createElement('canvas');
            tempShrinkCanvas.width = width;
            tempShrinkCanvas.height = stretchedHeight;
        }
        const shrinkCtx = tempShrinkCanvas.getContext('2d');
        
        shrinkCtx.drawImage(
            infiniteSpectrogramCanvas,
            0, infiniteSpectrogramCanvas.height - height,
            width, height,
            0, 0,
            width, stretchedHeight
        );
        
        ctx.drawImage(
            tempShrinkCanvas,
            0, 0,
            width, stretchedHeight,
            0, height - stretchedHeight,
            width, stretchedHeight
        );
    }
    
    return viewportCanvas;
}

/**
 * Update spectrogram viewport with GPU-accelerated stretching
 */
export function updateSpectrogramViewport(playbackRate) {
    // console.log(`🎨 [spectrogram-complete-renderer.js] updateSpectrogramViewport CALLED: playbackRate=${playbackRate.toFixed(2)}, infiniteCanvas=${!!infiniteSpectrogramCanvas}`);
    // console.trace('📍 Call stack:'); // This shows us WHO called this function
    
    if (!infiniteSpectrogramCanvas) {
        if (!isStudyMode()) {
            console.log(`⚠️ updateSpectrogramViewport: No infinite canvas! playbackRate=${playbackRate}`);
        }
        return;
    }
    
    const canvas = document.getElementById('spectrogram');
    if (!canvas) {
        if (!isStudyMode()) {
            console.log(`⚠️ updateSpectrogramViewport: No spectrogram canvas!`);
        }
        return;
    }
    
    // console.log(`🎨 updateSpectrogramViewport: stretching with playbackRate=${playbackRate}, frequencyScale=${State.frequencyScale}`);
    
    // Update overlay opacity (fade out when zooming in, fade in when zooming out)
    updateSpectrogramOverlay();
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    const stretchFactor = calculateStretchFactor(playbackRate, State.frequencyScale);
    const stretchedHeight = Math.floor(height * stretchFactor);
    // console.log(`   Stretch factor: ${stretchFactor.toFixed(3)}, stretchedHeight: ${stretchedHeight}px (from ${height}px)`);
    
    ctx.clearRect(0, 0, width, height);
    
    if (stretchedHeight >= height) {
        if (!tempStretchCanvas || tempStretchCanvas.width !== width || tempStretchCanvas.height !== stretchedHeight) {
            if (tempStretchCanvas) {
                tempStretchCanvas.width = 0;
                tempStretchCanvas.height = 0;
            }
            tempStretchCanvas = document.createElement('canvas');
            tempStretchCanvas.width = width;
            tempStretchCanvas.height = stretchedHeight;
        }
        const stretchCtx = tempStretchCanvas.getContext('2d');
        
        stretchCtx.drawImage(
            infiniteSpectrogramCanvas,
            0, infiniteSpectrogramCanvas.height - height,
            width, height,
            0, 0,
            width, stretchedHeight
        );
        
        ctx.drawImage(
            tempStretchCanvas,
            0, stretchedHeight - height,
            width, height,
            0, 0,
            width, height
        );
    } else {
        const [r, g, b] = hslToRgb(0, 100, 10);
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(0, 0, width, height);
        
        if (!tempShrinkCanvas || tempShrinkCanvas.width !== width || tempShrinkCanvas.height !== stretchedHeight) {
            if (tempShrinkCanvas) {
                tempShrinkCanvas.width = 0;
                tempShrinkCanvas.height = 0;
            }
            tempShrinkCanvas = document.createElement('canvas');
            tempShrinkCanvas.width = width;
            tempShrinkCanvas.height = stretchedHeight;
        }
        const shrinkCtx = tempShrinkCanvas.getContext('2d');
        
        shrinkCtx.drawImage(
            infiniteSpectrogramCanvas,
            0, infiniteSpectrogramCanvas.height - height,
            width, height,
            0, 0,
            width, stretchedHeight
        );
        
        ctx.drawImage(
            tempShrinkCanvas,
            0, 0,
            width, stretchedHeight,
            0, height - stretchedHeight,
            width, stretchedHeight
        );
    }
    
    // Draw regions and selection on top
    // COMMENTED OUT: Don't draw bars or yellow background when in zoomed region mode
    // if (!zoomState.isInRegion()) {
    //     drawSpectrogramRegionHighlights(ctx, width, height);
    //     drawSpectrogramSelection(ctx, width, height);
    // }
    
    // NOTE: Selection box now drawn on separate overlay canvas (spectrogram-renderer.js)
    // No need to draw it here - completely separate layer with no conflicts!
    
    // NOTE: Feature box positions are updated AFTER zoom transitions complete
    // (in region-tracker.js zoom completion callbacks), not during animation loops
}

/**
 * 🔥 PROTECTION: Cancel any active render operation
 * Called when a new zoom starts to prevent race conditions
 */
export function cancelActiveRender() {
    if (activeRenderAbortController) {
        console.log(`🛑 Cancelling active render for region: ${activeRenderRegionId}`);
        activeRenderAbortController.abort();
        activeRenderAbortController = null;
        activeRenderRegionId = null;
        renderingInProgress = false;
    }
}

/**
 * 🔥 PROTECTION: Check if there's an active render for a different region
 * Returns true if we should cancel the active render (different region or transition in progress)
 */
export function shouldCancelActiveRender(newRegionId) {
    // Cancel if there's an active render for a different region
    if (activeRenderAbortController && activeRenderRegionId !== null && activeRenderRegionId !== newRegionId) {
        return true;
    }
    return false;
}

/**
 * Render spectrogram for a specific time range (region zoom)
 * 🔬 Renders high-res zoomed version in BACKGROUND
 * 
 * 🔥 PROTECTION: Supports cancellation via AbortController
 */
export async function renderCompleteSpectrogramForRegion(startSeconds, endSeconds, renderInBackground = false, regionId = null) {
    // console.log(`🔍 [spectrogram-complete-renderer.js] renderCompleteSpectrogramForRegion CALLED: ${startSeconds.toFixed(2)}s to ${endSeconds.toFixed(2)}s${renderInBackground ? ' (background)' : ''}`);
    // console.trace('📍 Call stack:');
    
    if (!State.completeSamplesArray || State.completeSamplesArray.length === 0) {
        console.log('⚠️ Cannot render region spectrogram - no audio data');
        return;
    }
    
    // console.log(`🔍 Rendering spectrogram for region: ${startSeconds.toFixed(2)}s to ${endSeconds.toFixed(2)}s${renderInBackground ? ' (background)' : ''}`);
    
    // 🔥 PROTECTION: Cancel any previous render and set up new abort controller
    cancelActiveRender();
    activeRenderAbortController = new AbortController();
    activeRenderRegionId = regionId;
    renderingInProgress = true;
    
    const signal = activeRenderAbortController.signal;
    
    // logMemory('Before region FFT');
    
    const canvas = document.getElementById('spectrogram');
    if (!canvas) {
        renderingInProgress = false;
        activeRenderAbortController = null;
        activeRenderRegionId = null;
        return;
    }
    
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    const width = canvas.width;
    const height = canvas.height;
    
    // Only clear if not rendering in background
    if (!renderInBackground) {
        ctx.clearRect(0, 0, width, height);
    }
    
    const sampleRate = 44100;
    const startSample = Math.floor(startSeconds * sampleRate);
    const endSample = Math.floor(endSeconds * sampleRate);
    
    // logInfiniteCanvasState('renderCompleteSpectrogramForRegion START');
    
    // Check if we need to re-render
    const needsRerender = infiniteSpectrogramCanvas &&
        (infiniteCanvasContext.startSample !== startSample ||
         infiniteCanvasContext.endSample !== endSample ||
         infiniteCanvasContext.frequencyScale !== State.frequencyScale);
    
    if (needsRerender) {
        // console.log('🔄 Context changed - clearing old self and re-rendering');
        clearInfiniteCanvas();
    }
    
    try {
        // 🔥 PROTECTION: Check for cancellation before starting work
        if (signal.aborted) {
            console.log('🛑 Render cancelled before starting');
            renderingInProgress = false;
            activeRenderAbortController = null;
            activeRenderRegionId = null;
            return;
        }
        const startTime = performance.now();
        const regionSamples = State.completeSamplesArray.slice(startSample, endSample);
        const totalSamples = regionSamples.length;
        const duration = endSeconds - startSeconds;
        
        // console.log(`📊 Region: ${totalSamples.toLocaleString()} samples (${duration.toFixed(2)}s)`);
        // console.log(`🎯 ZOOM RESOLUTION: ${(width / duration).toFixed(1)} pixels/second (vs ${(width / State.totalAudioDuration).toFixed(1)} for full view)`);
        
        // FFT parameters
        const fftSize = 2048;
        const frequencyBinCount = fftSize / 2;
        
        const maxTimeSlices = width;
        const hopSize = Math.floor((totalSamples - fftSize) / maxTimeSlices);
        const numTimeSlices = Math.min(maxTimeSlices, Math.floor((totalSamples - fftSize) / hopSize));
        
        // console.log(`🔧 FFT size: ${fftSize}, Hop size: ${hopSize.toLocaleString()}, Time slices: ${numTimeSlices.toLocaleString()}`);
        
        // Pre-compute Hann window
        const window = new Float32Array(fftSize);
        for (let i = 0; i < fftSize; i++) {
            window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / fftSize));
        }
        
        // Initialize worker pool
        if (!workerPool) {
            workerPool = new SpectrogramWorkerPool();
            await workerPool.initialize();
        }
        
        // Helper function for y position
        const getYPosition = (binIndex, totalBins, canvasHeight) => {
            const originalSampleRate = State.currentMetadata?.original_sample_rate || 100;
            const originalNyquist = originalSampleRate / 2;
            
            const frequency = (binIndex / totalBins) * originalNyquist;
            
            if (State.frequencyScale === 'logarithmic') {
                const minFreq = 0.1;
                const freqSafe = Math.max(frequency, minFreq);
                const logMin = Math.log10(minFreq);
                const logMax = Math.log10(originalNyquist);
                const logFreq = Math.log10(freqSafe);
                const normalizedLog = (logFreq - logMin) / (logMax - logMin);
                
                return canvasHeight - (normalizedLog * canvasHeight);
            } else if (State.frequencyScale === 'sqrt') {
                const normalized = frequency / originalNyquist;
                const sqrtNormalized = Math.sqrt(normalized);
                return canvasHeight - (sqrtNormalized * canvasHeight);
            } else {
                const normalized = frequency / originalNyquist;
                return canvasHeight - (normalized * canvasHeight);
            }
        };
        
        // Create ImageData
        const imageData = ctx.createImageData(width, height);
        const pixels = imageData.data;
        
        // Use pre-computed color LUT (computed once at module load)
        // No need to recompute - it's constant!
        
        // Create batches
        const batchSize = 50;
        const batches = [];
        for (let batchStart = 0; batchStart < numTimeSlices; batchStart += batchSize) {
            const batchEnd = Math.min(batchStart + batchSize, numTimeSlices);
            batches.push({ start: batchStart, end: batchEnd });
        }
        
        const pixelsPerSlice = width / numTimeSlices;
        
        // Draw callback
        const drawResults = (results, progress, workerIndex) => {
            for (const result of results) {
                const { sliceIdx, magnitudes } = result;
                const xStart = Math.floor(sliceIdx * pixelsPerSlice);
                const xEnd = Math.floor((sliceIdx + 1) * pixelsPerSlice);
                
                for (let binIdx = 0; binIdx < frequencyBinCount; binIdx++) {
                    const magnitude = magnitudes[binIdx];
                    const db = 20 * Math.log10(magnitude + 1e-10);
                    const normalizedDb = Math.max(0, Math.min(1, (db + 100) / 100));
                    const colorIndex = Math.floor(normalizedDb * 255);
                    
                    const r = colorLUT[colorIndex * 3];
                    const g = colorLUT[colorIndex * 3 + 1];
                    const b = colorLUT[colorIndex * 3 + 2];
                    
                    const yStart = Math.floor(getYPosition(binIdx + 1, frequencyBinCount, height));
                    const yEnd = Math.floor(getYPosition(binIdx, frequencyBinCount, height));
                    
                    for (let x = xStart; x < xEnd; x++) {
                        for (let y = yStart; y < yEnd; y++) {
                            const pixelIndex = (y * width + x) * 4;
                            pixels[pixelIndex] = r;
                            pixels[pixelIndex + 1] = g;
                            pixels[pixelIndex + 2] = b;
                            pixels[pixelIndex + 3] = 255;
                        }
                    }
                }
            }
            // console.log(`⏳ Region spectrogram: ${progress}% (worker ${workerIndex})`);
        };
        
        // Process with worker pool
        await workerPool.processBatches(
            regionSamples,
            batches,
            fftSize,
            hopSize,
            window,
            drawResults
        );
        
        // 🔥 PROTECTION: Check for cancellation after worker processing
        if (signal.aborted) {
            console.log('🛑 Render cancelled during worker processing');
            renderingInProgress = false;
            activeRenderAbortController = null;
            activeRenderRegionId = null;
            return;
        }
        
        // Write ImageData to temp canvas
        // console.log(`🎨 Writing ImageData to neutral render canvas...`);
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.putImageData(imageData, 0, 0);
        
        // 🔥 PROTECTION: Check for cancellation before creating infinite canvas
        if (signal.aborted) {
            console.log('🛑 Render cancelled before creating infinite canvas');
            renderingInProgress = false;
            activeRenderAbortController = null;
            activeRenderRegionId = null;
            return;
        }
        
        // Create infinite canvas
        const infiniteHeight = Math.floor(height * MAX_PLAYBACK_RATE);
        infiniteSpectrogramCanvas = document.createElement('canvas');
        infiniteSpectrogramCanvas.width = width;
        infiniteSpectrogramCanvas.height = infiniteHeight;
        const infiniteCtx = infiniteSpectrogramCanvas.getContext('2d');
        
        infiniteCtx.fillStyle = '#000';
        infiniteCtx.fillRect(0, 0, width, infiniteHeight);
        
        infiniteCtx.drawImage(tempCanvas, 0, infiniteHeight - height);
        
        // console.log(`🌊 Temple infinite canvas: ${width} × ${infiniteHeight}px`);
        // console.log(`   Placed neutral ${width} × ${height}px render at bottom`);
        
        // Record context
        infiniteCanvasContext = {
            startSample: startSample,
            endSample: endSample,
            frequencyScale: State.frequencyScale
        };
        // console.log(`🏛️ New temple self created: Region (${startSample.toLocaleString()}-${endSample.toLocaleString()}), scale=${State.frequencyScale}`);
        
        // logInfiniteCanvasState('renderCompleteSpectrogramForRegion COMPLETE - region canvas created');
        
        const elapsed = performance.now() - startTime;
        // console.log(`✅ Region spectrogram rendered in ${elapsed.toFixed(0)}ms`);
        
        // logMemory('After region FFT');
        
        // Update frequency axis
        positionAxisCanvas();
        initializeAxisPlaybackRate();
        drawFrequencyAxis();
        
        // If rendering in background, DON'T update viewport yet
        // We'll crossfade to it when animation completes
        if (!renderInBackground) {
            const playbackRate = State.currentPlaybackRate || 1.0;
            if (!isStudyMode()) {
                console.log(`🏛️ Calling updateSpectrogramViewport with playbackRate=${playbackRate}`);
            }
            updateSpectrogramViewport(playbackRate);
            if (!isStudyMode()) {
                console.log(`🏛️ Viewport update complete`);
            }
        } else {
            // console.log(`🔬 High-res render complete (background) - ready for crossfade`);
        }
        
        // 🔥 PROTECTION: Only mark as complete if not cancelled
        if (!signal.aborted) {
            // 🔥 THE FIX: Set the flag so next scale change knows we have a rendered spectrogram!
            completeSpectrogramRendered = true;
            State.setSpectrogramInitialized(true);
            
            // Clear tracking if this render completed successfully
            if (activeRenderRegionId === regionId) {
                activeRenderAbortController = null;
                activeRenderRegionId = null;
            }
        }
        
    } catch (error) {
        // Only log error if not cancelled
        if (!signal.aborted) {
            console.error('❌ Error rendering region spectrogram:', error);
        } else {
            console.log('🛑 Render cancelled (error suppressed)');
        }
    } finally {
        // Always clear rendering flag and controller if this was the active render
        if (activeRenderRegionId === regionId) {
            renderingInProgress = false;
            // Don't clear controller here - it might have been cancelled and cleared already
        }
    }
}

/**
 * Create and manage spectrogram overlay for zoomed-out mode
 */
function createSpectrogramOverlay() {
    if (spectrogramOverlay) return; // Already exists
    
    const canvas = document.getElementById('spectrogram');
    if (!canvas) return;
    
    // Create overlay div
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
    `;
    
    // Position overlay to match canvas exactly
    // The parent (.panel-visualization) has position: relative
    const parent = canvas.parentElement;
    if (parent) {
        // Get canvas position relative to parent
        const canvasRect = canvas.getBoundingClientRect();
        const parentRect = parent.getBoundingClientRect();
        
        spectrogramOverlay.style.position = 'absolute';
        spectrogramOverlay.style.top = (canvasRect.top - parentRect.top) + 'px';
        spectrogramOverlay.style.left = (canvasRect.left - parentRect.left) + 'px';
        spectrogramOverlay.style.width = canvasRect.width + 'px';
        spectrogramOverlay.style.height = canvasRect.height + 'px';
        
        parent.appendChild(spectrogramOverlay);
        
        // Update overlay size when canvas resizes
        const resizeObserver = new ResizeObserver(() => {
            if (spectrogramOverlay && canvas) {
                const canvasRect = canvas.getBoundingClientRect();
                const parentRect = parent.getBoundingClientRect();
                spectrogramOverlay.style.top = (canvasRect.top - parentRect.top) + 'px';
                spectrogramOverlay.style.left = (canvasRect.left - parentRect.left) + 'px';
                spectrogramOverlay.style.width = canvasRect.width + 'px';
                spectrogramOverlay.style.height = canvasRect.height + 'px';
            }
        });
        resizeObserver.observe(canvas);
    }
}

/**
 * Update spectrogram overlay opacity based on zoom state
 * Overlay fades out when zooming IN, fades in when zooming OUT
 */
function updateSpectrogramOverlay() {
    if (!spectrogramOverlay) {
        createSpectrogramOverlay();
    }
    
    if (!spectrogramOverlay) return;
    
    // Use getRegionOpacityProgress which handles direction correctly:
    // - Returns 0.0 when zoomed out (full view)
    // - Returns 1.0 when zoomed in (region view)
    // - Interpolates smoothly during transitions
    // For overlay: we want inverse (visible when zoomed out, hidden when zoomed in)
    const opacityProgress = getRegionOpacityProgress();
    const overlayOpacity = 1.0 - opacityProgress;
    spectrogramOverlay.style.opacity = overlayOpacity.toFixed(3);
}

/**
 * Initialize complete spectrogram visualization
 */
export async function startCompleteVisualization() {
    await new Promise(resolve => setTimeout(resolve, 100));
    
    if (!State.completeSamplesArray || State.completeSamplesArray.length === 0) {
        console.log('⚠️ Cannot start complete visualization - no audio data');
        return;
    }
    
    console.log('🎬 Starting complete spectrogram visualization');
    
    await renderCompleteSpectrogram();
}
