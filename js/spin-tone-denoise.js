/**
 * spin-tone-denoise.js — Spacecraft spin tone removal
 *
 * Exact same pipeline as the working test page:
 *   1. DC remove + normalize the samples
 *   2. Detection (tonality scoring in worker)
 *   3. WASM notch filtering on the SAME preprocessed samples
 *   4. swap-buffer crossfade to cleaned version
 */

import * as State from './audio-state.js';
import { setDetoneMaskData, setDetoneMaskAlpha } from './main-window-renderer.js';

const HOP = 1024;
const MAX_TONES = 8;

let detectWorker = null;
let wasmInstance = null;
let wasmMemory = null;
let preprocessedSamples = null;  // DC removed + normalized
let cleanedSamples = null;
let denoiseActive = false;
let processing = false;
const NOTCH_Q = 100.0;  // WASM notch filter Q — BW ≈ f0/Q, so ~44 Hz at 4428 Hz

// ── Init ────────────────────────────────────────────────────────────────────

export async function initDenoise() {
    if (detectWorker) return;

    const resp = await fetch('workers/detone.wasm');
    const wasmBytes = await resp.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(wasmBytes, {
        env: { memory: new WebAssembly.Memory({ initial: 2 }) },
        wasi_snapshot_preview1: {
            proc_exit: () => {},
            fd_close: () => 0, fd_seek: () => 0, fd_write: () => 0,
        },
    });
    wasmInstance = instance.exports;
    wasmMemory = wasmInstance.memory;
    console.log('🎛️ Denoise WASM ready (offline mode)');

    detectWorker = new Worker('workers/denoise-detect-worker.js');
    detectWorker.onmessage = (e) => {
        if (e.data.type === 'result') {
            console.log(`🎛️ Detection: ${e.data.totalDetections} tones in ${e.data.numFrames} frames — ${e.data.elapsed.toFixed(0)}ms`);
            _buildMask(e.data.toneFreqs, e.data.toneCounts, e.data.numFrames);
            _applyNotches(e.data.toneFreqs, e.data.toneCounts, e.data.numFrames);
        }
    };
}

// ── Build mask texture from tone table ──────────────────────────────────────
// Texture layout: [bin * numFrames + frame], width=numFrames, height=numBins
// Each detected tone marks ±1 bin around its center, with smooth falloff via
// linear texture filtering on the GPU side.

const MASK_WIN_SIZE = 4096;            // matches detection worker WIN_SIZE
const MASK_NUM_BINS = MASK_WIN_SIZE / 2 + 1;
const MASK_HALF_WIDTH = 3;              // ±3 bins around tone center (wider band)
const MASK_VALUE = 255;                 // 0..255

function _buildMask(toneFreqs, toneCounts, numFrames) {
    const sampleRate = window._denoiseSR || State.audioContext?.sampleRate || 44100;
    const hzPerBin = sampleRate / MASK_WIN_SIZE;
    const data = new Uint8Array(MASK_NUM_BINS * numFrames);

    let nonZero = 0;
    for (let fi = 0; fi < numFrames; fi++) {
        const nt = toneCounts[fi];
        for (let k = 0; k < nt; k++) {
            const hz = toneFreqs[fi * MAX_TONES + k];
            if (hz <= 0) continue;
            const bin = Math.round(hz / hzPerBin);
            const lo = Math.max(0, bin - MASK_HALF_WIDTH);
            const hi = Math.min(MASK_NUM_BINS - 1, bin + MASK_HALF_WIDTH);
            for (let b = lo; b <= hi; b++) {
                if (data[b * numFrames + fi] === 0) nonZero++;
                data[b * numFrames + fi] = MASK_VALUE;
            }
        }
    }
    console.log(`🎛️ [_buildMask] sr=${sampleRate} hzPerBin=${hzPerBin.toFixed(2)} numFrames=${numFrames} numBins=${MASK_NUM_BINS} nonZeroCells=${nonZero}`);

    setDetoneMaskData(data, numFrames, MASK_NUM_BINS);
    console.log(`🎛️ [_buildMask] called setDetoneMaskData with ${data.length} bytes — denoiseActive=${denoiseActive}`);

    // If denoise is already active, make sure the mask is visible
    if (denoiseActive) {
        setDetoneMaskAlpha(1.0);
        console.log(`🎛️ [_buildMask] set alpha to 1.0`);
    }
}

// ── Run full pipeline ───────────────────────────────────────────────────────

export function runDenoise(samples, sampleRate) {
    if (!detectWorker || !wasmInstance || processing) return;
    processing = true;

    // Samples are already DC-removed + normalized by the data loading pipeline
    preprocessedSamples = samples;

    // Step 2: send preprocessed samples to detection worker
    const detectCopy = new Float32Array(preprocessedSamples);
    // Store sampleRate for WASM pass
    window._denoiseSR = sampleRate;
    detectWorker.postMessage(
        { type: 'detect', samples: detectCopy, sampleRate },
        [detectCopy.buffer]
    );
}

// ── WASM offline notch filtering (called after detection) ────────────────────

function _applyNotches(toneFreqs, toneCounts, numFrames) {
    if (!preprocessedSamples || !wasmInstance) { processing = false; return; }

    const sampleRate = window._denoiseSR || 44100;
    const t0 = performance.now();
    const wasm = wasmInstance;
    const mem = wasmMemory;
    wasm.init(sampleRate, NOTCH_Q);

    const tonePtr = wasm.get_tone_input_ptr();
    const audioPtr = wasm.get_audio_buf_ptr();
    const numSamples = preprocessedSamples.length;

    // Copy preprocessed samples — filter this copy
    const output = new Float32Array(preprocessedSamples);

    for (let fi = 0; fi < numFrames; fi++) {
        const start = fi * HOP;
        const end = Math.min(start + HOP, numSamples);
        const chunkLen = end - start;
        if (chunkLen <= 0) break;

        // Write tone frequencies
        const nt = toneCounts[fi];
        const toneView = new Float32Array(mem.buffer, tonePtr, MAX_TONES);
        for (let k = 0; k < MAX_TONES; k++) {
            toneView[k] = k < nt ? toneFreqs[fi * MAX_TONES + k] : 0;
        }
        wasm.update_tones(tonePtr, nt);

        // Copy chunk in, process, copy out
        const audioView = new Float32Array(mem.buffer, audioPtr, chunkLen);
        audioView.set(output.subarray(start, end));
        wasm.process_buf(chunkLen);
        output.set(new Float32Array(mem.buffer, audioPtr, chunkLen), start);
    }

    cleanedSamples = output;
    processing = false;
    console.log(`🎛️ WASM filtering: ${(performance.now() - t0).toFixed(0)}ms`);

    if (denoiseActive) _sendCleanedToWorklet();
    delete window._denoiseSR;
}

// ── Buffer swap ─────────────────────────────────────────────────────────────

function _sendCleanedToWorklet() {
    if (!cleanedSamples || !State.workletNode) return;
    State.workletNode.port.postMessage({
        type: 'swap-buffer',
        samples: cleanedSamples,
        sampleRate: State.currentMetadata?.original_sample_rate || 100,
    });
    console.log('🎛️ Crossfaded to cleaned audio');
}

function _sendOriginalToWorklet() {
    if (!preprocessedSamples || !State.workletNode) return;
    // Send preprocessed (DC removed + normalized) — same level as cleaned,
    // only difference when toggling is the notch filtering
    State.workletNode.port.postMessage({
        type: 'swap-buffer',
        samples: preprocessedSamples,
        sampleRate: State.currentMetadata?.original_sample_rate || 100,
    });
    console.log('🎛️ Crossfaded to original (preprocessed) audio');
}

// ── Toggle ──────────────────────────────────────────────────────────────────

export function toggleDenoise(active) {
    denoiseActive = active;
    console.log(`🎛️ [toggleDenoise] active=${active} hasCleanedSamples=${!!cleanedSamples}`);
    if (active && cleanedSamples) {
        _sendCleanedToWorklet();
        setDetoneMaskAlpha(1.0);
        console.log(`🎛️ [toggleDenoise] alpha → 1.0`);
    } else if (!active) {
        _sendOriginalToWorklet();
        setDetoneMaskAlpha(0.0);
        console.log(`🎛️ [toggleDenoise] alpha → 0.0`);
    }
}

export function isDenoiseActive() { return denoiseActive; }
export function getDenoiseNode() { return null; }
export function syncDenoisePosition() {}
