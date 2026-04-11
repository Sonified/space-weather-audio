"""
spin_tone_detect.py

Reaction wheel spin tone detector + STFT-domain suppression.

Two-stage detection:
  Stage 1 — WIDE temporal accumulation:
    Flatten 1/f spectrum. Per bin, compute bidirectional running average of
    above-floor energy along time. Threshold → 2D "tone present" mask.
    Label connected regions → each blob = one tone (handles sliding tones
    that sweep across bins naturally).

  Stage 2 — NARROW instantaneous targeting:
    Within each confirmed blob, per frame, find the exact spectral peak.
    Zero ±SUPPRESS_BINS around it in the complex STFT. ISTFT once.
"""

import numpy as np
import scipy.io.wavfile as wavfile
import scipy.signal as signal
import scipy.ndimage as ndimage
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import os

# ── Config ────────────────────────────────────────────────────────────────────
LAB_DIR   = os.path.dirname(__file__)
COMPONENT = "Br"

WIN_SIZE  = 8192   # 2.7 Hz/bin at 22kHz
HOP_FRAC  = 4

# Stage 1: wide temporal accumulation
FLOOR_PERCENTILE  = 40
FLOOR_HALF_BINS   = 30    # spectral floor window half-width (bins)
ANOMALY_DB        = 12    # dB above floor to be "elevated"
# Multi-scale accumulation: short catches fast sweeps, long catches slow ones
ACCUM_SCALES = [
    # (window_frames, threshold, dilation_bins)
    (15,  0.35, 5),    # fast sweeps: ~1.4s window, wider dilation
    (40,  0.35, 3),    # medium sweeps: ~3.7s window
    (80,  0.40, 2),    # slow sweeps: ~7.4s window, tight dilation
]
MIN_BLOB_FRAMES   = 10    # low bar — let the scanner decide if it's real
MIN_BLOB_POWER_DB = 15    # OR keep if peak power exceeds this even if small

# Stage 1b: spectral peak voting (catches pulsing tones)
PEAK_VOTE_THRESHOLD = 0.25  # fraction of frames a bin must have a local peak
PEAK_VOTE_WINDOW    = 80    # bidirectional accumulation window for peak votes
PEAK_MIN_DB         = 8     # minimum dB above floor for a peak vote to count

# Stage 2: ridge scan — follow regression line forward + backward
SCAN_SEARCH_BINS  = 3     # search radius around predicted freq
SCAN_MIN_DB       = 8     # looser threshold — we KNOW there's a tone
SCAN_GAP_FRAMES   = 15    # tolerate this many misses before stopping
SCAN_MIN_SEED     = 3     # minimum seed points to start a scan
SCAN_REFIT_EVERY  = 20    # refit regression every N new points

# Stage 3: narrow targeting
SUPPRESS_BINS     = 1

# Clip export
N_PEAK_CLIPS  = 5
CLIP_HALF_S   = 2.0
CROSSFADE_S   = 0.15
CLIP_PEAK_DB  = -12.0

# ── Load ──────────────────────────────────────────────────────────────────────

def load_wav(component):
    path = os.path.join(LAB_DIR, f"psp_magrtn_{component}.wav")
    sr, data = wavfile.read(path)
    data = data.astype(np.float32) / 32768.0
    print(f"Loaded {component}: {sr} Hz  {len(data)} samples  {len(data)/sr:.1f}s")
    return data, int(sr)

# ── STFT ──────────────────────────────────────────────────────────────────────

def make_stft(data, sr, win_size=WIN_SIZE):
    hop = win_size // HOP_FRAC
    freqs, times, Zxx = signal.stft(data, fs=sr, nperseg=win_size,
                                    noverlap=win_size - hop, window='hann')
    pdb = 20 * np.log10(np.abs(Zxx) + 1e-12)
    return freqs, times, pdb, Zxx, hop

# ── Stage 1: Wide temporal accumulation ───────────────────────────────────────

def _bidir_accum(mask, window):
    """Bidirectional running average along time axis. Fully vectorized."""
    n_bins, n_frames = mask.shape
    cs = np.cumsum(mask, axis=1)
    pad = np.zeros((n_bins, window), dtype=np.float32)
    fwd = (cs - np.concatenate([pad, cs[:, :-window]], axis=1)) / window
    cs_r = np.cumsum(mask[:, ::-1], axis=1)
    bwd = (cs_r - np.concatenate([pad, cs_r[:, :-window]], axis=1)) / window
    bwd = bwd[:, ::-1]
    return fwd, bwd

def _label_and_filter(mask, above, min_size, min_power_db):
    """Label connected regions, drop tiny/weak ones, relabel compactly."""
    struct = ndimage.generate_binary_structure(2, 2)  # 8-connectivity
    labeled, n = ndimage.label(mask, structure=struct)
    if n == 0:
        return labeled, 0
    sizes = ndimage.sum(mask, labeled, range(1, n + 1))
    keep = []
    for bid in range(1, n + 1):
        blob_above = above[labeled == bid]
        peak_pwr = blob_above.max() if len(blob_above) > 0 else 0
        if sizes[bid - 1] >= min_size or peak_pwr >= min_power_db:
            keep.append(bid)
    for bid in range(1, n + 1):
        if bid not in keep:
            labeled[labeled == bid] = 0
    if keep:
        remap = np.zeros(n + 1, dtype=int)
        for new_id, old_id in enumerate(sorted(keep), 1):
            remap[old_id] = new_id
        labeled = remap[labeled]
    return labeled, len(keep)

def find_tone_blobs(freqs, times, pdb):
    """
    Multi-signal detection:
      A) Power accumulation: bidirectional running average of above-threshold energy
      B) Peak voting: bidirectional accumulation of local spectral peaks
         (catches pulsing tones that dip below threshold periodically)
    Union of both → connected blobs.
    """
    n_bins, n_frames = pdb.shape

    # ── Flatten 1/f ──
    bg = np.median(pdb, axis=1, keepdims=True)
    pdb_flat = pdb - bg
    print(f"  Flattened: median profile subtracted")

    # ── Local spectral floor ──
    floor = ndimage.percentile_filter(
        pdb_flat, percentile=FLOOR_PERCENTILE,
        size=(2 * FLOOR_HALF_BINS + 1, 1), mode='reflect'
    )
    above = pdb_flat - floor

    # ── Signal A: Multi-scale power accumulation ──
    # Short windows catch fast sweeps, long windows catch slow ones.
    elevated = (above >= ANOMALY_DB).astype(np.float32)
    confirmed_power = np.zeros((n_bins, n_frames), dtype=bool)
    for win, thresh, dil in ACCUM_SCALES:
        dilated = ndimage.maximum_filter1d(elevated, size=dil, axis=0, mode='constant')
        fwd, bwd = _bidir_accum(dilated, win)
        scale_confirmed = (fwd >= thresh) & (bwd >= thresh)
        n_new = scale_confirmed.sum() - (confirmed_power & scale_confirmed).sum()
        confirmed_power |= scale_confirmed
        print(f"  Scale win={win} dil={dil}: +{n_new} new cells")
    print(f"  Power accumulation total: {confirmed_power.sum()} cells")

    # ── Signal B: Spectral peak voting ──
    # A "local peak" = bin is higher than both neighbors in the flattened spectrum
    # (and above some minimal threshold so we're not voting on noise wiggles)
    is_peak = np.zeros_like(pdb_flat, dtype=np.float32)
    is_peak[1:-1, :] = (
        (pdb_flat[1:-1, :] > pdb_flat[:-2, :]) &
        (pdb_flat[1:-1, :] > pdb_flat[2:, :]) &
        (above[1:-1, :] >= PEAK_MIN_DB)          # must be meaningfully above floor
    ).astype(np.float32)

    fwd_v, bwd_v = _bidir_accum(is_peak, PEAK_VOTE_WINDOW)
    confirmed_peaks = (fwd_v >= PEAK_VOTE_THRESHOLD) & (bwd_v >= PEAK_VOTE_THRESHOLD)
    print(f"  Peak voting: {confirmed_peaks.sum()} cells")

    # ── Union ──
    confirmed = confirmed_power | confirmed_peaks
    print(f"  Union: {confirmed.sum()} cells")

    # ── Label and filter blobs ──
    labeled, n_blobs = _label_and_filter(confirmed, above, MIN_BLOB_FRAMES, MIN_BLOB_POWER_DB)
    print(f"  {n_blobs} blob(s) after filtering (min {MIN_BLOB_FRAMES} frames)")

    return labeled, above, n_blobs

# ── Stage 2: Ridge scan — follow regression lines ─────────────────────────────

def _extract_seed_points(labeled, above, n_blobs, freqs, n_frames):
    """From blobs, extract seed ridges: (active_frames, peak_bins, peak_freqs)."""
    hz_per_bin = freqs[1] - freqs[0]
    n_bins = len(freqs)
    seeds = []
    for blob_id in range(1, n_blobs + 1):
        blob_mask = (labeled == blob_id)
        active = np.where(blob_mask.any(axis=0))[0]
        active = active[active < n_frames]
        if len(active) < SCAN_MIN_SEED:
            continue
        pk_bins = np.zeros(len(active), dtype=int)
        pk_freqs = np.zeros(len(active))
        for k, fi in enumerate(active):
            bb = np.where(blob_mask[:, fi])[0]
            if len(bb) == 0:
                continue
            best = np.argmax(above[bb, fi])
            pk_bins[k] = bb[best]
            pk_freqs[k] = freqs[bb[best]]
        seeds.append((active, pk_bins, pk_freqs))
    return seeds

def scan_ridges(freqs, times, above, labeled, n_blobs):
    """
    Stage 2: For each seed blob with enough points:
      1. Fit linear regression (freq vs frame)
      2. Extrapolate forward AND backward in time
      3. At each predicted frame+freq, search for a spectral peak
      4. Extend the ridge as long as peaks are found (with gap tolerance)
      5. Periodically refit the regression with new points
    """
    n_bins, n_frames = above.shape
    hz_per_bin = freqs[1] - freqs[0]

    seeds = _extract_seed_points(labeled, above, n_blobs, freqs, n_frames)
    print(f"  {len(seeds)} seed ridge(s) with ≥{SCAN_MIN_SEED} points")

    # Work on a mutable copy — mask out found ridges so subsequent scans
    # can't latch onto already-claimed tones
    above_work = above.copy()

    ridges = []
    for seed_frames, seed_bins, seed_freqs in seeds:
        # Start with seed points
        all_frames = list(seed_frames)
        all_bins   = list(seed_bins)
        all_freqs  = list(seed_freqs)

        # Fit initial regression: freq_hz = slope * frame_idx + intercept
        coeffs = np.polyfit(seed_frames.astype(float), seed_freqs, 1)

        # Scan in both directions
        for direction in [+1, -1]:
            start_frame = seed_frames[-1] if direction == 1 else seed_frames[0]
            gap_count = 0
            new_count = 0
            fi = start_frame + direction

            while 0 <= fi < n_frames and gap_count < SCAN_GAP_FRAMES:
                # Predict frequency at this frame
                pred_hz = np.polyval(coeffs, float(fi))
                pred_bin = int(round(pred_hz / hz_per_bin))

                if pred_bin < SCAN_SEARCH_BINS or pred_bin >= n_bins - SCAN_SEARCH_BINS:
                    break  # prediction went out of range

                # Search window around prediction
                lo = max(0, pred_bin - SCAN_SEARCH_BINS)
                hi = min(n_bins, pred_bin + SCAN_SEARCH_BINS + 1)
                window = above_work[lo:hi, fi]
                best_local = np.argmax(window)
                best_db = window[best_local]

                if best_db >= SCAN_MIN_DB:
                    # Found a peak — add it
                    actual_bin = lo + best_local
                    all_frames.append(fi)
                    all_bins.append(actual_bin)
                    all_freqs.append(freqs[actual_bin])
                    gap_count = 0
                    new_count += 1

                    # Refit periodically
                    if new_count % SCAN_REFIT_EVERY == 0:
                        coeffs = np.polyfit(
                            np.array(all_frames, dtype=float),
                            np.array(all_freqs), 1)
                else:
                    gap_count += 1

                fi += direction

        # Sort by frame
        order = np.argsort(all_frames)
        r_frames = np.array(all_frames)[order]
        r_bins   = np.array(all_bins)[order]
        r_freqs  = np.array(all_freqs)[order]

        # Deduplicate (same frame can appear from seed + scan)
        _, uniq_idx = np.unique(r_frames, return_index=True)
        r_frames = r_frames[uniq_idx]
        r_bins   = r_bins[uniq_idx]
        r_freqs  = r_freqs[uniq_idx]

        # ── Smooth the trajectory ──
        # Raw argmax jumps to noise; smooth to stay on the real tone.
        # Use Gaussian filter, then snap back to nearest bin.
        if len(r_freqs) >= 5:
            sigma = max(3, len(r_freqs) // 50)  # adaptive: ~2% of length
            r_freqs = ndimage.gaussian_filter1d(r_freqs, sigma=sigma)
            r_bins  = np.round(r_freqs / hz_per_bin).astype(int).clip(0, n_bins - 1)

        # Final regression
        if len(r_frames) >= 3:
            coeffs = np.polyfit(r_frames.astype(float), r_freqs, 1)
            predicted = np.polyval(coeffs, r_frames.astype(float))
            ss_res = np.sum((r_freqs - predicted) ** 2)
            ss_tot = np.sum((r_freqs - r_freqs.mean()) ** 2)
            r_sq = 1 - ss_res / (ss_tot + 1e-9)
            sweep_rate = coeffs[0] * (sr_global / (WIN_SIZE // HOP_FRAC))
        else:
            r_sq = 0.0
            sweep_rate = 0.0

        seed_n = len(seed_frames)
        scan_n = len(r_frames) - seed_n

        ridges.append({
            "active_frames": r_frames,
            "peak_bins":     r_bins,
            "peak_freqs":    r_freqs,
            "freq_range":    (float(r_freqs.min()), float(r_freqs.max())),
            "peak_power_db": float(above[r_bins, r_frames].max()),
            "n_frames":      len(r_frames),
            "seed_frames":   seed_n,
            "scan_frames":   scan_n,
            "trajectory_r2": float(r_sq),
            "sweep_hz_per_s": float(sweep_rate),
        })

        print(f"  Ridge: {r_freqs.min():.1f}–{r_freqs.max():.1f} Hz  "
              f"|  {seed_n} seed + {scan_n} scanned = {len(r_frames)} frames  "
              f"|  sweep {sweep_rate:+.2f} Hz/s  R²={r_sq:.3f}")

        # ── Mask out this ridge so next seeds don't latch onto it ──
        mask_radius = SCAN_SEARCH_BINS + 1
        for fi, pb in zip(r_frames, r_bins):
            lo = max(0, pb - mask_radius)
            hi = min(n_bins, pb + mask_radius + 1)
            above_work[lo:hi, fi] = 0.0

    # ── Parallel scan: try known slopes + extra sweep rates across all freqs ──
    known_sweeps = [(r["sweep_hz_per_s"], r["active_frames"], r["peak_freqs"])
                    for r in ridges if r["n_frames"] >= 50]
    # Also try a grid of sweep rates that covers typical reaction wheel speeds
    extra_rates = np.arange(-3.0, 3.1, 0.25)  # Hz/s
    mid_frame = n_frames // 2
    for rate in extra_rates:
        # Create a synthetic reference: a line through the middle of the spectrogram
        slope_hz_per_frame = rate / (sr_global / (WIN_SIZE // HOP_FRAC))
        ref_f = np.arange(n_frames)
        mid_hz = 1500  # arbitrary center — we'll offset anyway
        ref_hz = mid_hz + (ref_f - mid_frame) * slope_hz_per_frame
        known_sweeps.append((rate, ref_f[::10], ref_hz[::10]))

    parallel_offsets = np.arange(-500, 4001, hz_per_bin * 2)  # scan full spectrum
    parallel_offsets = parallel_offsets[parallel_offsets != 0]

    for sweep_rate, ref_frames, ref_freqs in known_sweeps:
        slope_bins_per_frame = sweep_rate / (sr_global / (WIN_SIZE // HOP_FRAC)) / hz_per_bin
        for offset_hz in parallel_offsets:
            offset_bins = int(round(offset_hz / hz_per_bin))
            # Check: is there energy along this parallel line?
            hit_count = 0
            test_frames = ref_frames[::5]  # sample every 5th frame
            for fi in test_frames:
                if fi >= n_frames:
                    continue
                pred_bin = int(round(ref_freqs[np.searchsorted(ref_frames, fi)] / hz_per_bin)) + offset_bins
                if pred_bin < 1 or pred_bin >= n_bins - 1:
                    continue
                if above_work[pred_bin, fi] >= SCAN_MIN_DB:
                    hit_count += 1
            hit_frac = hit_count / max(len(test_frames), 1)
            if hit_frac < 0.3:
                continue

            # Found a parallel tone — do a full scan along it
            mid_frame = ref_frames[len(ref_frames) // 2]
            mid_freq = ref_freqs[len(ref_freqs) // 2] + offset_hz
            # Build seed: just 3 points along the line
            seed_f = np.array([ref_frames[0], mid_frame, ref_frames[-1]])
            seed_hz = np.array([ref_freqs[0] + offset_hz,
                                mid_freq,
                                ref_freqs[-1] + offset_hz])
            coeffs = np.polyfit(seed_f.astype(float), seed_hz, 1)

            all_frames, all_bins, all_freqs = [], [], []
            for direction in [+1, -1]:
                start = mid_frame
                gap_count = 0
                fi = start + direction
                while 0 <= fi < n_frames and gap_count < SCAN_GAP_FRAMES:
                    pred_hz = np.polyval(coeffs, float(fi))
                    pred_bin = int(round(pred_hz / hz_per_bin))
                    if pred_bin < SCAN_SEARCH_BINS or pred_bin >= n_bins - SCAN_SEARCH_BINS:
                        break
                    lo = max(0, pred_bin - SCAN_SEARCH_BINS)
                    hi = min(n_bins, pred_bin + SCAN_SEARCH_BINS + 1)
                    window = above_work[lo:hi, fi]
                    best_local = np.argmax(window)
                    if window[best_local] >= SCAN_MIN_DB:
                        actual_bin = lo + best_local
                        all_frames.append(fi)
                        all_bins.append(actual_bin)
                        all_freqs.append(freqs[actual_bin])
                        gap_count = 0
                    else:
                        gap_count += 1
                    fi += direction

            if len(all_frames) < 50:
                continue

            order = np.argsort(all_frames)
            r_frames = np.array(all_frames)[order]
            r_bins = np.array(all_bins)[order]
            r_freqs = np.array(all_freqs)[order]
            _, ui = np.unique(r_frames, return_index=True)
            r_frames, r_bins, r_freqs = r_frames[ui], r_bins[ui], r_freqs[ui]

            if len(r_freqs) >= 5:
                sigma = max(3, len(r_freqs) // 50)
                r_freqs = ndimage.gaussian_filter1d(r_freqs, sigma=sigma)
                r_bins = np.round(r_freqs / hz_per_bin).astype(int).clip(0, n_bins - 1)

            if len(r_frames) >= 3:
                c = np.polyfit(r_frames.astype(float), r_freqs, 1)
                pred = np.polyval(c, r_frames.astype(float))
                ss_r = np.sum((r_freqs - pred) ** 2)
                ss_t = np.sum((r_freqs - r_freqs.mean()) ** 2)
                r_sq = 1 - ss_r / (ss_t + 1e-9)
                sw = c[0] * (sr_global / (WIN_SIZE // HOP_FRAC))
            else:
                r_sq, sw = 0, 0

            ridges.append({
                "active_frames": r_frames, "peak_bins": r_bins,
                "peak_freqs": r_freqs,
                "freq_range": (float(r_freqs.min()), float(r_freqs.max())),
                "peak_power_db": float(above[r_bins, r_frames].max()),
                "n_frames": len(r_frames), "seed_frames": 0,
                "scan_frames": len(r_frames),
                "trajectory_r2": float(r_sq), "sweep_hz_per_s": float(sw),
            })
            print(f"  Parallel: {r_freqs.min():.1f}–{r_freqs.max():.1f} Hz  "
                  f"|  {len(r_frames)} frames  |  sweep {sw:+.2f} Hz/s  "
                  f"R²={r_sq:.3f}  (offset {offset_hz:+.0f} Hz)")

            # Mask it
            for fi, pb in zip(r_frames, r_bins):
                lo = max(0, pb - SCAN_SEARCH_BINS - 1)
                hi = min(n_bins, pb + SCAN_SEARCH_BINS + 2)
                above_work[lo:hi, fi] = 0.0

    # ── Merge duplicate ridges (same tone found from different seeds) ──
    # If two ridges have similar sweep rates and overlapping frame ranges, keep the longer one
    merged = []
    used = set()
    ridges.sort(key=lambda r: -r["n_frames"])  # longest first
    for i, r in enumerate(ridges):
        if i in used:
            continue
        for j, other in enumerate(ridges):
            if j <= i or j in used:
                continue
            # Similar sweep rate?
            if abs(r["sweep_hz_per_s"] - other["sweep_hz_per_s"]) < 0.5:
                # Overlapping frames?
                overlap = np.intersect1d(r["active_frames"], other["active_frames"])
                if len(overlap) > min(len(r["active_frames"]), len(other["active_frames"])) * 0.3:
                    used.add(j)
                    print(f"  Merged duplicate ridge (sweep {other['sweep_hz_per_s']:+.2f} Hz/s)")
        merged.append(r)

    # Drop ridges the scanner couldn't extend (< 50 total frames = probably noise)
    final = [r for r in merged if r["n_frames"] >= 50]
    dropped = len(merged) - len(final)
    if dropped:
        print(f"  Dropped {dropped} short ridge(s) (< 50 frames after scan)")
    print(f"  {len(final)} ridge(s) final")
    return final

# Global sr reference for sweep rate calc (set in main)
sr_global = 22000

# ── Stage 3: Suppress along scanned ridges ────────────────────────────────────

def suppress_ridges_stft(data, sr, ridges, freqs, hop):
    win_size = (len(freqs) - 1) * 2
    hz_per_bin = freqs[1] - freqs[0]
    _, _, Zxx = signal.stft(data, fs=sr, nperseg=win_size,
                            noverlap=win_size - hop, window='hann')
    Zxx_clean = Zxx.copy()
    n_bins, n_frames = Zxx_clean.shape
    mag = np.abs(Zxx)

    # Recompute above-floor for width profiling
    bg = np.median(20 * np.log10(mag + 1e-12), axis=1, keepdims=True)
    pdb_flat = 20 * np.log10(mag + 1e-12) - bg

    total_zeroed = 0

    for ridge in ridges:
        af = ridge["active_frames"]
        pb = ridge["peak_bins"]
        af = af[af < n_frames]
        pb = pb[:len(af)]

        # Width profiling: at each frame, expand from peak bin outward
        # while bins remain elevated (> SCAN_MIN_DB above floor).
        # This catches wider tones and parallel sidebands.
        for k in range(len(af)):
            fi, center = af[k], pb[k]
            # Expand downward
            lo = center
            while lo > 0 and pdb_flat[lo - 1, fi] >= SCAN_MIN_DB / 2:
                lo -= 1
            # Expand upward
            hi = center + 1
            while hi < n_bins and pdb_flat[hi, fi] >= SCAN_MIN_DB / 2:
                hi += 1
            # Always suppress at least ±SUPPRESS_BINS
            lo = min(lo, max(0, center - SUPPRESS_BINS))
            hi = max(hi, min(n_bins, center + SUPPRESS_BINS + 1))
            Zxx_clean[lo:hi, fi] = 0.0
            total_zeroed += hi - lo

    print(f"  Zeroed {total_zeroed} bin-frame cells")

    _, data_clean = signal.istft(Zxx_clean, fs=sr, nperseg=win_size,
                                  noverlap=win_size - hop, window='hann')
    data_clean = data_clean[:len(data)].astype(np.float32)
    if len(data_clean) < len(data):
        data_clean = np.pad(data_clean, (0, len(data) - len(data_clean)))
    return data_clean

# ── Clip export ───────────────────────────────────────────────────────────────

def export_peak_clips(data_orig, data_clean, sr, ridge_info, times, hop):
    clip_samples = int(CLIP_HALF_S * sr)
    cf_samples   = int(CROSSFADE_S * sr)
    n_samples    = len(data_orig)
    n_frames     = len(times)
    target_peak  = 10 ** (CLIP_PEAK_DB / 20.0)

    # Score frames by peak power across all ridges
    tone_score = np.zeros(n_frames)
    for r in ridge_info:
        af = r["active_frames"]
        af = af[af < n_frames]
        # Use peak_power_db as weight for those frames
        tone_score[af] = np.maximum(tone_score[af], r["peak_power_db"])

    min_gap = int(CLIP_HALF_S * 2 * sr / hop)
    peaks, sc = [], tone_score.copy()
    for _ in range(N_PEAK_CLIPS):
        if sc.max() == 0: break
        fi = int(np.argmax(sc))
        peaks.append(fi)
        sc[max(0, fi - min_gap):min(n_frames, fi + min_gap)] = 0

    xfade_out = np.linspace(1, 0, cf_samples).astype(np.float32)
    xfade_in  = np.linspace(0, 1, cf_samples).astype(np.float32)

    for i, fi in enumerate(peaks):
        center = int(fi * hop)
        lo = max(0, center - clip_samples)
        hi = min(n_samples, center + clip_samples)

        raw   = data_orig[lo:hi].copy()
        clean = data_clean[lo:hi].copy()

        fade_len = min(cf_samples, len(raw), len(clean))
        raw[-fade_len:]  *= xfade_out[-fade_len:]
        clean[:fade_len] *= xfade_in[:fade_len]
        combined = np.concatenate([raw, clean])

        pk = np.max(np.abs(combined))
        if pk > 0:
            combined *= target_peak / pk
        combined_i = (combined * 32767).clip(-32768, 32767).astype(np.int16)

        # Find dominant ridge at this frame
        best = max(ridge_info, key=lambda r: r["peak_power_db"] if fi in r["active_frames"] else 0)
        hz = best["freq_range"][0]
        for r in ridge_info:
            idx = np.searchsorted(r["active_frames"], fi)
            if idx < len(r["active_frames"]) and r["active_frames"][idx] == fi:
                hz = r["peak_freqs"][idx]
                break

        fname = os.path.join(LAB_DIR, f"clip_{i+1:02d}_frame{fi}_{hz:.0f}hz.wav")
        wavfile.write(fname, sr, combined_i)

        r_rms = 20 * np.log10(np.sqrt(np.mean(data_orig[lo:hi]**2)) + 1e-12)
        c_rms = 20 * np.log10(np.sqrt(np.mean(data_clean[lo:hi]**2)) + 1e-12)
        print(f"  Clip {i+1}: ~{hz:.1f} Hz  raw {r_rms:.1f} → clean {c_rms:.1f} dB  "
              f"→ {os.path.basename(fname)}")

# ── Plots ─────────────────────────────────────────────────────────────────────

def plot_results(data_orig, data_clean, sr, ridge_info, freqs, times, pdb_orig):
    _, _, pdb_c, _, _ = make_stft(data_clean, sr)
    vmin, vmax = np.percentile(pdb_orig, [5, 99])

    # Auto-zoom on detected tones
    all_lo = [r["freq_range"][0] for r in ridge_info]
    all_hi = [r["freq_range"][1] for r in ridge_info]
    if all_lo:
        zoom_lo = max(1, min(all_lo) * 0.7)
        zoom_hi = max(all_hi) * 1.3
    else:
        zoom_lo, zoom_hi = 1, freqs[-1]

    # Square root scale: between linear and log
    sqrt_fwd = lambda x: np.sqrt(np.maximum(x, 0))
    sqrt_inv = lambda x: x ** 2

    fig, axes = plt.subplots(2, 2, figsize=(18, 10))
    fig.suptitle(f"PSP {COMPONENT} — Two-Stage Spin Tone Detection", fontsize=12)

    # Full spectrograms (sqrt freq scale, labels on right)
    for ax, pdb_data, title in [
        (axes[0, 0], pdb_orig, "Original (full)"),
        (axes[0, 1], pdb_c,    "Suppressed (full)"),
    ]:
        ax.pcolormesh(times, freqs[:pdb_data.shape[0]], pdb_data,
                      shading='auto', vmin=vmin, vmax=vmax, cmap='inferno')
        ax.set_yscale('function', functions=(sqrt_fwd, sqrt_inv))
        ax.set_ylim(max(freqs[1], 1), freqs[-1])
        ax.set_title(title)
        ax.yaxis.tick_right()
        ax.yaxis.set_label_position('right')
        ax.set_ylabel("Freq (Hz)")
        if 'Original' in title:
            for r in ridge_info:
                ax.plot(times[r["active_frames"]], r["peak_freqs"],
                        color='cyan', lw=0.8, alpha=0.9)

    # Zoomed spectrograms (sqrt scale too, labels on right)
    for ax, pdb_data, title in [
        (axes[1, 0], pdb_orig, f"Original ZOOM ({zoom_lo:.0f}–{zoom_hi:.0f} Hz)"),
        (axes[1, 1], pdb_c,    f"Suppressed ZOOM"),
    ]:
        ax.pcolormesh(times, freqs[:pdb_data.shape[0]], pdb_data,
                      shading='auto', vmin=vmin, vmax=vmax, cmap='inferno')
        ax.set_yscale('function', functions=(sqrt_fwd, sqrt_inv))
        ax.set_ylim(zoom_lo, zoom_hi)
        ax.set_title(title)
        ax.set_xlabel("Time (s)")
        ax.yaxis.tick_right()
        ax.yaxis.set_label_position('right')
        if 'Original' in title:
            for r in ridge_info:
                ax.plot(times[r["active_frames"]], r["peak_freqs"],
                        color='cyan', lw=1.2, alpha=0.9,
                        label=f"{r['freq_range'][0]:.0f}–{r['freq_range'][1]:.0f} Hz")
            ax.legend(fontsize=7, loc='upper right')
            ax.set_ylabel("Freq (Hz)")

    plt.tight_layout()
    out = os.path.join(LAB_DIR, "spectrogram_comparison.png")
    plt.savefig(out, dpi=150); plt.close()
    print(f"Saved → {out}")

# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    global sr_global
    data, sr = load_wav(COMPONENT)
    sr_global = sr

    print(f"\n── STFT (win={WIN_SIZE}, {sr/WIN_SIZE:.2f} Hz/bin) ──")
    freqs, times, pdb, Zxx, hop = make_stft(data, sr)
    print(f"  {pdb.shape}  hop={hop}  dt={times[1]-times[0]:.4f}s")

    print("\n── Stage 1: Wide temporal accumulation ──")
    labeled, above, n_blobs = find_tone_blobs(freqs, times, pdb)

    if n_blobs == 0:
        print("No tone blobs found.")
        return

    print(f"\n── Stage 2: Ridge scan — follow regression lines ──")
    ridges = scan_ridges(freqs, times, above, labeled, n_blobs)

    if not ridges:
        print("No ridges survived scan.")
        return

    print(f"\n── Stage 3: STFT suppression ──")
    data_clean = suppress_ridges_stft(data, sr, ridges, freqs, hop)

    rms_b = 20 * np.log10(np.sqrt(np.mean(data**2)) + 1e-12)
    rms_a = 20 * np.log10(np.sqrt(np.mean(data_clean**2)) + 1e-12)
    print(f"  RMS: {rms_b:.1f} → {rms_a:.1f} dB  ({rms_a - rms_b:+.1f} dB)")

    print("\n── Peak clips ──")
    for f in os.listdir(LAB_DIR):
        if f.startswith("clip_") and f.endswith(".wav"):
            os.remove(os.path.join(LAB_DIR, f))
    export_peak_clips(data, data_clean, sr, ridges, times, hop)

    print("\n── Spectrogram ──")
    plot_results(data, data_clean, sr, ridges, freqs, times, pdb)

    print("\nDone.")

if __name__ == "__main__":
    main()
