#!/usr/bin/env python3
"""
Naive half-speed: just halve the sample rate.
This SHOULD sound identical to what the wavelet version produces
if the wavelet version is broken.
"""
import numpy as np
from scipy.io import wavfile
import os

input_file = "../stretch_test_audio/Julia_Run_8.wav"
output_file = "stretched_audio/Julia_Run_8_2x_resample.wav"

os.makedirs("stretched_audio", exist_ok=True)

sample_rate, audio_data = wavfile.read(input_file)

if len(audio_data.shape) > 1:
    audio_data = audio_data.mean(axis=1).astype(np.int16)

# Write at half sample rate = half speed, octave down
wavfile.write(output_file, sample_rate // 2, audio_data)
print(f"Saved: {output_file} at {sample_rate // 2}Hz (half speed)")
