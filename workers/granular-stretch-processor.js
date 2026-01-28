/**
 * GranularStretchProcessor - Granular synthesis time stretching
 *
 * Algorithm:
 * 1. Extract small "grains" (chunks) from source audio
 * 2. Apply window envelope to each grain
 * 3. Overlap grains at output with crossfading
 * 4. To stretch: read grains slowly, output at normal rate
 *
 * This creates a different texture than FFT - more "grainy" but
 * preserves transients and original character differently.
 */

class GranularStretchProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        console.log('🌾 GranularStretchProcessor constructor called');

        // Parameters
        this.stretchFactor = options.processorOptions?.stretchFactor || 8.0;
        this.grainSize = options.processorOptions?.grainSize || 2048; // ~46ms at 44.1kHz
        this.overlap = options.processorOptions?.overlap || 0.75; // 75% overlap = 4 grains playing at once
        this.scatter = options.processorOptions?.scatter || 0.1; // Random position jitter (0-1)

        // Audio source
        this.sourceBuffer = null;
        this.sourcePosition = 0;
        this.isPlaying = false;

        // Output buffer
        this.outputBuffer = new Float32Array(131072);
        this.outputReadPos = 0;
        this.outputWritePos = 0;

        // Grain scheduling
        this.grainInterval = Math.floor(this.grainSize * (1 - this.overlap));
        this.samplesUntilNextGrain = 0;

        // Gain compensation: more overlap = more grains summing = need lower gain
        // Use square root for gentler scaling that doesn't get too quiet
        this.grainGain = Math.sqrt((1 - this.overlap) * 2);

        // Fade-in/out to avoid clicks
        this.fadeInLength = 1102; // ~25ms at 44.1kHz
        this.fadeOutLength = 1102; // ~25ms
        this.fadeInRemaining = 0;
        this.fadeOutRemaining = 0;
        this.pendingSeekPosition = null;

        // Precompute grain window (Hann)
        this.grainWindow = new Float32Array(this.grainSize);
        this.updateGrainWindow();

        this.setupMessageHandler();
    }

    updateGrainWindow() {
        for (let i = 0; i < this.grainSize; i++) {
            this.grainWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / this.grainSize));
        }
    }

    setupMessageHandler() {
        this.port.onmessage = (event) => {
            const { type, data } = event.data;
            console.log(`🌾 Granular received: ${type}`);

            switch (type) {
                case 'load-audio':
                    this.sourceBuffer = new Float32Array(data.samples);
                    this.sourcePosition = 0;
                    this.resetBuffers();
                    this.port.postMessage({ type: 'loaded', duration: data.samples.length / sampleRate });
                    break;

                case 'play':
                    this.isPlaying = true;
                    this.fadeInRemaining = this.fadeInLength;
                    break;

                case 'pause':
                    this.isPlaying = false;
                    break;

                case 'seek':
                    if (this.isPlaying) {
                        this.fadeOutRemaining = this.fadeOutLength;
                        this.pendingSeekPosition = Math.floor(data.position * sampleRate);
                        if (this.sourceBuffer) {
                            this.pendingSeekPosition = Math.max(0, Math.min(this.pendingSeekPosition, this.sourceBuffer.length - 1));
                        }
                    } else {
                        this.sourcePosition = Math.floor(data.position * sampleRate);
                        if (this.sourceBuffer) {
                            this.sourcePosition = Math.max(0, Math.min(this.sourcePosition, this.sourceBuffer.length - 1));
                        }
                        this.resetBuffers();
                        this.fadeInRemaining = this.fadeInLength;
                    }
                    break;

                case 'set-stretch':
                    this.stretchFactor = data.factor;
                    break;

                case 'set-grain-size':
                    this.grainSize = data.size;
                    this.grainInterval = Math.floor(this.grainSize * (1 - this.overlap));
                    this.grainWindow = new Float32Array(this.grainSize);
                    this.updateGrainWindow();
                    console.log(`🌾 Grain size: ${this.grainSize}, grainInterval: ${this.grainInterval}`);
                    break;

                case 'set-overlap':
                    this.overlap = data.overlap;
                    this.grainInterval = Math.floor(this.grainSize * (1 - this.overlap));
                    this.grainGain = Math.sqrt((1 - this.overlap) * 2);
                    console.log(`🌾 Overlap: ${this.overlap}, grainInterval: ${this.grainInterval}, grainGain: ${this.grainGain.toFixed(3)}`);
                    break;

                case 'set-scatter':
                    this.scatter = data.scatter;
                    break;
            }
        };
    }

    resetBuffers() {
        this.outputBuffer.fill(0);
        this.outputReadPos = 0;
        this.outputWritePos = 0;
        this.samplesUntilNextGrain = 0;
    }

    // Spawn a grain at the current source position
    spawnGrain() {
        if (!this.sourceBuffer) return false;

        // Calculate grain read position with optional scatter
        let grainStart = Math.floor(this.sourcePosition);

        // Add random scatter (jitter in grain position)
        if (this.scatter > 0) {
            const maxScatter = this.grainSize * this.scatter;
            const scatterOffset = (Math.random() - 0.5) * 2 * maxScatter;
            grainStart = Math.floor(grainStart + scatterOffset);
        }

        // Clamp to valid range
        grainStart = Math.max(0, Math.min(grainStart, this.sourceBuffer.length - this.grainSize));

        // Check if we have enough source left
        if (grainStart + this.grainSize > this.sourceBuffer.length) {
            return false; // End of source
        }

        // Add grain to output buffer with window and gain compensation
        const outputLen = this.outputBuffer.length;
        for (let i = 0; i < this.grainSize; i++) {
            const sample = this.sourceBuffer[grainStart + i] * this.grainWindow[i] * this.grainGain;
            const outIdx = (this.outputWritePos + i) % outputLen;
            this.outputBuffer[outIdx] += sample;
        }

        // Advance source position (slowly for stretching)
        // grainInterval samples of output = grainInterval/stretchFactor samples of input
        const inputAdvance = this.grainInterval / this.stretchFactor;
        this.sourcePosition += inputAdvance;

        // Advance output write position
        this.outputWritePos = (this.outputWritePos + this.grainInterval) % outputLen;

        return true;
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0];
        if (!output || output.length === 0) return true;

        const channel = output[0];
        if (!channel) return true;

        if (!this.sourceBuffer || !this.isPlaying) {
            channel.fill(0);
            return true;
        }

        // Spawn grains as needed to keep output buffer filled
        while (this.needsMoreOutput()) {
            if (!this.spawnGrain()) {
                this.isPlaying = false;
                this.port.postMessage({ type: 'ended' });
                break;
            }
        }

        // Read from output buffer with fade handling
        const outputLen = this.outputBuffer.length;
        for (let i = 0; i < channel.length; i++) {
            let sample = this.outputBuffer[this.outputReadPos];
            this.outputBuffer[this.outputReadPos] = 0; // Clear after reading
            this.outputReadPos = (this.outputReadPos + 1) % outputLen;

            // Apply fade-out
            if (this.fadeOutRemaining > 0) {
                const fadeProgress = this.fadeOutRemaining / this.fadeOutLength;
                sample *= fadeProgress * fadeProgress;
                this.fadeOutRemaining--;

                if (this.fadeOutRemaining === 0 && this.pendingSeekPosition !== null) {
                    this.sourcePosition = this.pendingSeekPosition;
                    this.pendingSeekPosition = null;
                    this.resetBuffers();
                    this.fadeInRemaining = this.fadeInLength;
                }
            }
            // Apply fade-in
            else if (this.fadeInRemaining > 0) {
                const fadeProgress = 1 - (this.fadeInRemaining / this.fadeInLength);
                sample *= fadeProgress * fadeProgress;
                this.fadeInRemaining--;
            }

            channel[i] = sample;
        }

        return true;
    }

    needsMoreOutput() {
        const outputLen = this.outputBuffer.length;
        let available = this.outputWritePos - this.outputReadPos;
        if (available < 0) available += outputLen;
        return available < 2048;
    }
}

registerProcessor('granular-stretch-processor', GranularStretchProcessor);
