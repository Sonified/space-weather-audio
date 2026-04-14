/**
 * feature-export.js
 * Download all tracked features (metadata or per-feature audio clips).
 *
 * Two split buttons in the bottom bar drive this:
 *
 *   1. "Features: JSON/CSV"   — metadata-only dump of every standalone feature
 *      Writes one file: features_<spacecraft>_<dataset>_<start>_<end>.(json|csv)
 *
 *   2. "Audio: Isolated/Full" — per-feature WAV clips
 *      Slices the audio buffer to each feature's time range, optionally
 *      band-passing to its [lowFreq, highFreq] range first. Bundles multiple
 *      features into one zip. Single-feature export still writes a loose WAV.
 *
 * Source audio: window.rawWaveformData (the original field shape) resampled
 * to playback rate for consistency with what the spectrogram displays.
 */

import * as State from './audio-state.js';
import { getStandaloneFeatures } from './feature-tracker.js';
import { isDenoiseActive, getCleanedSamples } from './spin-tone-denoise.js';

// ── localStorage keys for last-used format preferences ────────────────────
const LS_FEATURE_FORMAT = 'featureDownloadFormat';     // 'json' | 'csv'
const LS_AUDIO_MODE     = 'featureAudioExportMode';    // 'isolated' | 'full'

// ── Small utilities ────────────────────────────────────────────────────────
function currentFetchLabel() {
    const md = State.currentMetadata || {};
    const spacecraft = md.spacecraft || 'unknown';
    const dataset    = md.dataset    || 'unknown';
    const startIso   = State.dataStartTime ? State.dataStartTime.toISOString() : 'start';
    const endIso     = State.dataEndTime   ? State.dataEndTime.toISOString()   : 'end';
    const safeStart  = startIso.replace(/[:]/g, '-').replace(/\..+$/, '');
    const safeEnd    = endIso.replace(/[:]/g,   '-').replace(/\..+$/, '');
    return { spacecraft, dataset, startIso, endIso, safeStart, safeEnd };
}

function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function flagFromFeature(f, key) {
    const v = f[key];
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : String(v);
}

// ── Metadata export (JSON / CSV) ───────────────────────────────────────────
function buildFeatureRows() {
    const features = (getStandaloneFeatures() || []).slice().sort((a, b) => {
        const ta = new Date(a.startTime).getTime();
        const tb = new Date(b.startTime).getTime();
        return (isFinite(ta) ? ta : 0) - (isFinite(tb) ? tb : 0);
    });
    const { spacecraft, dataset, startIso, endIso } = currentFetchLabel();
    const selectorEl = document.getElementById('componentSelector');
    const componentIndex = selectorEl?.value ?? null;
    const rawName = selectorEl?.selectedOptions?.[0]?.textContent?.trim() || null;
    // Drop any parenthetical coordinate hint ("br (Radial)" → "br") and
    // capitalize the leading axis letter ("br" → "Br").
    const componentName = rawName
        ? rawName.replace(/\s*\(.*\)\s*$/, '').replace(/^([a-z])/, (c) => c.toUpperCase())
        : null;

    return features.map((f, i) => ({
        index: i + 1,
        spacecraft,
        fetchStart: startIso,
        fetchEnd: endIso,
        dataset,
        componentIndex,
        componentName,
        startTime: flagFromFeature(f, 'startTime'),
        endTime: flagFromFeature(f, 'endTime'),
        lowFreqHz: f.lowFreq !== undefined && f.lowFreq !== null && f.lowFreq !== ''
            ? Number(f.lowFreq) : null,
        highFreqHz: f.highFreq !== undefined && f.highFreq !== null && f.highFreq !== ''
            ? Number(f.highFreq) : null,
        confidence: flagFromFeature(f, 'confidence'),
        notes: flagFromFeature(f, 'notes'),
        d1Id: flagFromFeature(f, 'd1Id'),
    }));
}

function exportFeaturesAsJSON() {
    const rows = buildFeatureRows();
    if (rows.length === 0) { alert('No features to download — draw a feature box first.'); return; }
    const { spacecraft, dataset, safeStart, safeEnd } = currentFetchLabel();
    const payload = {
        exportedAt: new Date().toISOString(),
        spacecraft,
        dataset,
        fetchStart: State.dataStartTime ? State.dataStartTime.toISOString() : null,
        fetchEnd: State.dataEndTime ? State.dataEndTime.toISOString() : null,
        featureCount: rows.length,
        features: rows,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    triggerBlobDownload(blob, `features_${spacecraft}_${dataset}_${safeStart}_${safeEnd}.json`);
}

function exportFeaturesAsCSV() {
    const rows = buildFeatureRows();
    if (rows.length === 0) { alert('No features to download — draw a feature box first.'); return; }
    const { spacecraft, dataset, safeStart, safeEnd } = currentFetchLabel();
    const header = ['index','spacecraft','fetchStart','fetchEnd','dataset','componentIndex','componentName','startTime','endTime','lowFreqHz','highFreqHz','confidence','notes','d1Id'];
    const escape = (v) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(',')];
    for (const row of rows) lines.push(header.map(k => escape(row[k])).join(','));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    triggerBlobDownload(blob, `features_${spacecraft}_${dataset}_${safeStart}_${safeEnd}.csv`);
}

// ── Audio export (Isolated / Full spectrum) ────────────────────────────────
//
// The audio source is the original raw waveform. For each feature we:
//   1. Convert feature.startTime/endTime to sample indices (UTC → seconds
//      since dataStartTime × samplesPerRealSecond).
//   2. Slice the raw buffer to that window.
//   3. If mode='isolated', run the slice through an offline biquad bandpass
//      at the feature's [lowFreq, highFreq] range (center = sqrt(lo*hi),
//      Q = center / bandwidth).
//   4. Encode the result as a 16-bit PCM mono WAV.

function featureToSampleRange(feature) {
    if (!State.dataStartTime) return null;
    const startMs = new Date(feature.startTime).getTime();
    const endMs   = new Date(feature.endTime).getTime();
    if (!isFinite(startMs) || !isFinite(endMs)) return null;
    const dataStartMs = State.dataStartTime.getTime();
    const dataEndMs   = State.dataEndTime ? State.dataEndTime.getTime() : dataStartMs;
    const totalSpanSec = (dataEndMs - dataStartMs) / 1000;

    const md = State.currentMetadata || {};
    const totalSamples = md.playback_total_samples
        || (State.completeSamplesArray ? State.completeSamplesArray.length : 0);
    const samplesPerRealSec = md.playback_samples_per_real_second
        || (totalSpanSec > 0 ? totalSamples / totalSpanSec : 44100);

    const startSec = (startMs - dataStartMs) / 1000;
    const endSec   = (endMs   - dataStartMs) / 1000;
    const sampleStart = Math.max(0, Math.floor(startSec * samplesPerRealSec));
    const sampleEnd   = Math.min(totalSamples, Math.ceil(endSec * samplesPerRealSec));
    if (sampleEnd <= sampleStart) return null;
    const playbackSampleRate = State.audioContext?.sampleRate || 44100;
    return { sampleStart, sampleEnd, sampleRate: playbackSampleRate };
}

function getSourceSamples() {
    // If de-tone is active and cleaned samples exist, use those
    if (isDenoiseActive()) {
        const cleaned = getCleanedSamples();
        if (cleaned && cleaned.length > 0) return cleaned;
    }
    if (window.rawWaveformData && window.rawWaveformData.length > 0) return window.rawWaveformData;
    return State.completeSamplesArray || State.getCompleteSamplesArray?.() || null;
}

/**
 * Offline isolation filter — HP → LP Butterworth chain, Q = 0.7071, matching
 * the live isolation pipeline in audio-worklet-init.js (createBiquadFilter
 * type='highpass' then type='lowpass', both at Q = 0.7071). RBJ cookbook
 * coefficients, same ones WebAudio's BiquadFilterNode uses internally.
 *
 *    isolateHP.frequency = lowFreq   // kill everything below
 *    isolateLP.frequency = highFreq  // kill everything above
 */
const BUTTERWORTH_Q = 0.7071;

function applyBiquad(samples, sampleRate, type, freq, Q) {
    const w0 = 2 * Math.PI * freq / sampleRate;
    const cosW0 = Math.cos(w0);
    const sinW0 = Math.sin(w0);
    const alpha = sinW0 / (2 * Q);

    let b0, b1, b2;
    if (type === 'highpass') {
        const onePlusCos = 1 + cosW0;
        b0 =  onePlusCos / 2;
        b1 = -onePlusCos;
        b2 =  onePlusCos / 2;
    } else { // lowpass
        const oneMinusCos = 1 - cosW0;
        b0 =  oneMinusCos / 2;
        b1 =  oneMinusCos;
        b2 =  oneMinusCos / 2;
    }
    const a0 =  1 + alpha;
    const a1 = -2 * cosW0;
    const a2 =  1 - alpha;

    const out = new Float32Array(samples.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < samples.length; i++) {
        const x0 = samples[i];
        const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
        out[i] = y0;
        x2 = x1; x1 = x0;
        y2 = y1; y1 = y0;
    }
    return out;
}

function offlineIsolation(samples, sampleRate, lowHz, highHz) {
    // HP at lowFreq (kills DC + everything below the band), then LP at highFreq
    // (kills everything above the band). Same serial chain as the live worklet
    // output path — isolateHP → isolateLP.
    const afterHP = applyBiquad(samples, sampleRate, 'highpass', Math.max(1, lowHz),  BUTTERWORTH_Q);
    const afterLP = applyBiquad(afterHP, sampleRate, 'lowpass',  Math.max(1, highHz), BUTTERWORTH_Q);
    return afterLP;
}

function removeDC(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i];
    const dc = sum / buf.length;
    for (let i = 0; i < buf.length; i++) buf[i] -= dc;
}

function taper(buf, sampleRate) {
    const len = Math.min(Math.floor(sampleRate * 0.05), Math.floor(buf.length / 2));
    for (let i = 0; i < len; i++) {
        const g = 0.5 * (1 - Math.cos(Math.PI * i / len));
        buf[i] *= g;
        buf[buf.length - 1 - i] *= g;
    }
}

function normalize(buf) {
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
        const a = Math.abs(buf[i]);
        if (a > peak) peak = a;
    }
    const scale = peak > 0 ? 0.98 / peak : 1;
    for (let i = 0; i < buf.length; i++) buf[i] *= scale;
}

function encodeWAV(samples, sampleRate) {

    const numSamples = samples.length;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    const writeString = (offset, s) => {
        for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);        // PCM chunk size
    view.setUint16(20, 1, true);         // PCM format
    view.setUint16(22, 1, true);         // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);         // block align
    view.setUint16(34, 16, true);        // bits per sample
    writeString(36, 'data');
    view.setUint32(40, numSamples * 2, true);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
    }
    return new Blob([buffer], { type: 'audio/wav' });
}

function featureAudioFilename(feature, idx, mode) {
    const label = currentFetchLabel();
    const start = (feature.startTime || '').replace(/[:]/g, '-').replace(/\..+$/, '');
    const lo = feature.lowFreq  !== undefined ? Math.round(Number(feature.lowFreq))  : 0;
    const hi = feature.highFreq !== undefined ? Math.round(Number(feature.highFreq)) : 0;
    const component = document.getElementById('componentSelector')?.value ?? '';
    const pad = String(idx + 1).padStart(2, '0');
    const detone = isDenoiseActive() ? '_de-tone' : '';
    return `feature_${pad}_${mode}${detone}_${start}_${lo}-${hi}Hz_${label.spacecraft}_${component || label.dataset}.wav`;
}

async function exportFeatureAudio(mode /* 'isolated' | 'full' */) {
    const features = getStandaloneFeatures() || [];
    if (features.length === 0) { alert('No features to export — draw a feature box first.'); return; }
    const source = getSourceSamples();
    if (!source || source.length === 0) { alert('No audio loaded to export from.'); return; }

    const clips = [];
    for (let i = 0; i < features.length; i++) {
        const f = features[i];
        const range = featureToSampleRange(f);
        if (!range) continue;
        let slice = new Float32Array(source.subarray(range.sampleStart, range.sampleEnd));
        // Pipeline: DC removal → filter → taper → normalize
        removeDC(slice);
        if (mode === 'isolated') {
            const lo = Number(f.lowFreq);
            const hi = Number(f.highFreq);
            if (isFinite(lo) && isFinite(hi) && hi > lo) {
                const origRate = State.currentMetadata?.original_sample_rate || 100;
                const speedup = range.sampleRate / origRate;
                slice = offlineIsolation(slice, range.sampleRate, lo * speedup, hi * speedup);
            }
        }
        taper(slice, range.sampleRate);
        normalize(slice);
        const wav = encodeWAV(slice, range.sampleRate);
        clips.push({ name: featureAudioFilename(f, i, mode), blob: wav });
    }
    if (clips.length === 0) { alert('Could not slice any features — check their time ranges.'); return; }

    const label = currentFetchLabel();
    if (clips.length === 1) {
        triggerBlobDownload(clips[0].blob, clips[0].name);
        return;
    }
    if (typeof window.JSZip !== 'function' && typeof JSZip !== 'function') {
        // Lazy-load JSZip on first use
        try {
            await new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
                s.onload = resolve; s.onerror = reject;
                document.head.appendChild(s);
            });
        } catch (e) {
            // Still no zip — download sequentially as fallback
            for (const c of clips) triggerBlobDownload(c.blob, c.name);
            return;
        }
    }
    const zip = new JSZip();
    for (const c of clips) zip.file(c.name, c.blob);
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    const detone = isDenoiseActive() ? '_de-tone' : '';
    triggerBlobDownload(zipBlob, `features_audio_${mode}${detone}_${label.spacecraft}_${label.dataset}_${label.safeStart}_${label.safeEnd}.zip`);
}

// ── Split-button wiring ────────────────────────────────────────────────────
function wireSplitButton({ mainId, chevronId, menuId, labelId, storageKey, options, defaultValue, onClick, formatLabel }) {
    const mainBtn = document.getElementById(mainId);
    const chevron = document.getElementById(chevronId);
    const menu    = document.getElementById(menuId);
    const label   = document.getElementById(labelId);
    if (!mainBtn || !chevron || !menu || !label) return;

    const current = () => localStorage.getItem(storageKey) || defaultValue;
    const setLabel = () => { label.textContent = formatLabel(current()); };
    setLabel();

    mainBtn.addEventListener('click', (e) => {
        e.preventDefault();
        onClick(current());
        // Blur so Space still toggles play/pause (the keyboard shortcut
        // defers when any visible button has focus).
        mainBtn.blur();
    });

    chevron.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Toggle open/closed on chevron click
        menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        chevron.blur();
    });

    menu.querySelectorAll('.split-btn-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
            e.preventDefault();
            const val = opt.dataset.format || opt.dataset.mode;
            if (val) {
                // Only change the mode + persist + update label.
                // Export fires ONLY when the main button is clicked.
                localStorage.setItem(storageKey, val);
                setLabel();
                menu.style.display = 'none';
            }
            opt.blur();
        });
    });
    // Also close the menu on any click outside the split-button cluster.
    document.addEventListener('click', (e) => {
        if (menu.style.display === 'none') return;
        if (menu.contains(e.target) || chevron.contains(e.target) || mainBtn.contains(e.target)) return;
        menu.style.display = 'none';
    });
}

export function initFeatureExport() {
    wireSplitButton({
        mainId: 'downloadFeaturesBtn',
        chevronId: 'downloadFeaturesChevron',
        menuId: 'downloadFeaturesMenu',
        labelId: 'downloadFeaturesFormat',
        storageKey: LS_FEATURE_FORMAT,
        options: ['json', 'csv'],
        defaultValue: 'json',
        formatLabel: (v) => v.toUpperCase(),
        onClick: (format) => {
            if (format === 'csv') exportFeaturesAsCSV();
            else exportFeaturesAsJSON();
        },
    });

    wireSplitButton({
        mainId: 'exportFeatureAudioBtn',
        chevronId: 'exportFeatureAudioChevron',
        menuId: 'exportFeatureAudioMenu',
        labelId: 'exportFeatureAudioMode',
        storageKey: LS_AUDIO_MODE,
        options: ['isolated', 'full'],
        defaultValue: 'isolated',
        formatLabel: (v) => v === 'isolated' ? 'Isolated' : 'Full',
        onClick: (mode) => { exportFeatureAudio(mode); },
    });
}
