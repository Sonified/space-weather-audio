#!/usr/bin/env python3
"""
Generate CORRECT Butterworth highpass filter coefficients for JavaScript
EXACTLY matches scipy.signal.butter
"""

from scipy import signal
import json

def generate_coeffs(sample_rate, cutoff_hz, order=4):
    nyquist = sample_rate / 2
    normalized = cutoff_hz / nyquist
    b, a = signal.butter(order, normalized, btype='high', analog=False)
    
    key = f'{sample_rate}Hz_{cutoff_hz}Hz'
    print(f"    '{key}': {{")
    print(f"        b: {json.dumps(b.tolist())},")
    print(f"        a: {json.dumps(a.tolist())},")
    print(f"        normalized_cutoff: {normalized}")
    print(f"    }},")

# Generate all the ones we need
print("const SCIPY_BUTTER_COEFFICIENTS = {")

configs = [
    (100, 0.01),
    (100, 0.02),
    (100, 0.045),
    (100, 0.5),   # CRITICAL: Railway default
    (100, 1.0),
    (50, 0.01),
    (50, 0.02),
    (50, 0.045),
    (50, 0.5),
    (40, 0.01),
    (40, 0.02),
    (40, 0.5),
]

for sr, cf in configs:
    generate_coeffs(sr, cf)

print("};")

# Verify the critical one
print("\n// VERIFICATION: 100Hz, 0.5Hz cutoff")
sr, cf = 100, 0.5
nyquist = sr / 2
normalized = cf / nyquist
b, a = signal.butter(4, normalized, btype='high', analog=False)
print(f"// Normalized cutoff: {normalized}")
print(f"// b[0] = {b[0]}")
print(f"// a[1] = {a[1]}")
b_sum = sum(b)
a_sum = sum(a)
dc_gain = b_sum / a_sum
print(f"// DC gain: {dc_gain:.15f}")

