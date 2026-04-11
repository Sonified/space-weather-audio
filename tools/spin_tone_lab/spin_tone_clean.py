"""
spin_tone_clean.py — The De-Toner

Removes spacecraft reaction wheel sine tones from audified magnetometer data.
Uses STFT for detection only; filtering is pure time-domain IIR (no IFFT).

Pipeline:
  1. DC removal (bidirectional EMA, matches main page algorithm)
  2. Tonality detection (per-bin peak-to-median ratio, brief temporal accumulation)
  3. Time-domain notch filtering (IIR notches track detected frequencies hop-by-hop)
  4. A/B clip export + spectrogram comparison

Usage:  python3 tools/spin_tone_lab/spin_tone_clean.py
"""

import numpy as np
import scipy.io.wavfile as wavfile
import scipy.signal as signal
import scipy.ndimage as ndimage
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import os
import time as timer

# ── Config ────────────────────────────────────────────────────────────────────
LAB_DIR   = os.path.dirname(__file__)
COMPONENT = "Br"

# Detection
WIN_SIZE        = 4096   # 5.4 Hz/bin at 22kHz
HOP_FRAC        = 4
TONALITY_WINDOW = 15     # spectral neighborhood half-width (bins)
TONALITY_THRESH = 6      # dB above local median = "tonal"
ACCUM_FRAMES    = 6      # brief temporal smoothing
ACCUM_THRESH    = 0.35   # fraction of frames that must be tonal
MAX_TONES       = 8      # max simultaneous notches per frame

# Notch filter
NOTCH_Q = 40.0

# Clip export
N_PEAK_CLIPS = 5
CLIP_HALF_S  = 2.0
CROSSFADE_S  = 0.15
CLIP_PEAK_DB = -12.0

# ── Timing helper ─────────────────────────────────────────────────────────────

class Timer:
    def __init__(self): self.marks = []
    def mark(self, label):
        self.marks.append((label, timer.perf_counter()))
    def report(self):
        print("\n── Timing ──")
        for i in range(1, len(self.marks)):
            dt = self.marks[i][1] - self.marks[i-1][1]
            print(f"  {self.marks[i-1][0]:30s}  {dt*1000:8.1f} ms")
        total = self.marks[-1][1] - self.marks[0][1]
        print(f"  {'TOTAL':30s}  {total*1000:8.1f} ms")

# ── Load ──────────────────────────────────────────────────────────────────────

def load_wav(component):
    path = os.path.join(LAB_DIR, f"psp_magrtn_{component}.wav")
    sr, raw = wavfile.read(path)
    data = raw.astype(np.float32) * (1.0 / 32768.0)
    print(f"Loaded {component}: {sr} Hz  {len(data)} samples  {len(data)/sr:.1f}s")
    return data, int(sr)

# ── DC removal (bidirectional EMA via scipy.signal.lfilter — vectorized) ──────

def remove_dc(data, alpha=0.995):
    """Bidirectional EMA highpass. Matches removeDCOffset() on the main page.
    Uses scipy.signal.lfilter (C-level loop) instead of Python for-loop."""
    n = len(data)
    warmup = min(n, int(np.ceil(3.0 / (1.0 - alpha))))

    # IIR coefficients for EMA: y[n] = alpha*y[n-1] + (1-alpha)*x[n]
    # Transfer function: H(z) = (1-alpha) / (1 - alpha*z^-1)
    b_ema = np.array([1.0 - alpha], dtype=np.float64)
    a_ema = np.array([1.0, -alpha], dtype=np.float64)

    # Forward pass
    zi_fwd = signal.lfilter_zi(b_ema, a_ema) * data[:warmup].mean()
    fwd, _ = signal.lfilter(b_ema, a_ema, data, zi=zi_fwd)

    # Backward pass
    zi_bwd = signal.lfilter_zi(b_ema, a_ema) * data[-warmup:].mean()
    bwd, _ = signal.lfilter(b_ema, a_ema, data[::-1], zi=zi_bwd)
    bwd = bwd[::-1]

    # Subtract zero-phase mean estimate
    y = data - (fwd + bwd).astype(np.float32) * 0.5

    # Cosine taper at edges
    taper = min(int(np.ceil(n * 0.001)), warmup, n // 2)
    t = np.arange(taper, dtype=np.float32)
    w = 0.5 * (1.0 - np.cos(np.pi * t / taper))
    y[:taper] *= w
    y[-taper:] *= w[::-1]

    return y

# ── Detection: tonality index (fully vectorized) ─────────────────────────────

def detect_tones(data, sr):
    """
    Returns:
      tone_map:  (MAX_TONES, n_frames) float32 — detected frequencies per frame
                 padded with 0 where fewer than MAX_TONES tones found
      n_tones:   (n_frames,) int — count of tones per frame
      times, freqs, pdb, confirmed — for plotting
    """
    hop = WIN_SIZE // HOP_FRAC

    # STFT
    freqs, times, Zxx = signal.stft(data, fs=sr, nperseg=WIN_SIZE,
                                    noverlap=WIN_SIZE - hop, window='hann')
    mag = np.abs(Zxx)
    pdb = np.empty_like(mag)
    np.log10(mag + 1e-12, out=pdb)
    pdb *= 20.0
    n_bins, n_frames = pdb.shape

    # Flatten 1/f: subtract mean spectrum (mean is fine here — the 1/f slope is smooth)
    bg = pdb.mean(axis=1, keepdims=True)
    pdb_flat = pdb - bg

    # Tonality: how far each bin rises above its spectral neighborhood.
    # uniform_filter1d (mean) is O(n) vs median_filter's O(n·k).
    # For spike detection, peak-vs-mean works as well as peak-vs-median.
    local_mean = ndimage.uniform_filter1d(pdb_flat, size=2 * TONALITY_WINDOW + 1,
                                           axis=0, mode='reflect')
    tonality = pdb_flat - local_mean

    # Binary tonal mask + brief bidirectional accumulation
    tonal = (tonality >= TONALITY_THRESH).astype(np.float32)
    A = ACCUM_FRAMES
    cs = np.cumsum(tonal, axis=1)
    pad = np.zeros((n_bins, A), dtype=np.float32)
    fwd = (cs - np.concatenate([pad, cs[:, :-A]], axis=1)) / A
    cs_r = np.cumsum(tonal[:, ::-1], axis=1)
    bwd = (cs_r - np.concatenate([pad, cs_r[:, :-A]], axis=1)) / A
    bwd = bwd[:, ::-1]
    confirmed = (fwd >= ACCUM_THRESH) & (bwd >= ACCUM_THRESH)

    # Extract top-N tones per frame (vectorized: argsort on tonality * mask)
    # Mask non-confirmed bins with -inf so they sort last
    masked_tonality = np.where(confirmed, tonality, -np.inf)
    # argsort descending along axis=0
    top_idx = np.argpartition(-masked_tonality, MAX_TONES, axis=0)[:MAX_TONES]  # (MAX_TONES, n_frames)

    # Build output arrays
    tone_map = np.zeros((MAX_TONES, n_frames), dtype=np.float32)
    n_tones  = np.zeros(n_frames, dtype=np.int32)

    for k in range(MAX_TONES):
        bins_k = top_idx[k]
        vals_k = masked_tonality[bins_k, np.arange(n_frames)]
        valid  = vals_k > -np.inf
        tone_map[k, valid] = freqs[bins_k[valid]]
        n_tones += valid.astype(np.int32)

    total = int(n_tones.sum())
    avg = total / max(n_frames, 1)
    print(f"  {total} detections across {n_frames} frames (avg {avg:.1f}/frame)")

    return tone_map, n_tones, times, freqs, pdb, confirmed

# ── Filtering: time-domain IIR notch (hop-by-hop) ────────────────────────────

def apply_notches(data, sr, tone_map, n_tones):
    """
    Process raw audio hop-by-hop. Each hop updates notch filter coefficients
    to track the detected tone frequencies. Filter state carries across hops.
    No IFFT — pure time-domain IIR on the raw waveform.
    """
    hop = WIN_SIZE // HOP_FRAC
    n_samples = len(data)
    n_frames = tone_map.shape[1]
    hz_per_bin = sr / WIN_SIZE
    out = data.copy()

    # Pre-compute notch SOS for a grid of frequencies (avoid recomputing per hop)
    freq_grid = np.arange(1, sr // 2, hz_per_bin * 0.5)
    sos_cache = {}
    for f in freq_grid:
        b, a = signal.iirnotch(float(f), NOTCH_Q, fs=sr)
        sos_cache[int(round(f / hz_per_bin))] = signal.tf2sos(b, a)

    def get_sos(freq_hz):
        key = int(round(freq_hz / hz_per_bin))
        if key not in sos_cache:
            b, a = signal.iirnotch(float(freq_hz), NOTCH_Q, fs=sr)
            sos_cache[key] = signal.tf2sos(b, a)
        return sos_cache[key], key

    # Active filter states: key -> zi (filter memory)
    filter_states = {}

    for fi in range(n_frames):
        start = fi * hop
        end = min(start + hop, n_samples)
        if start >= n_samples:
            break
        chunk = out[start:end]

        nt = n_tones[fi]
        if nt == 0:
            filter_states.clear()
            continue

        # Get target frequencies for this frame
        targets = tone_map[:nt, fi]
        new_states = {}

        for tf in targets:
            if tf <= 0 or tf >= sr / 2:
                continue
            sos, key = get_sos(tf)
            zi = filter_states.get(key)
            if zi is None:
                zi = signal.sosfilt_zi(sos) * chunk[0]
            chunk, zi = signal.sosfilt(sos, chunk, zi=zi)
            new_states[key] = zi

        filter_states = new_states
        out[start:end] = chunk

    return out

# ── Clip export ───────────────────────────────────────────────────────────────

def export_clips(data_orig, data_clean, sr, confirmed, freqs, times, hop):
    clip_n   = int(CLIP_HALF_S * sr)
    fade_n   = int(CROSSFADE_S * sr)
    target   = 10 ** (CLIP_PEAK_DB / 20.0)
    n_samp   = len(data_orig)
    n_frames = len(times)

    score = confirmed.sum(axis=0).astype(np.float32)
    gap = int(CLIP_HALF_S * 2 * sr / hop)
    fade_out = np.linspace(1, 0, fade_n, dtype=np.float32)
    fade_in  = np.linspace(0, 1, fade_n, dtype=np.float32)

    peaks = []
    sc = score.copy()
    for _ in range(N_PEAK_CLIPS):
        if sc.max() == 0: break
        fi = int(np.argmax(sc))
        peaks.append(fi)
        sc[max(0, fi - gap):min(n_frames, fi + gap)] = 0

    for i, fi in enumerate(peaks):
        c = int(fi * hop)
        lo, hi = max(0, c - clip_n), min(n_samp, c + clip_n)
        raw, clean = data_orig[lo:hi].copy(), data_clean[lo:hi].copy()

        fn = min(fade_n, len(raw), len(clean))
        raw[-fn:]  *= fade_out[-fn:]
        clean[:fn] *= fade_in[:fn]
        combo = np.concatenate([raw, clean])

        pk = np.max(np.abs(combo))
        if pk > 0: combo *= target / pk

        fname = os.path.join(LAB_DIR, f"clean_{i+1:02d}_frame{fi}.wav")
        wavfile.write(fname, sr, (combo * 32767).clip(-32768, 32767).astype(np.int16))

        r_db = 20 * np.log10(np.sqrt(np.mean(data_orig[lo:hi]**2)) + 1e-12)
        c_db = 20 * np.log10(np.sqrt(np.mean(data_clean[lo:hi]**2)) + 1e-12)
        print(f"  Clip {i+1}: raw {r_db:.1f} → clean {c_db:.1f} dB  → {os.path.basename(fname)}")

# ── Plot ──────────────────────────────────────────────────────────────────────

def plot_results(data_orig, data_clean, sr, confirmed, freqs, times, pdb_orig):
    hop = WIN_SIZE // HOP_FRAC
    _, _, Zxx_c = signal.stft(data_clean, fs=sr, nperseg=WIN_SIZE,
                              noverlap=WIN_SIZE - hop, window='hann')
    pdb_c = 20 * np.log10(np.abs(Zxx_c) + 1e-12)
    vmin, vmax = np.percentile(pdb_orig, [5, 99])

    sqrt_fwd = lambda x: np.sqrt(np.maximum(x, 0))
    sqrt_inv = lambda x: x ** 2

    fig, axes = plt.subplots(2, 2, figsize=(18, 10))
    fig.suptitle(f"PSP {COMPONENT} — The De-Toner (time-domain IIR notch, no IFFT)", fontsize=12)

    for ax, pdb_data, title in [
        (axes[0, 0], pdb_orig, "Original"),
        (axes[0, 1], pdb_c,    "Cleaned"),
    ]:
        ax.pcolormesh(times, freqs[:pdb_data.shape[0]], pdb_data,
                      shading='auto', vmin=vmin, vmax=vmax, cmap='inferno')
        ax.set_yscale('function', functions=(sqrt_fwd, sqrt_inv))
        ax.set_ylim(max(freqs[1], 1), freqs[-1])
        ax.set_title(title)
        ax.yaxis.tick_right(); ax.yaxis.set_label_position('right')
        ax.set_ylabel("Freq (Hz)")

    ax = axes[1, 0]
    ax.pcolormesh(times, freqs, confirmed.astype(float),
                  shading='auto', vmin=0, vmax=1, cmap='hot')
    ax.set_yscale('function', functions=(sqrt_fwd, sqrt_inv))
    ax.set_ylim(max(freqs[1], 1), freqs[-1])
    ax.set_title("Tonal mask"); ax.set_xlabel("Time (s)")
    ax.yaxis.tick_right(); ax.yaxis.set_label_position('right')
    ax.set_ylabel("Freq (Hz)")

    diff = pdb_orig - pdb_c[:pdb_orig.shape[0], :pdb_orig.shape[1]]
    ax = axes[1, 1]
    ax.pcolormesh(times, freqs[:diff.shape[0]], diff,
                  shading='auto', vmin=0, vmax=20, cmap='magma')
    ax.set_yscale('function', functions=(sqrt_fwd, sqrt_inv))
    ax.set_ylim(max(freqs[1], 1), freqs[-1])
    ax.set_title("Removed (dB)"); ax.set_xlabel("Time (s)")
    ax.yaxis.tick_right(); ax.yaxis.set_label_position('right')

    plt.tight_layout()
    out = os.path.join(LAB_DIR, "clean_comparison.png")
    plt.savefig(out, dpi=150); plt.close()
    print(f"  Saved → {out}")

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    t = Timer()
    t.mark("load")
    data, sr = load_wav(COMPONENT)

    t.mark("dc_removal")
    dc_before = data.mean()
    data = remove_dc(data)
    peak = np.max(np.abs(data))
    if peak > 0: data *= 0.95 / peak
    print(f"  DC: {dc_before:.4f} → {data.mean():.6f}  normalized")

    t.mark("detection")
    tone_map, n_tones, times, freqs, pdb, confirmed = detect_tones(data, sr)

    t.mark("notch_filtering")
    data_clean = apply_notches(data, sr, tone_map, n_tones)
    rms_b = 20 * np.log10(np.sqrt(np.mean(data**2)) + 1e-12)
    rms_a = 20 * np.log10(np.sqrt(np.mean(data_clean**2)) + 1e-12)
    print(f"  RMS: {rms_b:.1f} → {rms_a:.1f} dB  ({rms_a - rms_b:+.1f} dB)")

    t.mark("clips")
    for f in os.listdir(LAB_DIR):
        if f.startswith("clean_") and f.endswith(".wav"):
            os.remove(os.path.join(LAB_DIR, f))
    hop = WIN_SIZE // HOP_FRAC
    export_clips(data, data_clean, sr, confirmed, freqs, times, hop)

    # t.mark("plot")
    # plot_results(data, data_clean, sr, confirmed, freqs, times, pdb)

    t.mark("done")
    t.report()

if __name__ == "__main__":
    main()
