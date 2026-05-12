#!/usr/bin/env python3
"""
Audification post-processor for THEMIS WAV files.

Takes a raw audified WAV (e.g. from Xueling's pipeline) and applies:
  1. Zero-phase high-pass filter (removes DC offset + low-freq drift)
  2. Cosine taper at edges (fade in/out)
  3. Peak normalization to [-1, 1]

The high-pass filter uses scipy's sosfiltfilt, which runs the filter
forward and then backward across the signal. This "zero-phase" approach
means the filter removes unwanted low frequencies without shifting the
timing of the EMIC wave features -- important for comparing events.

The cosine taper smoothly fades the signal to zero at the start and end,
preventing clicks/pops from abrupt signal edges. The taper shape is a
raised cosine (Tukey window), so the transition is smooth, not linear.

Normalization scales the peak amplitude to 1.0 so the full dynamic range
of the WAV format is used, regardless of the original signal amplitude.

Usage:
    python process_audified_wav.py input.wav                  # writes input_processed.wav
    python process_audified_wav.py input.wav -o output.wav    # explicit output path
    python process_audified_wav.py input.wav --taper 0.05     # 5% taper (default 2%)
    python process_audified_wav.py input.wav --hp-freq 30     # 30 Hz highpass (default 20)
    python process_audified_wav.py input.wav --hp-order 4     # steeper roll-off (default 2)

Requirements:
    pip install numpy scipy
"""

import argparse
import numpy as np
import scipy.io.wavfile as wav
from scipy.signal import butter, sosfiltfilt
from pathlib import Path

# ============================================================================
# Configuration -- change these defaults in one place
#
# These values are used when no command-line arguments are provided.
# They can all be overridden per-run via CLI flags (see --help).
# ============================================================================

HIGHPASS_FREQ = 20       # Hz (audio-domain cutoff frequency)
                         # 20 Hz is below the range of human hearing, so it
                         # removes DC drift without affecting audible content.

HIGHPASS_ORDER = 2       # Butterworth filter order.
                         # sosfiltfilt runs the filter twice (forward + backward),
                         # which doubles the effective order:
                         #   order 1 -> 12 dB/oct effective (gentle slope)
                         #   order 2 -> 24 dB/oct effective (good default)
                         #   order 4 -> 48 dB/oct effective (steep, surgical)
                         # Higher orders cut more sharply at the cutoff frequency
                         # but can introduce ringing near the cutoff if too aggressive.

TAPER_FRACTION = 0.02    # Fraction of total signal length to taper at EACH edge.
                         #   0.02 = 2% fade-in at start + 2% fade-out at end
                         #   0.05 = 5% at each edge (more conservative)
                         # For a 12-second file at 2%, that's ~0.24s of fade.


def highpass_zero_phase(data, sample_rate, cutoff=HIGHPASS_FREQ, order=HIGHPASS_ORDER):
    """
    Zero-phase Butterworth high-pass filter.

    Uses sosfiltfilt (second-order sections, forward-backward) to avoid
    phase distortion. The result has zero group delay -- peaks and troughs
    in the filtered signal align exactly with the original data in time.
    """
    nyq = sample_rate / 2.0
    if cutoff >= nyq:
        print(f"  Warning: cutoff {cutoff} Hz >= Nyquist {nyq} Hz, skipping filter")
        return data

    # Design the Butterworth filter as second-order sections (SOS).
    # SOS form is more numerically stable than transfer function (b, a) form,
    # especially for higher orders.
    sos = butter(order, cutoff / nyq, btype='high', output='sos')

    # Apply forward-backward (zero-phase) filtering
    return sosfiltfilt(sos, data, axis=0).astype(np.float32)


def cosine_taper(data, fraction=TAPER_FRACTION):
    """
    Apply a raised-cosine (Tukey) taper at both edges of the signal.

    The window goes from 0 to 1 over `fraction * len(data)` samples at each
    edge, using a cosine curve. The middle of the signal is untouched (gain = 1).
    This prevents spectral leakage and audible clicks at file boundaries.
    """
    n = len(data)
    taper_len = int(n * fraction)
    if taper_len < 2:
        return data
    out = data.copy()
    for i in range(taper_len):
        # Raised cosine: 0 at edge, smoothly rises to 1
        w = 0.5 * (1 - np.cos(np.pi * i / taper_len))
        out[i] *= w              # fade in at start
        out[n - 1 - i] *= w     # fade out at end
    return out


def normalize(data):
    """
    Peak-normalize the signal so the loudest sample hits +/-1.0.

    This maximizes the dynamic range in the output WAV without clipping.
    """
    peak = np.max(np.abs(data))
    if peak == 0:
        return data
    return data / peak


def process(input_path, output_path=None, hp_freq=HIGHPASS_FREQ,
            hp_order=HIGHPASS_ORDER, taper=TAPER_FRACTION):
    input_path = Path(input_path)
    if output_path is None:
        output_path = input_path.with_stem(input_path.stem + '_processed')

    # --- Read ---
    rate, raw = wav.read(input_path)
    print(f"Input:  {input_path.name}")
    print(f"  Sample rate: {rate} Hz | Samples: {len(raw)} | Duration: {len(raw)/rate:.2f}s")

    # Convert integer WAV samples to float32 in [-1, 1] range for processing.
    # scipy.io.wavfile returns int16 or int32 for PCM files, float for float WAVs.
    if raw.dtype == np.int16:
        data = raw.astype(np.float32) / 32768.0
    elif raw.dtype == np.int32:
        data = raw.astype(np.float32) / 2147483648.0
    elif raw.dtype == np.float32 or raw.dtype == np.float64:
        data = raw.astype(np.float32)
    else:
        data = raw.astype(np.float32)

    dc_before = np.mean(data)
    print(f"  DC offset before: {dc_before:.6f}")

    # --- Step 1: High-pass filter (zero-phase) ---
    # Removes DC offset and any slow baseline drift from the magnetometer data.
    data = highpass_zero_phase(data, rate, cutoff=hp_freq, order=hp_order)
    dc_after = np.mean(data)
    print(f"  DC offset after HP {hp_freq} Hz (order {hp_order}, {hp_order*12} dB/oct effective): {dc_after:.6f}")

    # --- Step 2: Cosine taper ---
    # Fade in/out at edges to avoid clicks from abrupt signal boundaries.
    data = cosine_taper(data, fraction=taper)
    print(f"  Taper: {taper*100:.1f}% each edge ({int(len(data)*taper)} samples)")

    # --- Step 3: Normalize ---
    # Scale to full [-1, 1] range so the output WAV uses its full dynamic range.
    data = normalize(data)

    # --- Write ---
    # 32-bit float WAV preserves full precision (no quantization to 16-bit).
    wav.write(str(output_path), rate, data)
    print(f"Output: {output_path.name} ({output_path.stat().st_size / 1024:.0f} KB)")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Post-process audified WAV files')
    parser.add_argument('input', help='Input WAV file')
    parser.add_argument('-o', '--output', help='Output WAV file (default: input_processed.wav)')
    parser.add_argument('--hp-freq', type=float, default=HIGHPASS_FREQ,
                        help=f'High-pass cutoff in Hz (default: {HIGHPASS_FREQ})')
    parser.add_argument('--hp-order', type=int, default=HIGHPASS_ORDER,
                        help=f'Butterworth order, effective is 2x due to filtfilt (default: {HIGHPASS_ORDER})')
    parser.add_argument('--taper', type=float, default=TAPER_FRACTION,
                        help=f'Taper fraction per edge (default: {TAPER_FRACTION})')
    args = parser.parse_args()
    process(args.input, args.output, args.hp_freq, args.hp_order, args.taper)
