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

// ─── WGSL Compute Shader (inline) ───────────────────────────────────────────
// Stockham autosort FFT: ping-pong between two shared memory arrays.
// 2D dispatch: workgroup_id.x = time slice within tile, workgroup_id.y = tile index.
// 256 threads per workgroup. 2048-point FFT: 11 butterfly stages, 8 elements/thread.

const FFT_WGSL_SHADER = /* wgsl */ `

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
// 2048 complex values = 4096 f32 each = 32768 bytes total
var<workgroup> sA: array<f32, 4096>;
var<workgroup> sB: array<f32, 4096>;

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
            // Check if shared device has sufficient compute limits for our FFT shader
            const neededWorkgroupStorage = 32768;
            if (externalDevice.limits.maxComputeWorkgroupStorageSize >= neededWorkgroupStorage) {
                // Use shared device from WebGPU renderer (same GPUDevice for compute + render)
                this.device = externalDevice;
                this.ownsDevice = false;
                const limits = this.device.limits;
                this.maxOutputBytes = Math.min(
                    limits.maxStorageBufferBindingSize,
                    limits.maxBufferSize,
                    256 * 1024 * 1024
                );
            } else {
                console.warn(`[GPU Compute] Shared device has insufficient workgroup storage ` +
                    `(${externalDevice.limits.maxComputeWorkgroupStorageSize} < ${neededWorkgroupStorage}), creating own device`);
                externalDevice = null; // fall through to create own device
            }
        }
        if (!externalDevice) {
            const adapter = await navigator.gpu.requestAdapter({
                powerPreference: 'high-performance'
            });
            if (!adapter) {
                throw new Error('No WebGPU adapter available');
            }

            // Stockham FFT needs two shared arrays for ping-pong: 2 × 4096 f32 = 32768 bytes
            const neededWorkgroupStorage = 32768;
            if (adapter.limits.maxComputeWorkgroupStorageSize < neededWorkgroupStorage) {
                throw new Error(`GPU workgroup storage too small: ${adapter.limits.maxComputeWorkgroupStorageSize} < ${neededWorkgroupStorage} bytes needed`);
            }

            // Request adapter's max buffer limits (defaults are 128MB binding / 256MB buffer)
            const maxStorage = adapter.limits.maxStorageBufferBindingSize;
            const maxBuffer = adapter.limits.maxBufferSize;

            this.device = await adapter.requestDevice({
                requiredLimits: {
                    maxComputeWorkgroupSizeX: 256,
                    maxComputeInvocationsPerWorkgroup: 256,
                    maxComputeWorkgroupStorageSize: neededWorkgroupStorage,
                    maxStorageBufferBindingSize: maxStorage,
                    maxBufferSize: maxBuffer,
                }
            });
            this.ownsDevice = true;

            // Batch sizing: use device limits but cap at 256MB for staging buffer practicality
            this.maxOutputBytes = Math.min(maxStorage, maxBuffer, 256 * 1024 * 1024);
        }

        this.device.lost.then((info) => {
            console.warn(`[GPU Compute] Device lost: ${info.message}`);
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
            if (message.type === 'warning') {
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

        if (!isStudyMode()) {
            if (externalDevice) {
                console.log(
                    `%c[GPU Compute] Initialized (shared device from renderer)`,
                    'color: #4CAF50; font-weight: bold'
                );
            } else {
                const adapterInfo = await adapter.requestAdapterInfo();
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
        const { fftSize, exactHop, dbFloor, dbRange, hannWindow } = tiles[0];
        const freqBins = fftSize / 2;
        const logStages = Math.log2(fftSize);
        const numSlices = tiles[0].numTimeSlices;

        // Upload Hann window once (or when FFT size changes)
        if (!this.hannUploaded || this.lastFftSize !== fftSize) {
            if (this.hannBuffer) this.hannBuffer.destroy();
            this.hannBuffer = this.device.createBuffer({
                size: hannWindow.byteLength,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                label: 'hann-window'
            });
            this.device.queue.writeBuffer(this.hannBuffer, 0, hannWindow);
            this.hannUploaded = true;
            this.lastFftSize = fftSize;
        }

        // Write uniforms (shared across all tiles in batch)
        const uniforms = new Uint32Array(8);
        const uniformsF32 = new Float32Array(uniforms.buffer);
        uniforms[0] = fftSize;
        uniformsF32[1] = exactHop;
        uniforms[2] = numSlices;
        uniforms[3] = freqBins;
        uniformsF32[4] = dbFloor;
        uniformsF32[5] = dbRange;
        uniformsF32[6] = 1.0 / fftSize;
        uniforms[7] = logStages;
        this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

        // Split tiles into batches that fit within GPU buffer limits
        const outputPerTile = numSlices * freqBins; // 1 byte per value (packed in shader)
        const maxTilesPerBatch = Math.max(1, Math.floor(this.maxOutputBytes / outputPerTile));

        for (let batchStart = 0; batchStart < tiles.length; batchStart += maxTilesPerBatch) {
            if (signal?.aborted) return;

            const batchEnd = Math.min(batchStart + maxTilesPerBatch, tiles.length);
            const batchTiles = tiles.slice(batchStart, batchEnd);
            const numTiles = batchTiles.length;

            await this._processBatch(batchTiles, numTiles, numSlices, freqBins, onTileComplete, signal);
        }

        // Always log total (need this data!)
        const elapsed = (performance.now() - t0).toFixed(1);
        const numBatches = Math.ceil(tiles.length / maxTilesPerBatch);
        console.log(
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
        console.log(
            `%c  [GPU batch] ${numTiles} tiles: ` +
            `${concatMs}ms concat (${audioMB}MB) + ` +
            `${uploadMs}ms upload + ` +
            `${gpuMs}ms GPU (${numTiles}×${numSlices} FFTs) + ` +
            `${splitMs}ms copy-out (${outputMB}MB packed)`,
            'color: #9C27B0'
        );
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

        const { fftSize, exactHop, dbFloor, dbRange, hannWindow } = tiles[0];
        const freqBins = fftSize / 2;
        const logStages = Math.log2(fftSize);
        const numSlices = tiles[0].numTimeSlices;

        // Upload Hann window once (or when FFT size changes)
        if (!this.hannUploaded || this.lastFftSize !== fftSize) {
            if (this.hannBuffer) this.hannBuffer.destroy();
            this.hannBuffer = this.device.createBuffer({
                size: hannWindow.byteLength,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
                label: 'hann-window'
            });
            this.device.queue.writeBuffer(this.hannBuffer, 0, hannWindow);
            this.hannUploaded = true;
            this.lastFftSize = fftSize;
        }

        // Write uniforms
        const uniforms = new Uint32Array(8);
        const uniformsF32 = new Float32Array(uniforms.buffer);
        uniforms[0] = fftSize;
        uniformsF32[1] = exactHop;
        uniforms[2] = numSlices;
        uniforms[3] = freqBins;
        uniformsF32[4] = dbFloor;
        uniformsF32[5] = dbRange;
        uniformsF32[6] = 1.0 / fftSize;
        uniforms[7] = logStages;
        this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

        // Split into batches that fit GPU limits
        const outputPerTile = numSlices * freqBins;
        const maxTilesPerBatch = Math.max(1, Math.floor(this.maxOutputBytes / outputPerTile));

        const allGpuDonePromises = [];
        const batchEncodeTimes = [];
        let batchCount = 0;

        const numBatches = Math.ceil(tiles.length / maxTilesPerBatch);
        console.log(
            `%c[GPU Zero-Copy] ${tiles.length} tiles → ${numBatches} batches (${maxTilesPerBatch}/batch)`,
            'color: #FF9800; font-weight: bold'
        );

        for (let batchStart = 0; batchStart < tiles.length; batchStart += maxTilesPerBatch) {
            if (signal?.aborted) return;

            const batchEnd = Math.min(batchStart + maxTilesPerBatch, tiles.length);
            const batchTiles = tiles.slice(batchStart, batchEnd);

            const { gpuDonePromise, encodeMs } = this._processBatchZeroCopy(
                batchTiles, batchTiles.length, numSlices, freqBins, onTileGPUTexture, signal
            );
            if (onBatchGPUDone) {
                gpuDonePromise.then(() => onBatchGPUDone(batchCount));
            }
            allGpuDonePromises.push(gpuDonePromise);
            batchEncodeTimes.push(encodeMs);
            batchCount++;
        }

        const submitElapsed = (performance.now() - t0).toFixed(1);
        const totalEncodeMs = batchEncodeTimes.reduce((a, b) => a + b, 0).toFixed(1);
        console.log(
            `%c[GPU Zero-Copy] All ${batchCount} batches submitted in ${submitElapsed}ms ` +
            `(encode: ${totalEncodeMs}ms) — GPUTextures ready, cascade via GPU render passes`,
            'color: #FF9800; font-weight: bold'
        );

        // Return promise that resolves when GPU finishes ALL batches
        return Promise.all(allGpuDonePromises).then(gpuTimes => {
            const maxGpu = Math.max(...gpuTimes).toFixed(1);
            const minGpu = Math.min(...gpuTimes).toFixed(1);
            console.log(
                `%c[GPU Zero-Copy] GPU compute done: ${maxGpu}ms (range: ${minGpu}–${maxGpu}ms across ${batchCount} batches)`,
                'color: #E91E63; font-weight: bold'
            );
        });
    }

    /**
     * Zero-copy batch: compute → copyBufferToTexture → GPUTextures ready.
     * No staging buffer, no readback. Cascade built on GPU via render passes.
     */
    _processBatchZeroCopy(batchTiles, numTiles, numSlices, freqBins, onTileGPUTexture, signal) {
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
        if (this.dummyTexture) {
            this.dummyTexture.destroy();
            this.dummyTexture = null;
        }
        this.cascadePipeline = null;
        this.cascadeBindGroupLayout = null;
        if (this.device) {
            if (this.ownsDevice) this.device.destroy();
            this.device = null;
        }
        this.initialized = false;
        this.hannUploaded = false;

        if (!isStudyMode()) {
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
