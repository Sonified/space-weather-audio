#!/usr/bin/env python3
"""
Zarr Compression Shootout
Compare different compression algorithms for seismic data storage
"""

import time
import xarray as xr
import zarr
from zarr.codecs import BloscCodec, ZstdCodec, GzipCodec
import numpy as np
import pandas as pd
from pathlib import Path
from obspy.clients.fdsn import Client
from obspy import UTCDateTime, Stream
import shutil

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

def get_dir_size(path):
    """Get total size of directory in bytes"""
    total = 0
    for entry in Path(path).rglob('*'):
        if entry.is_file():
            total += entry.stat().st_size
    return total

def test_compression(data_array, compressor_name, compressor, cache_dir):
    """Test a specific compression algorithm using zarr directly"""
    zarr_path = cache_dir / f"test_{compressor_name}.zarr"
    
    if zarr_path.exists():
        shutil.rmtree(zarr_path)
    
    # Test write speed - use zarr directly for v3 codec support
    write_start = time.time()
    
    if compressor is None:
        # No compression
        z = zarr.open_array(
            str(zarr_path),
            mode='w',
            shape=data_array.shape,
            chunks=(360000,),  # 1 hour chunks
            dtype=data_array.dtype
        )
    else:
        # With compression - Zarr v3 codecs
        from zarr.codecs import BytesCodec
        z = zarr.open_array(
            str(zarr_path),
            mode='w',
            shape=data_array.shape,
            chunks=(360000,),
            dtype=data_array.dtype,
            codecs=[BytesCodec(), compressor]  # Zarr v3 requires BytesCodec first
        )
    
    z[:] = data_array
    write_time = time.time() - write_start
    
    # Get compressed size
    compressed_size = get_dir_size(zarr_path)
    
    # Test read speed (3 runs, average)
    read_times = []
    for _ in range(3):
        read_start = time.time()
        z = zarr.open_array(str(zarr_path), mode='r')
        data = z[:]
        read_time = time.time() - read_start
        read_times.append(read_time)
    
    avg_read_time = np.mean(read_times)
    
    # Cleanup
    shutil.rmtree(zarr_path)
    
    return {
        'compressor': compressor_name,
        'write_time_ms': write_time * 1000,
        'read_time_ms': avg_read_time * 1000,
        'compressed_size_mb': compressed_size / (1024 * 1024),
    }

def run_compression_shootout():
    """Test multiple compression algorithms"""
    print("=" * 80)
    print("ZARR COMPRESSION SHOOTOUT")
    print("=" * 80)
    
    # Fetch test data
    print("\nFetching test data from IRIS...")
    client = Client("IRIS")
    end = UTCDateTime.now() - (5 * 60)  # Account for latency
    start = end - (6 * 3600)  # 6 hours
    
    print(f"  Time range: {start} to {end}")
    stream = client.get_waveforms('HV', 'HLPD', '', 'HHZ', start, end)
    
    # Get raw data array
    trace = stream[0]
    data_array = trace.data
    
    # Calculate uncompressed size (approximate)
    uncompressed_size = data_array.nbytes / (1024 * 1024)
    print(f"  Uncompressed data size: {uncompressed_size:.2f} MB")
    print(f"  Data points: {len(data_array):,}")
    
    # Setup cache directory
    cache_dir = Path(__file__).parent / 'compression_cache'
    cache_dir.mkdir(exist_ok=True)
    
    # Define compressors to test (Zarr v3 API)
    compressors = [
        ('No Compression', None),
        ('Blosc-zstd-1', BloscCodec(cname='zstd', clevel=1)),
        ('Blosc-zstd-3', BloscCodec(cname='zstd', clevel=3)),
        ('Blosc-zstd-5', BloscCodec(cname='zstd', clevel=5)),
        ('Blosc-zstd-9', BloscCodec(cname='zstd', clevel=9)),
        ('Blosc-lz4-5', BloscCodec(cname='lz4', clevel=5)),
        ('Blosc-lz4hc-5', BloscCodec(cname='lz4hc', clevel=5)),
        ('Blosc-zlib-5', BloscCodec(cname='zlib', clevel=5)),
        ('Zstd-1', ZstdCodec(level=1)),
        ('Zstd-3', ZstdCodec(level=3)),
        ('Zstd-5', ZstdCodec(level=5)),
        ('Zstd-9', ZstdCodec(level=9)),
        ('Zstd-22', ZstdCodec(level=22)),
        ('GZip-1', GzipCodec(level=1)),
        ('GZip-6', GzipCodec(level=6)),
        ('GZip-9', GzipCodec(level=9)),
    ]
    
    print(f"\nTesting {len(compressors)} compression algorithms...")
    print("=" * 80)
    
    results = []
    
    for i, (name, compressor) in enumerate(compressors, 1):
        print(f"\n[{i}/{len(compressors)}] Testing {name}...", end=' ', flush=True)
        
        try:
            result = test_compression(data_array, name, compressor, cache_dir)
            results.append(result)
            
            # Calculate compression ratio
            ratio = uncompressed_size / result['compressed_size_mb']
            result['compression_ratio'] = ratio
            result['space_saved_pct'] = ((uncompressed_size - result['compressed_size_mb']) / uncompressed_size) * 100
            
            print(f"✓ {result['compressed_size_mb']:.2f} MB ({ratio:.2f}x)")
        except Exception as e:
            print(f"✗ Failed: {e}")
    
    # Cleanup cache directory
    shutil.rmtree(cache_dir)
    
    # Sort results by compression ratio
    results.sort(key=lambda x: x['compression_ratio'], reverse=True)
    
    # Print results table
    print("\n" + "=" * 80)
    print("RESULTS (sorted by compression ratio)")
    print("=" * 80)
    print(f"{'Compressor':<20} {'Size (MB)':<12} {'Ratio':<10} {'Saved':<10} {'Write':<12} {'Read':<12}")
    print(f"{'':20} {'':12} {'':10} {'(%)':10} {'(ms)':12} {'(ms)':12}")
    print("-" * 80)
    
    for r in results:
        print(f"{r['compressor']:<20} "
              f"{r['compressed_size_mb']:<12.2f} "
              f"{r['compression_ratio']:<10.2f}x "
              f"{r['space_saved_pct']:<10.1f} "
              f"{r['write_time_ms']:<12.0f} "
              f"{r['read_time_ms']:<12.0f}")
    
    # Analysis
    print("\n" + "=" * 80)
    print("ANALYSIS")
    print("=" * 80)
    
    # Best compression
    best_compression = max(results, key=lambda x: x['compression_ratio'])
    print(f"\n🏆 BEST COMPRESSION: {best_compression['compressor']}")
    print(f"   Ratio: {best_compression['compression_ratio']:.2f}x")
    print(f"   Size: {best_compression['compressed_size_mb']:.2f} MB")
    print(f"   Space saved: {best_compression['space_saved_pct']:.1f}%")
    
    # Fastest read (excluding no compression)
    compressed_results = [r for r in results if r['compressor'] != 'No Compression']
    fastest_read = min(compressed_results, key=lambda x: x['read_time_ms'])
    print(f"\n⚡ FASTEST READ: {fastest_read['compressor']}")
    print(f"   Read time: {fastest_read['read_time_ms']:.0f} ms")
    print(f"   Compression: {fastest_read['compression_ratio']:.2f}x")
    
    # Fastest write
    fastest_write = min(compressed_results, key=lambda x: x['write_time_ms'])
    print(f"\n💾 FASTEST WRITE: {fastest_write['compressor']}")
    print(f"   Write time: {fastest_write['write_time_ms']:.0f} ms")
    print(f"   Compression: {fastest_write['compression_ratio']:.2f}x")
    
    # Best balanced (good compression + fast read)
    # Score = compression_ratio / (read_time normalized)
    min_read = min(r['read_time_ms'] for r in compressed_results)
    for r in compressed_results:
        r['balance_score'] = r['compression_ratio'] / (r['read_time_ms'] / min_read)
    
    best_balanced = max(compressed_results, key=lambda x: x['balance_score'])
    print(f"\n⚖️  BEST BALANCED: {best_balanced['compressor']}")
    print(f"   Compression: {best_balanced['compression_ratio']:.2f}x")
    print(f"   Read time: {best_balanced['read_time_ms']:.0f} ms")
    print(f"   Write time: {best_balanced['write_time_ms']:.0f} ms")
    
    # Recommendations
    print("\n" + "=" * 80)
    print("RECOMMENDATIONS")
    print("=" * 80)
    print(f"\n📦 For maximum compression (archival):")
    print(f"   Use: {best_compression['compressor']}")
    
    print(f"\n🚀 For maximum speed (real-time serving):")
    print(f"   Use: {fastest_read['compressor']}")
    
    print(f"\n✨ For production (balanced):")
    print(f"   Use: {best_balanced['compressor']}")
    print(f"   Good compression + fast reads + reasonable write speed")
    
    print("\n" + "=" * 80)

if __name__ == '__main__':
    try:
        run_compression_shootout()
    except KeyboardInterrupt:
        print("\n\n⚠️  Test interrupted by user")
    except Exception as e:
        print(f"\n\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()

