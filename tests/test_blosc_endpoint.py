"""
Quick test to verify Blosc and Gzip endpoints work correctly.
"""

import requests
import time

def test_endpoint(format_type, level):
    print(f"\n{'='*60}")
    print(f"Testing {format_type.upper()} Level {level}")
    print('='*60)
    
    start = time.time()
    
    if format_type == 'blosc':
        url = f'http://localhost:5001/api/zarr/kilauea/1?format=blosc&blosc_level={level}'
    else:
        url = f'http://localhost:5001/api/zarr/kilauea/1?gzip_level={level}'
    
    print(f"Fetching: {url}")
    
    response = requests.get(url)
    
    if response.status_code == 200:
        elapsed = time.time() - start
        size_kb = len(response.content) / 1024
        
        print(f"✅ Success!")
        print(f"   Status: {response.status_code}")
        print(f"   Size: {size_kb:.1f} KB")
        print(f"   Time: {elapsed:.2f}s")
        print(f"   Headers:")
        print(f"     Compression Format: {response.headers.get('X-Compression-Format', 'N/A')}")
        print(f"     Compression Level: {response.headers.get('X-Compression-Level', 'N/A')}")
        print(f"     Sample Rate: {response.headers.get('X-Sample-Rate', 'N/A')}")
        print(f"     Data Points: {response.headers.get('X-Data-Points', 'N/A')}")
    else:
        print(f"❌ Failed!")
        print(f"   Status: {response.status_code}")
        print(f"   Error: {response.text}")

if __name__ == '__main__':
    print("🌋 Testing Flask Endpoints with Blosc and Gzip")
    
    # Test Gzip
    test_endpoint('gzip', 1)
    test_endpoint('gzip', 6)
    
    # Test Blosc
    test_endpoint('blosc', 1)
    test_endpoint('blosc', 5)
    test_endpoint('blosc', 9)
    
    print("\n" + "="*60)
    print("✅ All tests complete!")
    print("="*60)
    print("\nNow open test_browser_blosc.html in your browser to test client-side decompression!")

