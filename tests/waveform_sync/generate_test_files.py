#!/usr/bin/env python3
"""
Generate test audio files with precise timing markers.
Each file has a full-amplitude click (spike) at every second boundary.
"""

import numpy as np
import struct
import os

def generate_test_file(duration_seconds, sample_rate=44100):
    """
    Generate a test audio file with clicks every second.
    
    Args:
        duration_seconds: Length of audio in seconds
        sample_rate: Sample rate (default 44100 Hz)
    
    Returns:
        numpy array of float32 samples
    """
    total_samples = duration_seconds * sample_rate
    audio = np.zeros(total_samples, dtype=np.float32)
    
    # Add full-amplitude clicks at every second boundary
    for second in range(duration_seconds + 1):  # +1 to include the final second
        sample_idx = second * sample_rate
        if sample_idx < total_samples:
            # Full positive spike
            audio[sample_idx] = 1.0
        if sample_idx + 1 < total_samples:
            # Full negative spike (makes the biggest click)
            audio[sample_idx + 1] = -1.0
    
    return audio

def save_as_bin(audio, filename):
    """Save Float32Array as binary file."""
    output_dir = os.path.join(os.path.dirname(__file__), 'test_files')
    os.makedirs(output_dir, exist_ok=True)
    filepath = os.path.join(output_dir, filename)
    
    # Write as raw float32 binary
    with open(filepath, 'wb') as f:
        f.write(audio.tobytes())
    
    print(f"✅ Generated {filename}: {len(audio):,} samples ({len(audio)/44100:.1f}s) = {os.path.getsize(filepath):,} bytes")
    return filepath

def main():
    print("🎵 Generating test audio files with timing markers...\n")
    
    # Generate test files
    durations = [
        (30, "test_30s.bin"),
        (60, "test_1m.bin"),
        (120, "test_2m.bin")
    ]
    
    for duration, filename in durations:
        audio = generate_test_file(duration)
        save_as_bin(audio, filename)
    
    print("\n✅ All test files generated!")
    print("\nTo test: Open tests/waveform_sync/test_player.html in your browser")

if __name__ == "__main__":
    main()



