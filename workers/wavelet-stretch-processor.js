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
 * Double-buffer design for seamless param changes:
 * - Active buffer plays audio. Back buffer loads new chunks.
 * - 'swap-buffer' message triggers crossfade from active → back.
 * - After swap, old active buffer becomes available for next re-use.
 *
 * When the speed changes, the GPU re-computes the buffer and sends
 * it here via 'load-audio'. Crossfade is handled by the audio-player gain nodes.
 */

class WaveletStretchProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        // Active buffer — currently playing
        this.sourceBuffer = null;
        this.sourcePosition = 0;
        this.isPlaying = false;
        this.isStreaming = false;
        this.readyRanges = [];  // sorted [{start, end}] of computed regions

        // Back buffer — loads new audio while active plays
        this.backBuffer = null;
        this.backReadyRanges = [];
        this.backIsStreaming = false;

        // Crossfade between active ↔ back
        this.swapFading = false;
        this.swapFadeLength = 2205; // ~50ms at 44.1kHz
        this.swapFadeRemaining = 0;
        this.swapSeekPosition = null; // position to seek to in back buffer after swap

        // Fade-in/out to avoid clicks
        this.fadeInLength = 1102; // ~25ms at 44.1kHz
        this.fadeOutLength = 1102;
        this.fadeInRemaining = 0;
        this.fadeOutRemaining = 0;
        this.pendingSeekPosition = null;
        this.pendingPause = false;

        // Underrun handling (streaming mode)
        this.underrunFading = false;
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
                    // Pre-allocate buffer for progressive chunk filling.
                    // If audio is currently playing, this goes to the BACK buffer
                    // so active audio is undisturbed.
                    if (this.isPlaying && this.sourceBuffer) {
                        // Double-buffer: load into back buffer
                        this.backBuffer = new Float32Array(data.totalLength);
                        this.backReadyRanges = [];
                        this.backIsStreaming = true;
                        this.port.postMessage({
                            type: 'buffer-initialized',
                            totalLength: data.totalLength,
                            target: 'back'
                        });
                    } else {
                        // No active playback — load directly into active buffer
                        this.sourceBuffer = new Float32Array(data.totalLength);
                        this.sourcePosition = 0;
                        this.isStreaming = true;
                        this.readyRanges = [];
                        this.underrunFading = false;
                        this.underrunFadeRemaining = 0;
                        this.port.postMessage({
                            type: 'buffer-initialized',
                            totalLength: data.totalLength,
                            target: 'active'
                        });
                    }
                    break;

                case 'append-chunk': {
                    // Route to back buffer if it exists, otherwise active
                    const toBack = this.backBuffer !== null;
                    const buf = toBack ? this.backBuffer : this.sourceBuffer;
                    const ranges = toBack ? this.backReadyRanges : this.readyRanges;

                    if (buf && data.samples) {
                        const samples = (data.samples instanceof Float32Array)
                            ? data.samples
                            : new Float32Array(data.samples);
                        buf.set(samples, data.offset);
                        const newRanges = this._mergeRange(ranges, data.offset, data.offset + samples.length);
                        if (toBack) {
                            this.backReadyRanges = newRanges;
                        } else {
                            this.readyRanges = newRanges;
                        }
                        this.port.postMessage({
                            type: 'chunk-appended',
                            offset: data.offset,
                            length: samples.length,
                            readyRanges: newRanges.slice(),
                            target: toBack ? 'back' : 'active'
                        });
                    }
                    break;
                }

                case 'swap-buffer':
                    // Crossfade from active → back buffer.
                    // data.seekPosition (in seconds) = where to start in the new buffer.
                    if (this.backBuffer) {
                        this.swapFading = true;
                        this.swapFadeRemaining = this.swapFadeLength;
                        this.swapSeekPosition = data?.seekPosition != null
                            ? Math.floor(data.seekPosition * sampleRate)
                            : this.sourcePosition; // default: same position
                        // Clamp
                        this.swapSeekPosition = Math.max(0,
                            Math.min(this.swapSeekPosition, this.backBuffer.length - 1));
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
     * Merge a new range into a sorted ranges list.
     * Returns the new merged array (does not mutate input).
     */
    _mergeRange(ranges, start, end) {
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
        return merged;
    }

    /**
     * Kept for backward compat — delegates to _mergeRange and writes to this.readyRanges.
     */
    _mergeReadyRange(start, end) {
        this.readyRanges = this._mergeRange(this.readyRanges, start, end);
    }

    /**
     * Check if a sample position falls within a computed (ready) region.
     */
    _isReady(pos, ranges) {
        const r = ranges || this.readyRanges;
        for (const range of r) {
            if (pos >= range.start && pos < range.end) return true;
            if (range.start > pos) break; // sorted, no need to continue
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

            // ── Swap crossfade: blend active → back buffer ──
            if (this.swapFading && this.backBuffer) {
                const progress = this.swapFadeRemaining / this.swapFadeLength; // 1→0
                const oldGain = progress * progress; // quadratic fade out
                const newGain = (1 - progress) * (1 - progress); // quadratic fade in

                // Sample from active buffer (fading out)
                let oldSample = 0;
                if (pos < this.sourceBuffer.length) {
                    if (!this.isStreaming || this._isReady(pos, this.readyRanges)) {
                        oldSample = this.sourceBuffer[pos];
                    }
                }

                // Sample from back buffer (fading in)
                const backPos = this.swapSeekPosition + (this.swapFadeLength - this.swapFadeRemaining);
                let newSample = 0;
                if (backPos >= 0 && backPos < this.backBuffer.length) {
                    if (!this.backIsStreaming || this._isReady(backPos, this.backReadyRanges)) {
                        newSample = this.backBuffer[backPos];
                    }
                }

                channel[i] = oldSample * oldGain + newSample * newGain;
                this.swapFadeRemaining--;

                if (this.swapFadeRemaining <= 0) {
                    // Swap complete — back becomes active
                    this.sourceBuffer = this.backBuffer;
                    this.readyRanges = this.backReadyRanges;
                    this.isStreaming = this.backIsStreaming;
                    this.sourcePosition = this.swapSeekPosition + this.swapFadeLength;
                    // Clamp
                    if (this.sourcePosition >= this.sourceBuffer.length) {
                        this.sourcePosition = this.sourceBuffer.length - 1;
                    }

                    // Clear back buffer
                    this.backBuffer = null;
                    this.backReadyRanges = [];
                    this.backIsStreaming = false;
                    this.swapFading = false;
                    this.swapSeekPosition = null;

                    // Clear any stale fade state
                    this.underrunFading = false;
                    this.underrunFadeRemaining = 0;
                    this.fadeOutRemaining = 0;
                    this.fadeInRemaining = 0;
                    this.pendingPause = false;
                    this.pendingSeekPosition = null;

                    this.port.postMessage({ type: 'swap-complete' });
                }

                this.sourcePosition++;
                continue;
            }

            // ── Normal playback from active buffer ──

            // In streaming mode, check if this position has computed data
            if (this.isStreaming && !this._isReady(pos, this.readyRanges)) {
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
