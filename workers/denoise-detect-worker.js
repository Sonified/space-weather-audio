/**
 * denoise-detect-worker.js — Tonality detection in a background Worker
 *
 * Receives audio samples, runs STFT + tonality scoring + accumulation,
 * returns per-frame tone frequencies. Keeps the main thread free.
 *
 * Messages:
 *   IN:  { type: 'detect', samples: Float32Array, sampleRate: number }
 *   OUT: { type: 'result', toneFreqs: Float32Array, toneCounts: Uint8Array, numFrames: number, elapsed: number }
 */

const WIN_SIZE        = 4096;
const HOP             = WIN_SIZE / 4;
const TONALITY_WINDOW = 15;
const TONALITY_THRESH = 10.0;  // 10 dB: 92% real tones, 8% noise (6 dB was 36/64)
const ACCUM_FRAMES    = 6;
const ACCUM_THRESH    = 0.35;
const MAX_TONES       = 8;

function fft(real, imag, n) {
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        while (j & bit) { j ^= bit; bit >>= 1; }
        j ^= bit;
        if (i < j) {
            [real[i], real[j]] = [real[j], real[i]];
            [imag[i], imag[j]] = [imag[j], imag[i]];
        }
    }
    for (let len = 2; len <= n; len *= 2) {
        const ang = -2 * Math.PI / len;
        const wR = Math.cos(ang), wI = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let curR = 1, curI = 0;
            for (let j = 0; j < len / 2; j++) {
                const uR = real[i+j], uI = imag[i+j];
                const vR = real[i+j+len/2]*curR - imag[i+j+len/2]*curI;
                const vI = real[i+j+len/2]*curI + imag[i+j+len/2]*curR;
                real[i+j] = uR+vR; imag[i+j] = uI+vI;
                real[i+j+len/2] = uR-vR; imag[i+j+len/2] = uI-vI;
                const nR = curR*wR - curI*wI; curI = curR*wI + curI*wR; curR = nR;
            }
        }
    }
}

self.onmessage = function(e) {
    if (e.data.type !== 'detect') return;

    const { samples, sampleRate } = e.data;
    const t0 = performance.now();
    const numSamples = samples.length;
    // Samples arrive already DC-removed + normalized from the data loading pipeline

    const numFrames = Math.floor((numSamples - WIN_SIZE) / HOP) + 1;
    const numBins = WIN_SIZE / 2 + 1;

    // Hann window
    const hann = new Float32Array(WIN_SIZE);
    for (let i = 0; i < WIN_SIZE; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / WIN_SIZE));

    // STFT → dB
    const pdb = new Float32Array(numBins * numFrames);
    for (let fi = 0; fi < numFrames; fi++) {
        const off = fi * HOP;
        const real = new Float32Array(WIN_SIZE), imag = new Float32Array(WIN_SIZE);
        for (let i = 0; i < WIN_SIZE; i++) real[i] = (samples[off + i] || 0) * hann[i];
        fft(real, imag, WIN_SIZE);
        for (let b = 0; b < numBins; b++) {
            pdb[b * numFrames + fi] = 20 * Math.log10(Math.sqrt(real[b] * real[b] + imag[b] * imag[b]) + 1e-12);
        }
    }

    // Flatten 1/f
    for (let b = 0; b < numBins; b++) {
        let s = 0;
        const base = b * numFrames;
        for (let f = 0; f < numFrames; f++) s += pdb[base + f];
        const mean = s / numFrames;
        for (let f = 0; f < numFrames; f++) pdb[base + f] -= mean;
    }

    // Tonality
    const tonality = new Float32Array(numBins * numFrames);
    for (let fi = 0; fi < numFrames; fi++) {
        for (let b = 0; b < numBins; b++) {
            const lo = Math.max(0, b - TONALITY_WINDOW);
            const hi = Math.min(numBins, b + TONALITY_WINDOW + 1);
            let sum = 0;
            for (let bb = lo; bb < hi; bb++) sum += pdb[bb * numFrames + fi];
            tonality[b * numFrames + fi] = pdb[b * numFrames + fi] - sum / (hi - lo);
        }
    }

    // Bidirectional accumulation
    const confirmed = new Uint8Array(numBins * numFrames);
    for (let b = 0; b < numBins; b++) {
        for (let fi = 0; fi < numFrames; fi++) {
            const fLo = Math.max(0, fi - ACCUM_FRAMES);
            let fc = 0;
            for (let f = fLo; f <= fi; f++) if (tonality[b * numFrames + f] >= TONALITY_THRESH) fc++;
            const bHi = Math.min(numFrames - 1, fi + ACCUM_FRAMES);
            let bc = 0;
            for (let f = fi; f <= bHi; f++) if (tonality[b * numFrames + f] >= TONALITY_THRESH) bc++;
            if (fc / (fi - fLo + 1) >= ACCUM_THRESH && bc / (bHi - fi + 1) >= ACCUM_THRESH) {
                confirmed[b * numFrames + fi] = 1;
            }
        }
    }

    // Extract top-N per frame
    // Physical constraints: DC (bin 0) is not a tone, Nyquist edge is an artifact,
    // and very low / very high bins are dominated by spectral slope artifacts
    const toneFreqs = new Float32Array(numFrames * MAX_TONES);
    const toneCounts = new Uint8Array(numFrames);
    const hzPerBin = sampleRate / WIN_SIZE;
    const minBin = Math.max(1, Math.ceil(50 / hzPerBin));       // skip below ~50 Hz
    const maxBin = Math.min(numBins - 2, Math.floor(8000 / hzPerBin)); // skip above ~8 kHz
    let totalDetections = 0;

    for (let fi = 0; fi < numFrames; fi++) {
        const candidates = [];
        for (let b = minBin; b <= maxBin; b++) {
            if (confirmed[b * numFrames + fi]) {
                candidates.push({ freq: b * hzPerBin, score: tonality[b * numFrames + fi] });
            }
        }
        candidates.sort((a, b) => b.score - a.score);
        const n = Math.min(candidates.length, MAX_TONES);
        toneCounts[fi] = n;
        for (let k = 0; k < n; k++) {
            toneFreqs[fi * MAX_TONES + k] = candidates[k].freq;
        }
        totalDetections += n;
    }

    // ── Gap filling: sustain confirmed tones through noisy bursts ──────────
    // For each frequency bin that was confirmed, find runs of presence,
    // and fill gaps up to GAP_FILL frames by holding the last known frequency.
    const GAP_FILL = 40;  // ~1 second at hop=1024/44100
    const MIN_RUN = 10;   // minimum consecutive frames to establish a tone

    // Build per-bin presence runs
    for (let b = minBin; b <= maxBin; b++) {
        // Find runs of confirmed frames for this bin
        let runStart = -1;
        let gapStart = -1;
        let inRun = false;
        let runLength = 0;

        for (let fi = 0; fi <= numFrames; fi++) {
            const isConf = fi < numFrames && confirmed[b * numFrames + fi];

            if (isConf && !inRun) {
                // Start of a run
                inRun = true;
                runStart = fi;
                runLength = 1;

                // Fill gap between previous run and this one
                if (gapStart >= 0 && (fi - gapStart) <= GAP_FILL) {
                    const freq = b * hzPerBin;
                    for (let g = gapStart; g < fi; g++) {
                        // Insert this freq if there's room in the tone list
                        const nt = toneCounts[g];
                        if (nt < MAX_TONES) {
                            toneFreqs[g * MAX_TONES + nt] = freq;
                            toneCounts[g] = nt + 1;
                            totalDetections++;
                        }
                    }
                }
            } else if (isConf && inRun) {
                runLength++;
            } else if (!isConf && inRun) {
                // End of a run — only set gap marker if run was long enough
                if (runLength >= MIN_RUN) {
                    gapStart = fi;
                }
                inRun = false;
                runLength = 0;
            }
        }
    }

    const elapsed = performance.now() - t0;

    self.postMessage({
        type: 'result',
        toneFreqs,
        toneCounts,
        numFrames,
        totalDetections,
        elapsed,
    }, [toneFreqs.buffer, toneCounts.buffer]); // Transfer ownership
};
