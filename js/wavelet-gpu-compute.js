/**
 * wavelet-gpu-compute.js — WebGPU Continuous Wavelet Transform + Phase Vocoder Stretch
 *
 * GPU-accelerated CWT using the standard frequency-domain approach:
 *   1. Forward FFT of full signal (multi-pass Stockham, global memory)
 *   2. For each scale: multiply signal_FFT × Morlet spectrum
 *   3. Inverse FFT per scale (multi-pass, batched across all scales)
 *   → complex CWT coefficients in time domain
 *
 * Phase vocoder stretch as second compute pass:
 *   CWT coefficients → interpolate + phase correct → ICWT accumulation → stretched audio
 *
 * Architecture:
 *   Pass 1 (CWT):     ~37 dispatches (18 fwd FFT + 1 multiply + 18 inv FFT)
 *   Pass 2 (Stretch):  dispatch(ceil(outputLength/256)) — re-run on stretch factor change
 *   Readback:          single mapAsync for final audio
 */

import { isStudyMode } from './master-modes.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const WORKGROUP_SIZE = 256;

// ─── WGSL: Global-memory Stockham FFT butterfly (one stage per dispatch) ─────
// Each thread computes one butterfly. Dispatched as (halfN / 256, numSlices).
// numSlices=1 for forward FFT, numSlices=numScales for batched inverse FFT.

const FFT_STAGE_SHADER = /* wgsl */ `

struct FFTParams {
    halfN:      u32,       // N / 2 (number of butterflies)
    stage:      u32,       // current Stockham stage (0..logN-1)
    direction:  f32,       // -1.0 forward, +1.0 inverse
    applyNorm:  u32,       // 1 on last inverse stage, 0 otherwise
    invN:       f32,       // 1.0 / N (for normalization)
    numSlices:  u32,       // number of independent FFTs (1 or numScales)
    N:          u32,       // FFT size
    _pad:       u32,
};

@group(0) @binding(0) var<storage, read> bufIn: array<f32>;
@group(0) @binding(1) var<storage, read_write> bufOut: array<f32>;
@group(0) @binding(2) var<uniform> params: FFTParams;

@compute @workgroup_size(256)
fn fft_stage(@builtin(global_invocation_id) gid: vec3<u32>) {
    let bflyIdx: u32 = gid.x;
    let sliceIdx: u32 = gid.y;

    if (bflyIdx >= params.halfN || sliceIdx >= params.numSlices) { return; }

    let sliceOffset: u32 = sliceIdx * params.N * 2u;

    let halfSpan: u32 = 1u << params.stage;
    let span: u32 = halfSpan << 1u;

    let group: u32 = bflyIdx / halfSpan;
    let pos: u32 = bflyIdx % halfSpan;

    // Stockham addressing: source is scrambled, destination is sorted
    let srcEven: u32 = group * halfSpan + pos;
    let srcOdd: u32 = srcEven + params.halfN;

    let dst0: u32 = group * span + pos;
    let dst1: u32 = dst0 + halfSpan;

    let angle: f32 = params.direction * 6.283185307 * f32(pos) / f32(span);
    let twR: f32 = cos(angle);
    let twI: f32 = sin(angle);

    let eR: f32 = bufIn[sliceOffset + srcEven * 2u];
    let eI: f32 = bufIn[sliceOffset + srcEven * 2u + 1u];
    let oR: f32 = bufIn[sliceOffset + srcOdd * 2u];
    let oI: f32 = bufIn[sliceOffset + srcOdd * 2u + 1u];

    let tR: f32 = oR * twR - oI * twI;
    let tI: f32 = oR * twI + oI * twR;

    var r0R: f32 = eR + tR;
    var r0I: f32 = eI + tI;
    var r1R: f32 = eR - tR;
    var r1I: f32 = eI - tI;

    if (params.applyNorm == 1u) {
        r0R *= params.invN; r0I *= params.invN;
        r1R *= params.invN; r1I *= params.invN;
    }

    bufOut[sliceOffset + dst0 * 2u] = r0R;
    bufOut[sliceOffset + dst0 * 2u + 1u] = r0I;
    bufOut[sliceOffset + dst1 * 2u] = r1R;
    bufOut[sliceOffset + dst1 * 2u + 1u] = r1I;
}
`;

// ─── WGSL: Morlet frequency-domain multiply ──────────────────────────────────
// For each (frequency bin, scale): cwtFreq[scale][bin] = signalFFT[bin] × morletLUT[scale][bin]
// Morlet is real-valued and zero for negative frequencies (analytic wavelet).

const MORLET_MUL_SHADER = /* wgsl */ `

struct MorletParams {
    N:          u32,       // FFT size
    halfN:      u32,       // N / 2
    numScales:  u32,
    _pad:       u32,
};

@group(0) @binding(0) var<storage, read> signalFFT: array<f32>;
@group(0) @binding(1) var<storage, read> morletLUT: array<f32>;
@group(0) @binding(2) var<storage, read_write> cwtFreq: array<f32>;
@group(0) @binding(3) var<uniform> params: MorletParams;

@compute @workgroup_size(256)
fn morlet_mul(@builtin(global_invocation_id) gid: vec3<u32>) {
    let bin: u32 = gid.x;
    let scaleIdx: u32 = gid.y;

    if (bin >= params.N || scaleIdx >= params.numScales) { return; }

    // Signal FFT (complex)
    let sigR: f32 = signalFFT[bin * 2u];
    let sigI: f32 = signalFFT[bin * 2u + 1u];

    // Morlet is real-valued, non-zero only for positive frequencies (bins 0..halfN-1)
    var morletVal: f32 = 0.0;
    if (bin < params.halfN) {
        morletVal = morletLUT[scaleIdx * params.halfN + bin];
    }

    // Complex × real = simple scaling
    let outOffset: u32 = scaleIdx * params.N * 2u;
    cwtFreq[outOffset + bin * 2u] = sigR * morletVal;
    cwtFreq[outOffset + bin * 2u + 1u] = sigI * morletVal;
}
`;

// ─── WGSL: Phase Vocoder Stretch + ICWT ──────────────────────────────────────
// Each thread produces one output sample by summing across all scales (ICWT).
// Interpolates CWT coefficients to stretched time position.
// Phase correction: multiply interpolated phase by stretch factor.

const STRETCH_WGSL_SHADER = /* wgsl */ `

struct StretchParams {
    stretchFactor:   f32,
    signalLength:    u32,
    outputLength:    u32,
    numScales:       u32,
    dj:              f32,
    dt:              f32,
    w0:              f32,
    phaseRand:       f32,    // 0.0 = phase vocoder, 1.0 = full random (paulstretch-style)
    interpMode:      u32,    // 0 = cubic (Catmull-Rom), 1 = linear
    _pad0:           u32,
    _pad1:           u32,
    _pad2:           u32,
};

// Deterministic hash for pseudo-random phase per (block, scale) pair
fn pcgHash(input: u32) -> u32 {
    var state: u32 = input * 747796405u + 2891336453u;
    var word: u32 = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
}

fn hashPhase(blockIdx: u32, scaleIdx: u32) -> f32 {
    let h: u32 = pcgHash(blockIdx * 65537u + scaleIdx * 17u + 1u);
    return f32(h) / f32(0xFFFFFFFFu) * 6.283185307;  // [0, 2π]
}

// Smooth random phase: constant within blocks, interpolated at boundaries.
// Block size ~2048 samples ≈ 43ms at 48kHz (similar to paulstretch grain).
const PHASE_BLOCK_SIZE: u32 = 2048u;

fn smoothRandomPhase(outIdx: u32, scaleIdx: u32) -> f32 {
    let blockIdx: u32 = outIdx / PHASE_BLOCK_SIZE;
    let posInBlock: f32 = f32(outIdx % PHASE_BLOCK_SIZE) / f32(PHASE_BLOCK_SIZE);

    let phase0: f32 = hashPhase(blockIdx, scaleIdx);
    let phase1: f32 = hashPhase(blockIdx + 1u, scaleIdx);

    // Smooth interpolation (raised cosine) to avoid clicks at block edges
    let t: f32 = 0.5 - 0.5 * cos(posInBlock * 3.14159265);
    // Unwrap phase difference for smooth interpolation
    var dp: f32 = phase1 - phase0;
    dp = dp - round(dp * 0.159154943) * 6.283185307;
    return phase0 + t * dp;
}

@group(0) @binding(0) var<storage, read> cwtCoeffs: array<f32>;
@group(0) @binding(1) var<storage, read_write> stretchedAudio: array<f32>;
@group(0) @binding(2) var<uniform> params: StretchParams;
@group(0) @binding(3) var<storage, read> scales: array<f32>;

@compute @workgroup_size(256)
fn stretch_main(
    @builtin(workgroup_id) wg_id: vec3<u32>,
    @builtin(local_invocation_id) lid: vec3<u32>,
) {
    let outIdx: u32 = wg_id.x * 256u + lid.x;
    if (outIdx >= params.outputLength) { return; }

    // Map output sample to input position
    let inputPos: f32 = f32(outIdx) / params.stretchFactor;
    let idx0: u32 = u32(floor(inputPos));
    let frac: f32 = inputPos - f32(idx0);

    // Clamp indices for 4-point access (Catmull-Rom needs p_-1, p_0, p_1, p_2)
    let maxIdx: u32 = params.signalLength - 1u;
    let i1: u32 = min(idx0, maxIdx);                    // p0
    let i0: u32 = select(0u, i1 - 1u, i1 > 0u);        // p_-1 (clamp at 0)
    let i2: u32 = min(i1 + 1u, maxIdx);                 // p1
    let i3: u32 = min(i1 + 2u, maxIdx);                 // p2

    var accumulator: f32 = 0.0;

    // Sum across all scales (ICWT)
    for (var si: u32 = 0u; si < params.numScales; si++) {
        let baseAddr: u32 = si * params.signalLength * 2u;

        // Read 4 complex coefficients for cubic interpolation
        let re_m1: f32 = cwtCoeffs[baseAddr + i0 * 2u];
        let im_m1: f32 = cwtCoeffs[baseAddr + i0 * 2u + 1u];
        let re_0: f32  = cwtCoeffs[baseAddr + i1 * 2u];
        let im_0: f32  = cwtCoeffs[baseAddr + i1 * 2u + 1u];
        let re_1: f32  = cwtCoeffs[baseAddr + i2 * 2u];
        let im_1: f32  = cwtCoeffs[baseAddr + i2 * 2u + 1u];
        let re_2: f32  = cwtCoeffs[baseAddr + i3 * 2u];
        let im_2: f32  = cwtCoeffs[baseAddr + i3 * 2u + 1u];

        // Magnitudes at 4 points
        let m0: f32 = sqrt(re_m1 * re_m1 + im_m1 * im_m1);
        let m1: f32 = sqrt(re_0 * re_0 + im_0 * im_0);
        let m2: f32 = sqrt(re_1 * re_1 + im_1 * im_1);
        let m3: f32 = sqrt(re_2 * re_2 + im_2 * im_2);

        // Phases at 4 points, unwrapped relative to p0
        let p1: f32 = atan2(im_0, re_0);

        var dp0: f32 = atan2(im_m1, re_m1) - p1;
        dp0 = dp0 - round(dp0 * 0.159154943) * 6.283185307;
        let p0: f32 = p1 + dp0;

        var dp2: f32 = atan2(im_1, re_1) - p1;
        dp2 = dp2 - round(dp2 * 0.159154943) * 6.283185307;
        let p2: f32 = p1 + dp2;

        var dp3: f32 = atan2(im_2, re_2) - p2;
        dp3 = dp3 - round(dp3 * 0.159154943) * 6.283185307;
        let p3: f32 = p2 + dp3;

        var mag: f32;
        var phase: f32;

        if (params.interpMode == 1u) {
            // Linear interpolation
            mag = mix(m1, m2, frac);
            phase = p1 + frac * (p2 - p1);
        } else {
            // Catmull-Rom cubic spline interpolation
            let t: f32 = frac;
            let t2: f32 = t * t;
            let t3: f32 = t2 * t;

            mag = 0.5 * ((2.0 * m1) + (-m0 + m2) * t
                + (2.0 * m0 - 5.0 * m1 + 4.0 * m2 - m3) * t2
                + (-m0 + 3.0 * m1 - 3.0 * m2 + m3) * t3);
            mag = max(mag, 0.0); // clamp negative from overshoot

            phase = 0.5 * ((2.0 * p1) + (-p0 + p2) * t
                + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
                + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3);
        }

        // Weight by 1/sqrt(s) — required for frequency-domain CWT normalization
        // (forward CWT has sqrt(2*pi*s/dt) which grows with scale; this compensates)
        let scaleWeight: f32 = 1.0 / sqrt(scales[si]);

        if (params.phaseRand > 0.0) {
            let randAngle: f32 = smoothRandomPhase(outIdx, si) * params.phaseRand;
            accumulator += scaleWeight * mag * cos(phase * params.stretchFactor + randAngle);
        } else {
            accumulator += scaleWeight * mag * cos(phase * params.stretchFactor);
        }
    }

    // Apply ICWT scaling: dj * sqrt(dt) / (C_d * psi(0))
    // C_d ≈ 0.776 for Morlet w0=6 (Torrence & Compo '98)
    // psi(0) = pi^(-0.25) ≈ 0.7511 for all Morlet wavelets
    let C_d: f32 = 0.776;
    let psi0: f32 = 0.7511255;
    stretchedAudio[outIdx] = accumulator * params.dj * sqrt(params.dt) / (C_d * psi0);
}
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nextPowerOf2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

// ─── Scale Generation (ported from Python wavelets/transform.py) ─────────────

/**
 * Find the smallest scale such that fourier_period(s0) = 2 * dt.
 */
function smallestScale(dt, w0) {
    return 2 * dt * (w0 + Math.sqrt(2 + w0 * w0)) / (4 * Math.PI);
}

/**
 * Generate logarithmically-spaced CWT scales.
 * Matches Python: scales = s0 * 2^(dj * [0, 1, 2, ..., J])
 */
export function generateScales(signalLength, dt, w0 = 6, dj = 0.1) {
    const s0 = smallestScale(dt, w0);
    const J = Math.floor((1 / dj) * Math.log2(signalLength * dt / s0));

    const scales = new Float32Array(J + 1);
    for (let j = 0; j <= J; j++) {
        scales[j] = s0 * Math.pow(2, dj * j);
    }
    return scales;
}

// ─── Morlet LUT Builder ──────────────────────────────────────────────────────

/**
 * Build the Morlet frequency-domain lookup table.
 * For each scale, the analytic Morlet spectrum is a Gaussian:
 *   psi_hat(omega, s) = pi^(-1/4) * exp(-(s*omega - w0)^2 / 2)
 * With normalization factor: sqrt(2*pi*s / dt) (matches Python convention)
 *
 * Layout: lut[scaleIdx * halfN + freqBin]
 *
 * @param {Float32Array} scales - CWT scales
 * @param {number} N - Full FFT size (padded to power of 2)
 * @param {number} dt - Sample spacing
 * @param {number} w0 - Morlet frequency parameter
 * @returns {Float32Array}
 */
export function buildMorletLUT(scales, N, dt, w0) {
    const halfN = N / 2;
    const numScales = scales.length;
    const lut = new Float32Array(numScales * halfN);
    const piInvFourth = Math.pow(Math.PI, -0.25);

    for (let si = 0; si < numScales; si++) {
        const s = scales[si];
        // Normalization: sqrt(2*pi*s / dt) * pi^(-1/4)
        // This matches the Python CWT convention
        const norm = Math.sqrt(2 * Math.PI * s / dt) * piInvFourth;
        const base = si * halfN;

        // Optimization: only compute bins where Gaussian is significant
        // The Gaussian exp(-(s*omega - w0)^2 / 2) peaks at omega = w0/s
        // omega_k = 2*pi*k / (N*dt) [rad/s], scales s are in seconds
        // Peak bin: k = w0 * N * dt / (2*pi*s)
        const centerK = w0 * N * dt / (2 * Math.PI * s);
        const widthK = Math.ceil(10 * N * dt / (2 * Math.PI * s));
        const kMin = Math.max(0, Math.floor(centerK - widthK));
        const kMax = Math.min(halfN, Math.ceil(centerK + widthK));

        for (let k = kMin; k < kMax; k++) {
            const omega = 2 * Math.PI * k / (N * dt);  // rad/s
            const x = s * omega - w0;
            lut[base + k] = norm * Math.exp(-0.5 * x * x);
        }
    }
    return lut;
}

// ─── CQT (Constant-Q Transform) Scale/Filter Generation ─────────────────────

/**
 * Generate CQT frequency bins, bandwidths, and equivalent scales.
 * @param {number} sampleRate - Audio sample rate in Hz
 * @param {number} binsPerOctave - Frequency resolution (12 = semitone)
 * @param {number} fMin - Lowest frequency in Hz
 * @returns {object} { frequencies, bandwidths, scales, numBins, Q }
 */
export function generateCQTScales(sampleRate, binsPerOctave = 12, fMin = 20, minBW = 0) {
    const fMax = sampleRate / 2;
    const Q = 1 / (Math.pow(2, 1 / binsPerOctave) - 1);
    const numBins = Math.ceil(binsPerOctave * Math.log2(fMax / fMin));

    const frequencies = new Float32Array(numBins);
    const bandwidths = new Float32Array(numBins);
    const scales = new Float32Array(numBins);

    for (let k = 0; k < numBins; k++) {
        frequencies[k] = fMin * Math.pow(2, k / binsPerOctave);
        const naturalBW = frequencies[k] / Q;
        bandwidths[k] = Math.max(naturalBW, minBW); // floor prevents bass smearing

        // Bandwidth normalization: wider filters capture more energy.
        // Weight = naturalBW / actualBW (< 1.0 for clamped bins).
        // Stretch shader reads 1/sqrt(scales[si]), so store 1/w² to get weight w.
        const w = naturalBW / bandwidths[k];
        scales[k] = 1.0 / (w * w);
    }
    return { frequencies, bandwidths, scales, numBins, Q };
}

/**
 * Build CQT frequency-domain filter bank.
 * Same layout as Morlet LUT: lut[binIdx * halfN + freqBin], one f32 per entry.
 * Uses raised cosine (Hann) windows for smooth spectral tiling —
 * adjacent filters sum to ~1.0 at crossover points.
 *
 * @param {Float32Array} frequencies - Center frequencies per bin
 * @param {Float32Array} bandwidths - Bandwidth per bin (f/Q)
 * @param {number} N - Full FFT size
 * @param {number} dt - Sample spacing (1/sampleRate)
 * @returns {Float32Array}
 */
export function buildCQTFilterBank(frequencies, bandwidths, N, dt) {
    const halfN = N / 2;
    const numBins = frequencies.length;
    const lut = new Float32Array(numBins * halfN);

    for (let k = 0; k < numBins; k++) {
        const fCenter = frequencies[k];
        const bw = bandwidths[k];
        const base = k * halfN;

        for (let bin = 0; bin < halfN; bin++) {
            const f = bin / (N * dt); // frequency in Hz
            const dist = Math.abs(f - fCenter);

            if (dist < bw / 2) {
                // Raised cosine (Hann) window: 1.0 at center, 0.0 at edges
                lut[base + bin] = 0.5 * (1 + Math.cos(2 * Math.PI * dist / bw));
            }
            // else: 0 (default Float32Array initialization)
        }
    }
    return lut;
}

// ─── WaveletGPUCompute Class ─────────────────────────────────────────────────

export class WaveletGPUCompute {
    constructor() {
        this.device = null;
        this.fftPipeline = null;
        this.morletPipeline = null;
        this.stretchPipeline = null;
        this.fftBindGroupLayout = null;
        this.morletBindGroupLayout = null;
        this.stretchBindGroupLayout = null;
        this.initialized = false;
        this.ownsDevice = false;
        this.maxOutputBytes = 0;

        // Cached CWT state (persists across stretch factor changes)
        this.cachedCwtBuffer = null;
        this.cachedSignalLength = 0;
        this.cachedNumScales = 0;
        this.cachedDt = 0;
        this.cachedDj = 0;
        this.cachedW0 = 0;
        this.cachedScales = null;

        // Reusable GPU buffers
        this.fftUniformBuffer = null;
        this.morletUniformBuffer = null;
        this.stretchUniformBuffer = null;
    }

    static isSupported() {
        return typeof navigator !== 'undefined' && !!navigator.gpu;
    }

    /**
     * Initialize GPU pipelines. Accepts shared device from WebGPU renderer.
     */
    async initialize(externalDevice = null) {
        if (this.initialized) return;

        if (externalDevice) {
            this.device = externalDevice;
            this.ownsDevice = false;
        }

        if (!this.device) {
            const adapter = await navigator.gpu.requestAdapter({
                powerPreference: 'high-performance'
            });
            if (!adapter) throw new Error('No WebGPU adapter available');

            const maxStorage = adapter.limits.maxStorageBufferBindingSize;
            const maxBuffer = adapter.limits.maxBufferSize;

            this.device = await adapter.requestDevice({
                requiredLimits: {
                    maxComputeWorkgroupSizeX: 256,
                    maxComputeInvocationsPerWorkgroup: 256,
                    maxStorageBufferBindingSize: maxStorage,
                    maxBufferSize: maxBuffer,
                }
            });
            this.ownsDevice = true;
        }

        const limits = this.device.limits;
        this.maxOutputBytes = Math.min(
            limits.maxStorageBufferBindingSize,
            limits.maxBufferSize,
            1024 * 1024 * 1024 // 1GB cap
        );

        this.device.lost.then((info) => {
            console.warn(`[Wavelet GPU] Device lost: ${info.message}`);
            this.initialized = false;
        });

        // ── Compile FFT stage shader ──
        const fftModule = this.device.createShaderModule({
            code: FFT_STAGE_SHADER,
            label: 'fft-stage'
        });
        const fftInfo = await fftModule.getCompilationInfo();
        for (const msg of fftInfo.messages) {
            if (msg.type === 'error') throw new Error(`FFT WGSL error: ${msg.message} (line ${msg.lineNum})`);
            if (msg.type === 'warning') console.warn(`[Wavelet GPU] FFT WGSL warning: ${msg.message}`);
        }

        // ── Compile Morlet multiply shader ──
        const morletModule = this.device.createShaderModule({
            code: MORLET_MUL_SHADER,
            label: 'morlet-multiply'
        });
        const morletInfo = await morletModule.getCompilationInfo();
        for (const msg of morletInfo.messages) {
            if (msg.type === 'error') throw new Error(`Morlet WGSL error: ${msg.message} (line ${msg.lineNum})`);
            if (msg.type === 'warning') console.warn(`[Wavelet GPU] Morlet WGSL warning: ${msg.message}`);
        }

        // ── Compile Stretch shader ──
        const stretchModule = this.device.createShaderModule({
            code: STRETCH_WGSL_SHADER,
            label: 'phase-vocoder-stretch'
        });
        const stretchInfo = await stretchModule.getCompilationInfo();
        for (const msg of stretchInfo.messages) {
            if (msg.type === 'error') throw new Error(`Stretch WGSL error: ${msg.message} (line ${msg.lineNum})`);
            if (msg.type === 'warning') console.warn(`[Wavelet GPU] Stretch WGSL warning: ${msg.message}`);
        }

        // ── FFT bind group layout ──
        this.fftBindGroupLayout = this.device.createBindGroupLayout({
            label: 'fft-bind-group-layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
            ]
        });

        this.fftPipeline = await this.device.createComputePipelineAsync({
            label: 'fft-pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.fftBindGroupLayout] }),
            compute: { module: fftModule, entryPoint: 'fft_stage' }
        });

        // ── Morlet bind group layout ──
        this.morletBindGroupLayout = this.device.createBindGroupLayout({
            label: 'morlet-bind-group-layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
            ]
        });

        this.morletPipeline = await this.device.createComputePipelineAsync({
            label: 'morlet-pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.morletBindGroupLayout] }),
            compute: { module: morletModule, entryPoint: 'morlet_mul' }
        });

        // ── Stretch bind group layout ──
        this.stretchBindGroupLayout = this.device.createBindGroupLayout({
            label: 'stretch-bind-group-layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            ]
        });

        this.stretchPipeline = await this.device.createComputePipelineAsync({
            label: 'stretch-pipeline',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.stretchBindGroupLayout] }),
            compute: { module: stretchModule, entryPoint: 'stretch_main' }
        });

        // ── Uniform buffers (persistent, rewritten each stage) ──
        this.fftUniformBuffer = this.device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: 'fft-params'
        });

        this.morletUniformBuffer = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: 'morlet-params'
        });

        this.stretchUniformBuffer = this.device.createBuffer({
            size: 48,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            label: 'stretch-params'
        });

        this.initialized = true;

        if (!isStudyMode()) {
            console.log(
                `%c[Wavelet GPU] Initialized (${this.ownsDevice ? 'own' : 'shared'} device, ` +
                `${(this.maxOutputBytes / 1024 / 1024).toFixed(0)}MB max buffer)`,
                'color: #E040FB; font-weight: bold'
            );
        }
    }

    /**
     * Run multi-pass Stockham FFT on GPU.
     * Each stage is a separate submit to ensure memory ordering.
     *
     * @param {GPUBuffer} bufA - first ping-pong buffer (complex f32 pairs)
     * @param {GPUBuffer} bufB - second ping-pong buffer
     * @param {number} N - FFT size (power of 2)
     * @param {number} direction - -1.0 for forward, 1.0 for inverse
     * @param {number} numSlices - 1 for single FFT, numScales for batched
     * @returns {GPUBuffer} whichever buffer contains the result
     */
    async runFFT(bufA, bufB, N, direction, numSlices) {
        const logN = Math.round(Math.log2(N));
        const halfN = N / 2;
        const wgX = Math.ceil(halfN / WORKGROUP_SIZE);

        // Pre-create bind groups for both ping-pong directions
        const bgAB = this.device.createBindGroup({
            layout: this.fftBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: bufA } },
                { binding: 1, resource: { buffer: bufB } },
                { binding: 2, resource: { buffer: this.fftUniformBuffer } },
            ]
        });
        const bgBA = this.device.createBindGroup({
            layout: this.fftBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: bufB } },
                { binding: 1, resource: { buffer: bufA } },
                { binding: 2, resource: { buffer: this.fftUniformBuffer } },
            ]
        });

        for (let stage = 0; stage < logN; stage++) {
            const isLast = (stage === logN - 1);

            // Write uniforms for this stage
            const params = new ArrayBuffer(32);
            const u32 = new Uint32Array(params);
            const f32 = new Float32Array(params);
            u32[0] = halfN;                                      // halfN
            u32[1] = stage;                                      // stage
            f32[2] = direction;                                   // direction
            u32[3] = (direction > 0 && isLast) ? 1 : 0;         // applyNorm
            f32[4] = 1.0 / N;                                    // invN
            u32[5] = numSlices;                                   // numSlices
            u32[6] = N;                                           // N
            u32[7] = 0;                                           // pad
            this.device.queue.writeBuffer(this.fftUniformBuffer, 0, new Uint8Array(params));

            const encoder = this.device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(this.fftPipeline);
            pass.setBindGroup(0, (stage % 2 === 0) ? bgAB : bgBA);
            pass.dispatchWorkgroups(wgX, numSlices);
            pass.end();
            this.device.queue.submit([encoder.finish()]);
        }

        // Result is in bufB if logN is odd, bufA if logN is even
        return (logN % 2 === 0) ? bufA : bufB;
    }

    /**
     * Pass 1: Compute the forward CWT.
     * Full-signal FFT → per-scale Morlet multiply → batched inverse FFT.
     * Result stays on GPU (cachedCwtBuffer). Only re-run when audio changes.
     *
     * @param {Float32Array} audioData - Input audio samples
     * @param {object} params - { dt, w0, dj }
     * @returns {object} { numScales, signalLength, scales }
     */
    async computeCWT(audioData, { dt, w0 = 6, dj = 0.1, transform = 'cwt', binsPerOctave = 12, fMin = 20, minBW = 0 } = {}) {
        if (!this.initialized) throw new Error('WaveletGPUCompute not initialized');

        const t0 = performance.now();
        const signalLength = audioData.length;
        const Npad = nextPowerOf2(signalLength);
        const logN = Math.round(Math.log2(Npad));
        const halfN = Npad / 2;

        // Generate scales/bins and frequency-domain filter LUT
        let scales, morletLUT, numScales, effectiveDj;

        if (transform === 'cqt') {
            const cqt = generateCQTScales(1 / dt, binsPerOctave, fMin, minBW);
            scales = cqt.scales;       // all 1.0 (uniform weight for stretch shader)
            numScales = cqt.numBins;
            morletLUT = buildCQTFilterBank(cqt.frequencies, cqt.bandwidths, Npad, dt);
            // Set dj so that dj * sqrt(dt) / (C_d * psi0) = 1.0 (neutralize CWT normalization)
            effectiveDj = 0.776 * 0.7511255 / Math.sqrt(dt);
        } else {
            scales = generateScales(signalLength, dt, w0, dj);
            numScales = scales.length;
            morletLUT = buildMorletLUT(scales, Npad, dt, w0);
            effectiveDj = dj;
        }

        const tSetup = performance.now();

        // ── Memory budget check ──
        const cwtBufferBytes = numScales * Npad * 2 * 4; // complex f32 per scale
        const totalGpuMB = (cwtBufferBytes * 2 + morletLUT.byteLength + Npad * 8 * 2) / 1024 / 1024;

        if (cwtBufferBytes > this.maxOutputBytes) {
            throw new Error(
                `CWT buffer too large: ${(cwtBufferBytes / 1024 / 1024).toFixed(0)}MB > ` +
                `${(this.maxOutputBytes / 1024 / 1024).toFixed(0)}MB limit. ` +
                `Signal: ${signalLength} samples, Npad: ${Npad}, ${numScales} scales.`
            );
        }

        // ── Upload signal as complex (real + 0i), zero-padded to Npad ──
        const signalComplex = new Float32Array(Npad * 2);
        for (let i = 0; i < signalLength; i++) {
            signalComplex[i * 2] = audioData[i];
            // imag stays 0
        }

        const fftBufA = this.device.createBuffer({
            size: Npad * 2 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: 'fft-buf-a'
        });
        const fftBufB = this.device.createBuffer({
            size: Npad * 2 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: 'fft-buf-b'
        });
        this.device.queue.writeBuffer(fftBufA, 0, signalComplex);

        // ── Upload Morlet LUT ──
        const morletLUTBuffer = this.device.createBuffer({
            size: morletLUT.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: 'morlet-lut'
        });
        this.device.queue.writeBuffer(morletLUTBuffer, 0, morletLUT);

        const tUpload = performance.now();

        // ═══════════════════════════════════════════════════════════════════
        // Step 1: Forward FFT of the full signal (single, Npad-point)
        // ═══════════════════════════════════════════════════════════════════
        const signalFFTBuf = await this.runFFT(fftBufA, fftBufB, Npad, -1.0, 1);
        await this.device.queue.onSubmittedWorkDone();

        const tFwdFFT = performance.now();

        // ═══════════════════════════════════════════════════════════════════
        // Step 2: Morlet multiply — for all (bin, scale) pairs
        // Output: cwtBufA[scale][bin] = signalFFT[bin] × morletLUT[scale][bin]
        // ═══════════════════════════════════════════════════════════════════
        const cwtBufA = this.device.createBuffer({
            size: cwtBufferBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
            label: 'cwt-buf-a'
        });

        // Write morlet uniforms
        const morletParams = new ArrayBuffer(16);
        const mU32 = new Uint32Array(morletParams);
        mU32[0] = Npad;
        mU32[1] = halfN;
        mU32[2] = numScales;
        mU32[3] = 0;
        this.device.queue.writeBuffer(this.morletUniformBuffer, 0, new Uint8Array(morletParams));

        const morletBg = this.device.createBindGroup({
            layout: this.morletBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: signalFFTBuf } },
                { binding: 1, resource: { buffer: morletLUTBuffer } },
                { binding: 2, resource: { buffer: cwtBufA } },
                { binding: 3, resource: { buffer: this.morletUniformBuffer } },
            ]
        });

        {
            const encoder = this.device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(this.morletPipeline);
            pass.setBindGroup(0, morletBg);
            pass.dispatchWorkgroups(Math.ceil(Npad / WORKGROUP_SIZE), numScales);
            pass.end();
            this.device.queue.submit([encoder.finish()]);
            await this.device.queue.onSubmittedWorkDone();
        }

        const tMorlet = performance.now();

        // Free forward FFT buffers — no longer needed
        fftBufA.destroy();
        fftBufB.destroy();
        morletLUTBuffer.destroy();

        // ═══════════════════════════════════════════════════════════════════
        // Step 3: Inverse FFT — batched across all scales
        // Each scale's frequency-domain CWT → time-domain CWT coefficients
        // ═══════════════════════════════════════════════════════════════════
        const cwtBufB = this.device.createBuffer({
            size: cwtBufferBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
            label: 'cwt-buf-b'
        });

        const resultBuf = await this.runFFT(cwtBufA, cwtBufB, Npad, 1.0, numScales);
        await this.device.queue.onSubmittedWorkDone();

        const tInvFFT = performance.now();

        // Keep the result buffer, destroy the other
        if (this.cachedCwtBuffer) this.cachedCwtBuffer.destroy();
        if (resultBuf === cwtBufA) {
            this.cachedCwtBuffer = cwtBufA;
            cwtBufB.destroy();
        } else {
            this.cachedCwtBuffer = cwtBufB;
            cwtBufA.destroy();
        }

        // Cache state for stretch pass
        // Use Npad as signalLength so the stretch shader uses correct buffer stride
        this.cachedSignalLength = Npad;
        this.cachedNumScales = numScales;
        this.cachedDt = dt;
        this.cachedDj = effectiveDj;
        this.cachedW0 = w0;
        this.cachedScales = scales;

        const setupMs = (tSetup - t0).toFixed(1);
        const uploadMs = (tUpload - tSetup).toFixed(1);
        const fwdMs = (tFwdFFT - tUpload).toFixed(1);
        const mulMs = (tMorlet - tFwdFFT).toFixed(1);
        const invMs = (tInvFFT - tMorlet).toFixed(1);
        const totalMs = (tInvFFT - t0).toFixed(1);

        console.log(
            `%c[Wavelet GPU] ${transform.toUpperCase()}: ${numScales} ${transform === 'cqt' ? 'bins' : 'scales'}, Npad=${Npad} (${logN} stages) in ${totalMs}ms ` +
            `(setup: ${setupMs}, upload: ${uploadMs}, fwdFFT: ${fwdMs}, morlet: ${mulMs}, invFFT: ${invMs}ms) ` +
            `[${(cwtBufferBytes / 1024 / 1024).toFixed(1)}MB coefficients, ~${totalGpuMB.toFixed(0)}MB peak GPU]`,
            'color: #E040FB; font-weight: bold'
        );

        return { numScales, signalLength: Npad, scales };
    }

    /**
     * Pass 2: Phase vocoder stretch + ICWT.
     * Uses cached CWT coefficients from Pass 1.
     * Fast path: re-run when stretch factor changes (~1-5ms).
     *
     * @param {number} stretchFactor - Time stretch ratio (e.g., 2.0 for 2x slower)
     * @param {object} [options]
     * @param {number} [options.phaseRand=0] - Phase randomization (0=vocoder, 1=full random)
     * @returns {Float32Array} Stretched audio samples
     */
    async stretchAudio(stretchFactor, { phaseRand = 0, interpMode = 0 } = {}) {
        if (!this.cachedCwtBuffer) throw new Error('No cached CWT — call computeCWT first');

        const t0 = performance.now();
        const outputLength = Math.round(this.cachedSignalLength * stretchFactor);

        // Write stretch uniforms (48 bytes: 8 f32/u32 fields + interpMode + 3 padding)
        const uniforms = new ArrayBuffer(48);
        const f32View = new Float32Array(uniforms);
        const u32View = new Uint32Array(uniforms);
        f32View[0] = stretchFactor;
        u32View[1] = this.cachedSignalLength;
        u32View[2] = outputLength;
        u32View[3] = this.cachedNumScales;
        f32View[4] = this.cachedDj;
        f32View[5] = this.cachedDt;
        f32View[6] = this.cachedW0;
        f32View[7] = phaseRand;
        u32View[8] = interpMode;  // 0 = cubic, 1 = linear
        // [9..11] = padding
        this.device.queue.writeBuffer(this.stretchUniformBuffer, 0, new Uint8Array(uniforms));

        // Upload scales array
        const scalesBuffer = this.device.createBuffer({
            size: this.cachedScales.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: 'stretch-scales'
        });
        this.device.queue.writeBuffer(scalesBuffer, 0, this.cachedScales);

        // Output buffer
        const outputBytes = outputLength * 4;
        const outputBuffer = this.device.createBuffer({
            size: outputBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
            label: 'stretch-output'
        });

        // Staging buffer for readback
        const stagingBuffer = this.device.createBuffer({
            size: outputBytes,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            label: 'stretch-staging'
        });

        const bindGroup = this.device.createBindGroup({
            layout: this.stretchBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.cachedCwtBuffer } },
                { binding: 1, resource: { buffer: outputBuffer } },
                { binding: 2, resource: { buffer: this.stretchUniformBuffer } },
                { binding: 3, resource: { buffer: scalesBuffer } },
            ]
        });

        // Dispatch
        const numWorkgroups = Math.ceil(outputLength / WORKGROUP_SIZE);
        const encoder = this.device.createCommandEncoder({ label: 'stretch-compute' });
        const pass = encoder.beginComputePass({ label: 'phase-vocoder' });
        pass.setPipeline(this.stretchPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(numWorkgroups);
        pass.end();

        encoder.copyBufferToBuffer(outputBuffer, 0, stagingBuffer, 0, outputBytes);
        this.device.queue.submit([encoder.finish()]);

        // Readback
        await stagingBuffer.mapAsync(GPUMapMode.READ);
        const mapped = stagingBuffer.getMappedRange();
        const result = new Float32Array(outputLength);
        result.set(new Float32Array(mapped));
        stagingBuffer.unmap();

        // Cleanup
        outputBuffer.destroy();
        stagingBuffer.destroy();
        scalesBuffer.destroy();

        const totalMs = (performance.now() - t0).toFixed(1);
        console.log(
            `%c[Wavelet GPU] Stretch: ${stretchFactor}x -> ${outputLength.toLocaleString()} samples ` +
            `in ${totalMs}ms (${numWorkgroups} workgroups)`,
            'color: #E040FB; font-weight: bold'
        );

        return result;
    }

    /**
     * CPU phase accumulation stretch — reads back CWT coefficients and does
     * synthesis on CPU. Avoids the harmonic distortion of cos(phase*stretchFactor)
     * by accumulating phase from instantaneous frequency estimates.
     *
     * @param {number} stretchFactor
     * @param {object} [options]
     * @returns {Float32Array}
     */
    async stretchAudioCPU(stretchFactor, { phaseRand = 0 } = {}) {
        if (!this.cachedCwtBuffer) throw new Error('No cached CWT — call computeCWT first');

        const t0 = performance.now();
        const signalLength = this.cachedSignalLength;
        const numScales = this.cachedNumScales;
        const scales = this.cachedScales;
        const dt = this.cachedDt;
        const dj = this.cachedDj;
        const outputLength = Math.round(signalLength * stretchFactor);

        // Read back CWT coefficients from GPU
        const tRead0 = performance.now();
        const cwt = await this.readbackBuffer(this.cachedCwtBuffer);
        const tRead1 = performance.now();

        const output = new Float32Array(outputLength);
        const accPhase = new Float64Array(numScales);

        // Initialize accumulated phase from the first input sample
        for (let si = 0; si < numScales; si++) {
            const base = si * signalLength * 2;
            accPhase[si] = Math.atan2(cwt[base + 1], cwt[base]);
        }

        const C_d = 0.776;
        const psi0 = 0.7511255; // pi^(-0.25)
        const icwtScale = dj * Math.sqrt(dt) / (C_d * psi0);
        const TWO_PI = 2 * Math.PI;
        const maxIdx = signalLength - 1;

        for (let m = 0; m < outputLength; m++) {
            const inputPos = m / stretchFactor;
            const idx = Math.min(Math.floor(inputPos), maxIdx);
            const frac = inputPos - idx;
            const i0 = Math.min(idx, maxIdx);
            const i1 = Math.min(idx + 1, maxIdx);

            let sample = 0;

            for (let si = 0; si < numScales; si++) {
                const base = si * signalLength * 2;

                // Read two adjacent complex CWT coefficients
                const re0 = cwt[base + i0 * 2];
                const im0 = cwt[base + i0 * 2 + 1];
                const re1 = cwt[base + i1 * 2];
                const im1 = cwt[base + i1 * 2 + 1];

                // Interpolated magnitude
                const mag0 = Math.sqrt(re0 * re0 + im0 * im0);
                const mag1 = Math.sqrt(re1 * re1 + im1 * im1);
                const mag = mag0 + frac * (mag1 - mag0);

                // Instantaneous frequency: unwrapped phase difference between adjacent samples
                const phase0 = Math.atan2(im0, re0);
                const phase1 = Math.atan2(im1, re1);
                let dPhase = phase1 - phase0;
                dPhase -= Math.round(dPhase / TWO_PI) * TWO_PI; // unwrap

                // Accumulate phase at the local instantaneous rate
                // (no multiply by stretchFactor — that's the whole point)
                accPhase[si] += dPhase;

                const scaleWeight = 1.0 / Math.sqrt(scales[si]);
                sample += scaleWeight * mag * Math.cos(accPhase[si]);
            }

            output[m] = sample * icwtScale;
        }

        const totalMs = (performance.now() - t0).toFixed(1);
        const readMs = (tRead1 - tRead0).toFixed(1);
        console.log(
            `%c[Wavelet CPU] Phase accumulation stretch: ${stretchFactor}x -> ` +
            `${outputLength.toLocaleString()} samples in ${totalMs}ms ` +
            `(readback: ${readMs}ms, compute: ${(performance.now() - tRead1).toFixed(1)}ms)`,
            'color: #4CAF50; font-weight: bold'
        );

        return output;
    }

    /**
     * Convenience: full pipeline (CWT + stretch) in one call.
     */
    async waveletStretch(audioData, stretchFactor, params) {
        await this.computeCWT(audioData, params);
        if (params.phaseMode === 'accumulate') {
            return this.stretchAudioCPU(stretchFactor, { phaseRand: params.phaseRand || 0 });
        }
        return this.stretchAudio(stretchFactor, {
            phaseRand: params.phaseRand || 0,
            interpMode: params.interpMode || 0
        });
    }

    /**
     * Auto-calculate the largest chunk size (power of 2) that fits in GPU memory.
     * Accounts for: 2× CWT ping-pong buffers + Morlet LUT + FFT working buffers.
     */
    calculateMaxChunkSamples(dt, w0 = 6, dj = 0.1, transform = 'cwt', binsPerOctave = 12, fMin = 20, minBW = 0) {
        // Reserve 1/3 of max buffer for headroom (ping-pong needs 2× CWT buffer)
        const targetCwtBytes = Math.floor(this.maxOutputBytes / 3);
        let bestNpad = 1024; // minimum

        // Binary search: find largest power of 2 that fits
        for (let logN = 10; logN <= 24; logN++) {
            const npad = 1 << logN;
            const numBins = transform === 'cqt'
                ? generateCQTScales(1 / dt, binsPerOctave, fMin, minBW).numBins
                : generateScales(npad, dt, w0, dj).length;
            const cwtBytes = numBins * npad * 2 * 4;
            if (cwtBytes <= targetCwtBytes) {
                bestNpad = npad;
            } else {
                break;
            }
        }
        return bestNpad;
    }

    /**
     * Chunked overlap-add wavelet stretch for arbitrarily long audio.
     * Splits audio into overlapping chunks, CWT+stretches each, crossfades output.
     *
     * @param {Float32Array} audioData - Input audio samples (mono)
     * @param {number} stretchFactor - Time stretch ratio (e.g., 2.0)
     * @param {object} params
     * @param {number} params.dt - Sample spacing (1/sampleRate)
     * @param {number} [params.w0=6] - Morlet frequency parameter
     * @param {number} [params.dj=0.1] - Scale spacing
     * @param {number} [params.maxChunkSamples] - Max samples per chunk (auto-calculated if omitted)
     * @param {number} [params.overlapSamples] - Overlap between chunks (default: 0.5s)
     * @param {function} [params.onChunkDone] - Progress callback(chunkIdx, numChunks, elapsedMs)
     * @returns {Float32Array} Stretched audio
     */
    async waveletStretchChunked(audioData, stretchFactor, {
        dt, w0 = 6, dj = 0.1,
        transform = 'cwt', binsPerOctave = 12, fMin = 20, minBW = 0,
        phaseRand = 0,
        interpMode = 0,
        phaseMode = 'multiply',
        maxChunkSamples,
        overlapSamples,
        onChunkDone
    } = {}) {
        if (!this.initialized) throw new Error('WaveletGPUCompute not initialized');

        const t0 = performance.now();

        // Auto-calculate chunk size if not provided
        if (!maxChunkSamples) {
            maxChunkSamples = this.calculateMaxChunkSamples(dt, w0, dj, transform, binsPerOctave, fMin, minBW);
        }

        // Default overlap: 0.5 seconds
        if (!overlapSamples) {
            overlapSamples = Math.round(0.5 / dt);
        }

        // If signal fits in one chunk, use the fast path
        if (audioData.length <= maxChunkSamples) {
            const result = await this.waveletStretch(audioData, stretchFactor, { dt, w0, dj, transform, binsPerOctave, fMin, minBW, phaseRand, interpMode, phaseMode });
            // Trim to exact expected output length (remove padding)
            const expectedLen = Math.round(audioData.length * stretchFactor);
            if (onChunkDone) onChunkDone(0, 1, performance.now() - t0);
            return result.subarray(0, Math.min(expectedLen, result.length));
        }

        const stride = maxChunkSamples - overlapSamples;
        const numChunks = Math.ceil((audioData.length - overlapSamples) / stride);
        const totalOutputLen = Math.round(audioData.length * stretchFactor);
        const output = new Float32Array(totalOutputLen);
        const outputOverlap = Math.round(overlapSamples * stretchFactor);

        if (!isStudyMode()) {
            console.log(
                `%c[Wavelet GPU] Chunked stretch: ${numChunks} chunks, ` +
                `${maxChunkSamples.toLocaleString()} samples/chunk, ` +
                `${overlapSamples.toLocaleString()} overlap`,
                'color: #E040FB; font-weight: bold'
            );
        }

        for (let ci = 0; ci < numChunks; ci++) {
            const inputStart = ci * stride;
            const inputEnd = Math.min(inputStart + maxChunkSamples, audioData.length);
            const chunk = audioData.subarray(inputStart, inputEnd);

            // CWT + stretch this chunk
            await this.computeCWT(chunk, { dt, w0, dj, transform, binsPerOctave, fMin, minBW });
            const stretched = phaseMode === 'accumulate'
                ? await this.stretchAudioCPU(stretchFactor, { phaseRand })
                : await this.stretchAudio(stretchFactor, { phaseRand, interpMode });

            // Trim stretched output to match actual chunk duration (not padding)
            const chunkOutputLen = Math.round(chunk.length * stretchFactor);
            const outputStart = Math.round(inputStart * stretchFactor);

            for (let j = 0; j < chunkOutputLen && j < stretched.length; j++) {
                const outIdx = outputStart + j;
                if (outIdx >= totalOutputLen) break;

                const sample = stretched[j];
                // Skip NaN/Inf from GPU edge artifacts
                if (!isFinite(sample)) continue;

                if (ci > 0 && j < outputOverlap) {
                    // Crossfade: raised cosine (Hann) window
                    const fade = 0.5 * (1 - Math.cos(Math.PI * j / outputOverlap));
                    output[outIdx] = output[outIdx] * (1 - fade) + sample * fade;
                } else {
                    output[outIdx] = sample;
                }
            }

            if (onChunkDone) onChunkDone(ci, numChunks, performance.now() - t0);
        }

        const totalMs = (performance.now() - t0).toFixed(1);
        if (!isStudyMode()) {
            const speedup = (audioData.length / (1/dt)) / (parseFloat(totalMs) / 1000);
            console.log(
                `%c[Wavelet GPU] Chunked stretch complete: ${totalMs}ms ` +
                `(${speedup.toFixed(1)}x realtime)`,
                'color: #E040FB; font-weight: bold'
            );
        }

        return output;
    }

    /**
     * Read back a GPU buffer to CPU (for diagnostics).
     * @param {GPUBuffer} buffer
     * @param {number} [byteLength] - If omitted, reads entire buffer
     * @returns {Float32Array}
     */
    async readbackBuffer(buffer, byteLength) {
        const size = byteLength || buffer.size;
        const staging = this.device.createBuffer({
            size,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
            label: 'diag-staging'
        });
        const encoder = this.device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffer, 0, staging, 0, size);
        this.device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const result = new Float32Array(staging.getMappedRange().slice(0));
        staging.unmap();
        staging.destroy();
        return result;
    }

    /**
     * Diagnostic version of computeCWT that captures intermediate buffers.
     * Returns everything needed to validate the pipeline stage by stage.
     */
    async computeCWT_diagnostic(audioData, { dt, w0 = 6, dj = 0.1, transform = 'cwt', binsPerOctave = 12, fMin = 20, minBW = 0 } = {}) {
        if (!this.initialized) throw new Error('WaveletGPUCompute not initialized');

        const diag = {}; // diagnostic output
        const signalLength = audioData.length;
        const Npad = nextPowerOf2(signalLength);
        const logN = Math.round(Math.log2(Npad));
        const halfN = Npad / 2;

        let scales, morletLUT, numScales, effectiveDj;

        if (transform === 'cqt') {
            const cqt = generateCQTScales(1 / dt, binsPerOctave, fMin, minBW);
            scales = cqt.scales;
            numScales = cqt.numBins;
            morletLUT = buildCQTFilterBank(cqt.frequencies, cqt.bandwidths, Npad, dt);
            effectiveDj = 0.776 * 0.7511255 / Math.sqrt(dt);
        } else {
            scales = generateScales(signalLength, dt, w0, dj);
            numScales = scales.length;
            morletLUT = buildMorletLUT(scales, Npad, dt, w0);
            effectiveDj = dj;
        }

        diag.Npad = Npad;
        diag.logN = logN;
        diag.numScales = numScales;
        diag.scales = scales;
        diag.morletLUT = morletLUT;
        diag.halfN = halfN;
        diag.dt = dt;
        diag.w0 = w0;

        const cwtBufferBytes = numScales * Npad * 2 * 4;

        // Upload signal
        const signalComplex = new Float32Array(Npad * 2);
        for (let i = 0; i < signalLength; i++) {
            signalComplex[i * 2] = audioData[i];
        }
        diag.signalComplex = signalComplex;

        const fftBufA = this.device.createBuffer({
            size: Npad * 2 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
            label: 'fft-buf-a'
        });
        const fftBufB = this.device.createBuffer({
            size: Npad * 2 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
            label: 'fft-buf-b'
        });
        this.device.queue.writeBuffer(fftBufA, 0, signalComplex);

        // Morlet LUT
        const morletLUTBuffer = this.device.createBuffer({
            size: morletLUT.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            label: 'morlet-lut'
        });
        this.device.queue.writeBuffer(morletLUTBuffer, 0, morletLUT);

        // Step 1: Forward FFT
        const signalFFTBuf = await this.runFFT(fftBufA, fftBufB, Npad, -1.0, 1);
        await this.device.queue.onSubmittedWorkDone();

        // DIAGNOSTIC: Read back FFT result
        diag.signalFFT = await this.readbackBuffer(signalFFTBuf);

        // Step 2: Morlet multiply
        const cwtBufA = this.device.createBuffer({
            size: cwtBufferBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
            label: 'cwt-buf-a'
        });

        const morletParams = new ArrayBuffer(16);
        const mU32 = new Uint32Array(morletParams);
        mU32[0] = Npad;
        mU32[1] = halfN;
        mU32[2] = numScales;
        mU32[3] = 0;
        this.device.queue.writeBuffer(this.morletUniformBuffer, 0, new Uint8Array(morletParams));

        const morletBg = this.device.createBindGroup({
            layout: this.morletBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: signalFFTBuf } },
                { binding: 1, resource: { buffer: morletLUTBuffer } },
                { binding: 2, resource: { buffer: cwtBufA } },
                { binding: 3, resource: { buffer: this.morletUniformBuffer } },
            ]
        });

        {
            const encoder = this.device.createCommandEncoder();
            const pass = encoder.beginComputePass();
            pass.setPipeline(this.morletPipeline);
            pass.setBindGroup(0, morletBg);
            pass.dispatchWorkgroups(Math.ceil(Npad / WORKGROUP_SIZE), numScales);
            pass.end();
            this.device.queue.submit([encoder.finish()]);
            await this.device.queue.onSubmittedWorkDone();
        }

        // DIAGNOSTIC: Read back Morlet multiply result (freq domain CWT, per scale)
        diag.cwtFreqDomain = await this.readbackBuffer(cwtBufA);

        fftBufA.destroy();
        fftBufB.destroy();
        morletLUTBuffer.destroy();

        // Step 3: Inverse FFT (batched)
        const cwtBufB = this.device.createBuffer({
            size: cwtBufferBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
            label: 'cwt-buf-b'
        });

        const resultBuf = await this.runFFT(cwtBufA, cwtBufB, Npad, 1.0, numScales);
        await this.device.queue.onSubmittedWorkDone();

        // DIAGNOSTIC: Read back CWT time-domain coefficients
        diag.cwtTimeDomain = await this.readbackBuffer(resultBuf);

        // Cache for stretch
        if (this.cachedCwtBuffer) this.cachedCwtBuffer.destroy();
        if (resultBuf === cwtBufA) {
            this.cachedCwtBuffer = cwtBufA;
            cwtBufB.destroy();
        } else {
            this.cachedCwtBuffer = cwtBufB;
            cwtBufA.destroy();
        }

        this.cachedSignalLength = Npad;
        this.cachedNumScales = numScales;
        this.cachedDt = dt;
        this.cachedDj = effectiveDj;
        this.cachedW0 = w0;
        this.cachedScales = scales;

        return diag;
    }

    /**
     * Normalize stretched audio to [-1, 1] range.
     */
    static normalize(audio) {
        let peak = 0;
        for (let i = 0; i < audio.length; i++) {
            const abs = Math.abs(audio[i]);
            if (abs > peak) peak = abs;
        }
        if (peak > 0) {
            const invPeak = 1.0 / peak;
            for (let i = 0; i < audio.length; i++) {
                audio[i] *= invPeak;
            }
        }
        return audio;
    }

    terminate() {
        if (this.cachedCwtBuffer) { this.cachedCwtBuffer.destroy(); this.cachedCwtBuffer = null; }
        if (this.fftUniformBuffer) { this.fftUniformBuffer.destroy(); this.fftUniformBuffer = null; }
        if (this.morletUniformBuffer) { this.morletUniformBuffer.destroy(); this.morletUniformBuffer = null; }
        if (this.stretchUniformBuffer) { this.stretchUniformBuffer.destroy(); this.stretchUniformBuffer = null; }

        if (this.device && this.ownsDevice) this.device.destroy();
        this.device = null;
        this.initialized = false;

        if (!isStudyMode()) {
            console.log('[Wavelet GPU] Terminated');
        }
    }

    async cleanup() {
        this.terminate();
    }
}
