// audio-processor-worker.js
importScripts('https://cdn.jsdelivr.net/npm/fzstd@0.1.1/umd/index.min.js');

// Debug flag for chunk processing logs (set to true to enable detailed logging)
const DEBUG_CHUNKS = false;

console.log('🏭 Audio Processor Worker initialized');

// Signal we're ready to receive messages
self.postMessage('ready');

self.onmessage = async (e) => {
    const { type, compressed, normMin, normMax, chunkIndex, isMissing, expectedSamples } = e.data;
    
    if (type === 'process-chunk') {
        const t0 = performance.now();
        
        // 🆕 Handle missing chunks - generate zeros instead of decompressing
        if (isMissing) {
            // Create arrays of zeros (Float32Array initializes to 0)
            const normalized = new Float32Array(expectedSamples);  // Already all zeros
            const int32Samples = new Int32Array(expectedSamples);  // Already all zeros
            
            const totalTime = performance.now() - t0;
            
            if (DEBUG_CHUNKS) console.log(`🏭 Worker generated silence for chunk ${chunkIndex}: ${expectedSamples.toLocaleString()} samples in ${totalTime.toFixed(0)}ms`);
            
            // Send back (no transfer needed, but include for consistency)
            self.postMessage({ 
                type: 'chunk-ready',
                chunkIndex,
                samples: normalized,
                rawSamples: int32Samples,
                sampleCount: normalized.length
            }, [normalized.buffer, int32Samples.buffer]);
            
            return;
        }
        
        // Normal processing for existing chunks
        // 1. Decompress (off main thread!)
        const decompressed = fzstd.decompress(new Uint8Array(compressed));
        const int32Samples = new Int32Array(
            decompressed.buffer, 
            decompressed.byteOffset, 
            decompressed.byteLength / 4
        );
        
        const decompressTime = performance.now() - t0;
        
        // 2. Normalize (off main thread!)
        const range = normMax - normMin;
        const normalized = new Float32Array(int32Samples.length);
        for (let i = 0; i < int32Samples.length; i++) {
            normalized[i] = 2 * (int32Samples[i] - normMin) / range - 1;
        }
        
        const totalTime = performance.now() - t0;
        
        if (DEBUG_CHUNKS) console.log(`🏭 Worker processed chunk ${chunkIndex}: ${int32Samples.length.toLocaleString()} samples in ${totalTime.toFixed(0)}ms (decompress: ${decompressTime.toFixed(0)}ms)`);
        
        // 3. Send back with ZERO-COPY transfer!
        self.postMessage({ 
            type: 'chunk-ready',
            chunkIndex,
            samples: normalized,
            rawSamples: int32Samples, // For waveform building later
            sampleCount: normalized.length
        }, [normalized.buffer, int32Samples.buffer]); // Transfer ownership!
    }
};

