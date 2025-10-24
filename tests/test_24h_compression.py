"""
Test compression on 24 hours of seismic data.

Compare final file sizes for a full day of data:
- int16 + Gzip-1
- int16 + Blosc-zstd-5
- int16 + Blosc-zstd-9
"""

import time
import gzip
import numpy as np
from obspy.clients.fdsn import Client
from obspy import UTCDateTime
import blosc
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

def test_24h_compression():
    print("=" * 80)
    print("24-HOUR SEISMIC DATA COMPRESSION TEST")
    print("=" * 80)
    print()
    
    # Fetch 24 hours of Kilauea data
    print("📡 Fetching 24 hours of Kilauea seismic data from IRIS...")
    print("   (This will take a minute...)")
    client = Client("IRIS")
    end = UTCDateTime.now()
    start = end - (24 * 3600)  # 24 hours
    
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
    print(f"📊 Raw int16 size: {raw_size:,} bytes ({raw_size/1024:.1f} KB = {raw_size/1024/1024:.2f} MB)")
    print()
    
    print("-" * 80)
    print(f"{'Format':<20} {'Compress':<12} {'Decompress':<12} {'Size (MB)':<12} {'Ratio':<10}")
    print("-" * 80)
    
    results = []
    
    # Test Gzip-1
    print("Compressing with Gzip-1...")
    start_time = time.perf_counter()
    gzip1 = gzip.compress(raw_bytes, compresslevel=1)
    gzip1_time = (time.perf_counter() - start_time) * 1000
    
    start_time = time.perf_counter()
    gzip1_decomp = gzip.decompress(gzip1)
    gzip1_decomp_time = (time.perf_counter() - start_time) * 1000
    
    assert gzip1_decomp == raw_bytes
    
    results.append({
        'name': 'Gzip-1',
        'compress_time': gzip1_time,
        'decompress_time': gzip1_decomp_time,
        'size': len(gzip1),
        'ratio': raw_size / len(gzip1)
    })
    
    print(f"{'Gzip-1':<20} {gzip1_time:<11.0f}ms {gzip1_decomp_time:<11.0f}ms {len(gzip1)/1024/1024:<11.2f} {raw_size/len(gzip1):<9.2f}x")
    
    # Test Blosc-zstd-5
    print("Compressing with Blosc-zstd-5...")
    start_time = time.perf_counter()
    blosc5 = blosc.compress(raw_bytes, typesize=2, cname='zstd', clevel=5, shuffle=blosc.SHUFFLE)
    blosc5_time = (time.perf_counter() - start_time) * 1000
    
    start_time = time.perf_counter()
    blosc5_decomp = blosc.decompress(blosc5)
    blosc5_decomp_time = (time.perf_counter() - start_time) * 1000
    
    assert blosc5_decomp == raw_bytes
    
    results.append({
        'name': 'Blosc-zstd-5',
        'compress_time': blosc5_time,
        'decompress_time': blosc5_decomp_time,
        'size': len(blosc5),
        'ratio': raw_size / len(blosc5)
    })
    
    print(f"{'Blosc-zstd-5':<20} {blosc5_time:<11.0f}ms {blosc5_decomp_time:<11.0f}ms {len(blosc5)/1024/1024:<11.2f} {raw_size/len(blosc5):<9.2f}x")
    
    # Test Blosc-zstd-9
    print("Compressing with Blosc-zstd-9...")
    start_time = time.perf_counter()
    blosc9 = blosc.compress(raw_bytes, typesize=2, cname='zstd', clevel=9, shuffle=blosc.SHUFFLE)
    blosc9_time = (time.perf_counter() - start_time) * 1000
    
    start_time = time.perf_counter()
    blosc9_decomp = blosc.decompress(blosc9)
    blosc9_decomp_time = (time.perf_counter() - start_time) * 1000
    
    assert blosc9_decomp == raw_bytes
    
    results.append({
        'name': 'Blosc-zstd-9',
        'compress_time': blosc9_time,
        'decompress_time': blosc9_decomp_time,
        'size': len(blosc9),
        'ratio': raw_size / len(blosc9)
    })
    
    print(f"{'Blosc-zstd-9':<20} {blosc9_time:<11.0f}ms {blosc9_decomp_time:<11.0f}ms {len(blosc9)/1024/1024:<11.2f} {raw_size/len(blosc9):<9.2f}x")
    
    print("-" * 80)
    print()
    
    # Analysis
    print("📊 ANALYSIS:")
    print()
    
    gzip_result = results[0]
    blosc5_result = results[1]
    blosc9_result = results[2]
    
    print(f"Raw int16 data: {raw_size/1024/1024:.2f} MB")
    print()
    
    print(f"Gzip-1:")
    print(f"  Size: {gzip_result['size']/1024/1024:.2f} MB")
    print(f"  Compress: {gzip_result['compress_time']:.0f}ms ({gzip_result['compress_time']/1000:.1f}s)")
    print(f"  Decompress: {gzip_result['decompress_time']:.0f}ms")
    print(f"  Ratio: {gzip_result['ratio']:.2f}x")
    print()
    
    print(f"Blosc-zstd-5:")
    print(f"  Size: {blosc5_result['size']/1024/1024:.2f} MB")
    print(f"  Compress: {blosc5_result['compress_time']:.0f}ms ({blosc5_result['compress_time']/1000:.1f}s)")
    print(f"  Decompress: {blosc5_result['decompress_time']:.0f}ms")
    print(f"  Ratio: {blosc5_result['ratio']:.2f}x")
    print(f"  vs Gzip: {((gzip_result['size'] - blosc5_result['size'])/gzip_result['size']*100):.1f}% smaller")
    print()
    
    print(f"Blosc-zstd-9:")
    print(f"  Size: {blosc9_result['size']/1024/1024:.2f} MB")
    print(f"  Compress: {blosc9_result['compress_time']:.0f}ms ({blosc9_result['compress_time']/1000:.1f}s)")
    print(f"  Decompress: {blosc9_result['decompress_time']:.0f}ms")
    print(f"  Ratio: {blosc9_result['ratio']:.2f}x")
    print(f"  vs Gzip: {((gzip_result['size'] - blosc9_result['size'])/gzip_result['size']*100):.1f}% smaller")
    print(f"  vs Blosc-5: {((blosc5_result['size'] - blosc9_result['size'])/blosc5_result['size']*100):.1f}% smaller")
    print()
    
    # Extrapolate to 50 volcanoes
    print("=" * 80)
    print("STORAGE COSTS (50 volcanoes, 30-day rolling window)")
    print("=" * 80)
    print()
    
    days_30_gzip = (gzip_result['size'] / 1024 / 1024) * 30 * 50
    days_30_blosc5 = (blosc5_result['size'] / 1024 / 1024) * 30 * 50
    days_30_blosc9 = (blosc9_result['size'] / 1024 / 1024) * 30 * 50
    
    print(f"Gzip-1:")
    print(f"  Per volcano (30 days): {(gzip_result['size'] / 1024 / 1024) * 30:.1f} MB")
    print(f"  50 volcanoes (30 days): {days_30_gzip/1024:.2f} GB")
    print(f"  Cost @ $0.015/GB/month: ${days_30_gzip/1024 * 0.015:.2f}/month")
    print()
    
    print(f"Blosc-zstd-5:")
    print(f"  Per volcano (30 days): {(blosc5_result['size'] / 1024 / 1024) * 30:.1f} MB")
    print(f"  50 volcanoes (30 days): {days_30_blosc5/1024:.2f} GB")
    print(f"  Cost @ $0.015/GB/month: ${days_30_blosc5/1024 * 0.015:.2f}/month")
    print(f"  Savings vs Gzip: ${(days_30_gzip - days_30_blosc5)/1024 * 0.015:.2f}/month")
    print()
    
    print(f"Blosc-zstd-9:")
    print(f"  Per volcano (30 days): {(blosc9_result['size'] / 1024 / 1024) * 30:.1f} MB")
    print(f"  50 volcanoes (30 days): {days_30_blosc9/1024:.2f} GB")
    print(f"  Cost @ $0.015/GB/month: ${days_30_blosc9/1024 * 0.015:.2f}/month")
    print(f"  Savings vs Gzip: ${(days_30_gzip - days_30_blosc9)/1024 * 0.015:.2f}/month")
    print()
    
    print("=" * 80)
    print("RECOMMENDATION:")
    print("=" * 80)
    print()
    
    if blosc5_result['decompress_time'] < 50:  # If decompress is fast enough
        print(f"""
Use Blosc-zstd-5 for storage:

✅ Pros:
  - {blosc5_result['size']/1024/1024:.2f} MB per 24h (vs {gzip_result['size']/1024/1024:.2f} MB with Gzip)
  - {((gzip_result['size'] - blosc5_result['size'])/gzip_result['size']*100):.1f}% smaller than Gzip-1
  - {blosc5_result['decompress_time']:.0f}ms decompress (blazing fast!)
  - ${(days_30_gzip - days_30_blosc5)/1024 * 0.015:.2f}/month savings (50 volcanoes)
  
❌ Cons:
  - Requires blosc.js in browser (~50KB)
  - More complex implementation
  
**For browser delivery:**
- Store as Blosc-zstd-5 on server
- Decompress server-side and send as Gzip-1 to browser
- Best of both worlds: storage savings + universal browser support
""")
    else:
        print("Blosc decompress is too slow for real-time. Stick with Gzip-1.")

if __name__ == '__main__':
    test_24h_compression()









