/**
 * WaveletStretchProcessor — Simple buffer player for GPU-stretched audio.
 *
 * The wavelet phase vocoder stretch is pre-computed on the GPU.
 * This processor just plays the resulting buffer at 1:1 rate.
 * No FFT, no wavelet math — just sequential sample playback with fade handling.
 *
 * Supports two modes:
 * 1. Batch mode: 'load-audio' replaces entire buffer (existing behavior)
 * 2. Streaming mode: 'init-buffer' + 'append-chunk' fills buffer progressively
 *    - Chunks arrive in healing-block order (forward from playhead, then backward)
 *    - Playback starts after first chunk, continues through computed regions
 *    - Uncomputed regions produce silence with automatic fade out/in
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

        // Streaming mode state
        this.isStreaming = false;
        this.readyRanges = [];  // sorted [{start, end}] of computed regions
        this.underrunFading = false;  // true when fading out due to buffer underrun
        this.underrunFadeRemaining = 0;
        this.underrunFadeLength = 882; // ~20ms fade for underrun transitions

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
                    this.isStreaming = false; // batch mode — full buffer loaded
                    this.readyRanges = [];
                    this.underrunFading = false;
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

                // --- Streaming mode messages ---

                case 'init-buffer':
                    // Pre-allocate buffer for progressive chunk filling
                    this.sourceBuffer = new Float32Array(data.totalLength);
                    this.sourcePosition = 0;
                    this.isStreaming = true;
                    this.readyRanges = [];
                    this.underrunFading = false;
                    this.underrunFadeRemaining = 0;
                    this.port.postMessage({
                        type: 'buffer-initialized',
                        totalLength: data.totalLength
                    });
                    break;

                case 'append-chunk':
                    // Copy crossfaded chunk data into buffer at offset
                    if (this.sourceBuffer && data.samples) {
                        const samples = (data.samples instanceof Float32Array)
                            ? data.samples
                            : new Float32Array(data.samples);
                        this.sourceBuffer.set(samples, data.offset);
                        this._mergeReadyRange(data.offset, data.offset + samples.length);
                        this.port.postMessage({
                            type: 'chunk-appended',
                            offset: data.offset,
                            length: samples.length,
                            readyRanges: this.readyRanges.slice() // copy for main thread
                        });
                    }
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

    /**
     * Merge a new range into the sorted readyRanges list.
     * Coalesces overlapping/adjacent ranges.
     */
    _mergeReadyRange(start, end) {
        const ranges = this.readyRanges;
        const merged = [];
        let newRange = { start, end };
        let inserted = false;

        for (const r of ranges) {
            if (r.end < newRange.start) {
                merged.push(r);
            } else if (r.start > newRange.end) {
                if (!inserted) {
                    merged.push(newRange);
                    inserted = true;
                }
                merged.push(r);
            } else {
                // Overlapping — extend newRange
                newRange.start = Math.min(newRange.start, r.start);
                newRange.end = Math.max(newRange.end, r.end);
            }
        }
        if (!inserted) merged.push(newRange);
        this.readyRanges = merged;
    }

    /**
     * Check if a sample position falls within a computed (ready) region.
     */
    _isReady(pos) {
        for (const r of this.readyRanges) {
            if (pos >= r.start && pos < r.end) return true;
            if (r.start > pos) break; // sorted, no need to continue
        }
        return false;
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

            // In streaming mode, check if this position has computed data
            if (this.isStreaming && !this._isReady(pos)) {
                // Buffer underrun — fade to silence, keep advancing
                if (!this.underrunFading) {
                    this.underrunFading = true;
                    this.underrunFadeRemaining = this.underrunFadeLength;
                    this.port.postMessage({ type: 'underrun', position: pos });
                }
                if (this.underrunFadeRemaining > 0) {
                    const fadeProgress = this.underrunFadeRemaining / this.underrunFadeLength;
                    channel[i] = this.sourceBuffer[pos] * fadeProgress * fadeProgress;
                    this.underrunFadeRemaining--;
                } else {
                    channel[i] = 0;
                }
                this.sourcePosition++;
                continue;
            }

            // Exiting underrun — data is available again, fade back in
            if (this.underrunFading) {
                this.underrunFading = false;
                this.fadeInRemaining = this.fadeInLength;
                this.port.postMessage({ type: 'underrun-resolved', position: pos });
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
