#!/usr/bin/env python3
"""
Compare raw int16 compression vs Zarr-wrapped compression on REAL seismic data
"""

import numpy as np
import time
from obspy.clients.fdsn import Client
from obspy import UTCDateTime
from numcodecs import Blosc, Zlib, Zstd
import xarray as xr
import tempfile
import shutil
import os

# Fetch REAL Kilauea data
print("🌋 Fetching 4 hours of REAL Kilauea seismic data...")
client = Client("IRIS")
end = UTCDateTime.now() - 300  # 5 min lag
start = end - 14400  # 4 hours

stream = client.get_waveforms(
    network='HV',
    station='HLPD',
    location='',
    channel='HHZ',
    starttime=start,
    endtime=end
)

stream.merge(fill_value='interpolate')
trace = stream[0]

# Process like the server does
data = trace.data.astype(np.float64)
data = data - np.mean(data)  # Detrend
max_abs = np.max(np.abs(data))
if max_abs > 0:
    data = data / max_abs * 32767.0
data_int16 = data.astype(np.int16)

print(f"✅ Got {len(data_int16)} samples ({len(data_int16) * 2 / 1024:.1f} KB uncompressed)")
print()

# Test configurations
compressors = [
    ('Gzip-1', Zlib(level=1)),
    ('Gzip-5', Zlib(level=5)),
    ('Blosc-5', Blosc(cname='zstd', clevel=5, shuffle=Blosc.SHUFFLE)),
    ('Zstd-5', Zstd(level=5)),
]

print("=" * 80)
print("RAW INT16 COMPRESSION (current streaming method)")
print("=" * 80)

raw_results = {}
for name, compressor in compressors:
    # Compress
    t0 = time.time()
    compressed = compressor.encode(data_int16.tobytes())
    compress_time = (time.time() - t0) * 1000
    
    # Decompress
    t0 = time.time()
    decompressed = compressor.decode(compressed)
    decompress_time = (time.time() - t0) * 1000
    
    size_kb = len(compressed) / 1024
    ratio = len(data_int16.tobytes()) / len(compressed)
    
    raw_results[name] = {
        'size': size_kb,
        'compress_time': compress_time,
        'decompress_time': decompress_time,
        'ratio': ratio
    }
    
    print(f"{name:12} | Size: {size_kb:7.1f} KB | Ratio: {ratio:.2f}:1 | "
          f"Compress: {compress_time:5.1f}ms | Decompress: {decompress_time:5.1f}ms")

print()
print("=" * 80)
print("ZARR-WRAPPED COMPRESSION (with metadata)")
print("=" * 80)

zarr_results = {}
for name, compressor in compressors:
    # Create Zarr
    t0 = time.time()
    ds = xr.Dataset({
        'amplitude': (['time'], data_int16)
    })
    
    temp_dir = tempfile.mkdtemp()
    zarr_path = f"{temp_dir}/data.zarr"
    
    # xarray uses encoding parameter for compression
    encoding = {
        'amplitude': {'compressor': compressor}
    }
    ds.to_zarr(zarr_path, mode='w', encoding=encoding)
    
    # Calculate total size
    total_size = 0
    for root, dirs, files in os.walk(zarr_path):
        for file in files:
            total_size += os.path.getsize(os.path.join(root, file))
    
    compress_time = (time.time() - t0) * 1000
    
    # Read back (simulate decompression)
    t0 = time.time()
    ds_read = xr.open_zarr(zarr_path)
    data_read = ds_read['amplitude'].values
    decompress_time = (time.time() - t0) * 1000
    
    shutil.rmtree(temp_dir)
    
    size_kb = total_size / 1024
    ratio = len(data_int16.tobytes()) / total_size
    
    zarr_results[name] = {
        'size': size_kb,
        'compress_time': compress_time,
        'decompress_time': decompress_time,
        'ratio': ratio
    }
    
    print(f"{name:12} | Size: {size_kb:7.1f} KB | Ratio: {ratio:.2f}:1 | "
          f"Compress: {compress_time:5.1f}ms | Decompress: {decompress_time:5.1f}ms")

print()
print("=" * 80)
print("COMPARISON: Zarr overhead vs Raw")
print("=" * 80)

for name in raw_results.keys():
    raw = raw_results[name]
    zarr = zarr_results[name]
    
    size_overhead = ((zarr['size'] - raw['size']) / raw['size']) * 100
    time_overhead = ((zarr['compress_time'] - raw['compress_time']) / raw['compress_time']) * 100
    
    print(f"{name:12} | Size overhead: {size_overhead:+6.1f}% | "
          f"Compress time overhead: {time_overhead:+6.1f}%")

print()
print("🏆 WINNER for streaming:")
best_raw = min(raw_results.items(), key=lambda x: x[1]['size'])
print(f"   Raw: {best_raw[0]} ({best_raw[1]['size']:.1f} KB, {best_raw[1]['compress_time']:.1f}ms compress)")

