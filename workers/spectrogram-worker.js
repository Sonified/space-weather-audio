/**
 * spectrogram-worker.js
 * Web Worker for computing FFT in background thread
 * This keeps the main thread free for smooth UI updates
 */

// Cached twiddle factors for FFT
let twiddleCache = null;
let twiddleCacheSize = 0;

/**
 * Pre-compute twiddle factors for all FFT stages
 */
function precomputeTwiddleFactors(N) {
    if (twiddleCache && twiddleCacheSize === N) {
        return; // Already computed
    }
    
    twiddleCacheSize = N;
    twiddleCache = {};
    
    for (let size = 2; size <= N; size *= 2) {
        const halfSize = size / 2;
        const angleStep = -2 * Math.PI / size;
        twiddleCache[size] = new Float32Array(size);
        
        for (let k = 0; k < halfSize; k++) {
            const angle = angleStep * k;
            twiddleCache[size][k * 2] = Math.cos(angle);
            twiddleCache[size][k * 2 + 1] = Math.sin(angle);
        }
    }
}

/**
 * Cooley-Tukey FFT with cached twiddle factors
 */
function fftInPlace(complex) {
    const N = complex.length / 2;
    
    // Bit-reversal permutation
    let j = 0;
    for (let i = 0; i < N; i++) {
        if (j > i) {
            let temp = complex[i * 2];
            complex[i * 2] = complex[j * 2];
            complex[j * 2] = temp;
            
            temp = complex[i * 2 + 1];
            complex[i * 2 + 1] = complex[j * 2 + 1];
            complex[j * 2 + 1] = temp;
        }
        
        let k = N / 2;
        while (k <= j) {
            j -= k;
            k /= 2;
        }
        j += k;
    }
    
    // Cooley-Tukey decimation-in-time
    for (let size = 2; size <= N; size *= 2) {
        const halfSize = size / 2;
        const twiddles = twiddleCache[size];
        
        for (let i = 0; i < N; i += size) {
            for (let k = 0; k < halfSize; k++) {
                const twiddleReal = twiddles[k * 2];
                const twiddleImag = twiddles[k * 2 + 1];
                
                const evenIdx = (i + k) * 2;
                const oddIdx = (i + k + halfSize) * 2;
                
                const evenReal = complex[evenIdx];
                const evenImag = complex[evenIdx + 1];
                const oddReal = complex[oddIdx];
                const oddImag = complex[oddIdx + 1];
                
                const tReal = oddReal * twiddleReal - oddImag * twiddleImag;
                const tImag = oddReal * twiddleImag + oddImag * twiddleReal;
                
                complex[evenIdx] = evenReal + tReal;
                complex[evenIdx + 1] = evenImag + tImag;
                complex[oddIdx] = evenReal - tReal;
                complex[oddIdx + 1] = evenImag - tImag;
            }
        }
    }
}

/**
 * Perform FFT on real-valued signal
 */
function performFFT(signal) {
    const N = signal.length;
    const halfN = N / 2;
    
    // Convert to complex
    const complex = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
        complex[i * 2] = signal[i];
        complex[i * 2 + 1] = 0;
    }
    
    fftInPlace(complex);
    
    // Extract magnitudes
    const magnitudes = new Float32Array(halfN);
    for (let k = 0; k < halfN; k++) {
        const real = complex[k * 2];
        const imag = complex[k * 2 + 1];
        magnitudes[k] = Math.sqrt(real * real + imag * imag) / N;
    }
    
    return magnitudes;
}

// Handle messages from main thread
self.onmessage = function(e) {
    const { type } = e.data;
    
    if (type === 'compute-batch') {
        const { audioData, batchStart, batchEnd, fftSize, hopSize, window } = e.data;
        
        // Pre-compute twiddle factors once
        if (!twiddleCache || twiddleCacheSize !== fftSize) {
            precomputeTwiddleFactors(fftSize);
        }
        
        const frequencyBinCount = fftSize / 2;
        const segment = new Float32Array(fftSize);
        const results = [];
        
        // Process this batch
        // Note: audioData is now a slice, so we work with relative indices
        for (let sliceIdx = batchStart; sliceIdx < batchEnd; sliceIdx++) {
            // Calculate relative position within this slice
            const relativeIdx = (sliceIdx - batchStart) * hopSize;
            
            // Extract windowed segment
            for (let i = 0; i < fftSize; i++) {
                segment[i] = audioData[relativeIdx + i] * window[i];
            }
            
            // Perform FFT
            const magnitudes = performFFT(segment);
            
            // Store results
            results.push({
                sliceIdx: sliceIdx,
                magnitudes: magnitudes
            });
        }
        
        // Clear reusable buffer
        segment.fill(0);
        
        // Calculate batch memory for monitoring
        const batchMemory = (results.length * results[0].magnitudes.length * 4 / 1024).toFixed(1);
        
        // Transfer magnitude buffers back to main thread (zero-copy!)
        const transferList = results.map(r => r.magnitudes.buffer);
        
        // Send results back to main thread with transferable objects
        self.postMessage({
            type: 'batch-complete',
            batchStart: batchStart,
            batchEnd: batchEnd,
            results: results,
            batchMemoryKB: batchMemory
        }, transferList); // Transfer all magnitude buffers back
    }
};

    if (type === 'compute-batch-uint8') {
        const { audioData, batchStart, batchEnd, fftSize, hopSize, window, dbFloor = -100, dbRange = 100 } = e.data;
        
        // Pre-compute twiddle factors once
        if (!twiddleCache || twiddleCacheSize !== fftSize) {
            precomputeTwiddleFactors(fftSize);
        }
        
        const frequencyBinCount = fftSize / 2;
        const segment = new Float32Array(fftSize);
        const results = [];
        
        for (let sliceIdx = batchStart; sliceIdx < batchEnd; sliceIdx++) {
            const relativeIdx = (sliceIdx - batchStart) * hopSize;
            
            for (let i = 0; i < fftSize; i++) {
                segment[i] = audioData[relativeIdx + i] * window[i];
            }
            
            const magnitudes = performFFT(segment);
            
            // Convert to Uint8 normalized dB
            const uint8Magnitudes = new Uint8Array(frequencyBinCount);
            for (let k = 0; k < frequencyBinCount; k++) {
                const db = 20 * Math.log10(magnitudes[k] + 1e-10);
                const normalized = Math.max(0, Math.min(1, (db - dbFloor) / dbRange));
                uint8Magnitudes[k] = Math.round(normalized * 255);
            }
            
            results.push({
                sliceIdx: sliceIdx,
                magnitudes: uint8Magnitudes
            });
        }
        
        segment.fill(0);
        
        const batchMemory = (results.length * frequencyBinCount / 1024).toFixed(1);
        const transferList = results.map(r => r.magnitudes.buffer);
        
        self.postMessage({
            type: 'batch-uint8-complete',
            batchStart: batchStart,
            batchEnd: batchEnd,
            results: results,
            batchMemoryKB: batchMemory
        }, transferList);
    }
};

// Signal that worker is ready
self.postMessage({ type: 'ready' });
