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

// ── Ridge filter tuning ──────────────────────────────────────────────────────
// Spin tones trace long near-horizontal ridges across the whole fetch window.
// Real data features tend to show up as short isolated blobs. Cluster confirmed
// detections into ridges and reject anything shorter than RIDGE_MIN_EXTENT_FRAC
// of the fetch duration.
const RIDGE_BIN_TOL         = 2;     // merge runs within ±N bins (allows slow drift)
const RIDGE_TIME_TOL        = 40;    // bridge gaps up to N frames (≈ 1 s at hop=1024)
const RIDGE_MIN_EXTENT_FRAC = 0.20;  // require ≥ 20% of the fetch duration to keep
const RIDGE_MAX_PRINT       = 12;    // cap the diagnostic list

// Second-pass: collinear chaining for drifting tones buried in noise.
// A fast-drifting spin tone may show up as many short fragments whose bin
// jumps and time gaps exceed the main-pass tolerances. If those fragments
// lie on a single line (low RMS residual after refitting), they're almost
// certainly one ridge — promote them back to "keep".
const CHAIN_RESIDUAL_TOL    = 20.0;  // Hz — ~2 STFT bins at 10.77 Hz/bin
const CHAIN_MIN_FRAGMENTS   = 2;     // need at least this many fragments to form a chain
const CHAIN_MIN_POINTS      = 10;    // need enough detection points for a stable fit
const CHAIN_MAX_OVERLAP     = 10;    // frames of allowed time overlap between linked fragments

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

    // ── Ridge filter ─────────────────────────────────────────────────────────
    // Collect per-bin runs of confirmed frames, cluster them into ridges via
    // union-find, linear-regress freq vs time for each ridge, and reject any
    // ridge whose temporal extent is below RIDGE_MIN_EXTENT_FRAC of the fetch.
    const hzPerBinRidge = sampleRate / WIN_SIZE;

    // 1. Per-bin runs
    const binRuns = []; // { bin, start, end, active }
    for (let b = 0; b < numBins; b++) {
        let inRun = false, runStart = -1, runActive = 0;
        for (let fi = 0; fi < numFrames; fi++) {
            if (confirmed[b * numFrames + fi]) {
                if (!inRun) { inRun = true; runStart = fi; runActive = 0; }
                runActive++;
            } else if (inRun) {
                binRuns.push({ bin: b, start: runStart, end: fi - 1, active: runActive });
                inRun = false;
            }
        }
        if (inRun) binRuns.push({ bin: b, start: runStart, end: numFrames - 1, active: runActive });
    }
    const confirmedCountBefore = binRuns.reduce((s, r) => s + r.active, 0);

    // 2. Cluster via union-find: merge runs within ±RIDGE_BIN_TOL bins whose
    //    time intervals either overlap or sit within RIDGE_TIME_TOL frames.
    binRuns.sort((a, b) => a.bin - b.bin || a.start - b.start);
    const parent = new Int32Array(binRuns.length);
    for (let i = 0; i < binRuns.length; i++) parent[i] = i;
    function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    function union(i, j) { const ri = find(i), rj = find(j); if (ri !== rj) parent[ri] = rj; }
    for (let i = 0; i < binRuns.length; i++) {
        for (let j = i + 1; j < binRuns.length; j++) {
            if (binRuns[j].bin - binRuns[i].bin > RIDGE_BIN_TOL) break;
            // Gap between intervals: 0 or negative = overlap; positive = separation
            const gap = Math.max(binRuns[i].start, binRuns[j].start) - Math.min(binRuns[i].end, binRuns[j].end);
            if (gap <= RIDGE_TIME_TOL) union(i, j);
        }
    }

    // 3. Group runs by ridge ID, compute per-ridge metrics + linear regression
    const ridgeMap = new Map();
    for (let i = 0; i < binRuns.length; i++) {
        const rid = find(i);
        if (!ridgeMap.has(rid)) {
            ridgeMap.set(rid, {
                runs: [], firstFrame: Infinity, lastFrame: -Infinity,
                binLo: Infinity, binHi: -Infinity, totalActive: 0
            });
        }
        const ridge = ridgeMap.get(rid);
        ridge.runs.push(binRuns[i]);
        if (binRuns[i].start < ridge.firstFrame) ridge.firstFrame = binRuns[i].start;
        if (binRuns[i].end > ridge.lastFrame) ridge.lastFrame = binRuns[i].end;
        if (binRuns[i].bin < ridge.binLo) ridge.binLo = binRuns[i].bin;
        if (binRuns[i].bin > ridge.binHi) ridge.binHi = binRuns[i].bin;
        ridge.totalActive += binRuns[i].active;
    }
    const ridges = [...ridgeMap.values()];
    for (const ridge of ridges) {
        ridge.extent = ridge.lastFrame - ridge.firstFrame + 1;

        // Collect (t, f) points once — reused by the chain pass below
        const pts = []; // flat [t0, f0, t1, f1, …]
        for (const run of ridge.runs) {
            const freq = run.bin * hzPerBinRidge;
            for (let fi = run.start; fi <= run.end; fi++) {
                if (confirmed[run.bin * numFrames + fi]) {
                    pts.push(fi, freq);
                }
            }
        }
        ridge.points = pts;

        // Linear regression freq = a·t + b
        let sT = 0, sF = 0, sTT = 0, sTF = 0;
        const n = pts.length / 2;
        for (let i = 0; i < pts.length; i += 2) {
            sT += pts[i]; sF += pts[i+1]; sTT += pts[i]*pts[i]; sTF += pts[i]*pts[i+1];
        }
        if (n >= 2) {
            const denom = n * sTT - sT * sT;
            ridge.slope = denom !== 0 ? (n * sTF - sT * sF) / denom : 0;
            ridge.intercept = (sF - ridge.slope * sT) / n;
        } else {
            ridge.slope = 0;
            ridge.intercept = n ? sF : 0;
        }
        ridge.meanFreq = ridge.intercept + ridge.slope * ((ridge.firstFrame + ridge.lastFrame) / 2);
        ridge.driftHz = ridge.slope * (ridge.lastFrame - ridge.firstFrame); // total drift over lifetime
    }
    ridges.sort((a, b) => b.extent - a.extent);

    // 4. Initial extent threshold → candidate keep flag
    const minExtent = Math.max(1, Math.floor(numFrames * RIDGE_MIN_EXTENT_FRAC));
    for (const ridge of ridges) ridge.keep = ridge.extent >= minExtent;

    // 4b. Second pass: collinear chaining of rejected fragments
    // For each pair of rejected candidate ridges, fit a single line to their
    // combined points. If the RMS residual is small, they're collinear → union
    // them into a chain. Promote any chain whose temporal extent clears minExtent.
    function fitLine(pointArrays) {
        let sT = 0, sF = 0, sTT = 0, sTF = 0, n = 0;
        for (const pts of pointArrays) {
            for (let i = 0; i < pts.length; i += 2) {
                sT += pts[i]; sF += pts[i+1]; sTT += pts[i]*pts[i]; sTF += pts[i]*pts[i+1];
                n++;
            }
        }
        if (n < 2) return { slope: 0, intercept: 0, residual: Infinity, n };
        const denom = n * sTT - sT * sT;
        const slope = denom !== 0 ? (n * sTF - sT * sF) / denom : 0;
        const intercept = (sF - slope * sT) / n;
        let ss = 0;
        for (const pts of pointArrays) {
            for (let i = 0; i < pts.length; i += 2) {
                const r = pts[i+1] - (slope * pts[i] + intercept);
                ss += r * r;
            }
        }
        return { slope, intercept, residual: Math.sqrt(ss / n), n };
    }

    const chainCandidates = ridges.filter(r => !r.keep && r.points.length >= 6);
    chainCandidates.sort((a, b) => a.firstFrame - b.firstFrame);
    const chainParent = new Int32Array(chainCandidates.length);
    for (let i = 0; i < chainCandidates.length; i++) chainParent[i] = i;
    function cfind(i) { while (chainParent[i] !== i) { chainParent[i] = chainParent[chainParent[i]]; i = chainParent[i]; } return i; }
    for (let i = 0; i < chainCandidates.length; i++) {
        for (let j = i + 1; j < chainCandidates.length; j++) {
            const A = chainCandidates[i];
            const B = chainCandidates[j];
            const overlap = Math.min(A.lastFrame, B.lastFrame) - Math.max(A.firstFrame, B.firstFrame);
            if (overlap > CHAIN_MAX_OVERLAP) continue; // too much time overlap — probably unrelated
            const fit = fitLine([A.points, B.points]);
            if (fit.residual < CHAIN_RESIDUAL_TOL) {
                const ri = cfind(i), rj = cfind(j);
                if (ri !== rj) chainParent[ri] = rj;
            }
        }
    }

    const chainGroups = new Map();
    for (let i = 0; i < chainCandidates.length; i++) {
        const cid = cfind(i);
        if (!chainGroups.has(cid)) chainGroups.set(cid, []);
        chainGroups.get(cid).push(chainCandidates[i]);
    }
    const promotedChains = [];
    for (const group of chainGroups.values()) {
        if (group.length < CHAIN_MIN_FRAGMENTS) continue;
        const firstFrame = Math.min(...group.map(r => r.firstFrame));
        const lastFrame  = Math.max(...group.map(r => r.lastFrame));
        const totalPoints = group.reduce((s, r) => s + r.points.length / 2, 0);
        const chainExtent = lastFrame - firstFrame + 1;
        if (chainExtent < minExtent || totalPoints < CHAIN_MIN_POINTS) continue;
        const fit = fitLine(group.map(r => r.points));
        if (fit.residual >= CHAIN_RESIDUAL_TOL) continue;
        // Promote every fragment in the chain
        for (const r of group) r.keep = true;
        promotedChains.push({ group, firstFrame, lastFrame, chainExtent, fit });
    }

    // 5. Diagnostic print
    console.log(`🎛️ [ridge filter] BEFORE: ${confirmedCountBefore} detections across ${binRuns.length} bin-runs → ${ridges.length} ridges`);
    console.log(`🎛️ [ridge filter] numFrames=${numFrames}, minExtent=${minExtent} frames (${(RIDGE_MIN_EXTENT_FRAC * 100).toFixed(0)}% of fetch)`);
    const printCount = Math.min(RIDGE_MAX_PRINT, ridges.length);
    for (let i = 0; i < printCount; i++) {
        const r = ridges[i];
        const kept = r.keep ? '✅' : '❌';
        const pct = (100 * r.extent / numFrames).toFixed(1);
        const eq = `freq = ${r.slope.toExponential(2)}·t + ${r.intercept.toFixed(2)}`;
        console.log(
            `  ${kept} ridge #${i}: bins[${r.binLo}-${r.binHi}] frames[${r.firstFrame}-${r.lastFrame}] ` +
            `extent=${r.extent} (${pct}%) active=${r.totalActive} ` +
            `meanFreq=${r.meanFreq.toFixed(2)}Hz drift=${r.driftHz.toFixed(3)}Hz ` +
            `[${eq}]`
        );
    }
    if (ridges.length > printCount) {
        console.log(`  … and ${ridges.length - printCount} shorter ridges`);
    }
    for (const pc of promotedChains) {
        const binLo = Math.min(...pc.group.map(r => r.binLo));
        const binHi = Math.max(...pc.group.map(r => r.binHi));
        const pct = (100 * pc.chainExtent / numFrames).toFixed(1);
        const eq = `freq = ${pc.fit.slope.toExponential(2)}·t + ${pc.fit.intercept.toFixed(2)}`;
        console.log(
            `  🔗 CHAIN promoted: ${pc.group.length} fragments, bins[${binLo}-${binHi}] ` +
            `frames[${pc.firstFrame}-${pc.lastFrame}] extent=${pc.chainExtent} (${pct}%) ` +
            `residual=${pc.fit.residual.toFixed(2)}Hz [${eq}]`
        );
    }

    // 6. Apply the filter: zero out confirmed[] for runs in rejected ridges
    let confirmedCountAfter = 0;
    for (const ridge of ridges) {
        for (const run of ridge.runs) {
            for (let fi = run.start; fi <= run.end; fi++) {
                if (confirmed[run.bin * numFrames + fi]) {
                    if (!ridge.keep) {
                        confirmed[run.bin * numFrames + fi] = 0;
                    } else {
                        confirmedCountAfter++;
                    }
                }
            }
        }
    }
    console.log(`🎛️ [ridge filter] AFTER: ${confirmedCountAfter} detections survive (dropped ${confirmedCountBefore - confirmedCountAfter})`);

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
