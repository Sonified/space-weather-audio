#!/usr/bin/env python3
"""
IRIS Performance Benchmark Tool
Tests optimal chunk sizes for fetching seismic data from IRIS
"""

from obspy.clients.fdsn import Client
from obspy import UTCDateTime
import time
import sys
import numpy as np

def test_fetch(duration_minutes, station_config, location=""):
    """
    Fetch data and measure performance
    
    Args:
        duration_minutes (int): Duration to fetch in minutes
        station_config (dict): Station configuration with network, station, channel
        location (str): Location code
        
    Returns:
        tuple: (fetch_time_seconds, data_size_mb, success)
    """
    try:
        client = Client("IRIS")
        
        end = UTCDateTime.now()
        start = end - (duration_minutes * 60)
        
        start_time = time.time()
        
        stream = client.get_waveforms(
            network=station_config['network'],
            station=station_config['station'],
            location=location,
            channel=station_config['channel'],
            starttime=start,
            endtime=end
        )
        
        fetch_time = time.time() - start_time
        
        if not stream or len(stream) == 0:
            return (None, None, False)
        
        # Calculate data size (approximate based on samples)
        total_samples = sum(trace.stats.npts for trace in stream)
        bytes_per_sample = 4  # Typical for float32
        data_size_bytes = total_samples * bytes_per_sample
        data_size_mb = data_size_bytes / (1024 * 1024)
        
        return (fetch_time, data_size_mb, True)
        
    except Exception as e:
        print(f"  ⚠️  Error fetching {duration_minutes}min: {e}", file=sys.stderr)
        return (None, None, False)

def run_benchmark():
    """
    Test multiple chunk sizes and print results
    """
    print("=" * 80)
    print("IRIS Performance Benchmark")
    print("=" * 80)
    
    # Test configurations
    durations = [5, 10, 15, 30, 60, 120, 360]  # minutes
    station = {'network': 'HV', 'station': 'HLPD', 'channel': 'HHZ'}
    location = ""  # Empty location for HLPD (Kilauea - 0.2 min latency)
    num_runs = 3
    
    print(f"\nStation: {station['network']}.{station['station']}.{location}.{station['channel']}")
    print(f"Number of runs per duration: {num_runs}")
    print(f"Testing durations: {', '.join(map(str, durations))} minutes\n")
    
    # Store results
    results = []
    
    for duration in durations:
        print(f"Testing {duration} min chunk... ", end='', flush=True)
        
        fetch_times = []
        data_sizes = []
        successes = 0
        
        for run in range(num_runs):
            fetch_time, data_size, success = test_fetch(duration, station, location)
            
            if success:
                fetch_times.append(fetch_time)
                data_sizes.append(data_size)
                successes += 1
            
            # Small delay between runs
            if run < num_runs - 1:
                time.sleep(0.5)
        
        if successes > 0:
            avg_fetch_time = np.mean(fetch_times)
            avg_data_size = np.mean(data_sizes)
            time_per_mb = avg_fetch_time / avg_data_size if avg_data_size > 0 else 0
            
            results.append({
                'duration': duration,
                'fetch_time': avg_fetch_time,
                'data_size': avg_data_size,
                'time_per_mb': time_per_mb,
                'successes': successes
            })
            print(f"✓ ({successes}/{num_runs} successful)")
        else:
            print(f"✗ All runs failed")
    
    # Print results table
    print("\n" + "=" * 80)
    print("RESULTS")
    print("=" * 80)
    print(f"{'Duration':<12} {'Fetch Time':<15} {'Data Size':<15} {'Time/MB':<15} {'Success':<10}")
    print(f"{'(min)':<12} {'(seconds)':<15} {'(MB)':<15} {'(sec/MB)':<15} {'Rate':<10}")
    print("-" * 80)
    
    for r in results:
        duration_str = f"{r['duration']}"
        fetch_time_str = f"{r['fetch_time']:.3f}"
        data_size_str = f"{r['data_size']:.2f}"
        time_per_mb_str = f"{r['time_per_mb']:.3f}"
        success_str = f"{r['successes']}/{num_runs}"
        
        print(f"{duration_str:<12} {fetch_time_str:<15} {data_size_str:<15} {time_per_mb_str:<15} {success_str:<10}")
    
    # Find optimal chunk size (minimum time per MB with good success rate)
    if results:
        valid_results = [r for r in results if r['successes'] == num_runs]
        if valid_results:
            optimal = min(valid_results, key=lambda x: x['time_per_mb'])
            print("\n" + "=" * 80)
            print(f"🎯 OPTIMAL CHUNK SIZE: {optimal['duration']} minutes")
            print(f"   Fetch time: {optimal['fetch_time']:.3f}s")
            print(f"   Data size: {optimal['data_size']:.2f} MB")
            print(f"   Efficiency: {optimal['time_per_mb']:.3f} sec/MB")
            print("=" * 80)
        
        # Calculate efficiency ratios
        print("\n" + "=" * 80)
        print("EFFICIENCY ANALYSIS")
        print("=" * 80)
        
        if len(results) >= 2:
            baseline = results[0]
            print(f"Baseline: {baseline['duration']} min chunk @ {baseline['time_per_mb']:.3f} sec/MB\n")
            
            for r in results[1:]:
                if r['successes'] == num_runs:
                    ratio = r['time_per_mb'] / baseline['time_per_mb']
                    if ratio < 1:
                        print(f"  {r['duration']:3d} min: {ratio:.2f}x FASTER than baseline ✓")
                    elif ratio > 1:
                        print(f"  {r['duration']:3d} min: {ratio:.2f}x SLOWER than baseline")
                    else:
                        print(f"  {r['duration']:3d} min: Same as baseline")
        
        print("=" * 80)
    else:
        print("\n⚠️  No successful fetches to analyze!")

if __name__ == '__main__':
    try:
        run_benchmark()
    except KeyboardInterrupt:
        print("\n\n⚠️  Benchmark interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n\n❌ Benchmark failed: {e}", file=sys.stderr)
        sys.exit(1)

