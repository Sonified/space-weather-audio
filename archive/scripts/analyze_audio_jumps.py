#!/usr/bin/env python3
"""
Analyze audio jumps in linear sweep test files
"""

import numpy as np
import struct
import matplotlib.pyplot as plt
from pathlib import Path

def read_wav_file(filepath):
    """Read a WAV file and return sample data"""
    with open(filepath, 'rb') as f:
        # Read RIFF header
        riff = f.read(4)
        if riff != b'RIFF':
            raise ValueError(f"Not a valid WAV file: {filepath}")
        
        file_size = struct.unpack('<I', f.read(4))[0]
        wave = f.read(4)
        if wave != b'WAVE':
            raise ValueError(f"Not a valid WAV file: {filepath}")
        
        # Read fmt chunk
        fmt_chunk = f.read(4)
        if fmt_chunk != b'fmt ':
            raise ValueError(f"Invalid fmt chunk: {filepath}")
        
        fmt_size = struct.unpack('<I', f.read(4))[0]
        audio_format = struct.unpack('<H', f.read(2))[0]
        num_channels = struct.unpack('<H', f.read(2))[0]
        sample_rate = struct.unpack('<I', f.read(4))[0]
        byte_rate = struct.unpack('<I', f.read(4))[0]
        block_align = struct.unpack('<H', f.read(2))[0]
        bits_per_sample = struct.unpack('<H', f.read(2))[0]
        
        # Skip any extra fmt bytes
        if fmt_size > 16:
            f.read(fmt_size - 16)
        
        # Find data chunk
        while True:
            chunk_id = f.read(4)
            if not chunk_id:
                raise ValueError(f"No data chunk found in {filepath}")
            chunk_size = struct.unpack('<I', f.read(4))[0]
            
            if chunk_id == b'data':
                # Read audio data
                num_samples = chunk_size // (bits_per_sample // 8)
                if bits_per_sample == 16:
                    samples = np.frombuffer(f.read(chunk_size), dtype=np.int16)
                else:
                    raise ValueError(f"Unsupported bit depth: {bits_per_sample}")
                break
            else:
                # Skip this chunk
                f.read(chunk_size)
        
        print(f"📊 {Path(filepath).name}:")
        print(f"   Sample rate: {sample_rate} Hz")
        print(f"   Channels: {num_channels}")
        print(f"   Samples: {len(samples):,}")
        print(f"   Duration: {len(samples) / sample_rate:.2f}s")
        print(f"   Range: [{samples.min()}, {samples.max()}]")
        
        return samples, sample_rate

def analyze_linear_sweep(samples, name):
    """Analyze a linear sweep for jumps/discontinuities"""
    print(f"\n🔍 Analyzing {name}...")
    
    # Check first sample
    print(f"   First sample: {samples[0]} (expected: -32768)")
    print(f"   Last sample: {samples[-1]}")
    
    # Find all discontinuities (where step != 1)
    jumps = []
    for i in range(len(samples) - 1):
        step = samples[i + 1] - samples[i]
        if step != 1 and step != 0:  # Allow wrapping at 32767 -> -32768
            # Check if it's the expected wrap
            if samples[i] == 32767 and samples[i + 1] == -32768:
                continue  # This is normal wrapping
            jumps.append({
                'index': i,
                'from': samples[i],
                'to': samples[i + 1],
                'step': step,
                'time_ms': (i / 44100) * 1000
            })
    
    print(f"   Discontinuities found: {len(jumps)}")
    
    if jumps:
        print(f"\n   📍 Jump details:")
        for j in jumps[:20]:  # Show first 20 jumps
            print(f"      Sample {j['index']:,} ({j['time_ms']:.1f}ms): {j['from']:,} → {j['to']:,} (step: {j['step']:+,})")
    
    return jumps

def compare_files(raw_samples, playback_samples):
    """Compare raw download vs actual playback"""
    print(f"\n🔄 Comparing files...")
    
    min_len = min(len(raw_samples), len(playback_samples))
    print(f"   Comparing first {min_len:,} samples")
    
    # Find where they diverge
    diffs = []
    for i in range(min_len):
        if raw_samples[i] != playback_samples[i]:
            diffs.append(i)
    
    if diffs:
        print(f"   ❌ Files differ at {len(diffs):,} positions ({100*len(diffs)/min_len:.2f}%)")
        print(f"   First difference at sample {diffs[0]:,} ({diffs[0]/44100:.3f}s)")
        
        # Show first few differences
        for i in diffs[:10]:
            print(f"      Sample {i:,}: raw={raw_samples[i]:,}, playback={playback_samples[i]:,}")
        
        # Try to find where playback actually starts in the raw file
        if len(diffs) > 100:
            # Sample the playback start and search for it in raw
            playback_start = playback_samples[:1000]
            print(f"\n   🔍 Searching for playback start in raw file...")
            
            for offset in range(0, min(len(raw_samples) - 1000, 100000), 100):
                matches = np.sum(raw_samples[offset:offset+1000] == playback_start)
                if matches > 900:  # 90% match
                    print(f"      ✅ Playback seems to start at raw sample {offset:,} ({offset/44100:.3f}s)")
                    print(f"         Skipped {offset:,} samples = {offset/44100:.2f}s of audio")
                    print(f"         That's {100*offset/len(raw_samples):.1f}% of the file!")
                    break
    else:
        print(f"   ✅ Files are identical!")

def plot_samples(raw_samples, playback_samples, output_path):
    """Plot the first few samples to visualize jumps"""
    fig, axes = plt.subplots(2, 1, figsize=(14, 8))
    
    # Plot first 20000 samples
    n = min(20000, len(raw_samples), len(playback_samples))
    
    axes[0].plot(raw_samples[:n], linewidth=0.5, label='Raw Download')
    axes[0].set_title('Raw Downloaded File (first 20k samples)')
    axes[0].set_xlabel('Sample Index')
    axes[0].set_ylabel('Amplitude (Int16)')
    axes[0].grid(True, alpha=0.3)
    axes[0].legend()
    
    axes[1].plot(playback_samples[:n], linewidth=0.5, label='Playback Capture', color='orange')
    axes[1].set_title('Actual Playback (first 20k samples)')
    axes[1].set_xlabel('Sample Index')
    axes[1].set_ylabel('Amplitude (Int16)')
    axes[1].grid(True, alpha=0.3)
    axes[1].legend()
    
    plt.tight_layout()
    plt.savefig(output_path, dpi=150)
    print(f"\n📊 Plot saved to: {output_path}")

if __name__ == '__main__':
    base_dir = Path('/Users/robertalexander/GitHub/volcano-audio/test_streaming_audio')
    
    # Read both files
    raw_samples, _ = read_wav_file(base_dir / 'Long_Trimmed_Raw_Download.wav')
    playback_samples, _ = read_wav_file(base_dir / 'Long_Trimmed_AudioWorklet_Playback_Capture.wav')
    
    # Analyze each file
    raw_jumps = analyze_linear_sweep(raw_samples, 'Raw Download')
    playback_jumps = analyze_linear_sweep(playback_samples, 'Playback Capture')
    
    # Compare them
    compare_files(raw_samples, playback_samples)
    
    # Create visualization
    plot_path = base_dir / 'audio_comparison_plot.png'
    plot_samples(raw_samples, playback_samples, plot_path)

