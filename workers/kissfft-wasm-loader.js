/**
 * kissfft-wasm-loader.js
 * Loader for custom KissFFT WASM binary (built from wasm/src/).
 * Provides single-FFT and batched-tile FFT functions for Web Workers.
 *
 * Exports (via globals, since this is loaded with importScripts):
 *   initKissFFT()                        → async, returns true/false
 *   performFFT_WASM(signal)              → Float32Array of magnitudes (N/2)
 *   processTileWASM(audioData, window, fftSize, hopSize, numSlices)
 *                                        → Float32Array magnitudes (row-major)
 *   processTileUint8WASM(audioData, window, fftSize, hopSize, numSlices, lutArray)
 *                                        → Uint8Array magnitudes (row-major)
 *   wasmReady                            → boolean
 *
 * KissFFT is BSD-3-Clause licensed. See wasm/KISSFFT-LICENSE.
 */

// ─── State ──────────────────────────────────────────────────────────────────

let wasmExports = null;
let wasmMemory = null;
var wasmReady = false;

// Reusable WASM-side buffer pointers for single-FFT path
let wasmSingleInputPtr = 0;
let wasmSingleWindowPtr = 0;
let wasmSingleMagPtr = 0;
let wasmSingleScratchPtr = 0;
let wasmSingleFFTSize = 0;

// Reusable WASM-side buffer pointers for batch path
let wasmBatchAudioPtr = 0;
let wasmBatchWindowPtr = 0;
let wasmBatchOutputPtr = 0;
let wasmBatchLutPtr = 0;
let wasmBatchAudioLen = 0;
let wasmBatchOutputLen = 0;
let wasmBatchFFTSize = 0;
let wasmBatchLutAllocated = false;
let wasmTileTimingCount = 0;

// ─── Helpers ────────────────────────────────────────────────────────────────

function getHeapF32() {
    return new Float32Array(wasmMemory.buffer);
}

function getHeapU8() {
    return new Uint8Array(wasmMemory.buffer);
}

// ─── WASM import stubs ──────────────────────────────────────────────────────
// Our custom build requires only 4 imports (much simpler than pre-built):
//   env.emscripten_notify_memory_growth  → no-op callback
//   wasi_snapshot_preview1.fd_close      → stub
//   wasi_snapshot_preview1.fd_write      → stub
//   wasi_snapshot_preview1.fd_seek       → stub

// ─── WASM initialization ────────────────────────────────────────────────────

async function initKissFFT() {
    try {
        const wasmUrl = new URL('../wasm/kissfft.wasm', self.location.href).href;

        const importObject = {
            env: {
                emscripten_notify_memory_growth: () => { /* memory grew — views refreshed on use */ }
            },
            wasi_snapshot_preview1: {
                fd_close: () => 52,
                fd_write: () => 0,
                fd_seek: () => 70
            }
        };

        let result;
        try {
            result = await WebAssembly.instantiateStreaming(fetch(wasmUrl), importObject);
        } catch (streamErr) {
            console.warn('KissFFT: streaming compile failed, using ArrayBuffer fallback:', streamErr.message);
            const response = await fetch(wasmUrl);
            const bytes = await response.arrayBuffer();
            result = await WebAssembly.instantiate(bytes, importObject);
        }

        wasmExports = result.instance.exports;
        wasmMemory = wasmExports.memory;

        wasmReady = true;
        const wasmSize = (wasmMemory.buffer.byteLength / 1024).toFixed(0);
        console.log(`%c[KissFFT WASM] Loaded (${wasmSize} KB heap, 22 KB binary)`,
            'color: #4CAF50; font-weight: bold');
        return true;

    } catch (err) {
        console.warn('%c[KissFFT WASM] Failed to load — falling back to JS FFT',
            'color: #FF9800; font-weight: bold', err);
        wasmReady = false;
        return false;
    }
}

// ─── Single FFT (per-slice, used by compute-batch) ──────────────────────────

/**
 * Ensure WASM buffers are allocated for single-FFT path.
 */
function ensureSingleBuffers(fftSize) {
    if (wasmSingleFFTSize === fftSize) return;

    const wfree = wasmExports.wasm_free;
    const wmalloc = wasmExports.wasm_malloc;

    if (wasmSingleInputPtr) wfree(wasmSingleInputPtr);
    if (wasmSingleWindowPtr) wfree(wasmSingleWindowPtr);
    if (wasmSingleMagPtr) wfree(wasmSingleMagPtr);
    if (wasmSingleScratchPtr) wfree(wasmSingleScratchPtr);

    const halfN = fftSize / 2;
    wasmSingleInputPtr = wmalloc(fftSize * 4);
    wasmSingleWindowPtr = wmalloc(fftSize * 4);
    wasmSingleMagPtr = wmalloc(halfN * 4);
    wasmSingleScratchPtr = wmalloc(fftSize * 4);
    wasmSingleFFTSize = fftSize;
}

/**
 * Perform a single real-valued FFT using KissFFT WASM.
 * The signal must already be windowed by the caller.
 * Returns Float32Array of magnitudes (length N/2), normalized by N.
 *
 * Uses the shared fftMagnitudeBuf pattern (caller must copy before next call).
 */
function performFFT_WASM(signal) {
    const N = signal.length;
    const halfN = N / 2;

    ensureSingleBuffers(N);
    ensureFFTBuffers(N); // Allocate shared fftMagnitudeBuf (defined in worker scope)

    const heap = getHeapF32();

    // Copy signal into WASM input buffer
    heap.set(signal, wasmSingleInputPtr / 4);

    // Set window to all 1.0 (signal is already windowed by caller)
    const windowOffset = wasmSingleWindowPtr / 4;
    for (let i = 0; i < N; i++) {
        heap[windowOffset + i] = 1.0;
    }

    // fft_single(signal, window, magnitudes, fft_size, scratch)
    wasmExports.fft_single(
        wasmSingleInputPtr, wasmSingleWindowPtr,
        wasmSingleMagPtr, N, wasmSingleScratchPtr
    );

    // Read magnitudes from WASM memory into shared JS buffer
    const magOffset = wasmSingleMagPtr / 4;
    const freshHeap = getHeapF32(); // refresh in case memory grew
    const magnitudes = fftMagnitudeBuf;
    for (let k = 0; k < halfN; k++) {
        magnitudes[k] = freshHeap[magOffset + k];
    }

    return magnitudes;
}

// ─── Batch tile processing (all slices in one WASM call) ────────────────────

/**
 * Ensure WASM buffers for batch tile processing.
 */
function ensureBatchBuffers(audioLen, fftSize, numSlices) {
    const freqBins = fftSize / 2;
    const outputLen = numSlices * freqBins;
    const wmalloc = wasmExports.wasm_malloc;
    const wfree = wasmExports.wasm_free;

    // Reallocate audio buffer if needed
    if (audioLen > wasmBatchAudioLen) {
        if (wasmBatchAudioPtr) wfree(wasmBatchAudioPtr);
        wasmBatchAudioPtr = wmalloc(audioLen * 4);
        wasmBatchAudioLen = audioLen;
    }

    // Reallocate window buffer if FFT size changed
    if (fftSize !== wasmBatchFFTSize) {
        if (wasmBatchWindowPtr) wfree(wasmBatchWindowPtr);
        wasmBatchWindowPtr = wmalloc(fftSize * 4);
        wasmBatchFFTSize = fftSize;
    }

    // Reallocate output buffer if needed
    if (outputLen > wasmBatchOutputLen) {
        if (wasmBatchOutputPtr) wfree(wasmBatchOutputPtr);
        wasmBatchOutputPtr = wmalloc(outputLen * 4); // Float32 for magnitudes
        wasmBatchOutputLen = outputLen;
    }
}

/**
 * Process an entire spectrogram tile in WASM.
 * Performs windowing + FFT + magnitude extraction for ALL time slices
 * in a single WASM call — no per-slice JS↔WASM boundary crossings.
 *
 * @param audioData   Float32Array — raw audio samples for this tile
 * @param window      Float32Array — Hann window (length = fftSize)
 * @param fftSize     number
 * @param hopSize     number
 * @param numSlices   number — time slices in this tile
 * @returns Float32Array — magnitudes in row-major layout [bin * numSlices + col]
 */
function processTileWASM(audioData, window, fftSize, hopSize, numSlices) {
    const freqBins = fftSize / 2;
    const outputLen = numSlices * freqBins;

    ensureBatchBuffers(audioData.length, fftSize, numSlices);

    let heap = getHeapF32();

    // Copy audio data into WASM memory
    heap.set(audioData, wasmBatchAudioPtr / 4);

    // Copy Hann window into WASM memory
    heap.set(window, wasmBatchWindowPtr / 4);

    // Run entire tile through WASM: window + FFT + magnitudes
    wasmExports.fft_batch_magnitudes(
        wasmBatchAudioPtr, wasmBatchWindowPtr, wasmBatchOutputPtr,
        fftSize, hopSize, numSlices
    );

    // Copy results out of WASM memory
    heap = getHeapF32(); // refresh in case memory grew during processing
    const result = new Float32Array(outputLen);
    const outOffset = wasmBatchOutputPtr / 4;
    result.set(heap.subarray(outOffset, outOffset + outputLen));
    return result;
}

/**
 * Process an entire tile and output Uint8 magnitudes via dB-scale LUT.
 * The LUT is the same MAG_TO_UINT8 array from the worker.
 *
 * @param audioData     Float32Array — raw audio samples
 * @param window        Float32Array — Hann window
 * @param fftSize       number
 * @param hopSize       number
 * @param numSlices     number
 * @param lutArray      Uint8Array — the MAG_TO_UINT8 lookup table (65536 entries)
 * @returns Uint8Array — magnitudes in row-major layout [bin * numSlices + col]
 */
function processTileUint8WASM(audioData, window, fftSize, hopSize, numSlices, lutArray) {
    const freqBins = fftSize / 2;
    const outputLen = numSlices * freqBins;
    const wmalloc = wasmExports.wasm_malloc;
    const wfree = wasmExports.wasm_free;

    const t0 = performance.now();

    ensureBatchBuffers(audioData.length, fftSize, numSlices);

    // Allocate LUT in WASM memory (only once — 64KB, reusable)
    if (!wasmBatchLutAllocated) {
        wasmBatchLutPtr = wmalloc(65536);
        wasmBatchLutAllocated = true;
    }

    const uint8OutPtr = wmalloc(outputLen);

    let heap = getHeapF32();
    let heapU8 = getHeapU8();

    const tCopyIn = performance.now();
    // Copy audio data + window + LUT into WASM memory
    heap.set(audioData, wasmBatchAudioPtr / 4);
    heap.set(window, wasmBatchWindowPtr / 4);
    heapU8.set(lutArray, wasmBatchLutPtr);
    const tCopyInDone = performance.now();

    // Run entire tile: window + FFT + magnitudes + LUT → uint8
    const tCompute = performance.now();
    wasmExports.fft_batch_uint8(
        wasmBatchAudioPtr, wasmBatchWindowPtr, uint8OutPtr, wasmBatchLutPtr,
        fftSize, hopSize, numSlices
    );
    const tComputeDone = performance.now();

    // Copy uint8 results out
    const tCopyOut = performance.now();
    heapU8 = getHeapU8(); // refresh
    const result = new Uint8Array(outputLen);
    result.set(heapU8.subarray(uint8OutPtr, uint8OutPtr + outputLen));
    const tCopyOutDone = performance.now();

    wfree(uint8OutPtr);

    // Log timing breakdown for first few tiles
    if (wasmTileTimingCount < 5) {
        const total = tCopyOutDone - t0;
        const copyIn = tCopyInDone - tCopyIn;
        const compute = tComputeDone - tCompute;
        const copyOut = tCopyOutDone - tCopyOut;
        console.log(
            `%c  [WASM breakdown] ${total.toFixed(2)}ms total` +
            ` = ${copyIn.toFixed(2)}ms copy-in (${(audioData.length * 4 / 1024).toFixed(0)} KB)` +
            ` + ${compute.toFixed(2)}ms compute (${numSlices}×${fftSize} FFT)` +
            ` + ${copyOut.toFixed(2)}ms copy-out (${(outputLen / 1024).toFixed(0)} KB)`,
            'color: #9C27B0'
        );
        wasmTileTimingCount++;
    }

    return result;
}
