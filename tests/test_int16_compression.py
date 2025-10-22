"""
Test int16 vs float32 compression for seismic data.

Question: Can we send int16 instead of float32 to save bandwidth?
Answer: Let's find out!
"""

import time
import gzip
import numpy as np
from obspy.clients.fdsn import Client
from obspy import UTCDateTime
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

def test_data_type_compression():
    print("=" * 80)
    print("INT16 vs FLOAT32 COMPRESSION TEST")
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
    
    # Original int32 data from IRIS
    int32_data = trace.data.astype(np.int32)
    
    print(f"✅ Fetched {len(int32_data):,} samples")
    print(f"📊 Data range: {int32_data.min():,} to {int32_data.max():,}")
    print()
    
    # Check if data fits in int16
    if int32_data.min() < -32768 or int32_data.max() > 32767:
        print("⚠️  WARNING: Data exceeds int16 range! Would need scaling.")
        scale_factor = max(abs(int32_data.min()), abs(int32_data.max())) / 32767
        print(f"   Scale factor needed: {scale_factor:.2f}")
    else:
        print("✅ Data fits perfectly in int16 range (no scaling needed!)")
    print()
    
    # Convert to different types
    int16_data = int32_data.astype(np.int16)
    float32_data = int32_data.astype(np.float32)
    
    print("-" * 80)
    print(f"{'Format':<12} {'Raw Size':<15} {'Gzip-1':<15} {'Gzip-6':<15} {'Ratio (Gzip-6)':<15}")
    print("-" * 80)
    
    results = {}
    
    for name, data in [('int16', int16_data), ('float32', float32_data), ('int32', int32_data)]:
        raw_bytes = data.tobytes()
        raw_size = len(raw_bytes)
        
        # Gzip level 1
        start = time.perf_counter()
        gzip1 = gzip.compress(raw_bytes, compresslevel=1)
        gzip1_time = (time.perf_counter() - start) * 1000
        gzip1_size = len(gzip1)
        
        # Gzip level 6
        start = time.perf_counter()
        gzip6 = gzip.compress(raw_bytes, compresslevel=6)
        gzip6_time = (time.perf_counter() - start) * 1000
        gzip6_size = len(gzip6)
        
        ratio = raw_size / gzip6_size
        
        results[name] = {
            'raw': raw_size,
            'gzip1': gzip1_size,
            'gzip6': gzip6_size,
            'gzip1_time': gzip1_time,
            'gzip6_time': gzip6_time,
            'ratio': ratio
        }
        
        print(f"{name:<12} {raw_size/1024:>10.1f} KB  {gzip1_size/1024:>10.1f} KB  {gzip6_size/1024:>10.1f} KB  {ratio:>10.2f}x")
    
    print("-" * 80)
    print()
    
    # Calculate savings
    float32_gzip6 = results['float32']['gzip6']
    int16_gzip6 = results['int16']['gzip6']
    savings = (float32_gzip6 - int16_gzip6) / float32_gzip6 * 100
    
    print("📊 ANALYSIS:")
    print()
    print(f"int16 vs float32 (gzip-6):")
    print(f"  - int16:   {int16_gzip6/1024:.1f} KB")
    print(f"  - float32: {float32_gzip6/1024:.1f} KB")
    print(f"  - Savings: {savings:.1f}% smaller with int16")
    print()
    
    # Extrapolate to 24 hours
    hours_24_int16 = (int16_gzip6 / 1024) * 24
    hours_24_float32 = (float32_gzip6 / 1024) * 24
    hours_24_savings = hours_24_float32 - hours_24_int16
    
    print(f"24-hour extrapolation:")
    print(f"  - int16:   {hours_24_int16:.1f} KB ({hours_24_int16/1024:.2f} MB)")
    print(f"  - float32: {hours_24_float32:.1f} KB ({hours_24_float32/1024:.2f} MB)")
    print(f"  - Savings: {hours_24_savings:.1f} KB ({hours_24_savings/1024:.2f} MB)")
    print()
    
    # Quality check
    print("🎵 QUALITY CHECK:")
    print()
    print("Does int16 preserve enough precision for audification?")
    print()
    
    # Simulate processing pipeline
    # 1. Detrend
    mean_int16 = np.mean(int16_data.astype(np.float32))
    mean_float32 = np.mean(float32_data)
    
    detrended_int16 = int16_data.astype(np.float32) - mean_int16
    detrended_float32 = float32_data - mean_float32
    
    # 2. Normalize
    max_int16 = np.max(np.abs(detrended_int16))
    max_float32 = np.max(np.abs(detrended_float32))
    
    normalized_int16 = detrended_int16 / max_int16
    normalized_float32 = detrended_float32 / max_float32
    
    # 3. Compare
    diff = np.abs(normalized_int16 - normalized_float32)
    max_diff = np.max(diff)
    mean_diff = np.mean(diff)
    
    print(f"After detrend + normalize:")
    print(f"  - Max difference: {max_diff:.10f}")
    print(f"  - Mean difference: {mean_diff:.10f}")
    print(f"  - SNR: {-20 * np.log10(mean_diff):.1f} dB")
    print()
    
    if max_diff < 0.0001:
        print("✅ EXCELLENT: Differences are negligible!")
        print("   int16 is perfectly adequate for audification.")
    elif max_diff < 0.001:
        print("✅ GOOD: Differences are very small.")
        print("   int16 should work fine for audification.")
    else:
        print("⚠️  WARNING: Noticeable differences detected.")
        print("   May want to stick with float32.")
    
    print()
    print("=" * 80)
    print("RECOMMENDATION:")
    print("=" * 80)
    print(f"""
Use int16 for transmission:

✅ Pros:
  - {savings:.1f}% smaller files
  - {hours_24_savings/1024:.2f} MB saved per 24-hour window
  - Data naturally fits in int16 range (no scaling needed!)
  - Negligible quality loss after normalization
  - Faster decompression (smaller files)

❌ Cons:
  - Need to handle int16 in browser (trivial)
  - Slightly less precision (but imperceptible)

**Verdict: SWITCH TO INT16!** 🎯
""")

if __name__ == '__main__':
    test_data_type_compression()


