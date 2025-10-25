// AudioWorklet processor for seismic data streaming
// Runs in the audio rendering thread (high priority, separate from main thread)

class SeismicProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        
        // Use Float32Array for efficient circular buffer
        this.maxBufferSize = 44100 * 60; // 60 seconds max buffer (enough for most files, not too wasteful)
        this.buffer = new Float32Array(this.maxBufferSize);
        this.buffer.fill(0); // CRITICAL: Initialize to silence, not random memory
        this.writeIndex = 0;
        this.readIndex = 0;
        this.samplesInBuffer = 0;
        
        // Playback control
        this.speed = 1.0;
        this.isPlaying = false; // Start paused until we have data
        this.minBufferBeforePlay = 44100 * 1; // Wait for 1 second of audio in worklet (main thread pre-loads more)
        this.hasStarted = false;
        this.readIndexLocked = false; // 🔧 FIX: Track if readIndex has been set and should not be recalculated
        
        // Metrics
        this.underruns = 0; // Count of times buffer ran empty
        this.metricsCounter = 0;
        
        // Listen for messages from main thread
        this.port.onmessage = (event) => {
            const { type, data, speed, rate } = event.data;
            
            if (type === 'audio-data') {
                // Receive audio chunk from main thread
                this.addSamples(data);
            } else if (type === 'set-speed') {
                this.speed = speed;
            } else if (type === 'set-playback-rate') {
                this.speed = rate;
                console.log(`🎚️ Worklet playback rate: ${rate}x`);
            } else if (type === 'pause') {
                this.isPlaying = false;
            } else if (type === 'resume') {
                this.isPlaying = true;
            }
        };
    }
    
    addSamples(samples) {
        // Add samples to circular buffer
        for (let i = 0; i < samples.length; i++) {
            if (this.samplesInBuffer < this.maxBufferSize) {
                this.buffer[this.writeIndex] = samples[i];
                this.writeIndex = (this.writeIndex + 1) % this.maxBufferSize;
                this.samplesInBuffer++;
            } else {
                // Buffer full - overwrite oldest sample
                this.buffer[this.writeIndex] = samples[i];
                this.writeIndex = (this.writeIndex + 1) % this.maxBufferSize;
                
                // 🔧 FIX: Only advance readIndex if it's NOT locked
                // This prevents readIndex drift when buffer overflows before playback starts
                if (!this.readIndexLocked) {
                    this.readIndex = (this.readIndex + 1) % this.maxBufferSize;
                }
            }
        }
        
        // Auto-start playback once we have enough buffer
        // 🔧 FIX: Lock readIndex at start position - never recalculate!
        if (!this.hasStarted && this.samplesInBuffer >= this.minBufferBeforePlay) {
            // Calculate where to start reading from and lock it
            this.readIndex = (this.writeIndex - this.samplesInBuffer + this.maxBufferSize) % this.maxBufferSize;
            this.readIndexLocked = true;
            
            this.isPlaying = true;
            this.hasStarted = true;
            this.port.postMessage({ type: 'started' });
        }
    }
    
    process(inputs, outputs, parameters) {
        const output = outputs[0];
        const channel = output[0];
        
        if (!this.isPlaying) {
            // Output silence when paused
            channel.fill(0);
            return true;
        }
        
        // Calculate how many samples to read based on playback speed
        const samplesToRead = Math.ceil(channel.length * this.speed);
        
        // Fill output buffer - output what we have, pad with zeros if underrun
        let min = Infinity, max = -Infinity;
        let i = 0;
        
        if (this.samplesInBuffer < samplesToRead) {
            // Underrun: output available samples, then silence
            console.warn(`⚠️ UNDERRUN: only ${this.samplesInBuffer} samples, need ${samplesToRead}. Padding with zeros.`);
            
            // Output what we have with simple downsampling/upsampling
            const availableForOutput = Math.min(this.samplesInBuffer, channel.length);
            for (i = 0; i < availableForOutput; i++) {
                const sample = this.buffer[this.readIndex];
                channel[i] = sample;
                if (sample < min) min = sample;
                if (sample > max) max = sample;
                this.readIndex = (this.readIndex + 1) % this.maxBufferSize;
                this.samplesInBuffer--;
            }
            
            // Fill remainder with silence (prevents hissy on/off edges)
            for (; i < channel.length; i++) {
                channel[i] = 0;
            }
            
            this.underruns++;
            this.port.postMessage({ type: 'underrun', samplesInBuffer: this.samplesInBuffer });
            
            // ✅ STOP PLAYBACK when buffer is empty after stream complete
            if (this.samplesInBuffer === 0) {
                console.log(`🏁 Buffer empty - stopping playback`);
                this.isPlaying = false;
                this.port.postMessage({ type: 'finished' });
                return false; // Stop processor
            }
        } else {
            // Normal case: plenty of samples available
            // Simple playback rate by reading more/fewer samples
            if (this.speed === 1.0) {
                // Normal speed - just copy
                for (i = 0; i < channel.length; i++) {
                    const sample = this.buffer[this.readIndex];
                    channel[i] = sample;
                    if (sample < min) min = sample;
                    if (sample > max) max = sample;
                    this.readIndex = (this.readIndex + 1) % this.maxBufferSize;
                    this.samplesInBuffer--;
                }
            } else {
                // Variable speed - linear interpolation
                let sourcePos = 0;
                for (i = 0; i < channel.length; i++) {
                    const readPos = Math.floor(sourcePos);
                    if (readPos < samplesToRead - 1) {
                        // Linear interpolation between samples
                        const frac = sourcePos - readPos;
                        const idx1 = (this.readIndex + readPos) % this.maxBufferSize;
                        const idx2 = (this.readIndex + readPos + 1) % this.maxBufferSize;
                        const sample = this.buffer[idx1] * (1 - frac) + this.buffer[idx2] * frac;
                        channel[i] = sample;
                        if (sample < min) min = sample;
                        if (sample > max) max = sample;
                    } else {
                        channel[i] = this.buffer[(this.readIndex + readPos) % this.maxBufferSize];
                    }
                    sourcePos += this.speed;
                }
                // Advance read pointer by samples consumed
                this.readIndex = (this.readIndex + samplesToRead) % this.maxBufferSize;
                this.samplesInBuffer -= samplesToRead;
            }
        }
        
        // Log output range periodically
        const range = max - min;
        if (this.metricsCounter % 4410 === 0) { // Log every ~100ms
            console.log(`🎵 Output range: [${min.toFixed(3)}, ${max.toFixed(3)}], buffer=${this.samplesInBuffer} samples`);
        }
        
        // Send metrics to main thread periodically (every ~100ms at 44.1kHz)
        this.metricsCounter++;
        if (this.metricsCounter >= 4410) {
            this.port.postMessage({
                type: 'metrics',
                bufferSize: this.samplesInBuffer,
                underruns: this.underruns
            });
            this.metricsCounter = 0;
        }
        
        // Keep processor alive
        return true;
    }
}

// Register the processor
registerProcessor('seismic-processor', SeismicProcessor);
