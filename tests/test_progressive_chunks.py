"""
Progressive Chunk Size Optimization Test

Tests all combinations of storage (raw/zarr) and compression (none/blosc/gzip)
with progressive chunk sizes: 8→16→32→64→128→256→512 KB

Fetches 4 hours of Kilauea data from 12 hours ago.
"""

import requests
import time
import gzip
import io
from numcodecs import Blosc

# Progressive chunk sizes in KB
CHUNK_SIZES_KB = [8, 16, 32, 64, 128, 256]
REMAINING_CHUNK_KB = 512

TEST_CONFIGURATIONS = [
    {'storage': 'raw', 'compression': 'none', 'label': 'Raw int16 + No Compression'},
    {'storage': 'raw', 'compression': 'blosc', 'label': 'Raw int16 + Blosc'},
    {'storage': 'raw', 'compression': 'gzip', 'label': 'Raw int16 + Gzip'},
    {'storage': 'zarr', 'compression': 'none', 'label': 'Zarr + No Compression'},
    {'storage': 'zarr', 'compression': 'blosc', 'label': 'Zarr + Blosc'},
    {'storage': 'zarr', 'compression': 'gzip', 'label': 'Zarr + Gzip'},
]

def decompress_chunk(data, compression):
    """Decompress a chunk based on compression method"""
    if compression == 'none':
        # Raw int16, no decompression needed
        import numpy as np
        int16_data = np.frombuffer(data, dtype=np.int16)
        return int16_data
    elif compression == 'gzip':
        decompressed = gzip.decompress(data)
        import numpy as np
        int16_data = np.frombuffer(decompressed, dtype=np.int16)
        return int16_data
    elif compression == 'blosc':
        codec = Blosc(cname='zstd', clevel=5, shuffle=Blosc.SHUFFLE)
        decompressed = codec.decode(data)
        import numpy as np
        int16_data = np.frombuffer(decompressed, dtype=np.int16)
        return int16_data

def run_single_test(config):
    """Run a single test configuration"""
    print(f"\n{'='*70}")
    print(f"🧪 Testing: {config['label']}")
    print('='*70)
    
    url = f"https://volcano-audio.onrender.com/api/progressive-test?storage={config['storage']}&compression={config['compression']}"
    
    test_start = time.time()
    
    try:
        response = requests.get(url, stream=True)
        
        if response.status_code != 200:
            print(f"❌ Error: HTTP {response.status_code}")
            print(f"   {response.text}")
            return None
        
        file_size = int(response.headers.get('Content-Length', 0))
        print(f"📦 File Size: {file_size / (1024*1024):.2f} MB")
        
        chunks = []
        buffer = b''
        chunk_index = 0
        bytes_received = 0
        ttfa = None
        
        chunk_sizes = [kb * 1024 for kb in CHUNK_SIZES_KB]
        
        # Stream data in chunks
        for raw_chunk in response.iter_content(chunk_size=8192):
            buffer += raw_chunk
            bytes_received += len(raw_chunk)
            
            # Determine expected size for this chunk
            expected_size = chunk_sizes[chunk_index] if chunk_index < len(chunk_sizes) else REMAINING_CHUNK_KB * 1024
            
            # Process chunk when we have enough data
            while len(buffer) >= expected_size:
                chunk_data = buffer[:expected_size]
                buffer = buffer[expected_size:]
                
                # Decompress
                decompress_start = time.time()
                audio_data = decompress_chunk(chunk_data, config['compression'])
                decompress_time = (time.time() - decompress_start) * 1000  # ms
                
                chunk_info = {
                    'index': chunk_index,
                    'size': len(chunk_data),
                    'decompress_time': decompress_time,
                    'samples': len(audio_data)
                }
                chunks.append(chunk_info)
                
                # Record time to first audio
                if ttfa is None:
                    ttfa = (time.time() - test_start) * 1000  # ms
                    print(f"⚡ Time to First Audio: {ttfa:.0f} ms")
                
                print(f"   Chunk {chunk_index + 1}: {len(chunk_data)/1024:.1f} KB, "
                      f"decompress {decompress_time:.1f}ms, {len(audio_data):,} samples")
                
                chunk_index += 1
                
                # Break if we've processed all expected chunks
                if bytes_received >= file_size and len(buffer) < expected_size:
                    break
        
        # Process any remaining buffer
        if len(buffer) > 0:
            decompress_start = time.time()
            audio_data = decompress_chunk(buffer, config['compression'])
            decompress_time = (time.time() - decompress_start) * 1000
            
            chunks.append({
                'index': chunk_index,
                'size': len(buffer),
                'decompress_time': decompress_time,
                'samples': len(audio_data)
            })
            
            print(f"   Chunk {chunk_index + 1} (final): {len(buffer)/1024:.1f} KB, "
                  f"decompress {decompress_time:.1f}ms, {len(audio_data):,} samples")
        
        total_time = (time.time() - test_start) * 1000  # ms
        total_decompress = sum(c['decompress_time'] for c in chunks)
        avg_decompress = total_decompress / len(chunks) if chunks else 0
        
        result = {
            'config': config,
            'file_size': file_size,
            'ttfa': ttfa,
            'chunks': chunks,
            'total_decompress_time': total_decompress,
            'avg_decompress_time': avg_decompress,
            'total_time': total_time
        }
        
        print(f"\n📊 Summary:")
        print(f"   Total Chunks: {len(chunks)}")
        print(f"   Total Decompress Time: {total_decompress:.0f} ms")
        print(f"   Average Decompress Time: {avg_decompress:.1f} ms/chunk")
        print(f"   Total Time: {total_time/1000:.2f} s")
        
        return result
        
    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return None

def print_summary(results):
    """Print comparison summary"""
    print("\n" + "="*70)
    print("📊 FINAL COMPARISON")
    print("="*70)
    
    valid_results = [r for r in results if r is not None]
    
    if not valid_results:
        print("❌ No valid results to compare")
        return
    
    print(f"\n{'Configuration':<30} {'Size (MB)':<12} {'TTFA (ms)':<12} {'Avg Decomp (ms)':<15} {'Total (s)':<10}")
    print("-"*85)
    
    for r in valid_results:
        print(f"{r['config']['label']:<30} "
              f"{r['file_size']/(1024*1024):<12.2f} "
              f"{r['ttfa']:<12.0f} "
              f"{r['avg_decompress_time']:<15.1f} "
              f"{r['total_time']/1000:<10.2f}")
    
    print("\n" + "="*70)
    print("🏆 WINNERS")
    print("="*70)
    
    best_size = min(valid_results, key=lambda x: x['file_size'])
    best_ttfa = min(valid_results, key=lambda x: x['ttfa'])
    best_decomp = min(valid_results, key=lambda x: x['avg_decompress_time'])
    best_total = min(valid_results, key=lambda x: x['total_time'])
    
    print(f"\n🏆 Smallest File: {best_size['config']['label']}")
    print(f"   {best_size['file_size']/(1024*1024):.2f} MB")
    
    print(f"\n⚡ Fastest Time to First Audio: {best_ttfa['config']['label']}")
    print(f"   {best_ttfa['ttfa']:.0f} ms")
    
    print(f"\n🚀 Fastest Decompression: {best_decomp['config']['label']}")
    print(f"   {best_decomp['avg_decompress_time']:.1f} ms/chunk")
    
    print(f"\n🎯 Fastest Overall: {best_total['config']['label']}")
    print(f"   {best_total['total_time']/1000:.2f} s")
    
    print("\n" + "="*70)

if __name__ == '__main__':
    print("🌋 PROGRESSIVE CHUNK SIZE OPTIMIZATION TEST")
    print("="*70)
    print("Data: Kilauea, 4 hours, 12 hours ago")
    print(f"Chunk sizes: {' → '.join(str(kb) for kb in CHUNK_SIZES_KB)} → {REMAINING_CHUNK_KB} KB (remaining)")
    print("="*70)
    
    all_results = []
    
    for i, config in enumerate(TEST_CONFIGURATIONS, 1):
        print(f"\n[Test {i}/{len(TEST_CONFIGURATIONS)}]")
        result = run_single_test(config)
        all_results.append(result)
        
        # Wait between tests
        if i < len(TEST_CONFIGURATIONS):
            print("\n⏳ Waiting 2 seconds before next test...")
            time.sleep(2)
    
    print_summary(all_results)

