"""
Test HTTP-level compression vs no compression for progressive streaming
Measures actual network transfer time and bandwidth usage
"""

import requests
import time
import numpy as np

def test_streaming(use_compression=True):
    """
    Test progressive streaming with or without HTTP compression
    """
    label = "WITH HTTP Compression" if use_compression else "WITHOUT Compression"
    print(f"\n{'='*70}")
    print(f"🧪 Testing: {label}")
    print('='*70)
    
    url = "http://localhost:5001/api/progressive-test?storage=raw&compression=none"
    
    headers = {}
    if not use_compression:
        # Tell server we don't want compression
        headers['Accept-Encoding'] = 'identity'
    
    test_start = time.time()
    
    try:
        response = requests.get(url, stream=True, headers=headers)
        
        if response.status_code != 200:
            print(f"❌ Error: HTTP {response.status_code}")
            return None
        
        # Check if response is compressed
        content_encoding = response.headers.get('Content-Encoding', 'none')
        content_length = response.headers.get('Content-Length', 'unknown')
        
        print(f"📦 Content-Encoding: {content_encoding}")
        print(f"📊 Content-Length: {content_length}")
        
        chunks_received = []
        bytes_received = 0
        ttfa = None
        chunk_count = 0
        
        # Read the stream
        chunk_start = time.time()
        for chunk in response.iter_content(chunk_size=8192):
            if chunk:
                bytes_received += len(chunk)
                chunk_count += 1
                
                # Record time to first chunk
                if ttfa is None:
                    ttfa = (time.time() - test_start) * 1000
                    print(f"⚡ Time to First Chunk: {ttfa:.0f} ms")
                
                # Show progress every 100KB
                if bytes_received % (100 * 1024) < 8192:
                    elapsed = (time.time() - test_start) * 1000
                    print(f"   Received: {bytes_received/(1024*1024):.2f} MB in {elapsed:.0f} ms")
        
        total_time = (time.time() - test_start) * 1000
        
        # Parse the data as int16
        int16_data = np.frombuffer(b''.join([chunk for chunk in response.iter_content(chunk_size=8192)]), dtype=np.int16)
        
        result = {
            'label': label,
            'compression': content_encoding,
            'bytes_transferred': bytes_received,
            'ttfa': ttfa,
            'total_time': total_time,
            'throughput_mbps': (bytes_received * 8 / 1000000) / (total_time / 1000)
        }
        
        print(f"\n📊 Summary:")
        print(f"   Content-Encoding: {content_encoding}")
        print(f"   Bytes Transferred: {bytes_received/(1024*1024):.2f} MB")
        print(f"   Time to First Chunk: {ttfa:.0f} ms")
        print(f"   Total Time: {total_time/1000:.2f} s")
        print(f"   Throughput: {result['throughput_mbps']:.2f} Mbps")
        
        return result
        
    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return None

if __name__ == '__main__':
    print("🌋 HTTP COMPRESSION TEST")
    print("="*70)
    print("Testing raw int16 streaming with and without HTTP compression")
    print("="*70)
    
    # Test without compression
    result_no_compress = test_streaming(use_compression=False)
    
    time.sleep(2)
    
    # Test with compression
    result_compress = test_streaming(use_compression=True)
    
    # Compare
    if result_no_compress and result_compress:
        print("\n" + "="*70)
        print("📊 COMPARISON")
        print("="*70)
        
        print(f"\n{'Configuration':<30} {'Bytes':<15} {'TTFA (ms)':<12} {'Total (s)':<10} {'Mbps':<10}")
        print("-"*80)
        print(f"{result_no_compress['label']:<30} "
              f"{result_no_compress['bytes_transferred']/(1024*1024):<15.2f} "
              f"{result_no_compress['ttfa']:<12.0f} "
              f"{result_no_compress['total_time']/1000:<10.2f} "
              f"{result_no_compress['throughput_mbps']:<10.2f}")
        print(f"{result_compress['label']:<30} "
              f"{result_compress['bytes_transferred']/(1024*1024):<15.2f} "
              f"{result_compress['ttfa']:<12.0f} "
              f"{result_compress['total_time']/1000:<10.2f} "
              f"{result_compress['throughput_mbps']:<10.2f}")
        
        if result_compress['bytes_transferred'] < result_no_compress['bytes_transferred']:
            savings = 100 * (1 - result_compress['bytes_transferred'] / result_no_compress['bytes_transferred'])
            print(f"\n💰 Bandwidth Savings: {savings:.1f}%")
        
        print("\n" + "="*70)

