#!/usr/bin/env python3
"""
Compression comparison test server - REAL seismic data
Serves the same data compressed with gzip and zstd
Runs on port 8003
"""
from flask import Flask, Response, jsonify
from flask_cors import CORS
from obspy.clients.fdsn import Client
from obspy import UTCDateTime
import numpy as np
import gzip
import os
import sys
from numcodecs import Zstd

app = Flask(__name__)
CORS(app)

# Cache directory for test files
CACHE_DIR = os.path.join(os.path.dirname(__file__), 'test_compression_cache')
os.makedirs(CACHE_DIR, exist_ok=True)

def fetch_and_cache_real_data(hours, label):
    """Fetch real seismic data from IRIS and cache it"""
    cache_file = os.path.join(CACHE_DIR, f'{label}_raw.bin')
    
    if os.path.exists(cache_file):
        print(f"  Loading cached {label} data...")
        with open(cache_file, 'rb') as f:
            return np.frombuffer(f.read(), dtype=np.int32)
    
    print(f"  Fetching {hours}h of real seismic data from IRIS...")
    client = Client("IRIS")
    end_time = UTCDateTime() - (12 * 3600)  # 12 hours ago like main.py default
    start_time = end_time - (hours * 3600)
    
    # Try with location wildcard like main.py does
    try:
        stream = client.get_waveforms(
            network='HV',
            station='UWE',
            location='*',
            channel='HHZ',
            starttime=start_time,
            endtime=end_time
        )
    except Exception as e:
        print(f"  Error fetching data: {e}")
        # Fallback to 24 hours ago like main.py
        try:
            end_time = UTCDateTime() - (24 * 3600)
            start_time = end_time - (hours * 3600)
            stream = client.get_waveforms(
                network='HV',
                station='UWE',
                location='*',
                channel='HHZ',
                starttime=start_time,
                endtime=end_time
            )
        except Exception as e2:
            print(f"  Error fetching data (fallback): {e2}")
            return None
    
    stream.merge(method=1, fill_value='interpolate')
    tr = stream[0]
    
    # Convert to int32 (native resolution)
    data_int32 = tr.data.astype(np.int32)
    
    # Cache it
    with open(cache_file, 'wb') as f:
        f.write(data_int32.tobytes())
    
    print(f"    Fetched {len(data_int32)} samples ({data_int32.nbytes / 1024 / 1024:.2f} MB)")
    
    return data_int32

def compress_and_cache(data_int32, label, method, level):
    """Compress data and cache to disk"""
    raw_bytes = data_int32.tobytes()
    
    if method == 'gzip':
        cache_file = os.path.join(CACHE_DIR, f'{label}_gzip{level}.bin.gz')
        if not os.path.exists(cache_file):
            print(f"  Compressing {label} with gzip level {level}...")
            compressed = gzip.compress(raw_bytes, compresslevel=level)
            with open(cache_file, 'wb') as f:
                f.write(compressed)
            print(f"    {len(raw_bytes) / 1024 / 1024:.2f} MB → {len(compressed) / 1024 / 1024:.2f} MB ({len(compressed)/len(raw_bytes)*100:.1f}%)")
        else:
            with open(cache_file, 'rb') as f:
                compressed = f.read()
    
    elif method == 'zstd':
        cache_file = os.path.join(CACHE_DIR, f'{label}_zstd{level}.bin.zst')
        if not os.path.exists(cache_file):
            print(f"  Compressing {label} with zstd level {level}...")
            codec = Zstd(level=level)
            compressed = codec.encode(raw_bytes)
            with open(cache_file, 'wb') as f:
                f.write(compressed)
            print(f"    {len(raw_bytes) / 1024 / 1024:.2f} MB → {len(compressed) / 1024 / 1024:.2f} MB ({len(compressed)/len(raw_bytes)*100:.1f}%)")
        else:
            with open(cache_file, 'rb') as f:
                compressed = f.read()
    
    return compressed, len(raw_bytes)

# Initialize data on startup
print("="*70)
print("COMPRESSION COMPARISON TEST SERVER (REAL DATA)")
print("="*70)
print("Initializing test data...")

DATA_CONFIGS = {
    'small': {'hours': 0.25, 'label': 'small', 'target_mb': '~1MB'},     # ~15 min
    'medium': {'hours': 1.5, 'label': 'medium', 'target_mb': '~5MB'},    # 1.5 hours
    'large': {'hours': 4, 'label': 'large', 'target_mb': '~14MB'}        # 4 hours
}

DATA_CACHE = {}

for key, config in DATA_CONFIGS.items():
    print(f"\nPreparing {key} dataset ({config['target_mb']})...")
    data = fetch_and_cache_real_data(config['hours'], config['label'])
    if data is not None:
        DATA_CACHE[key] = data
        # Pre-compress with gzip-1 and zstd-3
        compress_and_cache(data, config['label'], 'gzip', 1)
        compress_and_cache(data, config['label'], 'zstd', 3)

print("\n" + "="*70)

@app.route('/api/sizes', methods=['GET'])
def get_sizes():
    """Return available dataset sizes"""
    sizes = {}
    for key, data in DATA_CACHE.items():
        config = DATA_CONFIGS[key]
        raw_bytes = data.nbytes
        
        # Get compressed sizes
        gzip_file = os.path.join(CACHE_DIR, f'{config["label"]}_gzip1.bin.gz')
        zstd_file = os.path.join(CACHE_DIR, f'{config["label"]}_zstd3.bin.zst')
        
        gzip_size = os.path.getsize(gzip_file) if os.path.exists(gzip_file) else 0
        zstd_size = os.path.getsize(zstd_file) if os.path.exists(zstd_file) else 0
        
        sizes[key] = {
            'label': config['label'],
            'target': config['target_mb'],
            'samples': len(data),
            'raw_bytes': raw_bytes,
            'raw_mb': raw_bytes / 1024 / 1024,
            'gzip_bytes': gzip_size,
            'gzip_mb': gzip_size / 1024 / 1024,
            'gzip_ratio': (gzip_size / raw_bytes * 100) if raw_bytes > 0 else 0,
            'zstd_bytes': zstd_size,
            'zstd_mb': zstd_size / 1024 / 1024,
            'zstd_ratio': (zstd_size / raw_bytes * 100) if raw_bytes > 0 else 0
        }
    
    return jsonify(sizes)

@app.route('/api/data/<size>/<method>', methods=['GET'])
def get_compressed_data(size, method):
    """Serve compressed data"""
    if size not in DATA_CACHE:
        return jsonify({'error': f'Unknown size: {size}'}), 404
    
    if method not in ['gzip', 'zstd']:
        return jsonify({'error': f'Unknown method: {method}'}), 400
    
    data = DATA_CACHE[size]
    config = DATA_CONFIGS[size]
    
    # Get compression level from query or use defaults
    if method == 'gzip':
        level = int(request.args.get('level', 1))
        compressed, raw_size = compress_and_cache(data, config['label'], 'gzip', level)
        content_type = 'application/gzip'
        compression_name = f'gzip-{level}'
    else:  # zstd
        level = int(request.args.get('level', 3))
        compressed, raw_size = compress_and_cache(data, config['label'], 'zstd', level)
        content_type = 'application/zstd'
        compression_name = f'zstd-{level}'
    
    print(f"\nServing {size} data ({method}):")
    print(f"  Original: {raw_size / 1024 / 1024:.2f} MB")
    print(f"  Compressed: {len(compressed) / 1024 / 1024:.2f} MB")
    print(f"  Ratio: {len(compressed) / raw_size * 100:.1f}%")
    
    return Response(
        compressed,
        mimetype=content_type,
        headers={
            'Access-Control-Allow-Origin': '*',
            'Content-Length': str(len(compressed)),
            'X-Compression': compression_name,
            'X-Original-Size': str(raw_size),
            'X-Compressed-Size': str(len(compressed)),
            'X-Compression-Ratio': f'{len(compressed) / raw_size * 100:.1f}%'
        }
    )

if __name__ == '__main__':
    from flask import request
    print("\nRunning on http://localhost:8003")
    print("Endpoints:")
    print("  /api/sizes - List available datasets")
    print("  /api/data/<size>/<method> - Get compressed data")
    print("    size: small, medium, large")
    print("    method: gzip, zstd")
    print("="*70)
    app.run(host='0.0.0.0', port=8003, debug=False, use_reloader=False)

