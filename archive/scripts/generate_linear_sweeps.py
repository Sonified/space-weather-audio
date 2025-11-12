#!/usr/bin/env python3
"""
Generate linear sweep test files: -32768 to +32767 int16 values
These are perfect for detecting audio buffering glitches.
"""

import numpy as np
import struct

def generate_linear_sweep(sample_count):
    """Generate a linear sweep from -32768 to +32767"""
    samples = np.linspace(-32768, 32767, sample_count, dtype=np.int16)
    return samples

# Generate the three test files matching current dataset sizes
sizes = {
    'small': 90_000,   # ~2 seconds at 44.1kHz
    'medium': 540_000, # ~12 seconds
    'large': 1_440_000 # ~32 seconds
}

for size_name, sample_count in sizes.items():
    print(f"\n{'='*60}")
    print(f"Generating {size_name} sweep: {sample_count:,} samples")
    print(f"{'='*60}")
    
    # Generate linear sweep
    samples = generate_linear_sweep(sample_count)
    
    # Verify first value
    first_val = samples[0]
    last_val = samples[-1]
    print(f"✅ First value: {first_val} (should be -32768)")
    print(f"✅ Last value: {last_val} (should be 32767)")
    
    # Verify it's a smooth linear progression
    diffs = np.diff(samples)
    unique_diffs = np.unique(diffs)
    print(f"✅ Step sizes: {unique_diffs}")
    
    if len(unique_diffs) > 2:
        print(f"⚠️ WARNING: More than 2 step sizes detected! This might indicate precision issues.")
    else:
        print(f"✅ Perfect linear sweep!")
    
    # Save as raw int16 binary file
    filename = f"test/linear_sweep_{size_name}.bin"
    samples.tofile(filename)
    
    file_size_mb = len(samples) * 2 / (1024 * 1024)
    print(f"✅ Saved: {filename} ({file_size_mb:.2f} MB)")
    
    # Also save as gzipped for worker testing
    import gzip
    gzip_filename = f"test/linear_sweep_{size_name}.bin.gz"
    with gzip.open(gzip_filename, 'wb') as f:
        samples.tofile(f)
    
    gzip_size_mb = sum(1 for _ in open(gzip_filename, 'rb')) / (1024 * 1024)
    print(f"✅ Saved: {gzip_filename} ({gzip_size_mb:.2f} MB compressed)")

print(f"\n{'='*60}")
print("✅ All linear sweep files generated!")
print(f"{'='*60}\n")








