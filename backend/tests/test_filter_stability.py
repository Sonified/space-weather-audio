#!/usr/bin/env python3
"""
Test if scipy's filter is actually stable
"""

from scipy import signal
import numpy as np

# Generate coefficients
sr = 100
cf = 0.5
nyq = sr / 2
norm = cf / nyq
b, a = signal.butter(4, norm, btype='high', analog=False)

print(f"Sample rate: {sr} Hz")
print(f"Cutoff: {cf} Hz")
print(f"Normalized cutoff: {norm}")
print(f"\nCoefficients:")
print(f"b = {b}")
print(f"a = {a}")

# Check pole locations
zeros, poles, gain = signal.tf2zpk(b, a)
print(f"\nPoles: {poles}")
print(f"Pole magnitudes: {np.abs(poles)}")
print(f"All poles inside unit circle? {np.all(np.abs(poles) < 1)}")

# Test with a simple sine wave
t = np.arange(1000) / sr
test_signal = np.sin(2 * np.pi * 1.0 * t)  # 1 Hz sine

print(f"\nTest signal range: [{test_signal.min():.3f}, {test_signal.max():.3f}]")

# Apply filtfilt
filtered = signal.filtfilt(b, a, test_signal)

print(f"Filtered range: [{filtered.min():.3f}, {filtered.max():.3f}]")

if np.abs(filtered).max() > 10:
    print("❌ FILTER IS UNSTABLE IN SCIPY TOO!")
else:
    print("✅ Filter is stable in scipy")

# Test with real seismic-like data
test_data = np.random.randn(1000) * 10000 - 13000  # Similar to seismic data
print(f"\nSeismic-like data range: [{test_data.min():.0f}, {test_data.max():.0f}]")

filtered_seismic = signal.filtfilt(b, a, test_data)
print(f"Filtered seismic range: [{filtered_seismic.min():.0f}, {filtered_seismic.max():.0f}]")

if np.abs(filtered_seismic).max() > 1e6:
    print("❌ FILTER EXPLODES WITH SEISMIC DATA!")
else:
    print("✅ Filter is stable with seismic data")

