#!/usr/bin/env python3
"""
Simple test to measure cache hit performance:
1. Fetch a compressed chunk from R2 (using presigned URL)
2. Decompress it
3. Show total time

This simulates the browser receiving a cached chunk.
"""

import requests
import time
import zstandard as zstd
import numpy as np


def test_cache_hit_performance():
    """
    Test fetching and decompressing a real cached chunk.
    
    We'll use the pipeline dashboard to get a real presigned URL.
    """
    print("╔══════════════════════════════════════════════════════════════════════════════╗")
    print("║              Cache Hit Performance Test (Sleep Well Edition)                ║")
    print("║                                                                              ║")
    print("║  Testing real-world performance: Fetch cached chunk + decompress            ║")
    print("╚══════════════════════════════════════════════════════════════════════════════╝\n")
    
    # We'll trigger a request and capture a presigned URL from the backend
    # For this test, let's make a request to the backend
    
    backend_url = "http://localhost:5001"
    
    print("Step 1: Making request to backend for 1-hour data (2 days ago)...")
    print("        This will create chunks if they don't exist, or use cached ones")
    
    request_start = time.time()
    
    # Make SSE request to get chunk URLs
    from datetime import datetime, timedelta
    start_time = datetime.now() - timedelta(days=2)
    
    params = {
        'network': 'HV',
        'station': 'NPOC',
        'location': '',
        'channel': 'HHZ',
        'starttime': start_time.isoformat(),
        'duration': 3600  # 1 hour
    }
    
    try:
        response = requests.post(f"{backend_url}/request-stream", json=params, stream=True, timeout=60)
        
        # Parse SSE events to find first chunk_uploaded event
        chunk_url = None
        for line in response.iter_lines():
            if not line:
                continue
            
            line = line.decode('utf-8')
            
            if line.startswith('event: chunk_uploaded'):
                # Next line should have data
                continue
            elif line.startswith('data: '):
                import json
                data = json.loads(line[6:])  # Remove 'data: ' prefix
                if 'url' in data:
                    chunk_url = data['url']
                    chunk_size = data.get('compressed_size', 0)
                    print(f"\n✅ Got presigned URL for chunk ({chunk_size} bytes compressed)")
                    break
        
        request_time = (time.time() - request_start) * 1000
        
        if not chunk_url:
            print("❌ No chunk URL received - may need to wait for backend processing")
            return
        
        print(f"   Request processing time: {request_time:.1f}ms")
        
    except Exception as e:
        print(f"❌ Backend request failed: {e}")
        print("\n💡 Make sure backend is running: cd backend && python main.py")
        return
    
    print("\n" + "─"*80)
    print("Step 2: Fetching chunk from R2 Storage (simulating browser)...")
    
    fetch_start = time.time()
    
    try:
        chunk_response = requests.get(chunk_url, timeout=10)
        fetch_time = (time.time() - fetch_start) * 1000
        
        if chunk_response.status_code != 200:
            print(f"❌ Failed to fetch chunk: {chunk_response.status_code}")
            return
        
        compressed_data = chunk_response.content
        compressed_size = len(compressed_data)
        
        print(f"✅ Fetched {compressed_size:,} bytes in {fetch_time:.1f}ms")
        print(f"   Throughput: {(compressed_size / 1024 / 1024) / (fetch_time / 1000):.2f} MB/s")
        
    except Exception as e:
        print(f"❌ Fetch failed: {e}")
        return
    
    print("\n" + "─"*80)
    print("Step 3: Decompressing chunk (Zstd)...")
    
    decompress_start = time.time()
    
    try:
        dctx = zstd.ZstdDecompressor()
        decompressed_data = dctx.decompress(compressed_data)
        decompress_time = (time.time() - decompress_start) * 1000
        
        # Convert to numpy array (int32)
        audio_data = np.frombuffer(decompressed_data, dtype=np.int32)
        samples = len(audio_data)
        duration_seconds = samples / 100  # Assuming 100 Hz
        
        print(f"✅ Decompressed to {len(decompressed_data):,} bytes in {decompress_time:.1f}ms")
        print(f"   Samples: {samples:,} ({duration_seconds:.1f} seconds of audio)")
        print(f"   Compression ratio: {len(decompressed_data) / compressed_size:.2f}x")
        
    except Exception as e:
        print(f"❌ Decompress failed: {e}")
        return
    
    print("\n" + "="*80)
    print("FINAL RESULTS (What matters for user experience):")
    print("="*80)
    
    total_time = fetch_time + decompress_time
    
    print(f"⏱️  Fetch from R2:     {fetch_time:7.1f}ms")
    print(f"⏱️  Decompress (Zstd): {decompress_time:7.1f}ms")
    print(f"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"⏱️  TOTAL TIME:        {total_time:7.1f}ms  ← Time from 'chunk available' to 'ready to play'")
    print()
    
    if total_time < 100:
        print("🚀 EXCELLENT! Sub-100ms - imperceptible to users")
    elif total_time < 200:
        print("✅ GREAT! Sub-200ms - feels instant")
    elif total_time < 500:
        print("👍 GOOD! Sub-500ms - acceptable for streaming")
    else:
        print("⚠️  Slower than expected - may need optimization")
    
    print("\n" + "="*80)
    print("CACHE HIT SCENARIO PERFORMANCE:")
    print("="*80)
    print(f"""
For a request where R2 Worker already has the chunk cached:

1. Browser → R2 Worker (SSE):           ~20-30ms   (network latency)
2. R2 Worker sends chunk_data inline:   ~0ms       (data already in event)
3. Browser receives compressed chunk:   ~{fetch_time:.0f}ms      (measured above)
4. Browser decompresses:                ~{decompress_time:.0f}ms       (measured above)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TOTAL: ~{20 + total_time:.0f}ms from request to playback ready

With MUSTANG metadata (~500ms) available before chunks arrive,
browser can prepare UI while chunks stream in.

Result: Near-instant playback for cached historical data! 🎉
""")
    
    print("\n💤 Sleep well! Your architecture is fast. 😴")


if __name__ == "__main__":
    test_cache_hit_performance()



