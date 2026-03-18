/**
 * WaveletStretchProcessor — Simple buffer player for GPU-stretched audio.
 *
 * The wavelet phase vocoder stretch is pre-computed on the GPU.
 * This processor just plays the resulting buffer at 1:1 rate.
 * No FFT, no wavelet math — just sequential sample playback with fade handling.
 *
 * When the speed changes, the GPU re-computes the buffer and sends
 * it here via 'load-audio'. Crossfade is handled by the audio-player gain nodes.
 */

class WaveletStretchProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        this.sourceBuffer = null;
        this.sourcePosition = 0;
        this.isPlaying = false;

        // Fade-in/out to avoid clicks
        this.fadeInLength = 1102; // ~25ms at 44.1kHz
        this.fadeOutLength = 1102;
        this.fadeInRemaining = 0;
        this.fadeOutRemaining = 0;
        this.pendingSeekPosition = null;
        this.pendingPause = false;

        // speed is stored for position reporting but doesn't affect playback rate
        // (the buffer is already processed by GPU at the target speed)
        this.speed = options.processorOptions?.speed || 1.0;

        this.setupMessageHandler();
    }

    setupMessageHandler() {
        this.port.onmessage = (event) => {
            const { type, data } = event.data;

            switch (type) {
                case 'load-audio':
                    this.sourceBuffer = (data.samples instanceof Float32Array)
                        ? data.samples
                        : new Float32Array(data.samples);
                    this.sourcePosition = 0;
                    this.port.postMessage({
                        type: 'loaded',
                        duration: this.sourceBuffer.length / sampleRate
                    });
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
                        this.fadeOutRemaining = this.fadeOutLength;
                        this.pendingSeekPosition = Math.floor(data.position * sampleRate);
                        if (this.sourceBuffer) {
                            this.pendingSeekPosition = Math.max(0,
                                Math.min(this.pendingSeekPosition, this.sourceBuffer.length - 1));
                        }
                    } else {
                        this.sourcePosition = Math.floor(data.position * sampleRate);
                        if (this.sourceBuffer) {
                            this.sourcePosition = Math.max(0,
                                Math.min(this.sourcePosition, this.sourceBuffer.length - 1));
                        }
                        this.fadeInRemaining = this.fadeInLength;
                    }
                    break;

                case 'set-speed':
                    // Store for position tracking; doesn't change playback rate
                    // (the buffer itself is re-computed by GPU when speed changes)
                    this.speed = data.speed;
                    break;

                // No-ops for compatibility with shared message protocol
                case 'set-window-size':
                case 'set-grain-size':
                case 'set-overlap':
                case 'set-scatter':
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

        for (let i = 0; i < channel.length; i++) {
            const pos = this.sourcePosition;

            if (pos >= this.sourceBuffer.length) {
                this.isPlaying = false;
                this.port.postMessage({ type: 'ended' });
                for (let j = i; j < channel.length; j++) {
                    channel[j] = 0;
                }
                break;
            }

            let sample = this.sourceBuffer[pos];

            // Apply fade-out
            if (this.fadeOutRemaining > 0) {
                const fadeProgress = this.fadeOutRemaining / this.fadeOutLength;
                sample *= fadeProgress * fadeProgress;
                this.fadeOutRemaining--;

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
            this.sourcePosition++;
        }

        return true;
    }
}

registerProcessor('wavelet-stretch-processor', WaveletStretchProcessor);
