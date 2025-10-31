#!/usr/bin/env python3
"""
Simple test: Fetch a chunk from R2 and decompress it.
Paste in a presigned URL from your pipeline dashboard console.
"""

import requests
import time
import zstandard as zstd
import numpy as np


def test_fetch_and_decompress(url):
    """
    Fetch chunk from R2 and decompress it.
    """
    print("╔══════════════════════════════════════════════════════════════════════════════╗")
    print("║           Cache Hit Performance Test (Sleep Well Edition) 😴                ║")
    print("╚══════════════════════════════════════════════════════════════════════════════╝\n")
    
    # Step 1: Fetch
    print("Step 1: Fetching chunk from R2 Storage...")
    
    fetch_start = time.time()
    try:
        response = requests.get(url, timeout=10)
        fetch_time = (time.time() - fetch_start) * 1000
        
        if response.status_code != 200:
            print(f"❌ Failed: {response.status_code}")
            return
        
        compressed_data = response.content
        compressed_size = len(compressed_data)
        
        print(f"✅ Fetched {compressed_size:,} bytes in {fetch_time:.1f}ms")
        print(f"   Throughput: {(compressed_size / 1024) / (fetch_time / 1000):.1f} KB/s")
        
    except Exception as e:
        print(f"❌ Fetch failed: {e}")
        return
    
    # Step 2: Decompress
    print("\n" + "─"*80)
    print("Step 2: Decompressing chunk (Zstd)...")
    
    decompress_start = time.time()
    try:
        dctx = zstd.ZstdDecompressor()
        decompressed_data = dctx.decompress(compressed_data)
        decompress_time = (time.time() - decompress_start) * 1000
        
        # Convert to numpy array
        audio_data = np.frombuffer(decompressed_data, dtype=np.int32)
        samples = len(audio_data)
        duration_seconds = samples / 100  # 100 Hz
        
        print(f"✅ Decompressed to {len(decompressed_data):,} bytes in {decompress_time:.1f}ms")
        print(f"   Samples: {samples:,} ({duration_seconds:.1f} seconds @ 100Hz)")
        print(f"   Compression ratio: {len(decompressed_data) / compressed_size:.2f}x")
        
    except Exception as e:
        print(f"❌ Decompress failed: {e}")
        return
    
    # Results
    print("\n" + "="*80)
    print("📊 FINAL RESULTS")
    print("="*80)
    
    total_time = fetch_time + decompress_time
    
    print(f"\n⏱️  Fetch from R2:     {fetch_time:7.1f}ms")
    print(f"⏱️  Decompress (Zstd): {decompress_time:7.1f}ms")
    print(f"    ━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"⏱️  TOTAL TIME:        {total_time:7.1f}ms")
    
    print("\n💬 What this means:")
    if total_time < 100:
        print("   🚀 EXCELLENT! Sub-100ms = imperceptible to users")
    elif total_time < 200:
        print("   ✅ GREAT! Sub-200ms = feels instant")
    elif total_time < 500:
        print("   👍 GOOD! Sub-500ms = smooth streaming")
    else:
        print("   ⚠️  Could be faster, but still acceptable")
    
    print("\n" + "="*80)
    print("🎯 FULL CACHE HIT SCENARIO (from user click to audio ready):")
    print("="*80)
    
    print(f"""
1. Browser → R2 Worker (SSE request):          ~20-30ms   (network)
2. R2 Worker checks cache:                     ~10-20ms   (R2 lookup)
3. R2 Worker streams chunk inline via SSE:     ~0ms       (already in event)
4. Browser receives compressed chunk:          ~{fetch_time:.0f}ms      (measured above)
5. Browser decompresses chunk:                 ~{decompress_time:.0f}ms       (measured above)
6. Browser applies filters & normalizes:       ~5-10ms    (audio processing)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TOTAL: ~{50 + total_time:.0f}ms from click to audio playback starts

BONUS: With MUSTANG metadata (~500ms), browser gets normalization
       range BEFORE chunks arrive, so UI prepares in parallel.
""")
    
    print("="*80)
    print("💤 Sleep well! Your cached data is FAST. 😴✨")
    print("="*80)


if __name__ == "__main__":
    import sys
    
    if len(sys.argv) < 2:
        print("Usage: python test_simple_fetch_decompress.py <presigned-url>")
        print("\nTo get a URL:")
        print("  1. Open pipeline_dashboard.html")
        print("  2. Click 'Start Stream Test'")
        print("  3. Look in console for lines like:")
        print("     [Browser] 🎯 First chunk ready! Fetching from: https://...")
        print("  4. Copy that URL and paste it as argument")
        print("\nExample:")
        print("  python test_simple_fetch_decompress.py 'https://...r2.cloudflarestorage.com/...'")
        sys.exit(1)
    
    url = sys.argv[1]
    test_fetch_and_decompress(url)



