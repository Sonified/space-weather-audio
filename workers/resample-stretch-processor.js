/**
 * ResampleStretchProcessor - Simple resampling time stretch
 *
 * This is the simplest form of time stretching - just read samples
 * at a slower rate. This changes both duration AND pitch together
 * (like playing a vinyl record at the wrong speed).
 *
 * stretchFactor of 8 = 8x longer, pitch drops ~3 octaves
 */

class ResampleStretchProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        console.log('🔄 ResampleStretchProcessor constructor called');

        this.stretchFactor = options.processorOptions?.stretchFactor || 8.0;

        // Audio source
        this.sourceBuffer = null;
        this.sourcePosition = 0; // Fractional position for interpolation
        this.isPlaying = false;

        this.setupMessageHandler();
    }

    setupMessageHandler() {
        this.port.onmessage = (event) => {
            const { type, data } = event.data;
            console.log(`🔄 Resample received: ${type}`);

            switch (type) {
                case 'load-audio':
                    this.sourceBuffer = new Float32Array(data.samples);
                    this.sourcePosition = 0;
                    this.port.postMessage({ type: 'loaded', duration: data.samples.length / sampleRate });
                    break;

                case 'play':
                    this.isPlaying = true;
                    break;

                case 'pause':
                    this.isPlaying = false;
                    break;

                case 'seek':
                    this.sourcePosition = Math.floor(data.position * sampleRate);
                    if (this.sourceBuffer) {
                        this.sourcePosition = Math.max(0, Math.min(this.sourcePosition, this.sourceBuffer.length - 1));
                    }
                    break;

                case 'set-stretch':
                    this.stretchFactor = data.factor;
                    console.log(`🔄 Stretch factor: ${this.stretchFactor}`);
                    break;

                // These don't apply to resample but we handle them to avoid errors
                case 'set-window-size':
                case 'set-grain-size':
                case 'set-overlap':
                    break;
            }
        };
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

        // Read rate: advance by 1/stretchFactor samples per output sample
        const readRate = 1 / this.stretchFactor;

        for (let i = 0; i < channel.length; i++) {
            const pos = this.sourcePosition;
            const intPos = Math.floor(pos);

            if (intPos >= this.sourceBuffer.length - 1) {
                // End of source
                channel[i] = 0;
                if (intPos >= this.sourceBuffer.length) {
                    this.isPlaying = false;
                    this.port.postMessage({ type: 'ended' });
                    // Fill rest with silence
                    for (let j = i; j < channel.length; j++) {
                        channel[j] = 0;
                    }
                    break;
                }
            } else {
                // Linear interpolation for smooth playback
                const frac = pos - intPos;
                const sample0 = this.sourceBuffer[intPos];
                const sample1 = this.sourceBuffer[intPos + 1];
                channel[i] = sample0 + frac * (sample1 - sample0);
            }

            this.sourcePosition += readRate;
        }

        return true;
    }
}

registerProcessor('resample-stretch-processor', ResampleStretchProcessor);
