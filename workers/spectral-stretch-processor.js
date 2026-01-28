/**
 * SpectralStretchProcessor - FFT-based time stretching with phase randomization
 *
 * Algorithm (from first principles):
 * 1. Window the input with a Hann window
 * 2. FFT to frequency domain
 * 3. Keep magnitudes, randomize phases
 * 4. IFFT back to time domain
 * 5. Overlap-add with stretched hop size
 *
 * This creates smooth, ambient time-stretching without pitch change.
 */

class SpectralStretchProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        console.log('🎛️ SpectralStretchProcessor constructor called');
        console.log('🎛️ Options:', JSON.stringify(options));

        // Default parameters
        this.windowSize = options.processorOptions?.windowSize || 4096;
        this.stretchFactor = options.processorOptions?.stretchFactor || 8.0;
        this.overlap = options.processorOptions?.overlap || 0.9; // 90% overlap for smooth output

        console.log(`🎛️ Window size: ${this.windowSize}, Stretch factor: ${this.stretchFactor}, Overlap: ${this.overlap}`);

        // Derived values
        // For time-stretching: read input SLOWLY, write output at normal rate
        // Higher overlap = smoother output (less pulsing from random phases)
        this.halfWindow = this.windowSize / 2;
        this.outputHop = Math.max(1, Math.floor(this.windowSize * (1 - this.overlap))); // e.g., 87.5% overlap = hop of windowSize/8
        this.inputHop = Math.max(1, Math.floor(this.outputHop / this.stretchFactor)); // Read input even slower

        console.log(`🎛️ inputHop: ${this.inputHop}, outputHop: ${this.outputHop}`);

        // Buffers
        this.inputBuffer = new Float32Array(this.windowSize);
        this.outputBuffer = new Float32Array(this.windowSize * 4); // Extra space for overlap-add
        this.inputWritePos = 0;
        this.outputReadPos = 0;
        this.outputWritePos = 0;

        // Precompute Hann window
        this.hannWindow = new Float32Array(this.windowSize);
        for (let i = 0; i < this.windowSize; i++) {
            this.hannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / this.windowSize));
        }

        // FFT working arrays
        this.fftReal = new Float32Array(this.windowSize);
        this.fftImag = new Float32Array(this.windowSize);

        // Precompute bit-reversal table and twiddle factors for FFT
        this.bitReversal = this.computeBitReversal(this.windowSize);
        this.twiddleReal = new Float32Array(this.halfWindow);
        this.twiddleImag = new Float32Array(this.halfWindow);
        for (let i = 0; i < this.halfWindow; i++) {
            const angle = -2 * Math.PI * i / this.windowSize;
            this.twiddleReal[i] = Math.cos(angle);
            this.twiddleImag[i] = Math.sin(angle);
        }

        // Audio source buffer (loaded via message)
        this.sourceBuffer = null;
        this.sourcePosition = 0;
        this.isPlaying = false;

        // Fade-in/out to avoid hard edge artifacts at start/seek
        this.fadeInLength = 2205; // ~50ms at 44.1kHz
        this.fadeOutLength = 1102; // ~25ms fade-out

        // Pre-roll: number of blocks to process before outputting after seek
        // This "warms up" the overlap-add so it sounds smooth immediately
        // Need enough blocks so we can skip to a position with full overlap
        this.preRollBlocks = 12; // Process 12 windows before outputting
        this.preRollRemaining = 0;
        this.fadeInRemaining = 0;
        this.fadeOutRemaining = 0;
        this.pendingSeekPosition = null; // Deferred seek while fading out

        // Output normalization - more overlap = more windows summing = need lower gain
        // Use sqrt for gentler scaling (matches granular processor approach)
        this.outputGain = Math.sqrt((1 - this.overlap) * 2); // ~0.45 at 90% overlap

        this.setupMessageHandler();
    }

    setupMessageHandler() {
        console.log('🎛️ Setting up message handler');
        this.port.onmessage = (event) => {
            const { type, data } = event.data;
            console.log(`📨 Worklet received message: ${type}`, data ? JSON.stringify(data).slice(0, 100) : '');

            switch (type) {
                case 'load-audio':
                    console.log(`📨 Loading audio: ${data.samples.length} samples`);
                    this.sourceBuffer = new Float32Array(data.samples);
                    this.sourcePosition = 0;
                    this.resetBuffers();
                    console.log(`📨 Source buffer created. First 5 samples: ${Array.from(this.sourceBuffer.slice(0, 5))}`);
                    console.log(`📨 Sample rate: ${sampleRate}`);
                    this.port.postMessage({ type: 'loaded', duration: data.samples.length / sampleRate });
                    break;

                case 'play':
                    console.log('▶️ PLAY command received');
                    this.isPlaying = true;
                    // Pre-roll if starting fresh (buffers are empty)
                    if (this.outputWritePos === this.outputReadPos) {
                        this.preRollRemaining = this.preRollBlocks;
                    }
                    this.fadeInRemaining = this.fadeInLength;
                    console.log(`▶️ isPlaying = ${this.isPlaying}, preRoll: ${this.preRollRemaining}`);
                    break;

                case 'pause':
                    console.log('⏸️ PAUSE command received');
                    this.isPlaying = false;
                    break;

                case 'seek':
                    // Calculate target position
                    let targetPos = Math.floor(data.position * sampleRate);
                    if (this.sourceBuffer) {
                        targetPos = Math.max(0, Math.min(targetPos, this.sourceBuffer.length - 1));
                    }

                    if (this.isPlaying) {
                        // Fade out first, then seek when fade completes
                        this.fadeOutRemaining = this.fadeOutLength;
                        this.pendingSeekPosition = targetPos;
                        console.log(`⏩ Seek requested while playing, fading out first. Target: ${targetPos}`);
                    } else {
                        // Not playing, seek immediately
                        this.sourcePosition = targetPos;
                        this.resetBuffers();
                        this.inputWritePos = 0;
                        // Pre-roll to warm up overlap-add before outputting
                        this.preRollRemaining = this.preRollBlocks;
                        this.fadeInRemaining = this.fadeInLength;
                        console.log(`⏩ Seek to position: ${this.sourcePosition}, preRoll: ${this.preRollRemaining}`);
                    }
                    break;

                case 'set-stretch':
                    this.stretchFactor = data.factor;
                    this.inputHop = Math.max(1, Math.floor(this.outputHop / this.stretchFactor));
                    console.log(`🔄 Stretch factor: ${this.stretchFactor}, inputHop: ${this.inputHop}, outputHop: ${this.outputHop}`);
                    break;

                case 'set-window-size':
                    // Reinitialize with new window size
                    this.windowSize = data.size;
                    this.halfWindow = this.windowSize / 2;
                    this.outputHop = Math.max(1, Math.floor(this.windowSize * (1 - this.overlap)));
                    this.inputHop = Math.max(1, Math.floor(this.outputHop / this.stretchFactor));
                    this.reinitializeBuffers();
                    console.log(`📐 Window size: ${this.windowSize}, inputHop: ${this.inputHop}, outputHop: ${this.outputHop}`);
                    break;

                case 'set-overlap':
                    this.overlap = data.overlap;
                    this.outputHop = Math.max(1, Math.floor(this.windowSize * (1 - this.overlap)));
                    this.inputHop = Math.max(1, Math.floor(this.outputHop / this.stretchFactor));
                    this.outputGain = Math.sqrt((1 - this.overlap) * 2);
                    console.log(`🔀 Overlap: ${this.overlap}, outputHop: ${this.outputHop}, gain: ${this.outputGain.toFixed(3)}`);
                    break;
            }
        };
    }

    resetBuffers() {
        this.inputBuffer.fill(0);
        this.outputBuffer.fill(0);
        this.inputWritePos = 0;
        this.outputReadPos = 0;
        this.outputWritePos = 0;
    }

    reinitializeBuffers() {
        this.inputBuffer = new Float32Array(this.windowSize);
        this.outputBuffer = new Float32Array(this.windowSize * 4);

        this.hannWindow = new Float32Array(this.windowSize);
        for (let i = 0; i < this.windowSize; i++) {
            this.hannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / this.windowSize));
        }

        this.fftReal = new Float32Array(this.windowSize);
        this.fftImag = new Float32Array(this.windowSize);
        this.bitReversal = this.computeBitReversal(this.windowSize);

        this.twiddleReal = new Float32Array(this.halfWindow);
        this.twiddleImag = new Float32Array(this.halfWindow);
        for (let i = 0; i < this.halfWindow; i++) {
            const angle = -2 * Math.PI * i / this.windowSize;
            this.twiddleReal[i] = Math.cos(angle);
            this.twiddleImag[i] = Math.sin(angle);
        }

        this.resetBuffers();
    }

    // ===== FFT IMPLEMENTATION (Cooley-Tukey radix-2) =====

    computeBitReversal(n) {
        const bits = Math.log2(n);
        const reversal = new Uint32Array(n);
        for (let i = 0; i < n; i++) {
            let reversed = 0;
            let x = i;
            for (let j = 0; j < bits; j++) {
                reversed = (reversed << 1) | (x & 1);
                x >>= 1;
            }
            reversal[i] = reversed;
        }
        return reversal;
    }

    fft(real, imag) {
        const n = this.windowSize;

        // Bit-reversal permutation
        for (let i = 0; i < n; i++) {
            const j = this.bitReversal[i];
            if (i < j) {
                [real[i], real[j]] = [real[j], real[i]];
                [imag[i], imag[j]] = [imag[j], imag[i]];
            }
        }

        // Cooley-Tukey iterative FFT
        for (let size = 2; size <= n; size *= 2) {
            const halfSize = size / 2;
            const step = n / size;

            for (let i = 0; i < n; i += size) {
                for (let j = 0; j < halfSize; j++) {
                    const twiddleIdx = j * step;
                    const wr = this.twiddleReal[twiddleIdx];
                    const wi = this.twiddleImag[twiddleIdx];

                    const idx1 = i + j;
                    const idx2 = i + j + halfSize;

                    const tr = wr * real[idx2] - wi * imag[idx2];
                    const ti = wr * imag[idx2] + wi * real[idx2];

                    real[idx2] = real[idx1] - tr;
                    imag[idx2] = imag[idx1] - ti;
                    real[idx1] = real[idx1] + tr;
                    imag[idx1] = imag[idx1] + ti;
                }
            }
        }
    }

    ifft(real, imag) {
        const n = this.windowSize;

        // Conjugate
        for (let i = 0; i < n; i++) {
            imag[i] = -imag[i];
        }

        // Forward FFT
        this.fft(real, imag);

        // Conjugate and scale
        for (let i = 0; i < n; i++) {
            real[i] /= n;
            imag[i] = -imag[i] / n;
        }
    }

    // ===== SPECTRAL STRETCH CORE =====

    processStretchBlock() {
        this.blockCount = (this.blockCount || 0) + 1;
        const n = this.windowSize;

        // Apply Hann window and copy to FFT buffers
        let inputMax = 0;
        for (let i = 0; i < n; i++) {
            this.fftReal[i] = this.inputBuffer[i] * this.hannWindow[i];
            this.fftImag[i] = 0;
            inputMax = Math.max(inputMax, Math.abs(this.fftReal[i]));
        }

        // Forward FFT
        this.fft(this.fftReal, this.fftImag);

        // Log FFT result occasionally
        if (this.blockCount <= 3 || this.blockCount % 100 === 0) {
            const fftMax = Math.max(...Array.from(this.fftReal.slice(0, 100)).map(Math.abs));
            console.log(`🔬 Block ${this.blockCount}: inputMax=${inputMax.toFixed(4)}, fftMax=${fftMax.toFixed(4)}`);
        }

        // Randomize phases while preserving magnitudes AND conjugate symmetry
        // For real-valued output, we must maintain: bin[k] = conjugate(bin[N-k])
        const halfN = n / 2;

        // DC bin (0) - keep phase at 0, just preserve magnitude
        // (it's already real-only from a real input)

        // Nyquist bin (N/2) - keep phase at 0
        // (also real-only for real input)

        // Bins 1 to N/2-1: randomize phase, then set conjugate mirror
        for (let i = 1; i < halfN; i++) {
            const mag = Math.sqrt(this.fftReal[i] * this.fftReal[i] + this.fftImag[i] * this.fftImag[i]);
            const randomPhase = Math.random() * 2 * Math.PI;

            // Set bin i with random phase
            this.fftReal[i] = mag * Math.cos(randomPhase);
            this.fftImag[i] = mag * Math.sin(randomPhase);

            // Set conjugate mirror bin (N-i) - same magnitude, negated imaginary
            const mirrorIdx = n - i;
            const mirrorMag = Math.sqrt(this.fftReal[mirrorIdx] * this.fftReal[mirrorIdx] + this.fftImag[mirrorIdx] * this.fftImag[mirrorIdx]);
            this.fftReal[mirrorIdx] = mirrorMag * Math.cos(randomPhase);
            this.fftImag[mirrorIdx] = -mirrorMag * Math.sin(randomPhase); // Conjugate = negate imaginary
        }

        // Inverse FFT
        this.ifft(this.fftReal, this.fftImag);

        // Log IFFT result occasionally
        if (this.blockCount <= 3 || this.blockCount % 100 === 0) {
            const ifftMax = Math.max(...Array.from(this.fftReal.slice(0, 100)).map(Math.abs));
            console.log(`🔬 Block ${this.blockCount}: ifftMax=${ifftMax.toFixed(4)}, outputWritePos=${this.outputWritePos}`);
        }

        // Apply Hann window again (synthesis window) and overlap-add to output
        const outputLen = this.outputBuffer.length;
        for (let i = 0; i < n; i++) {
            const outIdx = (this.outputWritePos + i) % outputLen;
            this.outputBuffer[outIdx] += this.fftReal[i] * this.hannWindow[i] * this.outputGain;
        }

        // Advance output write position by output hop
        this.outputWritePos = (this.outputWritePos + this.outputHop) % outputLen;
    }

    // ===== AUDIO PROCESSING =====

    process(inputs, outputs, parameters) {
        this.processCount = (this.processCount || 0) + 1;

        const output = outputs[0];
        if (!output || output.length === 0) {
            if (this.processCount % 1000 === 0) console.log('🔇 No output array');
            return true;
        }

        const channel = output[0];
        if (!channel) {
            if (this.processCount % 1000 === 0) console.log('🔇 No channel');
            return true;
        }

        // If no source loaded or not playing, output silence
        if (!this.sourceBuffer || !this.isPlaying) {
            if (this.processCount % 1000 === 0) {
                console.log(`🔇 Silent: sourceBuffer=${!!this.sourceBuffer}, isPlaying=${this.isPlaying}`);
            }
            channel.fill(0);
            return true;
        }

        // Log every 100 process calls when playing
        if (this.processCount % 100 === 0) {
            console.log(`🎵 process() #${this.processCount}: sourcePos=${this.sourcePosition}/${this.sourceBuffer.length}, outputRead=${this.outputReadPos}, outputWrite=${this.outputWritePos}`);
        }

        let blocksProcessed = 0;
        const wasInPreRoll = this.preRollRemaining > 0;

        // Handle pre-roll: process blocks without outputting to warm up overlap-add
        while (this.preRollRemaining > 0 && this.sourcePosition < this.sourceBuffer.length) {
            // Fill input buffer (same logic as main loop)
            if (this.inputWritePos === 0) {
                for (let k = 0; k < this.windowSize && this.sourcePosition + k < this.sourceBuffer.length; k++) {
                    this.inputBuffer[k] = this.sourceBuffer[this.sourcePosition + k];
                }
                this.sourcePosition += this.inputHop;
                this.inputWritePos = this.windowSize;
            } else {
                for (let k = 0; k < this.windowSize - this.inputHop; k++) {
                    this.inputBuffer[k] = this.inputBuffer[k + this.inputHop];
                }
                for (let k = 0; k < this.inputHop && this.sourcePosition < this.sourceBuffer.length; k++) {
                    this.inputBuffer[this.windowSize - this.inputHop + k] = this.sourceBuffer[this.sourcePosition++];
                }
            }
            this.processStretchBlock();
            this.preRollRemaining--;
            blocksProcessed++;
        }

        // After pre-roll completes, skip to where we have full overlap coverage
        // With ~10 windows overlap at 90%, skip forward by (preRollBlocks - 10) * outputHop
        if (wasInPreRoll && this.preRollRemaining === 0) {
            const numOverlapWindows = Math.ceil(this.windowSize / this.outputHop);
            const skipBlocks = Math.max(0, this.preRollBlocks - numOverlapWindows);
            const skipSamples = skipBlocks * this.outputHop;
            this.outputReadPos = skipSamples % this.outputBuffer.length;
            console.log(`🎯 Pre-roll complete. Skipping ${skipSamples} samples (${skipBlocks} blocks) to full overlap position`);
        }

        // Fill output buffer by processing source audio
        for (let i = 0; i < channel.length; i++) {
            // Check if we need to process more input
            while (this.needsMoreOutput()) {
                // Read input samples
                if (this.sourcePosition < this.sourceBuffer.length) {
                    // Fill input buffer
                    for (let j = 0; j < this.inputHop && this.sourcePosition < this.sourceBuffer.length; j++) {
                        // Shift input buffer left by inputHop
                        if (this.inputWritePos === 0) {
                            // First fill - fill entire buffer
                            console.log(`📥 First fill: windowSize=${this.windowSize}, sourcePos=${this.sourcePosition}`);
                            for (let k = 0; k < this.windowSize && this.sourcePosition + k < this.sourceBuffer.length; k++) {
                                this.inputBuffer[k] = this.sourceBuffer[this.sourcePosition + k];
                            }
                            this.sourcePosition += this.inputHop;
                            this.inputWritePos = this.windowSize;
                            break;
                        } else {
                            // Shift and add new samples
                            for (let k = 0; k < this.windowSize - this.inputHop; k++) {
                                this.inputBuffer[k] = this.inputBuffer[k + this.inputHop];
                            }
                            for (let k = 0; k < this.inputHop && this.sourcePosition < this.sourceBuffer.length; k++) {
                                this.inputBuffer[this.windowSize - this.inputHop + k] = this.sourceBuffer[this.sourcePosition++];
                            }
                            break;
                        }
                    }

                    // Process this block
                    this.processStretchBlock();
                    blocksProcessed++;
                } else {
                    // End of source - stop
                    console.log(`🛑 END OF SOURCE: sourcePosition=${this.sourcePosition}, sourceBuffer.length=${this.sourceBuffer.length}`);
                    this.isPlaying = false;
                    this.port.postMessage({ type: 'ended' });
                    break;
                }
            }

            // Read from output buffer
            const outputLen = this.outputBuffer.length;
            let sample = this.outputBuffer[this.outputReadPos];

            // Apply fade-out envelope (when seeking while playing)
            if (this.fadeOutRemaining > 0) {
                const fadeProgress = this.fadeOutRemaining / this.fadeOutLength;
                sample *= fadeProgress * fadeProgress; // Quadratic fade-out
                this.fadeOutRemaining--;

                // When fade-out completes, apply the pending seek
                if (this.fadeOutRemaining === 0 && this.pendingSeekPosition !== null) {
                    this.sourcePosition = this.pendingSeekPosition;
                    this.pendingSeekPosition = null;
                    this.resetBuffers();
                    this.inputWritePos = 0;
                    this.preRollRemaining = this.preRollBlocks; // Warm up overlap-add
                    this.fadeInRemaining = this.fadeInLength;
                    console.log(`⏩ Fade-out complete, seeking to: ${this.sourcePosition}, preRoll: ${this.preRollRemaining}`);
                    // Fill rest with silence and return - next frame will have pre-roll
                    for (let j = i; j < channel.length; j++) {
                        channel[j] = 0;
                    }
                    return true;
                }
            }
            // Apply fade-in envelope to avoid hard edge artifacts
            else if (this.fadeInRemaining > 0) {
                const fadeProgress = 1 - (this.fadeInRemaining / this.fadeInLength);
                sample *= fadeProgress * fadeProgress; // Quadratic ease-in for smoother fade
                this.fadeInRemaining--;
            }

            channel[i] = sample;
            this.outputBuffer[this.outputReadPos] = 0; // Clear after reading
            this.outputReadPos = (this.outputReadPos + 1) % outputLen;
        }

        // Log output sample stats
        if (this.processCount % 100 === 0) {
            const maxSample = Math.max(...Array.from(channel).map(Math.abs));
            console.log(`🔊 Output: blocks=${blocksProcessed}, maxSample=${maxSample.toFixed(4)}`);
        }

        return true;
    }

    needsMoreOutput() {
        // Calculate how many samples are available in output buffer
        const outputLen = this.outputBuffer.length;
        let available = this.outputWritePos - this.outputReadPos;
        if (available < 0) available += outputLen;

        const needMore = available < 256;

        // Log occasionally
        if (this.processCount % 500 === 0) {
            console.log(`📊 needsMoreOutput: available=${available}, outputLen=${outputLen}, readPos=${this.outputReadPos}, writePos=${this.outputWritePos}, need=${needMore}`);
        }

        return needMore;
    }
}

registerProcessor('spectral-stretch-processor', SpectralStretchProcessor);
