"""
Test browser-native compression formats on seismic data.

Formats tested:
- Gzip (universal)
- Brotli (modern browsers)
- Deflate (older)
- Zstd (experimental)

All are natively supported by browsers via HTTP Content-Encoding.
"""

import time
import gzip
import zlib  # deflate
import numpy as np
from obspy.clients.fdsn import Client
from obspy import UTCDateTime
import sys
import os

# Try to import brotli (may not be installed)
try:
    import brotli
    HAS_BROTLI = True
except ImportError:
    HAS_BROTLI = False
    print("⚠️  Brotli not installed. Install with: pip install brotli")

# Try to import zstd (may not be installed)
try:
    import zstandard as zstd
    HAS_ZSTD = True
except ImportError:
    HAS_ZSTD = False
    print("⚠️  Zstandard not installed. Install with: pip install zstandard")

# Try to import blosc (may not be installed)
try:
    import blosc
    HAS_BLOSC = True
except ImportError:
    HAS_BLOSC = False
    print("⚠️  Blosc not installed. Install with: pip install blosc")

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

def test_compression_formats():
    print("=" * 80)
    print("BROWSER-NATIVE COMPRESSION FORMAT COMPARISON")
    print("=" * 80)
    print()
    
    # Fetch 1 hour of Kilauea data
    print("📡 Fetching 1 hour of Kilauea seismic data...")
    client = Client("IRIS")
    end = UTCDateTime.now()
    start = end - 3600
    
    try:
        stream = client.get_waveforms('HV', 'HLPD', '', 'HHZ', start, end)
    except:
        stream = client.get_waveforms('HV', 'HLPD', '01', 'HHZ', start, end)
    
    stream.merge(fill_value='interpolate')
    trace = stream[0]
    
    # Use int16 (our optimal format)
    int16_data = trace.data.astype(np.int16)
    raw_bytes = int16_data.tobytes()
    raw_size = len(raw_bytes)
    
    print(f"✅ Fetched {len(int16_data):,} samples")
    print(f"📊 Raw int16 size: {raw_size:,} bytes ({raw_size/1024:.1f} KB)")
    print()
    
    print("-" * 100)
    print(f"{'Format':<15} {'Level':<8} {'Compress':<12} {'Decompress':<12} {'Size (KB)':<12} {'Ratio':<10} {'Browser Support':<20}")
    print("-" * 100)
    
    results = []
    
    # Test Gzip (levels 1, 6, 9)
    for level in [1, 6, 9]:
        start_time = time.perf_counter()
        compressed = gzip.compress(raw_bytes, compresslevel=level)
        compress_time = (time.perf_counter() - start_time) * 1000
        
        start_time = time.perf_counter()
        decompressed = gzip.decompress(compressed)
        decompress_time = (time.perf_counter() - start_time) * 1000
        
        assert decompressed == raw_bytes
        
        size = len(compressed)
        ratio = raw_size / size
        
        results.append({
            'format': 'Gzip',
            'level': level,
            'compress_time': compress_time,
            'decompress_time': decompress_time,
            'size': size,
            'ratio': ratio,
            'support': '✅ Universal'
        })
        
        print(f"{'Gzip':<15} {level:<8} {compress_time:<11.1f}ms {decompress_time:<11.1f}ms {size/1024:<11.1f} {ratio:<9.2f}x {'✅ Universal':<20}")
    
    # Test Deflate (similar to gzip but different header)
    for level in [1, 6, 9]:
        start_time = time.perf_counter()
        compressed = zlib.compress(raw_bytes, level=level)
        compress_time = (time.perf_counter() - start_time) * 1000
        
        start_time = time.perf_counter()
        decompressed = zlib.decompress(compressed)
        decompress_time = (time.perf_counter() - start_time) * 1000
        
        assert decompressed == raw_bytes
        
        size = len(compressed)
        ratio = raw_size / size
        
        results.append({
            'format': 'Deflate',
            'level': level,
            'compress_time': compress_time,
            'decompress_time': decompress_time,
            'size': size,
            'ratio': ratio,
            'support': '✅ Universal'
        })
        
        print(f"{'Deflate':<15} {level:<8} {compress_time:<11.1f}ms {decompress_time:<11.1f}ms {size/1024:<11.1f} {ratio:<9.2f}x {'✅ Universal':<20}")
    
    # Test Brotli (if available)
    if HAS_BROTLI:
        for level in [1, 6, 11]:  # Brotli goes 0-11
            start_time = time.perf_counter()
            compressed = brotli.compress(raw_bytes, quality=level)
            compress_time = (time.perf_counter() - start_time) * 1000
            
            start_time = time.perf_counter()
            decompressed = brotli.decompress(compressed)
            decompress_time = (time.perf_counter() - start_time) * 1000
            
            assert decompressed == raw_bytes
            
            size = len(compressed)
            ratio = raw_size / size
            
            results.append({
                'format': 'Brotli',
                'level': level,
                'compress_time': compress_time,
                'decompress_time': decompress_time,
                'size': size,
                'ratio': ratio,
                'support': '✅ Modern (2015+)'
            })
            
            print(f"{'Brotli':<15} {level:<8} {compress_time:<11.1f}ms {decompress_time:<11.1f}ms {size/1024:<11.1f} {ratio:<9.2f}x {'✅ Modern (2015+)':<20}")
    
    # Test Zstd (if available)
    if HAS_ZSTD:
        cctx = zstd.ZstdCompressor()
        dctx = zstd.ZstdDecompressor()
        
        for level in [1, 6, 19]:  # Zstd goes 1-22
            cctx = zstd.ZstdCompressor(level=level)
            
            start_time = time.perf_counter()
            compressed = cctx.compress(raw_bytes)
            compress_time = (time.perf_counter() - start_time) * 1000
            
            start_time = time.perf_counter()
            decompressed = dctx.decompress(compressed)
            decompress_time = (time.perf_counter() - start_time) * 1000
            
            assert decompressed == raw_bytes
            
            size = len(compressed)
            ratio = raw_size / size
            
            results.append({
                'format': 'Zstd',
                'level': level,
                'compress_time': compress_time,
                'decompress_time': decompress_time,
                'size': size,
                'ratio': ratio,
                'support': '⚠️  Limited (2020+)'
            })
            
            print(f"{'Zstd':<15} {level:<8} {compress_time:<11.1f}ms {decompress_time:<11.1f}ms {size/1024:<11.1f} {ratio:<9.2f}x {'⚠️  Limited (2020+)':<20}")
    
    # Test Blosc (if available) - NOTE: Not browser-native, requires JS library
    if HAS_BLOSC:
        for compressor in ['blosclz', 'lz4', 'zstd']:
            for level in [1, 5, 9]:
                start_time = time.perf_counter()
                compressed = blosc.compress(raw_bytes, typesize=2, cname=compressor, clevel=level, shuffle=blosc.SHUFFLE)
                compress_time = (time.perf_counter() - start_time) * 1000
                
                start_time = time.perf_counter()
                decompressed = blosc.decompress(compressed)
                decompress_time = (time.perf_counter() - start_time) * 1000
                
                assert decompressed == raw_bytes
                
                size = len(compressed)
                ratio = raw_size / size
                
                results.append({
                    'format': f'Blosc-{compressor}',
                    'level': level,
                    'compress_time': compress_time,
                    'decompress_time': decompress_time,
                    'size': size,
                    'ratio': ratio,
                    'support': '❌ Needs JS lib'
                })
                
                print(f"{f'Blosc-{compressor}':<15} {level:<8} {compress_time:<11.1f}ms {decompress_time:<11.1f}ms {size/1024:<11.1f} {ratio:<9.2f}x {'❌ Needs JS lib':<20}")
    
    print("-" * 100)
    print()
    
    # Find best options
    print("📊 ANALYSIS:")
    print()
    
    # Best compression
    best_compression = min(results, key=lambda x: x['size'])
    print(f"🏆 Best compression: {best_compression['format']} level {best_compression['level']}")
    print(f"   Size: {best_compression['size']/1024:.1f} KB ({best_compression['ratio']:.2f}x)")
    print(f"   Decompress: {best_compression['decompress_time']:.1f}ms")
    print(f"   Support: {best_compression['support']}")
    print()
    
    # Fastest decompression
    fastest = min(results, key=lambda x: x['decompress_time'])
    print(f"⚡ Fastest decompression: {fastest['format']} level {fastest['level']}")
    print(f"   Decompress: {fastest['decompress_time']:.1f}ms")
    print(f"   Size: {fastest['size']/1024:.1f} KB ({fastest['ratio']:.2f}x)")
    print()
    
    # Best balance (universal support + good compression)
    universal = [r for r in results if '✅ Universal' in r['support']]
    best_universal = min(universal, key=lambda x: x['size'])
    print(f"⚖️  Best universal option: {best_universal['format']} level {best_universal['level']}")
    print(f"   Size: {best_universal['size']/1024:.1f} KB ({best_universal['ratio']:.2f}x)")
    print(f"   Decompress: {best_universal['decompress_time']:.1f}ms")
    print()
    
    # Compare Brotli to Gzip
    if HAS_BROTLI:
        gzip6 = next(r for r in results if r['format'] == 'Gzip' and r['level'] == 6)
        brotli6 = next(r for r in results if r['format'] == 'Brotli' and r['level'] == 6)
        
        savings = (gzip6['size'] - brotli6['size']) / gzip6['size'] * 100
        
        print(f"🆚 Brotli-6 vs Gzip-6:")
        print(f"   Gzip-6:   {gzip6['size']/1024:.1f} KB")
        print(f"   Brotli-6: {brotli6['size']/1024:.1f} KB")
        print(f"   Savings:  {savings:.1f}% smaller with Brotli")
        print(f"   Decompress: {brotli6['decompress_time']:.1f}ms vs {gzip6['decompress_time']:.1f}ms")
        print()
    
    print("=" * 80)
    print("BROWSER SUPPORT:")
    print("=" * 80)
    print("""
Gzip/Deflate:
  ✅ All browsers since 1996
  ✅ HTTP/1.1 standard
  ✅ Works everywhere
  
Brotli:
  ✅ Chrome 50+ (2016)
  ✅ Firefox 44+ (2016)
  ✅ Safari 11+ (2017)
  ✅ Edge 15+ (2017)
  ✅ 95%+ global support (Can I Use)
  
Zstd:
  ⚠️  Chrome 123+ (2024)
  ⚠️  Firefox 126+ (2024)
  ❌ Safari: Not yet
  ⚠️  ~60% global support
""")
    
    print("=" * 80)
    print("RECOMMENDATION:")
    print("=" * 80)
    
    if HAS_BROTLI:
        gzip1 = next(r for r in results if r['format'] == 'Gzip' and r['level'] == 1)
        brotli6 = next(r for r in results if r['format'] == 'Brotli' and r['level'] == 6)
        savings_24h = ((gzip1['size'] - brotli6['size']) / 1024) * 24
        
        print(f"""
Use Brotli with Gzip fallback:

**Primary: Brotli-6**
  - {brotli6['size']/1024:.1f} KB per hour
  - {brotli6['decompress_time']:.1f}ms decompress
  - 95%+ browser support
  - {((gzip1['size'] - brotli6['size']) / gzip1['size'] * 100):.1f}% smaller than Gzip-1
  
**Fallback: Gzip-1**  
  - {gzip1['size']/1024:.1f} KB per hour
  - {gzip1['decompress_time']:.1f}ms decompress
  - 100% browser support
  - Fast compression
  
**Implementation:**
```python
# Server: Compress with both
brotli_data = brotli.compress(data, quality=6)
gzip_data = gzip.compress(data, compresslevel=1)

# Send based on Accept-Encoding header
if 'br' in request.headers.get('Accept-Encoding', ''):
    return brotli_data, {{'Content-Encoding': 'br'}}
else:
    return gzip_data, {{'Content-Encoding': 'gzip'}}
```

**Savings: {savings_24h:.1f} KB per 24h window with Brotli!**
""")
    else:
        print("""
Install brotli to test:
  pip install brotli

Then re-run this test!
""")

if __name__ == '__main__':
    test_compression_formats()

