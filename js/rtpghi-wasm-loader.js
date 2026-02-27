/**
 * RTPGHI WASM Loader
 * Loads and wraps the rtpghi.wasm binary for main-thread offline stretching.
 * Pattern follows workers/kissfft-wasm-loader.js.
 */

let rtpghiWasmExports = null;
let rtpghiWasmMemory = null;
let rtpghiWasmReady = false;

function getRTPGHIHeapF32() {
    return new Float32Array(rtpghiWasmMemory.buffer);
}

/**
 * Load and initialize the RTPGHI WASM module.
 * @param {string} wasmUrl - Path to rtpghi.wasm (default: 'wasm/rtpghi.wasm')
 * @returns {Promise<boolean>} true if loaded successfully
 */
async function initRTPGHIWasm(wasmUrl = 'wasm/rtpghi.wasm') {
    if (rtpghiWasmReady) return true;

    try {
        const importObject = {
            env: {
                emscripten_notify_memory_growth: function() { /* rebind views if needed */ }
            },
            wasi_snapshot_preview1: {
                fd_close: function() { return 52; },
                fd_write: function() { return 0; },
                fd_seek:  function() { return 70; }
            }
        };

        let result;
        try {
            result = await WebAssembly.instantiateStreaming(fetch(wasmUrl), importObject);
        } catch (e) {
            // Fallback for environments that don't support instantiateStreaming
            const response = await fetch(wasmUrl);
            const bytes = await response.arrayBuffer();
            result = await WebAssembly.instantiate(bytes, importObject);
        }

        rtpghiWasmExports = result.instance.exports;
        rtpghiWasmMemory = rtpghiWasmExports.memory;
        rtpghiWasmReady = true;

        const heapKB = (rtpghiWasmMemory.buffer.byteLength / 1024).toFixed(0);
        console.log(`%c[RTPGHI WASM] Loaded (${heapKB} KB heap)`,
            'color: #4CAF50; font-weight: bold');
        return true;
    } catch (err) {
        console.warn('%c[RTPGHI WASM] Failed to load — JS fallback will be used',
            'color: #FF9800; font-weight: bold', err);
        rtpghiWasmReady = false;
        return false;
    }
}

/**
 * Phase mode string to int mapping.
 */
const RTPGHI_PHASE_MAP = { full: 0, time: 1, freq: 2, zero: 3 };
const RTPGHI_WINDOW_MAP = { gauss: 0, hann: 1 };

/**
 * Stretch audio using RTPGHI WASM.
 * @param {Float32Array} source - Input audio samples
 * @param {number} stretchFactor - Time stretch factor (e.g. 2.0 = 2x slower)
 * @param {Object} opts - Algorithm parameters
 * @param {number} [opts.M=2048] - FFT size
 * @param {number} [opts.hopDiv=8] - Hop divisor
 * @param {number} [opts.gamma=0] - Gaussian window parameter (0 = auto)
 * @param {number} [opts.tol=10] - Magnitude threshold
 * @param {string} [opts.phaseMode='full'] - Phase mode: 'full', 'time', 'freq', 'zero'
 * @param {string} [opts.windowType='gauss'] - Window: 'gauss' or 'hann'
 * @returns {Float32Array} Stretched audio samples
 */
function rtpghiStretchWASM(source, stretchFactor, opts = {}) {
    if (!rtpghiWasmReady) throw new Error('RTPGHI WASM not initialized');

    const ex = rtpghiWasmExports;
    const M        = opts.M || 2048;
    const hopDiv   = opts.hopDiv || 8;
    const gamma    = opts.gamma || 0;  // 0 = auto in C
    const tol      = opts.tol || 10;
    const phaseMode  = RTPGHI_PHASE_MAP[opts.phaseMode || 'full'] || 0;
    const windowType = RTPGHI_WINDOW_MAP[opts.windowType || 'gauss'] || 0;

    // Create plan
    const plan = ex.rtpghi_init(M, hopDiv, gamma, tol, phaseMode, windowType);
    if (!plan) throw new Error('RTPGHI WASM: failed to create plan');

    // Query output length
    const outLen = ex.rtpghi_output_length(source.length, M, hopDiv, stretchFactor);
    if (outLen <= 0) {
        ex.rtpghi_free(plan);
        return new Float32Array(0);
    }

    // Allocate WASM buffers
    const inputPtr  = ex.wasm_malloc(source.length * 4);
    const outputPtr = ex.wasm_malloc(outLen * 4);
    if (!inputPtr || !outputPtr) {
        if (inputPtr) ex.wasm_free(inputPtr);
        if (outputPtr) ex.wasm_free(outputPtr);
        ex.rtpghi_free(plan);
        throw new Error('RTPGHI WASM: memory allocation failed');
    }

    // Copy source audio into WASM heap
    let heap = getRTPGHIHeapF32();
    heap.set(source, inputPtr >> 2);

    // Run the stretch
    const t0 = performance.now();
    const actualLen = ex.rtpghi_stretch_block(
        plan, inputPtr, source.length, outputPtr, outLen, stretchFactor
    );
    const elapsed = performance.now() - t0;

    // Refresh heap view (memory may have grown)
    heap = getRTPGHIHeapF32();

    // Copy result out
    const result = new Float32Array(actualLen);
    result.set(heap.subarray(outputPtr >> 2, (outputPtr >> 2) + actualLen));

    // Cleanup
    ex.wasm_free(inputPtr);
    ex.wasm_free(outputPtr);
    ex.rtpghi_free(plan);

    const speedup = (source.length / 44100) / (elapsed / 1000);
    console.log(
        `%c[RTPGHI WASM] ${source.length.toLocaleString()} → ${actualLen.toLocaleString()} samples ` +
        `(${stretchFactor.toFixed(2)}x) in ${elapsed.toFixed(0)}ms (${speedup.toFixed(1)}x realtime)`,
        'color: #9C27B0; font-weight: bold'
    );

    return result;
}

/**
 * Async stretch using chunked WASM API — allows progress updates between batches.
 * @param {Float32Array} source - Input audio samples
 * @param {number} stretchFactor - Time stretch factor
 * @param {Object} opts - Same as rtpghiStretchWASM, plus:
 * @param {function} [opts.onProgress] - Callback(fraction) called between batches
 * @param {number} [opts.batchSize=128] - Frames per batch (higher = fewer yields, lower = smoother progress)
 * @returns {Promise<Float32Array>} Stretched audio samples
 */
async function rtpghiStretchWASMAsync(source, stretchFactor, opts = {}) {
    if (!rtpghiWasmReady) throw new Error('RTPGHI WASM not initialized');

    const ex = rtpghiWasmExports;
    const M        = opts.M || 2048;
    const hopDiv   = opts.hopDiv || 8;
    const gamma    = opts.gamma || 0;
    const tol      = opts.tol || 10;
    const phaseMode  = RTPGHI_PHASE_MAP[opts.phaseMode || 'full'] || 0;
    const windowType = RTPGHI_WINDOW_MAP[opts.windowType || 'gauss'] || 0;
    const batchSize  = opts.batchSize || 128;
    const onProgress = opts.onProgress || null;

    const plan = ex.rtpghi_init(M, hopDiv, gamma, tol, phaseMode, windowType);
    if (!plan) throw new Error('RTPGHI WASM: failed to create plan');

    const outLen = ex.rtpghi_output_length(source.length, M, hopDiv, stretchFactor);
    if (outLen <= 0) {
        ex.rtpghi_free(plan);
        return new Float32Array(0);
    }

    const inputPtr  = ex.wasm_malloc(source.length * 4);
    const outputPtr = ex.wasm_malloc(outLen * 4);
    if (!inputPtr || !outputPtr) {
        if (inputPtr) ex.wasm_free(inputPtr);
        if (outputPtr) ex.wasm_free(outputPtr);
        ex.rtpghi_free(plan);
        throw new Error('RTPGHI WASM: memory allocation failed');
    }

    let heap = getRTPGHIHeapF32();
    heap.set(source, inputPtr >> 2);

    const t0 = performance.now();

    // Begin streaming stretch — returns total number of frames
    const totalFrames = ex.rtpghi_begin_stretch(
        plan, inputPtr, source.length, outputPtr, outLen, stretchFactor
    );

    // Process in batches, yielding between each for UI updates
    let framesProcessed = 0;
    while (framesProcessed < totalFrames) {
        framesProcessed = ex.rtpghi_process_frames(plan, batchSize);
        if (onProgress) onProgress(framesProcessed / totalFrames);
        // Yield to event loop so browser can paint
        await new Promise(r => setTimeout(r, 0));
    }

    // Finalize — normalize + trim
    const actualLen = ex.rtpghi_finish_stretch(plan);
    const elapsed = performance.now() - t0;

    heap = getRTPGHIHeapF32();
    const result = new Float32Array(actualLen);
    result.set(heap.subarray(outputPtr >> 2, (outputPtr >> 2) + actualLen));

    ex.wasm_free(inputPtr);
    ex.wasm_free(outputPtr);
    ex.rtpghi_free(plan);

    const speedup = (source.length / 44100) / (elapsed / 1000);
    console.log(
        `%c[RTPGHI WASM] ${source.length.toLocaleString()} → ${actualLen.toLocaleString()} samples ` +
        `(${stretchFactor.toFixed(2)}x) in ${elapsed.toFixed(0)}ms (${speedup.toFixed(1)}x realtime) [async]`,
        'color: #9C27B0; font-weight: bold'
    );

    return result;
}
