#!/usr/bin/env python3
"""
Wavelet Phase Vocoder for EMIC Study Region (2022-08-17 to 2022-08-24)
Fetches GOES-16 Bx magnetometer data from CDAWeb, audifies, and applies
wavelet time-stretch with Morlet w0=10 (Robert's preferred setting).

Outputs: WAV files at 0.75x and 0.5x playback speed.
Uses streaming ICWT to keep memory under control (~17 GB peak).

Usage:
    python3 emic_wavelet_stretch.py
"""
import sys
import os
import time
import tempfile
from datetime import datetime, timedelta

import numpy as np
import requests
import cdflib
from scipy.io import wavfile
from scipy.interpolate import interp1d

# Add parent for wavelet imports
sys.path.insert(0, os.path.dirname(__file__))

# Inline Morlet + CWT to avoid relative import issues
import scipy.optimize
import scipy.signal


class Morlet:
    def __init__(self, w0=6):
        self.w0 = w0
        if w0 == 6:
            self.C_d = 0.776

    def __call__(self, *args, **kwargs):
        return self.time(*args, **kwargs)

    def time(self, t, s=1.0, complete=False):
        x = t / s
        output = np.exp(1j * self.w0 * x)
        if complete:
            output -= np.exp(-0.5 * (self.w0 ** 2))
        output *= np.exp(-0.5 * (x ** 2)) * np.pi ** (-0.25)
        return output

    def fourier_period(self, s):
        return 4 * np.pi * s / (self.w0 + (2 + self.w0 ** 2) ** .5)


def generate_scales(data_length, dj, dt, wavelet):
    def smallest_scale(dt, w):
        def f(s):
            return w.fourier_period(s) - 2 * dt
        return scipy.optimize.fsolve(f, 1)[0]

    s0 = smallest_scale(dt, wavelet)
    J = int((1 / dj) * np.log2(data_length * dt / s0))
    return s0 * 2 ** (dj * np.arange(0, J + 1))


def cwt(x, scales, dt, wavelet):
    """Forward CWT with progress reporting."""
    n_scales = len(scales)
    n_samples = len(x)
    output = np.empty((n_scales, n_samples), dtype=np.complex128)

    for i, s in enumerate(scales):
        if i % 20 == 0:
            print(f"  CWT: scale {i+1}/{n_scales} ({100*(i+1)/n_scales:.0f}%)", flush=True)
        pts = int(10 * s / dt)
        times = np.arange((-pts + 1) / 2., (pts + 1) / 2.) * dt
        norm = (dt ** 0.5) / s
        w = norm * wavelet(times, s)
        output[i] = scipy.signal.fftconvolve(x, w, mode='same')

    print(f"  CWT: done — {n_scales} scales × {n_samples:,} samples", flush=True)
    return output


def streaming_stretch_icwt(coefficients, stretch_factor, dj, dt):
    """
    Streaming ICWT: interpolate and accumulate one scale at a time.
    Avoids holding the full interpolated coefficient matrix in memory.
    """
    n_scales, n_samples = coefficients.shape
    n_out = int(n_samples * stretch_factor)
    running_sum = np.zeros(n_out, dtype=np.float64)

    original_steps = np.linspace(0, 1, n_samples)
    new_steps = np.linspace(0, 1, n_out)

    for i in range(n_scales):
        if i % 20 == 0:
            print(f"  Stretch+ICWT: scale {i+1}/{n_scales} ({100*(i+1)/n_scales:.0f}%)", flush=True)

        mag = np.abs(coefficients[i])
        phase = np.unwrap(np.angle(coefficients[i]))

        # Interpolate this scale
        f_mag = interp1d(original_steps, mag, kind='cubic')
        f_phase = interp1d(original_steps, phase, kind='cubic')

        new_mag = f_mag(new_steps)
        new_phase = f_phase(new_steps)

        # Reconstruct with phase shift and accumulate
        shifted = new_mag * np.cos(new_phase * stretch_factor)
        running_sum += shifted

    # Apply ICWT scaling
    result = (dj * dt ** 0.5) * running_sum
    print(f"  Stretch+ICWT: done — {n_out:,} output samples", flush=True)
    return result


# =============================================================================
# CDAWeb Data Fetching
# =============================================================================

CDAWEB_BASE = "https://cdaweb.gsfc.nasa.gov/WS/cdasr/1"
DATAVIEW = "sp_phys"
DATASET = "DN_MAGN-L2-HIRES_G16"
VARIABLE = "b_gse"
SAMPLE_RATE = 10  # Hz
FILL_VALUE = -9999.0


def fetch_day(date_str):
    """Download one day of GOES-16 Bx mag data from CDAWeb."""
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    start = dt.strftime("%Y%m%dT000000Z")
    end = (dt + timedelta(days=1)).strftime("%Y%m%dT000000Z")

    api_url = (
        f"{CDAWEB_BASE}/dataviews/{DATAVIEW}/datasets/{DATASET}"
        f"/data/{start},{end}/{VARIABLE}?format=cdf"
    )

    print(f"  📡 Fetching {date_str} from CDAWeb...", flush=True)
    resp = requests.get(api_url, headers={"Accept": "application/json"}, timeout=120)
    resp.raise_for_status()

    files = resp.json().get("FileDescription", [])
    if not files:
        raise RuntimeError(f"No CDF files for {date_str}")

    cdf_url = files[0]["Name"]
    print(f"  📥 Downloading CDF...", flush=True)
    cdf_resp = requests.get(cdf_url, timeout=300)
    cdf_resp.raise_for_status()

    tmp = tempfile.NamedTemporaryFile(suffix=".cdf", delete=False)
    tmp.write(cdf_resp.content)
    tmp.close()

    cdf = cdflib.CDF(tmp.name)
    b_gse = cdf.varget(VARIABLE)  # shape (N, 3)

    expected = 24 * 3600 * SAMPLE_RATE
    if b_gse.shape[0] > expected:
        b_gse = b_gse[:expected]

    bx = b_gse[:, 0].astype(np.float64)

    # Replace fill values with interpolated
    fill_mask = bx <= FILL_VALUE
    if np.any(fill_mask):
        nans = fill_mask
        valid = np.where(~nans)[0]
        if len(valid) > 0:
            bx[nans] = np.interp(np.where(nans)[0], valid, bx[valid])
        fill_pct = np.sum(fill_mask) / len(bx) * 100
        print(f"  🩹 Interpolated {np.sum(fill_mask):,} fill values ({fill_pct:.2f}%)", flush=True)

    os.unlink(tmp.name)
    print(f"  ✅ {date_str}: {len(bx):,} Bx samples", flush=True)
    return bx


def fetch_emic_region():
    """Fetch 7 days of GOES-16 Bx for EMIC study: 2022-08-17 to 2022-08-24."""
    start = datetime(2022, 8, 17)
    all_bx = []

    for day in range(7):
        date_str = (start + timedelta(days=day)).strftime("%Y-%m-%d")
        bx = fetch_day(date_str)
        all_bx.append(bx)

    combined = np.concatenate(all_bx)
    print(f"\n📊 Total: {len(combined):,} samples ({len(combined)/SAMPLE_RATE/3600:.1f} hours)", flush=True)
    return combined


# =============================================================================
# Main
# =============================================================================

def main():
    t_start = time.time()

    # Settings
    W0 = 10
    DJ = 0.12
    AUDIO_SAMPLE_RATE = 44100
    OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "emic_audio")
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    speeds = [
        (0.75, 1.0 / 0.75),  # 0.75x speed = 1.333x stretch
        (0.50, 1.0 / 0.50),  # 0.50x speed = 2.0x stretch
    ]

    # Step 1: Fetch data
    print("=" * 60)
    print("STEP 1: Fetching GOES-16 Bx data (2022-08-17 to 2022-08-24)")
    print("=" * 60, flush=True)
    bx = fetch_emic_region()

    # Step 2: Forward CWT
    print("\n" + "=" * 60)
    print(f"STEP 2: Forward CWT (w0={W0}, dj={DJ})")
    print("=" * 60, flush=True)
    dt = 1.0 / SAMPLE_RATE
    wavelet = Morlet(w0=W0)
    scales = generate_scales(len(bx), DJ, dt, wavelet)
    print(f"  Scales: {len(scales)}, samples: {len(bx):,}")
    est_mem = len(scales) * len(bx) * 16 / 1e9
    print(f"  Estimated CWT memory: {est_mem:.1f} GB", flush=True)

    coefficients = cwt(bx, scales, dt, wavelet)
    t_cwt = time.time()
    print(f"  CWT completed in {t_cwt - t_start:.0f}s\n", flush=True)

    # Step 3: Stretch + ICWT for each speed
    for speed, stretch in speeds:
        print("=" * 60)
        print(f"STEP 3: Wavelet stretch for {speed}x speed (stretch={stretch:.3f}x)")
        print("=" * 60, flush=True)

        t_stretch_start = time.time()
        stretched = streaming_stretch_icwt(coefficients, stretch, DJ, dt)

        # Normalize
        peak = np.max(np.abs(stretched))
        if peak > 0:
            stretched = stretched / peak

        # Save as 16-bit WAV at 44100 Hz
        # The data is 10 Hz played back at 44100 Hz (audification)
        # So we write the samples and set the sample rate to 44100
        audio_int16 = (stretched * 32767).astype(np.int16)

        filename = f"GOES16_Bx_EMIC_7day_20220817-20220824_wavelet_w0-{W0}_{speed}x.wav"
        filepath = os.path.join(OUTPUT_DIR, filename)
        wavfile.write(filepath, AUDIO_SAMPLE_RATE, audio_int16)

        duration = len(audio_int16) / AUDIO_SAMPLE_RATE
        t_stretch_end = time.time()
        print(f"\n  ✅ Saved: {filename}")
        print(f"     Duration: {duration:.1f}s, samples: {len(audio_int16):,}")
        print(f"     Stretch took {t_stretch_end - t_stretch_start:.0f}s\n", flush=True)

    t_total = time.time() - t_start
    print("=" * 60)
    print(f"DONE! Total time: {t_total:.0f}s ({t_total/60:.1f} min)")
    print(f"Output directory: {OUTPUT_DIR}")
    print("=" * 60, flush=True)


if __name__ == "__main__":
    main()
