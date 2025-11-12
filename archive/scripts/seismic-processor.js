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
        
        // Fade in/out
        this.fadeDurationSamples = Math.ceil(44100 * 0.05); // 50ms fade = 2205 samples at 44.1kHz
        this.samplesRendered = 0; // Track total samples rendered (for fade-in)
        this.isFadingOut = false; // Track if we're in fade-out mode
        this.pauseFadeOut = false; // Track if we're fading out for pause
        this.pauseFadeProgress = 0; // Track progress of pause fade-out
        
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
            } else if (type === 'pause-fade') {
                // Trigger fade-out for pause
                console.log('⏸️ Worklet: Starting 50ms fade-out for pause');
                this.pauseFadeOut = true;
                this.pauseFadeProgress = 0;
            } else if (type === 'pause') {
                // Immediate pause (no fade) - only used internally after fade completes
                this.isPlaying = false;
            } else if (type === 'resume') {
                // Resume playback with fade-in
                console.log('▶️ Worklet: Resuming with 50ms fade-in');
                this.isPlaying = true;
                this.pauseFadeOut = false;
                this.pauseFadeProgress = 0;
                this.samplesRendered = 0; // Reset to trigger fade-in
            } else if (type === 'reset') {
                // Reset all buffer state for new stream
                console.log('🔄 WORKLET RESET: Clearing all buffers for new stream');
                this.buffer.fill(0);
                this.readIndex = 0;
                this.writeIndex = 0;
                this.samplesInBuffer = 0;
                this.hasStarted = false;
                this.readIndexLocked = false;
                this.underruns = 0;
                this.metricsCounter = 0;
                this.samplesRendered = 0;
                this.isFadingOut = false;
                this.pauseFadeOut = false;
                this.pauseFadeProgress = 0;
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
        
        // ✨ FADE IN/OUT PROCESSING
        // Check if we should start fade-out (speed-aware)
        // Remaining time = samplesInBuffer / (sampleRate * speed)
        const remainingTimeSec = this.samplesInBuffer / (44100 * this.speed);
        const fadeOutThreshold = 0.05; // 50ms
        
        if (!this.isFadingOut && remainingTimeSec < fadeOutThreshold) {
            this.isFadingOut = true;
            console.log('🌅 Starting fade-out (' + (remainingTimeSec * 1000).toFixed(1) + 'ms remaining at ' + this.speed + 'x speed)');
        }
        
        // Apply fade-in or fade-out to each sample
        for (let j = 0; j < channel.length; j++) {
            let gain = 1.0;
            
            // Pause fade-out: Takes priority over everything else
            if (this.pauseFadeOut) {
                const fadeOutProgress = this.pauseFadeProgress / this.fadeDurationSamples;
                // Cosine fade: smooth S-curve from 1 to 0
                gain = 1 - ((1 - Math.cos(fadeOutProgress * Math.PI)) / 2);
                this.pauseFadeProgress++;
                
                // When fade complete, pause playback and notify main thread
                if (this.pauseFadeProgress >= this.fadeDurationSamples) {
                    this.pauseFadeOut = false;
                    this.pauseFadeProgress = 0;
                    this.isPlaying = false;
                    this.port.postMessage({ type: 'pause-fade-complete' });
                    console.log('⏸️ Worklet: Pause fade-out complete, playback stopped');
                }
            } else {
                // Normal fade-in: First 50ms (2205 samples) of playback
                if (this.samplesRendered < this.fadeDurationSamples) {
                    const fadeInProgress = this.samplesRendered / this.fadeDurationSamples;
                    // Cosine fade: smooth S-curve from 0 to 1
                    gain = (1 - Math.cos(fadeInProgress * Math.PI)) / 2;
                }
                
                // Fade-out: Last 50ms based on remaining buffer
                if (this.isFadingOut) {
                    // Calculate how far through the fade-out we are
                    // When samplesInBuffer is high, fadeOutProgress is 0 (full volume)
                    // When samplesInBuffer approaches 0, fadeOutProgress approaches 1 (silence)
                    const fadeOutSamples = this.fadeDurationSamples * this.speed; // Adjust for playback speed
                    const fadeOutProgress = 1 - (this.samplesInBuffer / fadeOutSamples);
                    const fadeOutGain = 1 - ((1 - Math.cos(fadeOutProgress * Math.PI)) / 2);
                    
                    // Use the quieter of fade-in or fade-out
                    gain = Math.min(gain, fadeOutGain);
                }
                
                this.samplesRendered++;
            }
            
            // Apply gain
            channel[j] *= gain;
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
