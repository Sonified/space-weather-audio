"""
Test gzip compression levels (1-9) on seismic data.

Measures:
- Source data size
- Compression time
- Decompression time  
- Resulting file size
- Compression ratio

For each gzip level 1-9.
"""

import time
import gzip
import numpy as np
from obspy.clients.fdsn import Client
from obspy import UTCDateTime
import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

def test_gzip_levels():
    """Test all gzip compression levels on real seismic data"""
    
    print("=" * 80)
    print("GZIP COMPRESSION LEVEL COMPARISON")
    print("=" * 80)
    print()
    
    # Fetch 1 hour of Kilauea data
    print("📡 Fetching 1 hour of Kilauea seismic data from IRIS...")
    client = Client("IRIS")
    end = UTCDateTime.now()
    start = end - 3600  # 1 hour
    
    try:
        stream = client.get_waveforms(
            network='HV',
            station='HLPD',
            location='',
            channel='HHZ',
            starttime=start,
            endtime=end
        )
    except:
        # Try with location code 01
        stream = client.get_waveforms(
            network='HV',
            station='HLPD',
            location='01',
            channel='HHZ',
            starttime=start,
            endtime=end
        )
    
    stream.merge(fill_value='interpolate')
    trace = stream[0]
    
    # Get raw data as bytes
    data = trace.data.astype(np.float32)
    raw_bytes = data.tobytes()
    raw_size = len(raw_bytes)
    
    print(f"✅ Fetched {len(data):,} samples")
    print(f"📊 Raw data size: {raw_size:,} bytes ({raw_size / 1024:.1f} KB)")
    print()
    
    print("-" * 80)
    print(f"{'Level':<8} {'Comp Time':<12} {'Decomp Time':<14} {'Size (KB)':<12} {'Ratio':<10} {'Speed':<10}")
    print("-" * 80)
    
    results = []
    
    for level in range(1, 10):
        # Compression
        start_compress = time.perf_counter()
        compressed = gzip.compress(raw_bytes, compresslevel=level)
        compress_time = (time.perf_counter() - start_compress) * 1000  # ms
        
        compressed_size = len(compressed)
        ratio = raw_size / compressed_size
        
        # Decompression
        start_decompress = time.perf_counter()
        decompressed = gzip.decompress(compressed)
        decompress_time = (time.perf_counter() - start_decompress) * 1000  # ms
        
        # Verify
        assert decompressed == raw_bytes, "Decompression failed!"
        
        # Calculate "speed" metric (smaller is better)
        # Weighted: compression time matters more since it's done once on server
        speed_metric = compress_time * 0.3 + decompress_time * 0.7
        
        results.append({
            'level': level,
            'compress_time': compress_time,
            'decompress_time': decompress_time,
            'size': compressed_size,
            'ratio': ratio,
            'speed_metric': speed_metric
        })
        
        print(f"{level:<8} {compress_time:<11.1f}ms {decompress_time:<13.1f}ms {compressed_size/1024:<11.1f} {ratio:<9.2f}x {speed_metric:<9.1f}")
    
    print("-" * 80)
    print()
    
    # Find optimal level (best compression with acceptable speed)
    print("📊 ANALYSIS:")
    print()
    
    # Best compression
    best_compression = min(results, key=lambda x: x['size'])
    print(f"🏆 Best compression: Level {best_compression['level']} ({best_compression['ratio']:.2f}x, {best_compression['size']/1024:.1f} KB)")
    
    # Fastest decompression (most important for client)
    fastest_decomp = min(results, key=lambda x: x['decompress_time'])
    print(f"⚡ Fastest decompression: Level {fastest_decomp['level']} ({fastest_decomp['decompress_time']:.1f}ms)")
    
    # Best balance (speed metric)
    best_balance = min(results, key=lambda x: x['speed_metric'])
    print(f"⚖️  Best balance: Level {best_balance['level']} (speed metric: {best_balance['speed_metric']:.1f})")
    
    # Diminishing returns analysis
    print()
    print("📉 DIMINISHING RETURNS:")
    for i in range(1, len(results)):
        prev = results[i-1]
        curr = results[i]
        size_improvement = (prev['size'] - curr['size']) / prev['size'] * 100
        time_cost = curr['compress_time'] - prev['compress_time']
        
        if size_improvement < 1.0:  # Less than 1% improvement
            print(f"⚠️  Level {curr['level']}: Only {size_improvement:.2f}% smaller than level {prev['level']}, but {time_cost:.1f}ms slower")
    
    print()
    print("=" * 80)
    print("RECOMMENDATION:")
    print("=" * 80)
    
    # Level 6 is typically the sweet spot
    level6 = results[5]  # Index 5 = level 6
    level1 = results[0]
    level9 = results[8]
    
    print(f"""
For browser-side decompression with gzip:

Level 1 (fastest):
  - Compress: {level1['compress_time']:.1f}ms
  - Decompress: {level1['decompress_time']:.1f}ms  
  - Size: {level1['size']/1024:.1f} KB ({level1['ratio']:.2f}x)
  
Level 6 (default, recommended):
  - Compress: {level6['compress_time']:.1f}ms
  - Decompress: {level6['decompress_time']:.1f}ms
  - Size: {level6['size']/1024:.1f} KB ({level6['ratio']:.2f}x)
  - {((level1['size'] - level6['size']) / level1['size'] * 100):.1f}% smaller than level 1
  - Only {level6['decompress_time'] - level1['decompress_time']:.1f}ms slower to decompress
  
Level 9 (maximum):
  - Compress: {level9['compress_time']:.1f}ms
  - Decompress: {level9['decompress_time']:.1f}ms
  - Size: {level9['size']/1024:.1f} KB ({level9['ratio']:.2f}x)
  - Only {((level6['size'] - level9['size']) / level6['size'] * 100):.1f}% smaller than level 6
  - {level9['compress_time'] - level6['compress_time']:.1f}ms slower to compress

**Recommendation: Level 6**
- Good compression ({level6['ratio']:.2f}x)
- Fast decompression ({level6['decompress_time']:.1f}ms)
- Industry standard default
- Negligible difference from level 9 in size
""")

if __name__ == '__main__':
    test_gzip_levels()


