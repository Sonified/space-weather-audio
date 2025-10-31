# -*- coding: utf-8 -*-
from flask import Flask, request, jsonify, send_file, Response, stream_with_context
from obspy.clients.fdsn import Client
from obspy import UTCDateTime
import numpy as np
from scipy.io import wavfile
import xarray as xr
import io
import os
import tempfile
import shutil
import json
import zarr
from numcodecs import Blosc, Zstd, Zlib
from pathlib import Path
import time
import gzip
import boto3

app = Flask(__name__)

# Register audio streaming blueprint (separate from chunk pipeline)
from audio_stream import audio_stream_bp
app.register_blueprint(audio_stream_bp)

# ✅ RELIABLE CORS SETUP - After-request hook catches EVERYTHING
@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    response.headers['Access-Control-Expose-Headers'] = 'X-Metadata,X-Cache-Hit,X-Data-Ready-Ms,X-Original-Size,X-Compressed-Size,X-Compression,X-Sample-Rate,X-Sample-Count,X-Format,X-Highpass,X-Normalized'
    return response

# Configuration
MAX_RADIUS_KM = 13.0 * 1.60934  # 13 miles converted to km
REQUIRED_COMPONENT = 'Z'  # Z-component only (vertical)

# Cloudflare R2 configuration (S3-compatible)
R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID', '66f906f29f28b08ae9c80d4f36e25c7a')
R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '9e1cf6c395172f108c2150c52878859f')
R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec')
R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')
R2_PUBLIC_URL = os.getenv('R2_PUBLIC_URL', f'https://pub-{R2_ACCOUNT_ID}.r2.dev')

s3_client = boto3.client(
    's3',
    endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    region_name='auto'
)

PROGRESSIVE_CHUNK_SIZES_KB = [8, 16, 32, 64, 128, 256]
REMAINING_CHUNK_KB = 512

def generate_cache_key(volcano: str, hours_ago: int, duration_hours: int) -> str:
    import hashlib
    key_string = f"{volcano}_{hours_ago}h_ago_{duration_hours}h_duration"
    return hashlib.sha256(key_string.encode()).hexdigest()[:16]

def r2_key(cache_key: str, compression: str, storage: str, ext: str = '') -> str:
    return f"cache/{compression}/{storage}/{cache_key}{ext}"

def list_zarr_chunk_keys(prefix: str) -> list:
    keys = []
    continuation = None
    while True:
        kwargs = {
            'Bucket': R2_BUCKET_NAME,
            'Prefix': prefix,
            'MaxKeys': 1000
        }
        if continuation:
            kwargs['ContinuationToken'] = continuation
        resp = s3_client.list_objects_v2(**kwargs)
        for obj in resp.get('Contents', []):
            key = obj['Key']
            base = key.split('/')[-1]
            if base in ['.zarray', '.zattrs', '.zgroup']:
                continue
            keys.append(key)
        if resp.get('IsTruncated'):
            continuation = resp.get('NextContinuationToken')
        else:
            break
    def sort_key(k: str):
        tail = k.split('/')[-1]
        try:
            return int(tail)
        except Exception:
            return tail
    keys.sort(key=sort_key)
    return keys

def ensure_cached_in_r2(volcano: str, hours_ago: int, duration_hours: int, network=None, station=None, location=None, channel=None):
    """Ensure all variants are cached in R2. Returns (cache_key, profiles, metadata)."""
    cache_key = generate_cache_key(volcano, hours_ago, duration_hours)
    # Quick existence check
    try:
        s3_client.head_object(Bucket=R2_BUCKET_NAME, Key=r2_key(cache_key, 'int16', 'raw', '.bin'))
        try:
            prof = s3_client.get_object(Bucket=R2_BUCKET_NAME, Key=f"cache/metadata/{cache_key}_profiles.json")
            profiles = json.loads(prof['Body'].read())
        except Exception:
            profiles = {}
        try:
            meta = s3_client.get_object(Bucket=R2_BUCKET_NAME, Key=f"cache/metadata/{cache_key}.json")
            metadata = json.loads(meta['Body'].read())
        except Exception:
            metadata = {}
        return cache_key, profiles, metadata
    except Exception:
        pass

    config = VOLCANOES[volcano.lower()]
    # Use provided station params or fall back to config defaults
    network = network or config['network']
    station = station or config['station']
    location = location or config.get('location', '*')
    channel = channel or config['channel']
    
    client = Client("IRIS")
    end_time = UTCDateTime() - (hours_ago * 3600)
    start_time = end_time - (duration_hours * 3600)

    iris_t0 = time.time()
    try:
        stream = client.get_waveforms(
            network=network,
            station=station,
            location=location,
            channel=channel,
            starttime=start_time,
            endtime=end_time
        )
    except Exception:
        end_time = UTCDateTime() - (24 * 3600)
        start_time = end_time - (duration_hours * 3600)
        stream = client.get_waveforms(
            network=config['network'],
            station=config['station'],
            location=config.get('location', '*'),
            channel=config['channel'],
            starttime=start_time,
            endtime=end_time
        )
    iris_fetch_ms = (time.time() - iris_t0) * 1000.0

    stream.merge(method=1, fill_value='interpolate')
    tr = stream[0]

    # Save mseed to R2 (best effort)
    try:
        import io as _io
        mseed_buf = _io.BytesIO()
        stream.write(mseed_buf, format='MSEED')
        mseed_buf.seek(0)
        s3_client.put_object(Bucket=R2_BUCKET_NAME, Key=f"cache/mseed/{cache_key}.mseed", Body=mseed_buf.read())
    except Exception:
        pass

    prep_t0 = time.time()
    data = tr.data.astype(np.float64)
    data = data - np.mean(data)
    max_abs = np.max(np.abs(data))
    if max_abs > 0:
        data = data / max_abs
    data_int16 = (data * 32767.0).astype(np.int16)
    sample_rate = float(tr.stats.sampling_rate)
    total_samples = int(data_int16.size)
    preprocess_ms = (time.time() - prep_t0) * 1000.0

    profiles = {
        'iris_fetch_ms': iris_fetch_ms,
        'preprocess_ms': preprocess_ms,
        'variants': {}
    }

    # 1) int16/raw
    raw_bytes = data_int16.tobytes()
    s3_client.put_object(Bucket=R2_BUCKET_NAME, Key=r2_key(cache_key, 'int16', 'raw', '.bin'), Body=raw_bytes)
    profiles['variants']['int16/raw'] = {
        'compress_ms': 0.0,
        'original_size_bytes': len(raw_bytes),
        'compressed_size_bytes': len(raw_bytes)
    }

    def build_and_upload_zarr(arr, compressor, comp_label):
        t0 = time.time()
        with tempfile.TemporaryDirectory() as tmpdir:
            zarr_path = os.path.join(tmpdir, 'data.zarr')
            chunk_len = min(524288, arr.size)  # ~1MB per chunk
            z = zarr.open(zarr_path, mode='w', shape=arr.shape, chunks=(chunk_len,), dtype='i2', compressor=compressor)
            z[:] = arr
            total = 0
            for root, _, files in os.walk(zarr_path):
                for fn in files:
                    lp = os.path.join(root, fn)
                    rel = os.path.relpath(lp, tmpdir)
                    key = r2_key(cache_key, comp_label, 'zarr', f'/{rel}')
                    with open(lp, 'rb') as fh:
                        b = fh.read()
                        total += len(b)
                        s3_client.put_object(Bucket=R2_BUCKET_NAME, Key=key, Body=b)
        return (time.time() - t0) * 1000.0, total

    # 2) int16/zarr
    ms, size_b = build_and_upload_zarr(data_int16, None, 'int16')
    profiles['variants']['int16/zarr'] = {
        'compress_ms': ms,
        'original_size_bytes': len(raw_bytes),
        'compressed_size_bytes': size_b
    }

    # 3) gzip/raw (level 1)
    t0 = time.time()
    gzip_bytes = gzip.compress(raw_bytes, compresslevel=1)
    s3_client.put_object(Bucket=R2_BUCKET_NAME, Key=r2_key(cache_key, 'gzip', 'raw', '.bin.gz'), Body=gzip_bytes)
    profiles['variants']['gzip/raw'] = {
        'compress_ms': (time.time() - t0) * 1000.0,
        'original_size_bytes': len(raw_bytes),
        'compressed_size_bytes': len(gzip_bytes)
    }

    # 4) gzip/zarr (level 1)
    ms, size_b = build_and_upload_zarr(data_int16, Zlib(level=1), 'gzip')
    profiles['variants']['gzip/zarr'] = {
        'compress_ms': ms,
        'original_size_bytes': len(raw_bytes),
        'compressed_size_bytes': size_b
    }

    # 5) blosc/raw (zstd level 5)
    t0 = time.time()
    blosc_codec = Blosc(cname='zstd', clevel=5, shuffle=Blosc.SHUFFLE)
    blosc_bytes = blosc_codec.encode(data_int16)
    s3_client.put_object(Bucket=R2_BUCKET_NAME, Key=r2_key(cache_key, 'blosc', 'raw', '.blosc'), Body=blosc_bytes)
    profiles['variants']['blosc/raw'] = {
        'compress_ms': (time.time() - t0) * 1000.0,
        'original_size_bytes': len(raw_bytes),
        'compressed_size_bytes': len(blosc_bytes)
    }

    # 6) blosc/zarr
    ms, size_b = build_and_upload_zarr(data_int16, blosc_codec, 'blosc')
    profiles['variants']['blosc/zarr'] = {
        'compress_ms': ms,
        'original_size_bytes': len(raw_bytes),
        'compressed_size_bytes': size_b
    }

    metadata = {
        'volcano': volcano,
        'sample_rate': sample_rate,
        'total_samples': total_samples,
        'duration_hours': duration_hours,
        'hours_ago': hours_ago
    }
    s3_client.put_object(Bucket=R2_BUCKET_NAME, Key=f"cache/metadata/{cache_key}.json", Body=json.dumps(metadata))
    s3_client.put_object(Bucket=R2_BUCKET_NAME, Key=f"cache/metadata/{cache_key}_profiles.json", Body=json.dumps(profiles))

    return cache_key, profiles, metadata

def stream_variant_from_r2(cache_key: str, storage: str, compression: str):
    # Raw variants stream as a single object progressively
    if storage == 'raw':
        if compression == 'int16':
            ext = '.bin'
        elif compression == 'gzip':
            ext = '.bin.gz'
        elif compression == 'blosc':
            ext = '.blosc'
        else:
            raise ValueError('Unsupported compression')
        key = r2_key(cache_key, compression, storage, ext)
        obj = s3_client.get_object(Bucket=R2_BUCKET_NAME, Key=key)
        data = obj['Body'].read()
        total = len(data)
        offset = 0
        for kb in PROGRESSIVE_CHUNK_SIZES_KB:
            if offset >= total:
                break
            sz = kb * 1024
            yield data[offset:offset + sz]
            offset += sz
        rem = REMAINING_CHUNK_KB * 1024
        while offset < total:
            yield data[offset:offset + rem]
            offset += rem
    elif storage == 'zarr':
        prefix = r2_key(cache_key, compression, storage, '/data.zarr/')
        keys = list_zarr_chunk_keys(prefix)
        for key in keys:
            obj = s3_client.get_object(Bucket=R2_BUCKET_NAME, Key=key)
            data = obj['Body'].read()
            total = len(data)
            offset = 0
            for kb in PROGRESSIVE_CHUNK_SIZES_KB:
                if offset >= total:
                    break
                sz = kb * 1024
                yield data[offset:offset + sz]
                offset += sz
            rem = REMAINING_CHUNK_KB * 1024
            while offset < total:
                yield data[offset:offset + rem]
                offset += rem
    else:
        raise ValueError('Unsupported storage')

def load_volcano_stations():
    """
    Load and filter stations from volcano_station_availability.json
    Returns dict of volcano configs with best available Z-component station
    """
    repo_root = Path(__file__).resolve().parent.parent
    availability_path = repo_root / 'data' / 'reference' / 'volcano_station_availability.json'
    
    if not availability_path.exists():
        print(f"⚠️  Warning: {availability_path} not found, using fallback configs")
        return {
            'kilauea': {'network': 'HV', 'station': 'HLPD', 'channel': 'HHZ'},
            'spurr': {'network': 'AV', 'station': 'SPCN', 'channel': 'BHZ'},
            'shishaldin': {'network': 'AV', 'station': 'SSLS', 'channel': 'HHZ'}
        }
    
    with open(availability_path, 'r') as f:
        data = json.load(f)
    
    # Map volcano names to URL-friendly keys
    volcano_mapping = {
        'Kilauea': 'kilauea',
        'Mauna Loa': 'maunaloa',
        'Great Sitkin': 'greatsitkin',
        'Shishaldin': 'shishaldin',
        'Spurr': 'spurr'
    }
    
    configs = {}
    
    for entry in data:
        volcano_name = entry.get('name')
        if volcano_name not in volcano_mapping:
            continue
        
        url_key = volcano_mapping[volcano_name]
        seismic_channels = entry.get('seismic_channels', [])
        
        # Filter to Z-component only, active, within radius
        z_channels = [
            ch for ch in seismic_channels
            if ch.get('channel', '').endswith('Z') and  # Z-component
               not ch.get('end_time') and  # Active (no end time)
               ch.get('distance_km', 999) <= MAX_RADIUS_KM  # Within 13 miles
        ]
        
        if not z_channels:
            print(f"⚠️  No Z-component stations within {MAX_RADIUS_KM:.1f}km for {volcano_name}")
            continue
        
        # Sort by distance (closest first), then by sample rate (highest first)
        z_channels.sort(key=lambda ch: (ch.get('distance_km', 999), -ch.get('sample_rate', 0)))
        
        best_channel = z_channels[0]
        configs[url_key] = {
            'network': best_channel['network'],
            'station': best_channel['station'],
            'channel': best_channel['channel'],
            'location': best_channel.get('location', ''),
            'distance_km': best_channel.get('distance_km'),
            'sample_rate': best_channel.get('sample_rate'),
            'volcano_name': volcano_name
        }
        
        print(f"✅ {volcano_name}: {best_channel['network']}.{best_channel['station']}.{best_channel['channel']} "
              f"({best_channel.get('distance_km', 0):.1f}km, {best_channel.get('sample_rate', 0)}Hz)")
    
    return configs

# Load volcano configurations at startup
VOLCANOES = load_volcano_stations()
print(f"\n🌋 Loaded {len(VOLCANOES)} volcano configurations")

LOCATION_FALLBACKS = ["", "01", "00", "10", "--"]

@app.route('/')
def home():
    return "Volcano Audio API - Ready"

@app.route('/api/stations/<volcano>')
def get_stations(volcano):
    """
    Returns all available stations for a volcano within MAX_RADIUS_KM
    Grouped by type (seismic/infrasound) and sorted by distance
    """
    try:
        if volcano.lower() not in VOLCANOES:
            return jsonify({'error': f'Unknown volcano: {volcano}'}), 404
        
        config = VOLCANOES[volcano.lower()]
        volcano_name = config.get('volcano_name', volcano)
        
        # Load full availability data
        repo_root = Path(__file__).resolve().parent.parent
        availability_path = repo_root / 'data' / 'reference' / 'volcano_station_availability.json'
        
        if not availability_path.exists():
            return jsonify({'error': 'Station availability data not found'}), 500
        
        with open(availability_path, 'r') as f:
            data = json.load(f)
        
        # Find this volcano's data
        volcano_data = None
        for entry in data:
            if entry.get('name') == volcano_name:
                volcano_data = entry
                break
        
        if not volcano_data:
            return jsonify({'error': f'No station data for {volcano_name}'}), 404
        
        result = {
            'volcano': volcano_name,
            'lat': volcano_data.get('lat'),
            'lon': volcano_data.get('lon'),
            'seismic': [],
            'infrasound': []
        }
        
        # Filter seismic channels (Z-component only, active, within radius)
        for ch in volcano_data.get('seismic_channels', []):
            if (ch.get('channel', '').endswith('Z') and  # Z-component only
                not ch.get('end_time') and  # Active
                ch.get('distance_km', 999) <= MAX_RADIUS_KM):
                result['seismic'].append({
                    'network': ch['network'],
                    'station': ch['station'],
                    'location': ch.get('location', ''),
                    'channel': ch['channel'],
                    'distance_km': ch.get('distance_km'),
                    'sample_rate': ch.get('sample_rate'),
                    'label': f"{ch['network']}.{ch['station']}.{ch.get('location') or '--'}.{ch['channel']} ({ch.get('distance_km', 0):.1f}km, {int(ch.get('sample_rate', 0))} Hz)"
                })
        
        # Filter infrasound channels (active, within radius)
        for ch in volcano_data.get('infrasound_channels', []):
            if (not ch.get('end_time') and  # Active
                ch.get('distance_km', 999) <= MAX_RADIUS_KM):
                result['infrasound'].append({
                    'network': ch['network'],
                    'station': ch['station'],
                    'location': ch.get('location', ''),
                    'channel': ch['channel'],
                    'distance_km': ch.get('distance_km'),
                    'sample_rate': ch.get('sample_rate'),
                    'label': f"{ch['network']}.{ch['station']}.{ch.get('location') or '--'}.{ch['channel']} ({ch.get('distance_km', 0):.1f}km, {int(ch.get('sample_rate', 0))} Hz)"
                })
        
        # Sort by distance (closest first)
        result['seismic'].sort(key=lambda x: x['distance_km'])
        result['infrasound'].sort(key=lambda x: x['distance_km'])
        
        return jsonify(result)
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/test/<volcano>')
def test_data(volcano):
    """Test endpoint to check if data is available without generating audio"""
    try:
        if volcano.lower() not in VOLCANOES:
            return jsonify({'error': f'Unknown volcano: {volcano}'}), 404
            
        config = VOLCANOES[volcano.lower()]
        end = UTCDateTime.now()
        start = end - 3600  # Just check last hour
        
        client = Client("IRIS")
        
        # Try preferred location first, then fallbacks
        locations_to_try = [config.get('location', '')] + LOCATION_FALLBACKS
        for loc in locations_to_try:
            try:
                stream = client.get_waveforms(
                    network=config['network'],
                    station=config['station'],
                    location=loc,
                    channel=config['channel'],
                    starttime=start,
                    endtime=end
                )
                if stream and len(stream) > 0:
                    return jsonify({
                        'available': True,
                        'network': config['network'],
                        'station': config['station'],
                        'location': loc,
                        'channel': config['channel'],
                        'sample_rate': stream[0].stats.sampling_rate,
                        'points': stream[0].stats.npts,
                        'volcano_name': config.get('volcano_name', volcano),
                        'distance_km': config.get('distance_km')
                    })
            except Exception:
                continue
        
        return jsonify({'available': False, 'error': 'No data found for any location code'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/audio/<volcano>/<int:hours>')
def get_audio(volcano, hours):
    try:
        if volcano.lower() not in VOLCANOES:
            return jsonify({'error': f'Unknown volcano: {volcano}'}), 404
            
        config = VOLCANOES[volcano.lower()]
        end = UTCDateTime.now()
        start = end - (hours * 3600)
        
        client = Client("IRIS")
        
        # Try preferred location first, then fallbacks
        stream = None
        successful_location = None
        locations_to_try = [config.get('location', '')] + LOCATION_FALLBACKS
        for loc in locations_to_try:
            try:
                stream = client.get_waveforms(
                    network=config['network'],
                    station=config['station'],
                    location=loc,
                    channel=config['channel'],
                    starttime=start,
                    endtime=end
                )
                if stream and len(stream) > 0:
                    successful_location = loc
                    break
            except Exception as e:
                continue
        
        if not stream or len(stream) == 0:
            return jsonify({'error': 'No data available for the specified time range'}), 404
        
        stream.merge(fill_value=0)
        trace = stream[0]
        
        speedup = 200
        original_rate = trace.stats.sampling_rate
        audio_rate = int(original_rate * speedup)
        
        # Avoid division by zero
        max_val = np.max(np.abs(trace.data))
        if max_val == 0:
            return jsonify({'error': 'Data contains only zeros'}), 500
            
        audio = np.int16(trace.data / max_val * 32767)
        
        filename = f"{volcano}_{hours}h.wav"
        filepath = f"/tmp/{filename}"
        wavfile.write(filepath, audio_rate, audio)
        
        return send_file(filepath, mimetype='audio/wav', as_attachment=True, download_name=filename)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/zarr/<volcano>/<int:hours>')
def get_zarr(volcano, hours):
    """
    Returns raw seismic data as Zarr with configurable gzip compression.
    Query params:
    - gzip_level: 1-9 (default: 6)
    - format: 'gzip' or 'blosc' (default: 'gzip')
    - blosc_level: 1-9 (default: 5, only used if format=blosc)
    """
    try:
        if volcano.lower() not in VOLCANOES:
            return jsonify({'error': f'Unknown volcano: {volcano}'}), 404
        
        # Get compression parameters from query params
        compression_format = request.args.get('format', 'gzip', type=str).lower()
        gzip_level = request.args.get('gzip_level', 6, type=int)
        blosc_level = request.args.get('blosc_level', 5, type=int)
        zstd_level = request.args.get('zstd_level', 3, type=int)
        
        if compression_format not in ['gzip', 'blosc', 'zstd']:
            return jsonify({'error': 'format must be "gzip", "blosc", or "zstd"'}), 400
        if not 1 <= gzip_level <= 9:
            return jsonify({'error': 'gzip_level must be between 1 and 9'}), 400
        if not 1 <= blosc_level <= 9:
            return jsonify({'error': 'blosc_level must be between 1 and 9'}), 400
        if not 1 <= zstd_level <= 22:
            return jsonify({'error': 'zstd_level must be between 1 and 22'}), 400
            
        config = VOLCANOES[volcano.lower()]
        end = UTCDateTime.now()
        start = end - (hours * 3600)
        
        client = Client("IRIS")
        
        # Try preferred location first, then fallbacks
        stream = None
        successful_location = None
        locations_to_try = [config.get('location', '')] + LOCATION_FALLBACKS
        for loc in locations_to_try:
            try:
                stream = client.get_waveforms(
                    network=config['network'],
                    station=config['station'],
                    location=loc,
                    channel=config['channel'],
                    starttime=start,
                    endtime=end
                )
                if stream and len(stream) > 0:
                    successful_location = loc
                    break
            except Exception as e:
                continue
        
        if not stream or len(stream) == 0:
            return jsonify({'error': 'No data available for the specified time range'}), 404
        
        stream.merge(fill_value='interpolate')  # Use linear interpolation for gaps
        trace = stream[0]
        
        # Handle any remaining NaN values (shouldn't happen after interpolation, but just in case)
        data = trace.data.astype(np.float32)
        nan_mask = np.isnan(data) | ~np.isfinite(data)
        if np.any(nan_mask):
            # If there are still NaNs after merge, replace with linear interpolation
            valid_indices = np.where(~nan_mask)[0]
            if len(valid_indices) > 1:
                data[nan_mask] = np.interp(
                    np.where(nan_mask)[0],
                    valid_indices,
                    data[valid_indices]
                )
            else:
                # If almost all data is NaN, just fill with zeros
                data[nan_mask] = 0
        
        # Convert to int16 for better compression
        int16_data = data.astype(np.int16)
        
        # Create xarray Dataset with metadata
        times = np.arange(len(int16_data)) / trace.stats.sampling_rate
        
        # Determine compression level for metadata
        if compression_format == 'blosc':
            comp_level = blosc_level
        elif compression_format == 'zstd':
            comp_level = zstd_level
        else:
            comp_level = gzip_level
        
        ds = xr.Dataset(
            {
                'amplitude': (['time'], int16_data),
            },
            coords={
                'time': times
            },
            attrs={
                'network': config['network'],
                'station': config['station'],
                'location': successful_location,
                'channel': config['channel'],
                'sampling_rate': float(trace.stats.sampling_rate),
                'start_time': str(trace.stats.starttime),
                'end_time': str(trace.stats.endtime),
                'volcano': volcano.lower(),
                'compression_format': compression_format,
                'compression_level': comp_level
            }
        )
        
        # Create temporary directory for Zarr store
        temp_dir = tempfile.mkdtemp()
        zarr_path = os.path.join(temp_dir, 'data.zarr')
        
        try:
            # Choose compressor based on format
            if compression_format == 'blosc':
                from numcodecs import Blosc
                compressor = Blosc(cname='zstd', clevel=blosc_level, shuffle=Blosc.SHUFFLE)
            elif compression_format == 'zstd':
                from numcodecs import Zstd
                compressor = Zstd(level=zstd_level)
            else:
                from numcodecs import Zlib
                compressor = Zlib(level=gzip_level)
            
            # Save to Zarr with chosen compression (using Zarr v2 API for xarray compatibility)
            ds.to_zarr(
                zarr_path,
                mode='w',
                encoding={
                    'amplitude': {
                        'compressor': compressor
                    }
                }
            )
            
            # Create a zip file of the Zarr directory
            import zipfile
            zip_buffer = io.BytesIO()
            with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_STORED) as zip_file:
                for root, dirs, files in os.walk(zarr_path):
                    for file in files:
                        file_path = os.path.join(root, file)
                        arcname = os.path.relpath(file_path, temp_dir)
                        zip_file.write(file_path, arcname)
            
            zip_buffer.seek(0)
            
            if compression_format == 'blosc':
                filename_suffix = f"blosc{blosc_level}"
            elif compression_format == 'zstd':
                filename_suffix = f"zstd{zstd_level}"
            else:
                filename_suffix = f"gzip{gzip_level}"
            
            return Response(
                zip_buffer.getvalue(),
                mimetype='application/zip',
                headers={
                    'Content-Disposition': f'attachment; filename={volcano}_{hours}h_{filename_suffix}.zarr.zip',
                    'X-Compression-Format': compression_format,
                    'X-Compression-Level': str(comp_level),
                    'X-Sample-Rate': str(trace.stats.sampling_rate),
                    'X-Data-Points': str(len(trace.data))
                }
            )
        finally:
            # Clean up temp directory
            shutil.rmtree(temp_dir, ignore_errors=True)
            
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/stream/<volcano>/<int:hours>')
def stream_zarr(volcano, hours):
    """Stream progressive chunks from R2 cache; populate cache from IRIS if missing.
    Query params:
    - storage: raw|zarr (default: raw)
    - compression: int16|gzip|blosc|none (default: gzip; none->int16)
    - hours_ago: int (default: 12)
    - network, station, location, channel: Optional station selection
    """
    try:
        if volcano.lower() not in VOLCANOES:
            return jsonify({'error': f'Unknown volcano: {volcano}'}), 404

        storage = request.args.get('storage', 'raw')
        compression = request.args.get('compression', 'gzip')
        if compression == 'none':
            compression = 'int16'
        hours_ago = int(request.args.get('hours_ago', 12))
        
        # Optional station selection
        network = request.args.get('network')
        station = request.args.get('station')
        location = request.args.get('location')
        channel = request.args.get('channel')

        cache_key, profiles, metadata = ensure_cached_in_r2(volcano.lower(), hours_ago, hours, network, station, location, channel)

        # Determine total file size for headers
        if storage == 'raw':
            if compression == 'int16':
                ext = '.bin'
            elif compression == 'gzip':
                ext = '.bin.gz'
            elif compression == 'blosc':
                ext = '.blosc'
            else:
                return jsonify({'error': 'Unsupported compression'}), 400
            key = r2_key(cache_key, compression, storage, ext)
            head = s3_client.head_object(Bucket=R2_BUCKET_NAME, Key=key)
            total_size = int(head['ContentLength'])
        elif storage == 'zarr':
            # Sum all zarr chunk sizes for content-length
            prefix = r2_key(cache_key, compression, storage, '/data.zarr/')
            size_sum = 0
            cont = None
            while True:
                kwargs = {'Bucket': R2_BUCKET_NAME, 'Prefix': prefix, 'MaxKeys': 1000}
                if cont:
                    kwargs['ContinuationToken'] = cont
                resp = s3_client.list_objects_v2(**kwargs)
                for obj in resp.get('Contents', []):
                    base = obj['Key'].split('/')[-1]
                    if base in ['.zarray', '.zattrs', '.zgroup']:
                        continue
                    size_sum += int(obj['Size'])
                if resp.get('IsTruncated'):
                    cont = resp.get('NextContinuationToken')
                else:
                    break
            total_size = size_sum
        else:
            return jsonify({'error': 'Unsupported storage'}), 400

        # Build profiling headers
        variant_key = f"{compression}/{storage}"
        variant_profile = profiles.get('variants', {}).get(variant_key, {})
        headers = {
            'X-Cache-Key': cache_key,
            'X-Storage': storage,
            'X-Compression': compression,
            'X-Original-Bytes': str(variant_profile.get('original_size_bytes', 0)),
            'X-Compressed-Bytes': str(variant_profile.get('compressed_size_bytes', total_size)),
            'X-Compress-MS': str(round(variant_profile.get('compress_ms', 0.0), 1)),
            'X-IRIS-Fetch-MS': str(round(profiles.get('iris_fetch_ms', 0.0), 1)),
            'X-Preprocess-MS': str(round(profiles.get('preprocess_ms', 0.0), 1)),
            'Content-Length': str(total_size),
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*'
        }

        def generator():
            t0 = time.time()
            first_sent = None
            for chunk in stream_variant_from_r2(cache_key, storage, compression):
                if first_sent is None:
                    first_sent = time.time()
                yield chunk
            total_ms = (time.time() - t0) * 1000.0
            if first_sent is not None:
                headers['X-TTFA-MS'] = str(round((first_sent - t0) * 1000.0, 1))
            headers['X-Transfer-MS'] = str(round(total_ms, 1))

        return Response(stream_with_context(generator()), mimetype='application/octet-stream', headers=headers)

    except Exception as e:
        return jsonify({'error': str(e)}), 500

# Register progressive chunk test endpoint
from progressive_test_endpoint import create_progressive_test_endpoint
app = create_progressive_test_endpoint(app)

@app.route('/test_iris_to_r2', methods=['GET'])
def test_iris_to_r2():
    """Test endpoint: IRIS → Render → R2 pipeline"""
    import requests
    from datetime import datetime, timedelta
    
    try:
        results = {
            'test': 'IRIS → Render → R2 Pipeline',
            'timestamp': datetime.utcnow().isoformat(),
            'steps': []
        }
        
        # Step 1: Fetch from IRIS (1 hour, 48 hours ago)
        now = datetime.utcnow()
        start_time = now - timedelta(hours=48)
        end_time = start_time + timedelta(hours=1)
        
        start_str = start_time.strftime("%Y-%m-%dT%H:%M:%S")
        end_str = end_time.strftime("%Y-%m-%dT%H:%M:%S")
        
        iris_url = (
            "https://service.iris.edu/fdsnws/dataselect/1/query?"
            "net=HV&sta=OBL&loc=--&cha=HHZ"
            f"&start={start_str}&end={end_str}"
            "&format=miniseed"
        )
        
        fetch_start = time.time()
        response = requests.get(iris_url, timeout=120)
        fetch_time = time.time() - fetch_start
        
        if response.status_code != 200:
            return jsonify({
                'success': False,
                'error': f'IRIS returned {response.status_code}',
                'url': iris_url
            }), 500
        
        data = response.content
        data_size_mb = len(data) / (1024 * 1024)
        
        results['steps'].append({
            'step': 'IRIS Fetch',
            'success': True,
            'size_mb': round(data_size_mb, 2),
            'time_sec': round(fetch_time, 2),
            'speed_mbps': round(data_size_mb / fetch_time, 2)
        })
        
        # Step 2: Upload to R2
        r2_key = f"test/render-iris-test-{int(time.time())}.mseed"
        
        upload_start = time.time()
        s3_client.put_object(
            Bucket=R2_BUCKET_NAME,
            Key=r2_key,
            Body=data,
            ContentType='application/vnd.fdsn.mseed',
            Metadata={
                'source': 'IRIS',
                'network': 'HV',
                'station': 'OBL',
                'channel': 'HHZ',
                'start_time': start_str,
                'end_time': end_str,
                'duration_hours': '1',
                'test': 'render-to-r2'
            }
        )
        upload_time = time.time() - upload_start
        
        results['steps'].append({
            'step': 'R2 Upload',
            'success': True,
            'key': r2_key,
            'time_sec': round(upload_time, 2)
        })
        
        # Step 3: Verify
        verify_start = time.time()
        obj = s3_client.get_object(Bucket=R2_BUCKET_NAME, Key=r2_key)
        stored_data = obj['Body'].read()
        verify_time = time.time() - verify_start
        
        matches = len(stored_data) == len(data)
        
        results['steps'].append({
            'step': 'R2 Verify',
            'success': matches,
            'original_size': len(data),
            'stored_size': len(stored_data),
            'time_sec': round(verify_time, 2)
        })
        
        # Summary
        results['success'] = True
        results['total_time_sec'] = round(fetch_time + upload_time + verify_time, 2)
        results['summary'] = {
            'iris_fetch': '✅ PASS',
            'r2_upload': '✅ PASS',
            'r2_verify': '✅ PASS' if matches else '❌ FAIL',
            'data_integrity': '✅ INTACT' if matches else '❌ CORRUPTED'
        }
        
        return jsonify(results)
        
    except Exception as e:
        return jsonify({
            'success': False,
            'error': str(e),
            'test': 'IRIS → Render → R2 Pipeline'
        }), 500

@app.route('/api/local-files', methods=['GET'])
def list_local_files():
    """List all mseed files in the local mseed_files directory"""
    try:
        mseed_dir = Path('../mseed_files')
        if not mseed_dir.exists():
            return jsonify({'files': [], 'error': 'mseed_files directory not found'})
        
        # Get all .mseed files
        mseed_files = sorted([f.name for f in mseed_dir.glob('*.mseed')])
        
        return jsonify({
            'files': mseed_files,
            'count': len(mseed_files)
        })
    except Exception as e:
        return jsonify({'error': str(e), 'files': []}), 500

@app.route('/api/local-file', methods=['GET'])
def serve_local_file():
    """Serve a local mseed file as int16 raw binary, progressively chunked"""
    try:
        filename = request.args.get('filename')
        output_sample_rate = int(request.args.get('sample_rate', 44100))
        
        if not filename:
            return jsonify({'error': 'filename parameter required'}), 400
        
        mseed_file = Path(f'../mseed_files/{filename}')
        if not mseed_file.exists():
            return jsonify({'error': f'File not found: {filename}'}), 404
        
        # Read the mseed file
        from obspy import read
        st = read(str(mseed_file))
        
        # Get the trace data
        trace = st[0]
        data = trace.data.astype(np.float64)
        sample_rate = trace.stats.sampling_rate
        
        # Convert to int16
        max_val = np.abs(data).max()
        if max_val > 0:
            normalized = data / max_val
            int16_data = (normalized * 32767).astype(np.int16)
        else:
            int16_data = data.astype(np.int16)
        
        # Create metadata
        metadata = {
            'sample_rate': float(sample_rate),
            'samples': len(int16_data),
            'duration_seconds': len(int16_data) / sample_rate,
            'filename': filename
        }
        
        # Send entire file as one chunk (no progressive loading for local files)
        return Response(
            int16_data.tobytes(),
            mimetype='application/octet-stream',
            headers={
                'X-Metadata': json.dumps(metadata),
                'X-Cache-Hit': 'true',
                'X-Data-Ready-Ms': '0',
                'Cache-Control': 'no-cache'
            }
        )
        
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/request', methods=['POST'])
def handle_request():
    """
    FULL PIPELINE - Receives requests from R2 Worker
    Fetches from IRIS, processes, chunks, compresses, and uploads to R2
    """
    import zstandard as zstd
    from datetime import datetime, timedelta
    
    try:
        data = request.get_json()
        
        network = data.get('network', 'HV')
        station = data.get('station', 'NPOC')
        location = data.get('location', '')  # NPOC has empty location
        channel = data.get('channel', 'HHZ')
        starttime_str = data.get('starttime')
        duration = data.get('duration', 3600)  # seconds
        
        if not starttime_str:
            return jsonify({'error': 'starttime is required'}), 400
        
        app.logger.info(f"[Render] 📥 Received request: {network}.{station}.{location}.{channel} @ {starttime_str} for {duration}s")
        
        # Convert to ObsPy time
        starttime = UTCDateTime(starttime_str)
        endtime = starttime + duration
        
        # STEP 1: Fetch from IRIS with retry logic
        app.logger.info(f"[Render] 📤 Requesting from IRIS...")
        client = Client("IRIS")
        
        attempt_duration = duration
        st = None
        while attempt_duration >= 60:  # Minimum 1 minute
            try:
                st = client.get_waveforms(
                    network=network,
                    station=station,
                    location=location,
                    channel=channel,
                    starttime=starttime,
                    endtime=starttime + attempt_duration
                )
                app.logger.info(f"[Render] ✅ IRIS returned {len(st)} traces for {attempt_duration}s")
                break
            except Exception as e:
                app.logger.warning(f"[Render] IRIS failed for {attempt_duration}s: {e}")
                attempt_duration = attempt_duration // 2
                app.logger.info(f"[Render] Retrying with half duration: {attempt_duration}s")
        
        if not st:
            return jsonify({'error': 'Failed to fetch data from IRIS'}), 500
        
        # STEP 2: Merge and dedupe
        app.logger.info(f"[Render] 🔧 Merging traces...")
        st.merge(method=1, fill_value='interpolate')
        trace = st[0]
        
        # STEP 3: Calculate metadata
        app.logger.info(f"[Render] 📊 Calculating metadata...")
        data_array = trace.data.astype(np.int32)
        metadata = {
            'network': network,
            'station': station,
            'location': location,
            'channel': channel,
            'starttime': str(trace.stats.starttime),
            'endtime': str(trace.stats.endtime),
            'sampling_rate': float(trace.stats.sampling_rate),
            'npts': int(trace.stats.npts),
            'min': int(np.min(data_array)),
            'max': int(np.max(data_array)),
        }
        app.logger.info(f"[Render] Min/Max: [{metadata['min']}, {metadata['max']}]")
        
        # STEP 4: Create chunks
        sampling_rate = trace.stats.sampling_rate
        samples_per_minute = int(sampling_rate * 60)
        
        chunks_created = []
        
        # Build R2 path
        dt = datetime.fromisoformat(starttime_str.replace('Z', '+00:00'))
        year = dt.year
        month = dt.month
        day = dt.day
        hour = dt.hour
        minute = dt.minute
        
        # Build path (handle empty location)
        loc_part = location if location else '--'
        base_path = f"data/{year}/{month:02d}/{network}/kilauea/{station}/{loc_part}/{channel}"
        
        # Compress function
        compressor = zstd.ZstdCompressor(level=3)
        
        # 6 x 1-minute chunks
        app.logger.info(f"[Render] ✂️ Creating 1-minute chunks...")
        for i in range(6):
            start_sample = i * samples_per_minute
            end_sample = min((i + 1) * samples_per_minute, len(data_array))
            if start_sample >= len(data_array):
                break
            
            chunk_data = data_array[start_sample:end_sample]
            chunk_bytes = chunk_data.tobytes()
            compressed = compressor.compress(chunk_bytes)
            
            # Upload to R2
            chunk_time = starttime + (i * 60)
            chunk_filename = f"{year}-{month:02d}-{day:02d}-{hour:02d}-{(minute + i):02d}.zst"
            r2_key = f"{base_path}/{chunk_filename}"
            
            s3_client.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=r2_key,
                Body=compressed,
                ContentType='application/zstd'
            )
            
            chunks_created.append({'type': '1min', 'key': r2_key, 'size': len(compressed)})
            app.logger.info(f"[Render] ✅ Uploaded 1-min chunk {i+1}/6: {len(chunk_data)} samples → {len(compressed)} bytes")
        
        # 4 x 6-minute chunks (starting after first 6 minutes)
        if len(data_array) > 6 * samples_per_minute:
            app.logger.info(f"[Render] ✂️ Creating 6-minute chunks...")
            samples_per_6min = samples_per_minute * 6
            offset = 6 * samples_per_minute
            
            for i in range(4):
                start_sample = offset + (i * samples_per_6min)
                end_sample = min(start_sample + samples_per_6min, len(data_array))
                if start_sample >= len(data_array):
                    break
                
                chunk_data = data_array[start_sample:end_sample]
                chunk_bytes = chunk_data.tobytes()
                compressed = compressor.compress(chunk_bytes)
                
                chunk_time = starttime + 360 + (i * 360)  # 6 min = 360s
                chunk_filename = f"{year}-{month:02d}-{day:02d}-{hour:02d}-{(minute + 6 + i*6):02d}_6min.zst"
                r2_key = f"{base_path}/{chunk_filename}"
                
                s3_client.put_object(
                    Bucket=R2_BUCKET_NAME,
                    Key=r2_key,
                    Body=compressed,
                    ContentType='application/zstd'
                )
                
                chunks_created.append({'type': '6min', 'key': r2_key, 'size': len(compressed)})
                app.logger.info(f"[Render] ✅ Uploaded 6-min chunk {i+1}/4: {len(chunk_data)} samples → {len(compressed)} bytes")
        
        # 1 x 30-minute chunk (final)
        if len(data_array) > 30 * samples_per_minute:
            app.logger.info(f"[Render] ✂️ Creating 30-minute chunk...")
            offset = 30 * samples_per_minute
            
            chunk_data = data_array[offset:]
            chunk_bytes = chunk_data.tobytes()
            compressed = compressor.compress(chunk_bytes)
            
            chunk_filename = f"{year}-{month:02d}-{day:02d}-{hour:02d}-{(minute + 30):02d}_30min.zst"
            r2_key = f"{base_path}/{chunk_filename}"
            
            s3_client.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=r2_key,
                Body=compressed,
                ContentType='application/zstd'
            )
            
            chunks_created.append({'type': '30min', 'key': r2_key, 'size': len(compressed)})
            app.logger.info(f"[Render] ✅ Uploaded 30-min chunk: {len(chunk_data)} samples → {len(compressed)} bytes")
        
        # Upload metadata
        metadata_filename = f"{year}-{month:02d}-{day:02d}.json"
        metadata_key = f"{base_path}/{metadata_filename}"
        
        s3_client.put_object(
            Bucket=R2_BUCKET_NAME,
            Key=metadata_key,
            Body=json.dumps(metadata, indent=2),
            ContentType='application/json'
        )
        
        app.logger.info(f"[Render] ✅ Uploaded metadata: {metadata_key}")
        app.logger.info(f"[Render] 🎉 Pipeline complete: {len(chunks_created)} chunks created")
        
        return jsonify({
            'status': 'completed',
            'message': 'Data processed and uploaded to R2',
            'request_id': f"{network}.{station}.{location}.{channel}@{starttime_str}",
            'metadata': metadata,
            'chunks': chunks_created,
            'metadata_key': metadata_key,
        }), 200
        
    except Exception as e:
        app.logger.error(f"[Render] Pipeline error: {e}", exc_info=True)
        return jsonify({'error': str(e)}), 500

@app.route('/api/request-stream', methods=['POST'])
def handle_request_stream():
    """
    SSE STREAMING PIPELINE - Real-time progress updates
    Same as /api/request but streams events as they happen
    """
    import zstandard as zstd
    from datetime import datetime, timedelta
    
    # Parse request data BEFORE generator (must be in request context)
    data = request.get_json()
    
    network = data.get('network', 'HV')
    station = data.get('station', 'NPOC')
    location = data.get('location', '')
    channel = data.get('channel', 'HHZ')
    starttime_str = data.get('starttime')
    duration = data.get('duration', 3600)
    
    if not starttime_str:
        return jsonify({'error': 'starttime is required'}), 400
    
    app.logger.info(f"[Render SSE] 📥 Received streaming request: {network}.{station}.{location}.{channel} @ {starttime_str} for {duration}s")
    
    def generate():
        try:
            
            # Event: Request received
            yield f"event: request_received\ndata: {json.dumps({'network': network, 'station': station, 'channel': channel, 'starttime': starttime_str, 'duration': duration})}\n\n"
            
            starttime = UTCDateTime(starttime_str)
            endtime = starttime + duration
            
            # Event: Requesting from IRIS
            yield f"event: iris_request\ndata: {json.dumps({'message': 'Requesting data from IRIS'})}\n\n"
            
            client = Client("IRIS")
            attempt_duration = duration
            st = None
            
            while attempt_duration >= 60:
                try:
                    st = client.get_waveforms(
                        network=network,
                        station=station,
                        location=location,
                        channel=channel,
                        starttime=starttime,
                        endtime=starttime + attempt_duration
                    )
                    # Event: IRIS response
                    yield f"event: iris_response\ndata: {json.dumps({'traces': len(st), 'duration': attempt_duration})}\n\n"
                    break
                except Exception as e:
                    attempt_duration = attempt_duration // 2
                    yield f"event: iris_retry\ndata: {json.dumps({'message': f'Retrying with {attempt_duration}s'})}\n\n"
            
            if not st:
                yield f"event: error\ndata: {json.dumps({'error': 'Failed to fetch data from IRIS'})}\n\n"
                return
            
            # Event: Merging traces
            yield f"event: merge_start\ndata: {json.dumps({'message': 'Merging and deduplicating traces'})}\n\n"
            st.merge(method=1, fill_value='interpolate')
            trace = st[0]
            
            # Event: Calculating metadata
            yield f"event: metadata_start\ndata: {json.dumps({'message': 'Calculating metadata'})}\n\n"
            data_array = trace.data.astype(np.int32)
            min_val = int(np.min(data_array))
            max_val = int(np.max(data_array))
            npts_val = int(trace.stats.npts)
            
            metadata = {
                'network': network,
                'station': station,
                'location': location,
                'channel': channel,
                'starttime': str(trace.stats.starttime),
                'endtime': str(trace.stats.endtime),
                'sampling_rate': float(trace.stats.sampling_rate),
                'npts': npts_val,
                'min': min_val,
                'max': max_val,
            }
            
            # Log metadata calculation
            app.logger.info(f"[Render] 📊 Metadata calculated: min={min_val}, max={max_val}, npts={npts_val}, samples={len(data_array)}")
            
            # Event: Metadata calculated
            metadata_json = json.dumps(metadata)
            app.logger.info(f"[Render] 📤 Sending metadata_calculated event: {metadata_json[:200]}...")
            yield f"event: metadata_calculated\ndata: {metadata_json}\n\n"
            
            # Setup for chunking
            sampling_rate = trace.stats.sampling_rate
            samples_per_minute = int(sampling_rate * 60)
            
            dt = datetime.fromisoformat(starttime_str.replace('Z', '+00:00'))
            year = dt.year
            month = dt.month
            day = dt.day
            hour = dt.hour
            minute = dt.minute
            
            loc_part = location if location else '--'
            base_path = f"data/{year}/{month:02d}/{network}/kilauea/{station}/{loc_part}/{channel}"
            
            compressor = zstd.ZstdCompressor(level=3)
            chunks_created = []
            
            # Event: Starting chunk creation
            yield f"event: chunk_start\ndata: {json.dumps({'message': 'Creating 1-minute chunks'})}\n\n"
            
            # 6 x 1-minute chunks
            for i in range(6):
                start_sample = i * samples_per_minute
                end_sample = min((i + 1) * samples_per_minute, len(data_array))
                if start_sample >= len(data_array):
                    break
                
                chunk_data = data_array[start_sample:end_sample]
                chunk_bytes = chunk_data.tobytes()
                compressed = compressor.compress(chunk_bytes)
                
                chunk_filename = f"{year}-{month:02d}-{day:02d}-{hour:02d}-{(minute + i):02d}.zst"
                r2_key = f"{base_path}/{chunk_filename}"
                
                s3_client.put_object(Bucket=R2_BUCKET_NAME, Key=r2_key, Body=compressed, ContentType='application/zstd')
                chunks_created.append({'type': '1min', 'key': r2_key, 'size': len(compressed)})
                
                # Event: Chunk uploaded with presigned URL (works around CORS)
                chunk_url = s3_client.generate_presigned_url(
                    'get_object',
                    Params={'Bucket': R2_BUCKET_NAME, 'Key': r2_key},
                    ExpiresIn=3600  # 1 hour
                )
                yield f"event: chunk_uploaded\ndata: {json.dumps({'type': '1min', 'index': i+1, 'total': 6, 'samples': len(chunk_data), 'compressed_size': len(compressed), 'url': chunk_url, 'key': r2_key})}\n\n"
            
            # 4 x 6-minute chunks
            if len(data_array) > 6 * samples_per_minute:
                yield f"event: chunk_start\ndata: {json.dumps({'message': 'Creating 6-minute chunks'})}\n\n"
                
                samples_per_6min = samples_per_minute * 6
                offset = 6 * samples_per_minute
                
                for i in range(4):
                    start_sample = offset + (i * samples_per_6min)
                    end_sample = min(start_sample + samples_per_6min, len(data_array))
                    if start_sample >= len(data_array):
                        break
                    
                    chunk_data = data_array[start_sample:end_sample]
                    chunk_bytes = chunk_data.tobytes()
                    compressed = compressor.compress(chunk_bytes)
                    
                    chunk_filename = f"{year}-{month:02d}-{day:02d}-{hour:02d}-{(minute + 6 + i*6):02d}_6min.zst"
                    r2_key = f"{base_path}/{chunk_filename}"
                    
                    s3_client.put_object(Bucket=R2_BUCKET_NAME, Key=r2_key, Body=compressed, ContentType='application/zstd')
                    chunks_created.append({'type': '6min', 'key': r2_key, 'size': len(compressed)})
                    
                    # Event: Chunk uploaded with presigned URL
                    chunk_url = s3_client.generate_presigned_url(
                        'get_object',
                        Params={'Bucket': R2_BUCKET_NAME, 'Key': r2_key},
                        ExpiresIn=3600
                    )
                    yield f"event: chunk_uploaded\ndata: {json.dumps({'type': '6min', 'index': i+1, 'total': 4, 'samples': len(chunk_data), 'compressed_size': len(compressed), 'url': chunk_url, 'key': r2_key})}\n\n"
            
            # 1 x 30-minute chunk
            if len(data_array) > 30 * samples_per_minute:
                yield f"event: chunk_start\ndata: {json.dumps({'message': 'Creating 30-minute chunk'})}\n\n"
                
                offset = 30 * samples_per_minute
                chunk_data = data_array[offset:]
                chunk_bytes = chunk_data.tobytes()
                compressed = compressor.compress(chunk_bytes)
                
                chunk_filename = f"{year}-{month:02d}-{day:02d}-{hour:02d}-{(minute + 30):02d}_30min.zst"
                r2_key = f"{base_path}/{chunk_filename}"
                
                s3_client.put_object(Bucket=R2_BUCKET_NAME, Key=r2_key, Body=compressed, ContentType='application/zstd')
                chunks_created.append({'type': '30min', 'key': r2_key, 'size': len(compressed)})
                
                # Event: Chunk uploaded with presigned URL
                chunk_url = s3_client.generate_presigned_url(
                    'get_object',
                    Params={'Bucket': R2_BUCKET_NAME, 'Key': r2_key},
                    ExpiresIn=3600
                )
                yield f"event: chunk_uploaded\ndata: {json.dumps({'type': '30min', 'index': 1, 'total': 1, 'samples': len(chunk_data), 'compressed_size': len(compressed), 'url': chunk_url, 'key': r2_key})}\n\n"
            
            # Upload metadata
            metadata_filename = f"{year}-{month:02d}-{day:02d}.json"
            metadata_key = f"{base_path}/{metadata_filename}"
            s3_client.put_object(Bucket=R2_BUCKET_NAME, Key=metadata_key, Body=json.dumps(metadata, indent=2), ContentType='application/json')
            
            yield f"event: metadata_uploaded\ndata: {json.dumps({'key': metadata_key})}\n\n"
            
            # Event: Complete
            yield f"event: complete\ndata: {json.dumps({'chunks': len(chunks_created), 'metadata_key': metadata_key})}\n\n"
            
        except Exception as e:
            app.logger.error(f"[Render] SSE Pipeline error: {e}", exc_info=True)
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
    
    return Response(stream_with_context(generate()), mimetype='text/event-stream', headers={
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*'
    })

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(host='0.0.0.0', port=port, debug=True)
