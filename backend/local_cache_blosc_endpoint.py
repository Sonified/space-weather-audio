"""
Local Cache Endpoint with Blosc Compression
Implements the architecture defined in docs/cache_architecture.md

Pipeline: Local Backend → Local Cache (blosc compressed) → IRIS
"""
from flask import Flask, jsonify, request, Response
from obspy import read, UTCDateTime, Stream
from obspy.clients.fdsn import Client
from numcodecs import Blosc
import numpy as np
import os
import json
from pathlib import Path
import time
from datetime import datetime, timezone

# Cache base directory
CACHE_DIR = Path(__file__).parent / 'cache' / 'blosc'
CACHE_DIR.mkdir(parents=True, exist_ok=True)

def register_local_cache_blosc_endpoint(app):
    """Register the local cache endpoint with Flask app"""
    
    @app.route('/api/local-cache-blosc-test', methods=['GET'])
    def local_cache_blosc_test():
        """
        Test endpoint for local file cache with blosc compression
        Query params: network, station, location, channel, starttime, endtime
        """
        try:
            # Parse request parameters
            network = request.args.get('network', 'HV')
            station = request.args.get('station', 'NPOC')
            location = request.args.get('location', '01')
            channel = request.args.get('channel', 'HHZ')
            volcano = request.args.get('volcano', 'kilauea')  # For organization
            
            # Parse time range
            start_time = UTCDateTime(request.args.get('starttime'))
            end_time = UTCDateTime(request.args.get('endtime'))
            
            print(f"\n{'='*70}")
            print(f"LOCAL CACHE REQUEST (Blosc)")
            print(f"{'='*70}")
            print(f"Station: {network}.{station}.{location}.{channel}")
            print(f"Volcano: {volcano}")
            print(f"Time: {start_time} to {end_time}")
            
            # Check cache first
            cache_data = check_cache(network, volcano, station, location, channel, start_time, end_time)
            
            if cache_data:
                print("✓ Cache HIT - returning cached data")
                return create_response(cache_data)
            
            # Cache MISS - fetch from IRIS
            print("✗ Cache MISS - fetching from IRIS")
            iris_data = fetch_from_iris(network, station, location, channel, start_time, end_time)
            
            # Process and cache
            processed_data = process_and_cache(
                iris_data, network, volcano, station, location, channel, start_time, end_time
            )
            
            return create_response(processed_data)
            
        except Exception as e:
            print(f"ERROR: {e}")
            import traceback
            traceback.print_exc()
            return jsonify({'error': str(e)}), 500
    
    def check_cache(network, volcano, station, location, channel, start_time, end_time):
        """Check if requested data exists in cache"""
        # For now, simple day-based cache lookup
        # TODO: Handle multi-day requests
        cache_file = get_cache_path(network, volcano, station, location, channel, start_time)
        metadata_file = cache_file.with_suffix('.json')
        
        if not cache_file.exists() or not metadata_file.exists():
            return None
        
        # Read metadata to verify coverage
        with open(metadata_file, 'r') as f:
            metadata = json.load(f)
        
        cached_start = UTCDateTime(metadata['start_time'])
        cached_end = UTCDateTime(metadata['end_time'])
        
        # Check if cache covers requested range
        if cached_start <= start_time and cached_end >= end_time:
            # Read and decompress cached data
            with open(cache_file, 'rb') as f:
                compressed = f.read()
            
            # Decompress
            codec = Blosc(cname='zstd', clevel=5, shuffle=Blosc.SHUFFLE)
            decompressed = codec.decode(compressed)
            data = np.frombuffer(decompressed, dtype=np.int32)
            
            # Extract requested range
            sample_rate = metadata['sample_rate']
            offset_samples = int((start_time - cached_start) * sample_rate)
            duration_samples = int((end_time - start_time) * sample_rate)
            
            data_slice = data[offset_samples:offset_samples + duration_samples]
            
            return {
                'data': data_slice,
                'metadata': metadata,
                'cache_hit': True
            }
        
        return None
    
    def fetch_from_iris(network, station, location, channel, start_time, end_time):
        """Fetch data from IRIS"""
        t0 = time.time()
        print(f"  → Fetching from IRIS...")
        
        client = Client("IRIS")
        st = client.get_waveforms(
            network=network,
            station=station,
            location=location,
            channel=channel,
            starttime=start_time,
            endtime=end_time
        )
        
        fetch_time = time.time() - t0
        print(f"  ✓ Fetched {len(st)} traces in {fetch_time:.2f}s")
        
        return st
    
    def process_and_cache(st, network, volcano, station, location, channel, start_time, end_time):
        """Process data (dedupe, interpolate gaps) and cache with blosc compression"""
        t0 = time.time()
        print(f"  → Processing data...")
        
        # Deduplicate (merge overlapping traces)
        st.merge(method=1, fill_value='interpolate', interpolation_samples=0)
        
        # After merge, should have single trace (or traces with gaps)
        if len(st) == 0:
            raise ValueError("No data after merge")
        
        # Get the trace
        tr = st[0]
        
        # Detect and document gaps
        gaps = []
        if len(st.get_gaps()) > 0:
            for gap in st.get_gaps():
                gap_info = {
                    'start_time': str(UTCDateTime(gap[4])),
                    'end_time': str(UTCDateTime(gap[5])),
                    'duration': gap[6]
                }
                gaps.append(gap_info)
                print(f"    Gap detected: {gap[6]:.2f}s at {gap[4]}")
        
        # Extract data
        data = tr.data.astype(np.int32)
        sample_rate = tr.stats.sampling_rate
        
        # Metadata
        metadata = {
            'network': network,
            'station': station,
            'location': location,
            'channel': channel,
            'volcano': volcano,
            'start_time': str(tr.stats.starttime),
            'end_time': str(tr.stats.endtime),
            'sample_rate': sample_rate,
            'samples': len(data),
            'gaps': gaps,
            'data_range': {
                'min': int(data.min()),
                'max': int(data.max())
            },
            'compression': {
                'algorithm': 'blosc',
                'codec': 'zstd',
                'level': 5,
                'shuffle': True
            },
            'cached_at': datetime.now(timezone.utc).isoformat(),
            'processing': {
                'deduplicated': True,
                'interpolated': False  # TODO: implement gap interpolation
            }
        }
        
        # Compress with blosc
        codec = Blosc(cname='zstd', clevel=5, shuffle=Blosc.SHUFFLE)
        t_compress = time.time()
        compressed = codec.encode(data)
        compress_time = time.time() - t_compress
        
        original_size = data.nbytes
        compressed_size = len(compressed)
        ratio = compressed_size / original_size
        
        print(f"  ✓ Compressed: {original_size/1024/1024:.2f} MB → {compressed_size/1024/1024:.2f} MB ({ratio*100:.1f}%) in {compress_time*1000:.1f}ms")
        
        # Save to cache
        cache_file = get_cache_path(network, volcano, station, location, channel, start_time)
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        
        with open(cache_file, 'wb') as f:
            f.write(compressed)
        
        metadata_file = cache_file.with_suffix('.json')
        with open(metadata_file, 'w') as f:
            json.dump(metadata, f, indent=2)
        
        process_time = time.time() - t0
        print(f"  ✓ Cached in {process_time:.2f}s")
        print(f"    File: {cache_file}")
        
        return {
            'data': data,
            'metadata': metadata,
            'cache_hit': False,
            'performance': {
                'compress_time_ms': compress_time * 1000,
                'compression_ratio': ratio
            }
        }
    
    def get_cache_path(network, volcano, station, location, channel, timestamp):
        """
        Generate cache file path following architecture:
        /data/{YEAR}/{MONTH}/{NETWORK}/{VOLCANO}/{STATION}/{LOCATION}/{CHANNEL}/YYYY-MM-DD.blosc
        """
        dt = timestamp.datetime
        year = dt.strftime('%Y')
        month = dt.strftime('%m')
        day = dt.strftime('%Y-%m-%d')
        
        path = CACHE_DIR / year / month / network / volcano / station / location / channel
        return path / f"{day}.blosc"
    
    def create_response(data_package):
        """Create streaming response with compressed data"""
        data = data_package['data']
        metadata = data_package['metadata']
        
        # Compress for transmission
        codec = Blosc(cname='zstd', clevel=5, shuffle=Blosc.SHUFFLE)
        compressed = codec.encode(data)
        
        # Return metadata + compressed data
        response_data = {
            'metadata': metadata,
            'compression': {
                'algorithm': 'blosc',
                'codec': 'zstd',
                'level': 5,
                'original_size': data.nbytes,
                'compressed_size': len(compressed)
            },
            'data': compressed.hex(),  # Hex encode for JSON transport
            'cache_hit': data_package.get('cache_hit', False)
        }
        
        return jsonify(response_data)
    
    return app

# Standalone test
if __name__ == '__main__':
    from flask import Flask
    app = Flask(__name__)
    app = register_local_cache_blosc_endpoint(app)
    
    # Test request
    test_url = '/api/local-cache-blosc-test?network=HV&station=NPOC&location=01&channel=HHZ&volcano=kilauea&starttime=2024-09-28T00:00:00&endtime=2024-09-28T00:10:00'
    
    with app.test_client() as client:
        print("Testing local cache endpoint...")
        response = client.get(test_url)
        print(f"Status: {response.status_code}")
        if response.status_code == 200:
            data = response.get_json()
            print(f"Cache hit: {data.get('cache_hit')}")
            print(f"Samples: {data['metadata']['samples']}")


