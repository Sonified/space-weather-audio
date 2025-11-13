// Simplified waveform worker for testing
// Just builds min/max visualization from complete sample array

let allSamples = null;

self.addEventListener('message', (e) => {
    const { type } = e.data;
    
    if (type === 'set-samples') {
        allSamples = e.data.samples;
        console.log(`🎨 Waveform worker received ${allSamples.length.toLocaleString()} samples`);
        
    } else if (type === 'build-waveform') {
        if (!allSamples) {
            console.error('No samples loaded!');
            return;
        }
        
        const { canvasWidth, canvasHeight } = e.data;
        const t0 = performance.now();
        
        // Build min/max for each pixel column
        const samplesPerPixel = Math.floor(allSamples.length / canvasWidth);
        const mins = new Float32Array(canvasWidth);
        const maxs = new Float32Array(canvasWidth);
        
        for (let x = 0; x < canvasWidth; x++) {
            const startSample = x * samplesPerPixel;
            const endSample = Math.min(startSample + samplesPerPixel, allSamples.length);
            
            let min = Infinity;
            let max = -Infinity;
            
            for (let i = startSample; i < endSample; i++) {
                const sample = allSamples[i];
                if (sample < min) min = sample;
                if (sample > max) max = sample;
            }
            
            mins[x] = min === Infinity ? 0 : min;
            maxs[x] = max === -Infinity ? 0 : max;
        }
        
        const elapsed = performance.now() - t0;
        console.log(`✅ Waveform built in ${elapsed.toFixed(0)}ms (${canvasWidth} pixels)`);
        
        self.postMessage({
            type: 'waveform-ready',
            waveformData: { mins, maxs },
            totalSamples: allSamples.length
        }, [mins.buffer, maxs.buffer]);
    }
});

console.log('🎨 Test waveform worker initialized');


