/**
 * spectrogram-complete-renderer.js
 * Complete spectrogram renderer - renders entire spectrogram in one shot after all audio is loaded
 * This provides perfect time alignment with the waveform and avoids streaming artifacts
 * 
 * OPTIMIZATIONS:
 * - Worker pool for parallel FFT computation (8 cores!)
 * - Direct ImageData pixel buffer manipulation (no fillRect!)
 * - Pre-computed color lookup table (no repeated HSL→RGB conversion!)
 * - Only computes as many FFTs as pixels wide (no wasted computation!)
 */

import * as State from './audio-state.js';
import { drawFrequencyAxis, positionAxisCanvas, resizeAxisCanvas, initializeAxisPlaybackRate } from './spectrogram-axis-renderer.js';
import { SpectrogramWorkerPool } from './spectrogram-worker-pool.js';
import { zoomState } from './zoom-state.js';

// Track if we've rendered the complete spectrogram
let completeSpectrogramRendered = false;
let renderingInProgress = false;

// Worker pool for parallel FFT computation (MAXIMIZE ALL CPU CORES! 🔥)
let workerPool = null;

// Cached spectrogram canvas (for redrawing with playhead)
let cachedSpectrogramCanvas = null;

// Infinite canvas for GPU-accelerated viewport stretching
// Rendered once at neutral (1x), then GPU-stretched on demand
let infiniteSpectrogramCanvas = null;

// 🏛️ Track the context of the current infinite canvas
// Each zoom level = new self (new infinite canvas)
// Speed changes = same self, different expression (GPU stretch)
let infiniteCanvasContext = {
    startSample: null,
    endSample: null,
    frequencyScale: null
};
const MAX_PLAYBACK_RATE = 15.0; // Maximum playback rate for infinite canvas sizing

// Reusable temporary canvases (to avoid creating/destroying many canvases)
let tempStretchCanvas = null;
let tempShrinkCanvas = null;

// Memory monitoring
let memoryMonitorInterval = null;
let memoryBaseline = null;
let memoryHistory = [];
const MEMORY_HISTORY_SIZE = 20; // Keep last 20 readings (1.7 minutes at 5s intervals)

/**
 * Log memory usage for monitoring
 */
function logMemory(label) {
    if (performance.memory) {
        const used = (performance.memory.usedJSHeapSize / 1024 / 1024).toFixed(1);
        const total = (performance.memory.totalJSHeapSize / 1024 / 1024).toFixed(1);
        const limit = (performance.memory.jsHeapSizeLimit / 1024 / 1024).toFixed(1);
        const percent = ((performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit) * 100).toFixed(1);
        console.log(`💾 ${label}: ${used}MB / ${total}MB (limit: ${limit}MB, ${percent}% used)`);
        
        if (percent > 80) {
            console.warn('⚠️ Memory usage high!');
        }
        
        return parseFloat(used);
    }
    return null;
}

/**
 * Periodic memory health check
 * Monitors baseline and detects potential memory leaks
 */
function memoryHealthCheck() {
    if (!performance.memory) return; // Safari/Firefox don't support this API
    
    const used = performance.memory.usedJSHeapSize / 1024 / 1024;
    const limit = performance.memory.jsHeapSizeLimit / 1024 / 1024;
    const percent = ((performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit) * 100).toFixed(1);
    
    // Track baseline (minimum observed memory - after GC runs)
    if (memoryBaseline === null || used < memoryBaseline) {
        memoryBaseline = used;
    }
    
    // Add to history
    memoryHistory.push({ time: Date.now(), used, percent: parseFloat(percent) });
    if (memoryHistory.length > MEMORY_HISTORY_SIZE) {
        memoryHistory.shift();
    }
    
    // Calculate trend (is baseline growing?)
    let trend = 'stable';
    if (memoryHistory.length >= 10) {
        const oldBaseline = Math.min(...memoryHistory.slice(0, 5).map(h => h.used));
        const newBaseline = Math.min(...memoryHistory.slice(-5).map(h => h.used));
        const growth = newBaseline - oldBaseline;
        
        if (growth > 200) { // Growing by 200+ MB
            trend = '📈 increasing';
            console.warn(`🚨 POTENTIAL MEMORY LEAK: Baseline grew ${growth.toFixed(0)}MB (${oldBaseline.toFixed(0)}MB → ${newBaseline.toFixed(0)}MB)`);
        } else if (growth > 100) {
            trend = '📈 rising';
        }
    }
    
    // Log periodic health check
    const avgPercent = (memoryHistory.reduce((sum, h) => sum + h.percent, 0) / memoryHistory.length).toFixed(1);
    console.log(`🏥 Memory health: ${used.toFixed(0)}MB (${percent}%) | Baseline: ${memoryBaseline.toFixed(0)}MB | Avg: ${avgPercent}% | Limit: ${limit.toFixed(0)}MB | Trend: ${trend}`);
}

/**
 * Start periodic memory monitoring
 */
export function startMemoryMonitoring() {
    if (memoryMonitorInterval) return;
    
    console.log('🏥 Starting memory health monitoring (every 10 seconds)');
    memoryMonitorInterval = setInterval(memoryHealthCheck, 10000);
    
    // Initial check
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
 * @param {number} h - Hue (0-360)
 * @param {number} s - Saturation (0-100)
 * @param {number} l - Lightness (0-100)
 * @returns {Array} [r, g, b] values (0-255)
 */
function hslToRgb(h, s, l) {
    h = h / 360;
    s = s / 100;
    l = l / 100;
    
    let r, g, b;
    
    if (s === 0) {
        r = g = b = l; // achromatic
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
 * Main function to render the complete spectrogram
 * Called once all audio data is available
 */
export async function renderCompleteSpectrogram(skipViewportUpdate = false) {
    if (!State.completeSamplesArray || State.completeSamplesArray.length === 0) {
        console.log('⚠️ Cannot render complete spectrogram - no audio data available');
        return;
    }
    
    if (renderingInProgress) {
        console.log('⚠️ Spectrogram rendering already in progress');
        return;
    }
    
    // 🏛️ Check zoom state FIRST - if zoomed, always render region (ignore completeSpectrogramRendered flag)
    if (zoomState.mode === 'temple' && zoomState.isInitialized()) {
        const startSeconds = zoomState.sampleToTime(zoomState.currentViewStartSample);
        const endSeconds = zoomState.sampleToTime(zoomState.currentViewEndSample);
        console.log(`🔍 Zoomed mode detected - rendering region instead`);
        return await renderCompleteSpectrogramForRegion(startSeconds, endSeconds);
    }
    
    // Only check completeSpectrogramRendered for full view (not zoomed)
    if (completeSpectrogramRendered) {
        console.log('✅ Complete spectrogram already rendered');
        return;
    }
    
    // 🏛️ Check if we need to re-render due to context change
    const audioData = State.completeSamplesArray;
    const totalSamples = audioData ? audioData.length : 0;
    const needsRerender = infiniteSpectrogramCanvas && 
        (infiniteCanvasContext.startSample !== 0 ||
         infiniteCanvasContext.endSample !== totalSamples ||
         infiniteCanvasContext.frequencyScale !== State.frequencyScale);
    
    if (needsRerender) {
        console.log('🔄 Context changed - clearing old self and re-rendering');
        console.log(`   Old: ${infiniteCanvasContext.startSample}-${infiniteCanvasContext.endSample}, scale=${infiniteCanvasContext.frequencyScale}`);
        console.log(`   New: 0-${totalSamples}, scale=${State.frequencyScale}`);
        clearInfiniteCanvas();
    }
    
    renderingInProgress = true;
    console.log('🎨 Starting complete spectrogram rendering...');
    
    // Log memory before rendering
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
    
    // Clear canvas (skip if we're transitioning - old spectrogram stays visible!)
    if (!skipViewportUpdate) {
        ctx.clearRect(0, 0, width, height);
    }
    
    try {
        const startTime = performance.now();
        
        // Get audio data
        const audioData = State.completeSamplesArray;
        const totalSamples = audioData.length;
        const sampleRate = 44100; // AudioContext sample rate
        
        console.log(`📊 Rendering spectrogram for ${totalSamples.toLocaleString()} samples (${(totalSamples / sampleRate).toFixed(2)}s)`);
        
        // FFT parameters
        const fftSize = 2048; // Matches analyser node
        const frequencyBinCount = fftSize / 2;
        
        // OPTIMIZATION: Only compute as many time slices as we have pixels!
        const maxTimeSlices = width; // One FFT per pixel column
        const hopSize = Math.floor((totalSamples - fftSize) / maxTimeSlices);
        const numTimeSlices = Math.min(maxTimeSlices, Math.floor((totalSamples - fftSize) / hopSize));
        
        console.log(`🔧 FFT size: ${fftSize}, Hop size: ${hopSize.toLocaleString()}, Time slices: ${numTimeSlices.toLocaleString()} (optimized for ${width}px width)`);
        
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
        // 🔥 RENDER AT NEUTRAL (1x) - NO playback rate scaling during rendering!
        // CRITICAL: Convert bin indices to actual frequencies to match tick positioning!
        const getYPosition = (binIndex, totalBins, canvasHeight) => {
            // Get original sample rate from metadata (matches spectrogram-axis-renderer.js)
            const originalSampleRate = State.currentMetadata?.original_sample_rate || 100;
            const originalNyquist = originalSampleRate / 2;
            
            // Convert bin index to actual frequency in Hz
            // Bin 0 = 0 Hz, Bin (totalBins-1) = Nyquist
            const frequency = (binIndex / totalBins) * originalNyquist;
            
            if (State.frequencyScale === 'logarithmic') {
                // Logarithmic scale: use same frequency range as tick positioning!
                const minFreq = 0.1; // Match tick positioning (avoid log(0))
                const freqSafe = Math.max(frequency, minFreq);
                const logMin = Math.log10(minFreq);
                const logMax = Math.log10(originalNyquist);
                const logFreq = Math.log10(freqSafe);
                const normalizedLog = (logFreq - logMin) / (logMax - logMin);
                
                return canvasHeight - (normalizedLog * canvasHeight);
            } else if (State.frequencyScale === 'sqrt') {
                // Square root scale: normalize by Nyquist, then apply sqrt
                const normalized = frequency / originalNyquist;
                const sqrtNormalized = Math.sqrt(normalized);
                return canvasHeight - (sqrtNormalized * canvasHeight);
            } else {
                // Linear scale: normalize by Nyquist
                const normalized = frequency / originalNyquist;
                return canvasHeight - (normalized * canvasHeight);
            }
        };
        
        // Create ImageData for direct pixel manipulation (MUCH faster than fillRect!)
        const imageData = ctx.createImageData(width, height);
        const pixels = imageData.data;
        
        // Pre-compute color lookup table (256 levels from dB scale)
        const colorLUT = new Uint8ClampedArray(256 * 3); // RGB values for each level
        for (let i = 0; i < 256; i++) {
            const normalized = i / 255;
            const hue = normalized * 60; // 0° to 60°
            const saturation = 100;
            const lightness = 10 + (normalized * 60);
            
            // Convert HSL to RGB (pre-compute once!)
            const rgb = hslToRgb(hue, saturation, lightness);
            colorLUT[i * 3] = rgb[0];
            colorLUT[i * 3 + 1] = rgb[1];
            colorLUT[i * 3 + 2] = rgb[2];
        }
        
        console.log(`🎨 Pre-computed color LUT (256 levels)`);
        
        // Calculate x position for each slice
        const pixelsPerSlice = width / numTimeSlices;
        
        // Create batches for parallel processing
        const batchSize = 50; // Smaller batches = better load balancing across workers
        const batches = [];
        
        for (let batchStart = 0; batchStart < numTimeSlices; batchStart += batchSize) {
            const batchEnd = Math.min(batchStart + batchSize, numTimeSlices);
            batches.push({ start: batchStart, end: batchEnd });
        }
        
        console.log(`📦 Processing ${numTimeSlices} slices in ${batches.length} batches across worker pool`);
        
        // Function to draw results from worker (called as results arrive)
        const drawResults = (results, progress, workerIndex) => {
            for (const result of results) {
                const { sliceIdx, magnitudes } = result;
                
                // Calculate x position
                const xStart = Math.floor(sliceIdx * pixelsPerSlice);
                const xEnd = Math.floor((sliceIdx + 1) * pixelsPerSlice);
                
                // Draw this time slice directly to pixel buffer
                for (let binIdx = 0; binIdx < frequencyBinCount; binIdx++) {
                    const magnitude = magnitudes[binIdx];
                    
                    // Convert magnitude to dB scale and normalize
                    const db = 20 * Math.log10(magnitude + 1e-10);
                    const normalizedDb = Math.max(0, Math.min(1, (db + 100) / 100));
                    const colorIndex = Math.floor(normalizedDb * 255);
                    
                    // Get pre-computed RGB values
                    const r = colorLUT[colorIndex * 3];
                    const g = colorLUT[colorIndex * 3 + 1];
                    const b = colorLUT[colorIndex * 3 + 2];
                    
                    // Calculate y positions
                    const yStart = Math.floor(getYPosition(binIdx + 1, frequencyBinCount, height));
                    const yEnd = Math.floor(getYPosition(binIdx, frequencyBinCount, height));
                    
                    // Write pixels directly to buffer (no fillRect calls!)
                    for (let x = xStart; x < xEnd; x++) {
                        for (let y = yStart; y < yEnd; y++) {
                            const pixelIndex = (y * width + x) * 4;
                            pixels[pixelIndex] = r;
                            pixels[pixelIndex + 1] = g;
                            pixels[pixelIndex + 2] = b;
                            pixels[pixelIndex + 3] = 255; // Alpha
                        }
                    }
                }
                
                // 🔥 FIX: Clear magnitudes reference after processing to allow GC of ArrayBuffer
                // The magnitudes Float32Array's buffer was transferred from worker
                // Clearing the reference helps GC reclaim the ArrayBuffer
                result.magnitudes = null;
            }
            
            // Log progress with worker info
            console.log(`⏳ Spectrogram rendering: ${progress}% (worker ${workerIndex})`);
        };
        
        // Process all batches in parallel across worker pool! 🔥
        await workerPool.processBatches(
            audioData,
            batches,
            fftSize,
            hopSize,
            window,
            drawResults  // Callback fires immediately as each worker completes
        );
        
        // Write ImageData to temp canvas (neutral 450px render)
        console.log(`🎨 Writing ImageData to neutral render canvas...`);
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height; // 450px - neutral render
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.putImageData(imageData, 0, 0);
        
        // Create infinite canvas (6750px = 450 * 15)
        const infiniteHeight = Math.floor(height * MAX_PLAYBACK_RATE);
        infiniteSpectrogramCanvas = document.createElement('canvas');
        infiniteSpectrogramCanvas.width = width;
        infiniteSpectrogramCanvas.height = infiniteHeight;
        const infiniteCtx = infiniteSpectrogramCanvas.getContext('2d');
        
        // Fill infinite canvas with black
        infiniteCtx.fillStyle = '#000';
        infiniteCtx.fillRect(0, 0, width, infiniteHeight);
        
        // Place neutral 450px render at BOTTOM of infinite canvas
        infiniteCtx.drawImage(tempCanvas, 0, infiniteHeight - height);
        
        console.log(`🌊 Created infinite canvas: ${width} × ${infiniteHeight}px`);
        console.log(`   Placed neutral ${width} × ${height}px render at bottom`);
        
        // 🏛️ Record the context of this render
        infiniteCanvasContext = {
            startSample: 0,
            endSample: totalSamples,
            frequencyScale: State.frequencyScale
        };
        console.log(`🏛️ New self created: Full view (0-${totalSamples.toLocaleString()}), scale=${State.frequencyScale}`);
        
        // Cache the spectrogram for redrawing with playhead (use temp canvas)
        cachedSpectrogramCanvas = tempCanvas;
        
        // Update display canvas with initial viewport (will be called after function is defined)
        // We'll call updateSpectrogramViewport at the end of this function
        
        const elapsed = performance.now() - startTime;
        console.log(`✅ Complete spectrogram rendered in ${elapsed.toFixed(0)}ms`);
        
        // Log memory after rendering
        logMemory('After FFT completion');
        
        completeSpectrogramRendered = true;
        State.setSpectrogramInitialized(true);
        
        // Draw frequency axis
        positionAxisCanvas();
        initializeAxisPlaybackRate();
        drawFrequencyAxis();
        
        // Update display canvas with initial viewport (now that function is defined)
        // Skip if we're in a transition (will be handled by caller)
        if (!skipViewportUpdate) {
            updateSpectrogramViewport(State.currentPlaybackRate || 1.0);
        }
        
    } catch (error) {
        console.error('❌ Error rendering complete spectrogram:', error);
    } finally {
        renderingInProgress = false;
    }
}

/**
 * Clear the complete spectrogram and reset rendering state
 * Called when new audio is loaded
 */
/**
 * Clear the infinite canvas and its context
 * Called when fundamental rendering parameters change (zoom, frequency scale)
 * Each zoom level = new self (new infinite canvas)
 */
function clearInfiniteCanvas() {
    if (infiniteSpectrogramCanvas) {
        const ctx = infiniteSpectrogramCanvas.getContext('2d');
        ctx.clearRect(0, 0, infiniteSpectrogramCanvas.width, infiniteSpectrogramCanvas.height);
        infiniteSpectrogramCanvas.width = 0;
        infiniteSpectrogramCanvas.height = 0;
        infiniteSpectrogramCanvas = null;
    }
    
    // Clear context
    infiniteCanvasContext = {
        startSample: null,
        endSample: null,
        frequencyScale: null
    };
    
    console.log('🧹 Infinite canvas cleared - ready for new self');
}

/**
 * Reset spectrogram state without clearing the display canvas
 * Used during transitions to allow re-rendering while keeping old spectrogram visible
 */
export function resetSpectrogramState() {
    completeSpectrogramRendered = false;
    renderingInProgress = false;
    State.setSpectrogramInitialized(false);
    
    // 🏛️ Clear infinite canvas and context (handles both canvas and context)
    clearInfiniteCanvas();
    
    // Clear cached canvases but NOT the display canvas
    if (cachedSpectrogramCanvas) {
        try {
            const cacheCtx = cachedSpectrogramCanvas.getContext('2d');
            cacheCtx.clearRect(0, 0, cachedSpectrogramCanvas.width, cachedSpectrogramCanvas.height);
            cachedSpectrogramCanvas.width = 0;
            cachedSpectrogramCanvas.height = 0;
        } catch (e) {
            console.warn('⚠️ Error clearing cached canvas:', e);
        }
        cachedSpectrogramCanvas = null;
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

export function clearCompleteSpectrogram() {
    console.log('🧹 Starting aggressive spectrogram cleanup...');
    
    // Log memory before cleanup
    logMemory('Before cleanup');
    
    const canvas = document.getElementById('spectrogram');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    
    // Aggressively clear cached canvas to free memory immediately
    if (cachedSpectrogramCanvas) {
        try {
            const cacheCtx = cachedSpectrogramCanvas.getContext('2d');
            cacheCtx.clearRect(0, 0, cachedSpectrogramCanvas.width, cachedSpectrogramCanvas.height);
            // Resize to 0x0 to force deallocation
            cachedSpectrogramCanvas.width = 0;
            cachedSpectrogramCanvas.height = 0;
        } catch (e) {
            console.warn('⚠️ Error clearing cached canvas:', e);
        }
        cachedSpectrogramCanvas = null;
    }
    
    // Clear infinite canvas
    if (infiniteSpectrogramCanvas) {
        try {
            const infiniteCtx = infiniteSpectrogramCanvas.getContext('2d');
            infiniteCtx.clearRect(0, 0, infiniteSpectrogramCanvas.width, infiniteSpectrogramCanvas.height);
            infiniteSpectrogramCanvas.width = 0;
            infiniteSpectrogramCanvas.height = 0;
        } catch (e) {
            console.warn('⚠️ Error clearing infinite canvas:', e);
        }
        infiniteSpectrogramCanvas = null;
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
    
    // Terminate worker pool to free memory (will be recreated on next render)
    if (workerPool) {
        workerPool.terminate();
        workerPool = null;
    }
    
    // Hint to browser that GC would be nice (only works with --expose-gc flag)
    if (typeof window !== 'undefined' && window.gc) {
        console.log('🗑️ Requesting manual garbage collection...');
        window.gc();
    }
    
    // Log memory after cleanup
    logMemory('After aggressive cleanup');
    
    console.log('✅ Spectrogram cleanup complete');
}

/**
 * Check if complete spectrogram has been rendered
 */
export function isCompleteSpectrogramRendered() {
    return completeSpectrogramRendered;
}

/**
 * Get the cached spectrogram canvas
 */
export function getCachedSpectrogramCanvas() {
    return cachedSpectrogramCanvas;
}

/**
 * Calculate stretch factor based on frequency scale
 * Different scales compress frequency range differently!
 * 
 * @param {number} playbackRate - Current playback rate
 * @param {string} frequencyScale - 'linear', 'sqrt', or 'logarithmic'
 * @returns {number} Stretch factor to apply
 */
function calculateStretchFactor(playbackRate, frequencyScale) {
    if (frequencyScale === 'linear') {
        // Linear: direct proportion
        // At 15x: Show 1/15th of frequency range → stretch 15x
        return playbackRate;
    } else if (frequencyScale === 'sqrt') {
        // Sqrt: stretch by sqrt(playbackRate)
        // Because sqrt(1/15) of canvas needs to become full canvas
        // sqrt(1/15) ≈ 0.258 → need to stretch 0.258 → 1.0 = 1/0.258 ≈ sqrt(15)
        return Math.sqrt(playbackRate);
    } else if (frequencyScale === 'logarithmic') {
        // Log: use logarithmic scaling similar to how sqrt uses sqrt(playbackRate)
        // Get original sample rate from metadata (matches spectrogram-axis-renderer.js)
        const originalSampleRate = State.currentMetadata?.original_sample_rate || 100;
        const originalNyquist = originalSampleRate / 2;
        const minFreq = 0.1; // Match tick positioning (avoid log(0))
        
        // Calculate the log-space equivalent of sqrt(playbackRate)
        // For sqrt: sqrt(playbackRate) works because sqrt compresses by sqrt
        // For log: we need the equivalent log-space compression factor
        // The key insight: when frequencies scale by playbackRate, the log range scales differently
        const logMin = Math.log10(minFreq);
        const logMax = Math.log10(originalNyquist);
        const logRange = logMax - logMin;
        
        // When playbackRate changes, the effective frequency range changes
        // In log space: log(f * playbackRate) = log(f) + log(playbackRate)
        // So the log range shifts by log(playbackRate)
        // The stretch factor should compensate for this shift
        // Try: similar to sqrt, but account for log compression
        const logPlaybackRate = Math.log10(playbackRate);
        
        // Adapted from old formula: targetMaxFreq = maxFreq / playbackRate
        // But using actual frequencies: at higher playbackRate, we show a smaller portion
        // of the frequency range (zooming in on lower frequencies)
        const targetMaxFreq = originalNyquist / playbackRate;
        const logTargetMax = Math.log10(Math.max(targetMaxFreq, minFreq));
        const targetLogRange = logTargetMax - logMin;
        const fraction = targetLogRange / logRange;
        
        // Stretch to fill viewport: if showing fraction of log space, stretch by 1/fraction
        return 1 / fraction;
    }
    
    return playbackRate; // Fallback to linear
}

/**
 * Update spectrogram viewport with GPU-accelerated stretching
 * NOW WITH FREQUENCY-SCALE-AWARE STRETCHING! 🎨✨
 * Called when playback rate changes - stretches/shrinks neutral render on demand
 * @param {number} playbackRate - Current playback rate (0.1 = min, 1.0 = neutral, 15.0 = max)
 */
/**
 * Get the viewport image for a given playback rate without updating the display canvas
 * Returns a canvas element with the viewport rendered
 */
export function getSpectrogramViewport(playbackRate) {
    // 🏛️ Check for infinite canvas (works for both full view and temple mode!)
    if (!infiniteSpectrogramCanvas) {
        return null;
    }
    
    const canvas = document.getElementById('spectrogram');
    if (!canvas) return null;
    
    const width = canvas.width;
    const height = canvas.height;
    
    // Create output canvas
    const viewportCanvas = document.createElement('canvas');
    viewportCanvas.width = width;
    viewportCanvas.height = height;
    const ctx = viewportCanvas.getContext('2d');
    
    // Calculate scale-aware stretch factor
    const stretchFactor = calculateStretchFactor(playbackRate, State.frequencyScale);
    const stretchedHeight = Math.floor(height * stretchFactor);
    
    ctx.clearRect(0, 0, width, height);
    
    if (stretchedHeight >= height) {
        // STRETCHING case (playbackRate >= 1.0): Show bottom slice of stretched image
        // Reuse or create temporary stretch canvas
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
        
        // Stretch the neutral render
        stretchCtx.drawImage(
            infiniteSpectrogramCanvas,
            0, infiniteSpectrogramCanvas.height - height,
            width, height,
            0, 0,
            width, stretchedHeight
        );
        
        // Extract bottom 450px
        ctx.drawImage(
            tempStretchCanvas,
            0, stretchedHeight - height,
            width, height,
            0, 0,
            width, height
        );
    } else {
        // SHRINKING case (playbackRate < 1.0): Shrink render and fill top with silence
        // Fill with spectrogram "silence" color
        const [r, g, b] = hslToRgb(0, 100, 10);
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(0, 0, width, height);
        
        // Reuse or create temporary shrink canvas
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
        
        // Place shrunken render at BOTTOM of viewport
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
 * 
 * PLAYBACK RATE PHYSICS:
 * - Slower playback (< 1.0) = lower frequencies (like slowing a record)
 *   → All content shifts DOWN in frequency space
 *   → Spectrogram compresses vertically (less space needed)
 *   → Black gap appears at TOP (no high-frequency content)
 * 
 * - Faster playback (> 1.0) = higher frequencies (like speeding a record)
 *   → All content shifts UP in frequency space  
 *   → Spectrogram stretches vertically (more space needed for higher freqs)
 *   → Content fills viewport and beyond
 */
export function updateSpectrogramViewport(playbackRate) {
    // 🏛️ Check for infinite canvas (works for both full view and temple mode!)
    if (!infiniteSpectrogramCanvas) {
        console.log(`⚠️ updateSpectrogramViewport: No infinite canvas! playbackRate=${playbackRate}`);
        return; // Not ready yet (no infinite canvas created)
    }
    
    const canvas = document.getElementById('spectrogram');
    if (!canvas) {
        console.log(`⚠️ updateSpectrogramViewport: No spectrogram canvas!`);
        return;
    }
    
    console.log(`🎨 updateSpectrogramViewport: stretching with playbackRate=${playbackRate}, frequencyScale=${State.frequencyScale}`);
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height; // 450px viewport
    
    // 🔥 Calculate stretch factor based on frequency scale!
    const stretchFactor = calculateStretchFactor(playbackRate, State.frequencyScale);
    const stretchedHeight = Math.floor(height * stretchFactor);
    console.log(`   Stretch factor: ${stretchFactor.toFixed(3)}, stretchedHeight: ${stretchedHeight}px (from ${height}px)`);
    
    // Clear viewport
    ctx.clearRect(0, 0, width, height);
    
    if (stretchedHeight >= height) {
        // STRETCHING case (playbackRate >= 1.0): Show bottom slice of stretched image
        // Reuse or create temporary stretch canvas
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
        
        // Stretch the neutral render
        stretchCtx.drawImage(
            infiniteSpectrogramCanvas,
            0, infiniteSpectrogramCanvas.height - height,  // Source: bottom 450px
            width, height,                                  // Source size
            0, 0,                                          // Dest: top-left
            width, stretchedHeight                          // Dest: stretched by scale-aware factor!
        );
        
        // Extract bottom 450px of stretched image
        ctx.drawImage(
            tempStretchCanvas,
            0, stretchedHeight - height,  // Source: bottom of stretched
            width, height,                // Source size
            0, 0,                         // Dest: top-left
            width, height                 // Dest size
        );
    } else {
        // SHRINKING case (playbackRate < 1.0): Shrink render and fill top with silence
        
        // Fill with spectrogram "silence" color (dark red, matching spectrogram background)
        const [r, g, b] = hslToRgb(0, 100, 10);
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(0, 0, width, height);
        
        // Reuse or create temporary shrink canvas
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
            0, infiniteSpectrogramCanvas.height - height,  // Source: bottom 450px
            width, height,                                  // Source size
            0, 0,                                          // Dest: top-left
            width, stretchedHeight                          // Dest: shrunk!
        );
        
        // Place shrunken render at BOTTOM of viewport
        ctx.drawImage(
            tempShrinkCanvas,
            0, 0,                          // Source: entire shrunken image
            width, stretchedHeight,         // Source size
            0, height - stretchedHeight,   // Dest: place at bottom!
            width, stretchedHeight         // Dest size
        );
    }
    
    // Update cached canvas for playhead redrawing
    if (cachedSpectrogramCanvas) {
        cachedSpectrogramCanvas.getContext('2d').drawImage(canvas, 0, 0);
    }
}

/**
 * Render spectrogram for a specific time range (region zoom)
 * @param {number} startSeconds - Start time in seconds
 * @param {number} endSeconds - End time in seconds
 */
export async function renderCompleteSpectrogramForRegion(startSeconds, endSeconds) {
    if (!State.completeSamplesArray || State.completeSamplesArray.length === 0) {
        console.log('⚠️ Cannot render region spectrogram - no audio data');
        return;
    }
    
    console.log(`🔍 Rendering spectrogram for region: ${startSeconds.toFixed(2)}s to ${endSeconds.toFixed(2)}s`);
    
    // Log memory before region rendering
    logMemory('Before region FFT');
    
    const canvas = document.getElementById('spectrogram');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    const width = canvas.width;
    const height = canvas.height;
    
    // Clear canvas
    ctx.clearRect(0, 0, width, height);
    
    // Calculate sample range (needed for context check)
    const sampleRate = 44100;
    const startSample = Math.floor(startSeconds * sampleRate);
    const endSample = Math.floor(endSeconds * sampleRate);
    
    // 🏛️ Check if we need to re-render due to context change
    const needsRerender = infiniteSpectrogramCanvas &&
        (infiniteCanvasContext.startSample !== startSample ||
         infiniteCanvasContext.endSample !== endSample ||
         infiniteCanvasContext.frequencyScale !== State.frequencyScale);
    
    if (needsRerender) {
        console.log('🔄 Context changed - clearing old self and re-rendering');
        console.log(`   Old: ${infiniteCanvasContext.startSample}-${infiniteCanvasContext.endSample}, scale=${infiniteCanvasContext.frequencyScale}`);
        console.log(`   New: ${startSample}-${endSample}, scale=${State.frequencyScale}`);
        clearInfiniteCanvas();
    }
    
    try {
        const startTime = performance.now();
        const regionSamples = State.completeSamplesArray.slice(startSample, endSample);
        const totalSamples = regionSamples.length;
        const duration = endSeconds - startSeconds;
        
        console.log(`📊 Region: ${totalSamples.toLocaleString()} samples (${duration.toFixed(2)}s)`);
        console.log(`🎯 ZOOM RESOLUTION: ${(width / duration).toFixed(1)} pixels/second (vs ${(width / State.totalAudioDuration).toFixed(1)} for full view)`);
        
        // FFT parameters
        const fftSize = 2048;
        const frequencyBinCount = fftSize / 2;
        
        // Higher resolution for zoomed view!
        const maxTimeSlices = width; // One FFT per pixel
        const hopSize = Math.floor((totalSamples - fftSize) / maxTimeSlices);
        const numTimeSlices = Math.min(maxTimeSlices, Math.floor((totalSamples - fftSize) / hopSize));
        
        console.log(`🔧 FFT size: ${fftSize}, Hop size: ${hopSize.toLocaleString()}, Time slices: ${numTimeSlices.toLocaleString()}`);
        
        // 🔥 FIX: Note - regionSamples is a slice that shares the ArrayBuffer with completeSamplesArray
        // This is fine as long as we don't retain regionSamples after this function completes
        // The slice will be GC'd when the function returns, allowing the buffer to be reclaimed
        
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
        
        // Helper function to calculate y position based on frequency scale
        // 🔥 RENDER AT NEUTRAL (1x) - NO playback rate scaling during rendering!
        // CRITICAL: Convert bin indices to actual frequencies to match tick positioning!
        const getYPosition = (binIndex, totalBins, canvasHeight) => {
            // Get original sample rate from metadata (matches spectrogram-axis-renderer.js)
            const originalSampleRate = State.currentMetadata?.original_sample_rate || 100;
            const originalNyquist = originalSampleRate / 2;
            
            // Convert bin index to actual frequency in Hz
            // Bin 0 = 0 Hz, Bin (totalBins-1) = Nyquist
            const frequency = (binIndex / totalBins) * originalNyquist;
            
            if (State.frequencyScale === 'logarithmic') {
                // Logarithmic scale: use same frequency range as tick positioning!
                const minFreq = 0.1; // Match tick positioning (avoid log(0))
                const freqSafe = Math.max(frequency, minFreq);
                const logMin = Math.log10(minFreq);
                const logMax = Math.log10(originalNyquist);
                const logFreq = Math.log10(freqSafe);
                const normalizedLog = (logFreq - logMin) / (logMax - logMin);
                
                return canvasHeight - (normalizedLog * canvasHeight);
            } else if (State.frequencyScale === 'sqrt') {
                // Square root scale: normalize by Nyquist, then apply sqrt
                const normalized = frequency / originalNyquist;
                const sqrtNormalized = Math.sqrt(normalized);
                return canvasHeight - (sqrtNormalized * canvasHeight);
            } else {
                // Linear scale: normalize by Nyquist
                const normalized = frequency / originalNyquist;
                return canvasHeight - (normalized * canvasHeight);
            }
        };
        
        // Create ImageData for direct pixel manipulation
        const imageData = ctx.createImageData(width, height);
        const pixels = imageData.data;
        
        // Pre-compute color LUT
        const colorLUT = new Uint8ClampedArray(256 * 3);
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
            console.log(`⏳ Region spectrogram: ${progress}% (worker ${workerIndex})`);
        };
        
        // Process with worker pool
        await workerPool.processBatches(
            regionSamples, // Use region data only!
            batches,
            fftSize,
            hopSize,
            window,
            drawResults
        );
        
        // Write ImageData to temp canvas (neutral render at 1x)
        console.log(`🎨 Writing ImageData to neutral render canvas...`);
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = width;
        tempCanvas.height = height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.putImageData(imageData, 0, 0);
        
        // 🏛️ Create/reuse infinite canvas (same as full view!)
        const infiniteHeight = Math.floor(height * MAX_PLAYBACK_RATE);
        infiniteSpectrogramCanvas = document.createElement('canvas');
        infiniteSpectrogramCanvas.width = width;
        infiniteSpectrogramCanvas.height = infiniteHeight;
        const infiniteCtx = infiniteSpectrogramCanvas.getContext('2d');
        
        // Fill infinite canvas with black (silence color)
        infiniteCtx.fillStyle = '#000';
        infiniteCtx.fillRect(0, 0, width, infiniteHeight);
        
        // Place neutral render at BOTTOM of infinite canvas
        infiniteCtx.drawImage(tempCanvas, 0, infiniteHeight - height);
        
        console.log(`🌊 Temple infinite canvas: ${width} × ${infiniteHeight}px`);
        console.log(`   Placed neutral ${width} × ${height}px render at bottom`);
        
        // 🏛️ Record the context of this render
        infiniteCanvasContext = {
            startSample: startSample,
            endSample: endSample,
            frequencyScale: State.frequencyScale
        };
        console.log(`🏛️ New temple self created: Region (${startSample.toLocaleString()}-${endSample.toLocaleString()}), scale=${State.frequencyScale}`);
        
        // Cache for playhead redrawing (use temp canvas)
        cachedSpectrogramCanvas = tempCanvas;
        
        const elapsed = performance.now() - startTime;
        console.log(`✅ Region spectrogram rendered in ${elapsed.toFixed(0)}ms`);
        
        // Log memory after region rendering
        logMemory('After region FFT');
        
        // Update frequency axis
        positionAxisCanvas();
        initializeAxisPlaybackRate();
        drawFrequencyAxis();
        
        // 🏛️ Update viewport with current playback rate (GPU stretch!)
        const playbackRate = State.currentPlaybackRate || 1.0;
        console.log(`🏛️ Calling updateSpectrogramViewport with playbackRate=${playbackRate}, infiniteCanvas exists=${!!infiniteSpectrogramCanvas}`);
        updateSpectrogramViewport(playbackRate);
        console.log(`🏛️ Viewport update complete`);
        
    } catch (error) {
        console.error('❌ Error rendering region spectrogram:', error);
    }
}

/**
 * Initialize complete spectrogram visualization
 * Called once after all audio data is loaded
 */
export async function startCompleteVisualization() {
    // Wait a bit to ensure all data is truly ready
    await new Promise(resolve => setTimeout(resolve, 100));
    
    if (!State.completeSamplesArray || State.completeSamplesArray.length === 0) {
        console.log('⚠️ Cannot start complete visualization - no audio data');
        return;
    }
    
    console.log('🎬 Starting complete spectrogram visualization');
    
    // Render the complete spectrogram
    await renderCompleteSpectrogram();
}
