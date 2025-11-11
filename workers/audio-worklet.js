/**
 * SeismicProcessor - AudioWorklet for real-time seismic audio processing
 * 
 * Features:
 * - Circular buffer with dynamic expansion
 * - Variable-speed playback with interpolation
 * - High-pass filter (9 Hz) to remove DC drift
 * - Anti-aliasing filter for slow playback
 * - Selection looping with crossfade
 * - Sample-accurate seeking
 */

class SeismicProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.initializeBuffer();
        this.initializePlaybackState();
        this.initializeSelectionState();
        this.initializePositionTracking();
        this.initializeFilters();
        this.setupMessageHandler();
    }
    
    // ===== INITIALIZATION MODULES =====
    
    initializeBuffer() {
        this.maxBufferSize = 44100 * 60; // 60 seconds max
        this.buffer = new Float32Array(this.maxBufferSize);
        this.buffer.fill(0);
        this.writeIndex = 0;
        this.readIndex = 0;
        this.samplesInBuffer = 0;
    }
    
    initializePlaybackState() {
        this.isPlaying = false;
        this.hasStarted = false;
        this.minBufferBeforePlay = 0; // YOLO - start immediately!
        this.speed = 1.0;
        this.finishSent = false;
        this.loopWarningShown = false;
        this.dataLoadingComplete = false;
        this.totalSamples = 0;
        this.processStartLogged = false; // For debugging TTFA
    }
    
    initializeSelectionState() {
        this.selectionStart = null; // in seconds
        this.selectionEnd = null; // in seconds
        this.isLooping = false;
        this.selectionEndWarned = false;
    }
    
    initializePositionTracking() {
        this.samplesSinceLastPositionUpdate = 0;
        this.positionUpdateIntervalSamples = 1323; // ~30ms at 44.1kHz
    }
    
    initializeFilters() {
        // High-pass filter state (IIR, 1st order)
        // FIXED at 9 Hz (audio domain) regardless of playback speed!
        // This removes low-frequency drift from seismic data
        this.enableHighPass = true;
        this.highPassCutoff = 9.0; // 9 Hz in audio domain (44.1 kHz)
        this.highPassPrevX = 0;
        this.highPassPrevY = 0;
        this.highPassAlpha = 0;
        this.updateHighPassFilter();
        
        // Anti-aliasing filter state (biquad low-pass)
        this.enableAntiAliasing = true;
        this.filterX1 = 0;
        this.filterX2 = 0;
        this.filterY1 = 0;
        this.filterY2 = 0;
        this.filterB0 = 1;
        this.filterB1 = 0;
        this.filterB2 = 0;
        this.filterA1 = 0;
        this.filterA2 = 0;
        this.currentFilterCutoff = 22050; // Start at Nyquist
    }
    
    // ===== MESSAGE HANDLER MODULE =====
    
    setupMessageHandler() {
        this.port.onmessage = (event) => {
            const { type, data, speed, enabled } = event.data;
            
            if (type === 'audio-data') {
                this.addSamples(data);
            } else if (type === 'pause') {
                this.isPlaying = false;
            } else if (type === 'resume') {
                this.isPlaying = true;
            } else if (type === 'set-speed') {
                this.setSpeed(speed);
            } else if (type === 'set-anti-aliasing') {
                this.setAntiAliasing(enabled);
            } else if (type === 'start-immediately') {
                this.startImmediately();
            } else if (type === 'data-complete') {
                this.markDataComplete(event.data.totalSamples);
            } else if (type === 'reset') {
                this.resetState();
            } else if (type === 'loop') {
                this.loopToStart();
            } else if (type === 'seek') {
                this.seekToPosition(event.data.samplePosition);
            } else if (type === 'set-selection') {
                this.setSelection(event.data.start, event.data.end, event.data.loop);
            }
        };
    }
    
    // ===== PLAYBACK CONTROL METHODS =====
    
    setSpeed(speed) {
        this.speed = speed;
        this.updateAntiAliasingFilter();
    }
    
    setAntiAliasing(enabled) {
        this.enableAntiAliasing = enabled;
        console.log('🎛️ Anti-aliasing filter: ' + (enabled ? 'ON' : 'OFF'));
        if (!enabled) {
            this.resetFilterState();
        }
    }
    
    startImmediately() {
        this.hasStarted = true;
        this.minBuffer = 0;
        console.log('🚀 WORKLET: Forced immediate start! minBuffer=0, hasStarted=true');
    }
    
    markDataComplete(totalSamples) {
        this.dataLoadingComplete = true;
        this.totalSamples = totalSamples || this.samplesInBuffer;
        console.log('🎵 WORKLET: Data complete. Total samples set to ' + this.totalSamples + ' (samplesInBuffer=' + this.samplesInBuffer + ')');
    }
    
    resetState() {
        this.buffer.fill(0);
        this.readIndex = 0;
        this.writeIndex = 0;
        this.samplesInBuffer = 0;
        this.isPlaying = true;
        this.hasStarted = true;
        this.finishSent = false;
        this.loopWarningShown = false;
        this.dataLoadingComplete = false;
        this.totalSamples = 0;
        this.speed = 1.0;
        this.samplesSinceLastPositionUpdate = 0;
        this.selectionStart = null;
        this.selectionEnd = null;
        this.isLooping = false;
        this.selectionEndWarned = false;
    }
    
    loopToStart() {
        const previousReadIndex = this.readIndex;
        const previousSamplesInBuffer = this.samplesInBuffer;
        this.readIndex = 0;
        this.samplesInBuffer = this.totalSamples;
        this.isPlaying = true;
        this.finishSent = false;
        this.loopWarningShown = false;
        console.log('🔄 WORKLET LOOP: ReadIndex ' + previousReadIndex + ' -> 0, SamplesInBuffer ' + previousSamplesInBuffer + ' -> ' + this.totalSamples + ', Speed: ' + this.speed.toFixed(2) + 'x');
    }
    
    seekToPosition(targetSample) {
        // Clamp to selection bounds if selection exists
        if (this.selectionStart !== null && this.selectionEnd !== null) {
            const startSample = Math.floor(this.selectionStart * 44100);
            const endSample = Math.floor(this.selectionEnd * 44100);
            targetSample = Math.max(startSample, Math.min(targetSample, endSample));
        }
        
        if (targetSample >= 0 && targetSample <= this.totalSamples) {
            const previousReadIndex = this.readIndex;
            const previousSamplesInBuffer = this.samplesInBuffer;
            this.readIndex = targetSample;
            this.samplesInBuffer = this.totalSamples - targetSample;
            this.finishSent = false;
            this.loopWarningShown = false;
            this.selectionEndWarned = false;
            this.isPlaying = true;
            console.log('🎯 WORKLET SEEK: ReadIndex ' + previousReadIndex + ' -> ' + this.readIndex + ', SamplesInBuffer ' + previousSamplesInBuffer + ' -> ' + this.samplesInBuffer + ', Target sample: ' + targetSample);
        }
    }
    
    setSelection(start, end, loop) {
        this.selectionStart = start;
        this.selectionEnd = end;
        this.isLooping = loop;
        this.selectionEndWarned = false;
        console.log('🎯 WORKLET SELECTION: Start=' + start + 's, End=' + end + 's, Loop=' + loop);
    }
    
    // ===== FILTER MODULES =====
    
    updateHighPassFilter() {
        // Calculate high-pass filter coefficient
        // This is a 1st-order IIR high-pass filter (same as browser version)
        const sampleRate = 44100; // AudioWorklet sample rate
        const RC = 1.0 / (2 * Math.PI * this.highPassCutoff);
        this.highPassAlpha = RC / (RC + 1 / sampleRate);
        console.log('🎛️ High-pass filter updated: cutoff=' + this.highPassCutoff + 'Hz, alpha=' + this.highPassAlpha.toFixed(6));
    }
    
    updateAntiAliasingFilter() {
        // Calculate cutoff frequency based on playback speed
        // At 1x speed: cutoff = 22050 Hz (no filtering needed, above human hearing)
        // At 0.5x speed: cutoff = 11025 Hz (filter above new Nyquist)
        // At 0.1x speed: cutoff = 2205 Hz (aggressive filtering for slow playback)
        
        const sampleRate = 44100;
        const nyquist = sampleRate / 2;
        
        // CRITICAL FIX: Divide by speed CORRECTLY!
        // When speed < 1.0, we're slowing down, so cutoff should DECREASE
        let cutoff = nyquist * this.speed; // At 0.1x speed: 22050 * 0.1 = 2205 Hz
        
        // Clamp cutoff to reasonable range
        cutoff = Math.max(100, Math.min(cutoff, nyquist * 0.95)); // 100 Hz to 20.9 kHz
        
        // Always update (removed the threshold check for debugging)
        this.currentFilterCutoff = cutoff;
        
        // Calculate biquad coefficients for low-pass filter (Butterworth 2nd order)
        const omega = 2 * Math.PI * cutoff / sampleRate;
        const sinOmega = Math.sin(omega);
        const cosOmega = Math.cos(omega);
        const alpha = sinOmega / (2 * 0.707); // Q = 0.707 (Butterworth)
        
        const b0 = (1 - cosOmega) / 2;
        const b1 = 1 - cosOmega;
        const b2 = (1 - cosOmega) / 2;
        const a0 = 1 + alpha;
        const a1 = -2 * cosOmega;
        const a2 = 1 - alpha;
        
        // Normalize coefficients
        this.filterB0 = b0 / a0;
        this.filterB1 = b1 / a0;
        this.filterB2 = b2 / a0;
        this.filterA1 = a1 / a0;
        this.filterA2 = a2 / a0;
    }
    
    resetFilterState() {
        this.filterX1 = 0;
        this.filterX2 = 0;
        this.filterY1 = 0;
        this.filterY2 = 0;
    }
    
    // ===== BUFFER MANAGEMENT MODULE =====
    
    expandBuffer(neededSize) {
        const newSize = Math.max(neededSize, this.maxBufferSize * 2);
        const newBuffer = new Float32Array(newSize);
        
        // Copy existing data in correct order
        for (let i = 0; i < this.samplesInBuffer; i++) {
            const srcIdx = (this.readIndex + i) % this.maxBufferSize;
            newBuffer[i] = this.buffer[srcIdx];
        }
        
        this.buffer = newBuffer;
        this.maxBufferSize = newSize;
        this.readIndex = 0;
        this.writeIndex = this.samplesInBuffer;
        
        console.log('📏 Expanded buffer to ' + (newSize / 44100 / 60).toFixed(1) + ' minutes');
    }
    
    writeSamples(samples) {
        for (let i = 0; i < samples.length; i++) {
            this.buffer[this.writeIndex] = samples[i];
            this.writeIndex = (this.writeIndex + 1) % this.maxBufferSize;
            this.samplesInBuffer++;
        }
    }
    
    addSamples(samples) {
        const neededSize = this.samplesInBuffer + samples.length;
        if (neededSize > this.maxBufferSize) {
            this.expandBuffer(neededSize);
        }
        
        this.writeSamples(samples);
        
        // Check if we can start playback
        if (!this.hasStarted && this.samplesInBuffer >= this.minBufferBeforePlay) {
            console.log('🎵 WORKLET addSamples: Threshold reached! samplesInBuffer=' + this.samplesInBuffer + ', minBuffer=' + this.minBufferBeforePlay);
            this.readIndex = 0;
            this.isPlaying = true;
            this.hasStarted = true;
            this.port.postMessage({ type: 'started' });
        }
    }
    
    // ===== SELECTION & LOOP MODULE =====
    
    handleSelectionBoundaries() {
        if (this.selectionStart === null || this.selectionEnd === null) {
            return false; // No selection active
        }
        
        const selectionEndSample = Math.floor(this.selectionEnd * 44100);
        const samplesToEnd = selectionEndSample - this.readIndex;
        
        // Warn 20ms before selection end to match fade time
        const WARNING_THRESHOLD = 882; // 20ms at 44.1kHz (matches fade time)
        if (samplesToEnd <= WARNING_THRESHOLD && samplesToEnd > 0 && !this.selectionEndWarned) {
            this.selectionEndWarned = true;
            const secondsToEnd = samplesToEnd / 44100 / this.speed; // Real-time seconds
            const loopDuration = this.selectionEnd - this.selectionStart; // Loop duration in seconds
            this.port.postMessage({
                type: 'selection-end-approaching',
                samplesToEnd: samplesToEnd,
                secondsToEnd: secondsToEnd,
                isLooping: this.isLooping,
                loopDuration: loopDuration
            });
        }
        
        // At selection end, loop or stop
        if (this.readIndex >= selectionEndSample) {
            if (this.isLooping) {
                // Jump to selection start (sample-accurate)
                const selectionStartSample = Math.floor(this.selectionStart * 44100);
                this.readIndex = selectionStartSample;
                this.samplesInBuffer = this.totalSamples - selectionStartSample;
                this.selectionEndWarned = false;
                this.port.postMessage({ 
                    type: 'selection-loop',
                    newPosition: this.selectionStart
                });
            } else {
                // Stop at selection end
                this.isPlaying = false;
                this.port.postMessage({ 
                    type: 'selection-end-reached',
                    position: this.selectionEnd
                });
            }
            return true; // Handled boundary
        }
        
        return false;
    }
    
    handleFullBufferLoop() {
        const loopWarningThreshold = 44100 * 0.020;
        if (this.samplesInBuffer < loopWarningThreshold && !this.loopWarningShown && this.hasStarted) {
            const remainingSeconds = this.samplesInBuffer / 44100;
            this.port.postMessage({ 
                type: 'loop-soon',
                samplesRemaining: this.samplesInBuffer,
                secondsRemaining: remainingSeconds,
                speed: this.speed
            });
            this.loopWarningShown = true;
        }
    }
    
    // ===== POSITION TRACKING MODULE =====
    
    updatePosition(frameSize) {
        this.samplesSinceLastPositionUpdate += frameSize;
        if (this.samplesSinceLastPositionUpdate >= this.positionUpdateIntervalSamples) {
            if (this.hasStarted && this.isPlaying) {
                this.port.postMessage({
                    type: 'position',
                    samplePosition: this.readIndex,
                    positionSeconds: this.readIndex / 44100
                });
            }
            this.samplesSinceLastPositionUpdate = 0;
        }
    }
    
    updateMetrics() {
        if (this.hasStarted && Math.random() < 0.01) {
            const samplesConsumed = this.totalSamples - this.samplesInBuffer;
            this.port.postMessage({
                type: 'metrics',
                bufferSize: this.samplesInBuffer,
                samplesConsumed: samplesConsumed,
                totalSamples: this.totalSamples
            });
        }
    }
    
    // ===== CORE AUDIO PROCESSING (KEPT INLINE FOR PERFORMANCE) =====
    
    process(inputs, outputs, parameters) {
        const output = outputs[0];
        const channel = output[0];
        
        // Log first time process() is called after starting
        if (this.hasStarted && !this.processStartLogged) {
            console.log('🎵 WORKLET process() FIRST CALL after hasStarted=true');
            this.processStartLogged = true;
        }
        
        if (!this.isPlaying) {
            channel.fill(0);
            return true;
        }
        
        const samplesToRead = Math.ceil(channel.length * this.speed);
        
        // Handle selection boundaries and looping (delegated to clean methods)
        if (this.selectionStart !== null && this.selectionEnd !== null) {
            this.handleSelectionBoundaries();
        } else {
            this.handleFullBufferLoop();
        }
        
        // CRITICAL HOT PATH: Buffer reading (kept inline for performance)
        if (this.samplesInBuffer < samplesToRead) {
            // Underrun case
            const availableForOutput = Math.min(this.samplesInBuffer, channel.length);
            for (let i = 0; i < availableForOutput; i++) {
                let sample = this.buffer[this.readIndex];
                
                // Apply high-pass filter if enabled
                if (this.enableHighPass) {
                    const y = this.highPassAlpha * (this.highPassPrevY + sample - this.highPassPrevX);
                    this.highPassPrevX = sample;
                    this.highPassPrevY = y;
                    sample = y;
                }
                
                channel[i] = sample;
                this.readIndex = (this.readIndex + 1) % this.maxBufferSize;
                this.samplesInBuffer--;
            }
            for (let i = availableForOutput; i < channel.length; i++) {
                channel[i] = 0;
            }
            
            // Check if finished
            if (this.samplesInBuffer === 0) {
                if (!this.finishSent && this.hasStarted && this.dataLoadingComplete) {
                    this.isPlaying = false;
                    const expectedDuration = this.totalSamples / (44100 * this.speed);
                    this.port.postMessage({ 
                        type: 'finished',
                        totalSamples: this.totalSamples,
                        speed: this.speed,
                        expectedDurationSeconds: expectedDuration
                    });
                    this.finishSent = true;
                }
                channel.fill(0);
                return true;
            }
        } else {
            // Normal case: enough samples available
            if (this.speed === 1.0) {
                // Fast path: no interpolation needed
                for (let i = 0; i < channel.length; i++) {
                    let sample = this.buffer[this.readIndex];
                    
                    // Apply high-pass filter if enabled
                    if (this.enableHighPass) {
                        const y = this.highPassAlpha * (this.highPassPrevY + sample - this.highPassPrevX);
                        this.highPassPrevX = sample;
                        this.highPassPrevY = y;
                        sample = y;
                    }
                    
                    channel[i] = sample;
                    this.readIndex = (this.readIndex + 1) % this.maxBufferSize;
                    this.samplesInBuffer--;
                }
            } else {
                // Interpolation path for variable speed
                let sourcePos = 0;
                for (let i = 0; i < channel.length; i++) {
                    const readPos = Math.floor(sourcePos);
                    let sample;
                    
                    // Linear interpolation
                    if (readPos < samplesToRead - 1) {
                        const frac = sourcePos - readPos;
                        const idx1 = (this.readIndex + readPos) % this.maxBufferSize;
                        const idx2 = (this.readIndex + readPos + 1) % this.maxBufferSize;
                        sample = this.buffer[idx1] * (1 - frac) + this.buffer[idx2] * frac;
                    } else {
                        sample = this.buffer[(this.readIndex + readPos) % this.maxBufferSize];
                    }
                    
                    // Apply high-pass filter FIRST (before anti-aliasing)
                    if (this.enableHighPass) {
                        const y = this.highPassAlpha * (this.highPassPrevY + sample - this.highPassPrevX);
                        this.highPassPrevX = sample;
                        this.highPassPrevY = y;
                        sample = y;
                    }
                    
                    // Apply anti-aliasing filter if enabled
                    if (this.enableAntiAliasing && this.speed < 1.0) {
                        // Biquad filter: y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]
                        const filtered = this.filterB0 * sample + 
                                        this.filterB1 * this.filterX1 + 
                                        this.filterB2 * this.filterX2 - 
                                        this.filterA1 * this.filterY1 - 
                                        this.filterA2 * this.filterY2;
                        
                        // Update filter state
                        this.filterX2 = this.filterX1;
                        this.filterX1 = sample;
                        this.filterY2 = this.filterY1;
                        this.filterY1 = filtered;
                        
                        channel[i] = filtered;
                    } else {
                        channel[i] = sample;
                    }
                    
                    sourcePos += this.speed;
                }
                this.readIndex = (this.readIndex + samplesToRead) % this.maxBufferSize;
                this.samplesInBuffer -= samplesToRead;
            }
        }
        
        // Update position and metrics (delegated to clean methods)
        this.updatePosition(128);
        this.updateMetrics();
        
        return true;
    }
}

registerProcessor('seismic-processor', SeismicProcessor);

