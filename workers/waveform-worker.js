/**
 * Waveform Worker - Efficiently builds waveform display data
 * 
 * Key optimizations:
 * 1. Only calculates min/max for each pixel column (no wasted computation)
 * 2. Runs off main thread (doesn't block UI)
 * 3. Progressive rendering (can render partial waveforms as chunks arrive)
 * 4. Memory efficient (doesn't store full waveform, just pixel data)
 */

// Debug flag for waveform logs (set to true to enable detailed logging)
const DEBUG_WAVEFORM = false;

console.log('🎨 Waveform Worker initialized');

// Store accumulated samples
let allSamples = new Float32Array(0);
let rawSamples = new Float32Array(0);

// 🔥 CACHE: Store drift-removed version to avoid reprocessing
let processedSamples = null;  // Drift-removed and normalized
let processedAlpha = null;    // Track which alpha was used
let processedRemoveDC = null; // Track if DC removal was applied

self.addEventListener('message', (e) => {
    const { type } = e.data;
    
    if (type === 'add-samples') {
        // Add new samples to our buffer
        const { samples, rawSamples: raw } = e.data;
        // console.log(`🔍 [WORKER] Received add-samples: ${samples?.length || 0} samples, type=${samples?.constructor?.name}`);
        
        // 🔥 Clear processed cache when new samples arrive (data changed)
        processedSamples = null;
        processedAlpha = null;
        processedRemoveDC = null;
        
        // Append to existing arrays
        const newAllSamples = new Float32Array(allSamples.length + samples.length);
        newAllSamples.set(allSamples);
        newAllSamples.set(samples, allSamples.length);
        allSamples = newAllSamples;
        
        const newRawSamples = new Float32Array(rawSamples.length + raw.length);
        newRawSamples.set(rawSamples);
        newRawSamples.set(raw, rawSamples.length);
        rawSamples = newRawSamples;
        
        // console.log(`🔍 [WORKER] Samples added: total=${allSamples.length.toLocaleString()}, raw=${rawSamples.length.toLocaleString()}`);
        if (DEBUG_WAVEFORM) console.log(`🎨 Waveform worker: Added ${samples.length.toLocaleString()} samples (total: ${allSamples.length.toLocaleString()})`);
        
    } else if (type === 'build-waveform') {
        // Build optimized waveform for display
        const { canvasWidth, canvasHeight, removeDC, alpha, isComplete, totalExpectedSamples, startSample, endSample } = e.data;
        
        // console.log(`🔍 [WORKER] Received build-waveform: width=${canvasWidth}, height=${canvasHeight}, allSamples.length=${allSamples.length}`);
        
        const t0 = performance.now();
        if (DEBUG_WAVEFORM) console.log(`🎨 Building waveform: ${canvasWidth}px wide, ${allSamples.length.toLocaleString()} samples, removeDC=${removeDC}, alpha=${alpha}`);
        
        // 🏛️ Determine which samples to use (zoom-aware)
        let displaySamples = allSamples;
        let sampleRangeInfo = 'full';
        
        // If zoom range specified, slice to that range
        if (startSample !== undefined && endSample !== undefined && startSample >= 0 && endSample <= allSamples.length) {
            displaySamples = allSamples.slice(startSample, endSample);
            sampleRangeInfo = `zoomed (${startSample.toLocaleString()}-${endSample.toLocaleString()})`;
            if (DEBUG_WAVEFORM) console.log(`🔍 Zoom mode: using ${displaySamples.length.toLocaleString()} samples ${sampleRangeInfo}`);
        }
        
        // 🔥 OPTIMIZATION: Process drift removal ONCE and cache the result
        // Only reprocess if settings changed or cache doesn't exist
        if (removeDC && rawSamples.length > 0) {
            // Check if we need to reprocess (settings changed or no cache)
            const needsReprocess = processedSamples === null || 
                                   processedAlpha !== alpha || 
                                   processedRemoveDC !== removeDC ||
                                   processedSamples.length !== rawSamples.length;
            
            if (needsReprocess) {
                console.log(`  🎛️ Processing drift removal (alpha=${alpha.toFixed(4)})...`);
                // Process FULL dataset (drift removal needs full context)
                const filtered = removeDCOffset(rawSamples, alpha);
                processedSamples = normalize(filtered);
                processedAlpha = alpha;
                processedRemoveDC = removeDC;
                console.log(`  ✅ Drift removal complete (cached)`);
            }
            
            // Use cached processed samples, slice if zoomed
            if (startSample !== undefined && endSample !== undefined && startSample >= 0 && endSample <= processedSamples.length) {
                displaySamples = processedSamples.slice(startSample, endSample);
            } else {
                displaySamples = processedSamples;
            }
        } else {
            // No drift removal - use normalized samples directly
            // Clear cache if DC removal was disabled
            if (processedRemoveDC === true) {
                processedSamples = null;
                processedAlpha = null;
                processedRemoveDC = null;
            }
        }
        
        // Build min/max arrays for efficient rendering
        // 🏛️ When zoomed, we want to fill the FULL canvas with the zoomed samples
        // For progressive rendering (not zoomed): only fill the LEFT portion based on samples received so far
        let effectiveWidth;
        if (startSample !== undefined && endSample !== undefined) {
            // Zoomed: fill full canvas with zoomed samples
            effectiveWidth = canvasWidth;
        } else {
            // Progressive rendering: calculate partial width based on samples received
            effectiveWidth = totalExpectedSamples 
            ? Math.floor((displaySamples.length / totalExpectedSamples) * canvasWidth)
            : canvasWidth;
        }
        
        const waveformData = buildMinMaxWaveform(displaySamples, effectiveWidth);
        
        const elapsed = performance.now() - t0;
        // console.log(`🔍 [WORKER] Waveform built: ${effectiveWidth} pixels from ${allSamples.length.toLocaleString()} samples in ${elapsed.toFixed(0)}ms`);
        if (DEBUG_WAVEFORM) console.log(`✅ Waveform built in ${elapsed.toFixed(0)}ms (${effectiveWidth} pixels from ${allSamples.length.toLocaleString()} samples)`);
        
        // Send back to main thread
        // console.log(`🔍 [WORKER] Sending waveform-ready message back to main thread`);
        self.postMessage({
            type: 'waveform-ready',
            waveformData: waveformData,
            totalSamples: allSamples.length,
            buildTime: elapsed,
            isComplete: isComplete || false  // Flag to indicate if this is the final detrended waveform
        }, [waveformData.mins.buffer, waveformData.maxs.buffer]); // Transfer ownership for zero-copy
        
    } else if (type === 'reset') {
        // Clear all stored samples
        allSamples = new Float32Array(0);
        rawSamples = new Float32Array(0);
        console.log('🎨 Waveform worker: Reset');
        
        self.postMessage({ type: 'reset-complete' });
    }
});

/**
 * Build min/max waveform data for efficient rendering.
 * For each pixel column, calculate the min and max sample values.
 * This allows rendering millions of samples as just a few thousand pixels.
 */
function buildMinMaxWaveform(samples, canvasWidth) {
    const mins = new Float32Array(canvasWidth);
    const maxs = new Float32Array(canvasWidth);
    
    const samplesPerPixel = samples.length / canvasWidth;
    
    for (let pixelX = 0; pixelX < canvasWidth; pixelX++) {
        const startIdx = Math.floor(pixelX * samplesPerPixel);
        const endIdx = Math.floor((pixelX + 1) * samplesPerPixel);
        
        let min = Infinity;
        let max = -Infinity;
        
        // Find min/max in this pixel's sample range
        for (let i = startIdx; i < endIdx && i < samples.length; i++) {
            const value = samples[i];
            if (value < min) min = value;
            if (value > max) max = value;
        }
        
        // Handle edge case where no samples in range
        if (!isFinite(min)) min = 0;
        if (!isFinite(max)) max = 0;
        
        mins[pixelX] = min;
        maxs[pixelX] = max;
    }
    
    return { mins, maxs };
}

/**
 * Remove DC offset and drift using exponential moving average (high-pass DC blocker).
 * This is the same algorithm used in the main thread.
 */
function removeDCOffset(data, alpha = 0.995) {
    let mean = data[0];
    const y = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
        mean = alpha * mean + (1 - alpha) * data[i];
        y[i] = data[i] - mean;
    }
    return y;
}

/**
 * Normalize data to [-1, 1] range.
 */
function normalize(data) {
    // Find min and max
    let min = data[0];
    let max = data[0];
    for (let i = 1; i < data.length; i++) {
        if (data[i] < min) min = data[i];
        if (data[i] > max) max = data[i];
    }
    
    // If all values are the same, return zeros
    if (max === min) {
        return new Float32Array(data.length);
    }
    
    // Scale to [-1, 1] range
    const normalized = new Float32Array(data.length);
    const range = max - min;
    for (let i = 0; i < data.length; i++) {
        // Map [min, max] to [-1, 1]
        normalized[i] = 2 * (data[i] - min) / range - 1;
    }
    
    return normalized;
}

