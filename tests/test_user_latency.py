#!/usr/bin/env python3
"""
User-Facing Latency Benchmark: On-Demand vs Pre-Processed Audio Chunks

ACTUAL audification process (NO downsampling):
- Load seismic data (100 Hz)
- Detrend (remove DC offset)
- Taper (reduce edge effects)
- Normalize (across full time range)
- Save as WAV at 44,100 Hz (metadata change - ALL samples preserved)

Comparison:
- Approach A: Load Zarr → detrend → taper → normalize → WAV (on-demand processing)
- Approach B: Load pre-processed WAV chunks → concatenate → normalize → WAV (pre-processed)

Both approaches preserve EVERY seismic sample (complete data integrity).
Background processing (IRIS fetch, Zarr creation, pre-processing) is NOT measured.
"""

import time
import numpy as np
import xarray as xr
import zarr
from pathlib import Path
from obspy.clients.fdsn import Client
from obspy import UTCDateTime, Trace
import pandas as pd
from scipy.io import wavfile
import shutil

# Configuration
STATION_CONFIG = {
    'network': 'HV',
    'station': 'HLPD',
    'channel': 'HHZ',
    'location': ''
}

TEST_DURATIONS = [1, 3, 6, 12, 24]  # hours
SEISMIC_SAMPLE_RATE = 100  # Hz (actual seismic data rate)
AUDIO_SAMPLE_RATE = 44100  # Hz (metadata for WAV playback)
CHUNK_MINUTES = 10  # Pre-audified chunk size
NUM_RUNS = 3

# TOGGLE: Time array mode for visualization
# Options: False (audio only), 'full' (full time array), 'endpoints' (first+last only)
TIME_ARRAY_MODE = 'endpoints'  # False, 'full', or 'endpoints'

# Paths
CACHE_DIR = Path(__file__).parent / 'cache_user_latency'
ZARR_DIR = CACHE_DIR / 'zarr'
AUDIO_CHUNKS_DIR = CACHE_DIR / 'audio_chunks'  # Pre-normalized chunks


def setup_test_data():
    """
    Background setup (NOT measured):
    - Fetch data from IRIS
    - Save as Zarr (numpy arrays - raw seismic counts)
    - Save 10-min chunks as raw WAV files (NO processing)
    """
    print("\n" + "="*70)
    print("SETUP (Background Processing - Not Measured)")
    print("="*70)
    
    CACHE_DIR.mkdir(exist_ok=True)
    ZARR_DIR.mkdir(exist_ok=True)
    AUDIO_CHUNKS_DIR.mkdir(exist_ok=True)
    
    client = Client("IRIS")
    
    # Fetch max duration of data (covers all test cases)
    max_duration = max(TEST_DURATIONS)
    end_time = UTCDateTime.now() - 300  # 5 min ago for latency
    start_time = end_time - (max_duration * 3600)
    
    print(f"\nFetching {max_duration}h from IRIS...")
    print(f"  {STATION_CONFIG['network']}.{STATION_CONFIG['station']}.{STATION_CONFIG['location'] or '--'}.{STATION_CONFIG['channel']}")
    print(f"  {start_time} to {end_time}")
    
    try:
        stream = client.get_waveforms(
            STATION_CONFIG['network'],
            STATION_CONFIG['station'],
            STATION_CONFIG['location'],
            STATION_CONFIG['channel'],
            start_time,
            end_time
        )
    except Exception as e:
        print(f"Error fetching data: {e}")
        return None
    
    if not stream or len(stream) == 0:
        print("No data returned")
        return None
    
    trace = stream[0]
    print(f"  ✓ Got {len(trace.data)} samples")
    
    # Convert to xarray
    print("\nCreating Zarr dataset...")
    times = pd.date_range(
        start=trace.stats.starttime.datetime,
        periods=len(trace.data),
        freq=pd.Timedelta(seconds=1/trace.stats.sampling_rate)
    )
    
    ds = xr.Dataset(
        data_vars={'amplitude': (['time'], trace.data)},
        coords={'time': times},
        attrs={
            'station': trace.stats.station,
            'network': trace.stats.network,
            'channel': trace.stats.channel,
            'sampling_rate': trace.stats.sampling_rate,
        }
    )
    
    # Save as Zarr with Blosc-zstd-5
    zarr_path = ZARR_DIR / 'data.zarr'
    if zarr_path.exists():
        shutil.rmtree(zarr_path)
    
    from zarr.codecs import BloscCodec, BytesCodec
    
    ds.to_zarr(
        str(zarr_path),
        mode='w',
        encoding={
            'amplitude': {
                'compressor': None,  # xarray doesn't support zarr v3 codecs yet
                'chunks': (360000,)  # 1 hour at 100 Hz
            }
        }
    )
    print(f"  ✓ Saved to {zarr_path}")
    
    # Save raw 10-minute chunks as WAV (NO processing)
    print(f"\nSaving {CHUNK_MINUTES}-minute raw audio chunks...")
    chunk_samples = CHUNK_MINUTES * 60 * SEISMIC_SAMPLE_RATE
    total_samples = len(trace.data)
    num_chunks = int(np.ceil(total_samples / chunk_samples))
    
    for i in range(num_chunks):
        start_idx = i * chunk_samples
        end_idx = min((i + 1) * chunk_samples, total_samples)
        chunk_data = trace.data[start_idx:end_idx].copy()
        
        # Save as WAV (raw seismic data, NO detrend/taper/normalize)
        chunk_path = AUDIO_CHUNKS_DIR / f'audio_chunk_{i:03d}.wav'
        wavfile.write(str(chunk_path), AUDIO_SAMPLE_RATE, chunk_data.astype(np.int32))
    
    print(f"  ✓ Saved {num_chunks} raw WAV chunks")
    
    return {
        'zarr_path': zarr_path,
        'start_time': trace.stats.starttime.datetime,
        'end_time': trace.stats.endtime.datetime,
        'sample_rate': trace.stats.sampling_rate
    }


def approach_a_ondemand(zarr_path, start_time_dt, duration_hours):
    """
    Approach A: On-Demand Audification
    Load Zarr → detrend → taper → normalize → convert to int16
    (+ optionally load time data for visualization)
    """
    # Load Zarr (numpy arrays - raw seismic counts)
    ds = xr.open_zarr(str(zarr_path))
    
    # Extract time range
    end_time_dt = start_time_dt + pd.Timedelta(hours=duration_hours)
    subset = ds.sel(time=slice(start_time_dt, end_time_dt))
    data = subset['amplitude'].values
    
    # Load time data if needed for visualization
    time_data = None
    if TIME_ARRAY_MODE == 'full':
        time_data = subset['time'].values
    elif TIME_ARRAY_MODE == 'endpoints':
        times = subset['time'].values
        time_data = (times[0], times[-1])  # Just first and last
    
    # Create ObsPy trace
    tr = Trace(data=data)
    tr.stats.sampling_rate = SEISMIC_SAMPLE_RATE
    
    # Pre-process (USER-FACING COMPUTATION)
    tr.detrend('demean')
    tr.taper(max_percentage=0.0001)
    
    # Normalize
    max_val = np.max(np.abs(tr.data))
    if max_val > 0:
        normalized = tr.data / max_val
    else:
        normalized = tr.data
    
    # Convert to int16
    audio_int16 = np.int16(normalized * 32767)
    
    if TIME_ARRAY_MODE:
        return audio_int16, time_data
    return audio_int16


def approach_b_preprocessed(duration_hours, zarr_path, start_time_dt):
    """
    Approach B: Load WAV Chunks
    Load raw WAV chunks → concatenate → detrend → taper → normalize → int16
    (+ optionally load time data from Zarr for visualization)
    """
    # Calculate how many chunks we need
    samples_needed = duration_hours * 3600 * SEISMIC_SAMPLE_RATE
    chunk_samples = CHUNK_MINUTES * 60 * SEISMIC_SAMPLE_RATE
    num_chunks_needed = int(np.ceil(samples_needed / chunk_samples))
    
    # Load and concatenate raw WAV chunks
    chunks = []
    for i in range(num_chunks_needed):
        chunk_path = AUDIO_CHUNKS_DIR / f'audio_chunk_{i:03d}.wav'
        if chunk_path.exists():
            rate, audio_data = wavfile.read(str(chunk_path))
            chunks.append(audio_data)
    
    # Concatenate
    full_data = np.concatenate(chunks)
    
    # Trim to exact duration
    full_data = full_data[:samples_needed]
    
    # Load time data from Zarr if needed for visualization
    time_data = None
    if TIME_ARRAY_MODE:
        ds = xr.open_zarr(str(zarr_path))
        end_time_dt = start_time_dt + pd.Timedelta(hours=duration_hours)
        subset = ds.sel(time=slice(start_time_dt, end_time_dt))
        
        if TIME_ARRAY_MODE == 'full':
            time_data = subset['time'].values
        elif TIME_ARRAY_MODE == 'endpoints':
            times = subset['time'].values
            time_data = (times[0], times[-1])  # Just first and last
    
    # Create ObsPy trace for processing
    tr = Trace(data=full_data)
    tr.stats.sampling_rate = SEISMIC_SAMPLE_RATE
    
    # Process (detrend + taper on FULL concatenated data)
    tr.detrend('demean')
    tr.taper(max_percentage=0.0001)
    
    # Normalize across entire dataset
    max_val = np.max(np.abs(tr.data))
    if max_val > 0:
        normalized = tr.data / max_val
    else:
        normalized = tr.data
    
    # Convert to int16
    audio_int16 = np.int16(normalized * 32767)
    
    if TIME_ARRAY_MODE:
        return audio_int16, time_data
    return audio_int16


def benchmark_approach(approach_func, duration_hours, zarr_path=None):
    """Run a single approach multiple times and measure latency"""
    times = []
    
    for run in range(NUM_RUNS):
        start = time.time()
        
        # Get start time for both approaches
        setup_data = xr.open_zarr(str(zarr_path))
        start_time_dt = setup_data['time'].values[0]
        
        if approach_func == approach_a_ondemand:
            # Approach A: Zarr time-slicing
            result = approach_func(zarr_path, start_time_dt, duration_hours)
        else:
            # Approach B: WAV chunks + Zarr time array (if enabled)
            result = approach_func(duration_hours, zarr_path, start_time_dt)
        
        elapsed = time.time() - start
        times.append(elapsed * 1000)  # Convert to ms
    
    return times


def run_benchmark():
    """Main benchmark runner"""
    print("\n" + "="*70)
    print("USER-FACING LATENCY BENCHMARK")
    print("="*70)
    print("\nThis test measures ONLY the time from 'user clicks button'")
    print("to 'audio is ready'. Background processing is NOT measured.")
    if TIME_ARRAY_MODE == 'full':
        print("\n⏱️  FULL TIME ARRAYS: Loading complete time array for visualization")
    elif TIME_ARRAY_MODE == 'endpoints':
        print("\n⏱️  ENDPOINTS ONLY: Loading first + last timestamp (minimal overhead)")
    else:
        print("\n🎵 AUDIO ONLY: No time data loaded")
    print("="*70)
    
    # Setup (background processing - not measured)
    setup_data = setup_test_data()
    if not setup_data:
        print("Setup failed. Exiting.")
        return
    
    zarr_path = setup_data['zarr_path']
    start_time_dt = setup_data['start_time']
    
    print("\n" + "="*70)
    print("RUNNING BENCHMARKS")
    print("="*70)
    
    results = []
    
    for duration in TEST_DURATIONS:
        print(f"\n{'─'*70}")
        print(f"Test: {duration} hour(s) of data")
        print('─'*70)
        
        # Approach A: On-Demand
        print("\nApproach A (On-Demand Audification):")
        times_a = benchmark_approach(approach_a_ondemand, duration, zarr_path)
        for i, t in enumerate(times_a, 1):
            print(f"  Run {i}: {t:.1f}ms")
        avg_a = np.mean(times_a)
        print(f"  Average: {avg_a:.1f}ms")
        
        # Approach B: WAV Chunks
        print("\nApproach B (Load WAV Chunks):")
        times_b = benchmark_approach(approach_b_preprocessed, duration, zarr_path)
        for i, t in enumerate(times_b, 1):
            print(f"  Run {i}: {t:.1f}ms")
        avg_b = np.mean(times_b)
        print(f"  Average: {avg_b:.1f}ms")
        
        # Calculate speedup
        if avg_b < avg_a:
            speedup = avg_a / avg_b
            winner = "B (WAV Chunks)"
            print(f"\n✓ Approach B is {speedup:.2f}x FASTER")
        else:
            speedup = avg_b / avg_a
            winner = "A (Zarr Slice)"
            print(f"\n✓ Approach A is {speedup:.2f}x FASTER")
        
        results.append({
            'duration': duration,
            'avg_a': avg_a,
            'avg_b': avg_b,
            'winner': winner,
            'speedup': speedup
        })
    
    # Summary
    print("\n" + "="*70)
    print("SUMMARY")
    print("="*70)
    print(f"\n{'Duration':<12} {'Zarr Slice':<15} {'WAV Chunks':<15} {'Winner':<18}")
    print('─'*70)
    for r in results:
        print(f"{r['duration']}h{' '*10} {r['avg_a']:>6.1f}ms{' '*7} {r['avg_b']:>6.1f}ms{' '*7} {r['winner']}")
    
    # Recommendation
    print("\n" + "="*70)
    print("RECOMMENDATION")
    print("="*70)
    
    avg_speedup_b = np.mean([r['speedup'] if r['winner'].startswith('B') else 1/r['speedup'] for r in results])
    
    if avg_speedup_b > 1.5:
        print("\n🎯 WAV Chunks WIN!")
        print(f"   Average {avg_speedup_b:.2f}x faster across all durations")
        print("   Recommendation: Store raw chunks as WAV files")
        print("   Avoids Zarr time-slicing overhead - faster loads!")
    elif avg_speedup_b > 1.1:
        print("\n⚖️  WAV Chunks are slightly faster")
        print(f"   Average {avg_speedup_b:.2f}x faster")
        print("   Recommendation: Marginal benefit - consider storage simplicity")
    else:
        print("\n✨ Zarr Time-Slicing is Competitive!")
        print(f"   Only {1/avg_speedup_b:.2f}x slower than WAV chunks")
        print("   Recommendation: Zarr is fine - simpler single-file architecture")
        print("   Time-slicing overhead is negligible!")
    
    print("\n" + "="*70)


if __name__ == '__main__':
    run_benchmark()

