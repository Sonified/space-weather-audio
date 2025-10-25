#!/usr/bin/env python3
"""
Create test files for Cloudflare Worker testing
Generate small/medium/large files in raw int32, zstd3, and gzip3 formats
"""
import numpy as np
from numcodecs import Zstd
import gzip
import os

# Create output directory
output_dir = 'tests/worker_test_files'
os.makedirs(output_dir, exist_ok=True)

# Use cached data
cache_dir = 'backend/test_compression_cache'

print('='*70)
print('CREATING CLOUDFLARE WORKER TEST FILES')
print('='*70)
print('Formats: raw int32, zstd3, gzip3')
print('Sizes: small, medium, large')
print('='*70)

datasets = {
    'small': f'{cache_dir}/small_raw.bin',
    'medium': f'{cache_dir}/medium_raw.bin',
    'large': f'{cache_dir}/large_raw.bin'
}

total_files = 0

for size_name, cache_file in datasets.items():
    if not os.path.exists(cache_file):
        print(f'\n⚠️  Skipping {size_name} - cache file not found')
        continue
    
    print(f'\n{size_name.upper()} DATASET:')
    print('-' * 70)
    
    # Load cached data
    with open(cache_file, 'rb') as f:
        data_int32 = np.frombuffer(f.read(), dtype=np.int32)
    
    raw_bytes = data_int32.tobytes()
    raw_size_kb = len(raw_bytes) / 1024
    
    print(f'  Samples: {len(data_int32):,}')
    print(f'  Raw size: {raw_size_kb:.1f} KB')
    print(f'  Data range: [{data_int32.min():,}, {data_int32.max():,}]')
    
    # Save raw int32
    raw_file = f'{output_dir}/seismic_{size_name}_int32.bin'
    with open(raw_file, 'wb') as f:
        f.write(raw_bytes)
    print(f'  ✓ {raw_file}')
    total_files += 1
    
    # Compress with Zstd level 3
    zstd_codec = Zstd(level=3)
    zstd_compressed = zstd_codec.encode(raw_bytes)
    zstd_file = f'{output_dir}/seismic_{size_name}_zstd3.bin'
    with open(zstd_file, 'wb') as f:
        f.write(zstd_compressed)
    zstd_ratio = len(zstd_compressed) / len(raw_bytes) * 100
    print(f'  ✓ {zstd_file}')
    print(f'    {len(zstd_compressed) / 1024:.1f} KB ({zstd_ratio:.1f}%)')
    total_files += 1
    
    # Compress with Gzip level 3
    gzip_compressed = gzip.compress(raw_bytes, compresslevel=3)
    gzip_file = f'{output_dir}/seismic_{size_name}_gzip3.bin.gz'
    with open(gzip_file, 'wb') as f:
        f.write(gzip_compressed)
    gzip_ratio = len(gzip_compressed) / len(raw_bytes) * 100
    print(f'  ✓ {gzip_file}')
    print(f'    {len(gzip_compressed) / 1024:.1f} KB ({gzip_ratio:.1f}%)')
    total_files += 1

print('\n' + '='*70)
print(f'✅ Created {total_files} test files')
print('='*70)
print('\n📦 Upload these files to R2 for Worker testing')
print('\n📋 File naming convention:')
print('  seismic_{size}_{format}.bin[.gz]')
print('  - size: small, medium, large')
print('  - format: int32, zstd3, gzip3')

