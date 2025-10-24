"""
Test ONLY compression time (no IRIS fetch, no network transfer)
Compare Gzip-1, Blosc-5, Zstd-3 on the same data
"""

import numpy as np
import time
from numcodecs import Zlib, Blosc, Zstd

# Simulate 2 hours of Kilauea data (100 Hz, int16)
print("🌋 Generating 2 hours of synthetic seismic data...")
data_points = 2 * 3600 * 100  # 2 hours * 3600 seconds * 100 Hz
int16_data = np.random.randint(-10000, 10000, size=data_points, dtype=np.int16)
raw_bytes = int16_data.tobytes()
raw_size_mb = len(raw_bytes) / 1024 / 1024

print(f"✅ Generated {data_points:,} samples ({raw_size_mb:.2f} MB)")
print()

results = []

# Test Gzip-1
print("Testing Gzip-1...")
compressor = Zlib(level=1)
start = time.perf_counter()
compressed = compressor.encode(raw_bytes)
compress_time = (time.perf_counter() - start) * 1000

start = time.perf_counter()
decompressed = compressor.decode(compressed)
decompress_time = (time.perf_counter() - start) * 1000

assert decompressed == raw_bytes
results.append({
    'name': 'Gzip-1',
    'compress_ms': compress_time,
    'decompress_ms': decompress_time,
    'size_kb': len(compressed) / 1024,
    'ratio': len(raw_bytes) / len(compressed)
})
print(f"  Compress: {compress_time:.0f}ms")
print(f"  Decompress: {decompress_time:.0f}ms")
print(f"  Size: {len(compressed)/1024:.1f} KB")
print()

# Test Blosc-5
print("Testing Blosc-zstd-5...")
compressor = Blosc(cname='zstd', clevel=5, shuffle=Blosc.SHUFFLE)
start = time.perf_counter()
compressed = compressor.encode(raw_bytes)
compress_time = (time.perf_counter() - start) * 1000

start = time.perf_counter()
decompressed = compressor.decode(compressed)
decompress_time = (time.perf_counter() - start) * 1000

assert decompressed == raw_bytes
results.append({
    'name': 'Blosc-zstd-5',
    'compress_ms': compress_time,
    'decompress_ms': decompress_time,
    'size_kb': len(compressed) / 1024,
    'ratio': len(raw_bytes) / len(compressed)
})
print(f"  Compress: {compress_time:.0f}ms")
print(f"  Decompress: {decompress_time:.0f}ms")
print(f"  Size: {len(compressed)/1024:.1f} KB")
print()

# Test Zstd-3
print("Testing Zstd-3...")
compressor = Zstd(level=3)
start = time.perf_counter()
compressed = compressor.encode(raw_bytes)
compress_time = (time.perf_counter() - start) * 1000

start = time.perf_counter()
decompressed = compressor.decode(compressed)
decompress_time = (time.perf_counter() - start) * 1000

assert decompressed == raw_bytes
results.append({
    'name': 'Zstd-3',
    'compress_ms': compress_time,
    'decompress_ms': decompress_time,
    'size_kb': len(compressed) / 1024,
    'ratio': len(raw_bytes) / len(compressed)
})
print(f"  Compress: {compress_time:.0f}ms")
print(f"  Decompress: {decompress_time:.0f}ms")
print(f"  Size: {len(compressed)/1024:.1f} KB")
print()

# Summary
print("="*80)
print("COMPRESSION TIME COMPARISON (2 hours of data)")
print("="*80)
print(f"{'Format':<20} {'Compress':<12} {'Decompress':<12} {'Size (KB)':<12} {'Ratio':<10}")
print("-"*80)

for r in results:
    print(f"{r['name']:<20} {r['compress_ms']:<11.0f}ms {r['decompress_ms']:<11.0f}ms {r['size_kb']:<11.1f} {r['ratio']:<9.2f}x")

print("-"*80)

# Analysis
baseline = results[0]
print()
print("📊 ANALYSIS:")
print()

for r in results[1:]:
    size_diff = ((baseline['size_kb'] - r['size_kb']) / baseline['size_kb'] * 100)
    compress_diff = r['compress_ms'] - baseline['compress_ms']
    decompress_diff = r['decompress_ms'] - baseline['decompress_ms']
    
    print(f"{r['name']} vs Gzip-1:")
    print(f"  Size: {size_diff:+.1f}% ({r['size_kb']:.1f} KB vs {baseline['size_kb']:.1f} KB)")
    print(f"  Compress: {compress_diff:+.0f}ms ({r['compress_ms']:.0f}ms vs {baseline['compress_ms']:.0f}ms)")
    print(f"  Decompress: {decompress_diff:+.0f}ms ({r['decompress_ms']:.0f}ms vs {baseline['decompress_ms']:.0f}ms)")
    print()

print("="*80)
print("KEY INSIGHT:")
print("="*80)
print()
print("The 'server time' in the previous test included:")
print("  1. IRIS data fetch (~1-2 seconds)")
print("  2. Data processing (convert to int16, create Zarr)")
print("  3. Compression (shown above)")
print("  4. Network transfer to client")
print()
print("This test shows ONLY compression/decompression time!")
print("="*80)









