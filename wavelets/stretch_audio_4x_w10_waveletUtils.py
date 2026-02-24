#!/usr/bin/env python3
"""
Wavelet Phase Vocoder 4x time-stretch, w0=10 for tighter frequency resolution.
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

TSM_FACTOR = 4.0

input_file = "../stretch_test_audio/Julia_Run_8.wav"
output_file = "stretched_audio/Julia_Run_8_4x_w10_waveletUtils.wav"
os.makedirs("stretched_audio", exist_ok=True)

# Load
sample_rate, audio_data = wavfile.read(input_file)
print(f"Loaded: {sample_rate}Hz, {audio_data.shape}, {audio_data.dtype}")

if len(audio_data.shape) > 1:
    audio_data = audio_data.mean(axis=1)

audio_data = audio_data.astype(np.float64) / 32768.0
original_duration = len(audio_data) / sample_rate
print(f"Duration: {original_duration:.2f}s, {len(audio_data)} samples")

sample_spacing = 1.0 / sample_rate
wavelet = Morlet(w0=10)
scale_log_spacing = 0.12

scales = generateCwtScales(
    maxNumberSamples=None,
    dataLength=len(audio_data),
    scaleSpacingLog=scale_log_spacing,
    sampleSpacingTime=sample_spacing,
    waveletFunction=wavelet
)
print(f"Scales: {len(scales)} (spacing={scale_log_spacing}, w0=10)")

print("Computing CWT...")
coefficients = cwt(audio_data, scales, sample_spacing, wavelet)
print(f"Coefficients shape: {coefficients.shape}")

print("Decomposing to polar (unwrapping phase)...")
magnitude = np.abs(coefficients)
phase = np.unwrap(np.angle(coefficients), axis=1)

print(f"Interpolating polar coefficients by {TSM_FACTOR}x...")
magnitude, phase = interpolateCoeffsPolar(magnitude, phase, TSM_FACTOR)

print("Applying phase shift correction...")
coefficients_shifted = magnitude * np.exp(1j * phase * TSM_FACTOR)

print("Computing ICWT...")
# C_d only defined for w0=6; scaling is redundant since we normalize
stretched_audio = icwt(
    coefficients_shifted,
    scale_log_spacing,
    sample_spacing
)
stretched_audio = np.real(stretched_audio)

new_duration = len(stretched_audio) / sample_rate
print(f"Output: {new_duration:.2f}s, {len(stretched_audio)} samples")

peak = np.max(np.abs(stretched_audio))
if peak > 0:
    stretched_audio = stretched_audio / peak

stretched_int16 = (stretched_audio * 32767).astype(np.int16)
wavfile.write(output_file, sample_rate, stretched_int16)
print(f"Saved: {output_file}")
