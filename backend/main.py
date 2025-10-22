# -*- coding: utf-8 -*-
from flask import Flask, request, jsonify, send_file, Response, stream_with_context
from flask_cors import CORS
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

app = Flask(__name__)
CORS(app)

# Configuration
MAX_RADIUS_KM = 13.0 * 1.60934  # 13 miles converted to km
REQUIRED_COMPONENT = 'Z'  # Z-component only (vertical)

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
                    'label': f"{ch['network']}.{ch['station']}.{ch.get('location') or '--'}.{ch['channel']} ({int(ch.get('sample_rate', 0))} Hz, {ch.get('distance_km', 0):.1f}km)"
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
                    'label': f"{ch['network']}.{ch['station']}.{ch.get('location') or '--'}.{ch['channel']} ({int(ch.get('sample_rate', 0))} Hz, {ch.get('distance_km', 0):.1f}km)"
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
    """Stream progressive chunks of seismic data
    
    Query params:
    - format: gzip/blosc/zstd (default: gzip)
    - level: compression level 1-9 (default: 5)
    - zarr: wrap in zarr format (default: false)
    - network: network code (optional, uses default if not specified)
    - station: station code (optional, uses default if not specified)
    - location: location code (optional, uses default if not specified)
    - channel: channel code (optional, uses default if not specified)
    """
    try:
        if volcano.lower() not in VOLCANOES:
            return jsonify({'error': f'Unknown volcano: {volcano}'}), 404
        
        # Get compression settings
        compression_format = request.args.get('format', 'gzip')
        compression_level = int(request.args.get('level', 5))
        use_zarr = request.args.get('zarr', 'false').lower() == 'true'
        
        # Get station parameters (use config defaults if not specified)
        config = VOLCANOES[volcano.lower()]
        network = request.args.get('network', config['network'])
        station = request.args.get('station', config['station'])
        location = request.args.get('location', config.get('location', ''))
        channel = request.args.get('channel', config['channel'])
        
        # Progressive chunk sizes (in seconds)
        chunk_sizes = [60, 120, 300, 600]  # 1min, 2min, 5min, 10min
        
        def generate():
            end = UTCDateTime.now() - 300  # 5 min lag
            start = end - (hours * 3600)
            
            client = Client("IRIS")
            
            # Fetch full data once
            stream = None
            locations_to_try = [location] + LOCATION_FALLBACKS
            for loc in locations_to_try:
                try:
                    stream = client.get_waveforms(
                        network=network,
                        station=station,
                        location=loc,
                        channel=channel,
                        starttime=start,
                        endtime=end
                    )
                    if stream:
                        break
                except:
                    continue
            
            if not stream:
                yield json.dumps({'error': 'No data available'}).encode() + b'\n'
                return
            
            # Merge and process
            stream.merge(fill_value='interpolate')
            trace = stream[0]
            
            # Handle NaN/Inf
            data = trace.data.astype(np.float64)
            if np.any(~np.isfinite(data)):
                mask = ~np.isfinite(data)
                indices = np.arange(len(data))
                data[mask] = np.interp(indices[mask], indices[~mask], data[~mask])
                if np.any(~np.isfinite(data)):
                    data[~np.isfinite(data)] = 0
            
            # Detrend the FULL dataset (critical for continuity)
            data = data - np.mean(data)
            
            # Normalize to int16 range
            max_abs = np.max(np.abs(data))
            if max_abs > 0:
                data = data / max_abs * 32767.0
            
            # Convert to int16
            data_int16 = data.astype(np.int16)
            sampling_rate = int(trace.stats.sampling_rate)
            
            # Send metadata first
            metadata = {
                'type': 'metadata',
                'sampling_rate': sampling_rate,
                'total_samples': len(data_int16),
                'channel': channel,
                'network': network,
                'station': station,
                'location': location,
                'start_time': str(trace.stats.starttime),
                'end_time': str(trace.stats.endtime)
            }
            yield json.dumps(metadata).encode() + b'\n'
            
            # Stream progressive chunks
            import time
            offset = 0
            chunk_index = 0
            processing_complete_time = time.time()
            
            while offset < len(data_int16):
                # Determine chunk size
                chunk_size_seconds = chunk_sizes[min(chunk_index, len(chunk_sizes) - 1)]
                samples_in_chunk = chunk_size_seconds * sampling_rate
                end_idx = min(offset + samples_in_chunk, len(data_int16))
                
                chunk_data = data_int16[offset:end_idx]
                
                # Compress chunk
                compress_start = time.time()
                
                if use_zarr:
                    # Wrap in Zarr format
                    import xarray as xr
                    import tempfile
                    import shutil
                    
                    # Create xarray Dataset
                    ds = xr.Dataset({
                        'amplitude': (['time'], chunk_data)
                    })
                    
                    # Save to temp Zarr store
                    temp_dir = tempfile.mkdtemp()
                    zarr_path = f"{temp_dir}/chunk.zarr"
                    
                    if compression_format == 'blosc':
                        compressor = Blosc(cname='zstd', clevel=compression_level, shuffle=Blosc.SHUFFLE)
                    elif compression_format == 'zstd':
                        compressor = Zstd(level=compression_level)
                    else:  # gzip
                        compressor = Zlib(level=compression_level)
                    
                    ds.to_zarr(zarr_path, mode='w', compressor=compressor)
                    
                    # Read back as bytes
                    import os
                    compressed_parts = []
                    for root, dirs, files in os.walk(zarr_path):
                        for file in files:
                            with open(os.path.join(root, file), 'rb') as f:
                                compressed_parts.append(f.read())
                    compressed = b''.join(compressed_parts)
                    
                    shutil.rmtree(temp_dir)
                else:
                    # Raw compression
                    if compression_format == 'blosc':
                        compressor = Blosc(cname='zstd', clevel=compression_level, shuffle=Blosc.SHUFFLE)
                    elif compression_format == 'zstd':
                        compressor = Zstd(level=compression_level)
                    else:  # gzip
                        compressor = Zlib(level=compression_level)
                    
                    compressed = compressor.encode(chunk_data.tobytes())
                
                compress_time = (time.time() - compress_start) * 1000
                
                # Send chunk header
                chunk_header = {
                    'type': 'chunk',
                    'index': chunk_index,
                    'samples': len(chunk_data),
                    'compressed_size': len(compressed),
                    'compression': compression_format
                }
                yield json.dumps(chunk_header).encode() + b'\n'
                
                # Send compressed data
                send_start = time.time()
                yield compressed + b'\n'
                send_time = (time.time() - send_start) * 1000
                
                if chunk_index == 0:
                    time_to_first_send = (send_start - processing_complete_time) * 1000
                    print(f"⚡ FIRST CHUNK: Compress={compress_time:.1f}ms | Send={send_time:.1f}ms | Time from processing complete={time_to_first_send:.1f}ms")
                
                offset = end_idx
                chunk_index += 1
            
            # Send completion message
            completion = {'type': 'complete', 'total_chunks': chunk_index}
            yield json.dumps(completion).encode() + b'\n'
        
        return Response(stream_with_context(generate()), 
                       mimetype='application/octet-stream',
                       headers={
                           'X-Compression-Format': compression_format,
                           'X-Compression-Level': str(compression_level)
                       })
    
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(host='0.0.0.0', port=port, debug=True)
