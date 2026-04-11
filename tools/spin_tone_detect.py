"""
spin_tone_detect.py — PSP reaction wheel spin tone detector + notch filter.
Fully vectorized (numpy/scipy). No interactive plots.

Usage:  python3 tools/spin_tone_detect.py
Output: tools/spin_tone_output/*.png  and  *_denoised.wav
"""

import numpy as np
import scipy.io.wavfile as wav
import scipy.signal as signal
import scipy.ndimage as ndimage
import matplotlib
matplotlib.use('Agg')   # no display — saves PNG only
import matplotlib.pyplot as plt
import os

# ── Config ────────────────────────────────────────────────────────────────────
WAV_DIR       = "tools/spin_tone_output"
COMPONENT     = "Br"

PRIMARY_WIN   = 2048
WINDOW_SIZES  = [512, 1024, 2048, 4096]

# Sample a few short windows spread across the file for detection.
# Tones are persistent throughout — no need to analyze the whole thing.
SAMPLE_DURATION_S  = 10.0   # seconds per sample region
SAMPLE_OFFSETS_S   = [5, 45, 90, 140, 180]  # spread across ~191s file

FLOOR_PERCENTILE   = 40    # local spectral floor percentile
FLOOR_HALF_BINS    = 80    # rolling window half-width (bins)
ANOMALY_DB         = 18    # dB above floor → candidate
NARROWNESS_BINS    = 6     # peak half-width limit in bins
PERSIST_FRAMES     = 10    # min frames within a sample to count as present
VOTE_THRESHOLD     = 3     # tone must appear in this many sample regions
MERGE_HZ           = 2.0   # merge candidate tones within this Hz
MAX_DRIFT_HZ_PER_S = 2.0   # anti-whistler drift guard
NOTCH_Q            = 50.0  # notch quality factor — high = very narrow & deep

# ── Load ──────────────────────────────────────────────────────────────────────

def load_wav(component):
    path = os.path.join(WAV_DIR, f"psp_magrtn_{component}.wav")
    sr, data = wav.read(path)
    data = data.astype(np.float32) / 32768.0
    print(f"{component}: {sr} Hz, {len(data)} samples, {len(data)/sr:.1f}s")
    return data, sr

# ── STFT ──────────────────────────────────────────────────────────────────────

def stft_db(data, sr, win_size):
    hop = win_size // 4
    freqs, times, Zxx = signal.stft(data, fs=sr, nperseg=win_size,
                                    noverlap=win_size - hop, window='hann')
    return freqs, times, 20 * np.log10(np.abs(Zxx) + 1e-12)

# ── Detection (fully vectorized) ──────────────────────────────────────────────

def detect_tones(freqs, times, pdb, sr):
    """
    pdb: shape (n_bins, n_frames)
    Returns list of confirmed tone dicts.
    """
    n_bins, n_frames = pdb.shape
    dt = (times[-1] - times[0]) / max(n_frames - 1, 1)
    hz_per_bin = freqs[1] - freqs[0]

    # --- Vectorized local floor via percentile filter along freq axis ---
    # scipy.ndimage.percentile_filter: size=(2*FLOOR_HALF_BINS+1, 1) → per-frame rolling
    floor = ndimage.percentile_filter(
        pdb,
        percentile=FLOOR_PERCENTILE,
        size=(2 * FLOOR_HALF_BINS + 1, 1),
        mode='reflect'
    )  # shape (n_bins, n_frames)

    above = pdb - floor   # how far each bin rises above local floor

    # --- Binary mask: bins exceeding threshold ---
    hot = (above >= ANOMALY_DB).astype(np.int32)   # (n_bins, n_frames)

    # --- Persistence: count how many frames each bin exceeds threshold ---
    # Sum along time axis
    frame_counts = hot.sum(axis=1)   # (n_bins,)

    candidate_bins = np.where(frame_counts >= PERSIST_FRAMES)[0]
    print(f"  {len(candidate_bins)} candidate bins passed persistence test")

    if len(candidate_bins) == 0:
        return []

    confirmed = []
    for bidx in candidate_bins:
        # Frames where this bin is hot
        hot_frames = np.where(hot[bidx, :] > 0)[0]

        # Centroid per hot frame: weighted average in ±NARROWNESS_BINS window
        lo = max(0, bidx - NARROWNESS_BINS)
        hi = min(n_bins, bidx + NARROWNESS_BINS + 1)
        w = np.maximum(0, above[lo:hi, :][:, hot_frames])   # (window, n_hot)
        w_sum = w.sum(axis=0)
        w_sum = np.where(w_sum == 0, 1, w_sum)
        bin_offsets = np.arange(lo, hi)
        centroids = (freqs[bin_offsets] @ w) / w_sum   # (n_hot,)

        # Anti-whistler: check drift rate
        span_frames = hot_frames[-1] - hot_frames[0]
        if span_frames > 0:
            span_s = span_frames * dt
            drift = abs(float(centroids[-1]) - float(centroids[0]))
            if drift / span_s > MAX_DRIFT_HZ_PER_S:
                print(f"  ⚡ Whistler rejected: {freqs[bidx]:.2f} Hz "
                      f"(drift {drift/span_s:.2f} Hz/s)")
                continue

        mean_freq = float(centroids.mean())
        mean_db   = float(above[bidx, hot_frames].mean())

        confirmed.append({
            "freq_hz":  mean_freq,
            "power_db": mean_db,
            "start_s":  float(times[hot_frames[0]]),
            "end_s":    float(times[hot_frames[-1]]),
            "n_frames": len(hot_frames),
        })

    # Merge tones within MERGE_HZ
    confirmed.sort(key=lambda x: x["freq_hz"])
    merged = []
    for tone in confirmed:
        if merged and abs(tone["freq_hz"] - merged[-1]["freq_hz"]) < MERGE_HZ:
            if tone["power_db"] > merged[-1]["power_db"]:
                merged[-1] = tone
        else:
            merged.append(tone)

    return merged

# ── Notch filter ──────────────────────────────────────────────────────────────

def apply_notches(data, sr, tones):
    out = data.copy()
    for t in tones:
        b, a = signal.iirnotch(t["freq_hz"], NOTCH_Q, fs=sr)
        out = signal.filtfilt(b, a, out)
    return out

# ── Plots (saved as PNG, no display) ─────────────────────────────────────────

def plot_window_sizes(data, sr):
    fig, axes = plt.subplots(1, len(WINDOW_SIZES), figsize=(20, 5), sharey=True)
    fig.suptitle(f"PSP {COMPONENT} — window size exploration", fontsize=12)
    for i, ws in enumerate(WINDOW_SIZES):
        freqs, times, pdb = stft_db(data, sr, ws)
        vmin, vmax = np.percentile(pdb, [5, 99])
        axes[i].pcolormesh(times, freqs, pdb, shading='auto',
                           vmin=vmin, vmax=vmax, cmap='inferno')
        axes[i].set_title(f"win={ws}")
        axes[i].set_xlabel("Time (s)")
        if i == 0: axes[i].set_ylabel("Freq (Hz)")
    plt.tight_layout()
    out = os.path.join(WAV_DIR, "01_window_comparison.png")
    plt.savefig(out, dpi=120); plt.close()
    print(f"Saved → {out}")

def plot_results(data_orig, data_clean, sr, tones):
    freqs_o, times_o, pdb_o = stft_db(data_orig, sr, PRIMARY_WIN)
    freqs_c, times_c, pdb_c = stft_db(data_clean, sr, PRIMARY_WIN)
    residual = data_orig - data_clean
    vmin, vmax = np.percentile(pdb_o, [5, 99])

    fig, axes = plt.subplots(2, 2, figsize=(18, 10))
    fig.suptitle(f"PSP {COMPONENT} — Spin Tone Denoise  (win={PRIMARY_WIN}, Q={NOTCH_Q})", fontsize=12)

    ax = axes[0, 0]
    ax.pcolormesh(times_o, freqs_o, pdb_o, shading='auto', vmin=vmin, vmax=vmax, cmap='inferno')
    for t in tones:
        ax.axhline(t["freq_hz"], color='cyan', lw=1, alpha=0.8, label=f"{t['freq_hz']:.1f} Hz")
    ax.set_title("Original"); ax.set_ylabel("Freq (Hz)"); ax.set_xlabel("Time (s)")
    if tones: ax.legend(fontsize=7, loc='upper right')

    ax = axes[0, 1]
    ax.pcolormesh(times_c, freqs_c, pdb_c, shading='auto', vmin=vmin, vmax=vmax, cmap='inferno')
    ax.set_title("Notch-filtered"); ax.set_xlabel("Time (s)")

    n5 = min(int(sr * 5), len(data_orig))
    t5 = np.arange(n5) / sr
    axes[1, 0].plot(t5, data_orig[:n5], lw=0.4, label="Original", alpha=0.85)
    axes[1, 0].plot(t5, data_clean[:n5], lw=0.4, label="Denoised", alpha=0.85)
    axes[1, 0].set_title("Time series — first 5 s"); axes[1, 0].set_xlabel("Time (s)")
    axes[1, 0].legend(fontsize=8)

    axes[1, 1].plot(t5, residual[:n5], lw=0.4, color='tomato')
    axes[1, 1].set_title("Removed signal"); axes[1, 1].set_xlabel("Time (s)")

    plt.tight_layout()
    out = os.path.join(WAV_DIR, "02_denoise_result.png")
    plt.savefig(out, dpi=150); plt.close()
    print(f"Saved → {out}")

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    data, sr = load_wav(COMPONENT)

    print("\n── Window comparison ──")
    plot_window_sizes(data, sr)

    print(f"\n── Tone detection (win={PRIMARY_WIN}) ──")
    freqs, times, pdb = stft_db(data, sr, PRIMARY_WIN)
    tones = detect_tones(freqs, times, pdb, sr)

    if not tones:
        print("No tones found — try lowering ANOMALY_DB or PERSIST_FRAMES")
        return

    print(f"\nConfirmed {len(tones)} tone(s):")
    for t in tones:
        print(f"  {t['freq_hz']:8.2f} Hz  |  +{t['power_db']:.1f} dB above floor  "
              f"|  {t['n_frames']} frames  |  {t['start_s']:.1f}–{t['end_s']:.1f} s")

    data_clean = apply_notches(data, sr, tones)

    out_wav = os.path.join(WAV_DIR, f"psp_magrtn_{COMPONENT}_denoised.wav")
    wav.write(out_wav, sr, (data_clean * 32767).clip(-32768, 32767).astype(np.int16))
    print(f"\nDenoised WAV → {out_wav}")

    plot_results(data, data_clean, sr, tones)

if __name__ == "__main__":
    main()
