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

        // Fade-in/out to avoid clicks
        this.fadeInLength = 1102; // ~25ms at 44.1kHz
        this.fadeOutLength = 1102; // ~25ms
        this.fadeInRemaining = 0;
        this.fadeOutRemaining = 0;
        this.pendingSeekPosition = null;
        this.pendingPause = false;

        this.setupMessageHandler();
    }

    setupMessageHandler() {
        this.port.onmessage = (event) => {
            const { type, data } = event.data;
            console.log(`🔄 Resample received: ${type}`);

            switch (type) {
                case 'load-audio':
                    // Accept transferred Float32Array directly, or convert from plain array
                    this.sourceBuffer = (data.samples instanceof Float32Array) ? data.samples : new Float32Array(data.samples);
                    this.sourcePosition = 0;
                    this.port.postMessage({ type: 'loaded', duration: data.samples.length / sampleRate });
                    break;

                case 'play':
                    this.isPlaying = true;
                    this.fadeInRemaining = this.fadeInLength;
                    break;

                case 'pause':
                    if (this.isPlaying) {
                        this.fadeOutRemaining = this.fadeOutLength;
                        this.pendingSeekPosition = null;
                        this.pendingPause = true;
                    }
                    break;

                case 'seek':
                    if (this.isPlaying) {
                        // Fade out first, then seek
                        this.fadeOutRemaining = this.fadeOutLength;
                        this.pendingSeekPosition = Math.floor(data.position * sampleRate);
                        if (this.sourceBuffer) {
                            this.pendingSeekPosition = Math.max(0, Math.min(this.pendingSeekPosition, this.sourceBuffer.length - 1));
                        }
                    } else {
                        // Not playing, seek immediately
                        this.sourcePosition = Math.floor(data.position * sampleRate);
                        if (this.sourceBuffer) {
                            this.sourcePosition = Math.max(0, Math.min(this.sourcePosition, this.sourceBuffer.length - 1));
                        }
                        this.fadeInRemaining = this.fadeInLength;
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

            let sample = 0;

            if (intPos >= this.sourceBuffer.length - 1) {
                // End of source
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
                sample = sample0 + frac * (sample1 - sample0);
            }

            // Apply fade-out
            if (this.fadeOutRemaining > 0) {
                const fadeProgress = this.fadeOutRemaining / this.fadeOutLength;
                sample *= fadeProgress * fadeProgress;
                this.fadeOutRemaining--;

                // When fade-out completes, apply pending seek
                if (this.fadeOutRemaining === 0) {
                    if (this.pendingPause) {
                        this.isPlaying = false;
                        this.pendingPause = false;
                        for (let j = i; j < channel.length; j++) {
                            channel[j] = 0;
                        }
                        return true;
                    }
                    if (this.pendingSeekPosition !== null) {
                        this.sourcePosition = this.pendingSeekPosition;
                        this.pendingSeekPosition = null;
                        this.fadeInRemaining = this.fadeInLength;
                        // Don't advance position this frame
                        channel[i] = 0;
                        continue;
                    }
                }
            }
            // Apply fade-in
            else if (this.fadeInRemaining > 0) {
                const fadeProgress = 1 - (this.fadeInRemaining / this.fadeInLength);
                sample *= fadeProgress * fadeProgress;
                this.fadeInRemaining--;
            }

            channel[i] = sample;
            this.sourcePosition += readRate;
        }

        return true;
    }
}

registerProcessor('resample-stretch-processor', ResampleStretchProcessor);
