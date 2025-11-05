# -*- coding: utf-8 -*-
"""
Progressive chunk size test endpoint
Server fetches from IRIS, saves to R2 in all formats, streams back with progressive chunks
"""
from flask import Response, request, jsonify
from obspy.clients.fdsn import Client
from obspy import UTCDateTime
import numpy as np
import zarr
from numcodecs import Blosc, Zlib
import gzip
import json
import os
import boto3
import io
import tempfile
import shutil

# R2 Configuration
R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID', '66f906f29f28b08ae9c80d4f36e25c7a')
R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '9e1cf6c395172f108c2150c52878859f')
R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec')
R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')

s3_client = boto3.client(
    's3',
    endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    region_name='auto'
)

def generate_cache_key(volcano, hours_ago, duration_hours, network=None, station=None, location=None, channel=None):
    """Generate unique cache key including station info"""
    import hashlib
    station_str = f"{network}.{station}.{location}.{channel}" if network else "default"
    key_string = f"{volcano}_{station_str}_{hours_ago}h_ago_{duration_hours}h_duration"
    return hashlib.sha256(key_string.encode()).hexdigest()[:16]

def get_r2_key(cache_key, compression, storage, ext=''):
    """Generate R2 key: cache/{compression}/{storage}/{cache_key}{ext}"""
    # compression: int16, gzip, blosc
    # storage: raw, zarr
    return f"cache/{compression}/{storage}/{cache_key}{ext}"

def fetch_from_iris_and_save_all_formats(volcano, hours_ago=12, duration_hours=4, network=None, station=None, location=None, channel=None):
    """
    Fetch data from IRIS, process to int16, save all 6 format combinations to R2
    Returns: (cache_key, sample_rate, total_samples, was_cached)
    """
    cache_key = generate_cache_key(volcano, hours_ago, duration_hours, network, station, location, channel)
    
    # Check if data already exists in R2
    test_key = get_r2_key(cache_key, 'int16', 'raw', '.bin')
    try:
        s3_client.head_object(Bucket=R2_BUCKET_NAME, Key=test_key)
        print(f"✅ Data already cached in R2 for {cache_key}")
        # Get metadata
        response = s3_client.get_object(Bucket=R2_BUCKET_NAME, Key=f"cache/metadata/{cache_key}.json")
        metadata = json.loads(response['Body'].read())
        return cache_key, metadata['sample_rate'], metadata['total_samples'], True
    except:
        pass
    
    # Fetch from IRIS
    print(f"📡 Fetching {volcano} from IRIS...")
    
    # Load volcano config
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).parent))
    from main import VOLCANOES
    
    if volcano not in VOLCANOES:
        raise ValueError(f"Unknown volcano: {volcano}")
    
    config = VOLCANOES[volcano]
    
    # Use provided station params or fall back to config defaults
    network = network or config['network']
    station = station or config['station']
    location = location or config.get('location', '*')
    channel = channel or config['channel']
    
    print(f"   {network}.{station}.{location}.{channel}")
    
    client = Client("IRIS")
    end_time = UTCDateTime() - (hours_ago * 3600)
    start_time = end_time - (duration_hours * 3600)
    
    try:
        st = client.get_waveforms(
            network=network,
            station=station,
            location=location,
            channel=channel,
            starttime=start_time,
            endtime=end_time
        )
    except Exception as e:
        print(f"❌ Failed at {hours_ago}h ago, trying 24h ago...")
        end_time = UTCDateTime() - (24 * 3600)
        start_time = end_time - (duration_hours * 3600)
        st = client.get_waveforms(
            network=config['network'],
            station=config['station'],
            location=config.get('location', '*'),
            channel=config['channel'],
            starttime=start_time,
            endtime=end_time
        )
    
    st.merge(method=1, fill_value='interpolate')
    tr = st[0]
    
    # Process to int16
    data_array = tr.data
    data_normalized = data_array - np.mean(data_array)
    data_normalized = data_normalized / (np.max(np.abs(data_normalized)) + 1e-10)
    data_int16 = (data_normalized * 32767).astype(np.int16)
    
    sample_rate = tr.stats.sampling_rate
    total_samples = len(data_int16)
    
    print(f"📊 Processing {total_samples:,} samples @ {sample_rate} Hz")
    print(f"   Duration: {total_samples/sample_rate/3600:.2f} hours")
    
    # Save all 6 formats to R2
    print("💾 Saving to R2...")
    
    # 1. INT16/RAW - uncompressed int16 binary
    raw_bytes = data_int16.tobytes()
    key = get_r2_key(cache_key, 'int16', 'raw', '.bin')
    s3_client.put_object(Bucket=R2_BUCKET_NAME, Key=key, Body=raw_bytes)
    print(f"   ✓ int16/raw: {len(raw_bytes)/(1024*1024):.2f} MB")
    
    # 2. INT16/ZARR - zarr without compression
    with tempfile.TemporaryDirectory() as tmpdir:
        zarr_path = os.path.join(tmpdir, 'data.zarr')
        z = zarr.open(zarr_path, mode='w', shape=data_int16.shape,
                      chunks=(len(data_int16),), dtype='i2', compressor=None)
        z[:] = data_int16
        # Upload zarr directory to R2
        for root, dirs, files in os.walk(zarr_path):
            for file in files:
                local_path = os.path.join(root, file)
                relative_path = os.path.relpath(local_path, tmpdir)
                r2_key = get_r2_key(cache_key, 'int16', 'zarr', f'/{relative_path}')
                with open(local_path, 'rb') as f:
                    s3_client.put_object(Bucket=R2_BUCKET_NAME, Key=r2_key, Body=f.read())
        print(f"   ✓ int16/zarr")
    
    # 3. GZIP/RAW - gzipped int16 (level 1)
    gzip_bytes = gzip.compress(raw_bytes, compresslevel=1)
    key = get_r2_key(cache_key, 'gzip', 'raw', '.bin.gz')
    s3_client.put_object(Bucket=R2_BUCKET_NAME, Key=key, Body=gzip_bytes)
    print(f"   ✓ gzip/raw: {len(gzip_bytes)/(1024*1024):.2f} MB")
    
    # 4. GZIP/ZARR - zarr with gzip codec (level 1)
    with tempfile.TemporaryDirectory() as tmpdir:
        zarr_path = os.path.join(tmpdir, 'data.zarr')
        z = zarr.open(zarr_path, mode='w', shape=data_int16.shape,
                      chunks=(len(data_int16),), dtype='i2', compressor=Zlib(level=1))
        z[:] = data_int16
        for root, dirs, files in os.walk(zarr_path):
            for file in files:
                local_path = os.path.join(root, file)
                relative_path = os.path.relpath(local_path, tmpdir)
                r2_key = get_r2_key(cache_key, 'gzip', 'zarr', f'/{relative_path}')
                with open(local_path, 'rb') as f:
                    s3_client.put_object(Bucket=R2_BUCKET_NAME, Key=r2_key, Body=f.read())
        print(f"   ✓ gzip/zarr")
    
    # 5. BLOSC/RAW - blosc compressed int16 (level 5)
    codec = Blosc(cname='zstd', clevel=5, shuffle=Blosc.SHUFFLE)
    blosc_bytes = codec.encode(data_int16)
    key = get_r2_key(cache_key, 'blosc', 'raw', '.blosc')
    s3_client.put_object(Bucket=R2_BUCKET_NAME, Key=key, Body=blosc_bytes)
    print(f"   ✓ blosc/raw: {len(blosc_bytes)/(1024*1024):.2f} MB")
    
    # 6. BLOSC/ZARR - zarr with blosc codec (level 5)
    with tempfile.TemporaryDirectory() as tmpdir:
        zarr_path = os.path.join(tmpdir, 'data.zarr')
        z = zarr.open(zarr_path, mode='w', shape=data_int16.shape,
                      chunks=(len(data_int16),), dtype='i2',
                      compressor=Blosc(cname='zstd', clevel=5, shuffle=Blosc.SHUFFLE))
        z[:] = data_int16
        for root, dirs, files in os.walk(zarr_path):
            for file in files:
                local_path = os.path.join(root, file)
                relative_path = os.path.relpath(local_path, tmpdir)
                r2_key = get_r2_key(cache_key, 'blosc', 'zarr', f'/{relative_path}')
                with open(local_path, 'rb') as f:
                    s3_client.put_object(Bucket=R2_BUCKET_NAME, Key=r2_key, Body=f.read())
        print(f"   ✓ blosc/zarr")
    
    # Save metadata
    metadata = {
        'volcano': volcano,
        'sample_rate': float(sample_rate),
        'total_samples': int(total_samples),
        'duration_hours': duration_hours,
        'hours_ago': hours_ago
    }
    s3_client.put_object(
        Bucket=R2_BUCKET_NAME,
        Key=f"cache/metadata/{cache_key}.json",
        Body=json.dumps(metadata)
    )
    
    print(f"✅ All formats saved to R2")
    return cache_key, sample_rate, total_samples, False

def stream_from_r2_progressive(cache_key, storage, compression):
    """
    Stream data from R2 with progressive chunk sizes
    STREAMS DIRECTLY - does NOT download entire file first!
    """
    # Determine file extension and R2 key
    if storage == 'raw':
        if compression == 'int16':
            ext = '.bin'
        elif compression == 'gzip':
            ext = '.bin.gz'
        elif compression == 'blosc':
            ext = '.blosc'
        r2_key = get_r2_key(cache_key, compression, storage, ext)
    elif storage == 'zarr':
        # For zarr, stream the main data chunk
        r2_key = get_r2_key(cache_key, compression, storage, '/data.zarr/0')
    
    print(f"📥 STREAMING from R2: {r2_key}")
    
    # Get the R2 object - DON'T read() it yet!
    response = s3_client.get_object(Bucket=R2_BUCKET_NAME, Key=r2_key)
    total_size = response['ContentLength']
    print(f"📊 Total size: {total_size/(1024*1024):.2f} MB")
    
    # Progressive chunk sizes
    chunk_sizes_kb = [8, 16, 32, 64, 128, 256]
    remaining_chunk_kb = 512
    
    # Stream from R2's Body
    r2_stream = response['Body']
    chunk_index = 0
    
    # Send progressive chunks directly from R2 stream
    for chunk_kb in chunk_sizes_kb:
        chunk_size = chunk_kb * 1024
        chunk_data = r2_stream.read(chunk_size)
        if not chunk_data:
            break
        yield chunk_data
        chunk_index += 1
        print(f"   📤 Sent chunk {chunk_index}: {len(chunk_data)/1024:.1f} KB")
    
    # Yield remaining in 512KB chunks
    while True:
        chunk_size = remaining_chunk_kb * 1024
        chunk_data = r2_stream.read(chunk_size)
        if not chunk_data:
            break
        yield chunk_data
        chunk_index += 1
        print(f"   📤 Sent chunk {chunk_index}: {len(chunk_data)/1024:.1f} KB")

def create_progressive_test_endpoint(app):
    """Add the progressive test endpoint to Flask app"""
    
    @app.route('/api/progressive-test', methods=['GET'])
    def progressive_test():
        """
        Progressive chunk delivery test endpoint
        
        Query params:
        - storage: 'raw' or 'zarr' (default: 'raw')
        - compression: 'int16', 'blosc', 'gzip' (default: 'int16')
        - volcano: volcano name (default: 'kilauea')
        - hours_ago: how many hours ago to start (default: 12)
        - duration: duration in hours (default: 4)
        """
        storage = request.args.get('storage', 'raw')
        compression = request.args.get('compression', 'int16')
        if compression == 'none':
            compression = 'int16'  # Map 'none' to 'int16'
        volcano = request.args.get('volcano', 'kilauea')
        hours_ago = int(request.args.get('hours_ago', 12))
        duration = int(request.args.get('duration', 4))
        
        # Optional station selection
        network = request.args.get('network')
        station = request.args.get('station')
        location = request.args.get('location')
        channel = request.args.get('channel')
        
        import time as time_module
        request_start = time_module.time()
        
        print(f"\n{'='*70}")
        print(f"🧪 PROGRESSIVE TEST: {storage}/{compression}")
        print(f"   Volcano: {volcano}, {duration}h, {hours_ago}h ago")
        if network:
            print(f"   Station: {network}.{station}.{location}.{channel}")
        print(f"{'='*70}")
        
        try:
            # Fetch from IRIS and save all formats to R2
            cache_key, sample_rate, total_samples, was_cached = fetch_from_iris_and_save_all_formats(
                volcano, hours_ago, duration, network, station, location, channel
            )
            
            data_ready_time = time_module.time() - request_start
            cache_status = "CACHE HIT" if was_cached else "CACHE MISS (fetched from IRIS)"
            print(f"⏱️ Data ready in {data_ready_time*1000:.0f}ms ({cache_status})")
            
            # Get file size from R2
            if storage == 'raw':
                if compression == 'int16':
                    ext = '.bin'
                elif compression == 'gzip':
                    ext = '.bin.gz'
                elif compression == 'blosc':
                    ext = '.blosc'
                r2_key = get_r2_key(cache_key, compression, storage, ext)
            else:  # zarr
                r2_key = get_r2_key(cache_key, compression, storage, '/data.zarr/0')
            
            head_response = s3_client.head_object(Bucket=R2_BUCKET_NAME, Key=r2_key)
            file_size = head_response['ContentLength']
            
            # Create metadata
            metadata = {
                'storage': storage,
                'compression': compression,
                'file_size': file_size,
                'sample_rate': float(sample_rate),
                'samples': int(total_samples),
                'duration_seconds': float(total_samples / sample_rate)
            }
            
            print(f"📤 Streaming {file_size/(1024*1024):.2f} MB with progressive chunks...")
            
            # Stream with progressive chunks
            stream_start_time = time_module.time()
            return Response(
                stream_from_r2_progressive(cache_key, storage, compression),
                mimetype='application/octet-stream',
                headers={
                    'X-Metadata': json.dumps(metadata),
                    'X-Cache-Hit': 'true' if was_cached else 'false',
                    'X-Data-Ready-Ms': str(int(data_ready_time * 1000)),
                    'Content-Length': str(file_size),
                    'Cache-Control': 'no-cache',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Expose-Headers': 'X-Metadata, X-Cache-Hit, X-Data-Ready-Ms'
                }
            )
            
        except Exception as e:
            print(f"❌ Error: {e}")
            import traceback
            traceback.print_exc()
            return jsonify({'error': str(e)}), 500
    
    return app
