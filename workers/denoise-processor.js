/**
 * denoise-processor.js — AudioWorkletProcessor with WASM notch filters
 *
 * Receives the full tone table upfront, self-indexes by sample count.
 * No RAF dependency — immune to tab visibility throttling.
 */

class DenoiseProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.active = false;
        this.wasmReady = false;
        this.wasm = null;
        this.tonePtr = 0;
        this.audioPtr = 0;
        this.maxTones = 16;

        // Tone table: sent once after detection, indexed by sample position
        this.toneTable = null;      // Float32Array[numFrames * maxTones]
        this.toneCounts = null;     // Uint8Array[numFrames]
        this.tableFrames = 0;
        this.tableHop = 1024;       // samples per frame
        this.sampleCounter = 0;     // tracks playback position
        this.lastFrameIdx = -1;

        this._processCount = 0;

        this.port.onmessage = (e) => {
            const { type } = e.data;
            if (type === 'load-wasm') {
                this.port.postMessage({ type: 'debug', msg: 'loading WASM...' });
                this._loadWasm(e.data.wasmBytes, e.data.sampleRate);
            } else if (type === 'load-tone-table') {
                // Full tone table from detection — self-contained, no RAF needed
                this.toneTable = e.data.toneFreqs;
                this.toneCounts = e.data.toneCounts;
                this.tableFrames = e.data.numFrames;
                this.tableHop = e.data.hop || 1024;
                this.maxTones = e.data.maxTones || 8;
                this.sampleCounter = 0;
                this.lastFrameIdx = -1;
                this.port.postMessage({ type: 'debug', msg: `tone table loaded: ${this.tableFrames} frames, hop=${this.tableHop}` });
            } else if (type === 'update-tones') {
                // Legacy per-frame updates (fallback)
                this._updateTones(e.data.freqs);
            } else if (type === 'set-active') {
                this.active = e.data.active;
                this.port.postMessage({ type: 'debug', msg: `set-active: ${e.data.active}` });
            } else if (type === 'seek') {
                // Sync sample counter when user seeks
                this.sampleCounter = e.data.samplePos || 0;
                this.lastFrameIdx = -1;
            }
        };
    }

    async _loadWasm(wasmBytes, sampleRate) {
        try {
            const { instance } = await WebAssembly.instantiate(wasmBytes, {
                env: { memory: new WebAssembly.Memory({ initial: 2 }) },
                wasi_snapshot_preview1: {
                    proc_exit: () => {},
                    fd_close: () => 0, fd_seek: () => 0, fd_write: () => 0,
                },
            });
            this.wasm = instance.exports;
            this.wasm.init(sampleRate, 40.0);
            this.tonePtr = this.wasm.get_tone_input_ptr();
            this.audioPtr = this.wasm.get_audio_buf_ptr();
            this.wasmReady = true;
            this.port.postMessage({ type: 'wasm-ready' });
        } catch (err) {
            this.port.postMessage({ type: 'wasm-error', error: err.message });
        }
    }

    _updateTones(freqs) {
        if (!this.wasmReady) return;
        const mem = this.wasm.memory;
        const toneView = new Float32Array(mem.buffer, this.tonePtr, this.maxTones);
        const n = Math.min(freqs.length, this.maxTones);
        for (let i = 0; i < this.maxTones; i++) {
            toneView[i] = i < n ? freqs[i] : 0;
        }
        this.wasm.update_tones(this.tonePtr, n);
    }

    _updateFromTable() {
        // Index into tone table by sample position
        const frameIdx = Math.floor(this.sampleCounter / this.tableHop);
        if (frameIdx === this.lastFrameIdx) return; // no change
        if (frameIdx < 0 || frameIdx >= this.tableFrames) return;
        this.lastFrameIdx = frameIdx;

        const nt = this.toneCounts[frameIdx];
        const freqs = [];
        for (let k = 0; k < nt; k++) {
            const f = this.toneTable[frameIdx * this.maxTones + k];
            if (f > 0) freqs.push(f);
        }
        this._updateTones(freqs);
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];
        if (!input || !input[0]) return true;

        const inCh = input[0];
        const outCh = output[0];
        const len = inCh.length;

        if (!this.active || !this.wasmReady) {
            outCh.set(inCh);
            return true;
        }

        // Self-index from tone table if available
        if (this.toneTable) {
            this._updateFromTable();
            this.sampleCounter += len;
        }

        try {
            const mem = this.wasm.memory;
            const audioBuf = new Float32Array(mem.buffer, this.audioPtr, len);
            audioBuf.set(inCh);
            this.wasm.process_buf(len);
            const result = new Float32Array(mem.buffer, this.audioPtr, len);
            outCh.set(result);

            this._processCount++;
            if (this._processCount % 2000 === 1) {
                const activeCount = this.wasm.get_active_count();
                const inRMS = Math.sqrt(inCh.reduce((s,v) => s + v*v, 0) / len);
                const outRMS = Math.sqrt(result.reduce((s,v) => s + v*v, 0) / len);
                this.port.postMessage({ type: 'debug',
                    msg: `PROCESS: frame=${this.lastFrameIdx} notches=${activeCount} inRMS=${inRMS.toFixed(4)} outRMS=${outRMS.toFixed(4)}`
                });
            }
        } catch(err) {
            this.port.postMessage({ type: 'debug', msg: `WASM ERROR: ${err.message}` });
            outCh.set(inCh);
        }

        return true;
    }
}

registerProcessor('denoise-processor', DenoiseProcessor);
