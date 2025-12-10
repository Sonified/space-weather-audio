/**
 * spectrogram-complete-renderer.js - ELASTIC FRIEND VERSION 🦋
 * Complete transmission for the beautiful new world
 * 
 * KEY INSIGHT: ONE elastic friend (full spectrogram) stretches during ALL transitions
 * High-res zoomed version renders in background, crossfades when ready
 */

import * as State from './audio-state.js';

import { drawFrequencyAxis, positionAxisCanvas, resizeAxisCanvas, initializeAxisPlaybackRate, getLogScaleMinFreq } from './spectrogram-axis-renderer.js';

import { SpectrogramWorkerPool } from './spectrogram-worker-pool.js';

import { zoomState } from './zoom-state.js';

import { getInterpolatedTimeRange, getZoomDirection, getZoomTransitionProgress, getOldTimeRange, isZoomTransitionInProgress, getRegionOpacityProgress } from './waveform-x-axis-renderer.js';
import { drawSpectrogramRegionHighlights, drawSpectrogramSelection } from './region-tracker.js';
import { isStudyMode } from './master-modes.js';
import { getColorLUT } from './colormaps.js';

/**
 * Get the background/zero color from the current colormap LUT
 * @returns {[number, number, number]} RGB values for the bottom of the colormap
 */
function getColormapBackgroundColor() {
    const lut = getColorLUT();
    if (lut && lut.length >= 3) {
        return [lut[0], lut[1], lut[2]];
    }
    // Fallback to black if LUT not ready
    return [0, 0, 0];
}

// Track if we've rendered the complete spectrogram
let completeSpectrogramRendered = false;
let renderingInProgress = false;

// 🔥 PROTECTION: Track active render operation to allow cancellation
let activeRenderRegionId = null; // Track which region is currently being rendered
let activeRenderAbortController = null; // AbortController for cancelling renders

// 🎯 SMART RENDER: Track expanded render bounds for early crossfade detection
let smartRenderBounds = {
    expandedStart: null,  // Expanded window start (seconds)
    expandedEnd: null,    // Expanded window end (seconds)
    targetStart: null,    // Target region start (seconds)
    targetEnd: null,      // Target region end (seconds)
    renderComplete: false // Is the smart render ready for crossfade?
};

// Worker pool for parallel FFT computation
let workerPool = null;

// 🏠 THE ELASTIC FRIEND - our source of truth during transitions
let cachedFullSpectrogramCanvas = null;
let cachedFullFrequencyScale = null;  // Track which scale the elastic friend was rendered with

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

// 🔍 DIAGNOSTIC: Export canvas status functions for debugging
export function getInfiniteCanvasStatus() {
    return infiniteSpectrogramCanvas ? `EXISTS (${infiniteSpectrogramCanvas.width}x${infiniteSpectrogramCanvas.height})` : 'NULL';
}

export function getCachedFullStatus() {
    return cachedFullSpectrogramCanvas ? `EXISTS (${cachedFullSpectrogramCanvas.width}x${cachedFullSpectrogramCanvas.height})` : 'NULL';
}

export function getCachedZoomedStatus() {
    return cachedZoomedSpectrogramCanvas ? `EXISTS (${cachedZoomedSpectrogramCanvas.width}x${cachedZoomedSpectrogramCanvas.height})` : 'NULL';
}

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
        console.log('🏥 Starting memory health monitoring (every 30 seconds)');
    }
    memoryMonitorInterval = setInterval(memoryHealthCheck, 30000);
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

// Color LUT is now managed by colormaps.js module

/**
 * Main function to render the complete spectrogram (FULL VIEW)
 * This becomes our ELASTIC FRIEND 🏠
 * @param {boolean} skipViewportUpdate - Don't update the display canvas
 * @param {boolean} forceFullView - Bypass region check (for background elastic friend update)
 */
export async function renderCompleteSpectrogram(skipViewportUpdate = false, forceFullView = false) {
    // Only log in dev/personal modes, not study mode
    if (!isStudyMode()) {
        console.groupCollapsed('🎨 [RENDER] Spectrogram Rendering');
        console.log(`🎨 [spectrogram-complete-renderer.js] renderCompleteSpectrogram CALLED: skipViewportUpdate=${skipViewportUpdate}`);
    }
    // console.trace('📍 Call stack:');
    
    if (!State.completeSamplesArray || State.completeSamplesArray.length === 0) {
        if (!isStudyMode()) {
            console.log('⚠️ Cannot render complete spectrogram - no audio data available');
            console.groupEnd();
        }
        return;
    }
    
    if (renderingInProgress) {
        if (!isStudyMode()) {
            console.log('⚠️ Spectrogram rendering already in progress');
            console.groupEnd();
        }
        return;
    }
    
    // If inside a region, render that instead (unless forceFullView is set)
    if (!forceFullView && zoomState.isInRegion()) {
        const regionRange = zoomState.getRegionRange();
        if (!isStudyMode()) {
            console.log(`🔍 Inside temple - rendering region instead`);
            console.groupEnd();
        }
        // 🔥 FIX: Convert Date objects to seconds (renderCompleteSpectrogramForRegion expects seconds!)
        const dataStartMs = State.dataStartTime ? State.dataStartTime.getTime() : 0;
        const startSeconds = (regionRange.startTime.getTime() - dataStartMs) / 1000;
        const endSeconds = (regionRange.endTime.getTime() - dataStartMs) / 1000;
        return await renderCompleteSpectrogramForRegion(startSeconds, endSeconds);
    }

    // Skip "already rendered" check when forcing full view update
    if (!forceFullView && completeSpectrogramRendered) {
        if (!isStudyMode()) {
            console.log('✅ Complete spectrogram already rendered');
            console.groupEnd();
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

        // FFT parameters (use State.fftSize from UI dropdown)
        const fftSize = State.fftSize || 2048;
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
            
            // 🎯 LOG: Show what we're using for spectrogram rendering
            if (!window._spectrogramMaxFreqLogged) {
                console.log(`📊 ⭐ SPECTROGRAM RENDERING:`);
                console.log(`   Original sampling rate: ${originalSampleRate.toFixed(2)} Hz`);
                console.log(`   → Max frequency (Nyquist): ${originalNyquist.toFixed(2)} Hz`);
                console.log(`   FFT bins will map: 0 Hz to ${originalNyquist.toFixed(2)} Hz`);
                window._spectrogramMaxFreqLogged = true;
            }
            
            const frequency = (binIndex / totalBins) * originalNyquist;

            if (State.frequencyScale === 'logarithmic') {
                const minFreq = getLogScaleMinFreq();
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
            const colorLUT = getColorLUT();
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
        cachedFullFrequencyScale = State.frequencyScale;  // Remember which scale we rendered with
        
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
        if (!isStudyMode()) {
            console.groupEnd(); // End Spectrogram Rendering (on error)
        }
    } finally {
        renderingInProgress = false;
        if (!isStudyMode()) {
            console.groupEnd(); // End Spectrogram Rendering
        }
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

/**
 * Clear complete spectrogram and free memory
 */
export function clearCompleteSpectrogram() {
    // Only log in dev/personal modes, not study mode
    if (!isStudyMode()) {
        console.groupCollapsed('🧹 [CLEANUP] Spectrogram & Resources');
        console.log(`🧹 [spectrogram-complete-renderer.js] clearCompleteSpectrogram CALLED`);
        // console.trace('📍 Call stack:');
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
        console.groupEnd(); // End Cleanup
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

// Track frequency scale when caching so we can detect mismatches
let cachedZoomedFrequencyScale = null;

/**
 * Cache the current zoomed spectrogram (before zooming out)
 * Caches what's ACTUALLY VISIBLE on the main canvas (not the infiniteCanvas)
 */
export function cacheZoomedSpectrogram() {
    const mainCanvas = document.getElementById('spectrogram');
    if (!mainCanvas) {
        console.warn('⚠️ cacheZoomedSpectrogram: No main canvas found!');
        return;
    }
    
    // 🎯 Cache what's ACTUALLY VISIBLE on screen (the main canvas)
    // This includes the crossfaded HQ composite if it's ready, or the infiniteCanvas viewport if not
    const cachedCopy = document.createElement('canvas');
    cachedCopy.width = mainCanvas.width;
    cachedCopy.height = mainCanvas.height;
    const cachedCtx = cachedCopy.getContext('2d');
    cachedCtx.drawImage(mainCanvas, 0, 0);
    
    // Stretch it to match infiniteCanvas height for consistency with frequency stretching
    const infiniteHeight = Math.floor(mainCanvas.height * MAX_PLAYBACK_RATE);
    const stretchedCopy = document.createElement('canvas');
    stretchedCopy.width = mainCanvas.width;
    stretchedCopy.height = infiniteHeight;
    const stretchedCtx = stretchedCopy.getContext('2d');
    
    // Fill with black background
    stretchedCtx.fillStyle = '#000';
    stretchedCtx.fillRect(0, 0, stretchedCopy.width, stretchedCopy.height);
    
    // Place the visible content at the bottom (matching infiniteCanvas structure)
    stretchedCtx.drawImage(cachedCopy, 0, infiniteHeight - mainCanvas.height);
    
    cachedZoomedSpectrogramCanvas = stretchedCopy;
    cachedZoomedFrequencyScale = State.frequencyScale;  // Remember scale for validation
    
    // console.log(`💾 Cached zoomed spectrogram from MAIN CANVAS (what user sees): ${stretchedCopy.width}x${stretchedCopy.height}`);
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
 * 🏠 Update elastic friend in background (after frequency scale change while zoomed in)
 * Re-renders the full spectrogram so it's ready with the new scale when user zooms out
 * Does NOT touch the current display - purely background update
 */
export async function updateElasticFriendInBackground() {
    if (!isStudyMode()) {
        console.log(`🏠 Updating elastic friend in background with ${State.frequencyScale} scale...`);
    }
    const startTime = performance.now();

    // 🔧 FIX: Clone the current infinite canvas (region view) before rendering full view
    // We must CLONE it because renderCompleteSpectrogram will destroy the original canvas
    let clonedCanvas = null;
    const savedContext = { ...infiniteCanvasContext };

    if (infiniteSpectrogramCanvas && infiniteSpectrogramCanvas.width > 0) {
        clonedCanvas = document.createElement('canvas');
        clonedCanvas.width = infiniteSpectrogramCanvas.width;
        clonedCanvas.height = infiniteSpectrogramCanvas.height;
        const cloneCtx = clonedCanvas.getContext('2d');
        cloneCtx.drawImage(infiniteSpectrogramCanvas, 0, 0);
        if (!isStudyMode()) {
            console.log(`🏠 Cloned region canvas: ${clonedCanvas.width}x${clonedCanvas.height}`);
        }
    }

    try {
        // Use existing render function with forceFullView=true to bypass region check
        // skipViewportUpdate=true so we don't touch the display
        await renderCompleteSpectrogram(true, true);

        if (!isStudyMode()) {
            const elapsed = performance.now() - startTime;
            console.log(`🏠 Elastic friend updated in background (${elapsed.toFixed(0)}ms) - ready for zoom out!`);
        }

    } catch (error) {
        console.error('❌ Error updating elastic friend in background:', error);
    } finally {
        // 🔧 FIX: Restore the region view from the clone
        // The elastic friend is now in cachedFullSpectrogramCanvas, but we need
        // infiniteSpectrogramCanvas to remain the REGION view for display
        if (clonedCanvas && clonedCanvas.width > 0) {
            infiniteSpectrogramCanvas = clonedCanvas;
            infiniteCanvasContext = savedContext;
            if (!isStudyMode()) {
                console.log(`🏠 Restored region view from clone (context: ${savedContext.startSample}-${savedContext.endSample})`);
            }
        }
    }
}

/**
 * 🎯 Clear smart render bounds (called when starting new zoom or zooming out)
 */
export function clearSmartRenderBounds() {
    smartRenderBounds = {
        expandedStart: null,
        expandedEnd: null,
        targetStart: null,
        targetEnd: null,
        renderComplete: false
    };
}

/**
 * 🏠 THE ELASTIC FRIEND - stretches during ALL transitions!
 * Just like the waveform and x-axis - one source, one stretch, done!
 */
export function drawInterpolatedSpectrogram() {
    // 🚨 ONLY call during transitions!
    if (!isZoomTransitionInProgress()) {
        // Reset progress tracker when not in transition
        window._drawInterpLastProgress = undefined;
        // console.log(`⚠️ drawInterpolatedSpectrogram: NOT in transition - returning early!`);
        return; // Not in transition - don't touch the display!
    }
    
    // 🔥 FIX: Prevent multiple draws of the same frame by tracking progress
    // Only skip if we're being called again with the SAME progress (same frame)
    // This prevents canvas from being cleared multiple times in one RAF frame
    const currentProgress = getZoomTransitionProgress();
    if (window._drawInterpLastProgress !== undefined && 
        Math.abs(window._drawInterpLastProgress - currentProgress) < 0.0001) {
        // Same progress value - skip to prevent clearing canvas multiple times
        return;
    }
    window._drawInterpLastProgress = currentProgress;
    
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
    
    // Track first trigger for logging
    if (smartRenderBounds.renderComplete && !window._smartRenderFirstTrigger) {
        window._smartRenderFirstTrigger = performance.now();
        console.log('✨ ⏱️ CROSSFADE START:', window._smartRenderFirstTrigger.toFixed(0) + 'ms');
        console.log('✨ Smart render ready - beginning fade-in overlay!');
    }
    
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
    
    // 🎯 When zooming OUT, don't clear/draw elastic until 10% in (keep showing infiniteCanvas)
    const zoomDirection = getZoomDirection();
    const progress = getZoomTransitionProgress();

    // 🔍 DIAGNOSTIC: Log canvas status (throttled)
    // if (!window._lastDrawInterpLog || (performance.now() - window._lastDrawInterpLog) > 100) {
    //     console.log(`📊 ZOOM ${zoomDirection ? 'IN' : 'OUT'} @ ${progress.toFixed(3)}:`, {
    //         infiniteCanvas: infiniteSpectrogramCanvas ? 'YES' : '❌ NULL',
    //         elasticFriend: cachedFullSpectrogramCanvas ? 'YES' : '❌ NULL',
    //         zoomedCache: cachedZoomedSpectrogramCanvas ? 'YES' : '❌ NULL',
    //         canvasWillClear: true
    //     });
    //     window._lastDrawInterpLog = performance.now();
    // }

    // 🚨 CRITICAL CHECK: Do we have what we need?
    // if (!zoomDirection && !cachedZoomedSpectrogramCanvas) {
    //     console.error(`🔴 ZOOM OUT BROKEN: No cached zoom canvas at progress ${progress.toFixed(3)}!`);
    //     console.trace('Stack trace for missing cached zoom:');
    // }
    // if (!cachedFullSpectrogramCanvas) {
    //     console.error(`🔴 ZOOM ${zoomDirection ? 'IN' : 'OUT'} BROKEN: No elastic friend at progress ${progress.toFixed(3)}!`);
    //     console.trace('Stack trace for missing elastic friend:');
    // }

    // 🔍 DEBUG: Check canvas context state before drawing
    // console.log(`🔍 Canvas context state:`, {
    //     globalAlpha: ctx.globalAlpha,
    //     transform: ctx.getTransform ? ctx.getTransform() : 'N/A',
    //     fillStyle: ctx.fillStyle,
    //     strokeStyle: ctx.strokeStyle
    // });
    
    // 🚨 CRITICAL: Reset any transforms that might be active!
    ctx.save(); // Save state to restore later
    ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset to identity matrix
    
    // Clear canvas for both zoom IN and OUT
    // console.log(`🧹 About to clear canvas at progress=${progress.toFixed(3)}, zoomDir=${zoomDirection ? 'IN' : 'OUT'}`);
    ctx.clearRect(0, 0, width, height);
    ctx.globalAlpha = 1.0;
    
    // console.log(`✅ Canvas cleared and reset to identity transform`);
    
    // 🎯 ZOOM OUT: Draw cached HQ (what user was seeing) positioned correctly in expanding viewport
    if (!zoomDirection && cachedZoomedSpectrogramCanvas) {
        // 🔥 CRITICAL: Only use cached HQ if frequency scale hasn't changed!
        if (cachedZoomedFrequencyScale !== State.frequencyScale) {
            // Frequency scale changed - cached HQ is wrong scale, skip it and just draw elastic friend
            // Don't return - let it fall through to draw elastic friend everywhere
        } else {
        // During zoom OUT, the cached HQ (from main canvas) starts filling the viewport and shrinks as we zoom out
        const oldTimeRange = getOldTimeRange();
        if (oldTimeRange) {
            // 🎯 CRITICAL: Position HQ based on where region sits in the INTERPOLATED viewport!
            // NOT "halfway to final position" - but "where it is within the expanding viewport"
            
            const regionStartMs = oldTimeRange.startTime.getTime();
            const regionEndMs = oldTimeRange.endTime.getTime();
            
            // Where does the region sit within the current INTERPOLATED viewport?
            const interpStartSec = (interpStartMs - dataStartMs) / 1000;
            const interpEndSec = (interpEndMs - dataStartMs) / 1000;
            const interpDuration = interpEndSec - interpStartSec;
            
            const regionStartSec = (regionStartMs - dataStartMs) / 1000;
            const regionEndSec = (regionEndMs - dataStartMs) / 1000;
            
            // Region's position within interpolated viewport (matches elastic friend coordinate system!)
            const regionStartInViewport = (regionStartSec - interpStartSec) / interpDuration;
            const regionEndInViewport = (regionEndSec - interpStartSec) / interpDuration;
            
            const currentX = regionStartInViewport * width;
            const currentWidth = (regionEndInViewport - regionStartInViewport) * width;
            
            // console.log(`🔵🔵 Zoom OUT (progress=${progress.toFixed(3)}): Cached HQ at x=${currentX.toFixed(1)}, width=${currentWidth.toFixed(1)} [GLUED to elastic friend coordinates]`);
            
            // Draw cached HQ at full opacity throughout
            ctx.globalAlpha = 1.0;
            
            // 🎨 Apply CURRENT playback rate stretch to the cached HQ
            // The cached canvas has the infiniteCanvas structure (6750px tall with content at bottom)
            // We need to extract the right portion based on CURRENT stretchedHeight
            
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = width;
            tempCanvas.height = stretchedHeight;
            const tempCtx = tempCanvas.getContext('2d');
            
            // Extract the correct portion from cached canvas based on CURRENT stretch
            // The cached canvas is structured like infiniteCanvas (content at bottom)
            tempCtx.drawImage(
                cachedZoomedSpectrogramCanvas,
                0, cachedZoomedSpectrogramCanvas.height - stretchedHeight, cachedZoomedSpectrogramCanvas.width, stretchedHeight,  // Source: bottom portion matching current stretch
                0, 0, width, stretchedHeight  // Destination: full temp canvas
            );
            
            // Now draw at interpolated position (shrinking horizontally)
            if (stretchedHeight >= height) {
                // Stretching up - draw bottom portion
                ctx.drawImage(
                    tempCanvas,
                    0, stretchedHeight - height, width, height,
                    currentX, 0, currentWidth, height
                );
            } else {
                // Shrinking down - fill background and draw at bottom
                const [r, g, b] = getColormapBackgroundColor();
                ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                ctx.fillRect(currentX, 0, currentWidth, height);
                
                ctx.drawImage(
                    tempCanvas,
                    0, 0, width, stretchedHeight,
                    currentX, height - stretchedHeight, currentWidth, stretchedHeight
                );
            }
            
            // console.log(`🔵🔵 Cached HQ drawn successfully at interpolated position`);
            
            // Reset alpha for elastic friend edges
            ctx.globalAlpha = 1.0;
            
            // 🎯 NOW draw elastic friend in the EMPTY SPACE around the HQ (hard clip at edges)
            // No alpha blending - just fill the areas that HQ doesn't cover!
            
            // Calculate what portion of elastic friend to show on LEFT and RIGHT
            const leftEdgeWidth = currentX;  // Space from 0 to where HQ starts
            const rightEdgeStart = currentX + currentWidth;  // Where HQ ends
            const rightEdgeWidth = width - rightEdgeStart;  // Space from HQ end to viewport edge
            
            // console.log(`🟢🟢 Zoom OUT (progress=${progress.toFixed(3)}): Drawing elastic friend in gaps - left=${leftEdgeWidth.toFixed(1)}px, right=${rightEdgeWidth.toFixed(1)}px`);
            
            // Draw elastic friend edges with same frequency stretch as the rest
            if (stretchedHeight >= height) {
                // Stretching up
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = width;
                tempCanvas.height = stretchedHeight;
                const tempCtx = tempCanvas.getContext('2d');
                
                // Draw full elastic friend slice (stretched)
                tempCtx.drawImage(
                    cachedFullSpectrogramCanvas,
                    sourceX, 0, sourceWidth, cachedFullSpectrogramCanvas.height,
                    0, 0, width, stretchedHeight
                );
                
                // LEFT edge
                if (leftEdgeWidth > 0) {
                    ctx.drawImage(
                        tempCanvas,
                        0, stretchedHeight - height, leftEdgeWidth, height,
                        0, 0, leftEdgeWidth, height
                    );
                }
                
                // RIGHT edge
                if (rightEdgeWidth > 0) {
                    ctx.drawImage(
                        tempCanvas,
                        width - rightEdgeWidth, stretchedHeight - height, rightEdgeWidth, height,
                        rightEdgeStart, 0, rightEdgeWidth, height
                    );
                }
            } else {
                // Shrinking down
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = width;
                tempCanvas.height = stretchedHeight;
                const tempCtx = tempCanvas.getContext('2d');
                
                // Draw full elastic friend slice (shrunk)
                tempCtx.drawImage(
                    cachedFullSpectrogramCanvas,
                    sourceX, 0, sourceWidth, cachedFullSpectrogramCanvas.height,
                    0, 0, width, stretchedHeight
                );
                
                // Fill background
                const [r, g, b] = getColormapBackgroundColor();
                ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
                
                // LEFT edge
                if (leftEdgeWidth > 0) {
                    ctx.fillRect(0, 0, leftEdgeWidth, height);
                    ctx.drawImage(
                        tempCanvas,
                        0, 0, leftEdgeWidth, stretchedHeight,
                        0, height - stretchedHeight, leftEdgeWidth, stretchedHeight
                    );
                }
                
                // RIGHT edge
                if (rightEdgeWidth > 0) {
                    ctx.fillRect(rightEdgeStart, 0, rightEdgeWidth, height);
                    ctx.drawImage(
                        tempCanvas,
                        width - rightEdgeWidth, 0, rightEdgeWidth, stretchedHeight,
                        rightEdgeStart, height - stretchedHeight, rightEdgeWidth, stretchedHeight
                    );
                }
            }
            
            // console.log(`🟢🟢 Elastic friend edges drawn with hard clip at HQ boundaries`);
        } else {
            // No oldTimeRange - shouldn't happen, but draw cached HQ scaled to full width
            console.warn(`⚠️ No oldTimeRange during zoom out - drawing cached HQ scaled to full width`);
            ctx.drawImage(
                cachedZoomedSpectrogramCanvas,
                0, cachedZoomedSpectrogramCanvas.height - height, cachedZoomedSpectrogramCanvas.width, height,
                0, 0, width, height
            );
        }
        }  // Close the `} else {` for frequency scale check
        
        // Done - zoom OUT drawing complete
        ctx.restore(); // Restore context state
        return;
    }

    
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
        const [r, g, b] = getColormapBackgroundColor();
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
    
    ctx.globalAlpha = 1.0; // Reset alpha after elastic friend
    
    // Draw regions and selection on top
    // COMMENTED OUT: Don't draw bars or yellow background when in zoomed region mode
    // if (!zoomState.isInRegion()) {
    //     drawSpectrogramRegionHighlights(ctx, width, height);
    //     drawSpectrogramSelection(ctx, width, height);
    // }
    
    // 🎯 ZOOM IN ONLY: Draw HQ composite OVER elastic friend
    // (For zoom OUT, we're fading elastic friend over the infiniteCanvas/HQ, so skip this)
    // 🔍 DEBUG: Log crossfade conditions
    if (!window._crossfadeDebugLogged) {
        console.log('🔍 Crossfade check:', {
            zoomDirection,
            renderComplete: smartRenderBounds.renderComplete,
            hasCachedZoomed: !!cachedZoomedSpectrogramCanvas,
            progress: getZoomTransitionProgress().toFixed(3)
        });
        window._crossfadeDebugLogged = true;
    }
    if (zoomDirection && smartRenderBounds.renderComplete && cachedZoomedSpectrogramCanvas) {
        const interpStartSec = (interpStartMs - dataStartMs) / 1000;
        const interpEndSec = (interpEndMs - dataStartMs) / 1000;
        const viewportDuration = interpEndSec - interpStartSec;
        
        // Where does the TARGET region appear on screen?
        const targetStart = smartRenderBounds.targetStart;
        const targetEnd = smartRenderBounds.targetEnd;
        
        const screenStartProgress = (targetStart - interpStartSec) / viewportDuration;
        const screenEndProgress = (targetEnd - interpStartSec) / viewportDuration;
        
        const screenX = screenStartProgress * width;
        const screenWidth = (screenEndProgress - screenStartProgress) * width;
        
            // Only draw if target is visible on screen
            if (screenX < width && screenX + screenWidth > 0) {
                // Fade in composite at 50% when motion is most noticeable (50% → 90%)
                const progress = getZoomTransitionProgress();
                const fadeStartProgress = 0.5;
                const fadeEndProgress = 0.9;
            
            if (progress >= fadeStartProgress) {
                const fadeProgress = Math.min((progress - fadeStartProgress) / (fadeEndProgress - fadeStartProgress), 1.0);
                
                // Find target region in composite (it's the full-quality zone)
                const expandedDuration = smartRenderBounds.expandedEnd - smartRenderBounds.expandedStart;
                const targetStartInComposite = (targetStart - smartRenderBounds.expandedStart) / expandedDuration;
                const targetEndInComposite = (targetEnd - smartRenderBounds.expandedStart) / expandedDuration;
                
                const compositeWidth = cachedZoomedSpectrogramCanvas.width;
                const sourceX = targetStartInComposite * compositeWidth;
                const sourceWidth = (targetEndInComposite - targetStartInComposite) * compositeWidth;
                
                // 🎨 Apply playback stretch to HQ composite too!
                const tempHQ = document.createElement('canvas');
                tempHQ.width = screenWidth;
                tempHQ.height = stretchedHeight;
                const tempHQCtx = tempHQ.getContext('2d');
                
                // Draw and stretch HQ to match current playback rate
                tempHQCtx.drawImage(
                    cachedZoomedSpectrogramCanvas,
                    sourceX, 0, sourceWidth, cachedZoomedSpectrogramCanvas.height,
                    0, 0, screenWidth, stretchedHeight
                );
                
                // Fade in during second half of animation - motion hides it!
                ctx.globalAlpha = fadeProgress;
                
                // Draw the stretched HQ at screen position
                if (stretchedHeight >= height) {
                    // Stretched up - draw bottom portion
                    ctx.drawImage(
                        tempHQ,
                        0, stretchedHeight - height, screenWidth, height,
                        screenX, 0, screenWidth, height
                    );
                } else {
                    // Shrunk down - draw at bottom
                    ctx.drawImage(
                        tempHQ,
                        0, 0, screenWidth, stretchedHeight,
                        screenX, height - stretchedHeight, screenWidth, stretchedHeight
                    );
                }
                
                ctx.globalAlpha = 1.0;
            }
        }
    }
    
    // Restore context state
    ctx.restore();
    // console.log(`✅ drawInterpolatedSpectrogram complete - context restored`);
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

/**
 * Get the viewport image for a given playback rate
 */
export function getSpectrogramViewport(playbackRate) {
    if (!infiniteSpectrogramCanvas) {
        if (!isStudyMode()) {
            console.warn('⚠️ getSpectrogramViewport: No infiniteSpectrogramCanvas!');
        }
        return null;
    }
    
    // 🔥 FIX: Validate infinite canvas has content before using it
    if (infiniteSpectrogramCanvas.width === 0 || infiniteSpectrogramCanvas.height === 0) {
        if (!isStudyMode()) {
            console.warn('⚠️ getSpectrogramViewport: Infinite canvas has zero dimensions!');
        }
        return null;
    }
    
    const canvas = document.getElementById('spectrogram');
    if (!canvas) {
        return null;
    }
    
    const width = canvas.width;
    const height = canvas.height;
    
    const viewportCanvas = document.createElement('canvas');
    viewportCanvas.width = width;
    viewportCanvas.height = height;
    const ctx = viewportCanvas.getContext('2d');
    
    const stretchFactor = calculateStretchFactor(playbackRate, State.frequencyScale);
    const stretchedHeight = Math.floor(height * stretchFactor);
    
    // 🔥 FIX: Fill with black background first (in case drawImage fails)
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    
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
        
        // 🔥 FIX: Validate source region before drawing
        const sourceY = infiniteSpectrogramCanvas.height - height;
        if (sourceY < 0 || sourceY >= infiniteSpectrogramCanvas.height) {
            if (!isStudyMode()) {
                console.error('❌ getSpectrogramViewport: Invalid sourceY (stretch):', {
                    sourceY,
                    infiniteHeight: infiniteSpectrogramCanvas.height,
                    height,
                    playbackRate
                });
            }
            // Already filled with black above, just return
            return viewportCanvas;
        }
        
        try {
            stretchCtx.drawImage(
                infiniteSpectrogramCanvas,
                0, sourceY,
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
        } catch (error) {
            if (!isStudyMode()) {
                console.error('❌ getSpectrogramViewport: drawImage failed (stretch):', error, {
                    infiniteCanvasSize: `${infiniteSpectrogramCanvas.width}x${infiniteSpectrogramCanvas.height}`,
                    sourceY,
                    height,
                    width,
                    stretchedHeight
                });
            }
            // Already filled with black above
        }
    } else {
        const [r, g, b] = getColormapBackgroundColor();
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
        
        // 🔥 FIX: Validate source region before drawing
        const sourceY = infiniteSpectrogramCanvas.height - height;
        if (sourceY < 0 || sourceY >= infiniteSpectrogramCanvas.height) {
            if (!isStudyMode()) {
                console.error('❌ getSpectrogramViewport: Invalid sourceY (shrink):', {
                    sourceY,
                    infiniteHeight: infiniteSpectrogramCanvas.height,
                    height,
                    playbackRate
                });
            }
            // Already filled with black above, just return
            return viewportCanvas;
        }
        
        try {
            shrinkCtx.drawImage(
                infiniteSpectrogramCanvas,
                0, sourceY,
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
        } catch (error) {
            if (!isStudyMode()) {
                console.error('❌ getSpectrogramViewport: drawImage failed (shrink):', error, {
                    infiniteCanvasSize: `${infiniteSpectrogramCanvas.width}x${infiniteSpectrogramCanvas.height}`,
                    sourceY,
                    height,
                    width,
                    stretchedHeight
                });
            }
            // Already filled with black above
        }
    }
    
    return viewportCanvas;
}

/**
 * Update spectrogram viewport with GPU-accelerated stretching
 */
export function updateSpectrogramViewport(playbackRate) {
    // 🎯 DEBUG: Log if called during zoom out transition
    if (isZoomTransitionInProgress() && !getZoomDirection()) {
        // const progress = getZoomTransitionProgress();
        // console.error(`🔴🔴🔴 updateSpectrogramViewport called DURING ZOOM OUT! playbackRate=${playbackRate.toFixed(2)}, progress=${progress.toFixed(3)}`);
        // console.trace('🔴 Stack trace for updateSpectrogramViewport during zoom out:');

        // 🚨 CRITICAL: During zoom-out, DON'T touch the canvas!
        // drawInterpolatedSpectrogram handles the entire transition
        // console.log(`🛑 BLOCKING updateSpectrogramViewport during zoom-out (progress=${progress.toFixed(3)})`);
        return;
    }

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
        const [r, g, b] = getColormapBackgroundColor();
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
 * 🔥 GUARD: Check if rendering is currently in progress
 * Used to wait for HQ render to complete before ending zoom transitions
 */
export function isRenderingInProgress() {
    return renderingInProgress;
}

/**
 * 🔥 GUARD: Check if a specific region's render is complete
 * Returns true if render is complete (or not rendering), false if still rendering
 */
export function isRegionRenderComplete(regionId) {
    // If not rendering at all, consider it "complete"
    if (!renderingInProgress) {
        return true;
    }
    // If rendering for a different region, consider this one "complete"
    if (activeRenderRegionId !== regionId) {
        return true;
    }
    // Still rendering this region
    return false;
}

/**
 * Render spectrogram for a specific time range (region zoom)
 * 🔬 Renders high-res zoomed version in BACKGROUND
 * 
 * 🔥 PROTECTION: Supports cancellation via AbortController
 */
export async function renderCompleteSpectrogramForRegion(startSeconds, endSeconds, renderInBackground = false, regionId = null, smartRenderOptions = null) {
    // console.log(`🔍 [spectrogram-complete-renderer.js] renderCompleteSpectrogramForRegion CALLED: ${startSeconds.toFixed(2)}s to ${endSeconds.toFixed(2)}s${renderInBackground ? ' (background)' : ''}`);
    // console.trace('📍 Call stack:');
    
    if (!State.completeSamplesArray || State.completeSamplesArray.length === 0) {
        console.log('⚠️ Cannot render region spectrogram - no audio data');
        return;
    }
    
    // 🎯 Smart predictive rendering with quality zones!
    const useSmartRender = smartRenderOptions && smartRenderOptions.expandedStart !== undefined;
    const renderStartTimestamp = performance.now();
    if (useSmartRender) {
        // console.log('🎯 ⏱️ RENDER START:', renderStartTimestamp.toFixed(0) + 'ms');
        // console.log('🎯 SMART RENDER MODE: Multi-quality composite rendering');
        // console.log('  Target (full quality):', `${startSeconds.toFixed(2)}s - ${endSeconds.toFixed(2)}s`);
        // console.log('  Expanded window:', `${smartRenderOptions.expandedStart.toFixed(2)}s - ${smartRenderOptions.expandedEnd.toFixed(2)}s`);
        // console.log('  Direction:', smartRenderOptions.direction);
    }
    
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
    
    // 🔥 PROTECTION: Validate canvas dimensions
    if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) {
        console.error('❌ Invalid canvas dimensions:', { width, height });
        renderingInProgress = false;
        activeRenderAbortController = null;
        activeRenderRegionId = null;
        return;
    }
    
    // Only clear if not rendering in background
    if (!renderInBackground) {
        ctx.clearRect(0, 0, width, height);
    }

    // 🔥 CRITICAL FIX: Use playback_samples_per_real_second, NOT original_sample_rate!
    // completeSamplesArray is at 44.1kHz, but indexed by "playback samples per real second"
    // This tells us how many samples correspond to one second of real-world time
    // original_sample_rate might be the INSTRUMENT rate (50 Hz), which is WRONG!
    const originalSampleRate = zoomState.sampleRate; // Uses playback_samples_per_real_second
    
    // 🎯 Determine actual render bounds (expanded window for smart render, or target for normal)
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
    const targetStartSample = Math.floor(startSeconds * originalSampleRate);
    const targetEndSample = Math.floor(endSeconds * originalSampleRate);

    // console.log('🎨 renderCompleteSpectrogramForRegion received:', {
    //     targetSeconds: `${startSeconds.toFixed(2)}s - ${endSeconds.toFixed(2)}s`,
    //     renderSeconds: `${renderStartSeconds.toFixed(2)}s - ${renderEndSeconds.toFixed(2)}s`,
    //     duration: endSeconds - startSeconds
    // });
    // console.log('🎨 Calculated samples:', {
    //     renderStart: startSample.toLocaleString(),
    //     renderEnd: endSample.toLocaleString(),
    //     targetStart: targetStartSample.toLocaleString(),
    //     targetEnd: targetEndSample.toLocaleString(),
    //     renderCount: (endSample - startSample).toLocaleString()
    // });

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
        // 🔥 CRITICAL: Convert original sample indices to resampled indices
        // startSample/endSample are in original coordinate system, but completeSamplesArray is resampled
        const resampledStartSample = zoomState.originalToResampledSample(startSample);
        const resampledEndSample = zoomState.originalToResampledSample(endSample);
        const regionSamples = State.completeSamplesArray.slice(resampledStartSample, resampledEndSample);
        const totalSamples = regionSamples.length;
        const renderDuration = renderEndSeconds - renderStartSeconds;
        const targetDuration = endSeconds - startSeconds;

        // 🔬 DIAGNOSTIC: Sample extraction details
        // const zoomStateSampleRate = zoomState.sampleRate;
        // const playbackSamplesPerRealSecond = State.currentMetadata?.playback_samples_per_real_second;
        // console.log(`🔬 [SPECTROGRAM REGION] Sample extraction:`, {
        //     originalSampleRate,
        //     zoomStateSampleRate,
        //     playbackSamplesPerRealSecond,
        //     MISMATCH_DETECTED: Math.abs(originalSampleRate - zoomStateSampleRate) > 1,
        //     completeSamplesArrayLength: State.completeSamplesArray.length,
        //     renderStartSeconds: renderStartSeconds.toFixed(2),
        //     renderEndSeconds: renderEndSeconds.toFixed(2),
        //     startSample: startSample.toLocaleString(),
        //     endSample: endSample.toLocaleString(),
        //     resampledStartSample: resampledStartSample.toLocaleString(),
        //     resampledEndSample: resampledEndSample.toLocaleString(),
        //     regionSamplesLength: regionSamples.length.toLocaleString(),
        //     fftSize: State.fftSize || 2048,
        //     hasEnoughForFFT: regionSamples.length > (State.fftSize || 2048),
        //     expectedSamplesAtZoomRate: Math.floor((renderEndSeconds - renderStartSeconds) * zoomStateSampleRate).toLocaleString()
        // });

        // FFT parameters (use State.fftSize from UI dropdown)
        const fftSize = State.fftSize || 2048;
        const frequencyBinCount = fftSize / 2;

        // 🎯 SMART QUALITY ZONES: Calculate hopSize per section
        // Target region: full quality (normal hopSize)
        // Buffer regions: half quality (2x hopSize = half the time slices)
        let renderPlan = [];
        
        if (useSmartRender) {
            // Calculate pixel distribution based on time duration
            const totalDuration = renderEndSeconds - renderStartSeconds;
            
            // 🔥 PROTECTION: Validate durations before calculating pixels
            if (!isFinite(totalDuration) || totalDuration <= 0 || !isFinite(targetDuration) || targetDuration <= 0) {
                console.error('❌ Invalid durations for smart render:', {
                    renderStartSeconds,
                    renderEndSeconds,
                    totalDuration,
                    startSeconds,
                    endSeconds,
                    targetDuration
                });
                renderingInProgress = false;
                activeRenderAbortController = null;
                activeRenderRegionId = null;
                return;
            }
            
            const targetDurationRatio = targetDuration / totalDuration;
            const targetPixels = Math.max(1, Math.min(width - 1, Math.floor(width * targetDurationRatio)));
            
            if (smartRenderOptions.direction === 'left') {
                // Target (full) + Right buffer (half)
                const bufferPixels = Math.max(1, width - targetPixels);
                renderPlan = [
                    { start: renderStartSeconds, end: endSeconds, endSample: targetEndSample, pixels: targetPixels, quality: 'full', label: 'Target' },
                    { start: endSeconds, end: renderEndSeconds, endSample: endSample, pixels: bufferPixels, quality: 'half', label: 'Right Buffer' }
                ];
                // console.log('🎯 Quality zones (LEFT entry): Target=full (1x), Right=1/8 quality (8x faster)');
            } else if (smartRenderOptions.direction === 'right') {
                // Left buffer (1/8) + Target (full)
                const bufferPixels = Math.max(1, width - targetPixels);
                renderPlan = [
                    { start: renderStartSeconds, end: startSeconds, endSample: targetStartSample, pixels: bufferPixels, quality: 'half', label: 'Left Buffer' },
                    { start: startSeconds, end: endSeconds, endSample: targetEndSample, pixels: targetPixels, quality: 'full', label: 'Target' }
                ];
                // console.log('🎯 Quality zones (RIGHT entry): Left=1/8 quality (8x faster), Target=full (1x)');
            } else {
                // CENTER: Left buffer (1/8) + Target (full) + Right buffer (1/8)
                // 🔥 FIX: Use actual target bounds, not calculated centered position!
                // When expanded range is clamped to dataset bounds, target is NOT centered
                const leftBufferDuration = startSeconds - renderStartSeconds;
                const rightBufferDuration = renderEndSeconds - endSeconds;
                const leftBufferRatio = leftBufferDuration / totalDuration;
                const rightBufferRatio = rightBufferDuration / totalDuration;
                const bufferPixelsLeft = Math.max(1, Math.floor(width * leftBufferRatio));
                const bufferPixelsRight = Math.max(1, Math.floor(width * rightBufferRatio));
                const actualTargetPixels = Math.max(1, width - bufferPixelsLeft - bufferPixelsRight);

                renderPlan = [
                    { start: renderStartSeconds, end: startSeconds, endSample: targetStartSample, pixels: bufferPixelsLeft, quality: 'half', label: 'Left Buffer' },
                    { start: startSeconds, end: endSeconds, endSample: targetEndSample, pixels: actualTargetPixels, quality: 'full', label: 'Target' },
                    { start: endSeconds, end: renderEndSeconds, endSample: endSample, pixels: bufferPixelsRight, quality: 'half', label: 'Right Buffer' }
                ];
                // console.log('🎯 Quality zones (CENTER): Left=1/8, Target=full, Right=1/8');
            }
            
            // renderPlan.forEach(zone => {
            //     console.log(`  ${zone.label}: ${zone.pixels}px (${zone.quality} quality)`);
            // });
        } else {
            // Normal render: full quality everywhere
            const maxTimeSlices = width;
            const hopSize = Math.floor((totalSamples - fftSize) / maxTimeSlices);
            renderPlan = [
                { start: renderStartSeconds, end: renderEndSeconds, endSample: endSample, pixels: width, quality: 'full', hopSize, label: 'Full' }
            ];
        }
        
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
                const minFreq = getLogScaleMinFreq();
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
        
        // Create composite canvas for multi-zone rendering
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        const tempCtx = tempCanvas.getContext('2d');
        
        // 🎯 RENDER EACH QUALITY ZONE
        let currentXOffset = 0;
        
        for (let zoneIdx = 0; zoneIdx < renderPlan.length; zoneIdx++) {
            const zone = renderPlan[zoneIdx];
            // 🔥 FIX: zone.start and zone.end are in seconds relative to data start
            // regionSamples is already sliced from startSample to endSample
            // So we need to convert zone bounds to samples relative to renderStartSeconds
            const zoneStartRelativeToRender = zone.start - renderStartSeconds;
            const zoneEndRelativeToRender = zone.end - renderStartSeconds;
            const zoneSampleStart = Math.floor(zoneStartRelativeToRender * originalSampleRate);
            const zoneSampleEnd = Math.floor(zoneEndRelativeToRender * originalSampleRate);
            const zoneSamples = regionSamples.slice(Math.max(0, zoneSampleStart), Math.min(regionSamples.length, zoneSampleEnd));
            const zoneSampleCount = zoneSamples.length;

            // 🔬 DIAGNOSTIC: Zone sample calculation
            // console.log(`🔬 [ZONE ${zoneIdx}] "${zone.label}":`, {
            //     zoneTimeRange: `${zone.start.toFixed(2)}s - ${zone.end.toFixed(2)}s`,
            //     zoneRelativeTime: `${zoneStartRelativeToRender.toFixed(2)}s - ${zoneEndRelativeToRender.toFixed(2)}s`,
            //     zoneSampleStart,
            //     zoneSampleEnd,
            //     regionSamplesLength: regionSamples.length,
            //     zoneSampleCount,
            //     fftSize,
            //     hasEnoughForFFT: zoneSampleCount > fftSize
            // });

            // Calculate hopSize based on quality
            // Buffer zones: 1/8 quality (8x hopSize) - motion hides the low quality!
            // Target zone: full quality (1x hopSize)
            const qualityMultiplier = zone.quality === 'half' ? 8 : 1;
            const zoneMaxTimeSlices = zone.pixels;
            
            // 🔥 FIX: Ensure hopSize is at least 1 to avoid division by zero
            const calculatedHopSize = Math.max(1, Math.floor((zoneSampleCount - fftSize) / zoneMaxTimeSlices)) * qualityMultiplier;
            const zoneHopSize = Math.max(1, calculatedHopSize);
            
            // 🔥 FIX: Ensure we have at least 1 time slice, and handle edge cases
            const maxPossibleSlices = zoneSampleCount > fftSize ? Math.floor((zoneSampleCount - fftSize) / zoneHopSize) : 0;
            const zoneNumTimeSlices = Math.max(0, Math.min(zoneMaxTimeSlices, maxPossibleSlices));
            
            // 🔥 PROTECTION: Ensure zone.pixels and height are valid integers before creating ImageData
            const zonePixelsInt = Math.max(1, Math.floor(zone.pixels));
            const heightInt = Math.max(1, Math.floor(height));
            
            // 🔥 FIX: Skip zone if no time slices can be rendered
            if (zoneNumTimeSlices <= 0) {
                if (!isStudyMode()) {
                    console.warn(`⚠️ Zone "${zone.label}" has no time slices to render (zoneSampleCount=${zoneSampleCount}, fftSize=${fftSize}, zoneHopSize=${zoneHopSize})`);
                }
                // Fill this zone with black in the temp canvas
                tempCtx.fillStyle = '#000';
                tempCtx.fillRect(currentXOffset, 0, zonePixelsInt, heightInt);
                currentXOffset += zonePixelsInt;
                continue;
            }
            
            // console.log(`🎨 Rendering ${zone.label}: ${zoneNumTimeSlices} slices, hopSize=${zoneHopSize} (${zone.quality})`);
            
            if (!isFinite(zonePixelsInt) || !isFinite(heightInt) || zonePixelsInt <= 0 || heightInt <= 0) {
                console.error('❌ Invalid dimensions for zone ImageData:', {
                    zoneLabel: zone.label,
                    zonePixels: zone.pixels,
                    zonePixelsInt,
                    height,
                    heightInt,
                    width
                });
                continue; // Skip this zone
            }
            
            // Create zone ImageData
            const zoneImageData = tempCtx.createImageData(zonePixelsInt, heightInt);
            const zonePixels = zoneImageData.data;
            
            // Create batches for this zone
            const batchSize = 50;
            const zoneBatches = [];
            for (let batchStart = 0; batchStart < zoneNumTimeSlices; batchStart += batchSize) {
                const batchEnd = Math.min(batchStart + batchSize, zoneNumTimeSlices);
                zoneBatches.push({ start: batchStart, end: batchEnd });
            }
            
            const zonePixelsPerSlice = zone.pixels / zoneNumTimeSlices;
            
            // Draw callback for this zone
            let firstResultLogged = false;
            let pixelsWritten = 0;
            const drawZoneResults = (results, progress, workerIndex) => {
                const colorLUT = getColorLUT();
                for (const result of results) {
                    const { sliceIdx, magnitudes } = result;
                    const xStart = Math.floor(sliceIdx * zonePixelsPerSlice);
                    const xEnd = Math.floor((sliceIdx + 1) * zonePixelsPerSlice);

                    // 🔬 Log first result
                    // if (!firstResultLogged) {
                    //     const maxMag = Math.max(...magnitudes);
                    //     const minMag = Math.min(...magnitudes);

                    //     // Test one bin's color calculation
                    //     const testBin = 512;
                    //     const testMag = magnitudes[testBin];
                    //     const testDb = 20 * Math.log10(testMag + 1e-10);
                    //     const testNormDb = Math.max(0, Math.min(1, (testDb + 100) / 100));
                    //     const testColorIdx = Math.floor(testNormDb * 255);
                    //     const testR = colorLUT ? colorLUT[testColorIdx * 3] : 'NO_LUT';
                    //     const testG = colorLUT ? colorLUT[testColorIdx * 3 + 1] : 'NO_LUT';
                    //     const testB = colorLUT ? colorLUT[testColorIdx * 3 + 2] : 'NO_LUT';

                    //     // Test Y positions for bin 512
                    //     const testYStart = Math.floor(getYPosition(testBin + 1, frequencyBinCount, height));
                    //     const testYEnd = Math.floor(getYPosition(testBin, frequencyBinCount, height));

                    //     console.log(`🔬 [DRAW] First result:`, {
                    //         sliceIdx,
                    //         xStart, xEnd,
                    //         magnitudesLength: magnitudes.length,
                    //         maxMagnitude: maxMag,
                    //         minMagnitude: minMag,
                    //         colorLUTExists: !!colorLUT,
                    //         colorLUTLength: colorLUT?.length
                    //     });
                    //     console.log(`🔬 [DRAW] Color test (bin ${testBin}):`, {
                    //         testMag,
                    //         testDb,
                    //         testNormDb,
                    //         testColorIdx,
                    //         testRGB: [testR, testG, testB],
                    //         testYStart,
                    //         testYEnd,
                    //         yLoopRuns: testYStart < testYEnd ? testYEnd - testYStart : 0
                    //     });
                    //     firstResultLogged = true;
                    // }

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

                        // 🔬 Log Y position issue on first bin
                        // if (!firstResultLogged && binIdx === 0) {
                        //     console.log(`🔬 [DRAW] Y positions:`, { binIdx, yStart, yEnd, loopWillRun: yStart < yEnd });
                        // }

                        for (let x = xStart; x < xEnd; x++) {
                            for (let y = yStart; y < yEnd; y++) {
                                const pixelIndex = (y * zone.pixels + x) * 4;
                                zonePixels[pixelIndex] = r;
                                zonePixels[pixelIndex + 1] = g;
                                zonePixels[pixelIndex + 2] = b;
                                zonePixels[pixelIndex + 3] = 255;
                                pixelsWritten++;
                            }
                        }
                    }
                }
            };
            
            // Track if callback was called
            let callbackCallCount = 0;
            let totalResultsProcessed = 0;

            // Wrap callback to track calls
            const trackingCallback = (results, progress, workerIndex) => {
                callbackCallCount++;
                totalResultsProcessed += results.length;
                drawZoneResults(results, progress, workerIndex);
            };

            // Process this zone with worker pool
            await workerPool.processBatches(
                zoneSamples,
                zoneBatches,
                fftSize,
                zoneHopSize,
                window,
                trackingCallback
            );

            // 🔬 DIAGNOSTIC: Check if FFT processing worked
            // console.log(`🔬 [ZONE ${zoneIdx}] FFT processing complete:`, {
            //     callbackCalls: callbackCallCount,
            //     totalResults: totalResultsProcessed,
            //     expectedBatches: zoneBatches.length,
            //     zoneNumTimeSlices,
            //     pixelsWritten
            // });

            // 🔥 PROTECTION: Check for cancellation after each zone
            if (signal.aborted) {
                console.log('🛑 Render cancelled during zone processing');
                renderingInProgress = false;
                activeRenderAbortController = null;
                activeRenderRegionId = null;
                return;
            }
            
            // 🔬 DIAGNOSTIC: Check if zoneImageData has any content
            // Check BOTTOM of canvas (where low frequencies / signal is drawn)
            let hasNonBlackPixels = false;
            const zonePixelData = zoneImageData.data;
            const startFromBottom = Math.max(0, zonePixelData.length - 40000); // Check last ~10k pixels (bottom)
            for (let i = startFromBottom; i < zonePixelData.length; i += 4) {
                if (zonePixelData[i] > 5 || zonePixelData[i + 1] > 5 || zonePixelData[i + 2] > 5) {
                    hasNonBlackPixels = true;
                    break;
                }
            }
            // Also sample middle of canvas
            const middleStart = Math.floor(zonePixelData.length / 2) - 2000;
            for (let i = middleStart; i < middleStart + 4000 && !hasNonBlackPixels; i += 4) {
                if (zonePixelData[i] > 5 || zonePixelData[i + 1] > 5 || zonePixelData[i + 2] > 5) {
                    hasNonBlackPixels = true;
                    break;
                }
            }
            // console.log(`🔬 [ZONE ${zoneIdx}] ImageData check:`, {
            //     hasNonBlackPixels,
            //     imageDataWidth: zoneImageData.width,
            //     imageDataHeight: zoneImageData.height,
            //     dataLength: zonePixelData.length,
            //     checkedFromBottom: startFromBottom
            // });

            // Composite this zone onto the final canvas
            tempCtx.putImageData(zoneImageData, currentXOffset, 0);
            currentXOffset += zone.pixels;
        }
        
        // console.log(`✅ Multi-zone composite complete: ${renderPlan.length} zones rendered`);
        
        // 🔥 PROTECTION: Check for cancellation before creating infinite canvas
        if (signal.aborted) {
            console.log('🛑 Render cancelled before creating infinite canvas');
            renderingInProgress = false;
            activeRenderAbortController = null;
            activeRenderRegionId = null;
            return;
        }
        
        // 🎯 SMART RENDER: Extract ONLY the full-quality target region for final display
        let finalCanvas = tempCanvas;
        if (useSmartRender) {
            // Find which zone is the target (full quality)
            const targetZone = renderPlan.find(z => z.quality === 'full');
            if (targetZone) {
                // Calculate pixel offset of target zone in composite
                let targetXOffset = 0;
                for (let i = 0; i < renderPlan.length; i++) {
                    if (renderPlan[i] === targetZone) break;
                    targetXOffset += renderPlan[i].pixels;
                }
                
                // console.log(`🎯 Extracting target region: ${targetZone.pixels}px at offset ${targetXOffset}px (full quality only)`);
                
                // Create final canvas with ONLY the target region
                finalCanvas = document.createElement('canvas');
                finalCanvas.width = width; // Still full width for consistency
                finalCanvas.height = height;
                const finalCtx = finalCanvas.getContext('2d');
                
                // Extract just the target region from composite and stretch to full width
                finalCtx.drawImage(
                    tempCanvas,
                    targetXOffset, 0, targetZone.pixels, height,  // source (target zone only)
                    0, 0, width, height  // destination (stretched to full width)
                );
                
                // Keep composite for early crossfade detection (stored separately)
                cachedZoomedSpectrogramCanvas = tempCanvas;
            }
        }
        
        // 🔥 DIAGNOSTIC: Verify finalCanvas has content before creating infinite canvas
        // Check BOTTOM of canvas (where low frequencies / signal is drawn)
        const finalCtxCheck = finalCanvas.getContext('2d');
        const checkHeight = Math.min(100, finalCanvas.height);
        const checkY = Math.max(0, finalCanvas.height - checkHeight); // Start from bottom
        const checkImageData = finalCtxCheck.getImageData(0, checkY, Math.min(100, finalCanvas.width), checkHeight);
        let finalCanvasHasContent = false;
        for (let i = 0; i < checkImageData.data.length; i += 4) {
            if (checkImageData.data[i] > 5 || checkImageData.data[i + 1] > 5 || checkImageData.data[i + 2] > 5) {
                finalCanvasHasContent = true;
                break;
            }
        }
        
        // 🔬 DIAGNOSTIC: Always log what we found
        // console.log(`🔬 [FINAL CANVAS] Content check:`, {
        //     finalCanvasHasContent,
        //     checkY,
        //     checkHeight,
        //     canvasSize: `${finalCanvas.width}x${finalCanvas.height}`,
        //     checkedRegion: `y=${checkY} to y=${checkY + checkHeight}`
        // });

        if (!finalCanvasHasContent && !isStudyMode()) {
            console.warn('⚠️ renderCompleteSpectrogramForRegion: finalCanvas has no visible content before creating infinite canvas!', {
                finalCanvasSize: `${finalCanvas.width}x${finalCanvas.height}`,
                tempCanvasSize: `${tempCanvas.width}x${tempCanvas.height}`,
                useSmartRender,
                renderPlanLength: renderPlan.length
            });
        }
        
        // Create infinite canvas from final (target-only) render
        const infiniteHeight = Math.floor(height * MAX_PLAYBACK_RATE);
        infiniteSpectrogramCanvas = document.createElement('canvas');
        infiniteSpectrogramCanvas.width = width;
        infiniteSpectrogramCanvas.height = infiniteHeight;
        const infiniteCtx = infiniteSpectrogramCanvas.getContext('2d');
        
        infiniteCtx.fillStyle = '#000';
        infiniteCtx.fillRect(0, 0, width, infiniteHeight);
        
        // 🔥 FIX: Only draw if finalCanvas has content
        if (finalCanvasHasContent) {
            infiniteCtx.drawImage(finalCanvas, 0, infiniteHeight - height);
        } else {
            if (!isStudyMode()) {
                console.error('❌ Skipping drawImage - finalCanvas is empty/black!');
            }
        }
        
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
            
            // 🎯 SMART RENDER: Track bounds for early crossfade detection
            if (useSmartRender) {
                const renderCompleteTimestamp = performance.now();
                const renderDuration = renderCompleteTimestamp - renderStartTimestamp;
                smartRenderBounds = {
                    expandedStart: renderStartSeconds,
                    expandedEnd: renderEndSeconds,
                    targetStart: startSeconds,
                    targetEnd: endSeconds,
                    renderComplete: true
                };
                // console.log('🎯 ⏱️ RENDER COMPLETE:', renderCompleteTimestamp.toFixed(0) + 'ms (took ' + renderDuration.toFixed(0) + 'ms)');
                // console.log('🎯 Smart render complete - ready for early crossfade!', smartRenderBounds);
            } else {
                // Clear smart render tracking for normal renders
                smartRenderBounds.renderComplete = false;
            }
            
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
