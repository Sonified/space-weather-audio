#!/usr/bin/env python3
"""
Compare actual file sizes: normalized int16 vs native int32 vs gzipped/blosc int32
Test gzip compression levels 1-9 and blosc compression with timing
Pick 10 files that exceed int16 range and 10 that fit within it
"""
from obspy import read
import numpy as np
import os
import gzip
import time
from numcodecs import Blosc

# Files that exceed int16 (from previous scan) - REDUCED SET FOR SPEED
files_exceeding = [
    'mseed_files/Spurr_Last_1d_2025-03-28_T_121852.mseed',
    'mseed_files/Kilauea_Sept28_24h.mseed',
    'mseed_files/Spurr_Last_0.5d_2025-03-28_T_092835.mseed',
]

# Files that fit in int16 - REDUCED SET FOR SPEED
files_within = [
    'mseed_files/Kilauea_Sept27_24h.mseed',
    'mseed_files/Spurr_Last_1d_2025-03-27_T_190401.mseed',
    'mseed_files/Spurr_Last_0.5d_2025-04-02_T_105950.mseed',
]

# Create output directory
output_dir = 'tests/file_size_comparison'
os.makedirs(output_dir, exist_ok=True)

print('='*70)
print('INT16 vs INT32 FILE SIZE COMPARISON')
print('='*70)

results = []

for category, files in [('EXCEEDS int16', files_exceeding), ('FITS in int16', files_within)]:
    print(f'\n{category}:')
    print('-' * 70)
    
    for fname in files:
        try:
            st = read(fname)
            fname_short = fname.split('/')[-1].replace('.mseed', '')
            
            # Merge all traces
            st.merge(method=1, fill_value='interpolate')
            data = st[0].data
            
            # Get native int32 data
            data_int32 = data.astype(np.int32)
            
            # Normalize and convert to int16
            data_normalized = data - np.mean(data)
            max_val = np.max(np.abs(data_normalized))
            if max_val > 0:
                data_normalized = data_normalized / max_val
            data_int16 = (data_normalized * 32767).astype(np.int16)
            
            # Save int16 and int32
            path_int16 = f'{output_dir}/{fname_short}_int16.bin'
            path_int32 = f'{output_dir}/{fname_short}_int32.bin'
            
            data_int16.tofile(path_int16)
            data_int32.tofile(path_int32)
            
            size_int16 = os.path.getsize(path_int16)
            size_int32 = os.path.getsize(path_int32)
            
            print(f'  {fname_short}')
            print(f'    Samples: {len(data):,}')
            print(f'    int16:  {size_int16/1024/1024:6.2f} MB (baseline)')
            print(f'    int32:  {size_int32/1024/1024:6.2f} MB ({size_int32/size_int16:.2f}x)')
            
            # Test gzip compression levels 1-9
            int32_bytes = data_int32.tobytes()
            gzip_results = []
            
            print(f'    gzip compression levels:')
            for level in range(1, 10):
                # Compression
                t0 = time.perf_counter()
                compressed = gzip.compress(int32_bytes, compresslevel=level)
                compress_time = time.perf_counter() - t0
                
                # Decompression
                t0 = time.perf_counter()
                decompressed = gzip.decompress(compressed)
                decompress_time = time.perf_counter() - t0
                
                size_gz = len(compressed)
                ratio = size_gz / size_int16
                
                gzip_results.append({
                    'level': level,
                    'size_mb': size_gz / 1024 / 1024,
                    'ratio': ratio,
                    'compress_ms': compress_time * 1000,
                    'decompress_ms': decompress_time * 1000
                })
                
                print(f'      level {level}: {size_gz/1024/1024:5.2f} MB ({ratio:.2f}x) | compress: {compress_time*1000:5.1f}ms | decompress: {decompress_time*1000:4.1f}ms')
            
            # Test blosc compression (zstd and lz4 algorithms)
            print(f'    blosc compression (zstd):')
            blosc_results = []
            
            for level in [1, 3, 5, 7, 9]:
                codec = Blosc(cname='zstd', clevel=level, shuffle=Blosc.SHUFFLE)
                
                # Compression
                t0 = time.perf_counter()
                compressed = codec.encode(data_int32)
                compress_time = time.perf_counter() - t0
                
                # Decompression
                t0 = time.perf_counter()
                decompressed = codec.decode(compressed)
                decompress_time = time.perf_counter() - t0
                
                size_blosc = len(compressed)
                ratio = size_blosc / size_int16
                
                blosc_results.append({
                    'algorithm': 'zstd',
                    'level': level,
                    'size_mb': size_blosc / 1024 / 1024,
                    'ratio': ratio,
                    'compress_ms': compress_time * 1000,
                    'decompress_ms': decompress_time * 1000
                })
                
                print(f'      level {level}: {size_blosc/1024/1024:5.2f} MB ({ratio:.2f}x) | compress: {compress_time*1000:5.1f}ms | decompress: {decompress_time*1000:4.1f}ms')
            
            results.append({
                'file': fname_short,
                'category': category,
                'samples': len(data),
                'size_int16_mb': size_int16 / 1024 / 1024,
                'size_int32_mb': size_int32 / 1024 / 1024,
                'gzip_results': gzip_results,
                'blosc_results': blosc_results
            })
            
        except Exception as e:
            print(f'  ❌ {fname}: {e}')

# Summary
print('\n' + '='*70)
print('SUMMARY')
print('='*70)

total_int16 = sum(r['size_int16_mb'] for r in results)
total_int32 = sum(r['size_int32_mb'] for r in results)
total_samples = sum(r['samples'] for r in results)

print(f'\nTotal files analyzed: {len(results)}')
print(f'Total samples: {total_samples:,}')
print(f'\nTotal size (int16): {total_int16:.2f} MB (baseline)')
print(f'Total size (int32): {total_int32:.2f} MB ({total_int32/total_int16:.2f}x)')

# Average gzip performance across all files
print(f'\nGZIP COMPRESSION LEVELS (averaged across all files):')
print(f'{"Level":<8} {"Size (MB)":<12} {"Ratio":<8} {"Compress (ms)":<15} {"Decompress (ms)"}')
print('-' * 70)

for level in range(1, 10):
    avg_size = np.mean([r['gzip_results'][level-1]['size_mb'] for r in results])
    avg_ratio = np.mean([r['gzip_results'][level-1]['ratio'] for r in results])
    avg_compress = np.mean([r['gzip_results'][level-1]['compress_ms'] for r in results])
    avg_decompress = np.mean([r['gzip_results'][level-1]['decompress_ms'] for r in results])
    total_size_level = sum([r['gzip_results'][level-1]['size_mb'] for r in results])
    
    print(f'{level:<8} {total_size_level:>6.2f} MB    {avg_ratio:.2f}x     {avg_compress:>6.1f} ms        {avg_decompress:>6.1f} ms')

# Best options
print(f'\n' + '='*70)
print('RECOMMENDATIONS')
print('='*70)

level1_ratio = np.mean([r['gzip_results'][0]['ratio'] for r in results])
level1_decompress = np.mean([r['gzip_results'][0]['decompress_ms'] for r in results])
level9_ratio = np.mean([r['gzip_results'][8]['ratio'] for r in results])
level9_decompress = np.mean([r['gzip_results'][8]['decompress_ms'] for r in results])

print(f'\nint16 (normalized):')
print(f'  - Size: baseline')
print(f'  - Loss: 3 bits for 18% of files')
print(f'  - Decompress: instant (no decompression)')

print(f'\nint32 + gzip level 1 (fast):')
print(f'  - Size: {level1_ratio:.2f}x vs int16')
print(f'  - Loss: none (lossless)')
print(f'  - Decompress: ~{level1_decompress:.0f}ms avg')

print(f'\nint32 + gzip level 9 (max):')
print(f'  - Size: {level9_ratio:.2f}x vs int16')
print(f'  - Loss: none (lossless)')
print(f'  - Decompress: ~{level9_decompress:.0f}ms avg')

# Blosc recommendations
print(f'\n' + '='*70)
print('BLOSC COMPRESSION (zstd):')
print('='*70)
for level in [1, 3, 5, 7, 9]:
    avg_size = np.mean([r['blosc_results'][[1,3,5,7,9].index(level)]['size_mb'] for r in results])
    avg_ratio = np.mean([r['blosc_results'][[1,3,5,7,9].index(level)]['ratio'] for r in results])
    avg_compress = np.mean([r['blosc_results'][[1,3,5,7,9].index(level)]['compress_ms'] for r in results])
    avg_decompress = np.mean([r['blosc_results'][[1,3,5,7,9].index(level)]['decompress_ms'] for r in results])
    total_size_level = sum([r['blosc_results'][[1,3,5,7,9].index(level)]['size_mb'] for r in results])
    
    print(f'Level {level}: {total_size_level:>6.2f} MB ({avg_ratio:.2f}x) | compress: {avg_compress:>6.1f}ms | decompress: {avg_decompress:>5.1f}ms')

blosc5_ratio = np.mean([r['blosc_results'][2]['ratio'] for r in results])
blosc5_decompress = np.mean([r['blosc_results'][2]['decompress_ms'] for r in results])

print(f'\nint32 + blosc level 5 (zstd):')
print(f'  - Size: {blosc5_ratio:.2f}x vs int16')
print(f'  - Loss: none (lossless)')
print(f'  - Decompress: ~{blosc5_decompress:.0f}ms avg')
print(f'  - ⚠️  JS support: Limited - may need WebAssembly')

