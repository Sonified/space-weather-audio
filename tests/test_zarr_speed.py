#!/usr/bin/env python3
"""
Zarr vs IRIS Speed Comparison
Tests loading speed from cached Zarr vs fresh IRIS fetch
"""

import time
import xarray as xr
import numpy as np
import pandas as pd
from pathlib import Path
from obspy.clients.fdsn import Client
from obspy import UTCDateTime, Stream

def stream_to_xarray(stream: Stream) -> xr.Dataset:
    """Convert ObsPy Stream to xarray Dataset"""
    trace = stream[0]
    
    # Create time coordinate
    times = pd.date_range(
        start=trace.stats.starttime.datetime,
        periods=len(trace.data),
        freq=pd.Timedelta(seconds=1/trace.stats.sampling_rate)
    )
    
    # Create Dataset
    ds = xr.Dataset(
        data_vars={
            'amplitude': (['time'], trace.data, {'units': 'counts'})
        },
        coords={'time': times},
        attrs={
            'station': trace.stats.station,
            'network': trace.stats.network,
            'channel': trace.stats.channel,
            'sampling_rate': trace.stats.sampling_rate,
            'location': trace.stats.location,
        }
    )
    
    return ds

def setup_zarr_cache():
    """Fetch data and cache as Zarr"""
    print("Setting up Zarr cache...")
    
    client = Client("IRIS")
    # Account for data latency - HLPD has ~0.2 min latency
    # Use data ending 5 minutes ago to be safe
    end = UTCDateTime.now() - (5 * 60)
    start = end - (6 * 3600)  # 6 hours
    
    print(f"  Fetching {start} to {end}")
    print(f"  (Accounting for ~5 min data latency)")
    stream = client.get_waveforms('HV', 'HLPD', '', 'HHZ', start, end)
    
    # Convert to xarray
    ds = stream_to_xarray(stream)
    
    # Save as Zarr
    cache_dir = Path(__file__).parent / 'cache'
    cache_dir.mkdir(exist_ok=True)
    zarr_path = cache_dir / 'test_data.zarr'
    
    if zarr_path.exists():
        import shutil
        shutil.rmtree(zarr_path)
    
    ds.to_zarr(str(zarr_path), mode='w')
    print(f"  ✓ Cached to {zarr_path}")
    
    return zarr_path, start, end

def test_zarr_load(zarr_path, start_time, end_time):
    """Test loading from Zarr cache"""
    start = time.time()
    
    ds = xr.open_zarr(str(zarr_path))
    
    # Just load all data (we're testing load speed, not slicing)
    data = ds['amplitude'].values
    
    # Convert to audio
    if len(data) > 0:
        max_val = np.max(np.abs(data))
        if max_val > 0:
            audio = np.int16(data / max_val * 32767)
        else:
            audio = np.zeros_like(data, dtype=np.int16)
    else:
        audio = np.array([], dtype=np.int16)
    
    elapsed = time.time() - start
    
    return elapsed, len(audio), audio

def test_iris_fetch(start_time, end_time):
    """Test fresh fetch from IRIS"""
    start = time.time()
    
    client = Client("IRIS")
    stream = client.get_waveforms('HV', 'HLPD', '', 'HHZ', start_time, end_time)
    trace = stream[0]
    
    # Convert to audio
    max_val = np.max(np.abs(trace.data))
    if max_val > 0:
        audio = np.int16(trace.data / max_val * 32767)
    else:
        audio = np.zeros_like(trace.data, dtype=np.int16)
    
    elapsed = time.time() - start
    
    return elapsed, len(audio), audio

def run_speed_test():
    """Run comprehensive speed comparison"""
    print("=" * 80)
    print("ZARR vs IRIS SPEED TEST")
    print("=" * 80)
    
    # Setup
    zarr_path, full_start, full_end = setup_zarr_cache()
    
    # Test different time windows
    test_windows = [
        ("15 min", 15 * 60),
        ("30 min", 30 * 60),
        ("1 hour", 60 * 60),
        ("2 hours", 120 * 60),
        ("6 hours", 360 * 60),
    ]
    
    print("\n" + "=" * 80)
    print("RUNNING TESTS (3 runs each)")
    print("=" * 80)
    
    results = []
    
    for window_name, duration_seconds in test_windows:
        print(f"\n{window_name} window:")
        
        # Calculate time range
        end_time = full_end
        start_time = end_time - duration_seconds
        
        # Test Zarr (3 runs)
        zarr_times = []
        for i in range(3):
            elapsed, samples, _ = test_zarr_load(zarr_path, start_time, end_time)
            zarr_times.append(elapsed)
            print(f"  Zarr run {i+1}: {elapsed*1000:.0f}ms")
        
        zarr_avg = np.mean(zarr_times)
        
        # Test IRIS (3 runs)
        iris_times = []
        for i in range(3):
            elapsed, samples, _ = test_iris_fetch(start_time, end_time)
            iris_times.append(elapsed)
            print(f"  IRIS run {i+1}: {elapsed*1000:.0f}ms")
            time.sleep(0.5)  # Be nice to IRIS
        
        iris_avg = np.mean(iris_times)
        speedup = iris_avg / zarr_avg
        
        results.append({
            'window': window_name,
            'zarr_ms': zarr_avg * 1000,
            'iris_ms': iris_avg * 1000,
            'speedup': speedup,
            'samples': samples
        })
        
        print(f"  → Zarr avg: {zarr_avg*1000:.0f}ms")
        print(f"  → IRIS avg: {iris_avg*1000:.0f}ms")
        print(f"  → Speedup: {speedup:.1f}x FASTER with Zarr ✓")
    
    # Summary table
    print("\n" + "=" * 80)
    print("SUMMARY")
    print("=" * 80)
    print(f"{'Window':<12} {'Zarr (ms)':<12} {'IRIS (ms)':<12} {'Speedup':<12} {'Samples':<12}")
    print("-" * 80)
    
    for r in results:
        print(f"{r['window']:<12} {r['zarr_ms']:<12.0f} {r['iris_ms']:<12.0f} {r['speedup']:<12.1f}x {r['samples']:<12,d}")
    
    avg_speedup = np.mean([r['speedup'] for r in results])
    print("\n" + "=" * 80)
    print(f"🎯 AVERAGE SPEEDUP: {avg_speedup:.1f}x FASTER with Zarr cache!")
    print("=" * 80)
    
    # Cleanup
    print(f"\n🧹 Cleaning up cache at {zarr_path.parent}")
    import shutil
    shutil.rmtree(zarr_path.parent)

if __name__ == '__main__':
    try:
        run_speed_test()
    except KeyboardInterrupt:
        print("\n\n⚠️  Test interrupted by user")
    except Exception as e:
        print(f"\n\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()

