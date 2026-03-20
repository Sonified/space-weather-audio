#!/usr/bin/env node
/**
 * Process gain curves: load raw .f32 → de-trend → apply gain curve → peak normalize → save as WAV
 *
 * Usage: node process_gain_curves.js
 */

const fs = require('fs');
const path = require('path');

// ============================================================================
// DSP Functions (matching the app's pipeline)
// ============================================================================

/** Forward-backward EMA de-trending (matches minimap-window-renderer.js removeDCOffset) */
function removeDCOffset(data, alpha = 0.999) {
    const n = data.length;
    if (n === 0) return new Float32Array(0);

    const warmup = Math.min(n, Math.ceil(3 / (1 - alpha)));

    let initFwd = 0;
    for (let i = 0; i < warmup; i++) initFwd += data[i];
    initFwd /= warmup;

    let initBwd = 0;
    for (let i = n - warmup; i < n; i++) initBwd += data[i];
    initBwd /= warmup;

    // Forward EMA
    const fwd = new Float32Array(n);
    let mean = initFwd;
    for (let i = 0; i < n; i++) {
        mean = alpha * mean + (1 - alpha) * data[i];
        fwd[i] = mean;
    }

    // Backward EMA
    const bwd = new Float32Array(n);
    mean = initBwd;
    for (let i = n - 1; i >= 0; i--) {
        mean = alpha * mean + (1 - alpha) * data[i];
        bwd[i] = mean;
    }

    // Subtract averaged forward+backward mean
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        y[i] = data[i] - (fwd[i] + bwd[i]) * 0.5;
    }

    // Cosine taper at edges
    const taperLen = Math.min(Math.ceil(n * 0.001), warmup, Math.floor(n / 2));
    for (let i = 0; i < taperLen; i++) {
        const w = 0.5 * (1 - Math.cos(Math.PI * i / taperLen));
        y[i] *= w;
        y[n - 1 - i] *= w;
    }

    return y;
}

/** Peak normalize to [-1, 1] (matches minimap-window-renderer.js normalize()) */
function peakNormalize(arr) {
    let peak = 0;
    for (let i = 0; i < arr.length; i++) {
        const abs = arr[i] < 0 ? -arr[i] : arr[i];
        if (abs > peak) peak = abs;
    }
    if (peak === 0) return new Float32Array(arr.length);
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
        out[i] = arr[i] / peak;
    }
    return out;
}

/** Piecewise linear gain curve (matches spike_review.html applyGainCurve) */
function applyGainCurve(buffer, envelope) {
    const out = new Float32Array(buffer);
    if (envelope.length === 0) return out;

    const pts = [...envelope].sort((a, b) => a.sample - b.sample);
    const totalSamples = buffer.length;

    // Add implicit 0 dB anchors at start/end
    const allPts = [];
    if (pts[0].sample > 0) allPts.push({ sample: 0, dB: 0 });
    allPts.push(...pts);
    if (pts[pts.length - 1].sample < totalSamples - 1) allPts.push({ sample: totalSamples - 1, dB: 0 });

    let cpIdx = 0;
    for (let i = 0; i < out.length; i++) {
        while (cpIdx < allPts.length - 2 && allPts[cpIdx + 1].sample <= i) cpIdx++;

        const p0 = allPts[cpIdx];
        const p1 = allPts[cpIdx + 1];
        const segLen = p1.sample - p0.sample;
        const t = segLen > 0 ? (i - p0.sample) / segLen : 0;
        const dB = p0.dB + t * (p1.dB - p0.dB);

        if (dB !== 0) {
            out[i] *= Math.pow(10, dB / 20);
        }
    }
    return out;
}

/** Write 16-bit PCM mono WAV at 44100 Hz */
function writeWav(filePath, samples, sampleRate) {
    const numSamples = samples.length;
    const bytesPerSample = 2; // 16-bit PCM
    const dataSize = numSamples * bytesPerSample;
    const headerSize = 44;
    const buffer = Buffer.alloc(headerSize + dataSize);

    // RIFF header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(headerSize + dataSize - 8, 4);
    buffer.write('WAVE', 8);

    // fmt chunk
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);           // chunk size
    buffer.writeUInt16LE(1, 20);            // format: PCM
    buffer.writeUInt16LE(1, 22);            // mono
    buffer.writeUInt32LE(sampleRate, 24);   // sample rate
    buffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
    buffer.writeUInt16LE(bytesPerSample, 32); // block align
    buffer.writeUInt16LE(16, 34);           // bits per sample

    // data chunk
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        buffer.writeInt16LE(Math.round(s * 32767), headerSize + i * bytesPerSample);
    }

    fs.writeFileSync(filePath, buffer);
}

function computeRMS(arr) {
    let sum = 0;
    for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
    return Math.sqrt(sum / arr.length);
}

// ============================================================================
// Main
// ============================================================================

const gainCurves = JSON.parse(fs.readFileSync('gain_curves.json', 'utf-8'));
const outputDir = 'stretch_test_audio';
const sampleRate = 44100;

const regions = {
    region1: {
        rawFile: '_recovery/region1_bx_raw.f32',
        label: 'GOES_REGION_1',
        timeRange: '2022-08-17T00-00-00-000Z_2022-08-20T00-00-00-000Z',
    },
    region2: {
        rawFile: '_recovery/region2_bx_raw.f32',
        label: 'GOES_REGION_2',
        timeRange: '2022-01-14T00-00-00-000Z_2022-01-17T00-00-00-000Z',
    },
};

for (const [regionId, config] of Object.entries(regions)) {
    console.log(`\n=== Processing ${regionId} ===`);

    // 1. Load raw data
    const rawBuf = fs.readFileSync(config.rawFile);
    const raw = new Float32Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.length / 4);
    console.log(`  Raw: ${raw.length} samples, RMS=${computeRMS(raw).toFixed(4)}`);

    // Pipeline matches the app: raw → detrend → gain curve → peak normalize
    // (minimap-window-renderer.js: removeDCOffset → normalize)

    // 2. Detrend raw directly (no pre-normalization — app doesn't do it)
    const baseDetrended = removeDCOffset(raw, 0.999);
    console.log(`  De-trended: RMS=${computeRMS(baseDetrended).toFixed(6)}`);

    // 3. Apply gain curve
    const envelope = gainCurves[regionId]?.gainEnvelope || [];
    const gainAdjusted = applyGainCurve(baseDetrended, envelope);
    console.log(`  Gain-adjusted: RMS=${computeRMS(gainAdjusted).toFixed(6)}, ${envelope.length} control points`);

    // 4. Peak normalize (matches app's normalize())
    const normalized = peakNormalize(gainAdjusted);
    console.log(`  Peak-normalized: RMS=${computeRMS(normalized).toFixed(6)}`);

    // 5. Save WAV
    const filename = `${config.label}_GAINCURVED_DN_MAGN-L2-HIRES_G16_Bx_${config.timeRange}.wav`;
    const outPath = path.join(outputDir, filename);
    writeWav(outPath, normalized, sampleRate);
    console.log(`  Saved: ${outPath} (${(fs.statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`);
}

console.log('\nDone!');
