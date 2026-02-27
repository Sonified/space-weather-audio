/**
 * ResampleStretchProcessor
 *
 * Normal mode: reads samples at 1/stretchFactor rate.
 *
 * Scrub mode: Two cascaded one-pole LPFs (simulates mass/inertia).
 *   - Velocity is always continuous (no pitch jumps)
 *   - Adaptive k: gap between mouse and read head scales the filter coefficient.
 *     Fast drag = large gap = higher k = snappy. Slow drag = small gap = lower k = smooth.
 *     This compensates for mouse quantization noise being proportionally worse at low speeds.
 *   - Deadzone snap: when close enough to target, snap exactly. No asymptotic crawl.
 *
 * Two UI controls:
 *   1. Inertia (scrub-inertia): base platter weight. Higher = heavier.
 *   2. Adaptivity (scrub-adapt): how much speed affects inertia.
 *      0 = fixed weight always. 100 = fully speed-dependent.
 */

class ResampleStretchProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        this.stretchFactor = options.processorOptions?.stretchFactor || 8.0;

        // Audio source
        this.sourceBuffer = null;
        this.sourcePosition = 0;
        this.isPlaying = false;

        // Scrub: two-pole LPF state
        this.scrubbing = false;
        this.scrubTarget = 0;       // raw mouse position (samples)
        this.scrubSmoothed1 = 0;    // first pole output
        this.scrubSmoothed2 = 0;    // second pole output = read head
        this.scrubReportCounter = 0;

        // Tuning: base cutoff and adaptive range
        this.baseCutoffHz = 15;     // default ~15 Hz
        this.baseK = 2 * Math.PI * 15 / sampleRate;
        this.adaptAmount = 0.5;     // 0 = fixed, 1 = fully adaptive

        // Speed tracking: velocity of second pole (inherently smooth)
        this.prevSmoothed2 = 0;
        // Reference speed (samples/sample). 1.0 = normal playback speed.
        this.refSpeed = 0.5;

        // Deadzone: snap when this close (in samples)
        this.deadzone = 0.05;

        // Fade-in/out to avoid clicks
        this.fadeInLength = 1102;
        this.fadeOutLength = 1102;
        this.fadeInRemaining = 0;
        this.fadeOutRemaining = 0;
        this.pendingSeekPosition = null;
        this.pendingPause = false;

        this.setupMessageHandler();
    }

    setupMessageHandler() {
        this.port.onmessage = (event) => {
            const { type, data } = event.data;

            switch (type) {
                case 'load-audio':
                    this.isPlaying = false;
                    this.pendingPause = false;
                    this.pendingSeekPosition = null;
                    this.fadeOutRemaining = 0;
                    this.fadeInRemaining = 0;
                    this.sourceBuffer = (data.samples instanceof Float32Array)
                        ? data.samples : new Float32Array(data.samples);
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

                case 'set-stretch':
                    this.stretchFactor = data.factor;
                    break;

                case 'set-window-size':
                case 'set-grain-size':
                case 'set-overlap':
                    break;

                case 'set-position':
                    if (this.sourceBuffer) {
                        this.sourcePosition = Math.max(0, Math.min(
                            Math.floor(data.position * sampleRate),
                            this.sourceBuffer.length - 1
                        ));
                    }
                    break;

                // ===== SCRUB =====

                case 'scrub-start': {
                    this.scrubbing = true;
                    if (this.sourceBuffer) {
                        const pos = Math.max(0, Math.min(
                            data.position * sampleRate,
                            this.sourceBuffer.length - 1
                        ));
                        // Snap both poles to click position
                        this.scrubTarget = pos;
                        this.scrubSmoothed1 = pos;
                        this.scrubSmoothed2 = pos;
                        this.prevSmoothed2 = pos;
                        this.sourcePosition = pos;
                    }
                    break;
                }

                case 'scrub-move': {
                    if (this.scrubbing && this.sourceBuffer) {
                        this.scrubTarget = Math.max(0, Math.min(
                            data.position * sampleRate,
                            this.sourceBuffer.length - 1
                        ));
                    }
                    break;
                }

                case 'scrub-stop':
                    this.scrubbing = false;
                    this.sourcePosition = this.scrubSmoothed2;
                    break;

                // Control 1: Inertia (base platter weight)
                // Slider 1..100. Higher = heavier = lower cutoff.
                // 1 → 60Hz (light), 50 → 8Hz (medium), 100 → 1Hz (heavy)
                case 'set-scrub-cutoff': {
                    const val = data.value;
                    this.baseCutoffHz = 60 * Math.pow(1 / 60, (val - 1) / 99);
                    this.baseK = 2 * Math.PI * this.baseCutoffHz / sampleRate;
                    break;
                }

                // Control 2: Adaptivity (how much speed affects inertia)
                // Slider 0..100. 0 = fixed, 100 = fully adaptive.
                case 'set-scrub-adapt': {
                    this.adaptAmount = data.value / 100;
                    break;
                }
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

        const buf = this.sourceBuffer;
        const bufLen = buf.length;

        // ===== SCRUB MODE: two-pole speed-adaptive LPF =====
        if (this.scrubbing) {
            const baseK = this.baseK;
            const adaptAmount = this.adaptAmount;
            const refSpeed = this.refSpeed;

            for (let i = 0; i < channel.length; i++) {
                // Deadzone: close enough, snap and stop
                const gap = Math.abs(this.scrubTarget - this.scrubSmoothed2);
                if (gap < this.deadzone) {
                    this.scrubSmoothed1 = this.scrubTarget;
                    this.scrubSmoothed2 = this.scrubTarget;
                    this.sourcePosition = this.scrubTarget;
                    channel[i] = 0;
                    continue;
                }

                // Speed from second pole's velocity (inherently double-smooth)
                const speed = Math.abs(this.scrubSmoothed2 - this.prevSmoothed2);
                this.prevSmoothed2 = this.scrubSmoothed2;

                // Speed scaling: slow → scale < 1 → lower k → more inertia
                //                fast → scale > 1 → higher k → less inertia
                const speedRatio = speed / refSpeed;
                const speedScale = Math.max(0.2, Math.min(3.0, Math.sqrt(speedRatio)));

                // Blend between fixed k (1.0) and speed-adaptive (speedScale)
                const effectiveScale = 1.0 + adaptAmount * (speedScale - 1.0);
                const k = Math.min(baseK * effectiveScale, 0.1);

                // Two cascaded one-pole LPFs
                this.scrubSmoothed1 += (this.scrubTarget - this.scrubSmoothed1) * k;
                this.scrubSmoothed2 += (this.scrubSmoothed1 - this.scrubSmoothed2) * k;
                this.sourcePosition = this.scrubSmoothed2;

                // Linear interpolation readout
                const pos = this.sourcePosition;
                const idx = Math.floor(pos);
                if (idx >= 0 && idx < bufLen - 1) {
                    const frac = pos - idx;
                    channel[i] = buf[idx] + frac * (buf[idx + 1] - buf[idx]);
                } else {
                    channel[i] = 0;
                }
            }

            // Report position for UI playhead
            this.scrubReportCounter += channel.length;
            if (this.scrubReportCounter >= 1024) {
                this.scrubReportCounter = 0;
                this.port.postMessage({
                    type: 'scrub-position',
                    data: {
                        ratio: Math.max(0, Math.min(1, this.sourcePosition / bufLen)),
                        speed: Math.abs(this.scrubSmoothed2 - this.prevSmoothed2) * sampleRate,
                        speedNorm: Math.min(1, Math.abs(this.scrubSmoothed2 - this.prevSmoothed2) / this.refSpeed)
                    }
                });
            }
            return true;
        }

        // ===== NORMAL STRETCH PLAYBACK =====
        const readRate = 1 / this.stretchFactor;

        for (let i = 0; i < channel.length; i++) {
            const pos = this.sourcePosition;
            const intPos = Math.floor(pos);
            let sample = 0;

            if (intPos >= bufLen - 1) {
                if (intPos >= bufLen) {
                    this.isPlaying = false;
                    this.port.postMessage({ type: 'ended' });
                    for (let j = i; j < channel.length; j++) channel[j] = 0;
                    break;
                }
            } else {
                const frac = pos - intPos;
                sample = buf[intPos] + frac * (buf[intPos + 1] - buf[intPos]);
            }

            // Fade-out
            if (this.fadeOutRemaining > 0) {
                const fadeProgress = this.fadeOutRemaining / this.fadeOutLength;
                sample *= fadeProgress * fadeProgress;
                this.fadeOutRemaining--;

                if (this.fadeOutRemaining === 0) {
                    if (this.pendingPause) {
                        this.isPlaying = false;
                        this.pendingPause = false;
                        for (let j = i; j < channel.length; j++) channel[j] = 0;
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
            // Fade-in
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
