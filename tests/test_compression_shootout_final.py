"""
Final compression shootout: Gzip-1 vs Blosc-5 vs Zstd-3
Test 2 hours of Kilauea data with optimal settings for each format.
"""

import requests
import time

def test_format(format_name, params):
    print(f"\n{'='*60}")
    print(f"Testing {format_name}")
    print('='*60)
    
    url = f'http://localhost:5001/api/zarr/kilauea/2?{params}'
    print(f"URL: {url}")
    
    start = time.time()
    response = requests.get(url)
    elapsed = time.time() - start
    
    if response.status_code == 200:
        size_kb = len(response.content) / 1024
        
        print(f"✅ Success!")
        print(f"   Time: {elapsed:.2f}s")
        print(f"   Size: {size_kb:.1f} KB")
        print(f"   Headers:")
        print(f"     Format: {response.headers.get('X-Compression-Format', 'N/A')}")
        print(f"     Level: {response.headers.get('X-Compression-Level', 'N/A')}")
        print(f"     Sample Rate: {response.headers.get('X-Sample-Rate', 'N/A')}")
        print(f"     Data Points: {response.headers.get('X-Data-Points', 'N/A')}")
        
        return {
            'name': format_name,
            'time': elapsed,
            'size': size_kb,
            'format': response.headers.get('X-Compression-Format'),
            'level': response.headers.get('X-Compression-Level')
        }
    else:
        print(f"❌ Failed!")
        print(f"   Status: {response.status_code}")
        print(f"   Error: {response.text}")
        return None

if __name__ == '__main__':
    print("🌋 COMPRESSION SHOOTOUT: 2 Hours of Kilauea Data")
    print("=" * 60)
    
    results = []
    
    # Test Gzip-1 (fastest gzip)
    r = test_format("Gzip-1", "gzip_level=1")
    if r: results.append(r)
    
    # Test Blosc-5 (optimal blosc)
    r = test_format("Blosc-zstd-5", "format=blosc&blosc_level=5")
    if r: results.append(r)
    
    # Test Zstd-3 (zstd default)
    r = test_format("Zstd-3", "format=zstd&zstd_level=3")
    if r: results.append(r)
    
    # Summary
    print("\n" + "="*60)
    print("SUMMARY (2 hours of Kilauea)")
    print("="*60)
    print(f"{'Format':<20} {'Size (KB)':<12} {'Time (s)':<10} {'vs Gzip-1':<15}")
    print("-"*60)
    
    baseline_size = results[0]['size'] if results else 0
    
    for r in results:
        savings = ((baseline_size - r['size']) / baseline_size * 100) if baseline_size > 0 else 0
        savings_str = f"{savings:+.1f}%" if r['name'] != 'Gzip-1' else "-"
        print(f"{r['name']:<20} {r['size']:<12.1f} {r['time']:<10.2f} {savings_str:<15}")
    
    print("="*60)
    
    # Winner
    smallest = min(results, key=lambda x: x['size'])
    fastest = min(results, key=lambda x: x['time'])
    
    print(f"\n🏆 Smallest file: {smallest['name']} ({smallest['size']:.1f} KB)")
    print(f"⚡ Fastest server: {fastest['name']} ({fastest['time']:.2f}s)")
    
    print("\n" + "="*60)
    print("RECOMMENDATION:")
    print("="*60)
    
    if smallest['name'] == fastest['name']:
        print(f"\n✅ Use {smallest['name']} - best on both metrics!")
    else:
        blosc = next((r for r in results if 'Blosc' in r['name']), None)
        gzip = next((r for r in results if 'Gzip' in r['name']), None)
        
        if blosc and gzip:
            savings_pct = ((gzip['size'] - blosc['size']) / gzip['size'] * 100)
            time_diff = blosc['time'] - gzip['time']
            
            print(f"\n📊 Blosc-5 saves {savings_pct:.1f}% file size")
            print(f"   but takes {time_diff:+.2f}s longer on server")
            print(f"\n💡 For storage: Use Blosc-5 (smaller files)")
            print(f"💡 For delivery: Use Gzip-1 (faster, browser-native)")
            print(f"\n🎯 Optimal: Store as Blosc, decompress server-side, send as Gzip")
    
    print("\n" + "="*60)









