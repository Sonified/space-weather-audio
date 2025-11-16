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

self.addEventListener('message', (e) => {
    const { type } = e.data;
    
    if (type === 'add-samples') {
        // Add new samples to our buffer
        const { samples, rawSamples: raw } = e.data;
        
        // Append to existing arrays
        const newAllSamples = new Float32Array(allSamples.length + samples.length);
        newAllSamples.set(allSamples);
        newAllSamples.set(samples, allSamples.length);
        allSamples = newAllSamples;
        
        const newRawSamples = new Float32Array(rawSamples.length + raw.length);
        newRawSamples.set(rawSamples);
        newRawSamples.set(raw, rawSamples.length);
        rawSamples = newRawSamples;
        
        if (DEBUG_WAVEFORM) console.log(`🎨 Waveform worker: Added ${samples.length.toLocaleString()} samples (total: ${allSamples.length.toLocaleString()})`);
        
    } else if (type === 'build-waveform') {
        // Build optimized waveform for display
        const { canvasWidth, canvasHeight, removeDC, alpha, isComplete, totalExpectedSamples, startSample, endSample } = e.data;
        
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
        
        // Apply drift removal if requested (for final complete waveform)
        if (removeDC && rawSamples.length > 0) {
            console.log(`  🎛️ Applying drift removal (alpha=${alpha.toFixed(4)})...`);
            // 🏛️ Use same zoom range for raw samples if zoomed
            let rawSamplesToProcess = rawSamples;
            if (startSample !== undefined && endSample !== undefined && startSample >= 0 && endSample <= rawSamples.length) {
                rawSamplesToProcess = rawSamples.slice(startSample, endSample);
            }
            const filtered = removeDCOffset(rawSamplesToProcess, alpha);
            displaySamples = normalize(filtered);
            console.log(`  ✅ Drift removal complete`);
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
        if (DEBUG_WAVEFORM) console.log(`✅ Waveform built in ${elapsed.toFixed(0)}ms (${effectiveWidth} pixels from ${allSamples.length.toLocaleString()} samples)`);
        
        // Send back to main thread
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

