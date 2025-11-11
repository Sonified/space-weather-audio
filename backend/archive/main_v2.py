# -*- coding: utf-8 -*-
"""
Updated Render Backend - v2: Metadata-Aware with Smart Merging
Priority 1 Implementation: Correct Metadata Format + Progressive Chunking
"""
from flask import Flask, request, jsonify, Response, stream_with_context
from flask_cors import CORS
from obspy.clients.fdsn import Client
from obspy import UTCDateTime, Stream
import numpy as np
import io
import os
import json
import zstandard as zstd
from pathlib import Path
from datetime import datetime, timedelta
import boto3
import time

app = Flask(__name__)
CORS(app, expose_headers=['X-Metadata', 'X-Cache-Hit', 'X-Data-Ready-Ms'])

# Configuration
MAX_RADIUS_KM = 13.0 * 1.60934  # 13 miles converted to km
REQUIRED_COMPONENT = 'Z'  # Z-component only (vertical)
LOCATION_FALLBACKS = ["", "01", "00", "10", "--"]

# Cloudflare R2 configuration (S3-compatible)
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


def construct_r2_path(network, volcano, station, location, channel, year, month):
    """Construct R2 storage path following hierarchy"""
    loc_part = location if location else '--'
    return f"data/{year}/{month:02d}/{network}/{volcano}/{station}/{loc_part}/{channel}"


def construct_chunk_filename(network, station, location, channel, sample_rate, start_time, end_time):
    """
    Construct self-describing filename with sample rate
    Format: NETWORK_STATION_LOCATION_CHANNEL_RATEHz_START_to_END.bin.zst
    """
    loc_part = location if location else '--'
    
    # Handle fractional sample rates
    if sample_rate % 1 == 0:
        rate_str = f"{int(sample_rate)}Hz"
    else:
        rate_str = f"{sample_rate}Hz"
    
    # Format timestamps (YYYY-MM-DD-HH-MM-SS)
    start_str = start_time.strftime("%Y-%m-%d-%H-%M-%S")
    end_str = end_time.strftime("%Y-%m-%d-%H-%M-%S")
    
    return f"{network}_{station}_{loc_part}_{channel}_{rate_str}_{start_str}_to_{end_str}.bin.zst"


def construct_metadata_filename(network, station, location, channel, sample_rate, date):
    """Construct metadata filename for a day"""
    loc_part = location if location else '--'
    
    if sample_rate % 1 == 0:
        rate_str = f"{int(sample_rate)}Hz"
    else:
        rate_str = f"{sample_rate}Hz"
    
    return f"{network}_{station}_{loc_part}_{channel}_{rate_str}_{date}.json"


def detect_gaps(stream):
    """
    Detect gaps in ObsPy stream before merging
    Returns list of gap dictionaries
    """
    gaps = []
    gap_list = stream.get_gaps()
    
    for gap in gap_list:
        gap_start = UTCDateTime(gap[4])
        gap_end = UTCDateTime(gap[5])
        duration = gap_end - gap_start
        sample_rate = gap[3]
        samples_filled = int(round(duration * sample_rate))
        
        gaps.append({
            'start': gap_start.isoformat(),
            'end': gap_end.isoformat(),
            'duration_seconds': float(duration),
            'samples_filled': samples_filled
        })
    
    return gaps


def round_to_second_boundary(trace):
    """
    Round trace end time down to nearest second boundary
    Discard partial-second samples for clean concatenation
    """
    original_end = trace.stats.endtime
    rounded_end = UTCDateTime(int(original_end.timestamp))
    
    # Calculate full seconds of data
    duration_seconds = int(rounded_end.timestamp - trace.stats.starttime.timestamp)
    
    # Calculate exact number of samples for full seconds
    samples_per_second = int(trace.stats.sampling_rate)
    full_second_samples = duration_seconds * samples_per_second
    
    # Trim data to full seconds only
    trace.data = trace.data[:full_second_samples]
    trace.stats.endtime = rounded_end
    
    return trace


def calculate_chunk_gap_stats(chunk_start, chunk_end, all_gaps):
    """
    Calculate gap statistics for a specific chunk time range
    """
    gap_count = 0
    gap_duration = 0.0
    gap_samples = 0
    
    for gap in all_gaps:
        gap_start = UTCDateTime(gap['start'])
        gap_end = UTCDateTime(gap['end'])
        
        # Check if gap overlaps with chunk
        if gap_start < chunk_end and gap_end > chunk_start:
            gap_count += 1
            gap_duration += gap['duration_seconds']
            gap_samples += gap['samples_filled']
    
    return gap_count, gap_duration, gap_samples


def parse_existing_metadata(existing_metadata):
    """
    Parse existing metadata to determine what chunks already exist
    Returns set of existing chunk time ranges
    """
    existing_chunks = set()
    
    if not existing_metadata or 'chunks' not in existing_metadata:
        return existing_chunks
    
    for chunk_size in ['10min', '1h', '6h', '24h']:
        if chunk_size in existing_metadata['chunks']:
            for chunk in existing_metadata['chunks'][chunk_size]:
                start = chunk['start']
                end = chunk['end']
                existing_chunks.add((chunk_size, start, end))
    
    return existing_chunks


def calculate_missing_time_ranges(requested_start, requested_end, existing_chunks, chunk_size):
    """
    Calculate which time ranges need to be fetched from IRIS
    Returns list of (start, end) tuples representing gaps in coverage
    
    Example:
    - Requested: 00:00 to 15:00
    - Existing chunks: 00:00-05:00, 10:00-12:00
    - Returns: [(05:00, 10:00), (12:00, 15:00)]
    """
    
    if not existing_chunks:
        # No existing data - fetch entire range
        return [(requested_start, requested_end)]
    
    # Extract time ranges for requested chunk size
    covered_ranges = []
    for (size, start_str, end_str) in existing_chunks:
        if size == chunk_size:
            # Parse time strings (HH:MM:SS format)
            start_parts = [int(p) for p in start_str.split(':')]
            end_parts = [int(p) for p in end_str.split(':')]
            
            # Calculate seconds from midnight
            start_seconds = start_parts[0] * 3600 + start_parts[1] * 60 + start_parts[2]
            end_seconds = end_parts[0] * 3600 + end_parts[1] * 60 + end_parts[2]
            
            # Convert to UTCDateTime relative to requested_start's date
            chunk_start = requested_start + start_seconds
            chunk_end = requested_start + end_seconds
            
            covered_ranges.append((chunk_start, chunk_end))
    
    if not covered_ranges:
        # No chunks of this size exist - fetch entire range
        return [(requested_start, requested_end)]
    
    # Sort covered ranges by start time
    covered_ranges.sort(key=lambda r: r[0])
    
    # Merge overlapping covered ranges
    merged_covered = []
    for start, end in covered_ranges:
        if merged_covered and start <= merged_covered[-1][1]:
            # Overlapping or adjacent - extend previous range
            merged_covered[-1] = (merged_covered[-1][0], max(merged_covered[-1][1], end))
        else:
            merged_covered.append((start, end))
    
    # Find gaps in coverage
    missing_ranges = []
    current_pos = requested_start
    
    for covered_start, covered_end in merged_covered:
        if current_pos < covered_start:
            # Gap before this covered range
            missing_ranges.append((current_pos, covered_start))
        current_pos = max(current_pos, covered_end)
    
    # Check if there's a gap after the last covered range
    if current_pos < requested_end:
        missing_ranges.append((current_pos, requested_end))
    
    return missing_ranges if missing_ranges else []


@app.route('/api/request-stream-v2', methods=['POST'])
def handle_request_stream_v2():
    """
    METADATA-AWARE SSE STREAMING PIPELINE
    
    Receives:
    - Request parameters (network, station, channel, starttime, duration)
    - OPTIONAL: existing_metadata from R2 Worker
    
    Smart behavior:
    - Parse existing metadata to see what chunks already exist
    - Calculate missing time ranges
    - Only fetch missing data from IRIS
    - Merge new chunks into existing metadata structure
    - Upload updated metadata back to R2
    """
    
    # Parse request data BEFORE generator
    data = request.get_json()
    
    network = data.get('network', 'HV')
    station = data.get('station', 'NPOC')
    location = data.get('location', '')
    channel = data.get('channel', 'HHZ')
    starttime_str = data.get('starttime')
    duration = data.get('duration', 3600)
    volcano = data.get('volcano', 'kilauea')  # R2 Worker should provide this
    
    # CRITICAL: R2 Worker sends existing metadata (if it exists)
    existing_metadata = data.get('existing_metadata', None)
    
    if not starttime_str:
        return jsonify({'error': 'starttime is required'}), 400
    
    app.logger.info(f"[Render V2] 📥 Request: {network}.{station}.{location}.{channel} @ {starttime_str} for {duration}s")
    if existing_metadata:
        app.logger.info(f"[Render V2] 📋 Existing metadata provided (will merge)")
    else:
        app.logger.info(f"[Render V2] 🆕 No existing metadata (creating new)")
    
    def generate():
        try:
            yield f"event: request_received\ndata: {json.dumps({'network': network, 'station': station, 'channel': channel, 'starttime': starttime_str, 'duration': duration})}\n\n"
            
            starttime = UTCDateTime(starttime_str)
            endtime = starttime + duration
            
            # Parse existing metadata to determine what's already cached
            existing_chunks = parse_existing_metadata(existing_metadata)
            
            if existing_chunks:
                yield f"event: metadata_parsed\ndata: {json.dumps({'existing_chunks': len(existing_chunks), 'message': 'Existing metadata parsed'})}\n\n"
                app.logger.info(f"[Render V2] Found {len(existing_chunks)} existing chunks")
            else:
                yield f"event: metadata_parsed\ndata: {json.dumps({'existing_chunks': 0, 'message': 'No existing metadata'})}\n\n"
            
            # Calculate missing time ranges
            missing_ranges = calculate_missing_time_ranges(starttime, endtime, existing_chunks, '1h')
            
            if not missing_ranges:
                yield f"event: no_fetch_needed\ndata: {json.dumps({'message': 'All requested data already cached'})}\n\n"
                return
            
            # STEP 1: Fetch from IRIS (only missing ranges)
            time_range_str = f"{starttime.strftime('%H:%M:%S')} to {endtime.strftime('%H:%M:%S')}"
            yield f"event: iris_request\ndata: {json.dumps({'message': 'Requesting data from IRIS', 'ranges': len(missing_ranges), 'time_range': time_range_str})}\n\n"
            
            client = Client("IRIS")
            
            # Fetch with retry logic
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
                    yield f"event: iris_response\ndata: {json.dumps({'traces': len(st), 'duration': attempt_duration})}\n\n"
                    app.logger.info(f"[Render V2] ✅ IRIS returned {len(st)} traces")
                    break
                except Exception as e:
                    app.logger.warning(f"[Render V2] IRIS failed for {attempt_duration}s: {e}")
                    attempt_duration = attempt_duration // 2
                    yield f"event: iris_retry\ndata: {json.dumps({'message': f'Retrying with {attempt_duration}s'})}\n\n"
            
            if not st:
                yield f"event: error\ndata: {json.dumps({'error': 'Failed to fetch from IRIS'})}\n\n"
                return
            
            # STEP 2: Detect gaps BEFORE merging
            yield f"event: gap_detection\ndata: {json.dumps({'message': 'Detecting gaps'})}\n\n"
            gaps = detect_gaps(st)
            yield f"event: gap_detection\ndata: {json.dumps({'gap_count': len(gaps)})}\n\n"
            app.logger.info(f"[Render V2] Found {len(gaps)} gaps")
            
            # STEP 3: Merge and deduplicate
            yield f"event: merge_start\ndata: {json.dumps({'message': 'Merging traces'})}\n\n"
            st.merge(method=1, fill_value='interpolate')
            trace = st[0]
            
            # STEP 4: Round to second boundaries
            yield f"event: rounding\ndata: {json.dumps({'message': 'Rounding to second boundaries'})}\n\n"
            trace = round_to_second_boundary(trace)
            
            # STEP 5: Convert to int32
            data_array = trace.data.astype(np.int32)
            sample_rate = float(trace.stats.sampling_rate)
            
            # STEP 6: Calculate global metadata
            yield f"event: metadata_start\ndata: {json.dumps({'message': 'Calculating metadata'})}\n\n"
            
            min_val = int(np.min(data_array))
            max_val = int(np.max(data_array))
            npts_val = int(trace.stats.npts)
            
            metadata = {
                'network': network,
                'station': station,
                'location': location,
                'channel': channel,
                'sample_rate': sample_rate,
                'starttime': str(trace.stats.starttime),
                'endtime': str(trace.stats.endtime),
                'npts': npts_val,
                'min': min_val,
                'max': max_val
            }
            
            # STEP 7: Send metadata_calculated event IMMEDIATELY
            app.logger.info(f"[Render V2] 📤 Sending metadata: min={min_val}, max={max_val}")
            yield f"event: metadata_calculated\ndata: {json.dumps(metadata)}\n\n"
            
            # STEP 8: Create chunks with progressive architecture (1min/6min/30min)
            dt = datetime.fromisoformat(starttime_str.replace('Z', '+00:00'))
            year = dt.year
            month = dt.month
            day = dt.day
            
            base_path = construct_r2_path(network, volcano, station, location, channel, year, month)
            compressor = zstd.ZstdCompressor(level=3)
            
            # Initialize or update metadata structure
            if existing_metadata:
                day_metadata = existing_metadata.copy()
            else:
                day_metadata = {
                    'date': dt.strftime('%Y-%m-%d'),
                    'network': network,
                    'volcano': volcano,
                    'station': station,
                    'location': location,
                    'channel': channel,
                    'sample_rate': sample_rate,
                    'created_at': datetime.utcnow().isoformat() + 'Z',
                    'complete_day': False,
                    'chunks': {
                        '10min': [],
                        '1h': [],
                        '6h': [],
                        '24h': []
                    }
                }
            
            # PROGRESSIVE CHUNKING: Small chunks first for fast playback start!
            samples_per_minute = int(sample_rate * 60)
            
            # PRIORITY 1: 6 × 1-minute chunks (minutes 0-6) - FASTEST START
            yield f"event: chunk_start\ndata: {json.dumps({'message': 'Creating 1-minute chunks (priority)'})}\n\n"
            
            for i in range(6):
                start_sample = i * samples_per_minute
                end_sample = min((i + 1) * samples_per_minute, len(data_array))
                
                if start_sample >= len(data_array):
                    break
                
                chunk_data = data_array[start_sample:end_sample]
                chunk_bytes = chunk_data.tobytes()
                compressed = compressor.compress(chunk_bytes)
                
                # Calculate chunk time range
                chunk_start_time = trace.stats.starttime + (i * 60)
                chunk_end_time = trace.stats.starttime + ((i + 1) * 60)
                
                # Construct self-describing filename
                chunk_filename = construct_chunk_filename(
                    network, station, location, channel, sample_rate,
                    chunk_start_time.datetime, chunk_end_time.datetime
                )
                
                r2_key = f"{base_path}/{chunk_filename}"
                
                # Upload to R2
                s3_client.put_object(
                    Bucket=R2_BUCKET_NAME,
                    Key=r2_key,
                    Body=compressed,
                    ContentType='application/zstd'
                )
                
                # Calculate chunk gap statistics
                gap_count, gap_duration, gap_samples = calculate_chunk_gap_stats(
                    chunk_start_time, chunk_end_time, gaps
                )
                
                # Determine if chunk is partial (less than expected samples)
                expected_samples = int(60 * sample_rate)  # 1 minute
                is_partial = len(chunk_data) < (expected_samples * 0.99)
                
                # Create chunk metadata
                chunk_meta = {
                    'start': chunk_start_time.strftime('%H:%M:%S'),
                    'end': chunk_end_time.strftime('%H:%M:%S'),
                    'min': int(np.min(chunk_data)),
                    'max': int(np.max(chunk_data)),
                    'samples': len(chunk_data),
                    'gap_count': gap_count,
                    'gap_duration_seconds': gap_duration,
                    'gap_samples_filled': gap_samples,
                    'partial': is_partial
                }
                
                # Add to 10min array (using for 1min chunks for now)
                day_metadata['chunks']['10min'].append(chunk_meta)
                
                # Generate presigned URL for browser
                chunk_url = s3_client.generate_presigned_url(
                    'get_object',
                    Params={'Bucket': R2_BUCKET_NAME, 'Key': r2_key},
                    ExpiresIn=3600
                )
                
                yield f"event: chunk_uploaded\ndata: {json.dumps({'type': '1min', 'index': i+1, 'total': 6, 'samples': len(chunk_data), 'compressed_size': len(compressed), 'url': chunk_url, 'key': r2_key, 'gap_count': gap_count, 'partial': is_partial})}\n\n"
                
                app.logger.info(f"[Render V2] ✅ Uploaded 1min chunk {i+1}/6: {len(chunk_data)} samples → {len(compressed)} bytes")
            
            # PRIORITY 2: 4 × 6-minute chunks (minutes 6-30)
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
                    
                    chunk_start_time = trace.stats.starttime + 360 + (i * 360)  # 6min = 360s
                    chunk_end_time = chunk_start_time + 360
                    
                    chunk_filename = construct_chunk_filename(
                        network, station, location, channel, sample_rate,
                        chunk_start_time.datetime, chunk_end_time.datetime
                    )
                    
                    r2_key = f"{base_path}/{chunk_filename}"
                    
                    s3_client.put_object(
                        Bucket=R2_BUCKET_NAME,
                        Key=r2_key,
                        Body=compressed,
                        ContentType='application/zstd'
                    )
                    
                    gap_count, gap_duration, gap_samples = calculate_chunk_gap_stats(
                        chunk_start_time, chunk_end_time, gaps
                    )
                    
                    expected_samples = int(360 * sample_rate)
                    is_partial = len(chunk_data) < (expected_samples * 0.99)
                    
                    chunk_meta = {
                        'start': chunk_start_time.strftime('%H:%M:%S'),
                        'end': chunk_end_time.strftime('%H:%M:%S'),
                        'min': int(np.min(chunk_data)),
                        'max': int(np.max(chunk_data)),
                        'samples': len(chunk_data),
                        'gap_count': gap_count,
                        'gap_duration_seconds': gap_duration,
                        'gap_samples_filled': gap_samples,
                        'partial': is_partial
                    }
                    
                    day_metadata['chunks']['10min'].append(chunk_meta)
                    
                    chunk_url = s3_client.generate_presigned_url(
                        'get_object',
                        Params={'Bucket': R2_BUCKET_NAME, 'Key': r2_key},
                        ExpiresIn=3600
                    )
                    
                    yield f"event: chunk_uploaded\ndata: {json.dumps({'type': '6min', 'index': i+1, 'total': 4, 'samples': len(chunk_data), 'compressed_size': len(compressed), 'url': chunk_url, 'key': r2_key, 'partial': is_partial})}\n\n"
                    
                    app.logger.info(f"[Render V2] ✅ Uploaded 6min chunk {i+1}/4: {len(chunk_data)} samples → {len(compressed)} bytes")
            
            # PRIORITY 3: 1 × 30-minute chunk (remaining)
            if len(data_array) > 30 * samples_per_minute:
                yield f"event: chunk_start\ndata: {json.dumps({'message': 'Creating 30-minute chunk'})}\n\n"
                
                offset = 30 * samples_per_minute
                chunk_data = data_array[offset:]
                chunk_bytes = chunk_data.tobytes()
                compressed = compressor.compress(chunk_bytes)
                
                chunk_start_time = trace.stats.starttime + 1800  # 30min = 1800s
                chunk_end_time = trace.stats.endtime
                
                chunk_filename = construct_chunk_filename(
                    network, station, location, channel, sample_rate,
                    chunk_start_time.datetime, chunk_end_time.datetime
                )
                
                r2_key = f"{base_path}/{chunk_filename}"
                
                s3_client.put_object(
                    Bucket=R2_BUCKET_NAME,
                    Key=r2_key,
                    Body=compressed,
                    ContentType='application/zstd'
                )
                
                gap_count, gap_duration, gap_samples = calculate_chunk_gap_stats(
                    chunk_start_time, chunk_end_time, gaps
                )
                
                expected_samples = int((chunk_end_time - chunk_start_time) * sample_rate)
                is_partial = len(chunk_data) < (expected_samples * 0.99)
                
                chunk_meta = {
                    'start': chunk_start_time.strftime('%H:%M:%S'),
                    'end': chunk_end_time.strftime('%H:%M:%S'),
                    'min': int(np.min(chunk_data)),
                    'max': int(np.max(chunk_data)),
                    'samples': len(chunk_data),
                    'gap_count': gap_count,
                    'gap_duration_seconds': gap_duration,
                    'gap_samples_filled': gap_samples,
                    'partial': is_partial
                }
                
                day_metadata['chunks']['10min'].append(chunk_meta)
                
                chunk_url = s3_client.generate_presigned_url(
                    'get_object',
                    Params={'Bucket': R2_BUCKET_NAME, 'Key': r2_key},
                    ExpiresIn=3600
                )
                
                yield f"event: chunk_uploaded\ndata: {json.dumps({'type': '30min', 'index': 1, 'total': 1, 'samples': len(chunk_data), 'compressed_size': len(compressed), 'url': chunk_url, 'key': r2_key, 'partial': is_partial})}\n\n"
                
                app.logger.info(f"[Render V2] ✅ Uploaded 30min chunk: {len(chunk_data)} samples → {len(compressed)} bytes")
            
            # CRITICAL: Sort chunks chronologically and remove duplicates
            yield f"event: metadata_cleanup\ndata: {json.dumps({'message': 'Sorting and deduplicating chunks'})}\n\n"
            
            for chunk_size in ['10min', '1h', '6h', '24h']:
                if chunk_size in day_metadata['chunks']:
                    chunks_array = day_metadata['chunks'][chunk_size]
                    
                    # Sort by start time (chronological order)
                    chunks_array.sort(key=lambda c: c['start'])
                    
                    # Remove duplicates (same start time = duplicate)
                    seen_starts = set()
                    deduplicated = []
                    for chunk in chunks_array:
                        if chunk['start'] not in seen_starts:
                            deduplicated.append(chunk)
                            seen_starts.add(chunk['start'])
                    
                    # Replace with clean, sorted, deduplicated array
                    day_metadata['chunks'][chunk_size] = deduplicated
            
            app.logger.info(f"[Render V2] 📋 Final chunk count: {len(day_metadata['chunks']['10min'])} (sorted & deduplicated)")
            
            # Check if day is complete (all 24 hours)
            # For now, just set to false since we're not tracking full days yet
            day_metadata['complete_day'] = False
            
            # Upload updated metadata (COMPLETE REWRITE)
            metadata_filename = construct_metadata_filename(
                network, station, location, channel, sample_rate, dt.strftime('%Y-%m-%d')
            )
            metadata_key = f"{base_path}/{metadata_filename}"
            
            s3_client.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=metadata_key,
                Body=json.dumps(day_metadata, indent=2),
                ContentType='application/json'
            )
            
            yield f"event: metadata_uploaded\ndata: {json.dumps({'key': metadata_key, 'complete_day': day_metadata['complete_day']})}\n\n"
            
            app.logger.info(f"[Render V2] ✅ Uploaded metadata: {metadata_key}")
            
            # Event: Complete
            yield f"event: complete\ndata: {json.dumps({'chunks': len(day_metadata['chunks']['10min']), 'metadata_key': metadata_key, 'gaps_detected': len(gaps)})}\n\n"
            
        except Exception as e:
            app.logger.error(f"[Render V2] Pipeline error: {e}", exc_info=True)
            yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
    
    return Response(stream_with_context(generate()), mimetype='text/event-stream', headers={
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*'
    })


# Load volcano configurations at startup
VOLCANOES = load_volcano_stations()
print(f"\n🌋 Loaded {len(VOLCANOES)} volcano configurations")


@app.route('/')
def home():
    return "Volcano Audio API V2 - Metadata-Aware Backend"


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


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5002))
    print(f"\n🚀 Starting Volcano Audio Backend V2 on port {port}")
    print(f"📡 Endpoint: /api/request-stream-v2")
    print(f"🌋 Loaded {len(VOLCANOES)} volcano configurations\n")
    app.run(host='0.0.0.0', port=port, debug=True)

