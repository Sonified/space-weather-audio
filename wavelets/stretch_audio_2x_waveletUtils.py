#!/usr/bin/env python3
"""
Wavelet Phase Vocoder time-stretch using the HARP ps_utils approach.

From _waveletPitchShift in ps_utils.py:
1. CWT
2. Decompose to magnitude + UNWRAPPED phase
3. Interpolate magnitude and phase separately in POLAR form
4. Multiply phase by shift factor
5. Recombine and ICWT with proper scaling (C_d, wavelet.time(0))

Reference: "A Wavelet-based Pitch-shifting Method" - Alexander G. Sklar
"""
import numpy as np
from scipy.io import wavfile
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from wavelets.wavelets import Morlet
from wavelets.transform import (
    generateCwtScales, cwt, icwt, interpolateCoeffsPolar
)

TSM_FACTOR = 2.0

input_file = "../stretch_test_audio/Julia_Run_8.wav"
output_file = "stretched_audio/Julia_Run_8_2x_waveletUtils.wav"
os.makedirs("stretched_audio", exist_ok=True)

# Load
sample_rate, audio_data = wavfile.read(input_file)
print(f"Loaded: {sample_rate}Hz, {audio_data.shape}, {audio_data.dtype}")

if len(audio_data.shape) > 1:
    audio_data = audio_data.mean(axis=1)

audio_data = audio_data.astype(np.float64) / 32768.0
original_duration = len(audio_data) / sample_rate
print(f"Duration: {original_duration:.2f}s, {len(audio_data)} samples")

# HARP defaults: scaleLogSpacing=0.12, wavelet=Morlet(w0=6)
sample_spacing = 1.0 / sample_rate
wavelet = Morlet()
scale_log_spacing = 0.12

scales = generateCwtScales(
    maxNumberSamples=None,
    dataLength=len(audio_data),
    scaleSpacingLog=scale_log_spacing,
    sampleSpacingTime=sample_spacing,
    waveletFunction=wavelet
)
print(f"Scales: {len(scales)} (spacing={scale_log_spacing})")

# Step 1: Forward CWT
print("Computing CWT...")
coefficients = cwt(audio_data, scales, sample_spacing, wavelet)
print(f"Coefficients shape: {coefficients.shape}")

# Step 2: Decompose to magnitude + unwrapped phase (unwrap BEFORE interpolation)
print("Decomposing to polar (unwrapping phase)...")
magnitude = np.abs(coefficients)
phase = np.unwrap(np.angle(coefficients), axis=1)

# Step 3: Interpolate magnitude and phase separately in polar form
print(f"Interpolating polar coefficients by {TSM_FACTOR}x...")
magnitude, phase = interpolateCoeffsPolar(magnitude, phase, TSM_FACTOR)

# Step 4: Multiply phase by shift factor (= TSM_FACTOR)
print("Applying phase shift correction...")
coefficients_shifted = magnitude * np.exp(1j * phase * TSM_FACTOR)

# Step 5: ICWT with proper scaling constants
print("Computing ICWT (with C_d and wavelet scaling)...")
stretched_audio = icwt(
    coefficients_shifted,
    scale_log_spacing,
    sample_spacing,
    wavelet.C_d,
    wavelet.time(0)
)
stretched_audio = np.real(stretched_audio)

new_duration = len(stretched_audio) / sample_rate
print(f"Output: {new_duration:.2f}s, {len(stretched_audio)} samples")

# Normalize
peak = np.max(np.abs(stretched_audio))
if peak > 0:
    stretched_audio = stretched_audio / peak

stretched_int16 = (stretched_audio * 32767).astype(np.int16)
wavfile.write(output_file, sample_rate, stretched_int16)
print(f"Saved: {output_file}")
