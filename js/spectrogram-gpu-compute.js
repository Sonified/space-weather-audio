/**
 * spectrogram-gpu-compute.js — WebGPU Compute Shader FFT for Spectrogram Tiles
 *
 * Replaces CPU worker pool with GPU-accelerated FFT using Stockham autosort algorithm.
 * Falls back to SpectrogramWorkerPool when WebGPU is unavailable.
 *
 * MEGA-BATCH: All tiles dispatched in a single GPU call.
 *   Audio concatenated → one upload → 2D dispatch(slices, tiles) → one readback → split.
 *   Streaming-friendly: batch whatever tiles are available.
 *
 * Interface matches SpectrogramWorkerPool.processTiles() exactly:
 *   processTiles(tiles, onTileComplete, signal)
 *   where onTileComplete(tileIndex, magnitudeData: Uint8Array, width, height)
 */

import { isStudyMode } from './master-modes.js';

// ─── WGSL Compute Shader (generated per FFT size) ───────────────────────────
// Stockham autosort FFT: ping-pong between two shared memory arrays.
// 2D dispatch: workgroup_id.x = time slice within tile, workgroup_id.y = tile index.
// 256 threads per workgroup. Array sizes scale with FFT size.

function buildFFTShader(fftSize) {
    // Each shared array holds fftSize complex values = fftSize * 2 floats
    const sharedArraySize = fftSize * 2;
    return /* wgsl */ `

struct Params {
    fftSize:      u32,
    hopSize:      f32,
    numSlices:    u32,
    freqBins:     u32,
    dbFloor:      f32,
    dbRange:      f32,
    invN:         f32,
    logStages:    u32,
};

@group(0) @binding(0) var<storage, read> audioData: array<f32>;
@group(0) @binding(1) var<storage, read> hannWindow: array<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<atomic<u32>>;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var<storage, read> tileDescs: array<u32>;

// Shared memory: two complex arrays for ping-pong Stockham FFT
// ${fftSize} complex values = ${sharedArraySize} f32 each = ${sharedArraySize * 4 * 2} bytes total
var<workgroup> sA: array<f32, ${sharedArraySize}>;
var<workgroup> sB: array<f32, ${sharedArraySize}>;

const WORKGROUP_SIZE: u32 = 256u;

@compute @workgroup_size(256)
fn fft_main(
    @builtin(workgroup_id) wg_id: vec3<u32>,
    @builtin(local_invocation_id) lid: vec3<u32>,
) {
    let N: u32 = params.fftSize;
    let halfN: u32 = N / 2u;
    let col: u32 = wg_id.x;                // time slice within this tile
    let tileIdx: u32 = wg_id.y;            // which tile in the batch
    let tid: u32 = lid.x;                   // thread ID: 0..255
    let elemsPerThread: u32 = N / WORKGROUP_SIZE;  // 2048/256 = 8

    // Per-tile offsets from descriptor buffer
    let audioBase: u32 = tileDescs[tileIdx * 2u];
    let outputBase: u32 = tileDescs[tileIdx * 2u + 1u];

    let baseOffset: u32 = audioBase + u32(round(f32(col) * params.hopSize));

    // ── Load audio into shared memory with Hann windowing ──
    for (var k: u32 = 0u; k < elemsPerThread; k++) {
        let i: u32 = tid * elemsPerThread + k;
        let sample: f32 = audioData[baseOffset + i] * hannWindow[i];
        sA[i * 2u] = sample;       // real
        sA[i * 2u + 1u] = 0.0;     // imag
    }

    workgroupBarrier();

    // ── Stockham autosort FFT ──
    let butterfliesPerThread: u32 = halfN / WORKGROUP_SIZE;  // 1024/256 = 4

    for (var s: u32 = 0u; s < params.logStages; s++) {
        let halfSpan: u32 = 1u << s;
        let span: u32 = halfSpan << 1u;

        for (var k: u32 = 0u; k < butterfliesPerThread; k++) {
            let bflyIdx: u32 = tid * butterfliesPerThread + k;

            let group: u32 = bflyIdx / halfSpan;
            let pos: u32 = bflyIdx % halfSpan;

            let srcEven: u32 = group * halfSpan + pos;
            let srcOdd: u32 = srcEven + halfN;

            let dst0: u32 = group * span + pos;
            let dst1: u32 = dst0 + halfSpan;

            let angle: f32 = -6.283185307 * f32(pos) / f32(span);
            let twR: f32 = cos(angle);
            let twI: f32 = sin(angle);

            var eR: f32; var eI: f32; var oR: f32; var oI: f32;
            if (s % 2u == 0u) {
                eR = sA[srcEven * 2u]; eI = sA[srcEven * 2u + 1u];
                oR = sA[srcOdd * 2u];  oI = sA[srcOdd * 2u + 1u];
            } else {
                eR = sB[srcEven * 2u]; eI = sB[srcEven * 2u + 1u];
                oR = sB[srcOdd * 2u];  oI = sB[srcOdd * 2u + 1u];
            }

            let tR: f32 = oR * twR - oI * twI;
            let tI: f32 = oR * twI + oI * twR;

            if (s % 2u == 0u) {
                sB[dst0 * 2u] = eR + tR;  sB[dst0 * 2u + 1u] = eI + tI;
                sB[dst1 * 2u] = eR - tR;  sB[dst1 * 2u + 1u] = eI - tI;
            } else {
                sA[dst0 * 2u] = eR + tR;  sA[dst0 * 2u + 1u] = eI + tI;
                sA[dst1 * 2u] = eR - tR;  sA[dst1 * 2u + 1u] = eI - tI;
            }
        }

        workgroupBarrier();
    }

    // ── Magnitude extraction + dB → Uint8 ──
    let binsPerThread: u32 = params.freqBins / WORKGROUP_SIZE;  // 1024/256 = 4
    let resultInB: bool = (params.logStages % 2u) == 1u;

    for (var k: u32 = 0u; k < binsPerThread; k++) {
        let bin: u32 = tid * binsPerThread + k;

        var re: f32; var im: f32;
        if (resultInB) {
            re = sB[bin * 2u];
            im = sB[bin * 2u + 1u];
        } else {
            re = sA[bin * 2u];
            im = sA[bin * 2u + 1u];
        }

        let mag: f32 = sqrt(re * re + im * im) * params.invN;

        // dB conversion: 20 * log10(mag) = 20 * ln(mag) / ln(10)
        let db: f32 = 20.0 * log(mag + 1e-10) / 2.302585093;
        let normalized: f32 = (db - params.dbFloor) / params.dbRange;
        let clamped: f32 = clamp(normalized, 0.0, 1.0);
        let uint8Val: u32 = u32(clamped * 255.0 + 0.5);

        // Pack bytes: 4 uint8 values per u32 via atomicOr
        // Column-major layout with aligned stride for GPU texture copy
        let linearIdx: u32 = outputBase + bin * params.numSlices + col;
        let wordIdx: u32 = linearIdx / 4u;
        let byteShift: u32 = (linearIdx % 4u) * 8u;
        atomicOr(&output[wordIdx], uint8Val << byteShift);
    }
}
`;
}

// ─── Two-Pass Sub-FFT Shader (for FFT sizes exceeding shared memory) ────────
// Cooley-Tukey DIT: split input into even/odd indexed samples, run M-point
// Stockham FFT on each half, write complex results to intermediate global buffer.
// Dispatch: (numSlices, numTiles * 2) — wg_id.y encodes tileIdx*2 + halfIdx.

function buildSubFFTShader(subFFTSize, numSubFFTs = 2) {
    const sharedArraySize = subFFTSize * 2;
    const logStages = Math.log2(subFFTSize);
    return /* wgsl */ `

struct Params {
    subFFTSize:   u32,
    hopSize:      f32,
    numSlices:    u32,
    freqBins:     u32,
    dbFloor:      f32,
    dbRange:      f32,
    invN:         f32,
    logStages:    u32,
};

@group(0) @binding(0) var<storage, read> audioData: array<f32>;
@group(0) @binding(1) var<storage, read> hannWindow: array<f32>;
@group(0) @binding(2) var<storage, read_write> intermediate: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var<storage, read> tileDescs: array<u32>;

// Shared memory for M-point Stockham FFT (fits in 32KB for M=2048)
var<workgroup> sA: array<f32, ${sharedArraySize}>;
var<workgroup> sB: array<f32, ${sharedArraySize}>;

const WORKGROUP_SIZE: u32 = 256u;

@compute @workgroup_size(256)
fn subfft_main(
    @builtin(workgroup_id) wg_id: vec3<u32>,
    @builtin(local_invocation_id) lid: vec3<u32>,
) {
    let M: u32 = params.subFFTSize;                // base sub-FFT size (e.g. 2048)
    let halfM: u32 = M / 2u;
    let col: u32 = wg_id.x;                        // time slice
    let subIdx: u32 = wg_id.y % ${numSubFFTs}u;    // which sub-FFT (0..${numSubFFTs - 1})
    let tileIdx: u32 = wg_id.y / ${numSubFFTs}u;   // tile in batch
    let tid: u32 = lid.x;
    let elemsPerThread: u32 = M / WORKGROUP_SIZE;   // 2048/256 = 8

    // Per-tile offsets
    let audioBase: u32 = tileDescs[tileIdx * 2u];
    let intermediateBase: u32 = tileDescs[tileIdx * 2u + 1u];

    let baseOffset: u32 = audioBase + u32(round(f32(col) * params.hopSize));

    // ── Load with stride-${numSubFFTs} deinterleaving + Hann windowing ──
    for (var k: u32 = 0u; k < elemsPerThread; k++) {
        let i: u32 = tid * elemsPerThread + k;
        let srcIdx: u32 = i * ${numSubFFTs}u + subIdx;
        let sample: f32 = audioData[baseOffset + srcIdx] * hannWindow[srcIdx];
        sA[i * 2u] = sample;       // real
        sA[i * 2u + 1u] = 0.0;     // imag
    }

    workgroupBarrier();

    // ── Stockham autosort FFT (M-point, identical to single-pass) ──
    let butterfliesPerThread: u32 = halfM / WORKGROUP_SIZE;

    for (var s: u32 = 0u; s < ${logStages}u; s++) {
        let halfSpan: u32 = 1u << s;
        let span: u32 = halfSpan << 1u;

        for (var k: u32 = 0u; k < butterfliesPerThread; k++) {
            let bflyIdx: u32 = tid * butterfliesPerThread + k;
            let group: u32 = bflyIdx / halfSpan;
            let pos: u32 = bflyIdx % halfSpan;
            let srcEven: u32 = group * halfSpan + pos;
            let srcOdd: u32 = srcEven + halfM;
            let dst0: u32 = group * span + pos;
            let dst1: u32 = dst0 + halfSpan;

            let angle: f32 = -6.283185307 * f32(pos) / f32(span);
            let twR: f32 = cos(angle);
            let twI: f32 = sin(angle);

            var eR: f32; var eI: f32; var oR: f32; var oI: f32;
            if (s % 2u == 0u) {
                eR = sA[srcEven * 2u]; eI = sA[srcEven * 2u + 1u];
                oR = sA[srcOdd * 2u];  oI = sA[srcOdd * 2u + 1u];
            } else {
                eR = sB[srcEven * 2u]; eI = sB[srcEven * 2u + 1u];
                oR = sB[srcOdd * 2u];  oI = sB[srcOdd * 2u + 1u];
            }

            let tR: f32 = oR * twR - oI * twI;
            let tI: f32 = oR * twI + oI * twR;

            if (s % 2u == 0u) {
                sB[dst0 * 2u] = eR + tR;  sB[dst0 * 2u + 1u] = eI + tI;
                sB[dst1 * 2u] = eR - tR;  sB[dst1 * 2u + 1u] = eI - tI;
            } else {
                sA[dst0 * 2u] = eR + tR;  sA[dst0 * 2u + 1u] = eI + tI;
                sA[dst1 * 2u] = eR - tR;  sA[dst1 * 2u + 1u] = eI - tI;
            }
        }
        workgroupBarrier();
    }

    // ── Write complex results to intermediate global buffer ──
    let resultInB: bool = (${logStages}u % 2u) == 1u;
    let binsPerThread: u32 = M / WORKGROUP_SIZE;  // write all M complex values
    // Layout: intermediateBase + subIdx * numSlices * M * 2 + col * M * 2 + bin * 2
    let subOffset: u32 = intermediateBase + subIdx * params.numSlices * M * 2u;
    let colOffset: u32 = subOffset + col * M * 2u;

    for (var k: u32 = 0u; k < binsPerThread; k++) {
        let bin: u32 = tid * binsPerThread + k;
        var re: f32; var im: f32;
        if (resultInB) {
            re = sB[bin * 2u]; im = sB[bin * 2u + 1u];
        } else {
            re = sA[bin * 2u]; im = sA[bin * 2u + 1u];
        }
        intermediate[colOffset + bin * 2u] = re;
        intermediate[colOffset + bin * 2u + 1u] = im;
    }
}
`;
}

// ─── Two-Pass Combine Shader ────────────────────────────────────────────────
// Reads even/odd sub-FFT results from intermediate buffer, applies twiddle
// factors, combines via Cooley-Tukey butterfly, computes magnitude→dB→uint8.
// No shared memory needed — purely element-wise.

function buildCombineShader() {
    return /* wgsl */ `

struct CombineParams {
    fullN:     u32,
    halfN:     u32,
    numSlices: u32,
    freqBins:  u32,
    dbFloor:   f32,
    dbRange:   f32,
    invN:      f32,
    _pad:      u32,
};

@group(0) @binding(0) var<storage, read> intermediate: array<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> params: CombineParams;
@group(0) @binding(3) var<storage, read> tileDescs: array<u32>;

const WORKGROUP_SIZE: u32 = 256u;

@compute @workgroup_size(256)
fn combine_main(
    @builtin(workgroup_id) wg_id: vec3<u32>,
    @builtin(local_invocation_id) lid: vec3<u32>,
) {
    let col: u32 = wg_id.x;
    let tileIdx: u32 = wg_id.y;
    let M: u32 = params.halfN;
    let N: u32 = params.fullN;
    let tid: u32 = lid.x;

    // Tile descriptors for combine pass: [evenBase, oddBase, outputBase, 0]
    let evenBase: u32 = tileDescs[tileIdx * 4u];
    let oddBase: u32 = tileDescs[tileIdx * 4u + 1u];
    let outputBase: u32 = tileDescs[tileIdx * 4u + 2u];

    let binsPerThread: u32 = params.freqBins / WORKGROUP_SIZE;

    for (var k: u32 = 0u; k < binsPerThread; k++) {
        let bin: u32 = tid * binsPerThread + k;
        let kMod: u32 = bin % M;

        // Read E[kMod] from even sub-FFT
        let eIdx: u32 = evenBase + col * M * 2u + kMod * 2u;
        let eR: f32 = intermediate[eIdx];
        let eI: f32 = intermediate[eIdx + 1u];

        // Read O[kMod] from odd sub-FFT
        let oIdx: u32 = oddBase + col * M * 2u + kMod * 2u;
        let oR: f32 = intermediate[oIdx];
        let oI: f32 = intermediate[oIdx + 1u];

        // Twiddle factor: W_N^bin = e^(-2πi·bin/N)
        let angle: f32 = -6.283185307 * f32(bin) / f32(N);
        let twR: f32 = cos(angle);
        let twI: f32 = sin(angle);

        // W * O[kMod]
        let tR: f32 = oR * twR - oI * twI;
        let tI: f32 = oR * twI + oI * twR;

        // Combine: X[bin] = E[kMod] ± W·O[kMod]
        var re: f32; var im: f32;
        if (bin < M) {
            re = eR + tR; im = eI + tI;
        } else {
            re = eR - tR; im = eI - tI;
        }

        // Magnitude → dB → uint8
        let mag: f32 = sqrt(re * re + im * im) * params.invN;
        let db: f32 = 20.0 * log(mag + 1e-10) / 2.302585093;
        let normalized: f32 = (db - params.dbFloor) / params.dbRange;
        let clamped: f32 = clamp(normalized, 0.0, 1.0);
        let uint8Val: u32 = u32(clamped * 255.0 + 0.5);

        // Column-major u8 pack (identical to single-pass output)
        let linearIdx: u32 = outputBase + bin * params.numSlices + col;
        let wordIdx: u32 = linearIdx / 4u;
        let byteShift: u32 = (linearIdx % 4u) * 8u;
        atomicOr(&output[wordIdx], uint8Val << byteShift);
    }
}
`;
}

// ─── Intermediate Combine Shader (complex → complex) ────────────────────────
// For multi-pass FFT (8192+): combines pairs of sub-FFT results with twiddle
// factors, outputting complex f32 pairs for the next combine level.
// No shared memory needed — purely element-wise global memory operations.

function buildIntermediateCombineShader() {
    return /* wgsl */ `

struct IntCombineParams {
    combineN:  u32,   // combined size (e.g. 4096)
    halfN:     u32,   // each input sub-result size (e.g. 2048)
    numSlices: u32,
    _pad:      u32,
};

@group(0) @binding(0) var<storage, read> input: array<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@group(0) @binding(2) var<uniform> params: IntCombineParams;
@group(0) @binding(3) var<storage, read> tileDescs: array<u32>;

const WORKGROUP_SIZE: u32 = 256u;

@compute @workgroup_size(256)
fn int_combine_main(
    @builtin(workgroup_id) wg_id: vec3<u32>,
    @builtin(local_invocation_id) lid: vec3<u32>,
) {
    let col: u32 = wg_id.x;
    let pairIdx: u32 = wg_id.y;
    let M: u32 = params.halfN;
    let N: u32 = params.combineN;
    let tid: u32 = lid.x;

    // Tile descriptors: [evenBase, oddBase, outputBase, _pad] per pair
    let evenBase: u32 = tileDescs[pairIdx * 4u];
    let oddBase: u32 = tileDescs[pairIdx * 4u + 1u];
    let outputBase: u32 = tileDescs[pairIdx * 4u + 2u];

    let valsPerThread: u32 = N / WORKGROUP_SIZE;

    for (var k: u32 = 0u; k < valsPerThread; k++) {
        let idx: u32 = tid * valsPerThread + k;
        let kMod: u32 = idx % M;

        // Read E[kMod] from even sub-result
        let eIdx: u32 = evenBase + col * M * 2u + kMod * 2u;
        let eR: f32 = input[eIdx];
        let eI: f32 = input[eIdx + 1u];

        // Read O[kMod] from odd sub-result
        let oIdx: u32 = oddBase + col * M * 2u + kMod * 2u;
        let oR: f32 = input[oIdx];
        let oI: f32 = input[oIdx + 1u];

        // Twiddle: W_N^idx — always add; twiddle encodes sign for second half
        let angle: f32 = -6.283185307 * f32(idx) / f32(N);
        let twR: f32 = cos(angle);
        let twI: f32 = sin(angle);

        let tR: f32 = oR * twR - oI * twI;
        let tI: f32 = oR * twI + oI * twR;

        let re: f32 = eR + tR;
        let im: f32 = eI + tI;

        // Write complex output
        let outIdx: u32 = outputBase + col * N * 2u + idx * 2u;
        output[outIdx] = re;
        output[outIdx + 1u] = im;
    }
}
`;
}

// Default shader for init — rebuilt when FFT size changes
let FFT_WGSL_SHADER = buildFFTShader(2048);

// ─── WGSL Cascade Shader (render pass: r8unorm → r8unorm) ───────────────────
// Fullscreen triangle vertex + fragment that downsamples two child textures
// into a parent tile. Reads column pairs via textureLoad, reduces, outputs f32
// which hardware packs to r8unorm automatically. Zero storage buffers.

const CASCADE_WGSL_SHADER = /* wgsl */ `

struct CascadeParams {
    splitCol:    u32,   // child0 contributes cols [0, splitCol), child1 contributes [splitCol, width)
    reduceMode:  u32,   // 0=average, 1=peak, 2=balanced
    hasChild1:   u32,   // 0=single child only, 1=two children
    _pad:        u32,
}

@group(0) @binding(0) var child0Tex: texture_2d<f32>;
@group(0) @binding(1) var child1Tex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: CascadeParams;

fn reducePair(v0: f32, v1: f32, mode: u32) -> f32 {
    if (mode == 1u) { return max(v0, v1); }                              // peak
    if (mode == 2u) { return (max(v0, v1) + (v0 + v1) * 0.5) * 0.5; }   // balanced
    return (v0 + v1) * 0.5;                                              // average
}

@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
    // Fullscreen triangle: 3 vertices cover [-1,-1] to [3,3] (clip space)
    let x = f32(i32(vi & 1u)) * 4.0 - 1.0;
    let y = f32(i32(vi >> 1u)) * 4.0 - 1.0;
    return vec4f(x, y, 0.0, 1.0);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
    let col = u32(pos.x);
    let bin = u32(pos.y);

    var v0: f32;
    var v1: f32;

    if (col < params.splitCol) {
        let srcCol0 = col * 2u;
        let srcCol1 = srcCol0 + 1u;
        v0 = textureLoad(child0Tex, vec2u(srcCol0, bin), 0).r;
        v1 = textureLoad(child0Tex, vec2u(srcCol1, bin), 0).r;
    } else {
        let localCol = col - params.splitCol;
        let srcCol0 = localCol * 2u;
        let srcCol1 = srcCol0 + 1u;
        v0 = textureLoad(child1Tex, vec2u(srcCol0, bin), 0).r;
        v1 = textureLoad(child1Tex, vec2u(srcCol1, bin), 0).r;
    }

    let result = reducePair(v0, v1, params.reduceMode);
    return vec4f(result, 0.0, 0.0, 1.0);
}
`;

// ─── SpectrogramGPUCompute Class ─────────────────────────────────────────────

export class SpectrogramGPUCompute {
    constructor() {
        this.device = null;
        this.pipeline = null;
        this.bindGroupLayout = null;
        this.hannBuffer = null;
        this.uniformBuffer = null;
        this.initialized = false;
        this.hannUploaded = false;
        this.lastFftSize = 0;
        this.maxStorageBufferSize = 0;
        // Multi-pass FFT state (for sizes exceeding single-pass shared memory)
        this.twoPassEnabled = false;       // 1 level: 4096 on 32KB GPU
        this.multiPassEnabled = false;     // 2+ levels: 8192+ on 32KB GPU
        this.numDecompLevels = 0;          // 0=single, 1=two-pass, 2=three-pass
        this.baseFFTSize = 0;              // sub-FFT size that fits in shared memory
        this.subFFTPipeline = null;
        this.subFFTBindGroupLayout = null;
        this.combinePipeline = null;
        this.combineBindGroupLayout = null;
        this.combineUniformBuffer = null;
        // Multi-pass intermediate combine state (for 3+ passes)
        this.intCombinePipeline = null;
        this.intCombineBindGroupLayout = null;
        this.intCombineUniformBuffer = null;
        // Cascade render pipeline (GPU pyramid building)
        this.cascadePipeline = null;
        this.cascadeBindGroupLayout = null;
        this.dummyTexture = null; // 1x1 r8unorm for single-child case
    }

    static isSupported() {
        return typeof navigator !== 'undefined' && !!navigator.gpu;
    }

    async initialize(externalDevice = null) {
        if (this.initialized) return;

        if (externalDevice) {
            // Check if shared device has sufficient workgroup storage (need 32KB for 2048-point FFT)
            const minNeeded = 32768; // 2 × 2048 × 2 × 4 bytes
            if (externalDevice.limits.maxComputeWorkgroupStorageSize >= minNeeded) {
                this.device = externalDevice;
                this.ownsDevice = false;
                this.maxWorkgroupStorage = externalDevice.limits.maxComputeWorkgroupStorageSize;
                const limits = this.device.limits;
                this.maxOutputBytes = Math.min(
                    limits.maxStorageBufferBindingSize,
                    limits.maxBufferSize,
                    256 * 1024 * 1024
                );
            } else {
                if (window.pm?.rendering) console.warn(`[GPU Compute] Shared device workgroup storage too small ` +
                    `(${externalDevice.limits.maxComputeWorkgroupStorageSize} < ${minNeeded}), creating own device`);
                externalDevice = null; // fall through to create own device
            }
        }
        let ownAdapter = null;
        if (!externalDevice) {
            const adapter = await navigator.gpu.requestAdapter({
                powerPreference: 'high-performance'
            });
            ownAdapter = adapter;
            if (!adapter) {
                throw new Error('No WebGPU adapter available');
            }

            // Request the adapter's max workgroup storage — we'll validate per-FFT-size later
            const adapterMaxWorkgroupStorage = adapter.limits.maxComputeWorkgroupStorageSize;
            this.maxWorkgroupStorage = adapterMaxWorkgroupStorage;

            // Request adapter's max buffer limits (defaults are 128MB binding / 256MB buffer)
            const maxStorage = adapter.limits.maxStorageBufferBindingSize;
            const maxBuffer = adapter.limits.maxBufferSize;

            this.device = await adapter.requestDevice({
                requiredLimits: {
                    maxComputeWorkgroupSizeX: 256,
                    maxComputeInvocationsPerWorkgroup: 256,
                    maxComputeWorkgroupStorageSize: adapterMaxWorkgroupStorage,
                    maxStorageBufferBindingSize: maxStorage,
                    maxBufferSize: maxBuffer,
                }
            });
            this.ownsDevice = true;

            // Batch sizing: use device limits but cap at 256MB for staging buffer practicality
            this.maxOutputBytes = Math.min(maxStorage, maxBuffer, 256 * 1024 * 1024);
        }

        this.device.lost.then((info) => {
            if (window.pm?.rendering) console.warn(`[GPU Compute] Device lost: ${info.message}`);
            this.initialized = false;
        });

        const shaderModule = this.device.createShaderModule({
            code: FFT_WGSL_SHADER,
            label: 'fft-spectrogram'
        });

        const compilationInfo = await shaderModule.getCompilationInfo();
        for (const message of compilationInfo.messages) {
            if (message.type === 'error') {
                throw new Error(`WGSL compile error: ${message.message} (line ${message.lineNum})`);
            }
            if (message.type === 'warning' && window.pm?.rendering) {
                console.warn(`[GPU Compute] WGSL warning: ${message.message}`);
            }
        }

        // Bind group layout — 5 bindings (added tileDescs)
        this.bindGroupLayout = this.device.createBindGroupLayout({
            label: 'fft-bind-group-layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            ]
        });

        this.pipeline = await this.device.createComputePipelineAsync({
            label: 'fft-pipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.bindGroupLayout]
            }),
            compute: {
                module: shaderModule,
                entryPoint: 'fft_main'
            }
        });

        // Persistent uniform buffer (8 u32/f32 values = 32 bytes)
        this.uniformBuffer = this.device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: 'fft-params'
        });

        // ── Cascade render pipeline (GPU pyramid building) ──
        await this._initCascadePipeline();

        this.initialized = true;

        if (!isStudyMode() && window.pm?.rendering) {
            if (externalDevice) {
                console.log(
                    `%c[GPU Compute] Initialized (shared device from renderer)`,
                    'color: #4CAF50; font-weight: bold'
                );
            } else if (ownAdapter && ownAdapter.requestAdapterInfo) {
                const adapterInfo = await ownAdapter.requestAdapterInfo();
                console.log(
                    `%c[GPU Compute] Initialized: ${adapterInfo.vendor} ${adapterInfo.architecture || adapterInfo.device || ''}`,
                    'color: #4CAF50; font-weight: bold'
                );
            }
        }
    }

    /**
     * Process spectrogram tiles using GPU compute shaders — MEGA-BATCH.
     * All tiles concatenated into one GPU buffer, one dispatch, one readback.
     * Same interface as SpectrogramWorkerPool.processTiles().
     */
    async processTiles(tiles, onTileComplete, signal = null) {
        if (!this.initialized) {
            await this.initialize();
        }

        if (tiles.length === 0) return;

        const t0 = performance.now();

        // All tiles must share the same FFT params (they do in pyramid)
        let { fftSize, exactHop, dbFloor, dbRange, hannWindow } = tiles[0];
        let freqBins = fftSize / 2;
        let logStages = Math.log2(fftSize);
        const numSlices = tiles[0].numTimeSlices;

        // Rebuild pipeline + Hann window when FFT size changes
        if (!this.hannUploaded || this.lastFftSize !== fftSize) {
            // Pipeline may clamp FFT size if GPU can't handle it — recompute derived values
            fftSize = await this._rebuildPipelineForFFTSize(fftSize);
            freqBins = fftSize / 2;
            logStages = Math.log2(fftSize);

            // Regenerate Hann window for the actual FFT size
            const actualHannWindow = new Float32Array(fftSize);
            for (let i = 0; i < fftSize; i++) {
                actualHannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));
            }

            if (this.hannBuffer) this.hannBuffer.destroy();
            this.hannBuffer = this.device.createBuffer({
                size: actualHannWindow.byteLength,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                label: 'hann-window'
            });
            this.device.queue.writeBuffer(this.hannBuffer, 0, actualHannWindow);
            this.hannUploaded = true;
            this.lastFftSize = fftSize;
        }

        // Write uniforms (shared across all tiles in batch)
        // For multi-pass/two-pass, uniforms[0] = sub-FFT size (not full FFT size)
        // because the sub-FFT shader reads params.subFFTSize to size its shared memory loops
        const uniforms = new Uint32Array(8);
        const uniformsF32 = new Float32Array(uniforms.buffer);
        uniforms[0] = (this.twoPassEnabled || this.multiPassEnabled) ? this.baseFFTSize : fftSize;
        uniformsF32[1] = exactHop;
        uniforms[2] = numSlices;
        uniforms[3] = freqBins;
        uniformsF32[4] = dbFloor;
        uniformsF32[5] = dbRange;
        uniformsF32[6] = 1.0 / fftSize;
        uniforms[7] = logStages;
        this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

        // Split tiles into batches that fit within GPU buffer limits
        let bytesPerTile = numSlices * freqBins; // 1 byte per value (packed in shader)
        if (this.multiPassEnabled) {
            // Multi-pass: bufferA (4 sub-FFTs) + bufferB (2 intermediate combines)
            const base = this.baseFFTSize;
            const numSubFFTs = Math.pow(2, this.numDecompLevels);
            const midN = base * 2;
            bytesPerTile += numSubFFTs * numSlices * base * 2 * 4;  // buffer A
            bytesPerTile += 2 * numSlices * midN * 2 * 4;           // buffer B
        } else if (this.twoPassEnabled) {
            const M = fftSize / 2;
            bytesPerTile += 2 * numSlices * M * 2 * 4;
        }
        const maxTilesPerBatch = Math.max(1, Math.floor(this.maxOutputBytes / bytesPerTile));

        for (let batchStart = 0; batchStart < tiles.length; batchStart += maxTilesPerBatch) {
            if (signal?.aborted) return;

            const batchEnd = Math.min(batchStart + maxTilesPerBatch, tiles.length);
            const batchTiles = tiles.slice(batchStart, batchEnd);
            const numTiles = batchTiles.length;

            await this._processBatch(batchTiles, numTiles, numSlices, freqBins, onTileComplete, signal);
        }

        const elapsed = (performance.now() - t0).toFixed(1);
        const numBatches = Math.ceil(tiles.length / maxTilesPerBatch);
        if (window.pm?.rendering) console.log(
            `%c[GPU Compute] ${tiles.length} tiles in ${elapsed}ms ` +
            `(${numBatches} batches of ≤${maxTilesPerBatch}, ` +
            `${(tiles.length * numSlices * freqBins / 1024 / 1024).toFixed(1)}M values)`,
            'color: #4CAF50; font-weight: bold'
        );
    }

    /**
     * Process a batch of tiles: concatenate audio → one dispatch → one readback → split.
     */
    async _processBatch(batchTiles, numTiles, numSlices, freqBins, onTileComplete, signal) {
        if (this.multiPassEnabled) {
            return this._processBatchMultiPass(batchTiles, numTiles, numSlices, freqBins, onTileComplete, signal);
        }
        if (this.twoPassEnabled) {
            return this._processBatchTwoPass(batchTiles, numTiles, numSlices, freqBins, onTileComplete, signal);
        }
        const tBatch = performance.now();

        // ── Concatenate all audio and build tile descriptors ──
        let totalAudioFloats = 0;
        const audioOffsets = [];
        const outputOffsets = [];

        for (let i = 0; i < numTiles; i++) {
            audioOffsets.push(totalAudioFloats);
            outputOffsets.push(i * numSlices * freqBins);
            totalAudioFloats += batchTiles[i].audioData.length;
        }

        const megaAudio = new Float32Array(totalAudioFloats);
        let offset = 0;
        for (let i = 0; i < numTiles; i++) {
            megaAudio.set(batchTiles[i].audioData, offset);
            offset += batchTiles[i].audioData.length;
        }

        const tileDescsData = new Uint32Array(numTiles * 2);
        for (let i = 0; i < numTiles; i++) {
            tileDescsData[i * 2] = audioOffsets[i];
            tileDescsData[i * 2 + 1] = outputOffsets[i];
        }

        const tConcat = performance.now();

        // ── Create GPU buffers ──
        const audioBuffer = this.device.createBuffer({
            size: megaAudio.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: 'mega-audio'
        });
        this.device.queue.writeBuffer(audioBuffer, 0, megaAudio);

        const tileDescsBuffer = this.device.createBuffer({
            size: tileDescsData.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: 'tile-descs'
        });
        this.device.queue.writeBuffer(tileDescsBuffer, 0, tileDescsData);

        const totalOutputValues = numTiles * numSlices * freqBins;
        const outputByteSize = Math.ceil(totalOutputValues / 4) * 4; // packed bytes, u32-aligned

        const outputBuffer = this.device.createBuffer({
            size: outputByteSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            label: 'mega-output'
        });

        const stagingBuffer = this.device.createBuffer({
            size: outputByteSize,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            label: 'mega-staging'
        });

        const bindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: audioBuffer } },
                { binding: 1, resource: { buffer: this.hannBuffer } },
                { binding: 2, resource: { buffer: outputBuffer } },
                { binding: 3, resource: { buffer: this.uniformBuffer } },
                { binding: 4, resource: { buffer: tileDescsBuffer } },
            ]
        });

        const tUpload = performance.now();

        // ── Dispatch: 2D — (slices per tile, num tiles) ──
        const encoder = this.device.createCommandEncoder({ label: 'mega-batch' });
        const pass = encoder.beginComputePass({ label: 'fft-mega' });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(numSlices, numTiles);
        pass.end();

        encoder.copyBufferToBuffer(outputBuffer, 0, stagingBuffer, 0, outputByteSize);
        this.device.queue.submit([encoder.finish()]);

        // ── Single readback — includes GPU compute wait ──
        await stagingBuffer.mapAsync(GPUMapMode.READ);
        const tGpuDone = performance.now();

        // ── Extract results: contiguous byte copy (bytes packed in shader) ──
        const mappedRange = stagingBuffer.getMappedRange();
        const rawBytes = new Uint8Array(mappedRange);
        const valuesPerTile = numSlices * freqBins;

        const tSplitStart = performance.now();

        for (let i = 0; i < numTiles; i++) {
            if (signal?.aborted) break;

            const tileOutput = new Uint8Array(valuesPerTile);
            const byteBase = outputOffsets[i]; // already a byte offset

            tileOutput.set(rawBytes.subarray(byteBase, byteBase + valuesPerTile));

            onTileComplete(batchTiles[i].tileIndex, tileOutput, numSlices, freqBins);
        }

        const tSplitDone = performance.now();

        stagingBuffer.unmap();

        // ── Cleanup batch buffers ──
        audioBuffer.destroy();
        tileDescsBuffer.destroy();
        outputBuffer.destroy();
        stagingBuffer.destroy();

        // ALWAYS log timing (even in study mode — we need this data)
        const concatMs = (tConcat - tBatch).toFixed(1);
        const uploadMs = (tUpload - tConcat).toFixed(1);
        const gpuMs = (tGpuDone - tUpload).toFixed(1);
        const splitMs = (tSplitDone - tSplitStart).toFixed(1);
        const audioMB = (megaAudio.byteLength / 1024 / 1024).toFixed(1);
        const outputMB = (outputByteSize / 1024 / 1024).toFixed(1);
        if (window.pm?.rendering) console.log(
            `%c  [GPU batch] ${numTiles} tiles: ` +
            `${concatMs}ms concat (${audioMB}MB) + ` +
            `${uploadMs}ms upload + ` +
            `${gpuMs}ms GPU (${numTiles}×${numSlices} FFTs) + ` +
            `${splitMs}ms copy-out (${outputMB}MB packed)`,
            'color: #9C27B0'
        );
    }

    /**
     * Two-pass batch processing (CPU readback path).
     * Pass 1: sub-FFTs → intermediate buffer. Pass 2: combine → output buffer.
     */
    async _processBatchTwoPass(batchTiles, numTiles, numSlices, freqBins, onTileComplete, signal) {
        const tBatch = performance.now();
        const M = this.lastFftSize / 2;  // sub-FFT size

        // ── Concatenate audio ──
        let totalAudioFloats = 0;
        const audioOffsets = [];
        for (let i = 0; i < numTiles; i++) {
            audioOffsets.push(totalAudioFloats);
            totalAudioFloats += batchTiles[i].audioData.length;
        }
        const megaAudio = new Float32Array(totalAudioFloats);
        let offset = 0;
        for (let i = 0; i < numTiles; i++) {
            megaAudio.set(batchTiles[i].audioData, offset);
            offset += batchTiles[i].audioData.length;
        }

        // ── Intermediate buffer layout ──
        // Per tile: 2 halves × numSlices × M × 2 floats
        const intermediateFloatsPerTile = 2 * numSlices * M * 2;
        const totalIntermediateFloats = numTiles * intermediateFloatsPerTile;

        // ── Pass 1 tile descriptors: [audioBase, intermediateBase] per tile ──
        const pass1Descs = new Uint32Array(numTiles * 2);
        for (let i = 0; i < numTiles; i++) {
            pass1Descs[i * 2] = audioOffsets[i];
            pass1Descs[i * 2 + 1] = i * intermediateFloatsPerTile;
        }

        // ── Pass 2 tile descriptors: [evenBase, oddBase, outputBase, 0] per tile ──
        const pass2Descs = new Uint32Array(numTiles * 4);
        for (let i = 0; i < numTiles; i++) {
            const tileIntBase = i * intermediateFloatsPerTile;
            pass2Descs[i * 4] = tileIntBase;                                // evenBase
            pass2Descs[i * 4 + 1] = tileIntBase + numSlices * M * 2;       // oddBase
            pass2Descs[i * 4 + 2] = i * numSlices * freqBins;              // outputBase
            pass2Descs[i * 4 + 3] = 0;
        }

        // ── Create GPU buffers ──
        const audioBuffer = this.device.createBuffer({
            size: megaAudio.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'tp-audio'
        });
        this.device.queue.writeBuffer(audioBuffer, 0, megaAudio);

        const intermediateBuffer = this.device.createBuffer({
            size: totalIntermediateFloats * 4, usage: GPUBufferUsage.STORAGE, label: 'tp-intermediate'
        });

        const pass1DescsBuffer = this.device.createBuffer({
            size: pass1Descs.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'tp-descs-p1'
        });
        this.device.queue.writeBuffer(pass1DescsBuffer, 0, pass1Descs);

        const pass2DescsBuffer = this.device.createBuffer({
            size: pass2Descs.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'tp-descs-p2'
        });
        this.device.queue.writeBuffer(pass2DescsBuffer, 0, pass2Descs);

        const totalOutputValues = numTiles * numSlices * freqBins;
        const outputByteSize = Math.ceil(totalOutputValues / 4) * 4;
        const outputBuffer = this.device.createBuffer({
            size: outputByteSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, label: 'tp-output'
        });
        const stagingBuffer = this.device.createBuffer({
            size: outputByteSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'tp-staging'
        });

        // ── Write combine uniforms ──
        const combineUniforms = new Uint32Array(8);
        const combineF32 = new Float32Array(combineUniforms.buffer);
        combineUniforms[0] = this.lastFftSize;      // fullN
        combineUniforms[1] = M;                      // halfN
        combineUniforms[2] = numSlices;
        combineUniforms[3] = freqBins;
        combineF32[4] = batchTiles[0].dbFloor;
        combineF32[5] = batchTiles[0].dbRange;
        combineF32[6] = 1.0 / this.lastFftSize;
        combineUniforms[7] = 0;
        this.device.queue.writeBuffer(this.combineUniformBuffer, 0, combineUniforms);

        // ── Bind groups ──
        const pass1BindGroup = this.device.createBindGroup({
            layout: this.subFFTBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: audioBuffer } },
                { binding: 1, resource: { buffer: this.hannBuffer } },
                { binding: 2, resource: { buffer: intermediateBuffer } },
                { binding: 3, resource: { buffer: this.uniformBuffer } },
                { binding: 4, resource: { buffer: pass1DescsBuffer } },
            ]
        });

        const pass2BindGroup = this.device.createBindGroup({
            layout: this.combineBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: intermediateBuffer } },
                { binding: 1, resource: { buffer: outputBuffer } },
                { binding: 2, resource: { buffer: this.combineUniformBuffer } },
                { binding: 3, resource: { buffer: pass2DescsBuffer } },
            ]
        });

        // ── Encode both passes in one command encoder ──
        const encoder = this.device.createCommandEncoder({ label: 'tp-mega-batch' });

        const p1 = encoder.beginComputePass({ label: 'subfft-pass' });
        p1.setPipeline(this.subFFTPipeline);
        p1.setBindGroup(0, pass1BindGroup);
        p1.dispatchWorkgroups(numSlices, numTiles * 2);  // ×2 for even/odd halves
        p1.end();

        const p2 = encoder.beginComputePass({ label: 'combine-pass' });
        p2.setPipeline(this.combinePipeline);
        p2.setBindGroup(0, pass2BindGroup);
        p2.dispatchWorkgroups(numSlices, numTiles);
        p2.end();

        encoder.copyBufferToBuffer(outputBuffer, 0, stagingBuffer, 0, outputByteSize);
        this.device.queue.submit([encoder.finish()]);

        // ── Readback ──
        await stagingBuffer.mapAsync(GPUMapMode.READ);
        const mappedRange = stagingBuffer.getMappedRange();
        const rawBytes = new Uint8Array(mappedRange);
        const valuesPerTile = numSlices * freqBins;

        for (let i = 0; i < numTiles; i++) {
            if (signal?.aborted) break;
            const tileOutput = new Uint8Array(valuesPerTile);
            const byteBase = i * numSlices * freqBins;
            tileOutput.set(rawBytes.subarray(byteBase, byteBase + valuesPerTile));
            onTileComplete(batchTiles[i].tileIndex, tileOutput, numSlices, freqBins);
        }

        stagingBuffer.unmap();
        audioBuffer.destroy();
        intermediateBuffer.destroy();
        pass1DescsBuffer.destroy();
        pass2DescsBuffer.destroy();
        outputBuffer.destroy();
        stagingBuffer.destroy();

        if (window.pm?.rendering) console.log(
            `%c  [GPU two-pass batch] ${numTiles} tiles in ${(performance.now() - tBatch).toFixed(1)}ms`,
            'color: #FF9800'
        );
    }

    /**
     * Two-pass batch processing (zero-copy GPU texture path).
     * Pass 1: sub-FFTs → intermediate buffer. Pass 2: combine → output → textures.
     */
    _processBatchZeroCopyTwoPass(batchTiles, numTiles, numSlices, freqBins, onTileGPUTexture, signal) {
        const tBatch = performance.now();
        const M = this.lastFftSize / 2;

        // ── Concatenate audio ──
        let totalAudioFloats = 0;
        const audioOffsets = [];
        for (let i = 0; i < numTiles; i++) {
            audioOffsets.push(totalAudioFloats);
            totalAudioFloats += batchTiles[i].audioData.length;
        }
        const megaAudio = new Float32Array(totalAudioFloats);
        let offset = 0;
        for (let i = 0; i < numTiles; i++) {
            megaAudio.set(batchTiles[i].audioData, offset);
            offset += batchTiles[i].audioData.length;
        }

        // ── Intermediate buffer layout ──
        const intermediateFloatsPerTile = 2 * numSlices * M * 2;
        const totalIntermediateFloats = numTiles * intermediateFloatsPerTile;

        // ── Pass 1 tile descriptors ──
        const pass1Descs = new Uint32Array(numTiles * 2);
        for (let i = 0; i < numTiles; i++) {
            pass1Descs[i * 2] = audioOffsets[i];
            pass1Descs[i * 2 + 1] = i * intermediateFloatsPerTile;
        }

        // ── Pass 2 tile descriptors ──
        const pass2Descs = new Uint32Array(numTiles * 4);
        const outputOffsets = [];
        for (let i = 0; i < numTiles; i++) {
            const tileIntBase = i * intermediateFloatsPerTile;
            outputOffsets.push(i * numSlices * freqBins);
            pass2Descs[i * 4] = tileIntBase;
            pass2Descs[i * 4 + 1] = tileIntBase + numSlices * M * 2;
            pass2Descs[i * 4 + 2] = outputOffsets[i];
            pass2Descs[i * 4 + 3] = 0;
        }

        // ── GPU buffers ──
        const audioBuffer = this.device.createBuffer({
            size: megaAudio.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'zc-tp-audio'
        });
        this.device.queue.writeBuffer(audioBuffer, 0, megaAudio);

        const intermediateBuffer = this.device.createBuffer({
            size: totalIntermediateFloats * 4, usage: GPUBufferUsage.STORAGE, label: 'zc-tp-intermediate'
        });

        const pass1DescsBuffer = this.device.createBuffer({
            size: pass1Descs.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'zc-tp-descs-p1'
        });
        this.device.queue.writeBuffer(pass1DescsBuffer, 0, pass1Descs);

        const pass2DescsBuffer = this.device.createBuffer({
            size: pass2Descs.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'zc-tp-descs-p2'
        });
        this.device.queue.writeBuffer(pass2DescsBuffer, 0, pass2Descs);

        const totalOutputBytes = numTiles * numSlices * freqBins;
        const outputByteSize = Math.ceil(totalOutputBytes / 4) * 4;
        const outputBuffer = this.device.createBuffer({
            size: outputByteSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, label: 'zc-tp-output'
        });

        // ── Write combine uniforms ──
        const combineUniforms = new Uint32Array(8);
        const combineF32 = new Float32Array(combineUniforms.buffer);
        combineUniforms[0] = this.lastFftSize;
        combineUniforms[1] = M;
        combineUniforms[2] = numSlices;
        combineUniforms[3] = freqBins;
        combineF32[4] = batchTiles[0].dbFloor;
        combineF32[5] = batchTiles[0].dbRange;
        combineF32[6] = 1.0 / this.lastFftSize;
        combineUniforms[7] = 0;
        this.device.queue.writeBuffer(this.combineUniformBuffer, 0, combineUniforms);

        // ── Bind groups ──
        const pass1BindGroup = this.device.createBindGroup({
            layout: this.subFFTBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: audioBuffer } },
                { binding: 1, resource: { buffer: this.hannBuffer } },
                { binding: 2, resource: { buffer: intermediateBuffer } },
                { binding: 3, resource: { buffer: this.uniformBuffer } },
                { binding: 4, resource: { buffer: pass1DescsBuffer } },
            ]
        });

        const pass2BindGroup = this.device.createBindGroup({
            layout: this.combineBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: intermediateBuffer } },
                { binding: 1, resource: { buffer: outputBuffer } },
                { binding: 2, resource: { buffer: this.combineUniformBuffer } },
                { binding: 3, resource: { buffer: pass2DescsBuffer } },
            ]
        });

        // ── Encode both passes + texture copies ──
        const encoder = this.device.createCommandEncoder({ label: 'zc-tp-mega-batch' });

        const p1 = encoder.beginComputePass({ label: 'subfft-pass' });
        p1.setPipeline(this.subFFTPipeline);
        p1.setBindGroup(0, pass1BindGroup);
        p1.dispatchWorkgroups(numSlices, numTiles * 2);
        p1.end();

        const p2 = encoder.beginComputePass({ label: 'combine-pass' });
        p2.setPipeline(this.combinePipeline);
        p2.setBindGroup(0, pass2BindGroup);
        p2.dispatchWorkgroups(numSlices, numTiles);
        p2.end();

        // ── Copy output → GPU textures (zero-readback) ──
        const gpuTextures = [];
        for (let i = 0; i < numTiles; i++) {
            const gpuTexture = this.device.createTexture({
                size: [numSlices, freqBins],
                format: 'r8unorm',
                usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
                label: `zc-tp-tile-${batchTiles[i].tileIndex}`
            });
            encoder.copyBufferToTexture(
                { buffer: outputBuffer, offset: outputOffsets[i], bytesPerRow: numSlices },
                { texture: gpuTexture },
                [numSlices, freqBins]
            );
            gpuTextures.push(gpuTexture);
        }

        this.device.queue.submit([encoder.finish()]);
        const tSubmit = performance.now();

        // ── Fire GPU texture callbacks immediately ──
        for (let i = 0; i < numTiles; i++) {
            if (signal?.aborted) break;
            onTileGPUTexture(batchTiles[i].tileIndex, gpuTextures[i], numSlices, freqBins);
        }

        // ── Cleanup after GPU finishes (single promise — destroy intermediates first) ──
        const gpuDonePromise = this.device.queue.onSubmittedWorkDone().then(() => {
            audioBuffer.destroy();
            intermediateBuffer.destroy();
            pass1DescsBuffer.destroy();
            pass2DescsBuffer.destroy();
            outputBuffer.destroy();
            return performance.now() - tSubmit;
        });

        return { gpuDonePromise, encodeMs: tSubmit - tBatch, numTiles };
    }

    /**
     * Multi-pass batch processing (CPU readback path).
     * For 8192+: Pass 1 = sub-FFTs, Pass 2 = intermediate combine, Pass 3 = final combine.
     * DIT decomposition: stride-4 into 4 sub-FFTs, combine (0,2)→E, (1,3)→O, then E+O→X.
     */
    async _processBatchMultiPass(batchTiles, numTiles, numSlices, freqBins, onTileComplete, signal) {
        const tBatch = performance.now();
        const fftSize = this.lastFftSize;
        const base = this.baseFFTSize;
        const numSubFFTs = Math.pow(2, this.numDecompLevels);  // 4 for 8192
        const midCombineN = base * 2;  // 4096 for 8192

        // ── Concatenate audio ──
        let totalAudioFloats = 0;
        const audioOffsets = [];
        for (let i = 0; i < numTiles; i++) {
            audioOffsets.push(totalAudioFloats);
            totalAudioFloats += batchTiles[i].audioData.length;
        }
        const megaAudio = new Float32Array(totalAudioFloats);
        let offset = 0;
        for (let i = 0; i < numTiles; i++) {
            megaAudio.set(batchTiles[i].audioData, offset);
            offset += batchTiles[i].audioData.length;
        }

        // ── Buffer A: sub-FFT output (4 blocks of base complex per tile) ──
        const bufAFloatsPerTile = numSubFFTs * numSlices * base * 2;
        const totalBufAFloats = numTiles * bufAFloatsPerTile;

        // ── Buffer B: intermediate combine output (2 blocks of midCombineN complex per tile) ──
        const bufBFloatsPerTile = 2 * numSlices * midCombineN * 2;
        const totalBufBFloats = numTiles * bufBFloatsPerTile;

        // ── Pass 1 tile descriptors: [audioBase, intermediateBase] per tile ──
        const pass1Descs = new Uint32Array(numTiles * 2);
        for (let i = 0; i < numTiles; i++) {
            pass1Descs[i * 2] = audioOffsets[i];
            pass1Descs[i * 2 + 1] = i * bufAFloatsPerTile;
        }

        // ── Pass 2 tile descriptors: combine pairs (0,2)→E and (1,3)→O ──
        // Each pair: [evenBase, oddBase, outputBase, _pad] — 2 pairs per tile
        const numPairs = numTiles * 2;
        const pass2Descs = new Uint32Array(numPairs * 4);
        for (let i = 0; i < numTiles; i++) {
            const bufABase = i * bufAFloatsPerTile;
            const bufBBase = i * bufBFloatsPerTile;
            const subBlockSize = numSlices * base * 2;
            // Pair 0: sub[0] + sub[2] → E (even half of original)
            pass2Descs[(i * 2) * 4]     = bufABase + 0 * subBlockSize;     // sub[0] = even-even
            pass2Descs[(i * 2) * 4 + 1] = bufABase + 2 * subBlockSize;     // sub[2] = even-odd
            pass2Descs[(i * 2) * 4 + 2] = bufBBase + 0;                    // E output
            pass2Descs[(i * 2) * 4 + 3] = 0;
            // Pair 1: sub[1] + sub[3] → O (odd half of original)
            pass2Descs[(i * 2 + 1) * 4]     = bufABase + 1 * subBlockSize; // sub[1] = odd-even
            pass2Descs[(i * 2 + 1) * 4 + 1] = bufABase + 3 * subBlockSize; // sub[3] = odd-odd
            pass2Descs[(i * 2 + 1) * 4 + 2] = bufBBase + numSlices * midCombineN * 2; // O output
            pass2Descs[(i * 2 + 1) * 4 + 3] = 0;
        }

        // ── Pass 3 tile descriptors: E + O → final output ──
        const pass3Descs = new Uint32Array(numTiles * 4);
        for (let i = 0; i < numTiles; i++) {
            const bufBBase = i * bufBFloatsPerTile;
            pass3Descs[i * 4]     = bufBBase;                              // E base
            pass3Descs[i * 4 + 1] = bufBBase + numSlices * midCombineN * 2; // O base
            pass3Descs[i * 4 + 2] = i * numSlices * freqBins;             // output base
            pass3Descs[i * 4 + 3] = 0;
        }

        // ── Create GPU buffers ──
        const audioBuffer = this.device.createBuffer({
            size: megaAudio.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'mp-audio'
        });
        this.device.queue.writeBuffer(audioBuffer, 0, megaAudio);

        const bufferA = this.device.createBuffer({
            size: totalBufAFloats * 4, usage: GPUBufferUsage.STORAGE, label: 'mp-bufA'
        });
        const bufferB = this.device.createBuffer({
            size: totalBufBFloats * 4, usage: GPUBufferUsage.STORAGE, label: 'mp-bufB'
        });

        const p1DescsBuffer = this.device.createBuffer({
            size: pass1Descs.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'mp-descs-p1'
        });
        this.device.queue.writeBuffer(p1DescsBuffer, 0, pass1Descs);

        const p2DescsBuffer = this.device.createBuffer({
            size: pass2Descs.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'mp-descs-p2'
        });
        this.device.queue.writeBuffer(p2DescsBuffer, 0, pass2Descs);

        const p3DescsBuffer = this.device.createBuffer({
            size: pass3Descs.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'mp-descs-p3'
        });
        this.device.queue.writeBuffer(p3DescsBuffer, 0, pass3Descs);

        const totalOutputValues = numTiles * numSlices * freqBins;
        const outputByteSize = Math.ceil(totalOutputValues / 4) * 4;
        const outputBuffer = this.device.createBuffer({
            size: outputByteSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, label: 'mp-output'
        });
        const stagingBuffer = this.device.createBuffer({
            size: outputByteSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'mp-staging'
        });

        // ── Write uniforms ──
        // Intermediate combine: combineN, halfN, numSlices, _pad
        const intUniforms = new Uint32Array(4);
        intUniforms[0] = midCombineN;   // 4096
        intUniforms[1] = base;          // 2048
        intUniforms[2] = numSlices;
        intUniforms[3] = 0;
        this.device.queue.writeBuffer(this.intCombineUniformBuffer, 0, intUniforms);

        // Final combine: fullN, halfN, numSlices, freqBins, dbFloor, dbRange, invN, _pad
        const combineUniforms = new Uint32Array(8);
        const combineF32 = new Float32Array(combineUniforms.buffer);
        combineUniforms[0] = fftSize;            // fullN = 8192
        combineUniforms[1] = fftSize / 2;        // halfN = 4096
        combineUniforms[2] = numSlices;
        combineUniforms[3] = freqBins;           // 4096
        combineF32[4] = batchTiles[0].dbFloor;
        combineF32[5] = batchTiles[0].dbRange;
        combineF32[6] = 1.0 / fftSize;
        combineUniforms[7] = 0;
        this.device.queue.writeBuffer(this.combineUniformBuffer, 0, combineUniforms);

        // ── Bind groups ──
        const pass1BindGroup = this.device.createBindGroup({
            layout: this.subFFTBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: audioBuffer } },
                { binding: 1, resource: { buffer: this.hannBuffer } },
                { binding: 2, resource: { buffer: bufferA } },
                { binding: 3, resource: { buffer: this.uniformBuffer } },
                { binding: 4, resource: { buffer: p1DescsBuffer } },
            ]
        });

        const pass2BindGroup = this.device.createBindGroup({
            layout: this.intCombineBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: bufferA } },
                { binding: 1, resource: { buffer: bufferB } },
                { binding: 2, resource: { buffer: this.intCombineUniformBuffer } },
                { binding: 3, resource: { buffer: p2DescsBuffer } },
            ]
        });

        const pass3BindGroup = this.device.createBindGroup({
            layout: this.combineBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: bufferB } },
                { binding: 1, resource: { buffer: outputBuffer } },
                { binding: 2, resource: { buffer: this.combineUniformBuffer } },
                { binding: 3, resource: { buffer: p3DescsBuffer } },
            ]
        });

        // ── Encode all three passes in one command encoder ──
        const encoder = this.device.createCommandEncoder({ label: 'mp-mega-batch' });

        const p1 = encoder.beginComputePass({ label: 'subfft-pass' });
        p1.setPipeline(this.subFFTPipeline);
        p1.setBindGroup(0, pass1BindGroup);
        p1.dispatchWorkgroups(numSlices, numTiles * numSubFFTs);  // ×4 for four sub-FFTs
        p1.end();

        const p2 = encoder.beginComputePass({ label: 'int-combine-pass' });
        p2.setPipeline(this.intCombinePipeline);
        p2.setBindGroup(0, pass2BindGroup);
        p2.dispatchWorkgroups(numSlices, numPairs);  // ×2 pairs per tile
        p2.end();

        const p3 = encoder.beginComputePass({ label: 'final-combine-pass' });
        p3.setPipeline(this.combinePipeline);
        p3.setBindGroup(0, pass3BindGroup);
        p3.dispatchWorkgroups(numSlices, numTiles);
        p3.end();

        encoder.copyBufferToBuffer(outputBuffer, 0, stagingBuffer, 0, outputByteSize);
        this.device.queue.submit([encoder.finish()]);

        // ── Readback ──
        await stagingBuffer.mapAsync(GPUMapMode.READ);
        const mappedRange = stagingBuffer.getMappedRange();
        const rawBytes = new Uint8Array(mappedRange);
        const valuesPerTile = numSlices * freqBins;

        for (let i = 0; i < numTiles; i++) {
            if (signal?.aborted) break;
            const tileOutput = new Uint8Array(valuesPerTile);
            const byteBase = i * numSlices * freqBins;
            tileOutput.set(rawBytes.subarray(byteBase, byteBase + valuesPerTile));
            onTileComplete(batchTiles[i].tileIndex, tileOutput, numSlices, freqBins);
        }

        stagingBuffer.unmap();
        audioBuffer.destroy();
        bufferA.destroy();
        bufferB.destroy();
        p1DescsBuffer.destroy();
        p2DescsBuffer.destroy();
        p3DescsBuffer.destroy();
        outputBuffer.destroy();
        stagingBuffer.destroy();

        if (window.pm?.rendering) console.log(
            `%c  [GPU multi-pass batch] ${numTiles} tiles in ${(performance.now() - tBatch).toFixed(1)}ms`,
            'color: #FF9800'
        );
    }

    /**
     * Multi-pass batch processing (zero-copy GPU texture path).
     * Pass 1: sub-FFTs → buffer A. Pass 2: intermediate combine → buffer B.
     * Pass 3: final combine → output → GPU textures.
     */
    _processBatchZeroCopyMultiPass(batchTiles, numTiles, numSlices, freqBins, onTileGPUTexture, signal) {
        const tBatch = performance.now();
        const fftSize = this.lastFftSize;
        const base = this.baseFFTSize;
        const numSubFFTs = Math.pow(2, this.numDecompLevels);
        const midCombineN = base * 2;

        // ── Concatenate audio ──
        let totalAudioFloats = 0;
        const audioOffsets = [];
        for (let i = 0; i < numTiles; i++) {
            audioOffsets.push(totalAudioFloats);
            totalAudioFloats += batchTiles[i].audioData.length;
        }
        const megaAudio = new Float32Array(totalAudioFloats);
        let offset = 0;
        for (let i = 0; i < numTiles; i++) {
            megaAudio.set(batchTiles[i].audioData, offset);
            offset += batchTiles[i].audioData.length;
        }

        // ── Buffer sizes ──
        const bufAFloatsPerTile = numSubFFTs * numSlices * base * 2;
        const totalBufAFloats = numTiles * bufAFloatsPerTile;
        const bufBFloatsPerTile = 2 * numSlices * midCombineN * 2;
        const totalBufBFloats = numTiles * bufBFloatsPerTile;

        // ── Pass 1 tile descriptors ──
        const pass1Descs = new Uint32Array(numTiles * 2);
        for (let i = 0; i < numTiles; i++) {
            pass1Descs[i * 2] = audioOffsets[i];
            pass1Descs[i * 2 + 1] = i * bufAFloatsPerTile;
        }

        // ── Pass 2 tile descriptors: (0,2)→E and (1,3)→O ──
        const numPairs = numTiles * 2;
        const pass2Descs = new Uint32Array(numPairs * 4);
        const outputOffsets = [];
        for (let i = 0; i < numTiles; i++) {
            const bufABase = i * bufAFloatsPerTile;
            const bufBBase = i * bufBFloatsPerTile;
            const subBlockSize = numSlices * base * 2;
            outputOffsets.push(i * numSlices * freqBins);
            pass2Descs[(i * 2) * 4]     = bufABase + 0 * subBlockSize;
            pass2Descs[(i * 2) * 4 + 1] = bufABase + 2 * subBlockSize;
            pass2Descs[(i * 2) * 4 + 2] = bufBBase + 0;
            pass2Descs[(i * 2) * 4 + 3] = 0;
            pass2Descs[(i * 2 + 1) * 4]     = bufABase + 1 * subBlockSize;
            pass2Descs[(i * 2 + 1) * 4 + 1] = bufABase + 3 * subBlockSize;
            pass2Descs[(i * 2 + 1) * 4 + 2] = bufBBase + numSlices * midCombineN * 2;
            pass2Descs[(i * 2 + 1) * 4 + 3] = 0;
        }

        // ── Pass 3 tile descriptors ──
        const pass3Descs = new Uint32Array(numTiles * 4);
        for (let i = 0; i < numTiles; i++) {
            const bufBBase = i * bufBFloatsPerTile;
            pass3Descs[i * 4]     = bufBBase;
            pass3Descs[i * 4 + 1] = bufBBase + numSlices * midCombineN * 2;
            pass3Descs[i * 4 + 2] = outputOffsets[i];
            pass3Descs[i * 4 + 3] = 0;
        }

        // ── GPU buffers ──
        const audioBuffer = this.device.createBuffer({
            size: megaAudio.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'zc-mp-audio'
        });
        this.device.queue.writeBuffer(audioBuffer, 0, megaAudio);

        const bufferA = this.device.createBuffer({
            size: totalBufAFloats * 4, usage: GPUBufferUsage.STORAGE, label: 'zc-mp-bufA'
        });
        const bufferB = this.device.createBuffer({
            size: totalBufBFloats * 4, usage: GPUBufferUsage.STORAGE, label: 'zc-mp-bufB'
        });

        const p1DescsBuffer = this.device.createBuffer({
            size: pass1Descs.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'zc-mp-descs-p1'
        });
        this.device.queue.writeBuffer(p1DescsBuffer, 0, pass1Descs);

        const p2DescsBuffer = this.device.createBuffer({
            size: pass2Descs.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'zc-mp-descs-p2'
        });
        this.device.queue.writeBuffer(p2DescsBuffer, 0, pass2Descs);

        const p3DescsBuffer = this.device.createBuffer({
            size: pass3Descs.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'zc-mp-descs-p3'
        });
        this.device.queue.writeBuffer(p3DescsBuffer, 0, pass3Descs);

        const totalOutputBytes = numTiles * numSlices * freqBins;
        const outputByteSize = Math.ceil(totalOutputBytes / 4) * 4;
        const outputBuffer = this.device.createBuffer({
            size: outputByteSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, label: 'zc-mp-output'
        });

        // ── Write uniforms ──
        const intUniforms = new Uint32Array(4);
        intUniforms[0] = midCombineN;
        intUniforms[1] = base;
        intUniforms[2] = numSlices;
        intUniforms[3] = 0;
        this.device.queue.writeBuffer(this.intCombineUniformBuffer, 0, intUniforms);

        const combineUniforms = new Uint32Array(8);
        const combineF32 = new Float32Array(combineUniforms.buffer);
        combineUniforms[0] = fftSize;
        combineUniforms[1] = fftSize / 2;
        combineUniforms[2] = numSlices;
        combineUniforms[3] = freqBins;
        combineF32[4] = batchTiles[0].dbFloor;
        combineF32[5] = batchTiles[0].dbRange;
        combineF32[6] = 1.0 / fftSize;
        combineUniforms[7] = 0;
        this.device.queue.writeBuffer(this.combineUniformBuffer, 0, combineUniforms);

        // ── Bind groups ──
        const pass1BindGroup = this.device.createBindGroup({
            layout: this.subFFTBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: audioBuffer } },
                { binding: 1, resource: { buffer: this.hannBuffer } },
                { binding: 2, resource: { buffer: bufferA } },
                { binding: 3, resource: { buffer: this.uniformBuffer } },
                { binding: 4, resource: { buffer: p1DescsBuffer } },
            ]
        });

        const pass2BindGroup = this.device.createBindGroup({
            layout: this.intCombineBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: bufferA } },
                { binding: 1, resource: { buffer: bufferB } },
                { binding: 2, resource: { buffer: this.intCombineUniformBuffer } },
                { binding: 3, resource: { buffer: p2DescsBuffer } },
            ]
        });

        const pass3BindGroup = this.device.createBindGroup({
            layout: this.combineBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: bufferB } },
                { binding: 1, resource: { buffer: outputBuffer } },
                { binding: 2, resource: { buffer: this.combineUniformBuffer } },
                { binding: 3, resource: { buffer: p3DescsBuffer } },
            ]
        });

        // ── Encode all three passes + texture copies ──
        const encoder = this.device.createCommandEncoder({ label: 'zc-mp-mega-batch' });

        const p1 = encoder.beginComputePass({ label: 'subfft-pass' });
        p1.setPipeline(this.subFFTPipeline);
        p1.setBindGroup(0, pass1BindGroup);
        p1.dispatchWorkgroups(numSlices, numTiles * numSubFFTs);
        p1.end();

        const p2 = encoder.beginComputePass({ label: 'int-combine-pass' });
        p2.setPipeline(this.intCombinePipeline);
        p2.setBindGroup(0, pass2BindGroup);
        p2.dispatchWorkgroups(numSlices, numPairs);
        p2.end();

        const p3 = encoder.beginComputePass({ label: 'final-combine-pass' });
        p3.setPipeline(this.combinePipeline);
        p3.setBindGroup(0, pass3BindGroup);
        p3.dispatchWorkgroups(numSlices, numTiles);
        p3.end();

        // ── Copy output → GPU textures ──
        const gpuTextures = [];
        for (let i = 0; i < numTiles; i++) {
            const gpuTexture = this.device.createTexture({
                size: [numSlices, freqBins],
                format: 'r8unorm',
                usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
                label: `zc-mp-tile-${batchTiles[i].tileIndex}`
            });
            encoder.copyBufferToTexture(
                { buffer: outputBuffer, offset: outputOffsets[i], bytesPerRow: numSlices },
                { texture: gpuTexture },
                [numSlices, freqBins]
            );
            gpuTextures.push(gpuTexture);
        }

        this.device.queue.submit([encoder.finish()]);
        const tSubmit = performance.now();

        // ── Fire GPU texture callbacks ──
        for (let i = 0; i < numTiles; i++) {
            if (signal?.aborted) break;
            onTileGPUTexture(batchTiles[i].tileIndex, gpuTextures[i], numSlices, freqBins);
        }

        // ── Cleanup after GPU finishes (single promise — destroy intermediates first) ──
        const gpuDonePromise = this.device.queue.onSubmittedWorkDone().then(() => {
            audioBuffer.destroy();
            bufferA.destroy();
            bufferB.destroy();
            p1DescsBuffer.destroy();
            p2DescsBuffer.destroy();
            p3DescsBuffer.destroy();
            outputBuffer.destroy();
            return performance.now() - tSubmit;
        });

        return { gpuDonePromise, encodeMs: tSubmit - tBatch, numTiles };
    }

    /**
     * Process tiles with ZERO CPU READBACK for display.
     * Creates GPUTextures via copyBufferToTexture — tiles are renderable immediately.
     * Returns a Promise that resolves with Uint8Array data for cascade building (background).
     *
     * @param {Array} tiles - Same format as processTiles()
     * @param {Function} onTileGPUTexture - (tileIndex, gpuTexture, width, height) called immediately
     * @param {AbortSignal} signal - Optional abort signal
     */
    async processTilesZeroCopy(tiles, onTileGPUTexture, signal = null, onBatchGPUDone = null) {
        if (!this.initialized) {
            await this.initialize();
        }

        if (tiles.length === 0) return;

        const t0 = performance.now();

        let { fftSize, exactHop, dbFloor, dbRange, hannWindow } = tiles[0];
        let freqBins = fftSize / 2;
        let logStages = Math.log2(fftSize);
        const numSlices = tiles[0].numTimeSlices;

        // Rebuild pipeline + Hann window when FFT size changes
        if (!this.hannUploaded || this.lastFftSize !== fftSize) {
            fftSize = await this._rebuildPipelineForFFTSize(fftSize);
            freqBins = fftSize / 2;
            logStages = Math.log2(fftSize);

            const actualHannWindow = new Float32Array(fftSize);
            for (let i = 0; i < fftSize; i++) {
                actualHannWindow[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));
            }

            if (this.hannBuffer) this.hannBuffer.destroy();
            this.hannBuffer = this.device.createBuffer({
                size: actualHannWindow.byteLength,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                label: 'hann-window'
            });
            this.device.queue.writeBuffer(this.hannBuffer, 0, actualHannWindow);
            this.hannUploaded = true;
            this.lastFftSize = fftSize;
        }

        // Write uniforms (sub-FFT size for multi-pass, full size for single-pass)
        const uniforms = new Uint32Array(8);
        const uniformsF32 = new Float32Array(uniforms.buffer);
        uniforms[0] = (this.twoPassEnabled || this.multiPassEnabled) ? this.baseFFTSize : fftSize;
        uniformsF32[1] = exactHop;
        uniforms[2] = numSlices;
        uniforms[3] = freqBins;
        uniformsF32[4] = dbFloor;
        uniformsF32[5] = dbRange;
        uniformsF32[6] = 1.0 / fftSize;
        uniforms[7] = logStages;
        this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

        // Split into batches that fit GPU limits
        let bytesPerTile = numSlices * freqBins;
        if (this.multiPassEnabled) {
            const base = this.baseFFTSize;
            const numSubFFTs = Math.pow(2, this.numDecompLevels);
            const midN = base * 2;
            bytesPerTile += numSubFFTs * numSlices * base * 2 * 4;  // buffer A
            bytesPerTile += 2 * numSlices * midN * 2 * 4;           // buffer B
        } else if (this.twoPassEnabled) {
            const M = fftSize / 2;
            bytesPerTile += 2 * numSlices * M * 2 * 4;
        }
        const maxTilesPerBatch = Math.max(1, Math.floor(this.maxOutputBytes / bytesPerTile));

        const allGpuDonePromises = [];
        const batchEncodeTimes = [];
        let batchCount = 0;

        const numBatches = Math.ceil(tiles.length / maxTilesPerBatch);
        if (window.pm?.rendering) console.log(
            `%c[GPU Zero-Copy] ${tiles.length} tiles → ${numBatches} batches (${maxTilesPerBatch}/batch)`,
            'color: #FF9800; font-weight: bold'
        );

        // For multi-pass, limit in-flight batches to avoid allocating all intermediate
        // buffers simultaneously (each batch uses ~130MB of transient buffers for 8192-point FFT).
        // 2 in-flight is optimal: GPU stays fed while previous batch cleans up, ~260MB peak.
        const maxInFlight = (this.multiPassEnabled || this.twoPassEnabled) ? 2 : Infinity;
        let inFlightPromises = [];

        for (let batchStart = 0; batchStart < tiles.length; batchStart += maxTilesPerBatch) {
            if (signal?.aborted) return;

            // Throttle: wait for oldest batch to finish before submitting new ones
            if (inFlightPromises.length >= maxInFlight) {
                await inFlightPromises.shift();
            }

            const batchEnd = Math.min(batchStart + maxTilesPerBatch, tiles.length);
            const batchTiles = tiles.slice(batchStart, batchEnd);

            const { gpuDonePromise, encodeMs } = this._processBatchZeroCopy(
                batchTiles, batchTiles.length, numSlices, freqBins, onTileGPUTexture, signal
            );

            const cleanupPromise = gpuDonePromise.then(gpuTime => {
                if (onBatchGPUDone) onBatchGPUDone(batchCount);
                return gpuTime;
            });

            inFlightPromises.push(cleanupPromise);
            allGpuDonePromises.push(cleanupPromise);
            batchEncodeTimes.push(encodeMs);
            batchCount++;
        }

        const submitElapsed = (performance.now() - t0).toFixed(1);
        const totalEncodeMs = batchEncodeTimes.reduce((a, b) => a + b, 0).toFixed(1);
        if (window.pm?.rendering) console.log(
            `%c[GPU Zero-Copy] All ${batchCount} batches submitted in ${submitElapsed}ms ` +
            `(encode: ${totalEncodeMs}ms) — GPUTextures ready, cascade via GPU render passes`,
            'color: #FF9800; font-weight: bold'
        );

        // Return promise that resolves when GPU finishes ALL batches
        return Promise.all(allGpuDonePromises).then(gpuTimes => {
            const maxGpu = Math.max(...gpuTimes).toFixed(1);
            const minGpu = Math.min(...gpuTimes).toFixed(1);
            if (window.pm?.rendering) console.log(
                `%c[GPU Zero-Copy] GPU compute done: ${maxGpu}ms (range: ${minGpu}–${maxGpu}ms across ${batchCount} batches)`,
                'color: #80d0ff; font-weight: bold'
            );
        });
    }

    /**
     * Zero-copy batch: compute → copyBufferToTexture → GPUTextures ready.
     * No staging buffer, no readback. Cascade built on GPU via render passes.
     */
    _processBatchZeroCopy(batchTiles, numTiles, numSlices, freqBins, onTileGPUTexture, signal) {
        if (this.multiPassEnabled) {
            return this._processBatchZeroCopyMultiPass(batchTiles, numTiles, numSlices, freqBins, onTileGPUTexture, signal);
        }
        if (this.twoPassEnabled) {
            return this._processBatchZeroCopyTwoPass(batchTiles, numTiles, numSlices, freqBins, onTileGPUTexture, signal);
        }
        const tBatch = performance.now();

        // ── Concatenate audio + build tile descriptors ──
        let totalAudioFloats = 0;
        const audioOffsets = [];
        const outputOffsets = [];

        for (let i = 0; i < numTiles; i++) {
            audioOffsets.push(totalAudioFloats);
            outputOffsets.push(i * numSlices * freqBins);
            totalAudioFloats += batchTiles[i].audioData.length;
        }

        const megaAudio = new Float32Array(totalAudioFloats);
        let offset = 0;
        for (let i = 0; i < numTiles; i++) {
            megaAudio.set(batchTiles[i].audioData, offset);
            offset += batchTiles[i].audioData.length;
        }

        const tileDescsData = new Uint32Array(numTiles * 2);
        for (let i = 0; i < numTiles; i++) {
            tileDescsData[i * 2] = audioOffsets[i];
            tileDescsData[i * 2 + 1] = outputOffsets[i];
        }

        // ── GPU buffers ──
        const audioBuffer = this.device.createBuffer({
            size: megaAudio.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: 'zc-audio'
        });
        this.device.queue.writeBuffer(audioBuffer, 0, megaAudio);

        const tileDescsBuffer = this.device.createBuffer({
            size: tileDescsData.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: 'zc-tile-descs'
        });
        this.device.queue.writeBuffer(tileDescsBuffer, 0, tileDescsData);

        const totalOutputBytes = numTiles * numSlices * freqBins;
        const outputByteSize = Math.ceil(totalOutputBytes / 4) * 4;

        const outputBuffer = this.device.createBuffer({
            size: outputByteSize,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            label: 'zc-output'
        });

        const bindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: audioBuffer } },
                { binding: 1, resource: { buffer: this.hannBuffer } },
                { binding: 2, resource: { buffer: outputBuffer } },
                { binding: 3, resource: { buffer: this.uniformBuffer } },
                { binding: 4, resource: { buffer: tileDescsBuffer } },
            ]
        });

        // ── Command encoder: compute + texture copy (no staging!) ──
        const encoder = this.device.createCommandEncoder({ label: 'zc-mega-batch' });

        const pass = encoder.beginComputePass({ label: 'fft-zc' });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(numSlices, numTiles);
        pass.end();

        // Create GPUTextures and copy from output buffer (zero-readback!)
        const gpuTextures = [];
        for (let i = 0; i < numTiles; i++) {
            const gpuTexture = this.device.createTexture({
                size: [numSlices, freqBins],
                format: 'r8unorm',
                usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
                label: `zc-tile-${batchTiles[i].tileIndex}`
            });
            encoder.copyBufferToTexture(
                { buffer: outputBuffer, offset: outputOffsets[i], bytesPerRow: numSlices },
                { texture: gpuTexture },
                [numSlices, freqBins]
            );
            gpuTextures.push(gpuTexture);
        }

        this.device.queue.submit([encoder.finish()]);

        const tSubmit = performance.now();

        // ── Immediately fire GPU texture callbacks — tiles are renderable NOW ──
        for (let i = 0; i < numTiles; i++) {
            if (signal?.aborted) break;
            onTileGPUTexture(batchTiles[i].tileIndex, gpuTextures[i], numSlices, freqBins);
        }

        // ── Cleanup: destroy transient buffers after GPU finishes ──
        this.device.queue.onSubmittedWorkDone().then(() => {
            audioBuffer.destroy();
            tileDescsBuffer.destroy();
            outputBuffer.destroy();
        });

        // ── Diagnostic: when does the GPU actually finish this batch's work? ──
        const gpuDonePromise = this.device.queue.onSubmittedWorkDone().then(() => {
            return performance.now() - tSubmit;
        });

        return {
            gpuDonePromise,
            encodeMs: tSubmit - tBatch,
            numTiles
        };
    }

    // ─── Cascade Render Pipeline ────────────────────────────────────────────

    /**
     * Rebuild the FFT compute pipeline for a new FFT size.
     * Uses single-pass Stockham when shared memory is sufficient,
     * or two-pass Cooley-Tukey (sub-FFT + combine) for larger sizes.
     */
    async _rebuildPipelineForFFTSize(fftSize) {
        const neededBytes = 2 * fftSize * 2 * 4;

        // Reset multi-pass state
        this.twoPassEnabled = false;
        this.multiPassEnabled = false;
        this.numDecompLevels = 0;
        this.baseFFTSize = fftSize;

        // Find the largest sub-FFT size that fits in shared memory
        const maxBaseSize = this.maxWorkgroupStorage
            ? Math.pow(2, Math.floor(Math.log2(this.maxWorkgroupStorage / (2 * 2 * 4))))
            : fftSize; // no limit known — assume it fits

        if (fftSize <= maxBaseSize) {
            // ── Single-pass: fits in shared memory ──
            FFT_WGSL_SHADER = buildFFTShader(fftSize);

            const shaderModule = this.device.createShaderModule({
                code: FFT_WGSL_SHADER,
                label: `fft-spectrogram-${fftSize}`
            });
            const compilationInfo = await shaderModule.getCompilationInfo();
            for (const msg of compilationInfo.messages) {
                if (msg.type === 'error') throw new Error(`WGSL compile error: ${msg.message}`);
            }

            this.pipeline = await this.device.createComputePipelineAsync({
                label: `fft-pipeline-${fftSize}`,
                layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
                compute: { module: shaderModule, entryPoint: 'fft_main' }
            });

            if (window.pm?.rendering) console.log(`[GPU Compute] Single-pass pipeline for FFT ${fftSize} (${neededBytes}B workgroup storage)`);
            return fftSize;
        }

        // ── Multi-pass decomposition ──
        // Calculate how many levels of splitting needed
        const numLevels = Math.round(Math.log2(fftSize / maxBaseSize));
        const numSubFFTs = Math.pow(2, numLevels);
        this.baseFFTSize = maxBaseSize;
        this.numDecompLevels = numLevels;

        // Cap at 2 levels (three-pass) for now — beyond that is impractical
        if (numLevels > 2) {
            const fallback = maxBaseSize * 4; // max 3-pass size
            console.warn(`[GPU Compute] FFT ${fftSize} needs ${numLevels} decomp levels (max 2). Falling back to ${fallback}.`);
            return this._rebuildPipelineForFFTSize(fallback);
        }

        if (numLevels === 1) {
            this.twoPassEnabled = true;
        } else {
            this.multiPassEnabled = true;
        }

        // ── Sub-FFT pipeline (Pass 1) — shared by both two-pass and multi-pass ──
        const subShaderCode = buildSubFFTShader(maxBaseSize, numSubFFTs);
        const subModule = this.device.createShaderModule({ code: subShaderCode, label: `subfft-${maxBaseSize}-x${numSubFFTs}` });
        const subInfo = await subModule.getCompilationInfo();
        for (const msg of subInfo.messages) {
            if (msg.type === 'error') throw new Error(`Sub-FFT WGSL error: ${msg.message}`);
        }

        this.subFFTBindGroupLayout = this.device.createBindGroupLayout({
            label: 'subfft-bind-group-layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },  // audioData
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },  // hannWindow
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },            // intermediate
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },            // params
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },  // tileDescs
            ]
        });

        this.subFFTPipeline = await this.device.createComputePipelineAsync({
            label: `subfft-pipeline-${maxBaseSize}-x${numSubFFTs}`,
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.subFFTBindGroupLayout] }),
            compute: { module: subModule, entryPoint: 'subfft_main' }
        });

        // ── Intermediate combine pipeline (for 3+ passes) ──
        if (numLevels >= 2) {
            const intCombineCode = buildIntermediateCombineShader();
            const intCombineModule = this.device.createShaderModule({ code: intCombineCode, label: `int-combine-${fftSize}` });
            const intCombineInfo = await intCombineModule.getCompilationInfo();
            for (const msg of intCombineInfo.messages) {
                if (msg.type === 'error') throw new Error(`Intermediate combine WGSL error: ${msg.message}`);
            }

            this.intCombineBindGroupLayout = this.device.createBindGroupLayout({
                label: 'int-combine-bind-group-layout',
                entries: [
                    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },  // input intermediate
                    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },            // output intermediate
                    { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },            // params
                    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },  // tileDescs
                ]
            });

            this.intCombinePipeline = await this.device.createComputePipelineAsync({
                label: `int-combine-pipeline-${fftSize}`,
                layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.intCombineBindGroupLayout] }),
                compute: { module: intCombineModule, entryPoint: 'int_combine_main' }
            });

            if (this.intCombineUniformBuffer) this.intCombineUniformBuffer.destroy();
            this.intCombineUniformBuffer = this.device.createBuffer({
                size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'int-combine-params'
            });
        }

        // ── Final combine pipeline (shared by two-pass and multi-pass) ──
        const combineShaderCode = buildCombineShader();
        const combineModule = this.device.createShaderModule({ code: combineShaderCode, label: `combine-${fftSize}` });
        const combineInfo = await combineModule.getCompilationInfo();
        for (const msg of combineInfo.messages) {
            if (msg.type === 'error') throw new Error(`Combine WGSL error: ${msg.message}`);
        }

        this.combineBindGroupLayout = this.device.createBindGroupLayout({
            label: 'combine-bind-group-layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },  // intermediate
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },            // output
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },            // combineParams
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },  // tileDescs
            ]
        });

        this.combinePipeline = await this.device.createComputePipelineAsync({
            label: `combine-pipeline-${fftSize}`,
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.combineBindGroupLayout] }),
            compute: { module: combineModule, entryPoint: 'combine_main' }
        });

        if (this.combineUniformBuffer) this.combineUniformBuffer.destroy();
        this.combineUniformBuffer = this.device.createBuffer({
            size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'combine-params'
        });

        const passLabel = numLevels === 1 ? 'Two-pass' : `${numLevels + 1}-pass`;
        if (window.pm?.rendering) console.log(
            `[GPU Compute] ${passLabel} pipeline for FFT ${fftSize}: ` +
            `${numSubFFTs}×${maxBaseSize} sub-FFTs, ${numLevels} combine level(s)`
        );
        return fftSize;
    }

    /**
     * Initialize the cascade render pipeline (called from initialize()).
     * Creates shader module, bind group layout, pipeline, uniform buffer,
     * and a 1x1 dummy texture for the single-child edge case.
     */
    async _initCascadePipeline() {
        const cascadeShader = this.device.createShaderModule({
            code: CASCADE_WGSL_SHADER,
            label: 'cascade-downsample'
        });

        const compilationInfo = await cascadeShader.getCompilationInfo();
        for (const msg of compilationInfo.messages) {
            if (msg.type === 'error') {
                throw new Error(`Cascade WGSL compile error: ${msg.message} (line ${msg.lineNum})`);
            }
        }

        this.cascadeBindGroupLayout = this.device.createBindGroupLayout({
            label: 'cascade-bind-group-layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ]
        });

        this.cascadePipeline = await this.device.createRenderPipelineAsync({
            label: 'cascade-pipeline',
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.cascadeBindGroupLayout]
            }),
            vertex: {
                module: cascadeShader,
                entryPoint: 'vs',
            },
            fragment: {
                module: cascadeShader,
                entryPoint: 'fs',
                targets: [{ format: 'r8unorm' }],
            },
            primitive: { topology: 'triangle-list' },
        });

        // 1x1 dummy texture for single-child case (bound as child1 but never read)
        this.dummyTexture = this.device.createTexture({
            size: [1, 1],
            format: 'r8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING,
            label: 'cascade-dummy'
        });
    }

    /**
     * Build cascade parents via GPU render passes. All parents encoded in a
     * single command buffer, single queue.submit(). Returns array of GPUTextures.
     *
     * @param {Array<{child0Tex: GPUTexture, child1Tex: GPUTexture|null, parentWidth: number, freqBins: number}>} pairs
     * @param {string} reduceMode - 'average' | 'peak' | 'balanced'
     * @returns {GPUTexture[]} Parent textures (one per pair)
     */
    buildCascadeChain(pairs, reduceMode = 'average') {
        if (!this.cascadePipeline || pairs.length === 0) return [];

        const modeMap = { average: 0, peak: 1, balanced: 2 };
        const mode = modeMap[reduceMode] ?? 0;

        const encoder = this.device.createCommandEncoder({ label: 'cascade-chain' });
        const parentTextures = [];
        const tempBuffers = []; // per-pass uniform buffers (each pass may have different params)

        for (const { child0Tex, child1Tex, parentWidth, freqBins } of pairs) {
            const splitCol = Math.floor(child0Tex.width / 2);

            // Per-pass uniform buffer (16 bytes) — each pass in the chain may differ
            const ubo = this.device.createBuffer({
                size: 16,
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                label: 'cascade-params-pass'
            });
            const uniforms = new Uint32Array([splitCol, mode, child1Tex ? 1 : 0, 0]);
            this.device.queue.writeBuffer(ubo, 0, uniforms);
            tempBuffers.push(ubo);

            const parentTex = this.device.createTexture({
                size: [parentWidth, freqBins],
                format: 'r8unorm',
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
                label: `cascade-L-parent`
            });

            const bindGroup = this.device.createBindGroup({
                layout: this.cascadeBindGroupLayout,
                entries: [
                    { binding: 0, resource: child0Tex.createView() },
                    { binding: 1, resource: (child1Tex || this.dummyTexture).createView() },
                    { binding: 2, resource: { buffer: ubo } },
                ]
            });

            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view: parentTex.createView(),
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                }],
                label: `cascade-pass`
            });
            pass.setPipeline(this.cascadePipeline);
            pass.setBindGroup(0, bindGroup);
            pass.draw(3); // fullscreen triangle
            pass.end();

            parentTextures.push(parentTex);
        }

        this.device.queue.submit([encoder.finish()]);

        // Cleanup per-pass uniform buffers after GPU finishes
        this.device.queue.onSubmittedWorkDone().then(() => {
            for (const buf of tempBuffers) buf.destroy();
        });

        return parentTextures;
    }

    /** Throttle — no-op for GPU (async, non-blocking). */
    throttle() {}

    /** Resume — no-op for GPU. */
    resume() {}

    /** Release GPU resources. */
    terminate() {
        if (this.hannBuffer) {
            this.hannBuffer.destroy();
            this.hannBuffer = null;
        }
        if (this.uniformBuffer) {
            this.uniformBuffer.destroy();
            this.uniformBuffer = null;
        }
        if (this.combineUniformBuffer) {
            this.combineUniformBuffer.destroy();
            this.combineUniformBuffer = null;
        }
        if (this.dummyTexture) {
            this.dummyTexture.destroy();
            this.dummyTexture = null;
        }
        // Multi-pass / two-pass state
        this.twoPassEnabled = false;
        this.multiPassEnabled = false;
        this.numDecompLevels = 0;
        this.baseFFTSize = 0;
        this.subFFTPipeline = null;
        this.subFFTBindGroupLayout = null;
        this.combinePipeline = null;
        this.combineBindGroupLayout = null;
        // Multi-pass intermediate combine
        if (this.intCombineUniformBuffer) {
            this.intCombineUniformBuffer.destroy();
            this.intCombineUniformBuffer = null;
        }
        this.intCombinePipeline = null;
        this.intCombineBindGroupLayout = null;

        this.cascadePipeline = null;
        this.cascadeBindGroupLayout = null;
        if (this.device) {
            if (this.ownsDevice) this.device.destroy();
            this.device = null;
        }
        this.initialized = false;
        this.hannUploaded = false;

        if (!isStudyMode() && window.pm?.rendering) {
            console.log('[GPU Compute] Terminated');
        }
    }

    async cleanup() {
        this.terminate();
    }

    getStats() {
        return {
            initialized: this.initialized,
            backend: 'webgpu'
        };
    }
}
