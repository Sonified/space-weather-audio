"""
Test compression with REAL Zarr pipeline (exactly like the server does)
Fetch data once, then test Zarr compression with different codecs
"""

import numpy as np
import time
import tempfile
import shutil
import os
from obspy.clients.fdsn import Client
from obspy import UTCDateTime
import xarray as xr
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

print(f"✅ Fetched {len(int16_data):,} samples")
print(f"   Sample rate: {trace.stats.sampling_rate} Hz")
print(f"   Duration: {len(int16_data) / trace.stats.sampling_rate / 3600:.2f} hours")
print()
print("="*80)
print("NOW TESTING ZARR COMPRESSION (exactly like the server)")
print("="*80)
print()

results = []

def test_zarr_compression(name, compressor):
    """Test Zarr compression with a specific codec"""
    print(f"Testing {name}...")
    
    # Create xarray Dataset (same as server)
    times = np.arange(len(int16_data)) / trace.stats.sampling_rate
    ds = xr.Dataset(
        {
            'amplitude': (['time'], int16_data),
        },
        coords={
            'time': times
        },
        attrs={
            'network': 'HV',
            'station': 'HLPD',
            'channel': 'HHZ',
            'sampling_rate': float(trace.stats.sampling_rate),
        }
    )
    
    # Create temp directory for Zarr
    temp_dir = tempfile.mkdtemp()
    zarr_path = os.path.join(temp_dir, 'data.zarr')
    
    try:
        # Compress with Zarr
        compress_start = time.perf_counter()
        ds.to_zarr(
            zarr_path,
            mode='w',
            encoding={
                'amplitude': {
                    'compressor': compressor
                }
            }
        )
        compress_time = (time.perf_counter() - compress_start) * 1000
        
        # Calculate total size of Zarr directory
        total_size = 0
        for root, dirs, files in os.walk(zarr_path):
            for file in files:
                file_path = os.path.join(root, file)
                total_size += os.path.getsize(file_path)
        
        # Decompress (load back)
        decompress_start = time.perf_counter()
        ds_loaded = xr.open_zarr(zarr_path)
        loaded_data = ds_loaded['amplitude'].values
        decompress_time = (time.perf_counter() - decompress_start) * 1000
        
        # Verify data integrity
        assert np.array_equal(loaded_data, int16_data), "Data mismatch after decompression!"
        
        size_kb = total_size / 1024
        
        print(f"  Compress: {compress_time:.0f}ms")
        print(f"  Decompress: {decompress_time:.0f}ms")
        print(f"  Zarr directory size: {size_kb:.1f} KB")
        print()
        
        return {
            'name': name,
            'compress_ms': compress_time,
            'decompress_ms': decompress_time,
            'size_kb': size_kb,
            'ratio': (len(int16_data) * 2) / (total_size)  # int16 = 2 bytes per sample
        }
        
    finally:
        # Clean up
        shutil.rmtree(temp_dir, ignore_errors=True)

# Test Gzip-1
results.append(test_zarr_compression("Gzip-1", Zlib(level=1)))

# Test Blosc-5
results.append(test_zarr_compression("Blosc-zstd-5", Blosc(cname='zstd', clevel=5, shuffle=Blosc.SHUFFLE)))

# Test Zstd-3
results.append(test_zarr_compression("Zstd-3", Zstd(level=3)))

# Summary
print("="*80)
print("ZARR COMPRESSION PERFORMANCE ON REAL SEISMIC DATA")
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
print(f"Smallest Zarr: {smallest['name']} ({smallest['size_kb']:.1f} KB)")
print(f"Fastest compress: {fastest_compress['name']} ({fastest_compress['compress_ms']:.0f}ms)")
print(f"Fastest decompress: {fastest_decompress['name']} ({fastest_decompress['decompress_ms']:.0f}ms)")
print()

print("="*80)
print("💡 FINAL RECOMMENDATION:")
print("="*80)

if smallest == fastest_compress == fastest_decompress:
    print(f"\n✅ Clear winner: {smallest['name']}")
    print(f"   Best on all metrics!")
else:
    blosc = next((r for r in results if 'Blosc' in r['name']), None)
    gzip = next((r for r in results if 'Gzip' in r['name']), None)
    
    if blosc and gzip:
        savings = ((gzip['size_kb'] - blosc['size_kb']) / gzip['size_kb'] * 100)
        compress_diff = blosc['compress_ms'] - gzip['compress_ms']
        decompress_diff = blosc['decompress_ms'] - gzip['decompress_ms']
        
        print(f"""
Blosc-zstd-5 vs Gzip-1:
  📦 File size: {savings:+.1f}% ({blosc['size_kb']:.1f} KB vs {gzip['size_kb']:.1f} KB)
  ⬆️  Compress: {compress_diff:+.0f}ms ({blosc['compress_ms']:.0f}ms vs {gzip['compress_ms']:.0f}ms)
  ⬇️  Decompress: {decompress_diff:+.0f}ms ({blosc['decompress_ms']:.0f}ms vs {gzip['decompress_ms']:.0f}ms)

Recommendation: {'Blosc-zstd-5' if savings > 0 else 'Gzip-1'}
  {'✅ Smaller files, better for storage' if savings > 0 else '✅ Smaller files'}
  {'✅ Faster compression' if compress_diff < 0 else ''}
  {'✅ Faster decompression' if decompress_diff < 0 else ''}
""")

print("="*80)
print("NOTE: This test uses the EXACT Zarr pipeline the server uses!")
print("="*80)









