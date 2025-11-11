/**
 * Waveform Worker - Efficiently builds waveform display data
 * 
 * Key optimizations:
 * 1. Only calculates min/max for each pixel column (no wasted computation)
 * 2. Runs off main thread (doesn't block UI)
 * 3. Progressive rendering (can render partial waveforms as chunks arrive)
 * 4. Memory efficient (doesn't store full waveform, just pixel data)
 */

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
        
        console.log(`🎨 Waveform worker: Added ${samples.length.toLocaleString()} samples (total: ${allSamples.length.toLocaleString()})`);
        
    } else if (type === 'build-waveform') {
        // Build optimized waveform for display
        const { canvasWidth, canvasHeight, removeDC, alpha, isComplete, totalExpectedSamples } = e.data;
        
        const t0 = performance.now();
        console.log(`🎨 Building waveform: ${canvasWidth}px wide, ${allSamples.length.toLocaleString()} samples, removeDC=${removeDC}, alpha=${alpha}`);
        
        // Determine which samples to use
        let displaySamples = allSamples;
        
        // Apply drift removal if requested (for final complete waveform)
        if (removeDC && rawSamples.length > 0) {
            console.log(`  🎛️ Applying drift removal (alpha=${alpha.toFixed(4)})...`);
            const filtered = removeDCOffset(rawSamples, alpha);
            displaySamples = normalize(filtered);
            console.log(`  ✅ Drift removal complete`);
        }
        
        // Build min/max arrays for efficient rendering
        // For progressive rendering: only fill the LEFT portion based on samples received so far
        const effectiveWidth = totalExpectedSamples 
            ? Math.floor((displaySamples.length / totalExpectedSamples) * canvasWidth)
            : canvasWidth;
        
        const waveformData = buildMinMaxWaveform(displaySamples, effectiveWidth);
        
        const elapsed = performance.now() - t0;
        console.log(`✅ Waveform built in ${elapsed.toFixed(0)}ms (${effectiveWidth} pixels from ${allSamples.length.toLocaleString()} samples)`);
        
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

