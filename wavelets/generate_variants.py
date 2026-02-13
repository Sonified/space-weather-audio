#!/usr/bin/env python3
"""
Generate wavelet phase vocoder variants with different settings.
"""
import numpy as np
from scipy.io import wavfile
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from wavelets.wavelets import Morlet
from wavelets.transform import generateCwtScales, cwt, icwt, interpolateCoeffs

TSM_FACTOR = 2.0
input_file = "../stretch_test_audio/Julia_Run_8.wav"
output_dir = "stretched_audio"
os.makedirs(output_dir, exist_ok=True)

# Load once
sample_rate, audio_data = wavfile.read(input_file)
if len(audio_data.shape) > 1:
    audio_data = audio_data.mean(axis=1)
audio_data = audio_data.astype(np.float64) / 32768.0
sample_spacing = 1.0 / sample_rate
print(f"Loaded: {sample_rate}Hz, {len(audio_data)} samples, {len(audio_data)/sample_rate:.2f}s\n")

# Variants: (name, w0, scaleSpacingLog)
variants = [
    ("w0-6_dj-0.10",   6,  0.10),   # current baseline
    ("w0-6_dj-0.05",   6,  0.05),   # denser scales
    ("w0-6_dj-0.025",  6,  0.025),  # very dense scales
    ("w0-10_dj-0.10",  10, 0.10),   # higher freq resolution
    ("w0-10_dj-0.05",  10, 0.05),   # higher freq res + denser
    ("w0-4_dj-0.10",   4,  0.10),   # better time resolution
]

for name, w0, dj in variants:
    print(f"=== {name} (w0={w0}, dj={dj}) ===")
    morlet = Morlet(w0=w0)

    scales = generateCwtScales(
        maxNumberSamples=None,
        dataLength=len(audio_data),
        scaleSpacingLog=dj,
        sampleSpacingTime=sample_spacing,
        waveletFunction=morlet
    )
    print(f"  Scales: {len(scales)}")

    print(f"  CWT...")
    coefficients = cwt(audio_data, scales, sampleSpacingTime=sample_spacing, waveletFunction=morlet)

    print(f"  Interpolating...")
    stretched_coeffs = interpolateCoeffs(coefficients, interpolate_factor=TSM_FACTOR)

    print(f"  Phase correction...")
    magnitude = np.abs(stretched_coeffs)
    phase = np.angle(stretched_coeffs)
    unwrapped_phase = np.unwrap(phase, axis=1)
    corrected_phase = unwrapped_phase * TSM_FACTOR
    corrected_coeffs = magnitude * np.exp(1j * corrected_phase)

    print(f"  ICWT...")
    stretched_audio = icwt(corrected_coeffs, scaleLogSpacing=dj, sampleSpacingTime=sample_spacing)

    peak = np.max(np.abs(stretched_audio))
    if peak > 0:
        stretched_audio = stretched_audio / peak

    out_path = os.path.join(output_dir, f"Julia_2x_{name}.wav")
    wavfile.write(out_path, sample_rate, (stretched_audio * 32767).astype(np.int16))
    print(f"  Saved: {out_path}\n")

print("Done — all variants generated.")
