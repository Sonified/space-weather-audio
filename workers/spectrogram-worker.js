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

// ─── Magnitude → Uint8 lookup table (IEEE 754 bit trick) ────────────────────
// Uses top 16 bits of float32 as index (sign + exponent + 7 mantissa bits).
// This gives log-spaced coverage naturally — ~128 levels per octave.
// Eliminates Math.log10, Math.max, Math.min, Math.round from the hot loop.
const MAG_TO_UINT8 = new Uint8Array(65536);
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
let _lutDbFloor = NaN;
let _lutDbRange = NaN;

function buildMagLUT(dbFloor, dbRange) {
    if (dbFloor === _lutDbFloor && dbRange === _lutDbRange) return;
    _lutDbFloor = dbFloor;
    _lutDbRange = dbRange;

    for (let i = 0; i < 65536; i++) {
        // Reconstruct float from top 16 bits
        _u32[0] = i << 16;
        const mag = _f32[0];

        if (mag <= 0 || !isFinite(mag)) {
            MAG_TO_UINT8[i] = 0;
            continue;
        }

        const db = 20 * Math.log10(mag + 1e-10);
        const normalized = (db - dbFloor) / dbRange;
        if (normalized <= 0) { MAG_TO_UINT8[i] = 0; continue; }
        if (normalized >= 1) { MAG_TO_UINT8[i] = 255; continue; }
        MAG_TO_UINT8[i] = (normalized * 255 + 0.5) | 0;
    }
}

// Pre-allocated FFT buffers (reused across calls to avoid GC pressure)
let fftComplexBuf = null;   // Float32Array(N * 2)
let fftMagnitudeBuf = null; // Float32Array(N / 2)
let fftBufSize = 0;

function ensureFFTBuffers(N) {
    if (fftBufSize !== N) {
        fftComplexBuf = new Float32Array(N * 2);
        fftMagnitudeBuf = new Float32Array(N / 2);
        fftBufSize = N;
    }
}

/**
 * Perform FFT on real-valued signal.
 * Uses pre-allocated buffers — caller must copy magnitudes before next call.
 */
function performFFT(signal) {
    const N = signal.length;
    const halfN = N / 2;

    ensureFFTBuffers(N);
    const complex = fftComplexBuf;
    const magnitudes = fftMagnitudeBuf;

    // Convert to complex (zero imaginary parts)
    for (let i = 0; i < N; i++) {
        complex[i * 2] = signal[i];
        complex[i * 2 + 1] = 0;
    }

    fftInPlace(complex);

    // Extract magnitudes into reusable buffer
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
            
            // Perform FFT (returns shared buffer — must copy for batch results)
            const magnitudes = new Float32Array(performFFT(segment));

            // Store results
            results.push({
                sliceIdx: sliceIdx,
                magnitudes: magnitudes
            });
        }
        
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
    
    if (type === 'compute-tile') {
        const { audioData, fftSize, hopSize, numTimeSlices, window: hannWindow, dbFloor = -100, dbRange = 100, tileIndex } = e.data;

        if (!twiddleCache || twiddleCacheSize !== fftSize) {
            precomputeTwiddleFactors(fftSize);
        }

        // Build magnitude → Uint8 lookup table (cached across tiles with same dB params)
        buildMagLUT(dbFloor, dbRange);

        const frequencyBinCount = fftSize / 2;
        const segment = new Float32Array(fftSize);
        const magnitudeData = new Uint8Array(numTimeSlices * frequencyBinCount);

        // Shared view for float→uint32 bit extraction
        const lutF32 = new Float32Array(1);
        const lutU32 = new Uint32Array(lutF32.buffer);

        for (let col = 0; col < numTimeSlices; col++) {
            const offset = col * hopSize;

            // Window the segment
            for (let i = 0; i < fftSize; i++) {
                segment[i] = audioData[offset + i] * hannWindow[i];
            }

            const magnitudes = performFFT(segment);

            // LUT-based magnitude → Uint8 (no log10, no branching)
            for (let bin = 0; bin < frequencyBinCount; bin++) {
                lutF32[0] = magnitudes[bin];
                magnitudeData[bin * numTimeSlices + col] = MAG_TO_UINT8[lutU32[0] >>> 16];
            }
        }

        self.postMessage({
            type: 'tile-complete',
            tileIndex,
            magnitudeData,
            width: numTimeSlices,
            height: frequencyBinCount
        }, [magnitudeData.buffer]);
    }

    if (type === 'compute-batch-uint8') {
        const { audioData, batchStart, batchEnd, fftSize, hopSize, window, dbFloor = -100, dbRange = 100 } = e.data;

        if (!twiddleCache || twiddleCacheSize !== fftSize) {
            precomputeTwiddleFactors(fftSize);
        }

        buildMagLUT(dbFloor, dbRange);

        const frequencyBinCount = fftSize / 2;
        const segment = new Float32Array(fftSize);
        const results = [];
        const lutF32 = new Float32Array(1);
        const lutU32 = new Uint32Array(lutF32.buffer);

        for (let sliceIdx = batchStart; sliceIdx < batchEnd; sliceIdx++) {
            const relativeIdx = (sliceIdx - batchStart) * hopSize;

            for (let i = 0; i < fftSize; i++) {
                segment[i] = audioData[relativeIdx + i] * window[i];
            }

            const magnitudes = performFFT(segment);

            const uint8Magnitudes = new Uint8Array(frequencyBinCount);
            for (let k = 0; k < frequencyBinCount; k++) {
                lutF32[0] = magnitudes[k];
                uint8Magnitudes[k] = MAG_TO_UINT8[lutU32[0] >>> 16];
            }
            
            results.push({
                sliceIdx: sliceIdx,
                magnitudes: uint8Magnitudes
            });
        }

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
