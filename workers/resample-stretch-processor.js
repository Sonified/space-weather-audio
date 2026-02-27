/**
 * Resample Stretch Processor
 *
 * Normal playback: reads through source buffer at 1/stretchFactor rate.
 * Scrub mode: mouse position → two cascaded one-pole LPFs → read head.
 *
 * WHY TWO POLES:
 * Mouse events arrive at ~60fps (every ~735 samples at 44.1kHz).
 * A single-pole LPF tracks the target position, but its VELOCITY (derivative)
 * jumps discontinuously every time a new mouse event shifts the target.
 * That velocity = playback speed = perceived pitch. Jumpy velocity = JUMP JUMP JUMP.
 *
 * Two cascaded poles: first stage smooths the target into a continuous signal,
 * second stage follows that smooth signal. The velocity of the second stage
 * is always smooth because its input is smooth. No jumps. Clean scrub.
 */

class ResampleStretchProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        const opts = options.processorOptions || {};
        this.stretchFactor = opts.stretchFactor || 1.0;

        // Audio buffer
        this.samples = null;
        this.totalSamples = 0;

        // Playback state
        this.isPlaying = false;
        this.sourcePosition = 0;

        // Fade-in/out to avoid clicks
        this.fadeInLength = 1102;
        this.fadeOutLength = 1102;
        this.fadeInRemaining = 0;
        this.fadeOutRemaining = 0;
        this.pendingSeekPosition = null;
        this.pendingPause = false;

        // Scrub state
        this.isScrubbing = false;
        this.scrubTarget = 0;
        this.scrubSmoothed1 = 0;
        this.scrubSmoothed2 = 0;
        this.scrubReportCounter = 0;

        // LPF coefficient: k = 2π × cutoffHz / sampleRate
        // Default 30 Hz cutoff: responsive but smooth.
        this.scrubCutoffHz = 30;
        this.scrubK = 2 * Math.PI * 30 / sampleRate;

        this.port.onmessage = (e) => this._onMessage(e.data);
    }

    _onMessage(msg) {
        const { type, data } = msg;

        switch (type) {
            case 'load-audio':
                this.isPlaying = false;
                this.pendingPause = false;
                this.pendingSeekPosition = null;
                this.fadeOutRemaining = 0;
                this.fadeInRemaining = 0;
                this.samples = (data.samples instanceof Float32Array) ? data.samples : new Float32Array(data.samples);
                this.totalSamples = this.samples.length;
                this.sourcePosition = 0;
                this.port.postMessage({ type: 'loaded', duration: this.totalSamples / sampleRate });
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
                    if (this.samples) {
                        this.pendingSeekPosition = Math.max(0, Math.min(this.pendingSeekPosition, this.totalSamples - 1));
                    }
                } else {
                    this.sourcePosition = Math.floor(data.position * sampleRate);
                    if (this.samples) {
                        this.sourcePosition = Math.max(0, Math.min(this.sourcePosition, this.totalSamples - 1));
                    }
                    this.fadeInRemaining = this.fadeInLength;
                }
                break;

            case 'set-position':
                this.sourcePosition = data.position * sampleRate;
                break;

            case 'set-stretch':
                this.stretchFactor = data.factor;
                break;

            // These don't apply to resample but get sent by the shared UI
            case 'set-window-size':
            case 'set-grain-size':
            case 'set-overlap':
                break;

            case 'scrub-start':
                this.isScrubbing = true;
                if (this.samples) {
                    const startPos = Math.max(0, Math.min(
                        data.position * sampleRate,
                        this.totalSamples - 1
                    ));
                    this.scrubTarget = startPos;
                    this.scrubSmoothed1 = startPos;
                    this.scrubSmoothed2 = startPos;
                    this.sourcePosition = startPos;
                }
                break;

            case 'scrub-move':
                if (this.isScrubbing && this.samples) {
                    this.scrubTarget = Math.max(0, Math.min(
                        data.position * sampleRate,
                        this.totalSamples - 1
                    ));
                }
                break;

            case 'scrub-stop':
                this.isScrubbing = false;
                this.sourcePosition = this.scrubSmoothed2;
                break;

            case 'set-scrub-cutoff': {
                // Slider 1-100. Higher = more inertia = lower cutoff.
                // Exponential: 1 → 100Hz (snappy), 50 → 10Hz, 100 → 1Hz (heavy)
                const val = data.value;
                this.scrubCutoffHz = 100 * Math.pow(0.01, (val - 1) / 99);
                this.scrubK = 2 * Math.PI * this.scrubCutoffHz / sampleRate;
                break;
            }
        }
    }

    process(inputs, outputs) {
        const output = outputs[0];
        if (!output || !output[0]) return true;
        const outL = output[0];
        const buf = this.samples;

        if (!buf || !this.isPlaying) {
            outL.fill(0);
            return true;
        }

        const len = this.totalSamples;

        if (this.isScrubbing) {
            // ===== SCRUB MODE =====
            // Two cascaded one-pole LPFs: target → smooth1 → smooth2
            // smooth2 IS the read head. Its velocity is naturally smooth.
            const k = this.scrubK;

            for (let i = 0; i < outL.length; i++) {
                this.scrubSmoothed1 += (this.scrubTarget - this.scrubSmoothed1) * k;
                this.scrubSmoothed2 += (this.scrubSmoothed1 - this.scrubSmoothed2) * k;

                const pos = this.scrubSmoothed2;
                if (pos >= 0 && pos < len - 1) {
                    const idx = Math.floor(pos);
                    const frac = pos - idx;
                    outL[i] = buf[idx] * (1 - frac) + buf[idx + 1] * frac;
                } else {
                    outL[i] = 0;
                }
            }

            // Report position back to UI for playhead
            this.scrubReportCounter += outL.length;
            if (this.scrubReportCounter >= 1024) {
                this.scrubReportCounter = 0;
                this.port.postMessage({
                    type: 'scrub-position',
                    data: { ratio: Math.max(0, Math.min(1, this.scrubSmoothed2 / len)) }
                });
            }

        } else {
            // ===== NORMAL STRETCH PLAYBACK =====
            const step = 1.0 / this.stretchFactor;

            for (let i = 0; i < outL.length; i++) {
                const pos = this.sourcePosition;
                const intPos = Math.floor(pos);

                let sample = 0;

                if (intPos >= len - 1) {
                    if (intPos >= len) {
                        this.isPlaying = false;
                        this.port.postMessage({ type: 'ended' });
                        for (let j = i; j < outL.length; j++) outL[j] = 0;
                        return true;
                    }
                } else if (intPos >= 0) {
                    const frac = pos - intPos;
                    sample = buf[intPos] * (1 - frac) + buf[intPos + 1] * frac;
                }

                // Fade-out
                if (this.fadeOutRemaining > 0) {
                    const p = this.fadeOutRemaining / this.fadeOutLength;
                    sample *= p * p;
                    this.fadeOutRemaining--;
                    if (this.fadeOutRemaining === 0) {
                        if (this.pendingPause) {
                            this.isPlaying = false;
                            this.pendingPause = false;
                            for (let j = i; j < outL.length; j++) outL[j] = 0;
                            return true;
                        }
                        if (this.pendingSeekPosition !== null) {
                            this.sourcePosition = this.pendingSeekPosition;
                            this.pendingSeekPosition = null;
                            this.fadeInRemaining = this.fadeInLength;
                            outL[i] = 0;
                            continue;
                        }
                    }
                }
                // Fade-in
                else if (this.fadeInRemaining > 0) {
                    const p = 1 - (this.fadeInRemaining / this.fadeInLength);
                    sample *= p * p;
                    this.fadeInRemaining--;
                }

                outL[i] = sample;
                this.sourcePosition += step;
            }
        }

        return true;
    }
}

registerProcessor('resample-stretch-processor', ResampleStretchProcessor);
