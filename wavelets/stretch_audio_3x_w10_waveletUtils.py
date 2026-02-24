#!/usr/bin/env python3
"""
Wavelet Phase Vocoder 3x time-stretch, w0=10.
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

TSM_FACTOR = 3.0

input_file = "../stretch_test_audio/Julia_Run_8.wav"
output_file = "stretched_audio/Julia_Run_8_3x_w10_waveletUtils.wav"
os.makedirs("stretched_audio", exist_ok=True)

sample_rate, audio_data = wavfile.read(input_file)
if len(audio_data.shape) > 1:
    audio_data = audio_data.mean(axis=1)
audio_data = audio_data.astype(np.float64) / 32768.0
print(f"Loaded: {len(audio_data)/sample_rate:.2f}s, {len(audio_data)} samples")

sample_spacing = 1.0 / sample_rate
wavelet = Morlet(w0=10)
scale_log_spacing = 0.12

scales = generateCwtScales(
    maxNumberSamples=None, dataLength=len(audio_data),
    scaleSpacingLog=scale_log_spacing, sampleSpacingTime=sample_spacing,
    waveletFunction=wavelet
)
print(f"Scales: {len(scales)} (w0=10, dj={scale_log_spacing})")

print("CWT...")
coefficients = cwt(audio_data, scales, sample_spacing, wavelet)

magnitude = np.abs(coefficients)
phase = np.unwrap(np.angle(coefficients), axis=1)

print(f"Interpolating {TSM_FACTOR}x...")
magnitude, phase = interpolateCoeffsPolar(magnitude, phase, TSM_FACTOR)

coefficients_shifted = magnitude * np.exp(1j * phase * TSM_FACTOR)

print("ICWT...")
stretched_audio = np.real(icwt(coefficients_shifted, scale_log_spacing, sample_spacing))

peak = np.max(np.abs(stretched_audio))
if peak > 0:
    stretched_audio = stretched_audio / peak

wavfile.write(output_file, sample_rate, (stretched_audio * 32767).astype(np.int16))
print(f"Saved: {output_file} ({len(stretched_audio)/sample_rate:.2f}s)")
