/**
 * AudioProcessor - AudioWorklet for real-time audio processing
 * 
 * Features:
 * - Circular buffer with dynamic expansion
 * - Variable-speed playback with interpolation
 * - High-pass filter (9 Hz) to remove DC drift
 * - Anti-aliasing filter for slow playback
 * - Selection looping with crossfade
 * - Sample-accurate seeking
 */

// ===== DEBUG FLAGS =====
const DEBUG_WORKLET = true; // Enable verbose worklet logging
const DEBUG_MESSAGES = true; // Log all incoming messages
const DEBUG_PROCESS = false; // Log process() calls every 100 frames
const DEBUG_SAMPLES = false; // Log sample content analysis

class AudioProcessor extends AudioWorkletProcessor {
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
        // 🔥 CRITICAL: Sample rate will be set when data loads (default to 100 Hz)
        // AudioContext is 44.1kHz, but data comes in at original rate (50 Hz seismic, 100 Hz infrasound, variable for spacecraft)
        this.sampleRate = 100; // Default, will be updated by 'data-complete' message

        this.maxBufferSize = 44100 * 300; // 5 minutes max (13.2M samples, ~53MB)
        this.buffer = new Float32Array(this.maxBufferSize);
        this.buffer.fill(0);
        this.writeIndex = 0;
        this.readIndex = 0;
        this.samplesInBuffer = 0;
        this.totalSamplesWritten = 0; // Track total samples written (for completion check)
        this.minBufferSeen = Infinity; // Track minimum buffer level for diagnostics

        // 🔄 DUAL-BUFFER CROSSFADE: Secondary buffer for component switching
        // During crossfade: read from both buffers, mix with crossfade envelope
        // After crossfade: pendingBuffer becomes primary, old buffer cleared
        this.pendingBuffer = null; // Float32Array, allocated on swap-buffer
        this.pendingSamplesInBuffer = 0;
        this.pendingTotalSamples = 0;
        this.isSwapping = false; // True during crossfade between buffers
        this.swapFadeSamples = 0; // Current position in swap crossfade
        this.swapFadeTotalSamples = 0; // Total samples for swap crossfade (e.g., 50ms @ 44.1kHz = 2205)
        this.swapFadeTimeMs = 50; // Crossfade duration in ms
    }
    
    initializePlaybackState() {
        this.isPlaying = false;
        this.hasStarted = false;
        
        // 🏎️ AUTONOMOUS MODE: No coordination flags needed!
        // Worklet decides when to fade based on its own state
        
        // ===== BUFFER THRESHOLDS (chunk-aligned for clean processing) =====
        // Audio worklet processes in 128-sample render quanta
        // All thresholds align to multiples of 128 for SIMD-friendly processing
        
        // INITIAL LOAD: Wait for streaming data to arrive
        // 86 chunks × 128 = 11,008 samples = ~249.7ms
        this.minBufferBeforePlayInitial = 128 * 86; // 11,008 samples (~250ms)
        
        // SEEK/LOOP: Quick refill after buffer clear
        // 8 chunks × 128 = 1,024 samples = ~23.2ms
        this.minBufferBeforePlaySeek = 128 * 8; // 1,024 samples (~23ms)
        
        // Use initial threshold for first load
        this.minBufferBeforePlay = this.minBufferBeforePlayInitial;
        
        this.speed = 1.0;
        this.finishSent = false;
        this.loopWarningShown = false;
        this.dataLoadingComplete = false;
        this.totalSamples = 0;
        this.processStartLogged = false; // For debugging TTFA
        this.stoppedWarningLogged = false; // Track if we've logged the stopped warning
        
        // 🏎️ Pending seek (only used during crossfade seek)
        this.pendingSeekSample = null;
        
        // 🦋 Self-knowledge: Remember if we just teleported (to prevent double fade)
        this.justTeleported = false;
    }
    
    initializeSelectionState() {
        this.selectionStart = null; // in seconds
        this.selectionEnd = null; // in seconds
        this.isLooping = false;
        // 🕉️ ONE LOVE: No selectionEndWarned flag - fadeState.isFading is sufficient!
        
        // 🎛️ SAMPLE-ACCURATE FADE STATE (Ferrari solution)
        // Fades happen in worklet's sample domain, perfectly synced with loop points
        this.fadeState = {
            isFading: false,
            fadeDirection: 0,  // -1 = fade out, +1 = fade in
            fadeStartGain: 1.0,
            fadeEndGain: 1.0,
            fadeSamplesTotal: 0,
            fadeSamplesCurrent: 0
        };
        
        // 🎚️ FADE TIME SETTINGS (hard-coded for optimal performance)
        // All fades use 50ms (prevents clicks on loops and seeks)
        // Exception: Very short loops (<200ms) use 2ms to avoid fade artifacts
        // Exception: First playback after data load uses 250ms to prevent massive click
        this.fadeTimeMs = 50;        // Hard-coded 50ms for all fades
        this.firstPlayAfterDataLoad = false; // Track if this is first play after data load
    }
    
    initializePositionTracking() {
        this.samplesSinceLastPositionUpdate = 0;
        this.positionUpdateIntervalSamples = 1323; // ~30ms at 44.1kHz
        this.totalSamplesConsumed = 0; // Track absolute position in file (for accurate seeking)
        
        // Oscilloscope visualization
        this.oscilloscopeBuffer = new Float32Array(128); // Send 128 samples (~3ms) per update
        this.oscilloscopeCounter = 0;
        this.oscilloscopeInterval = 2; // Send every 2 process() calls (~6ms updates)
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
            const { type, data, speed, enabled, autoResume } = event.data;
            
            // 🔔 DEBUG: Log all incoming messages
            if (DEBUG_MESSAGES && type !== 'audio-data' && type !== 'get-buffer-status') {
                // console.log(`🔔 WORKLET received message: ${type}`); // Commented out to reduce console noise
            }
            
            if (type === 'audio-data') {
                this.addSamples(data, autoResume);
            } else if (type === 'play') {
                // 🏎️ AUTONOMOUS: Worklet decides how to start based on current state
                if (!this.isPlaying) {
                    // 🔗 SHARED SESSION FIX: If hasStarted is false (auto-start was skipped),
                    // we need to initialize playback state properly
                    if (!this.hasStarted) {
                        this.hasStarted = true;
                        // 🐛 FIX: Don't reset readIndex here - it may have been set by a seek!
                        // If user clicked on waveform, seekToPositionInstant already set readIndex.
                        // Only log the state change.
                        console.log(`🔗 WORKLET: Manual start (shared session) - hasStarted=true, readIndex=${this.readIndex}`);
                    }

                    this.isPlaying = true;
                    // If we're not already fading in, start a fade-in
                    if (!this.fadeState.isFading || this.fadeState.fadeDirection !== 1) {
                        // Use LONG fade (250ms) for first play after data load, normal fade (25ms) otherwise
                        const fadeTime = this.firstPlayAfterDataLoad ? 250 : this.fadeTimeMs;
                        this.startFade(+1, fadeTime);

                        if (this.firstPlayAfterDataLoad) {
                            console.log(`🎚️ WORKLET: FIRST PLAY after data load - using LONG ${fadeTime}ms fade-in to prevent click`);
                            this.firstPlayAfterDataLoad = false; // Clear flag after using it
                        } else {
                            if (DEBUG_MESSAGES) console.log(`▶️ WORKLET: Starting playback with ${fadeTime}ms fade-in`);
                        }
                    }
                }
            } else if (type === 'pause') {
                // 🏎️ AUTONOMOUS: Worklet decides how to pause based on current state
                if (this.isPlaying) {
                    // Start fade-out, will set isPlaying=false when fade completes
                    // Keep isPlaying=true during fade so audio continues smoothly
                    this.startFade(-1, this.fadeTimeMs);
                    if (DEBUG_MESSAGES) console.log(`⏸️ WORKLET: Starting ${this.fadeTimeMs}ms fade-out before pause`);
                }
            } else if (type === 'seek') {
                // 🏎️ AUTONOMOUS: Worklet decides how to seek based on current state
                const { position } = event.data;
                const targetSample = Math.floor(position * this.sampleRate);
                console.log(`🎯 WORKLET SEEK: position=${position.toFixed(2)}s, this.sampleRate=${this.sampleRate} Hz, targetSample=${targetSample.toLocaleString()}`);
                
                if (this.isPlaying) {
                    // Crossfade seek: fade out → jump → fade in
                    this.pendingSeekSample = targetSample;
                    this.startFade(-1, this.fadeTimeMs); // Fade out first
                    // if (DEBUG_MESSAGES) console.log(`🎯 WORKLET: Crossfade seek - fade out ${this.fadeTimeMs}ms, jump to ${targetSample}, fade in ${this.fadeTimeMs}ms`);
                } else {
                    // Instant seek: just jump (no fade needed when paused)
                    this.seekToPositionInstant(targetSample);
                }
            } else if (type === 'set-speed') {
                this.setSpeed(speed);
            } else if (type === 'set-anti-aliasing') {
                this.setAntiAliasing(enabled);
            } else if (type === 'start-immediately') {
                this.startImmediately();
            } else if (type === 'set-first-play-flag') {
                // 🎚️ Set flag for first play after data load (must happen BEFORE samples arrive!)
                this.firstPlayAfterDataLoad = true;
                // console.log(`🎚️ WORKLET: First play flag set - next playback will use 250ms fade-in to prevent click`);
                // console.log(`🎚️ WORKLET STATE: hasStarted=${this.hasStarted}, isPlaying=${this.isPlaying}, samplesInBuffer=${this.samplesInBuffer}`);
            } else if (type === 'data-complete') {
                // 🔥 CRITICAL: Set actual sample rate from metadata!
                if (event.data.sampleRate) {
                    this.sampleRate = event.data.sampleRate;
                    // console.log(`🎵 WORKLET: Sample rate set to ${this.sampleRate} Hz (from metadata)`);
                }
                this.markDataComplete(event.data.totalSamples);
            } else if (type === 'reset') {
                this.resetState();
            } else if (type === 'set-selection') {
                this.setSelection(event.data.start, event.data.end, event.data.loop);
            } else if (type === 'get-buffer-status') {
                this.port.postMessage({
                    type: 'buffer-status',
                    samplesInBuffer: this.samplesInBuffer,
                    totalSamplesWritten: this.totalSamplesWritten
                });
            } else if (type === 'swap-buffer') {
                // 🔄 COMPONENT SWITCH: Receive new component's samples and crossfade
                this.handleSwapBuffer(event.data.samples, event.data.sampleRate);
            } else if (type === 'clear-buffer') {
                // Clear current buffer (used before sending new component data)
                this.buffer.fill(0);
                this.samplesInBuffer = 0;
                this.writeIndex = 0;
                // Don't reset readIndex or totalSamplesConsumed - we want to maintain position
                console.log(`🗑️ WORKLET: Buffer cleared`);
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
        this.isPlaying = true;  // 🔥 CRITICAL: Must set isPlaying=true for audio output!
        this.minBuffer = 0;

        // ✅ CRITICAL: Switch to seek threshold for future seeks/loops
        this.minBufferBeforePlay = this.minBufferBeforePlaySeek;

        // 🎚️ Only start a new fade if we're NOT already fading in
        // This prevents the autoPlay 'start-immediately' from interrupting the initial 250ms fade
        if (this.fadeState.isFading && this.fadeState.fadeDirection === 1) {
            console.log(`🎚️ WORKLET: start-immediately called but fade-in already in progress - keeping existing fade`);
            return;
        }

        // 🎚️ Start fade-in to prevent click at playback start
        // Use LONG fade (250ms) for first play after data load, normal fade (25ms) otherwise
        const fadeTime = this.firstPlayAfterDataLoad ? 250 : this.fadeTimeMs;
        this.startFade(+1, fadeTime);

        if (this.firstPlayAfterDataLoad) {
            console.log(`🎚️ WORKLET: FIRST PLAY after data load - using LONG ${fadeTime}ms fade-in to prevent click`);
            this.firstPlayAfterDataLoad = false; // Clear flag after using it
        } else {
            console.log(`🚀 WORKLET: Forced immediate start with ${fadeTime}ms fade-in! minBuffer=0, hasStarted=true, isPlaying=true`);
        }
    }
    
    markDataComplete(totalSamples) {
        this.dataLoadingComplete = true;
        this.totalSamples = totalSamples || this.samplesInBuffer;
        const bufferSeconds = this.samplesInBuffer / this.sampleRate;
        const bufferMinutes = bufferSeconds / 60;
        // console.log(`📊 Buffer Status: ${this.samplesInBuffer.toLocaleString()} samples in buffer (${bufferMinutes.toFixed(2)} minutes)`);
        // console.log('🎵 WORKLET: Data complete. Total samples set to ' + this.totalSamples + ' (samplesInBuffer=' + this.samplesInBuffer + ')');
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
        this.pendingSeekSample = null;
        this.justTeleported = false;
        // Reset swap state
        this.pendingBuffer = null;
        this.pendingSamplesInBuffer = 0;
        this.isSwapping = false;
    }

    /**
     * 🔄 DUAL-BUFFER CROSSFADE: Handle component switch
     * Receives new component samples, stores in pending buffer, initiates crossfade
     * @param {Float32Array} samples - New component's audio samples
     * @param {number} newSampleRate - Sample rate of new component (should match current)
     */
    handleSwapBuffer(samples, newSampleRate) {
        console.log(`🔄 WORKLET SWAP-BUFFER: Received ${samples.length.toLocaleString()} samples for crossfade`);

        // Update sample rate if provided
        if (newSampleRate && newSampleRate !== this.sampleRate) {
            console.log(`🔄 WORKLET: Sample rate changing from ${this.sampleRate} to ${newSampleRate} Hz`);
            this.sampleRate = newSampleRate;
        }

        // Allocate pending buffer if needed (or resize)
        if (!this.pendingBuffer || this.pendingBuffer.length < samples.length) {
            this.pendingBuffer = new Float32Array(Math.max(samples.length, this.maxBufferSize));
            console.log(`🔄 WORKLET: Allocated pending buffer: ${this.pendingBuffer.length.toLocaleString()} samples`);
        }

        // Copy samples to pending buffer
        this.pendingBuffer.set(samples);
        this.pendingSamplesInBuffer = samples.length;
        this.pendingTotalSamples = samples.length;

        // Calculate crossfade duration in output samples (44.1kHz)
        this.swapFadeTotalSamples = Math.floor(this.swapFadeTimeMs * 44.1);
        this.swapFadeSamples = 0;
        this.isSwapping = true;

        console.log(`🔄 WORKLET: Starting ${this.swapFadeTimeMs}ms crossfade (${this.swapFadeTotalSamples} output samples)`);
        console.log(`🔄 WORKLET: Current position: ${this.totalSamplesConsumed.toLocaleString()} / ${this.samplesInBuffer.toLocaleString()} samples`);

        // Notify main thread that swap started
        this.port.postMessage({
            type: 'swap-started',
            fadeDurationMs: this.swapFadeTimeMs
        });
    }

    /**
     * 🔄 Complete the buffer swap after crossfade finishes
     * Makes pending buffer the primary, clears old buffer for reuse
     */
    completeBufferSwap() {
        console.log(`🔄 WORKLET SWAP COMPLETE: Crossfade finished`);

        // Swap buffers: pending becomes primary
        const oldBuffer = this.buffer;
        this.buffer = this.pendingBuffer;
        this.samplesInBuffer = this.pendingSamplesInBuffer;
        this.totalSamples = this.pendingTotalSamples;

        // Old buffer becomes available for next swap (cleared)
        this.pendingBuffer = oldBuffer;
        this.pendingBuffer.fill(0);
        this.pendingSamplesInBuffer = 0;

        // Reset swap state
        this.isSwapping = false;
        this.swapFadeSamples = 0;

        // Reset write index (buffer is fully loaded)
        this.writeIndex = this.samplesInBuffer;

        // CRITICAL: Adjust readIndex to match current position in the NEW buffer
        // totalSamplesConsumed tracks absolute position - use modulo to wrap within buffer
        this.readIndex = this.totalSamplesConsumed % this.samplesInBuffer;

        // Mark data as complete
        this.dataLoadingComplete = true;

        console.log(`🔄 WORKLET: New buffer active: ${this.samplesInBuffer.toLocaleString()} samples`);
        console.log(`🔄 WORKLET: Playback position: ${this.totalSamplesConsumed.toLocaleString()}, readIndex adjusted to ${this.readIndex.toLocaleString()}`);

        // Notify main thread that swap is complete
        this.port.postMessage({
            type: 'swap-complete',
            samplesInBuffer: this.samplesInBuffer
        });
    }
    
    setSelection(start, end, loop) {
        this.selectionStart = start;
        this.selectionEnd = end;
        this.isLooping = loop;
        
        // 🏎️ AUTONOMOUS: Reset loop warning state when selection changes
        this.loopWarningShown = false;
        
        // Cancel any pending seek (selection change takes priority)
        this.pendingSeekSample = null;
        
        // if (DEBUG_WORKLET) console.log('🎯 WORKLET SELECTION: Start=' + start + 's, End=' + end + 's, Loop=' + loop);
    }
    
    // 🏎️ Instant seek (no fade) - used when paused or during crossfade completion
    seekToPositionInstant(targetSample) {
        // Clamp to selection bounds if selection exists
        if (this.selectionStart !== null && this.selectionEnd !== null) {
            const startSample = Math.floor(this.selectionStart * this.sampleRate);
            const endSample = Math.floor(this.selectionEnd * this.sampleRate);
            targetSample = Math.max(startSample, Math.min(targetSample, endSample));
        }
        
        if (targetSample >= 0 && targetSample <= this.totalSamples) {
            if (targetSample < this.samplesInBuffer) {
                // Sample is in buffer - instant jump
                this.readIndex = targetSample % this.maxBufferSize;
                this.totalSamplesConsumed = targetSample;
                
                // if (DEBUG_WORKLET) console.log(`⚡ INSTANT SEEK: Set readIndex to ${this.readIndex.toLocaleString()} for sample ${targetSample.toLocaleString()}`);
                
                // Send position update
                this.port.postMessage({
                    type: 'position',
                    samplePosition: targetSample,
                    positionSeconds: targetSample / this.sampleRate
                });
                return true;
            } else {
                // Sample not in buffer - need refill
                console.warn(`⚠️ SEEK OUT OF BUFFER: Target ${targetSample.toLocaleString()} >= samplesInBuffer ${this.samplesInBuffer.toLocaleString()}`);
                const wasPlaying = this.isPlaying;
                this.isPlaying = false;
                
                // Clear buffer and request refill
                this.writeIndex = 0;
                this.readIndex = 0;
                this.samplesInBuffer = 0;
                this.totalSamplesWritten = 0;
                this.totalSamplesConsumed = targetSample;
                this.finishSent = false;
                this.loopWarningShown = false;
                
                this.port.postMessage({
                    type: 'seek-ready',
                    targetSample: targetSample,
                    wasPlaying: wasPlaying,
                    forceResume: false
                });
                
                return false;
            }
        }
        return false;
    }
    
    startFade(direction, durationMs) {
        // Sample-accurate fade: direction = -1 (fade out), +1 (fade in)
        const durationSamples = Math.floor(durationMs * 44.1); // ms to samples at 44.1kHz
        this.fadeState.isFading = true;
        this.fadeState.fadeDirection = direction;
        this.fadeState.fadeSamplesTotal = durationSamples;
        this.fadeState.fadeSamplesCurrent = 0;
        this.fadeState.fadeStartGain = direction === -1 ? 1.0 : 0.0001;
        this.fadeState.fadeEndGain = direction === -1 ? 0.0001 : 1.0;
        
        // console.log(`🎚️ WORKLET FADE: ${direction === -1 ? 'OUT' : 'IN'} over ${durationMs}ms (${durationSamples} samples), gain: ${this.fadeState.fadeStartGain} → ${this.fadeState.fadeEndGain}`);
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
        
        console.log('📏 Expanded buffer to ' + (newSize / this.sampleRate / 60).toFixed(1) + ' minutes');
    }
    
    writeSamples(samples) {
        for (let i = 0; i < samples.length; i++) {
            this.buffer[this.writeIndex] = samples[i];
            this.writeIndex = (this.writeIndex + 1) % this.maxBufferSize;
            
            // 🔥 RANDOM-ACCESS FIX: Only increment if buffer not full
            if (this.samplesInBuffer < this.maxBufferSize) {
                this.samplesInBuffer++;
            }
            
            this.totalSamplesWritten++;
        }
    }
    
    addSamples(samples, autoResume = false) {
        const neededSize = this.samplesInBuffer + samples.length;
        if (neededSize > this.maxBufferSize) {
            this.expandBuffer(neededSize);
        }
        
        this.writeSamples(samples);

        // Check if we can start playback (initial load)
        // Only auto-start if autoResume is not explicitly false (for shared sessions, we wait for user click)
        if (!this.hasStarted && autoResume !== false && this.samplesInBuffer >= this.minBufferBeforePlay) {
            const bufferSeconds = this.samplesInBuffer / this.sampleRate;
            const bufferMinutes = bufferSeconds / 60;
            // console.log(`📊 Buffer Status: ${this.samplesInBuffer.toLocaleString()} samples in buffer (${bufferMinutes.toFixed(2)} minutes)`);
            // console.log('🎵 WORKLET addSamples: Threshold reached! samplesInBuffer=' + this.samplesInBuffer + ', minBuffer=' + this.minBufferBeforePlay);
            // console.log(`🎚️ WORKLET INITIAL START: firstPlayAfterDataLoad=${this.firstPlayAfterDataLoad}`);
            this.readIndex = 0;
            this.isPlaying = true;
            this.hasStarted = true;

            // 🎚️ CRITICAL: Start fade-in when threshold is reached!
            // Use LONG fade (250ms) for first play after data load, normal fade (25ms) otherwise
            const fadeTime = this.firstPlayAfterDataLoad ? 250 : this.fadeTimeMs;
            this.startFade(+1, fadeTime);

            if (this.firstPlayAfterDataLoad) {
                console.log(`🎚️ WORKLET THRESHOLD: FIRST PLAY after data load - using ${fadeTime}ms fade-in to prevent click`);
                this.firstPlayAfterDataLoad = false; // Clear flag after using it
            } else {
                // console.log(`🎚️ WORKLET THRESHOLD: Started ${fadeTime}ms fade-in (firstPlayAfterDataLoad was false)`);
            }
            
            // After first start, switch to seek threshold for future seeks/loops
            this.minBufferBeforePlay = this.minBufferBeforePlaySeek;
            
            this.port.postMessage({ type: 'started' });
        }
        // Auto-resume after seek/loop if requested and buffer is ready
        else if (autoResume && !this.isPlaying && this.samplesInBuffer >= this.minBufferBeforePlay) {
            if (DEBUG_WORKLET) console.log(`🎵 WORKLET addSamples: Auto-resuming! samplesInBuffer=${this.samplesInBuffer}, minBuffer=${this.minBufferBeforePlay}`);
            this.isPlaying = true;
            // 🎯 Start fade-in for graceful resumption after buffer underrun
            // Use LONG fade (250ms) for first play after data load, normal fade (25ms) otherwise
            const fadeTime = this.firstPlayAfterDataLoad ? 250 : this.fadeTimeMs;
            this.startFade(+1, fadeTime);
            
            if (this.firstPlayAfterDataLoad) {
                // console.log(`🎚️ WORKLET AUTO-RESUME: FIRST PLAY after data load - using ${fadeTime}ms fade-in to prevent click`);
                this.firstPlayAfterDataLoad = false; // Clear flag after using it
            } else {
                if (DEBUG_WORKLET) console.log(`🎚️ WORKLET addSamples: Started fade-in for auto-resume`);
            }
        } else if (autoResume && !this.isPlaying) {
            // if (DEBUG_WORKLET) console.log(`⏳ WORKLET addSamples: Buffering for auto-resume... samplesInBuffer=${this.samplesInBuffer}, need ${this.minBufferBeforePlay}`);
        }
        
        // 🔍 DEBUG: Check if isPlaying got set to false somehow
        if (DEBUG_WORKLET && this.hasStarted && !this.isPlaying) {
            console.warn(`⚠️ addSamples EXIT: isPlaying=FALSE (autoResume=${autoResume}, samplesInBuffer=${this.samplesInBuffer})`);
        }
    }
    
    // ===== SELECTION & LOOP MODULE =====
    
    handleSelectionBoundaries() {
        // 🏎️ AUTONOMOUS: Works for both selection loops AND full-file loops
        // If no selection, treat entire buffer as the "selection"
        const isFullFileLoop = (this.selectionStart === null || this.selectionEnd === null);
        
        const loopEndSample = isFullFileLoop 
            ? this.samplesInBuffer 
            : Math.floor(this.selectionEnd * this.sampleRate);
        
        const samplesToEnd = loopEndSample - this.totalSamplesConsumed;
        
        const loopDuration = isFullFileLoop 
            ? this.samplesInBuffer / this.sampleRate  // Full file duration in seconds
            : (this.selectionEnd - this.selectionStart); // Selection duration in seconds
        
        // 🎚️ AUTONOMOUS FADE TRIGGER: Start fade-out early enough to complete EXACTLY at boundary
        // 🕉️ ONE LOVE: Trust fadeState.isFading - no need for selectionEndWarned flag!
        // 🦋 Self-knowledge: Don't check boundaries if we just teleported (prevent double fade)
        if (samplesToEnd > 0 && this.isPlaying && !this.fadeState.isFading && this.pendingSeekSample === null && !this.justTeleported) {
            if (loopDuration < 0.050) {
                // Audio-rate loop (<50ms) - no fade, embrace the granular character
                // Just check if we're close enough (no fade needed)
                const AUDIO_RATE_WARNING = 441; // ~10ms warning
                if (samplesToEnd <= AUDIO_RATE_WARNING) {
                    // Close enough - will loop naturally without fade
                }
            } else {
                // 🏎️ SPEED-AWARE: Calculate fade time and convert to INPUT samples
                // Fade duration is always in wall-clock time (consistent UX)
                // At slow speeds, we consume fewer input samples per unit time, so need fewer samples warning
                // At fast speeds, we consume more input samples per unit time, so need more samples warning
                const fadeTime = this.isLooping && loopDuration < 0.200 ? 2 : this.fadeTimeMs;
                const FADE_SAMPLES_OUTPUT = Math.floor(fadeTime * 44.1); // Output samples (always same duration)
                const FADE_SAMPLES_INPUT = Math.floor(FADE_SAMPLES_OUTPUT * this.speed); // Convert to INPUT samples!
                
                // 🔍 DIAGNOSTIC LOG - Only print when playing
                // if (this.isPlaying) {
                //     console.log(`🔍 BOUNDARY CHECK: totalSamplesConsumed=${this.totalSamplesConsumed.toLocaleString()}, samplesInBuffer=${this.samplesInBuffer.toLocaleString()}, loopEndSample=${loopEndSample.toLocaleString()}, samplesToEnd=${samplesToEnd.toLocaleString()}, FADE_SAMPLES_INPUT=${FADE_SAMPLES_INPUT}, isFullFileLoop=${isFullFileLoop}, selectionEnd=${this.selectionEnd}`);
                // }
                
                if (samplesToEnd <= FADE_SAMPLES_INPUT) {
                    console.log(`🔄 LOOP FADE-OUT: samplesToEnd=${samplesToEnd}, fadeTime=${fadeTime}ms, isLooping=${this.isLooping}, isFullFileLoop=${isFullFileLoop}`);
                    this.startFade(-1, fadeTime); // Fade out

                    // 🏎️ AUTONOMOUS: Set pending seek for loop (will be handled when fade completes)
                    if (this.isLooping) {
                        const loopTargetSample = isFullFileLoop ? 0 : Math.floor(this.selectionStart * this.sampleRate);
                        this.pendingSeekSample = loopTargetSample;
                        console.log(`🔄 WORKLET: Starting fade-out for loop (${fadeTime}ms, ${FADE_SAMPLES_INPUT} input samples @ ${this.speed.toFixed(2)}x), will jump to ${loopTargetSample.toLocaleString()} when fade completes`);
                    }
                }
            }
        }
        
        // 🏎️ AUTONOMOUS: At boundary - check if fade completed, then loop or stop
        if (this.totalSamplesConsumed >= loopEndSample && this.isPlaying) {
            if (this.fadeState.isFading && this.fadeState.fadeDirection === -1) {
                // Fade-out still in progress - wait for it to complete (handled in fade completion)
                return false;
            } else {
                // No fade in progress - handle boundary immediately
                if (this.isLooping) {
                    // Loop: jump to start (fade-in will happen if we were fading)
                    const loopTargetSample = isFullFileLoop ? 0 : Math.floor(this.selectionStart * this.sampleRate);
                    if (this.seekToPositionInstant(loopTargetSample)) {
                        // Jump successful - fade in if we were playing
                        if (this.isPlaying) {
                            this.startFade(+1, this.fadeTimeMs);
                        }
                        this.loopWarningShown = false;
                        return true;
                    }
                } else {
                    // Not looping: stop at end
                    this.isPlaying = false;
                    const stopPosition = isFullFileLoop 
                        ? (this.samplesInBuffer / this.sampleRate) 
                        : this.selectionEnd;
                    this.port.postMessage({ 
                        type: 'selection-end-reached',
                        position: stopPosition
                    });
                    if (DEBUG_WORKLET) console.log('⏹️ WORKLET: Reached selection end, stopped');
                    return true;
                }
            }
        }
        
        return false;
    }
    
    // ===== POSITION TRACKING MODULE =====
    
    updatePosition(frameSize) {
        this.samplesSinceLastPositionUpdate += frameSize;
        if (this.samplesSinceLastPositionUpdate >= this.positionUpdateIntervalSamples) {
            if (this.hasStarted && this.isPlaying) {
                this.port.postMessage({
                    type: 'position',
                    samplePosition: this.totalSamplesConsumed,
                    positionSeconds: this.totalSamplesConsumed / this.sampleRate
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
            // console.log('🎵 WORKLET process() FIRST CALL after hasStarted=true');
            // console.log(`🔍 FIRST PROCESS CALL STATE: isPlaying=${this.isPlaying}, isFading=${this.fadeState.isFading}, fadeDirection=${this.fadeState.fadeDirection}, fadeStartGain=${this.fadeState.fadeStartGain}, fadeEndGain=${this.fadeState.fadeEndGain}`);
            this.processStartLogged = true;
        }
        
        // 🔍 DEBUG: Log process() state every 100 calls when playing
        if (!this.processDebugCounter) this.processDebugCounter = 0;
        this.processDebugCounter++;
        
        if (!this.isPlaying) {
            channel.fill(0);
            // 🔥 FIX: Only log stopped warning once to prevent spam
            // The worklet's process() continues to be called even after playback stops
            // This is normal behavior - we just output silence
            if (DEBUG_WORKLET && this.hasStarted && !this.stoppedWarningLogged) {
                console.warn(`⚠️ WORKLET process(): isPlaying=FALSE - outputting silence! (readIndex=${this.readIndex}, samplesInBuffer=${this.samplesInBuffer})`);
                this.stoppedWarningLogged = true;
            }
            return true;
        }
        
        // 🔥 FIX: Reset warning flag when playback resumes
        // This allows the warning to be logged again if playback stops again
        if (this.stoppedWarningLogged) {
            this.stoppedWarningLogged = false;
        }
        
        // 🏎️ AUTO-FADE: If we just started playing and we're not already fading in, START a fade-in!
        // This catches ALL cases: resume, selection start, seek without explicit fade, etc.
        const AUTO_FADE_THRESHOLD = 0.001; // If current gain is near silence
        const needsAutoFadeIn = !this.fadeState.isFading && 
                               this.fadeState.fadeDirection !== 1 && // Not already fading in
                               (this.fadeState.fadeEndGain < AUTO_FADE_THRESHOLD || 
                                this.processDebugCounter < 10); // Just started or was silent
        
        if (needsAutoFadeIn && this.hasStarted) {
            this.startFade(+1, this.fadeTimeMs); // Auto fade-in from silence
            if (DEBUG_WORKLET) console.log('🎚️ AUTO-FADE: Started automatic fade-in from silence');
        }
        
        // 🔍 DEBUG: Log every 100 process() calls when playing
        if (DEBUG_PROCESS && this.processDebugCounter % 100 === 0) {
            // Check what samples we're about to read
            const samplePeek = this.buffer[this.readIndex];
            const nextSamplePeek = this.buffer[(this.readIndex + 1) % this.maxBufferSize];
            console.log(`🔊 WORKLET process(): isPlaying=TRUE, readIndex=${this.readIndex}, samplesInBuffer=${this.samplesInBuffer}, totalSamplesConsumed=${this.totalSamplesConsumed}, samplePeek=${samplePeek?.toFixed(4)}, nextSample=${nextSamplePeek?.toFixed(4)}`);
        }
        
        const samplesToRead = Math.ceil(channel.length * this.speed);
        
        // 🏎️ UNIFIED LOOP HANDLER: Handles both selection loops AND full-file loops
        this.handleSelectionBoundaries();
        
        // Track minimum buffer level (for diagnostics)
        if (this.samplesInBuffer < this.minBufferSeen) {
            this.minBufferSeen = this.samplesInBuffer;
        }
        
        // CRITICAL HOT PATH: Buffer reading (kept inline for performance)
        if (this.samplesInBuffer < samplesToRead) {
            // Underrun case - log it!
            console.warn(`⚠️ BUFFER UNDERRUN: only ${this.samplesInBuffer} samples available, need ${samplesToRead} (readIndex=${this.readIndex})`);
            if (this.hasStarted && this.samplesInBuffer > 0) {
                console.warn(`⚠️ UNDERRUN DETAILS: hasStarted=true, playing partial buffer`);
            }
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
                // this.samplesInBuffer--;  // 🧪 TEST: Don't consume samples (random-access, not FIFO)
                this.totalSamplesConsumed++; // Track absolute position
            }
            for (let i = availableForOutput; i < channel.length; i++) {
                channel[i] = 0;
            }
            
            // Check if finished
            if (this.samplesInBuffer === 0) {
                if (!this.finishSent && this.hasStarted && this.dataLoadingComplete) {
                    this.isPlaying = false;
                    const expectedDuration = this.totalSamples / (this.sampleRate * this.speed);
                    
                    // Send final position update at 100% before sending finished message
                    this.port.postMessage({
                        type: 'position',
                        samplePosition: this.totalSamples,
                        positionSeconds: expectedDuration
                    });
                    
                    this.port.postMessage({ 
                        type: 'finished',
                        totalSamples: this.totalSamples,
                        speed: this.speed,
                        expectedDurationSeconds: expectedDuration,
                        minBufferSeen: this.minBufferSeen  // Report minimum buffer level
                    });
                    this.finishSent = true;
                    
                    // Report buffer health
                    const bufferSeconds = this.minBufferSeen / this.sampleRate;
                    if (this.minBufferSeen < this.sampleRate) {
                        console.warn(`⚠️ Buffer health: Minimum buffer was ${this.minBufferSeen.toLocaleString()} samples (${bufferSeconds.toFixed(2)}s) - DANGEROUSLY LOW!`);
                    } else {
                        console.log(`✅ Buffer health: Minimum buffer was ${this.minBufferSeen.toLocaleString()} samples (${bufferSeconds.toFixed(2)}s)`);
                    }
                }
                channel.fill(0);
                return true;
            }
        } else {
            // Normal case: enough samples available
            if (this.speed === 1.0) {
                // Fast path: no interpolation needed
                let nonZeroCount = 0;
                let sampleSum = 0;
                
                // 🎚️ CALCULATE FADE RANGE FOR THIS QUANTUM (128 samples)
                let fadeStartGainThisQuantum = 1.0;
                let fadeEndGainThisQuantum = 1.0;
                
                if (this.fadeState.isFading) {
                    const startSample = this.fadeState.fadeSamplesCurrent;
                    const endSample = Math.min(startSample + channel.length, this.fadeState.fadeSamplesTotal);
                    
                    const startProgress = startSample / this.fadeState.fadeSamplesTotal;
                    const endProgress = endSample / this.fadeState.fadeSamplesTotal;
                    
                    fadeStartGainThisQuantum = this.fadeState.fadeStartGain + 
                        (this.fadeState.fadeEndGain - this.fadeState.fadeStartGain) * startProgress;
                    fadeEndGainThisQuantum = this.fadeState.fadeStartGain + 
                        (this.fadeState.fadeEndGain - this.fadeState.fadeStartGain) * endProgress;
                }
                
                for (let i = 0; i < channel.length; i++) {
                    let sample = this.buffer[this.readIndex];

                    // 🔄 DUAL-BUFFER CROSSFADE: Mix old and new buffers during swap
                    if (this.isSwapping && this.pendingBuffer) {
                        // Read from pending buffer at same position
                        const pendingReadIndex = this.totalSamplesConsumed % this.pendingSamplesInBuffer;
                        const pendingSample = this.pendingBuffer[pendingReadIndex];

                        // Calculate crossfade mix (0.0 = all old, 1.0 = all new)
                        const swapProgress = (this.swapFadeSamples + i) / this.swapFadeTotalSamples;
                        const mixAmount = Math.min(1.0, Math.max(0.0, swapProgress));

                        // Equal-power crossfade for smooth transition
                        const oldGain = Math.cos(mixAmount * Math.PI / 2);
                        const newGain = Math.sin(mixAmount * Math.PI / 2);

                        sample = sample * oldGain + pendingSample * newGain;
                    }

                    // 🔍 DEBUG: Track non-zero samples
                    if (Math.abs(sample) > 0.0001) nonZeroCount++;
                    sampleSum += Math.abs(sample);

                    // Apply high-pass filter if enabled
                    if (this.enableHighPass) {
                        const y = this.highPassAlpha * (this.highPassPrevY + sample - this.highPassPrevX);
                        this.highPassPrevX = sample;
                        this.highPassPrevY = y;
                        sample = y;
                    }

                    // 🎚️ SAMPLE-ACCURATE FADE APPLICATION (interpolate across quantum)
                    let appliedGain = 1.0; // Track what gain was actually applied
                    if (this.fadeState.isFading) {
                        const t = i / channel.length; // 0.0 to 1.0 across this quantum
                        const currentGain = fadeStartGainThisQuantum +
                            (fadeEndGainThisQuantum - fadeStartGainThisQuantum) * t;
                        appliedGain = currentGain;

                        sample *= currentGain;
                    }

                    // 🔍 LOG THE VERY FIRST SAMPLE EVER OUTPUT
                    if (this.totalSamplesConsumed === 0 && i === 0) {
                        // console.log(`🎵 🔴 VERY FIRST SAMPLE OUTPUT: value=${sample.toFixed(6)}, gain=${appliedGain.toFixed(6)}, isFading=${this.fadeState.isFading}, original=${this.buffer[this.readIndex].toFixed(6)}`);
                    }

                    channel[i] = sample;
                    this.readIndex = (this.readIndex + 1) % this.maxBufferSize;
                    this.totalSamplesConsumed++; // Track absolute position

                    // 🏎️ RANDOM-ACCESS MODE: Handle end-of-buffer behavior
                    // (Loop handling is now autonomous in handleSelectionBoundaries())
                    if (this.totalSamplesConsumed >= this.samplesInBuffer && this.samplesInBuffer > 0 && !this.fadeState.isFading && !this.isSwapping) {
                        // Reached end of loaded audio - wrap to beginning immediately
                        // (Only if not fading and not swapping - otherwise those handlers will manage it)
                        this.readIndex = 0;
                        this.totalSamplesConsumed = 0;
                        this.loopWarningShown = false; // 🔥 RESET for next loop!
                    }
                }

                // 🔄 UPDATE SWAP FADE COUNTER AND CHECK FOR COMPLETION
                if (this.isSwapping) {
                    this.swapFadeSamples += channel.length;
                    if (this.swapFadeSamples >= this.swapFadeTotalSamples) {
                        this.completeBufferSwap();
                    }
                }
                
                // 🎚️ UPDATE FADE COUNTER ONCE PER QUANTUM (not per sample!)
                if (this.fadeState.isFading) {
                    this.fadeState.fadeSamplesCurrent += channel.length;
                    if (this.fadeState.fadeSamplesCurrent >= this.fadeState.fadeSamplesTotal) {
                        // 🏎️ AUTONOMOUS: Handle fade completion based on context
                        const wasFadingOut = (this.fadeState.fadeDirection === -1);
                        this.fadeState.isFading = false;

                        if (wasFadingOut) {
                            // Fade-out completed - check what to do next
                            if (this.pendingSeekSample !== null) {
                                // Pending seek (from user seek OR loop): jump to target and fade in
                                const targetSample = this.pendingSeekSample;
                                this.pendingSeekSample = null;
                                this.justTeleported = true; // 🦋 "I just arrived via teleport!"
                                // console.log(`🔄 LOOP FADE-OUT COMPLETE (mono): jumping to ${targetSample.toLocaleString()}, will fade in ${this.fadeTimeMs}ms`);
                                if (this.seekToPositionInstant(targetSample)) {
                                    // Jump successful - fade in if we're playing
                                    if (this.isPlaying) {
                                        this.startFade(+1, this.fadeTimeMs);
                                        // console.log(`🔄 LOOP FADE-IN STARTED (mono): ${this.fadeTimeMs}ms`);
                                    }
                                }
                            } else {
                                // No pending seek - check if we're at a boundary
                                const isFullFileLoop = (this.selectionStart === null || this.selectionEnd === null);
                                const loopEndSample = isFullFileLoop
                                    ? this.samplesInBuffer
                                    : Math.floor(this.selectionEnd * this.sampleRate);

                                if (this.totalSamplesConsumed >= loopEndSample) {
                                    // At boundary - handle loop or stop
                                    if (this.isLooping) {
                                        // Loop: jump to start and fade in
                                        const loopTargetSample = isFullFileLoop ? 0 : Math.floor(this.selectionStart * this.sampleRate);
                                        console.log(`🔄 LOOP AT BOUNDARY (mono): looping to ${loopTargetSample.toLocaleString()}, fade in ${this.fadeTimeMs}ms`);
                                        if (this.seekToPositionInstant(loopTargetSample)) {
                                            this.startFade(+1, this.fadeTimeMs);
                                            this.loopWarningShown = false;
                                        }
                                    } else {
                                        // Not looping: stop at end
                                        this.isPlaying = false;
                                        const stopPosition = isFullFileLoop
                                            ? (this.samplesInBuffer / this.sampleRate)
                                            : this.selectionEnd;
                                        this.port.postMessage({
                                            type: 'selection-end-reached',
                                            position: stopPosition
                                        });
                                        if (DEBUG_WORKLET) console.log('⏹️ WORKLET: Fade-out complete at boundary, stopped');
                                    }
                                } else {
                                    // No pending seek, not at boundary - must be pause
                                    this.isPlaying = false;
                                    this.port.postMessage({ type: 'fade-complete', action: 'pause' });
                                    if (DEBUG_WORKLET) console.log('⏸️ WORKLET: Fade-out complete, paused');
                                }
                            }
                        } else {
                            // 🦋 FADE-IN COMPLETION: Clear the teleport flag!
                            this.justTeleported = false;
                            // console.log(`🔄 LOOP FADE-IN COMPLETE (mono)`);
                        }
                        // Fade-in completion: nothing special needed, just continue playing
                    }
                }

                // 🔍 DEBUG: Log sample content every 100 calls
                if (DEBUG_SAMPLES && this.processDebugCounter % 100 === 0) {
                    const avgSample = sampleSum / channel.length;
                    console.log(`📊 WORKLET samples: ${nonZeroCount}/${channel.length} non-zero, avg magnitude: ${avgSample.toFixed(6)}`);
                }
            } else {
                // Interpolation path for variable speed
                
                // 🎚️ CALCULATE FADE RANGE FOR THIS QUANTUM (128 samples)
                let fadeStartGainThisQuantum = 1.0;
                let fadeEndGainThisQuantum = 1.0;
                
                if (this.fadeState.isFading) {
                    const startSample = this.fadeState.fadeSamplesCurrent;
                    const endSample = Math.min(startSample + channel.length, this.fadeState.fadeSamplesTotal);
                    
                    const startProgress = startSample / this.fadeState.fadeSamplesTotal;
                    const endProgress = endSample / this.fadeState.fadeSamplesTotal;
                    
                    fadeStartGainThisQuantum = this.fadeState.fadeStartGain + 
                        (this.fadeState.fadeEndGain - this.fadeState.fadeStartGain) * startProgress;
                    fadeEndGainThisQuantum = this.fadeState.fadeStartGain + 
                        (this.fadeState.fadeEndGain - this.fadeState.fadeStartGain) * endProgress;
                }
                
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

                    // 🔄 DUAL-BUFFER CROSSFADE: Mix old and new buffers during swap
                    if (this.isSwapping && this.pendingBuffer) {
                        // Read from pending buffer at same position (with interpolation)
                        const pendingBaseIdx = (this.totalSamplesConsumed + readPos) % this.pendingSamplesInBuffer;
                        let pendingSample;
                        if (readPos < samplesToRead - 1) {
                            const frac = sourcePos - readPos;
                            const pIdx1 = pendingBaseIdx;
                            const pIdx2 = (pendingBaseIdx + 1) % this.pendingSamplesInBuffer;
                            pendingSample = this.pendingBuffer[pIdx1] * (1 - frac) + this.pendingBuffer[pIdx2] * frac;
                        } else {
                            pendingSample = this.pendingBuffer[pendingBaseIdx];
                        }

                        // Calculate crossfade mix
                        const swapProgress = (this.swapFadeSamples + i) / this.swapFadeTotalSamples;
                        const mixAmount = Math.min(1.0, Math.max(0.0, swapProgress));

                        // Equal-power crossfade
                        const oldGain = Math.cos(mixAmount * Math.PI / 2);
                        const newGain = Math.sin(mixAmount * Math.PI / 2);

                        sample = sample * oldGain + pendingSample * newGain;
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

                        sample = filtered;
                    }

                    // 🎚️ SAMPLE-ACCURATE FADE APPLICATION (interpolate across quantum)
                    if (this.fadeState.isFading) {
                        const t = i / channel.length; // 0.0 to 1.0 across this quantum
                        const currentGain = fadeStartGainThisQuantum +
                            (fadeEndGainThisQuantum - fadeStartGainThisQuantum) * t;
                        sample *= currentGain;
                    }

                    channel[i] = sample;
                    sourcePos += this.speed;
                }
                this.readIndex = (this.readIndex + samplesToRead) % this.maxBufferSize;
                this.totalSamplesConsumed += samplesToRead; // Track absolute position

                // 🔄 UPDATE SWAP FADE COUNTER AND CHECK FOR COMPLETION
                if (this.isSwapping) {
                    this.swapFadeSamples += channel.length;
                    if (this.swapFadeSamples >= this.swapFadeTotalSamples) {
                        this.completeBufferSwap();
                    }
                }

                // 🏎️ RANDOM-ACCESS MODE: Handle end-of-buffer behavior
                // (Loop handling is now autonomous in handleSelectionBoundaries())
                if (this.totalSamplesConsumed >= this.samplesInBuffer && this.samplesInBuffer > 0 && !this.fadeState.isFading && !this.isSwapping) {
                    // Reached end of loaded audio - wrap to beginning immediately
                    // (Only if not fading and not swapping - otherwise those handlers will manage it)
                    this.readIndex = 0;
                    this.totalSamplesConsumed = 0;
                    this.loopWarningShown = false; // 🔥 RESET for next loop!
                }
                
                // 🎚️ UPDATE FADE COUNTER ONCE PER QUANTUM (not per sample!)
                if (this.fadeState.isFading) {
                    this.fadeState.fadeSamplesCurrent += channel.length;
                    if (this.fadeState.fadeSamplesCurrent >= this.fadeState.fadeSamplesTotal) {
                        // 🏎️ AUTONOMOUS: Handle fade completion based on context
                        const wasFadingOut = (this.fadeState.fadeDirection === -1);
                        this.fadeState.isFading = false;
                        
                        if (wasFadingOut) {
                            // Fade-out completed - check what to do next
                            if (this.pendingSeekSample !== null) {
                                // Pending seek (from user seek OR loop): jump to target and fade in
                                const targetSample = this.pendingSeekSample;
                                this.pendingSeekSample = null;
                                this.justTeleported = true; // 🦋 "I just arrived via teleport!"
                                // if (DEBUG_WORKLET) console.log(`🎯 WORKLET: Fade-out complete, jumping to ${targetSample.toLocaleString()} and fading in`);
                                if (this.seekToPositionInstant(targetSample)) {
                                    // Jump successful - fade in if we're playing
                                    if (this.isPlaying) {
                                        this.startFade(+1, this.fadeTimeMs);
                                    }
                                }
                            } else {
                                // No pending seek - check if we're at a boundary
                                const isFullFileLoop = (this.selectionStart === null || this.selectionEnd === null);
                                const loopEndSample = isFullFileLoop 
                                    ? this.samplesInBuffer 
                                    : Math.floor(this.selectionEnd * this.sampleRate);
                                
                                if (this.totalSamplesConsumed >= loopEndSample) {
                                    // At boundary - handle loop or stop
                                    if (this.isLooping) {
                                        // Loop: jump to start and fade in
                                        const loopTargetSample = isFullFileLoop ? 0 : Math.floor(this.selectionStart * this.sampleRate);
                                        if (DEBUG_WORKLET) console.log(`🔄 WORKLET: Fade-out complete at boundary, looping to ${loopTargetSample.toLocaleString()}`);
                                        if (this.seekToPositionInstant(loopTargetSample)) {
                                            this.startFade(+1, this.fadeTimeMs);
                                            this.loopWarningShown = false;
                                        }
                                    } else {
                                        // Not looping: stop at end
                                        this.isPlaying = false;
                                        const stopPosition = isFullFileLoop 
                                            ? (this.samplesInBuffer / this.sampleRate) 
                                            : this.selectionEnd;
                                        this.port.postMessage({ 
                                            type: 'selection-end-reached',
                                            position: stopPosition
                                        });
                                        if (DEBUG_WORKLET) console.log('⏹️ WORKLET: Fade-out complete at boundary, stopped');
                                    }
                                } else {
                                    // No pending seek, not at boundary - must be pause
                                    this.isPlaying = false;
                                    this.port.postMessage({ type: 'fade-complete', action: 'pause' });
                                    if (DEBUG_WORKLET) console.log('⏸️ WORKLET: Fade-out complete, paused');
                                }
                            }
                        } else {
                            // 🦋 FADE-IN COMPLETION: Clear the teleport flag!
                            this.justTeleported = false;
                            // if (DEBUG_WORKLET) console.log('✅ WORKLET: Fade-in complete, cleared justTeleported flag');
                        }
                        // Fade-in completion: nothing special needed, just continue playing
                    }
                }
            }
        }
        
        // Update position and metrics (delegated to clean methods)
        this.updatePosition(128);
        this.updateMetrics();
        
        // ===== OSCILLOSCOPE DATA =====
        // Send samples to main thread for real-time waveform visualization
        this.oscilloscopeCounter++;
        if (this.oscilloscopeCounter >= this.oscilloscopeInterval) {
            this.oscilloscopeCounter = 0;
            
            // Copy current output to oscilloscope buffer
            for (let i = 0; i < Math.min(channel.length, this.oscilloscopeBuffer.length); i++) {
                this.oscilloscopeBuffer[i] = channel[i];
            }
            
            // Send to main thread (use structured clone to avoid transferring)
            this.port.postMessage({
                type: 'oscilloscope',
                samples: this.oscilloscopeBuffer.slice(0, channel.length)
            });
        }
        
        return true;
    }
}

registerProcessor('audio-processor', AudioProcessor);

