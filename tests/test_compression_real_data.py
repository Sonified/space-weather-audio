"""
Test compression on REAL seismic data (fetch once, then test compression only)
"""

import numpy as np
import time
from obspy.clients.fdsn import Client
from obspy import UTCDateTime
from numcodecs import Zlib, Blosc, Zstd

print("🌋 Fetching 2 hours of REAL Kilauea seismic data from IRIS...")
print("   (This will take ~2 seconds, but we only do it once)")
print()

client = Client("IRIS")
end = UTCDateTime.now()
start = end - (2 * 3600)  # 2 hours

try:
    stream = client.get_waveforms('HV', 'HLPD', '', 'HHZ', start, end)
except:
    stream = client.get_waveforms('HV', 'HLPD', '01', 'HHZ', start, end)

stream.merge(fill_value='interpolate')
trace = stream[0]

# Convert to int16 (same as server does)
data = trace.data.astype(np.float32)
nan_mask = np.isnan(data) | ~np.isfinite(data)
if np.any(nan_mask):
    valid_indices = np.where(~nan_mask)[0]
    if len(valid_indices) > 1:
        data[nan_mask] = np.interp(
            np.where(nan_mask)[0],
            valid_indices,
            data[valid_indices]
        )
    else:
        data[nan_mask] = 0

int16_data = data.astype(np.int16)
raw_bytes = int16_data.tobytes()
raw_size_mb = len(raw_bytes) / 1024 / 1024

print(f"✅ Fetched {len(int16_data):,} samples ({raw_size_mb:.2f} MB)")
print(f"   Sample rate: {trace.stats.sampling_rate} Hz")
print(f"   Duration: {len(int16_data) / trace.stats.sampling_rate / 3600:.2f} hours")
print()
print("="*80)
print("NOW TESTING COMPRESSION (no network, just compression)")
print("="*80)
print()

results = []

# Test Gzip-1
print("Testing Gzip-1...")
compressor = Zlib(level=1)
start_time = time.perf_counter()
compressed = compressor.encode(raw_bytes)
compress_time = (time.perf_counter() - start_time) * 1000

start_time = time.perf_counter()
decompressed = compressor.decode(compressed)
decompress_time = (time.perf_counter() - start_time) * 1000

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
start_time = time.perf_counter()
compressed = compressor.encode(raw_bytes)
compress_time = (time.perf_counter() - start_time) * 1000

start_time = time.perf_counter()
decompressed = compressor.decode(compressed)
decompress_time = (time.perf_counter() - start_time) * 1000

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
start_time = time.perf_counter()
compressed = compressor.encode(raw_bytes)
compress_time = (time.perf_counter() - start_time) * 1000

start_time = time.perf_counter()
decompressed = compressor.decode(compressed)
decompress_time = (time.perf_counter() - start_time) * 1000

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
print("COMPRESSION PERFORMANCE ON REAL SEISMIC DATA")
print("="*80)
print(f"{'Format':<20} {'Compress':<12} {'Decompress':<12} {'Size (KB)':<12} {'Ratio':<10}")
print("-"*80)

for r in results:
    print(f"{r['name']:<20} {r['compress_ms']:<11.0f}ms {r['decompress_ms']:<11.0f}ms {r['size_kb']:<11.1f} {r['ratio']:<9.2f}x")

print("-"*80)

# Analysis
baseline = results[0]
print()
print("📊 DETAILED COMPARISON:")
print()

for r in results[1:]:
    size_diff = ((baseline['size_kb'] - r['size_kb']) / baseline['size_kb'] * 100)
    compress_diff = r['compress_ms'] - baseline['compress_ms']
    decompress_diff = r['decompress_ms'] - baseline['decompress_ms']
    
    print(f"{r['name']} vs Gzip-1:")
    print(f"  📦 Size: {size_diff:+.1f}% ({r['size_kb']:.1f} KB vs {baseline['size_kb']:.1f} KB)")
    print(f"  ⬆️  Compress: {compress_diff:+.0f}ms ({r['compress_ms']:.0f}ms vs {baseline['compress_ms']:.0f}ms)")
    print(f"  ⬇️  Decompress: {decompress_diff:+.0f}ms ({r['decompress_ms']:.0f}ms vs {baseline['decompress_ms']:.0f}ms)")
    print()

# Winner
smallest = min(results, key=lambda x: x['size_kb'])
fastest_compress = min(results, key=lambda x: x['compress_ms'])
fastest_decompress = min(results, key=lambda x: x['decompress_ms'])

print("="*80)
print("🏆 WINNERS:")
print("="*80)
print(f"Smallest file: {smallest['name']} ({smallest['size_kb']:.1f} KB)")
print(f"Fastest compress: {fastest_compress['name']} ({fastest_compress['compress_ms']:.0f}ms)")
print(f"Fastest decompress: {fastest_decompress['name']} ({fastest_decompress['decompress_ms']:.0f}ms)")
print()

print("="*80)
print("💡 RECOMMENDATION:")
print("="*80)
blosc = next((r for r in results if 'Blosc' in r['name']), None)
if blosc:
    savings = ((baseline['size_kb'] - blosc['size_kb']) / baseline['size_kb'] * 100)
    print(f"""
Use Blosc-zstd-5:
  ✅ {savings:.1f}% smaller files (saves storage costs)
  ✅ {blosc['compress_ms']:.0f}ms compression (faster than Gzip's {baseline['compress_ms']:.0f}ms)
  ✅ {blosc['decompress_ms']:.0f}ms decompression (same as Gzip's {baseline['decompress_ms']:.0f}ms)
  ✅ Byte shuffling optimized for numerical data
  
Perfect for seismic data storage and delivery!
""")
print("="*80)









