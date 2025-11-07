#!/usr/bin/env python3
"""
Generate Butterworth highpass filter coefficients for JavaScript
Matches scipy.signal.butter exactly
"""

from scipy import signal
import json

def generate_highpass_coeffs(sample_rate, cutoff_hz, order=4):
    """Generate coefficients matching Railway backend filter"""
    nyquist = sample_rate / 2
    normalized_cutoff = cutoff_hz / nyquist
    b, a = signal.butter(order, normalized_cutoff, btype='high', analog=False)
    
    return {
        'b': b.tolist(),
        'a': a.tolist(),
        'sample_rate': sample_rate,
        'cutoff_hz': cutoff_hz,
        'normalized_cutoff': normalized_cutoff
    }

# Generate coefficients for common combinations
configs = [
    # 100 Hz sample rate
    (100, 0.01),  # Very low cutoff
    (100, 0.02),  # Low cutoff (UI default)
    (100, 0.045), # Medium cutoff
    (100, 0.5),   # Railway backend default
    (100, 1.0),   # Higher cutoff
    
    # 50 Hz sample rate
    (50, 0.01),
    (50, 0.02),
    (50, 0.045),
    (50, 0.5),
    
    # 40 Hz sample rate
    (40, 0.01),
    (40, 0.02),
    (40, 0.5),
]

print("// Pre-computed scipy coefficients for exact matching")
print("// CRITICAL: Cutoff is normalized to NYQUIST (sample_rate/2), not sample_rate!")
print("// Railway backend uses: sample_rate=100Hz, cutoff=0.5Hz, order=4")
print("// normalized_cutoff = 0.5 / (100/2) = 0.01")
print("const SCIPY_BUTTER_COEFFICIENTS = {")

for sample_rate, cutoff_hz in configs:
    coeffs = generate_highpass_coeffs(sample_rate, cutoff_hz, order=4)
    key = f"{sample_rate}Hz_{cutoff_hz}Hz"
    
    print(f"    '{key}': {{")
    print(f"        b: {json.dumps(coeffs['b'])},")
    print(f"        a: {json.dumps(coeffs['a'])},")
    print(f"        normalized_cutoff: {coeffs['normalized_cutoff']}")
    print(f"    }},")

print("};")

# Also print verification info
print("\n// Verification:")
for sample_rate, cutoff_hz in configs:
    coeffs = generate_highpass_coeffs(sample_rate, cutoff_hz, order=4)
    b_sum = sum(coeffs['b'])
    a_sum = sum(coeffs['a'])
    dc_gain = b_sum / a_sum
    print(f"// {sample_rate}Hz_{cutoff_hz}Hz: DC gain = {dc_gain:.10f} (should be ~0 for highpass)")
