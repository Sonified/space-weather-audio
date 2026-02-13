#!/usr/bin/env python3
"""
Wavelet Phase Vocoder time-stretch (Archer et al. 2022 / De Gersem et al. 1997)

The algorithm per the paper:
1. CWT to get complex wavelet coefficients
2. Interpolate coefficients in time by TSM factor (stretches time, drops pitch)
3. Multiply UNWRAPPED PHASE by TSM factor (corrects pitch back up)
4. ICWT to reconstruct

Step 2 alone gives you half-speed playback. Step 3 is the pitch correction.
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
output_file = "stretched_audio/Julia_Run_8_2x_wavelet.wav"

os.makedirs("stretched_audio", exist_ok=True)

# Load
sample_rate, audio_data = wavfile.read(input_file)
print(f"Loaded: {sample_rate}Hz, {audio_data.shape}, {audio_data.dtype}")

if len(audio_data.shape) > 1:
    audio_data = audio_data.mean(axis=1)

audio_data = audio_data.astype(np.float64) / 32768.0
original_duration = len(audio_data) / sample_rate
print(f"Duration: {original_duration:.2f}s, {len(audio_data)} samples")

# Generate scales
sample_spacing = 1.0 / sample_rate
morlet = Morlet()
scales = generateCwtScales(
    maxNumberSamples=None,
    dataLength=len(audio_data),
    scaleSpacingLog=0.1,
    sampleSpacingTime=sample_spacing,
    waveletFunction=morlet
)
print(f"Scales: {len(scales)} (range {scales[0]:.6f} to {scales[-1]:.6f})")

# Step 1: Forward CWT
print("Computing CWT...")
coefficients = cwt(
    audio_data,
    scales,
    sampleSpacingTime=sample_spacing,
    waveletFunction=morlet
)
print(f"Coefficients shape: {coefficients.shape}")

# Step 2: Interpolate coefficients in time (stretches time, drops pitch)
print(f"Interpolating coefficients by {TSM_FACTOR}x...")
stretched_coeffs = interpolateCoeffs(coefficients, interpolate_factor=TSM_FACTOR)
print(f"Stretched shape: {stretched_coeffs.shape}")

# Step 3: Multiply unwrapped phase by TSM factor (corrects pitch)
print("Correcting phase (multiplying unwrapped phase by TSM factor)...")
magnitude = np.abs(stretched_coeffs)
phase = np.angle(stretched_coeffs)
unwrapped_phase = np.unwrap(phase, axis=1)
corrected_phase = unwrapped_phase * TSM_FACTOR
corrected_coeffs = magnitude * np.exp(1j * corrected_phase)

# Step 4: ICWT
print("Computing ICWT...")
stretched_audio = icwt(
    corrected_coeffs,
    scaleLogSpacing=0.1,
    sampleSpacingTime=sample_spacing
)

new_duration = len(stretched_audio) / sample_rate
print(f"Output: {new_duration:.2f}s, {len(stretched_audio)} samples")

# Normalize
peak = np.max(np.abs(stretched_audio))
if peak > 0:
    stretched_audio = stretched_audio / peak

stretched_int16 = (stretched_audio * 32767).astype(np.int16)
wavfile.write(output_file, sample_rate, stretched_int16)
print(f"Saved: {output_file}")
