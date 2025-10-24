"""
Test all Blosc-zstd compression levels (1-9) on 24h seismic data.

Find the optimal balance of compression ratio vs speed.
"""

import time
import numpy as np
from obspy.clients.fdsn import Client
from obspy import UTCDateTime
import blosc
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

def test_blosc_levels():
    print("=" * 80)
    print("BLOSC-ZSTD COMPRESSION LEVEL COMPARISON (24 hours)")
    print("=" * 80)
    print()
    
    # Fetch 24 hours of Kilauea data
    print("📡 Fetching 24 hours of Kilauea seismic data...")
    client = Client("IRIS")
    end = UTCDateTime.now()
    start = end - (24 * 3600)
    
    try:
        stream = client.get_waveforms('HV', 'HLPD', '', 'HHZ', start, end)
    except:
        stream = client.get_waveforms('HV', 'HLPD', '01', 'HHZ', start, end)
    
    stream.merge(fill_value='interpolate')
    trace = stream[0]
    
    # Convert to int16
    int16_data = trace.data.astype(np.int16)
    raw_bytes = int16_data.tobytes()
    raw_size = len(raw_bytes)
    
    print(f"✅ Fetched {len(int16_data):,} samples")
    print(f"📊 Raw int16 size: {raw_size/1024/1024:.2f} MB")
    print()
    
    print("-" * 90)
    print(f"{'Level':<8} {'Compress':<12} {'Decompress':<12} {'Size (MB)':<12} {'Ratio':<10} {'Speed Score':<12}")
    print("-" * 90)
    
    results = []
    
    for level in range(1, 10):
        # Compression
        start_time = time.perf_counter()
        compressed = blosc.compress(raw_bytes, typesize=2, cname='zstd', clevel=level, shuffle=blosc.SHUFFLE)
        compress_time = (time.perf_counter() - start_time) * 1000
        
        # Decompression
        start_time = time.perf_counter()
        decompressed = blosc.decompress(compressed)
        decompress_time = (time.perf_counter() - start_time) * 1000
        
        assert decompressed == raw_bytes
        
        size = len(compressed)
        ratio = raw_size / size
        
        # Speed score: weighted average (decompress matters more for user experience)
        # Lower is better
        speed_score = compress_time * 0.3 + decompress_time * 0.7
        
        results.append({
            'level': level,
            'compress_time': compress_time,
            'decompress_time': decompress_time,
            'size': size,
            'ratio': ratio,
            'speed_score': speed_score
        })
        
        print(f"{level:<8} {compress_time:<11.0f}ms {decompress_time:<11.0f}ms {size/1024/1024:<11.2f} {ratio:<9.2f}x {speed_score:<11.0f}")
    
    print("-" * 90)
    print()
    
    # Analysis
    print("📊 ANALYSIS:")
    print()
    
    # Best compression
    best_compression = min(results, key=lambda x: x['size'])
    print(f"🏆 Best compression: Level {best_compression['level']}")
    print(f"   Size: {best_compression['size']/1024/1024:.2f} MB ({best_compression['ratio']:.2f}x)")
    print(f"   Compress: {best_compression['compress_time']:.0f}ms")
    print(f"   Decompress: {best_compression['decompress_time']:.0f}ms")
    print()
    
    # Fastest decompression
    fastest_decomp = min(results, key=lambda x: x['decompress_time'])
    print(f"⚡ Fastest decompression: Level {fastest_decomp['level']}")
    print(f"   Decompress: {fastest_decomp['decompress_time']:.0f}ms")
    print(f"   Size: {fastest_decomp['size']/1024/1024:.2f} MB ({fastest_decomp['ratio']:.2f}x)")
    print()
    
    # Best balance (speed score)
    best_balance = min(results, key=lambda x: x['speed_score'])
    print(f"⚖️  Best balance (speed score): Level {best_balance['level']}")
    print(f"   Speed score: {best_balance['speed_score']:.0f}")
    print(f"   Size: {best_balance['size']/1024/1024:.2f} MB ({best_balance['ratio']:.2f}x)")
    print(f"   Compress: {best_balance['compress_time']:.0f}ms")
    print(f"   Decompress: {best_balance['decompress_time']:.0f}ms")
    print()
    
    # Diminishing returns
    print("📉 DIMINISHING RETURNS:")
    for i in range(1, len(results)):
        prev = results[i-1]
        curr = results[i]
        size_improvement = (prev['size'] - curr['size']) / prev['size'] * 100
        time_cost = curr['compress_time'] - prev['compress_time']
        
        if size_improvement < 1.0:  # Less than 1% improvement
            print(f"⚠️  Level {curr['level']}: Only {size_improvement:.2f}% smaller than level {prev['level']}, but {time_cost:.0f}ms slower to compress")
    
    print()
    
    # Compare to level 1 (baseline)
    level1 = results[0]
    print("📊 COMPARISON TO LEVEL 1 (BASELINE):")
    print()
    for r in results[1:]:
        size_savings = (level1['size'] - r['size']) / 1024 / 1024
        size_pct = (level1['size'] - r['size']) / level1['size'] * 100
        time_cost = r['compress_time'] - level1['compress_time']
        decomp_diff = r['decompress_time'] - level1['decompress_time']
        
        print(f"Level {r['level']} vs Level 1:")
        print(f"  Size: {size_savings:.2f} MB smaller ({size_pct:.1f}%)")
        print(f"  Compress: {time_cost:+.0f}ms")
        print(f"  Decompress: {decomp_diff:+.0f}ms")
        print()
    
    print("=" * 80)
    print("RECOMMENDATION:")
    print("=" * 80)
    print()
    
    # Find sweet spot (good compression, reasonable speed)
    # Typically level 3-5 for real-time systems
    level3 = results[2]
    level5 = results[4]
    
    print(f"""
For production use:

**Level 3 (Fast):**
  - Size: {level3['size']/1024/1024:.2f} MB
  - Compress: {level3['compress_time']:.0f}ms
  - Decompress: {level3['decompress_time']:.0f}ms
  - Use case: Real-time background fetching (every 10 min)
  
**Level 5 (Balanced - RECOMMENDED):**
  - Size: {level5['size']/1024/1024:.2f} MB
  - Compress: {level5['compress_time']:.0f}ms
  - Decompress: {level5['decompress_time']:.0f}ms
  - Use case: Standard caching, good balance
  - {((level1['size'] - level5['size'])/level1['size']*100):.1f}% smaller than level 1
  
**Level {best_compression['level']} (Maximum):**
  - Size: {best_compression['size']/1024/1024:.2f} MB
  - Compress: {best_compression['compress_time']:.0f}ms
  - Decompress: {best_compression['decompress_time']:.0f}ms
  - Use case: Archival storage, not real-time
  - {((level1['size'] - best_compression['size'])/level1['size']*100):.1f}% smaller than level 1

**Our choice: Level 5** ✅
- Fast enough for real-time ({level5['compress_time']:.0f}ms compress)
- Excellent compression ({level5['ratio']:.2f}x)
- Blazing decompression ({level5['decompress_time']:.0f}ms)
- Industry standard for scientific data
""")

if __name__ == '__main__':
    test_blosc_levels()









