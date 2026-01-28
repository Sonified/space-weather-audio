/**
 * PaulStretchProcessor - Direct port of paulstretch.js by Sébastien Piquemal
 * https://github.com/sebpiq/paulstretch.js
 *
 * Original algorithm by Nasca Octavian Paul
 *
 * The MIT License (MIT)
 *
 * Copyright (c) 2014 Sébastien Piquemal <sebpiq@gmail.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

class PaulStretchProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        console.log('🎛️ PaulStretchProcessor constructor called');

        // Parameters
        this.winSize = options.processorOptions?.windowSize || 4096;
        this.ratio = options.processorOptions?.stretchFactor || 8.0;

        // Derived
        this.halfWinSize = this.winSize / 2;

        // Create window array - THEIR EXACT WINDOW FUNCTION
        this.winArray = this.createWindow(this.winSize);

        // Input/output sample queues
        this.samplesIn = this.createSamplesQueue();
        this.samplesOut = this.createSamplesQueue();

        // Set initial displacePos for input queue
        this.samplesIn.setDisplacePos((this.winSize * 0.5) / this.ratio);

        // Working buffers for process()
        this.blockIn = new Float32Array(this.winSize);
        this.blockOut = new Float32Array(this.winSize);
        this.phaseArray = new Float32Array(this.halfWinSize + 1);

        // FFT working arrays
        this.re = new Array(this.winSize).fill(0);
        this.im = new Array(this.winSize).fill(0);
        this.amplitudes = new Float32Array(this.halfWinSize + 1);

        // Source buffer
        this.sourceBuffer = null;
        this.sourcePosition = 0;
        this.isPlaying = false;

        // Fade-in/out to avoid clicks
        this.fadeInLength = 1102; // ~25ms at 44.1kHz
        this.fadeOutLength = 1102; // ~25ms
        this.fadeInRemaining = 0;
        this.fadeOutRemaining = 0;
        this.pendingSeekPosition = null;

        // Output buffer for AudioWorklet process() callback
        this.outputRingBuffer = new Float32Array(65536);
        this.outputReadPos = 0;
        this.outputWritePos = 0;

        this.setupMessageHandler();
    }

    // ===== THEIR EXACT WINDOW FUNCTION =====
    createWindow(winSize) {
        var winArray = new Float32Array(winSize);
        var counter = -1, step = 2 / (winSize - 1);
        for (var i = 0; i < winSize; i++) {
            winArray[i] = Math.pow(1 - Math.pow(counter, 2), 1.25);
            counter += step;
        }
        return winArray;
    }

    // ===== THEIR EXACT APPLY WINDOW =====
    applyWindow(block, winArray) {
        for (var i = 0; i < block.length; i++) {
            block[i] = block[i] * winArray[i];
        }
    }

    // ===== THEIR EXACT SAMPLES QUEUE =====
    createSamplesQueue() {
        var blocksIn = [];
        var readPos = 0, framesAvailable = 0;
        var displacePos = 0;

        return {
            setDisplacePos: function(val) { displacePos = val; },
            getReadPos: function() { return readPos; },
            getFramesAvailable: function() { return framesAvailable; },

            read: function(blockOut) {
                var blockSize = blockOut.length;
                var i, block;
                var writePos;
                var readStart;
                var toRead;

                if (framesAvailable >= blockSize) {
                    readStart = Math.floor(readPos);
                    writePos = 0;
                    i = 0;

                    while (writePos < blockSize) {
                        block = blocksIn[i++];
                        toRead = Math.min(block.length - readStart, blockSize - writePos);

                        for (var j = 0; j < toRead; j++) {
                            blockOut[writePos + j] = block[readStart + j];
                        }
                        writePos += toRead;
                        readStart = 0;
                    }

                    readPos += (displacePos || blockSize);
                    framesAvailable -= (displacePos || blockSize);

                    block = blocksIn[0];
                    while (block && block.length < readPos) {
                        blocksIn.shift();
                        readPos -= block.length;
                        block = blocksIn[0];
                    }

                    return blockOut;
                } else {
                    return null;
                }
            },

            write: function(block) {
                blocksIn.push(block);
                framesAvailable += block.length;
            },

            clear: function() {
                blocksIn = [];
                readPos = 0;
                framesAvailable = 0;
            }
        };
    }

    // ===== THEIR EXACT FFT (ndfft style) =====
    // Using simple DFT for correctness - their code uses ndfft package
    fft(direction, re, im) {
        const n = re.length;
        const bits = Math.log2(n);

        // Bit-reversal permutation
        for (let i = 0; i < n; i++) {
            let j = 0;
            let x = i;
            for (let k = 0; k < bits; k++) {
                j = (j << 1) | (x & 1);
                x >>= 1;
            }
            if (i < j) {
                [re[i], re[j]] = [re[j], re[i]];
                [im[i], im[j]] = [im[j], im[i]];
            }
        }

        // Cooley-Tukey FFT
        for (let size = 2; size <= n; size *= 2) {
            const halfSize = size / 2;
            const angle = direction * 2 * Math.PI / size;

            for (let i = 0; i < n; i += size) {
                for (let j = 0; j < halfSize; j++) {
                    const wr = Math.cos(angle * j);
                    const wi = Math.sin(angle * j);

                    const idx1 = i + j;
                    const idx2 = i + j + halfSize;

                    const tr = wr * re[idx2] - wi * im[idx2];
                    const ti = wr * im[idx2] + wi * re[idx2];

                    re[idx2] = re[idx1] - tr;
                    im[idx2] = im[idx1] - ti;
                    re[idx1] = re[idx1] + tr;
                    im[idx1] = im[idx1] + ti;
                }
            }
        }

        // Scale for inverse
        if (direction === -1) {
            for (let i = 0; i < n; i++) {
                re[i] /= n;
                im[i] /= n;
            }
        }
    }

    // ===== THEIR EXACT REPHASE FUNCTION =====
    rephase(array, phases) {
        const winSize = this.winSize;
        const symSpectrumSlice = [1, winSize / 2];
        const uniqSpectrumSlice = [0, winSize / 2 + 1];
        const re = this.re;
        const im = this.im;
        const amplitudes = this.amplitudes;

        // Prepare im and re for FFT
        for (let i = 0; i < winSize; i++) {
            im[i] = 0;
            re[i] = array[i];
        }

        // get the amplitudes of the frequency components and discard the phases
        this.fft(1, re, im);

        // get only the unique part of the spectrum
        for (let i = uniqSpectrumSlice[0]; i < uniqSpectrumSlice[1]; i++) {
            amplitudes[i - uniqSpectrumSlice[0]] = Math.abs(re[i]); // input signal is real, so abs value of `re` is the amplitude
        }

        // Apply the new phases
        for (let i = 0; i < amplitudes.length; i++) {
            re[i] = amplitudes[i] * Math.cos(phases[i]);
            im[i] = amplitudes[i] * Math.sin(phases[i]);
        }

        // Rebuild `re` and `im` by adding the symetric part
        for (let i = symSpectrumSlice[0]; i < symSpectrumSlice[1]; i++) {
            re[symSpectrumSlice[1] + i] = re[symSpectrumSlice[1] - i];
            im[symSpectrumSlice[1] + i] = im[symSpectrumSlice[1] - i] * -1;
        }

        // do the inverse FFT
        this.fft(-1, re, im);

        // Copy back to array
        for (let i = 0; i < winSize; i++) {
            array[i] = re[i];
        }

        return array;
    }

    // ===== THEIR EXACT PROCESS FUNCTION =====
    processStretch() {
        // Read a block to blockIn
        if (this.samplesIn.read(this.blockIn) === null) return 0;

        // get the windowed buffer
        this.applyWindow(this.blockIn, this.winArray);

        // Randomize phases
        for (let i = 0; i < this.phaseArray.length; i++) {
            this.phaseArray[i] = Math.random() * 2 * Math.PI;
        }
        this.rephase(this.blockIn, this.phaseArray);

        // overlap-add the output
        this.applyWindow(this.blockIn, this.winArray);

        // Add first half of blockIn to second half of blockOut
        for (let i = 0; i < this.halfWinSize; i++) {
            this.blockIn[i] += this.blockOut[this.halfWinSize + i];
        }

        // Copy blockIn to blockOut for next iteration
        for (let i = 0; i < this.winSize; i++) {
            this.blockOut[i] = this.blockIn[i];
        }

        // Output first half of the result
        const outputBlock = this.blockIn.subarray(0, this.halfWinSize);

        // Write to output ring buffer
        for (let i = 0; i < this.halfWinSize; i++) {
            this.outputRingBuffer[this.outputWritePos] = outputBlock[i];
            this.outputWritePos = (this.outputWritePos + 1) % this.outputRingBuffer.length;
        }

        return this.halfWinSize;
    }

    setupMessageHandler() {
        this.port.onmessage = (event) => {
            const { type, data } = event.data;

            switch (type) {
                case 'load-audio':
                    console.log(`📨 Paul: Loading audio: ${data.samples.length} samples`);
                    this.sourceBuffer = new Float32Array(data.samples);
                    this.sourcePosition = 0;
                    this.resetBuffers();
                    this.port.postMessage({ type: 'loaded', duration: data.samples.length / sampleRate });
                    break;

                case 'play':
                    console.log('▶️ Paul: PLAY');
                    this.isPlaying = true;
                    this.fadeInRemaining = this.fadeInLength;
                    break;

                case 'pause':
                    console.log('⏸️ Paul: PAUSE');
                    this.isPlaying = false;
                    break;

                case 'seek':
                    let targetPos = Math.floor(data.position * sampleRate);
                    if (this.sourceBuffer) {
                        targetPos = Math.max(0, Math.min(targetPos, this.sourceBuffer.length - 1));
                    }

                    if (this.isPlaying) {
                        // Fade out first, then seek when fade completes
                        this.fadeOutRemaining = this.fadeOutLength;
                        this.pendingSeekPosition = targetPos;
                        console.log(`⏩ Paul: Seek requested while playing, fading out first. Target: ${targetPos}`);
                    } else {
                        // Not playing, seek immediately
                        this.sourcePosition = targetPos;
                        this.resetBuffers();
                        this.fadeInRemaining = this.fadeInLength;
                        console.log(`⏩ Paul: Seek to ${this.sourcePosition}`);
                    }
                    break;

                case 'set-stretch':
                    this.ratio = data.factor;
                    this.samplesIn.setDisplacePos((this.winSize * 0.5) / this.ratio);
                    console.log(`🔄 Paul: Stretch factor: ${this.ratio}`);
                    break;

                case 'set-window-size':
                    this.reinitialize(data.size);
                    console.log(`📐 Paul: Window size: ${this.winSize}`);
                    break;

                case 'set-overlap':
                    // Their algorithm doesn't have configurable overlap - it's fixed at 50%
                    console.log(`🔀 Paul: Overlap ignored (fixed at 50%)`);
                    break;
            }
        };
    }

    resetBuffers() {
        this.samplesIn.clear();
        this.samplesOut.clear();
        this.blockIn.fill(0);
        this.blockOut.fill(0);
        this.outputReadPos = 0;
        this.outputWritePos = 0;
        this.outputRingBuffer.fill(0);
    }

    reinitialize(winSize) {
        this.winSize = winSize;
        this.halfWinSize = winSize / 2;
        this.winArray = this.createWindow(winSize);
        this.blockIn = new Float32Array(winSize);
        this.blockOut = new Float32Array(winSize);
        this.phaseArray = new Float32Array(this.halfWinSize + 1);
        this.re = new Array(winSize).fill(0);
        this.im = new Array(winSize).fill(0);
        this.amplitudes = new Float32Array(this.halfWinSize + 1);
        this.samplesIn.setDisplacePos((this.winSize * 0.5) / this.ratio);
        this.resetBuffers();
    }

    // Feed source samples to the input queue
    feedInput(count) {
        if (!this.sourceBuffer || this.sourcePosition >= this.sourceBuffer.length) {
            return false;
        }

        const block = new Float32Array(count);
        for (let i = 0; i < count && this.sourcePosition < this.sourceBuffer.length; i++) {
            block[i] = this.sourceBuffer[this.sourcePosition++];
        }
        this.samplesIn.write(block);
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

        // Calculate how much output we have available
        let available = this.outputWritePos - this.outputReadPos;
        if (available < 0) available += this.outputRingBuffer.length;

        const neededSamples = channel.length * 2; // Some headroom

        // Keep feeding and processing until we have enough output
        while (available < neededSamples) {
            // First, ensure input queue has enough for a full window
            while (this.samplesIn.getFramesAvailable() < this.winSize) {
                // Try to feed more input
                if (this.sourcePosition < this.sourceBuffer.length) {
                    // Feed one window worth at a time
                    const toFeed = Math.min(this.winSize, this.sourceBuffer.length - this.sourcePosition);
                    const block = new Float32Array(toFeed);
                    for (let i = 0; i < toFeed; i++) {
                        block[i] = this.sourceBuffer[this.sourcePosition++];
                    }
                    this.samplesIn.write(block);
                } else {
                    // Source exhausted, can't feed more
                    break;
                }
            }

            // Now try to process
            const processed = this.processStretch();
            if (processed === 0) {
                // Can't process - not enough input
                // Check if we're truly done (source exhausted AND input queue can't fill a window)
                if (this.sourcePosition >= this.sourceBuffer.length &&
                    this.samplesIn.getFramesAvailable() < this.winSize) {
                    // Check if output is also exhausted
                    if (available === 0) {
                        this.isPlaying = false;
                        this.port.postMessage({ type: 'ended' });
                        channel.fill(0);
                        return true;
                    }
                }
                break;
            }

            // Update available count
            available = this.outputWritePos - this.outputReadPos;
            if (available < 0) available += this.outputRingBuffer.length;
        }

        // Read from output ring buffer with fade handling
        for (let i = 0; i < channel.length; i++) {
            let sample = this.outputRingBuffer[this.outputReadPos];
            this.outputRingBuffer[this.outputReadPos] = 0;
            this.outputReadPos = (this.outputReadPos + 1) % this.outputRingBuffer.length;

            // Apply fade-out
            if (this.fadeOutRemaining > 0) {
                const fadeProgress = this.fadeOutRemaining / this.fadeOutLength;
                sample *= fadeProgress * fadeProgress; // Quadratic fade
                this.fadeOutRemaining--;

                // When fade-out completes, apply the pending seek
                if (this.fadeOutRemaining === 0 && this.pendingSeekPosition !== null) {
                    this.sourcePosition = this.pendingSeekPosition;
                    this.pendingSeekPosition = null;
                    this.resetBuffers();
                    this.fadeInRemaining = this.fadeInLength;
                    console.log(`⏩ Paul: Fade-out complete, seeking to: ${this.sourcePosition}`);
                    // Fill rest with silence and return - next frame will have fresh audio
                    for (let j = i; j < channel.length; j++) {
                        channel[j] = 0;
                    }
                    return true;
                }
            }
            // Apply fade-in
            else if (this.fadeInRemaining > 0) {
                const fadeProgress = 1 - (this.fadeInRemaining / this.fadeInLength);
                sample *= fadeProgress * fadeProgress; // Quadratic ease-in
                this.fadeInRemaining--;
            }

            channel[i] = sample;
        }

        return true;
    }
}

registerProcessor('paul-stretch-processor', PaulStretchProcessor);
