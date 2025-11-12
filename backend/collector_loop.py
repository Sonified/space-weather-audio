#!/usr/bin/env python3
"""
Seismic Data Collector Service for Railway Deployment
Runs data collection every 10 minutes at :02, :12, :22, :32, :42, :52
Provides HTTP API for health monitoring, status, validation, and gap detection
"""
__version__ = "2025_11_12_v1.81"
import time
import sys
import os
import json
import threading
import boto3
from datetime import datetime, timezone
from flask import Flask, jsonify
from flask_cors import CORS
from pathlib import Path

# Simple Flask app for health/status endpoint
app = Flask(__name__)
CORS(app)  # Enable CORS for all routes

# Register audio streaming blueprint (for on-demand IRIS streaming when data not in R2)
from audio_stream import audio_stream_bp
app.register_blueprint(audio_stream_bp)

# Detect deployment environment
# Railway sets RAILWAY_ENVIRONMENT, local dev won't have this
IS_PRODUCTION = os.getenv('RAILWAY_ENVIRONMENT') is not None
DEPLOYMENT_ENV = "PRODUCTION (Railway)" if IS_PRODUCTION else "LOCAL (Development)"

# Schedule offset: Production runs at :02, :12, :22, etc.
#                  Local runs at :03, :13, :23, etc. (1 minute offset to avoid conflicts)
SCHEDULE_OFFSET_MINUTES = 0 if IS_PRODUCTION else 1

# Get or update deployment time (always update to current time on startup)
deploy_time_file = Path(__file__).parent / '.deploy_time'
deploy_time = datetime.now(timezone.utc).isoformat()
with open(deploy_time_file, 'w') as f:
    f.write(deploy_time)

# R2 Configuration for failure logs
R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID', '66f906f29f28b08ae9c80d4f36e25c7a')
R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '9e1cf6c395172f108c2150c52878859f')
R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec')
R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')
FAILURE_LOG_KEY = 'collector_logs/failures.json'
STATION_ACTIVATION_LOG_KEY = 'collector_logs/station_activations.json'

def get_s3_client():
    """Get S3 client for R2"""
    return boto3.client(
        's3',
        endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name='auto'
    )

def convert_to_local_time(utc_timestamp_str, target_timezone=None):
    """
    Convert UTC timestamp string to local/target time string.
    
    Args:
        utc_timestamp_str: UTC timestamp string
        target_timezone: Optional timezone name (e.g. 'America/Los_Angeles', 'US/Pacific', 'UTC')
                        If None, returns UTC
    
    Returns formatted string like '2025-11-05 10:32:01 PST' (with timezone name)
    """
    if not utc_timestamp_str:
        return None
    
    try:
        from datetime import datetime
        import pytz
        
        # Parse UTC timestamp
        if utc_timestamp_str.endswith('Z'):
            utc_timestamp_str = utc_timestamp_str[:-1] + '+00:00'
        
        utc_dt = datetime.fromisoformat(utc_timestamp_str)
        
        # If no target timezone specified, return UTC
        if not target_timezone:
            return f"{utc_dt.strftime('%Y-%m-%d %H:%M:%S')} UTC"
        
        # Convert to target timezone
        try:
            tz = pytz.timezone(target_timezone)
            local_dt = utc_dt.astimezone(tz)
            
            # Get timezone abbreviation (PST, EST, etc.)
            tz_name = local_dt.strftime('%Z')
            
            # Format: YYYY-MM-DD HH:MM:SS TZ
            return f"{local_dt.strftime('%Y-%m-%d %H:%M:%S')} {tz_name}"
        except pytz.exceptions.UnknownTimeZoneError:
            # Invalid timezone - return UTC with note
            return f"{utc_dt.strftime('%Y-%m-%d %H:%M:%S')} UTC (invalid timezone: {target_timezone})"
    except Exception as e:
        # If conversion fails, return original
        return utc_timestamp_str

def extract_error_summary(error_msg):
    """
    Extract a concise error summary from a full error message.
    Returns a short description (max 100 chars) suitable for status display.
    """
    if not error_msg:
        return "Unknown error"
    
    # Try to extract the key error information
    error_lower = error_msg.lower()
    
    # Check for common patterns
    if "modulenotfounderror" in error_lower or "no module named" in error_lower:
        # Extract module name
        if "no module named" in error_lower:
            module_match = error_msg.split("No module named")[-1].strip().split()[0].strip("'\"")
            return f"Missing module: {module_match}"
        return "Missing Python module"
    
    if "import" in error_lower and "error" in error_lower:
        return "Import error"
    
    if "exit code" in error_lower:
        # Extract exit code
        parts = error_msg.split("Exit code")
        if len(parts) > 1:
            exit_code = parts[1].split()[0] if parts[1].strip() else "unknown"
            return f"Process failed (exit code {exit_code})"
        return "Process failed"
    
    if "exception:" in error_lower:
        # Extract exception type
        parts = error_msg.split("Exception:")
        if len(parts) > 1:
            exc_msg = parts[1].strip().split('\n')[0][:80]
            return f"Exception: {exc_msg}"
        return "Exception occurred"
    
    # Fallback: return first line or first 100 chars
    first_line = error_msg.split('\n')[0]
    if len(first_line) > 100:
        return first_line[:97] + "..."
    return first_line

def load_failures():
    """Load failures from R2 and convert to summaries for display"""
    try:
        import json
        s3 = get_s3_client()
        response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=FAILURE_LOG_KEY)
        failures = json.loads(response['Body'].read())
        # Get last 10 failures
        recent = failures[-10:] if len(failures) > 10 else failures
        # Convert to summaries for status display
        summaries = []
        for failure in recent:
            error_msg = failure.get('error', 'Unknown error')
            summary = {
                'timestamp': failure.get('timestamp'),
                'summary': extract_error_summary(error_msg),
                'exit_code': failure.get('exit_code'),
                'type': failure.get('type', 'unknown'),
                'log_location': f'R2: {FAILURE_LOG_KEY}'
            }
            summaries.append(summary)
        return summaries
    except Exception as e:
        # Check if it's a NoSuchKey exception (file doesn't exist yet)
        error_code = getattr(e, 'response', {}).get('Error', {}).get('Code', '')
        if error_code == 'NoSuchKey':
            return []
        # Otherwise print warning and return empty list
        print(f"Warning: Could not load failure log from R2: {e}")
        return []

def save_failure(failure_info):
    """Append failure to R2 log (keeps all failures forever)"""
    try:
        import json
        s3 = get_s3_client()
        
        # Load existing failures
        try:
            response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=FAILURE_LOG_KEY)
            failures = json.loads(response['Body'].read())
        except Exception as load_error:
            # Check if it's a NoSuchKey exception (file doesn't exist yet)
            error_code = getattr(load_error, 'response', {}).get('Error', {}).get('Code', '')
            if error_code == 'NoSuchKey':
                failures = []
            else:
                raise  # Re-raise if it's not a NoSuchKey error
        
        # Append new failure (no limit - storage is cheap!)
        failures.append(failure_info)
        
        # Save back to R2
        s3.put_object(
            Bucket=R2_BUCKET_NAME,
            Key=FAILURE_LOG_KEY,
            Body=json.dumps(failures, indent=2),
            ContentType='application/json'
        )
    except Exception as e:
        print(f"Warning: Could not save failure log to R2: {e}")

def load_station_activations():
    """
    Load station activation log from R2.
    
    Returns:
        dict: {
            'stations': {
                'NETWORK_STATION_LOCATION_CHANNEL': {
                    'network': 'HV',
                    'station': 'OBL',
                    'location': '--',
                    'channel': 'HHZ',
                    'activated_at': '2025-10-01T00:00:00Z',
                    'deactivated_at': None or '2025-11-05T12:00:00Z'
                },
                ...
            },
            'changes': [
                {
                    'timestamp': '2025-11-05T12:00:00Z',
                    'type': 'activated' or 'deactivated',
                    'station_key': 'HV_OBL_--_HHZ',
                    'station_info': {...}
                },
                ...
            ]
        }
    """
    try:
        s3 = get_s3_client()
        response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=STATION_ACTIVATION_LOG_KEY)
        return json.loads(response['Body'].read())
    except s3.exceptions.NoSuchKey:
        # File doesn't exist yet - return empty structure
        return {
            'stations': {},
            'changes': []
        }
    except Exception as e:
        # Check if it's a NoSuchKey exception (boto3 uses ClientError)
        error_code = getattr(e, 'response', {}).get('Error', {}).get('Code', '')
        if error_code == 'NoSuchKey':
            return {
                'stations': {},
                'changes': []
            }
        print(f"Warning: Could not load station activation log from R2: {e}")
        return {
            'stations': {},
            'changes': []
        }

def save_station_activations(activation_log):
    """Save station activation log to R2"""
    try:
        s3 = get_s3_client()
        s3.put_object(
            Bucket=R2_BUCKET_NAME,
            Key=STATION_ACTIVATION_LOG_KEY,
            Body=json.dumps(activation_log, indent=2),
            ContentType='application/json'
        )
    except Exception as e:
        print(f"Warning: Could not save station activation log to R2: {e}")

def find_station_first_file_timestamp(s3_client, network, station, location, channel):
    """
    Find the timestamp of the first file collected for a station by reading metadata files.
    This is much faster and more accurate than scanning binary files.
    
    Returns:
        datetime: First file timestamp, or None if no files found
    """
    try:
        location_str = location if location and location != '--' else '--'
        
        # Find sample_rate for this station (needed for metadata filename)
        active_stations = get_active_stations_list()
        sample_rate = None
        for s in active_stations:
            if (s['network'] == network and s['station'] == station and 
                s.get('location', '--') in [location, location_str] and s['channel'] == channel):
                sample_rate = s['sample_rate']
                break
        
        if not sample_rate:
            print(f"Warning: Could not find sample_rate for {network}.{station}.{location_str}.{channel}")
            return None
        
        rate_str = f"{sample_rate:.2f}".rstrip('0').rstrip('.') if '.' in str(sample_rate) else str(int(sample_rate))
        
        # Find volcano for this station (needed for path)
        volcano = None
        for s in active_stations:
            if (s['network'] == network and s['station'] == station):
                volcano = s.get('volcano')
                break
        
        if not volcano:
            print(f"Warning: Could not find volcano for {network}.{station}")
            return None
        
        # List all metadata files for this station
        # Path format: data/{YEAR}/{MONTH}/{NETWORK}/{VOLCANO}/{STATION}/{LOCATION}/{CHANNEL}/
        # Metadata format: {NETWORK}_{STATION}_{LOCATION}_{CHANNEL}_{RATE}Hz_{DATE}.json
        prefix = f"data/"
        paginator = s3_client.get_paginator('list_objects_v2')
        pages = paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix=prefix)
        
        earliest_timestamp = None
        
        for page in pages:
            if 'Contents' not in page:
                continue
            
            for obj in page['Contents']:
                key = obj['Key']
                
                # Check if this is a metadata file for our station
                if not key.endswith('.json'):
                    continue
                
                # Path format: data/YYYY/MM/NETWORK/VOLCANO/STATION/LOCATION/CHANNEL/filename.json
                path_parts = key.split('/')
                if len(path_parts) < 9:
                    continue
                
                file_network = path_parts[3]
                file_volcano = path_parts[4]
                file_station = path_parts[5]
                file_location = path_parts[6]
                file_channel = path_parts[7]
                filename = path_parts[8]
                
                # Check if this metadata file matches our station
                if (file_network == network and file_station == station and 
                    file_location == location_str and file_channel == channel and
                    file_volcano == volcano):
                    
                    # Read the metadata file
                    try:
                        response = s3_client.get_object(Bucket=R2_BUCKET_NAME, Key=key)
                        metadata = json.loads(response['Body'].read().decode('utf-8'))
                        
                        # Extract date from metadata
                        date_str = metadata.get('date')  # Format: YYYY-MM-DD
                        if not date_str:
                            continue
                        
                        # Find earliest chunk start time from all chunk types
                        for chunk_type in ['10m', '1h', '6h']:
                            chunks = metadata.get('chunks', {}).get(chunk_type, [])
                            for chunk in chunks:
                                start_time_str = chunk.get('start')  # Format: HH:MM:SS
                                if start_time_str:
                                    # Combine date and time
                                    timestamp_str = f"{date_str}T{start_time_str}"
                                    chunk_timestamp = datetime.fromisoformat(timestamp_str).replace(tzinfo=timezone.utc)
                                    
                                    if earliest_timestamp is None or chunk_timestamp < earliest_timestamp:
                                        earliest_timestamp = chunk_timestamp
                    
                    except Exception as e:
                        # Skip this metadata file if there's an error reading it
                        continue
        
        return earliest_timestamp
    except Exception as e:
        print(f"Warning: Error finding first file timestamp for {network}.{station}: {e}")
        import traceback
        traceback.print_exc()
        return None

def process_station_window(network, station, location, channel, volcano, sample_rate,
                           start_time, end_time, chunk_type):
    """
    Fetch and process data for one station and one time window.
    Returns (status, error_info) tuple.
    status: 'success', 'skipped', or 'failed'
    error_info is dict with 'step', 'station', 'error' on failure, None otherwise.
    
    CRITICAL: Calculates min/max from the actual data array for each chunk type.
    """
    from obspy import UTCDateTime
    from obspy.clients.fdsn import Client
    import numpy as np
    import zstandard as zstd
    
    station_id = f"{network}.{station}.{location}.{channel}"
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] [{volcano}] {station_id} - {chunk_type} {start_time} to {end_time}")
    
    try:
        # Step 0: Check if this chunk already exists in metadata (skip if so)
        s3 = get_s3_client()
        year = start_time.year
        month = f"{start_time.month:02d}"
        day = f"{start_time.day:02d}"
        date_str = start_time.strftime("%Y-%m-%d")
        location_str = location if location and location != '--' else '--'
        rate_str = f"{sample_rate:.2f}".rstrip('0').rstrip('.') if '.' in str(sample_rate) else str(int(sample_rate))
        
        # NEW format (without sample rate in filename)
        metadata_filename = f"{network}_{station}_{location_str}_{channel}_{date_str}.json"
        metadata_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/{metadata_filename}"
        
        # Try to load existing metadata (try NEW format first, fallback to OLD format)
        metadata = None
        
        if IS_PRODUCTION:
            # Production: Load from R2
            try:
                response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
                metadata = json.loads(response['Body'].read().decode('utf-8'))
                print(f"  📖 Loaded existing metadata (NEW format)")
            except s3.exceptions.NoSuchKey:
                # Try OLD format (with sample rate)
                old_metadata_filename = f"{network}_{station}_{location_str}_{channel}_{rate_str}Hz_{date_str}.json"
                old_metadata_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/{old_metadata_filename}"
                try:
                    response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=old_metadata_key)
                    metadata = json.loads(response['Body'].read().decode('utf-8'))
                    print(f"  📖 Loaded existing metadata (OLD format) - will migrate to NEW format on save")
                except s3.exceptions.NoSuchKey:
                    pass  # No existing metadata, will create new
        else:
            # Local: Load from filesystem
            metadata_dir = Path(__file__).parent / 'cron_output' / 'data' / str(year) / month / day / network / volcano / station / location_str / channel
            metadata_path = metadata_dir / metadata_filename
            
            if metadata_path.exists():
                with open(metadata_path, 'r') as f:
                    metadata = json.load(f)
                print(f"  📖 Loaded existing metadata (NEW format)")
            else:
                # Try OLD format (with sample rate)
                old_metadata_filename = f"{network}_{station}_{location_str}_{channel}_{rate_str}Hz_{date_str}.json"
                old_metadata_path = metadata_dir / old_metadata_filename
                if old_metadata_path.exists():
                    with open(old_metadata_path, 'r') as f:
                        metadata = json.load(f)
                    print(f"  📖 Loaded existing metadata (OLD format) - will migrate to NEW format on save")
        
        if metadata:
            # Check if this time window already exists
            start_time_str = start_time.strftime("%H:%M:%S")
            existing_chunks = metadata['chunks'].get(chunk_type, [])
            for chunk in existing_chunks:
                if chunk['start'] == start_time_str:
                    print(f"  ⏭️  Chunk already exists, skipping")
                    return 'skipped', None
            print(f"  📖 Loaded existing metadata ({len(metadata['chunks']['10m'])} 10m, {len(metadata['chunks'].get('1h', []))} 1h, {len(metadata['chunks']['6h'])} 6h)")
        else:
            # No existing metadata, will create new
            print(f"  📝 Creating new metadata")
        
        # Step 1: Fetch from IRIS
        client = Client("IRIS")
        st = client.get_waveforms(
            network=network,
            station=station,
            location=location if location != '--' else '',
            channel=channel,
            starttime=UTCDateTime(start_time),
            endtime=UTCDateTime(end_time)
        )
        
        if not st or len(st) == 0:
            error_info = {
                'step': 'IRIS_FETCH',
                'station': station_id,
                'chunk_type': chunk_type,
                'error': 'No data returned from IRIS'
            }
            print(f"  ❌ No data returned from IRIS")
            return 'failed', error_info
        
        print(f"  ✅ Got {len(st)} trace(s)")
        
        # Step 2: Detect gaps and merge
        gaps = []
        gap_list = st.get_gaps()
        for gap in gap_list:
            gap_start = UTCDateTime(gap[4])
            gap_end = UTCDateTime(gap[5])
            duration = gap_end - gap_start
            samples_filled = int(round(duration * sample_rate))
            gaps.append({
                'start': gap_start.isoformat(),
                'end': gap_end.isoformat(),
                'samples_filled': samples_filled
            })
        
        if gaps:
            print(f"  ⚠️  {len(gaps)} gaps detected")
        
        st.merge(method=1, fill_value='interpolate', interpolation_samples=0)
        trace = st[0]
        
        # Step 3: Ensure exact sample count based on requested window (no rounding!)
        # We requested [start_time, end_time], so we MUST output exactly that many samples
        requested_duration = end_time - start_time
        expected_samples = int(requested_duration.total_seconds() * sample_rate)
        actual_samples = len(trace.data)
        
        if actual_samples < expected_samples:
            # Pad: Hold last sample value to fill to expected length
            missing = expected_samples - actual_samples
            last_value = trace.data[-1]
            padding = np.full(missing, last_value, dtype=trace.data.dtype)
            data = np.concatenate([trace.data, padding])
            print(f"  ⚠️  Padded {missing} samples (IRIS returned {actual_samples:,}, expected {expected_samples:,})")
        elif actual_samples > expected_samples:
            # Truncate: Remove extra samples (shouldn't happen but safeguard)
            extra = actual_samples - expected_samples
            data = trace.data[:expected_samples]
            print(f"  ⚠️  Truncated {extra} extra samples (IRIS returned {actual_samples:,}, expected {expected_samples:,})")
        else:
            # Perfect!
            data = trace.data
            print(f"  ✅ Perfect sample count: {actual_samples:,}")
        
        data_int32 = data.astype(np.int32)
        
        # CRITICAL FIX: Calculate min/max from the ACTUAL chunk data array
        # This ensures each chunk (10m, 1h, 6h) has accurate min/max for its time window
        min_val = int(np.min(data_int32))
        max_val = int(np.max(data_int32))
        
        print(f"  ✅ Processed {len(data_int32):,} samples, min/max={min_val}/{max_val}")
        
        # Step 4: Compress
        compressor = zstd.ZstdCompressor(level=3)
        compressed = compressor.compress(data_int32.tobytes())
        
        compression_ratio = len(compressed) / len(data_int32.tobytes()) * 100
        print(f"  ✅ Compressed {compression_ratio:.1f}% (saved {100-compression_ratio:.1f}%)")
        
        # Generate filename (NEW format: no sample rate)
        # Use requested start_time/end_time instead of trace.stats times to handle midnight crossing correctly
        # trace.stats.endtime might be slightly off (e.g., 23:59:59.999 instead of 00:00:00)
        start_str = start_time.strftime("%Y-%m-%d-%H-%M-%S")
        end_str = end_time.strftime("%Y-%m-%d-%H-%M-%S")
        
        filename = f"{network}_{station}_{location_str}_{channel}_{chunk_type}_{start_str}_to_{end_str}.bin.zst"
        
        # Step 5: Upload to R2
        r2_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/{chunk_type}/{filename}"
        
        # CRITICAL: Load metadata FIRST to check for duplicates BEFORE uploading binary
        # This second load ensures we have the latest state in case another process added chunks
        # (metadata is loaded at start of function, but other processes may have modified it)
        metadata = None
        
        if IS_PRODUCTION:
            # Production: Load from R2
            try:
                response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
                metadata = json.loads(response['Body'].read().decode('utf-8'))
            except s3.exceptions.NoSuchKey:
                # Try OLD format (with sample rate)
                old_metadata_filename = f"{network}_{station}_{location_str}_{channel}_{rate_str}Hz_{date_str}.json"
                old_metadata_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/{old_metadata_filename}"
                try:
                    response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=old_metadata_key)
                    metadata = json.loads(response['Body'].read().decode('utf-8'))
                    print(f"  📖 Re-loaded metadata (OLD format) - will migrate to NEW format on save")
                except s3.exceptions.NoSuchKey:
                    pass  # Will create new below
        else:
            # Local: Load from filesystem
            metadata_dir = Path(__file__).parent / 'cron_output' / 'data' / str(year) / month / day / network / volcano / station / location_str / channel
            metadata_path = metadata_dir / metadata_filename
            
            if metadata_path.exists():
                with open(metadata_path, 'r') as f:
                    metadata = json.load(f)
            else:
                # Try OLD format (with sample rate)
                old_metadata_filename = f"{network}_{station}_{location_str}_{channel}_{rate_str}Hz_{date_str}.json"
                old_metadata_path = metadata_dir / old_metadata_filename
                if old_metadata_path.exists():
                    with open(old_metadata_path, 'r') as f:
                        metadata = json.load(f)
                    print(f"  📖 Re-loaded metadata (OLD format) - will migrate to NEW format on save")
        
        if not metadata:
            # Create new metadata
            metadata = {
                'date': date_str,
                'network': network,
                'volcano': volcano,
                'station': station,
                'location': location if location != '--' else '',
                'channel': channel,
                'sample_rate': sample_rate,
                'created_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                'complete_day': False,
                'chunks': {
                    '10m': [],
                    '1h': [],
                    '6h': []
                }
            }
            print(f"  📝 Creating new metadata")
        
        # Build chunk metadata with ACTUAL min/max from this chunk's data
        chunk_meta = {
            'start': trace.stats.starttime.datetime.strftime("%H:%M:%S"),
            'end': trace.stats.endtime.datetime.strftime("%H:%M:%S"),
            'min': min_val,  # From THIS chunk's data array
            'max': max_val,  # From THIS chunk's data array
            'samples': len(data_int32),
            'gap_count': len(gaps),
            'gap_samples_filled': sum(g['samples_filled'] for g in gaps)
        }
        
        # CRITICAL: Check for duplicates BEFORE uploading binary file
        start_time_str = chunk_meta['start']
        existing_chunks = metadata['chunks'].get(chunk_type, [])
        for existing_chunk in existing_chunks:
            if existing_chunk['start'] == start_time_str:
                print(f"  ⏭️  Chunk already exists in metadata (race condition detected), skipping upload")
                return 'skipped', None
        
        # Safe to upload binary now (duplicate check passed)
        if IS_PRODUCTION:
            # Production: Save to R2
            s3.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=r2_key,
                Body=compressed,
                ContentType='application/octet-stream'
            )
            print(f"  💾 Uploaded to R2: {r2_key}")
        else:
            # Local: Save to filesystem
            base_dir = Path(__file__).parent / 'cron_output'
            chunk_dir = base_dir / 'data' / str(year) / month / day / network / volcano / station / location_str / channel / chunk_type
            chunk_dir.mkdir(parents=True, exist_ok=True)
            
            chunk_path = chunk_dir / filename
            with open(chunk_path, 'wb') as f:
                f.write(compressed)
            print(f"  💾 Saved locally: {chunk_path}")
        
        # Safe to append now
        metadata['chunks'][chunk_type].append(chunk_meta)
        
        # SORT by start time (chronological)
        metadata['chunks']['10m'].sort(key=lambda c: c['start'])
        metadata['chunks']['1h'].sort(key=lambda c: c['start'])
        metadata['chunks']['6h'].sort(key=lambda c: c['start'])
        
        # Update complete_day flag
        if len(metadata['chunks']['10m']) >= 144:
            metadata['complete_day'] = True
        
        # Upload updated metadata
        if IS_PRODUCTION:
            # Production: Save to R2
            s3.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=metadata_key,
                Body=json.dumps(metadata, indent=2).encode('utf-8'),
                ContentType='application/json'
            )
            print(f"  💾 Updated metadata: {len(metadata['chunks']['10m'])} 10m, {len(metadata['chunks'].get('1h', []))} 1h, {len(metadata['chunks']['6h'])} 6h (sorted)")
        else:
            # Local: Save to filesystem
            metadata_dir = Path(__file__).parent / 'cron_output' / 'data' / str(year) / month / day / network / volcano / station / location_str / channel
            metadata_dir.mkdir(parents=True, exist_ok=True)
            
            metadata_path = metadata_dir / metadata_filename
            with open(metadata_path, 'w') as f:
                json.dump(metadata, f, indent=2)
            print(f"  💾 Updated metadata locally: {len(metadata['chunks']['10m'])} 10m, {len(metadata['chunks'].get('1h', []))} 1h, {len(metadata['chunks']['6h'])} 6h (sorted)")
        
        return 'success', None
        
    except Exception as e:
        error_info = {
            'step': 'UNKNOWN',
            'station': station_id,
            'chunk_type': chunk_type,
            'error': str(e)
        }
        print(f"  ❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return 'failed', error_info


def detect_and_log_station_changes():
    """
    Detect changes in active stations and update activation log.
    Called periodically to track when stations are added/removed.
    
    Returns:
        dict: {
            'new_stations': [...],
            'removed_stations': [...],
            'log_updated': bool
        }
    """
    try:
        s3 = get_s3_client()
        activation_log = load_station_activations()
        current_stations = get_active_stations_list()
        
        # If log hasn't been initialized yet (empty), skip detection to avoid expensive scans
        # Auto-init endpoint should be called first to populate the log
        if len(activation_log.get('stations', {})) == 0:
            return {
                'new_stations': [],
                'reactivated_stations': [],
                'removed_stations': [],
                'log_updated': False,
                'skipped': 'Log not initialized - run /auto-init-station-activations first'
            }
        
        # Build set of current station keys
        current_keys = set()
        for station_config in current_stations:
            network = station_config['network']
            station = station_config['station']
            location = station_config.get('location', '')
            channel = station_config['channel']
            location_str = location if location and location != '--' else '--'
            station_key = f"{network}_{station}_{location_str}_{channel}"
            current_keys.add(station_key)
        
        # Build set of logged station keys (only active ones)
        logged_active_keys = set()
        all_logged_keys = set()
        for station_key, station_info in activation_log.get('stations', {}).items():
            all_logged_keys.add(station_key)
            if station_info.get('deactivated_at') is None:
                logged_active_keys.add(station_key)
        
        # Find new stations (in current but not in log, or deactivated but now active again)
        new_stations = []
        reactivated_stations = []
        now = datetime.now(timezone.utc).isoformat()
        
        for station_config in current_stations:
            network = station_config['network']
            station = station_config['station']
            location = station_config.get('location', '')
            channel = station_config['channel']
            location_str = location if location and location != '--' else '--'
            station_key = f"{network}_{station}_{location_str}_{channel}"
            
            if station_key not in logged_active_keys:
                # Check if this station was previously deactivated (reactivation)
                was_deactivated = False
                if station_key in all_logged_keys:
                    old_info = activation_log['stations'][station_key]
                    if old_info.get('deactivated_at'):
                        was_deactivated = True
                        # Reactivate - use original activation time
                        activated_at = old_info.get('activated_at', now)
                        station_info = {
                            'network': network,
                            'station': station,
                            'location': location_str,
                            'channel': channel,
                            'volcano': station_config.get('volcano'),
                            'sample_rate': station_config.get('sample_rate'),
                            'activated_at': activated_at,
                            'deactivated_at': None
                        }
                        activation_log['stations'][station_key] = station_info
                        activation_log['changes'].append({
                            'timestamp': now,
                            'type': 'reactivated',
                            'station_key': station_key,
                            'station_info': station_info.copy()
                        })
                        reactivated_stations.append(station_info)
                        print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 🔄 Station reactivated: {station_key}")
                        continue
                
                # New station - find its first file timestamp
                # (We only get here if log has been initialized, thanks to early return above)
                first_file_time = find_station_first_file_timestamp(s3, network, station, location, channel)
                
                # Use first file time if found, otherwise use now (just activated)
                activated_at = first_file_time.isoformat() if first_file_time else now
                
                station_info = {
                    'network': network,
                    'station': station,
                    'location': location_str,
                    'channel': channel,
                    'volcano': station_config.get('volcano'),
                    'sample_rate': station_config.get('sample_rate'),
                    'activated_at': activated_at,
                    'deactivated_at': None
                }
                
                activation_log['stations'][station_key] = station_info
                activation_log['changes'].append({
                    'timestamp': now,
                    'type': 'activated',
                    'station_key': station_key,
                    'station_info': station_info.copy()
                })
                
                new_stations.append(station_info)
                print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 📍 New station activated: {station_key} (first file: {activated_at})")
        
        # Find removed stations (in log but not in current)
        removed_stations = []
        for station_key in logged_active_keys:
            if station_key not in current_keys:
                # Station was deactivated
                station_info = activation_log['stations'][station_key]
                station_info['deactivated_at'] = now
                
                activation_log['changes'].append({
                    'timestamp': now,
                    'type': 'deactivated',
                    'station_key': station_key,
                    'station_info': station_info.copy()
                })
                
                removed_stations.append(station_info)
                print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 🚫 Station deactivated: {station_key}")
        
        # Save updated log if there were changes
        if new_stations or reactivated_stations or removed_stations:
            save_station_activations(activation_log)
            return {
                'new_stations': new_stations,
                'reactivated_stations': reactivated_stations,
                'removed_stations': removed_stations,
                'log_updated': True
            }
        
        return {
            'new_stations': [],
            'reactivated_stations': [],
            'removed_stations': [],
            'log_updated': False
        }
    except Exception as e:
        print(f"Warning: Error detecting station changes: {e}")
        import traceback
        traceback.print_exc()
        return {
            'new_stations': [],
            'reactivated_stations': [],
            'removed_stations': [],
            'log_updated': False
        }

# Load previous failures on startup
previous_failures = load_failures()

# Shared state
status = {
    'version': __version__,
    'deployed_at': deploy_time,
    'started_at': datetime.now(timezone.utc).isoformat(),
    'last_run_started': None,  # When current/last collection started
    'last_run_completed': None,  # When last collection finished
    'last_run_duration_seconds': None,  # How long last collection took
    'next_run': None,
    'total_runs': 0,
    'successful_runs': 0,
    'failed_runs': 0,
    'currently_running': False,
    'last_failure': previous_failures[-1] if previous_failures else None,
    'recent_failures': previous_failures  # Last 10 from disk
}

def get_dates_in_period(start_time, end_time):
    """
    Helper: Generate all dates between start_time and end_time (inclusive)
    Returns list of date objects
    Handles month/year boundaries naturally
    """
    from datetime import timedelta
    dates = []
    current = start_time.date()
    end = end_time.date()
    while current <= end:
        dates.append(current)
        current += timedelta(days=1)
    return dates


# ============================================================================
# Reusable Helper Functions for Gaps/Backfill System
# ============================================================================

def parse_period(period):
    """
    Parse period string to hours.
    
    Args:
        period: String like '24h', '2d', '1h', or just '24'
    
    Returns:
        int: Number of hours
    
    Raises:
        ValueError: If invalid format
    
    Examples:
        parse_period('24h') -> 24
        parse_period('2d') -> 48
        parse_period('1h') -> 1
    """
    if period.endswith('d'):
        return int(period[:-1]) * 24
    elif period.endswith('h'):
        return int(period[:-1])
    else:
        return int(period)


def get_active_stations_list():
    """
    Load active stations from stations_config.json.
    
    Returns:
        list: List of dicts with keys: network, volcano, station, location, channel, sample_rate
    
    Examples:
        [
            {
                'network': 'HV',
                'volcano': 'kilauea',
                'station': 'OBL',
                'location': '',
                'channel': 'HHZ',
                'sample_rate': 100.0
            },
            ...
        ]
    """
    config_path = Path(__file__).parent / 'stations_config.json'
    with open(config_path) as f:
        config = json.load(f)
    
    active_stations = []
    for network, volcanoes in config['networks'].items():
        for volcano, stations in volcanoes.items():
            for station in stations:
                if station.get('active', False):
                    active_stations.append({
                        'network': network,
                        'volcano': volcano,
                        **station
                    })
    
    return active_stations


def build_metadata_key(network, volcano, station, location, channel, sample_rate, date):
    """
    Build R2 metadata key for a given station and date (NEW format without sample rate).
    
    Args:
        network: Network code (e.g., 'HV')
        volcano: Volcano name (e.g., 'kilauea')
        station: Station code (e.g., 'OBL')
        location: Location code (e.g., '' or '--')
        channel: Channel code (e.g., 'HHZ')
        sample_rate: Sample rate (e.g., 100.0) - IGNORED in NEW format
        date: date object or datetime
    
    Returns:
        str: R2 key like "data/2025/11/05/HV/kilauea/OBL/--/HHZ/HV_OBL_--_HHZ_2025-11-05.json"
        Note: No longer includes sample rate in filename!
    """
    year = date.year
    month = f"{date.month:02d}"
    day = f"{date.day:02d}"
    location_str = location if location and location != '--' else '--'
    # NEW format: no sample rate in filename
    filename = f"{network}_{station}_{location_str}_{channel}_{date.strftime('%Y-%m-%d')}.json"
    return f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/{filename}"


def load_metadata_for_date(s3_client, network, volcano, station, location, channel, sample_rate, date):
    """
    Load metadata JSON for a station and date from R2.
    Tries NEW format (without sample rate) first, then falls back to OLD format (with sample rate).
    
    Args:
        s3_client: boto3 S3 client
        network, volcano, station, location, channel, sample_rate: Station identifiers
        date: date object or datetime
    
    Returns:
        dict: Metadata dict with 'chunks' key, or None if not found
    
    Example return:
        {
            'date': '2025-11-05',
            'network': 'HV',
            'chunks': {
                '10m': [{'start': '00:00:00', 'end': '00:09:59', ...}, ...],
                '1h': [...],
                '6h': [...]
            }
        }
    """
    # Try NEW format first (without sample rate)
    metadata_key = build_metadata_key(network, volcano, station, location, channel, sample_rate, date)
    try:
        response = s3_client.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
        return json.loads(response['Body'].read().decode('utf-8'))
    except s3_client.exceptions.NoSuchKey:
        # Try OLD format (with sample rate)
        year = date.year
        month = f"{date.month:02d}"
        day = f"{date.day:02d}"
        location_str = location if location and location != '--' else '--'
        rate_str = f"{sample_rate:.2f}".rstrip('0').rstrip('.') if '.' in str(sample_rate) else str(int(sample_rate))
        old_filename = f"{network}_{station}_{location_str}_{channel}_{rate_str}Hz_{date.strftime('%Y-%m-%d')}.json"
        old_metadata_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/{old_filename}"
        
        try:
            response = s3_client.get_object(Bucket=R2_BUCKET_NAME, Key=old_metadata_key)
            return json.loads(response['Body'].read().decode('utf-8'))
        except s3_client.exceptions.NoSuchKey:
            return None


def generate_expected_windows(date, chunk_type):
    """
    Generate expected time windows for a date and chunk type.
    
    This tells us what windows SHOULD exist for a given date based on our collection schedule.
    
    Args:
        date: date object (not datetime)
        chunk_type: '10m', '1h', or '6h'
    
    Returns:
        list of (start_datetime, end_datetime) tuples in UTC
    
    Examples:
        For date=Nov 5, 2025, chunk_type='10m':
            Returns 144 windows: (2025-11-05 00:00:00, 2025-11-05 00:10:00), 
                                 (2025-11-05 00:10:00, 2025-11-05 00:20:00), ...
        
        For date=Nov 5, 2025, chunk_type='1h':
            Returns 24 windows: (2025-11-05 00:00:00, 2025-11-05 01:00:00),
                                (2025-11-05 01:00:00, 2025-11-05 02:00:00), ...
        
        For date=Nov 5, 2025, chunk_type='6h':
            Returns 4 windows: (2025-11-05 00:00:00, 2025-11-05 06:00:00),
                               (2025-11-05 06:00:00, 2025-11-05 12:00:00), ...
    """
    from datetime import datetime, timedelta, timezone
    
    windows = []
    day_start = datetime.combine(date, datetime.min.time()).replace(tzinfo=timezone.utc)
    
    if chunk_type == '10m':
        # Every 10 minutes (144 windows per day)
        for hour in range(24):
            for minute in range(0, 60, 10):
                start = day_start + timedelta(hours=hour, minutes=minute)
                end = start + timedelta(minutes=10)
                windows.append((start, end))
    
    elif chunk_type == '1h':
        # Every hour (24 windows per day)
        for hour in range(24):
            start = day_start + timedelta(hours=hour)
            end = start + timedelta(hours=1)
            windows.append((start, end))
    
    elif chunk_type == '6h':
        # Every 6 hours (4 windows per day)
        for hour in range(0, 24, 6):
            start = day_start + timedelta(hours=hour)
            end = start + timedelta(hours=6)
            windows.append((start, end))
    
    return windows


def is_window_being_collected(window_end, last_run_completed):
    """
    Check if a window is from the collection currently in progress.
    
    Smart logic: If collector just finished, exclude the window(s) it just created.
    Uses actual last_run_completed timestamp instead of arbitrary buffers.
    
    Args:
        window_end: datetime when window ends
        last_run_completed: ISO timestamp of last completed collection (or None)
    
    Returns:
        bool: True if window might be from current/recent collection (exclude it)
    
    Logic:
        - Windows ending AFTER last_run_completed are too recent (either being collected now or just finished)
        - Windows ending BEFORE last_run_completed are fair game (should exist if collection succeeded)
    """
    if not last_run_completed:
        # No collections have completed yet - exclude everything recent
        now = datetime.now(timezone.utc)
        from datetime import timedelta
        return window_end > (now - timedelta(minutes=10))
    
    try:
        last_completed = datetime.fromisoformat(last_run_completed.replace('Z', '+00:00'))
        # If window ended after last completion, it's too recent
        return window_end > last_completed
    except:
        # Parse error - be conservative
        return True


def find_earliest_data_timestamp(s3_client):
    """
    Find the timestamp of the earliest data file in R2.
    Scans all files in data/ prefix to find the earliest one.
    
    Returns:
        datetime: Timestamp of earliest file, or None if no files found
    """
    try:
        paginator = s3_client.get_paginator('list_objects_v2')
        pages = paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix='data/')
        
        earliest_timestamp = None
        
        for page in pages:
            if 'Contents' not in page:
                continue
            
            for obj in page['Contents']:
                # Use LastModified as the file timestamp
                file_timestamp = obj['LastModified']
                
                if earliest_timestamp is None or file_timestamp < earliest_timestamp:
                    earliest_timestamp = file_timestamp
        
        return earliest_timestamp
    except Exception as e:
        print(f"Error finding earliest timestamp: {e}")
        return None


def detect_gaps_for_station(s3_client, network, volcano, station, location, channel, sample_rate, 
                            start_datetime, end_datetime, chunk_types=['10m', '1h', '6h'], 
                            last_run_completed=None):
    """
    Detect gaps (missing windows) for a station across a datetime range.
    
    This is the HIGH-LEVEL gap detection function. It:
    1. Gets all dates in range
    2. For each date, loads metadata
    3. Generates expected windows
    4. Compares expected vs actual (filters by start_datetime/end_datetime)
    5. Returns missing windows (gaps)
    
    Args:
        s3_client: boto3 S3 client
        network, volcano, station, location, channel, sample_rate: Station identifiers
        start_datetime: datetime object (inclusive) - exact time to start checking
        end_datetime: datetime object (inclusive) - exact time to stop checking
        chunk_types: list of chunk types to check (default: ['10m', '1h', '6h'])
        last_run_completed: ISO timestamp of last completed collection (excludes windows after this)
    
    Returns:
        dict: {
            '10m': [{'start': 'ISO8601', 'end': 'ISO8601', 'duration_minutes': int}, ...],
            '1h': [...],
            '6h': [...]
        }
    
    Example:
        gaps = detect_gaps_for_station(s3, 'HV', 'kilauea', 'OBL', '', 'HHZ', 100.0,
                                        datetime(2025, 11, 4, 20, 0), datetime(2025, 11, 5, 23, 59))
        # Returns:
        {
            '10m': [
                {'start': '2025-11-04T20:30:00Z', 'end': '2025-11-04T20:40:00Z', 'duration_minutes': 10},
                {'start': '2025-11-04T21:10:00Z', 'end': '2025-11-04T21:20:00Z', 'duration_minutes': 10}
            ],
            '1h': [],
            '6h': []
        }
    """
    gaps = {ct: [] for ct in chunk_types}
    
    # Get all dates in range (need to check each date's metadata)
    current_date = start_datetime.date()
    end_date = end_datetime.date()
    from datetime import timedelta
    while current_date <= end_date:
        # Load metadata for this date
        metadata = load_metadata_for_date(s3_client, network, volcano, station, location, 
                                          channel, sample_rate, current_date)
        
        # Check each chunk type
        for chunk_type in chunk_types:
            # Generate expected windows for this date
            expected_windows = generate_expected_windows(current_date, chunk_type)
            
            # Get actual windows from metadata (if exists)
            actual_starts = set()
            if metadata and 'chunks' in metadata and chunk_type in metadata['chunks']:
                # Metadata stores times as "HH:MM:SS", need to match against full datetime
                for chunk in metadata['chunks'][chunk_type]:
                    actual_starts.add(chunk['start'])  # e.g., "20:30:00"
            
            # Find missing windows
            for window_start, window_end in expected_windows:
                # FILTER: Only check windows within our exact datetime range
                if window_start < start_datetime or window_start >= end_datetime:
                    continue
                
                # Skip if window is from current/recent collection
                if is_window_being_collected(window_end, last_run_completed):
                    continue
                
                # Check if this window exists in metadata
                # Convert window_start to time-only string for comparison
                time_str = window_start.strftime("%H:%M:%S")
                
                if time_str not in actual_starts:
                    # It's a gap!
                    duration_minutes = int((window_end - window_start).total_seconds() / 60)
                    gaps[chunk_type].append({
                        'start': window_start.strftime('%Y-%m-%dT%H:%M:%SZ'),
                        'end': window_end.strftime('%Y-%m-%dT%H:%M:%SZ'),
                        'duration_minutes': duration_minutes
                    })
        
        # Move to next date
        current_date += timedelta(days=1)
    
    return gaps


# ============================================================================
# Gaps Detection & Backfill Endpoints
# ============================================================================

@app.route('/gaps/<mode>')
def gaps_detection(mode):
    """
    Detect missing data windows (gaps) in collected seismic data.
    
    Modes:
        /gaps/complete - From first file ever collected to now
        /gaps/24h - Last 24 hours
        /gaps/4h - Last 4 hours
        /gaps/1h - Last 1 hour
        /gaps/custom?start=<ISO>&end=<ISO> - Specific time range
    
    Returns:
        JSON report with gaps for all stations, saved to R2
    """
    from datetime import timedelta
    from flask import request
    
    try:
        # Determine time range based on mode
        now = datetime.now(timezone.utc)
        
        if mode == 'custom':
            # Custom time range from query params
            start_str = request.args.get('start')
            end_str = request.args.get('end')
            if not start_str or not end_str:
                return jsonify({'error': 'Custom mode requires start and end query parameters (ISO 8601 format)'}), 400
            
            # Parse ISO 8601 timestamps
            start_time = datetime.fromisoformat(start_str.replace('Z', '+00:00'))
            end_time = datetime.fromisoformat(end_str.replace('Z', '+00:00'))
        
        elif mode == 'complete':
            # From first file ever to now
            # We'll scan R2 to find the earliest file
            s3 = get_s3_client()
            
            # List all files in data/ prefix to find earliest
            paginator = s3.get_paginator('list_objects_v2')
            pages = paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix='data/')
            
            earliest_date = now.date()
            for page in pages:
                if 'Contents' not in page:
                    break
                for obj in page['Contents']:
                    # Extract date from key (data/YYYY/MM/...)
                    parts = obj['Key'].split('/')
                    if len(parts) >= 3:
                        try:
                            year = int(parts[1])
                            month = int(parts[2])
                            file_date = datetime(year, month, 1, tzinfo=timezone.utc).date()
                            if file_date < earliest_date:
                                earliest_date = file_date
                        except (ValueError, IndexError):
                            continue
            
            start_time = datetime.combine(earliest_date, datetime.min.time()).replace(tzinfo=timezone.utc)
            end_time = now
        
        elif mode.endswith('h'):
            # Hours mode (24h, 4h, 1h, etc.)
            hours = int(mode[:-1])
            start_time = now - timedelta(hours=hours)
            end_time = now
        
        elif mode.endswith('d'):
            # Days mode (2d, 7d, etc.)
            days = int(mode[:-1])
            start_time = now - timedelta(days=days)
            end_time = now
        
        else:
            return jsonify({'error': f'Invalid mode: {mode}. Use 24h, 4h, 1h, complete, or custom'}), 400
        
    except Exception as e:
        return jsonify({'error': f'Failed to parse time range: {str(e)}'}), 400
    
    try:
        # Get R2 client and active stations
        s3 = get_s3_client()
        active_stations = get_active_stations_list()
        
        # Find when collection actually started (earliest file in R2)
        # Don't check for gaps before data collection began!
        earliest_file = find_earliest_data_timestamp(s3)
        if earliest_file:
            # Clamp start_time to when collection actually started
            if start_time < earliest_file:
                original_start = start_time.strftime('%Y-%m-%dT%H:%M:%SZ')
                start_time = earliest_file
                print(f"Clamped start time from {original_start} to {start_time.strftime('%Y-%m-%dT%H:%M:%SZ')} (first file)")
        else:
            # No files in R2 yet - no point checking for gaps
            return jsonify({
                'error': 'No data files found in R2. Collection has not started yet.',
                'suggestion': 'Wait for the collector to run and create some files first.'
            }), 404
        
        # Generate report ID and timestamp
        report_timestamp = now.strftime('%Y-%m-%dT%H-%M-%SZ')
        report_id = f"gap_report_{report_timestamp}"
        
        # Calculate time range in hours
        time_range_hours = (end_time - start_time).total_seconds() / 3600
        
        # Track statistics
        total_gaps = 0
        gaps_by_type = {'10m': 0, '1h': 0, '6h': 0}
        total_missing_minutes = 0
        recent_windows_excluded = 0
        stations_with_gaps = 0
        
        # Collect gaps for all stations
        station_results = []
        
        for station_info in active_stations:
            network = station_info['network']
            volcano = station_info['volcano']
            station = station_info['station']
            location = station_info.get('location', '')
            channel = station_info['channel']
            sample_rate = station_info['sample_rate']
            
            # Detect gaps for this station
            gaps = detect_gaps_for_station(
                s3, network, volcano, station, location, channel, sample_rate,
                start_time, end_time,  # Pass full datetimes, not just dates
                chunk_types=['10m', '1h', '6h'],
                last_run_completed=status['last_run_completed']  # Use actual completion time!
            )
            
            # Count gaps
            station_gap_count = sum(len(gaps[ct]) for ct in ['10m', '1h', '6h'])
            
            if station_gap_count > 0:
                stations_with_gaps += 1
            
            # Add to totals
            for chunk_type in ['10m', '1h', '6h']:
                gaps_by_type[chunk_type] += len(gaps[chunk_type])
                total_gaps += len(gaps[chunk_type])
                
                # Calculate missing minutes
                for gap in gaps[chunk_type]:
                    total_missing_minutes += gap['duration_minutes']
            
            # Build station result
            station_results.append({
                'network': network,
                'station': station,
                'location': location if location else '--',
                'channel': channel,
                'volcano': volcano,
                'gaps': gaps,
                'gaps_count': {
                    '10m': len(gaps['10m']),
                    '1h': len(gaps['1h']),
                    '6h': len(gaps['6h']),
                    'total': station_gap_count
                }
            })
        
        # Build complete report
        report = {
            'report_id': report_id,
            'generated_at': now.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'mode': mode,
            'time_range': {
                'start': start_time.strftime('%Y-%m-%dT%H:%M:%SZ'),
                'end': end_time.strftime('%Y-%m-%dT%H:%M:%SZ'),
                'hours': round(time_range_hours, 2),
                'first_file_at': earliest_file.strftime('%Y-%m-%dT%H:%M:%SZ') if earliest_file else None
            },
            'collector_status': {
                'currently_running': status['currently_running'],
                'last_run': status.get('last_run')
            },
            'stations': station_results,
            'summary': {
                'total_stations': len(active_stations),
                'stations_with_gaps': stations_with_gaps,
                'total_gaps': total_gaps,
                'gaps_by_type': gaps_by_type,
                'total_missing_minutes': total_missing_minutes,
                'recent_windows_excluded': recent_windows_excluded  # TODO: track this in detect_gaps
            }
        }
        
        # Save report to R2
        report_key = f"collector_logs/{report_id}.json"
        latest_key = "collector_logs/gap_report_latest.json"
        
        s3.put_object(
            Bucket=R2_BUCKET_NAME,
            Key=report_key,
            Body=json.dumps(report, indent=2).encode('utf-8'),
            ContentType='application/json'
        )
        
        # Also save as latest
        s3.put_object(
            Bucket=R2_BUCKET_NAME,
            Key=latest_key,
            Body=json.dumps(report, indent=2).encode('utf-8'),
            ContentType='application/json'
        )
        
        # Add save info to response
        report['saved_to'] = report_key
        
        return jsonify(report)
    
    except Exception as e:
        import traceback
        return jsonify({
            'error': f'Gap detection failed: {str(e)}',
            'traceback': traceback.format_exc()
        }), 500


@app.route('/backfill', methods=['POST'])
def backfill():
    """
    Backfill missing data windows by fetching from IRIS.
    
    Request body options:
        {"use_latest_report": true}  - Use latest gap report
        {"report_file": "gap_report_*.json"}  - Use specific report
        {"station": "HV.OBL.--.HHZ"}  - Filter by station
        {"chunk_types": ["10m", "1h"]}  - Filter by chunk types
        {"windows": {...}}  - Manual windows (override)
    
    Returns:
        JSON report with backfill results
    """
    from flask import request
    from datetime import timedelta
    
    try:
        data = request.get_json() or {}
        
        # Get R2 client
        s3 = get_s3_client()
        
        # Determine what to backfill
        if 'windows' in data:
            # Manual windows mode
            station_id = data.get('station')
            if not station_id:
                return jsonify({'error': 'Manual windows mode requires "station" parameter'}), 400
            
            # Parse station ID (e.g., "HV.OBL.--.HHZ")
            parts = station_id.split('.')
            if len(parts) != 4:
                return jsonify({'error': 'Invalid station format. Use: NETWORK.STATION.LOCATION.CHANNEL'}), 400
            
            network, station, location, channel = parts
            
            # Find station config for volcano and sample_rate
            active_stations = get_active_stations_list()
            station_config = None
            for st in active_stations:
                if (st['network'] == network and st['station'] == station and 
                    st['channel'] == channel and st.get('location', '') == location.replace('--', '')):
                    station_config = st
                    break
            
            if not station_config:
                return jsonify({'error': f'Station {station_id} not found in active stations'}), 404
            
            volcano = station_config['volcano']
            sample_rate = station_config['sample_rate']
            
            # Build backfill tasks from manual windows
            backfill_tasks = []
            for chunk_type, windows in data['windows'].items():
                for window in windows:
                    start_time = datetime.fromisoformat(window['start'].replace('Z', '+00:00'))
                    end_time = datetime.fromisoformat(window['end'].replace('Z', '+00:00'))
                    backfill_tasks.append({
                        'network': network,
                        'volcano': volcano,
                        'station': station,
                        'location': location.replace('--', ''),
                        'channel': channel,
                        'sample_rate': sample_rate,
                        'chunk_type': chunk_type,
                        'start_time': start_time,
                        'end_time': end_time
                    })
            
            source = 'manual_windows'
        
        else:
            # Report-based mode
            report_file = data.get('report_file', 'gap_report_latest.json')
            if data.get('use_latest_report', True):
                report_file = 'gap_report_latest.json'
            
            # Load gap report from R2
            try:
                response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=f'collector_logs/{report_file}')
                gap_report = json.loads(response['Body'].read().decode('utf-8'))
            except s3.exceptions.NoSuchKey:
                return jsonify({'error': f'Gap report not found: {report_file}. Run /gaps first.'}), 404
            
            # Apply filters
            station_filter = data.get('station')
            chunk_type_filter = data.get('chunk_types', ['10m', '1h', '6h'])
            
            # Build backfill tasks from gap report
            backfill_tasks = []
            for station_info in gap_report['stations']:
                station_id = f"{station_info['network']}.{station_info['station']}.{station_info['location']}.{station_info['channel']}"
                
                # Apply station filter
                if station_filter and station_id != station_filter:
                    continue
                
                # Get station config for volcano and sample_rate
                active_stations = get_active_stations_list()
                station_config = None
                for st in active_stations:
                    loc = st.get('location', '').replace('', '--')
                    if loc == '':
                        loc = '--'
                    if (st['network'] == station_info['network'] and 
                        st['station'] == station_info['station'] and 
                        st['channel'] == station_info['channel'] and 
                        loc == station_info['location']):
                        station_config = st
                        break
                
                if not station_config:
                    continue
                
                # Process gaps for this station
                for chunk_type in chunk_type_filter:
                    if chunk_type not in station_info['gaps']:
                        continue
                    
                    for gap in station_info['gaps'][chunk_type]:
                        start_time = datetime.fromisoformat(gap['start'].replace('Z', '+00:00'))
                        end_time = datetime.fromisoformat(gap['end'].replace('Z', '+00:00'))
                        
                        backfill_tasks.append({
                            'network': station_info['network'],
                            'volcano': station_config['volcano'],
                            'station': station_info['station'],
                            'location': station_info['location'].replace('--', ''),
                            'channel': station_info['channel'],
                            'sample_rate': station_config['sample_rate'],
                            'chunk_type': chunk_type,
                            'start_time': start_time,
                            'end_time': end_time
                        })
            
            source = report_file
        
        # Execute backfill
        now = datetime.now(timezone.utc)
        backfill_timestamp = now.strftime('%Y-%m-%dT%H-%M-%SZ')
        backfill_id = f"backfill_{backfill_timestamp}"
        
        results = {
            'successful': 0,
            'failed': 0,
            'skipped': 0
        }
        
        details = []
        
        print(f"[{now.strftime('%Y-%m-%d %H:%M:%S UTC')}] Starting backfill: {len(backfill_tasks)} windows")
        
        for i, task in enumerate(backfill_tasks):
            start_time = time.time()
            
            station_id = f"{task['network']}.{task['station']}.{task['location'] or '--'}.{task['channel']}"
            print(f"[{i+1}/{len(backfill_tasks)}] {station_id} {task['chunk_type']} {task['start_time']} to {task['end_time']}")
            
            # Call process_station_window (consolidated from cron_job.py)
            status_result, error_info = process_station_window(
                network=task['network'],
                station=task['station'],
                location=task['location'],
                channel=task['channel'],
                volcano=task['volcano'],
                sample_rate=task['sample_rate'],
                start_time=task['start_time'],
                end_time=task['end_time'],
                chunk_type=task['chunk_type']
            )
            
            elapsed = time.time() - start_time
            
            # Track result
            if status_result == 'success':
                results['successful'] += 1
                detail = {
                    'station': station_id,
                    'chunk_type': task['chunk_type'],
                    'window': {
                        'start': task['start_time'].strftime('%Y-%m-%dT%H:%M:%SZ'),
                        'end': task['end_time'].strftime('%Y-%m-%dT%H:%M:%SZ')
                    },
                    'status': 'success',
                    'elapsed_seconds': round(elapsed, 2)
                }
            elif status_result == 'skipped':
                results['skipped'] += 1
                detail = {
                    'station': station_id,
                    'chunk_type': task['chunk_type'],
                    'window': {
                        'start': task['start_time'].strftime('%Y-%m-%dT%H:%M:%SZ'),
                        'end': task['end_time'].strftime('%Y-%m-%dT%H:%M:%SZ')
                    },
                    'status': 'skipped',
                    'reason': 'already_exists'
                }
            else:  # failed
                results['failed'] += 1
                detail = {
                    'station': station_id,
                    'chunk_type': task['chunk_type'],
                    'window': {
                        'start': task['start_time'].strftime('%Y-%m-%dT%H:%M:%SZ'),
                        'end': task['end_time'].strftime('%Y-%m-%dT%H:%M:%SZ')
                    },
                    'status': 'failed',
                    'error': error_info.get('error') if error_info else 'Unknown error'
                }
            
            details.append(detail)
        
        # Build response
        response = {
            'backfill_id': backfill_id,
            'started_at': now.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'source': source,
            'filters': {
                'station': data.get('station'),
                'chunk_types': data.get('chunk_types', ['10m', '1h', '6h'])
            },
            'total_windows': len(backfill_tasks),
            'progress': results,
            'details': details,
            'summary': {
                'duration_seconds': round(time.time() - now.timestamp(), 2),
                'success_rate': round(results['successful'] / len(backfill_tasks) * 100, 1) if backfill_tasks else 0
            }
        }
        
        print(f"Backfill complete: {results['successful']} success, {results['failed']} failed, {results['skipped']} skipped")
        
        return jsonify(response)
    
    except Exception as e:
        import traceback
        return jsonify({
            'error': f'Backfill failed: {str(e)}',
            'traceback': traceback.format_exc()
        }), 500


@app.route('/health')
def health():
    """Simple health check endpoint"""
    return jsonify({
        'status': 'healthy',
        'version': __version__,
        'uptime_seconds': (datetime.now(timezone.utc) - datetime.fromisoformat(status['started_at'])).total_seconds()
    })

@app.route('/status')
def get_status():
    """
    Return detailed status with R2 file counts and storage info
    
    Query params:
        timezone: Optional timezone name (e.g. 'America/Los_Angeles', 'US/Pacific', 'Europe/London')
                  Default: UTC
                  
    Examples:
        /status                                    # Returns times in UTC
        /status?timezone=America/Los_Angeles       # Returns times in Pacific Time
        /status?timezone=US/Pacific                # Same as above
        /status?timezone=Europe/London             # Returns times in GMT/BST
    """
    from flask import request
    
    # Get timezone from query parameter (default to None = UTC)
    target_timezone = request.args.get('timezone', None)
    
    # Collect data for response (build final response at the end)
    try:
        # Initialize R2 client
        R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID', '66f906f29f28b08ae9c80d4f36e25c7a')
        R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '9e1cf6c395172f108c2150c52878859f')
        R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec')
        R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')
        
        s3 = boto3.client(
            's3',
            endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
            aws_access_key_id=R2_ACCESS_KEY_ID,
            aws_secret_access_key=R2_SECRET_ACCESS_KEY,
            region_name='auto'
        )
        
        # Detect and log any station changes (new stations added or removed)
        detect_and_log_station_changes()
        
        # Count files and calculate storage
        paginator = s3.get_paginator('list_objects_v2')
        pages = paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix='data/')
        
        file_counts = {'10m': 0, '1h': 0, '6h': 0, 'metadata': 0, 'other': 0}
        station_file_counts = {}  # Track files per station: {station_key: {'10m': count, '1h': count, '6h': count}}
        station_earliest_timestamps = {}  # Track earliest file timestamp per station: {station_key: datetime}
        oldest_files = {'10m': None, '1h': None, '6h': None}  # Track oldest file timestamp by type
        total_size = 0
        latest_modified = None
        
        for page in pages:
            if 'Contents' not in page:
                continue
                
            for obj in page['Contents']:
                total_size += obj['Size']
                
                # Track latest modified
                if latest_modified is None or obj['LastModified'] > latest_modified:
                    latest_modified = obj['LastModified']
                
                # Count by type and extract station from path
                # Path format: data/{YEAR}/{MONTH}/{NETWORK}/{VOLCANO}/{STATION}/{LOCATION}/{CHANNEL}/...
                key = obj['Key']
                path_parts = key.split('/')
                
                # Extract station identifier (network-station-location-channel)
                # Find station in path (should be 5th element: data/YEAR/MONTH/NETWORK/VOLCANO/STATION/...)
                station_key = None
                if len(path_parts) >= 6:
                    # Format: network_station_location_channel (for tracking)
                    network = path_parts[3] if len(path_parts) > 3 else None
                    station = path_parts[5] if len(path_parts) > 5 else None
                    location = path_parts[6] if len(path_parts) > 6 else None
                    channel = path_parts[7] if len(path_parts) > 7 else None
                    if network and station and location and channel:
                        station_key = f"{network}_{station}_{location}_{channel}"
                
                # Count by type and track oldest files
                file_type = None
                if '/10m/' in key:
                    file_counts['10m'] += 1
                    file_type = '10m'
                elif '/1h/' in key:
                    file_counts['1h'] += 1
                    file_type = '1h'
                elif '/6h/' in key:
                    file_counts['6h'] += 1
                    file_type = '6h'
                elif key.endswith('.json'):
                    file_counts['metadata'] += 1
                else:
                    file_counts['other'] += 1
                
                # Extract timestamp from filename to find oldest files
                file_timestamp = None  # Initialize outside try block
                if file_type and '.bin.zst' in key:
                    # Filename format: NETWORK_STATION_LOCATION_CHANNEL_RATEHz_YYYY-MM-DD-HH-MM-SS_to_YYYY-MM-DD-HH-MM-SS.bin.zst
                    filename = key.split('/')[-1]
                    try:
                        # Extract start timestamp (before "_to_")
                        if '_to_' in filename:
                            start_part = filename.split('_to_')[0]
                            # The timestamp is in format YYYY-MM-DD-HH-MM-SS (19 chars with dashes)
                            # Split by underscore and find the part that matches this pattern
                            parts = start_part.split('_')
                            for part in parts:
                                # Check if this part matches YYYY-MM-DD-HH-MM-SS pattern (19 chars, 5 dashes)
                                if len(part) == 19 and part.count('-') == 5:
                                    # Parse: YYYY-MM-DD-HH-MM-SS
                                    file_timestamp = datetime.strptime(part, '%Y-%m-%d-%H-%M-%S')
                                    file_timestamp = file_timestamp.replace(tzinfo=timezone.utc)
                                    
                                    # Track oldest file for this type
                                    if oldest_files[file_type] is None or file_timestamp < oldest_files[file_type]:
                                        oldest_files[file_type] = file_timestamp
                                    break
                    except (ValueError, IndexError):
                        # Skip if we can't parse the timestamp
                        pass
                
                # Track per-station counts and earliest timestamps for data files (not metadata)
                if station_key and file_type:
                    if station_key not in station_file_counts:
                        station_file_counts[station_key] = {'10m': 0, '1h': 0, '6h': 0}
                        station_earliest_timestamps[station_key] = None
                    station_file_counts[station_key][file_type] += 1
                    
                    # Track earliest timestamp for this station
                    if file_timestamp:
                        if station_earliest_timestamps[station_key] is None or file_timestamp < station_earliest_timestamps[station_key]:
                            station_earliest_timestamps[station_key] = file_timestamp
        
        total_files = sum(file_counts.values())
        storage_mb = total_size / (1024 * 1024)
        
        # Calculate collection cycles (based on 10m files divided by number of stations)
        # Each cycle creates 1 file per station
        config_path = Path(__file__).parent / 'stations_config.json'
        with open(config_path) as f:
            config = json.load(f)
        
        active_station_count = 0
        for network, volcanoes in config['networks'].items():
            for volcano, stations in volcanoes.items():
                active_station_count += sum(1 for s in stations if s.get('active', False))
        
        # Calculate per-station statistics
        station_10m_counts = [counts['10m'] for counts in station_file_counts.values()] if station_file_counts else []
        station_1h_counts = [counts['1h'] for counts in station_file_counts.values()] if station_file_counts else []
        station_6h_counts = [counts['6h'] for counts in station_file_counts.values()] if station_file_counts else []
        
        # Calculate stats for each period
        def calc_stats(counts, active_count):
            if not counts or active_count == 0:
                return {'avg': 0.0, 'is_uniform': True}
            min_count = min(counts) if counts else 0
            max_count = max(counts) if counts else 0
            avg_count = sum(counts) / len(counts) if counts else 0
            # Check if all stations have same count (uniform distribution)
            is_uniform = len(set(counts)) <= 1 if counts else True
            
            result = {
                'avg': round(avg_count, 1),
                'is_uniform': is_uniform
            }
            # Only include min/max if not uniform
            if not is_uniform:
                result['min'] = min_count
                result['max'] = max_count
            return result
        
        stats_10m = calc_stats(station_10m_counts, active_station_count)
        stats_1h = calc_stats(station_1h_counts, active_station_count)
        stats_6h = calc_stats(station_6h_counts, active_station_count)
        
        # If we have fewer station counts than active stations, some stations are missing files
        stations_with_files = len(station_file_counts)
        missing_stations = active_station_count - stations_with_files if active_station_count > stations_with_files else 0
        
        # Calculate expected files PER STATION based on activation log (source of truth)
        # This handles stations that were added later - they shouldn't be expected to have
        # files going back to when the first station started collecting
        now = datetime.now(timezone.utc)
        expected_10m_total = 0
        expected_1h_total = 0
        expected_6h_total = 0
        
        # Load activation log to get when each station was activated
        activation_log = load_station_activations()
        
        # Get active stations list to match against file counts
        active_stations_list = get_active_stations_list()
        
        for station_config in active_stations_list:
            network = station_config['network']
            station = station_config['station']
            location = station_config.get('location', '')
            channel = station_config['channel']
            location_str = location if location and location != '--' else '--'
            station_key = f"{network}_{station}_{location_str}_{channel}"
            
            # Get activation time from log (source of truth)
            station_info = activation_log.get('stations', {}).get(station_key)
            if station_info and station_info.get('activated_at'):
                try:
                    # Parse activation timestamp
                    activated_at_str = station_info['activated_at']
                    if activated_at_str.endswith('Z'):
                        activated_at_str = activated_at_str[:-1] + '+00:00'
                    station_start = datetime.fromisoformat(activated_at_str)
                    
                    # Only calculate expected if station is still active (not deactivated)
                    if station_info.get('deactivated_at') is None:
                        # Calculate how many cycles this station should have based on its activation time
                        time_diff = now - station_start
                        total_minutes = time_diff.total_seconds() / 60
                        
                        # Collection runs every 10 minutes, so cycles = minutes / 10
                        # Round down to nearest cycle (stations don't get partial cycles)
                        station_cycles = int(total_minutes // 10)
                        
                        # Expected files for this station
                        # 10m files: 1 per cycle
                        # 1h files: 1 per 6 cycles (every hour)
                        # 6h files: 1 per 36 cycles (every 6 hours)
                        station_expected_10m = station_cycles
                        station_expected_1h = station_cycles // 6 if station_cycles >= 6 else 0
                        station_expected_6h = station_cycles // 36 if station_cycles >= 36 else 0
                        
                        expected_10m_total += station_expected_10m
                        expected_1h_total += station_expected_1h
                        expected_6h_total += station_expected_6h
                except (ValueError, TypeError) as e:
                    # If activation time is invalid, skip this station
                    print(f"Warning: Invalid activation time for {station_key}: {e}")
                    pass
            # If station not in log yet, don't add to expected (will be logged on next check)
        
        expected_10m = expected_10m_total
        expected_1h = expected_1h_total
        expected_6h = expected_6h_total
        
        # Status checks - account for currently_running
        is_running = status['currently_running']
        
        # For 10m files: if running and (not uniform or missing files), it's actively being created
        if is_running and (not stats_10m['is_uniform'] or file_counts['10m'] < expected_10m):
            status_10m = 'RUNNING'
        elif file_counts['10m'] == expected_10m and stats_10m['is_uniform']:
            status_10m = 'PERFECT'
        else:
            status_10m = 'MISSING'
        
        # For 1h files
        if is_running and (not stats_1h['is_uniform'] or (expected_1h > 0 and file_counts['1h'] < expected_1h)):
            status_1h = 'RUNNING'
        elif file_counts['1h'] == expected_1h and stats_1h['is_uniform']:
            status_1h = 'PERFECT'
        elif file_counts['1h'] >= expected_1h or expected_1h == 0:
            status_1h = 'OK'
        else:
            status_1h = 'INCOMPLETE'
        
        # For 6h files
        if is_running and (not stats_6h['is_uniform'] or (expected_6h > 0 and file_counts['6h'] < expected_6h)):
            status_6h = 'RUNNING'
        elif file_counts['6h'] == expected_6h and stats_6h['is_uniform']:
            status_6h = 'PERFECT'
        elif file_counts['6h'] >= expected_6h or expected_6h == 0:
            status_6h = 'OK'
        else:
            status_6h = 'INCOMPLETE'
        
        all_perfect = (file_counts['10m'] == expected_10m and stats_10m['is_uniform'] and not is_running)
        
        # Calculate coverage from file counts (files per station × duration)
        # 10m files: each file = 10 minutes
        # 1h files: each file = 1 hour
        # 6h files: each file = 6 hours
        def format_hours_minutes(total_hours):
            """Format hours as '1h 40m' or '0h' or '2h'"""
            if total_hours == 0:
                return "0h"
            hours = int(total_hours)
            minutes = round((total_hours - hours) * 60)  # Use round, not int (fixes 9.999 → 10)
            if minutes == 0:
                return f"{hours}h"
            return f"{hours}h {minutes}m"
        
        # Calculate coverage based on MINIMUM files per station (limiting factor)
        # This ensures new stations don't inflate coverage numbers
        coverage_hours_by_type = {}
        if station_file_counts and len(station_file_counts) > 0:
            # Get minimum files per station for each type (the limiting factor)
            min_files_10m = min(counts['10m'] for counts in station_file_counts.values()) if station_file_counts else 0
            min_files_1h = min(counts['1h'] for counts in station_file_counts.values()) if station_file_counts else 0
            min_files_6h = min(counts['6h'] for counts in station_file_counts.values()) if station_file_counts else 0
            
            # Calculate hours based on minimum files (limiting station)
            hours_10m = min_files_10m * (10/60)  # 10 min each
            hours_1h = min_files_1h * 1  # 1 hour each
            hours_6h = min_files_6h * 6  # 6 hours each
            
            coverage_hours_by_type['10m'] = format_hours_minutes(hours_10m)
            coverage_hours_by_type['1h'] = format_hours_minutes(hours_1h)
            coverage_hours_by_type['6h'] = format_hours_minutes(hours_6h)
        else:
            coverage_hours_by_type = {'10m': '0h', '1h': '0h', '6h': '0h'}
            hours_10m = 0
            hours_1h = 0
            hours_6h = 0
        
        # Full coverage = minimum across ALL types (if ANY type has 0, full coverage = 0)
        # Must have 10m, 1h, AND 6h files for full coverage
        if hours_10m > 0 and hours_1h > 0 and hours_6h > 0:
            full_coverage_hours = min(hours_10m, hours_1h, hours_6h)
        else:
            full_coverage_hours = 0
        
        full_coverage_days = round(full_coverage_hours / 24, 2) if full_coverage_hours > 0 else 0
        
        # Calculate average collection cycles for reporting (based on stations with files)
        avg_collection_cycles = 0
        if stations_with_files > 0:
            # Average cycles = average 10m files per station
            avg_collection_cycles = int(sum(counts['10m'] for counts in station_file_counts.values()) / stations_with_files) if station_file_counts else 0
        
        collection_stats = {
            'active_stations': active_station_count,
            'stations_with_files': stations_with_files,
            'missing_stations': missing_stations if missing_stations > 0 else None,
            'collection_cycles': avg_collection_cycles,
            'coverage_depth': {
                'full_coverage': format_hours_minutes(full_coverage_hours) if full_coverage_hours > 0 else "0h (need 6h files)",
                'by_type': coverage_hours_by_type
            },
            'files_per_station': {
                '10m': stats_10m,
                '1h': stats_1h,
                '6h': stats_6h
            },
            'expected_vs_actual': {
                '10m': {
                    'actual': file_counts['10m'],
                    'expected': expected_10m,
                    'status': status_10m
                },
                '1h': {
                    'actual': file_counts['1h'],
                    'expected': expected_1h,
                    'status': status_1h
                },
                '6h': {
                    'actual': file_counts['6h'],
                    'expected': expected_6h,
                    'status': status_6h
                },
                'overall': 'PERFECT' if all_perfect else 'OK'
            }
        }
        
        r2_storage = {
            'total_files': total_files,
            'file_counts': file_counts,
            'total_size_mb': round(storage_mb, 2),
            'total_size_gb': round(storage_mb / 1024, 3),
            'latest_file': latest_modified.isoformat() if latest_modified else None
        }
        
    except Exception as e:
        r2_storage = {
            'error': str(e)
        }
        collection_stats = {}  # Empty on error
    
    # Build final response in explicit order: runtime fields FIRST, then data
    # Use json.dumps with sort_keys=False to preserve order
    import json as json_module
    from flask import Response
    
    # Build failure summary
    failure_summary = {
        'total_failures': status['failed_runs'],
        'has_failures': status['failed_runs'] > 0,
        'last_failure': status['last_failure'],
        'recent_failures_count': len(status['recent_failures']),
        'log_location': f'R2: {FAILURE_LOG_KEY}' if status['failed_runs'] > 0 else None
    }
    
    # Convert timestamps to target timezone for display
    def convert_failure_timestamps(failure_obj):
        """Convert timestamps in failure object to target timezone"""
        if not failure_obj:
            return None
        converted = failure_obj.copy()
        if 'timestamp' in converted:
            converted['timestamp'] = convert_to_local_time(converted['timestamp'], target_timezone)
        return converted
    
    # Format last run duration
    def format_duration(seconds):
        if seconds is None:
            return None
        minutes = int(seconds // 60)
        secs = seconds % 60
        if minutes > 0:
            return f"{minutes}m {secs:.1f}s"
        else:
            return f"{secs:.1f}s"
    
    final_response = {
        'version': status['version'],
        'started_at': convert_to_local_time(status['started_at'], target_timezone),
        'total_runs': status['total_runs'],
        'successful_runs': status['successful_runs'],
        'failed_runs': status['failed_runs'],
        'currently_running': status['currently_running'],
        'deployed_at': convert_to_local_time(status['deployed_at'], target_timezone),
        'last_run_started': convert_to_local_time(status['last_run_started'], target_timezone),
        'last_run_completed': convert_to_local_time(status['last_run_completed'], target_timezone),
        'last_run_duration': format_duration(status['last_run_duration_seconds']),
        'next_run': convert_to_local_time(status['next_run'], target_timezone),
        'collection_stats': collection_stats,
        'r2_storage': r2_storage,
        'failure_summary': {
            'total_failures': failure_summary['total_failures'],
            'has_failures': failure_summary['has_failures'],
            'last_failure': convert_failure_timestamps(failure_summary['last_failure']),
            'recent_failures_count': failure_summary['recent_failures_count'],
            'log_location': failure_summary['log_location']
        },
        'last_failure': convert_failure_timestamps(status['last_failure'])
    }
    
    return Response(
        json_module.dumps(final_response, indent=2, sort_keys=False),
        mimetype='application/json'
    )

@app.route('/test/failure')
def test_failure():
    """TEST ENDPOINT: Simulate a failure to test tracking system"""
    import random
    
    # Create a fake failure
    error_msg = f"TEST FAILURE: Simulated error for testing (random={random.randint(1000, 9999)})"
    test_failure_info = {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'error': error_msg,
        'exit_code': 99,
        'type': 'test_simulation'
    }
    
    # Create summary version for status display
    test_failure_summary = {
        'timestamp': test_failure_info['timestamp'],
        'summary': extract_error_summary(error_msg),
        'exit_code': 99,
        'type': 'test_simulation',
        'log_location': f'R2: {FAILURE_LOG_KEY}'
    }
    
    # Save full error to R2 and update in-memory state with summary
    save_failure(test_failure_info)
    status['last_failure'] = test_failure_summary
    status['recent_failures'].append(test_failure_summary)
    if len(status['recent_failures']) > 10:
        status['recent_failures'] = status['recent_failures'][-10:]
    status['failed_runs'] += 1
    
    return jsonify({
        'success': True,
        'message': 'Test failure recorded',
        'failure': test_failure_summary,
        'note': f'Check /status to see the failure summary, or download {FAILURE_LOG_KEY} from R2 for full details'
    })

@app.route('/stations')
def get_stations():
    """Return currently active stations"""
    import json
    from pathlib import Path
    
    config_path = Path(__file__).parent / 'stations_config.json'
    with open(config_path) as f:
        config = json.load(f)
    
    active_stations = []
    for network, volcanoes in config['networks'].items():
        for volcano, stations in volcanoes.items():
            for station in stations:
                if station.get('active', False):
                    active_stations.append({
                        'network': network,
                        'volcano': volcano,
                        'station': station['station'],
                        'location': station['location'],
                        'channel': station['channel'],
                        'sample_rate': station['sample_rate']
                    })
    
    return jsonify({
        'total': len(active_stations),
        'stations': active_stations
    })

@app.route('/per-station-files')
def per_station_files():
    """
    Return detailed per-station file breakdown showing actual vs expected files.
    Shows which stations are missing files and by how much.
    """
    try:
        # Initialize R2 client
        s3 = get_s3_client()
        
        # Get active stations and activation log
        active_stations_list = get_active_stations_list()
        activation_log = load_station_activations()
        
        # Count files per station in R2
        station_file_counts = {}  # {station_key: {'10m': count, '1h': count, '6h': count}}
        
        paginator = s3.get_paginator('list_objects_v2')
        pages = paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix='data/')
        
        for page in pages:
            if 'Contents' not in page:
                continue
            
            for obj in page['Contents']:
                key = obj['Key']
                
                # Parse station info from key
                # Format: data/YYYY/MM/NETWORK/VOLCANO/STATION/LOCATION/CHANNEL/CHUNK_TYPE/filename.bin.zst
                parts = key.split('/')
                if len(parts) < 9:
                    continue
                
                network = parts[3]
                station = parts[5]
                location = parts[6]
                channel = parts[7]
                
                # Determine file type from path (10m, 1h, or 6h folder)
                file_type = None
                if '.bin.zst' in key:
                    # Check which chunk type folder it's in
                    if '/10m/' in key:
                        file_type = '10m'
                    elif '/1h/' in key:
                        file_type = '1h'
                    elif '/6h/' in key:
                        file_type = '6h'
                
                if file_type:
                    station_key = f"{network}_{station}_{location}_{channel}"
                    
                    if station_key not in station_file_counts:
                        station_file_counts[station_key] = {'10m': 0, '1h': 0, '6h': 0}
                    
                    station_file_counts[station_key][file_type] += 1
        
        # Calculate expected files per station
        now = datetime.now(timezone.utc)
        station_breakdown = []
        
        for station_config in active_stations_list:
            network = station_config['network']
            station = station_config['station']
            location = station_config.get('location', '')
            channel = station_config['channel']
            volcano = station_config.get('volcano', '')
            location_str = location if location and location != '--' else '--'
            station_key = f"{network}_{station}_{location_str}_{channel}"
            
            # Get actual file counts
            actual_counts = station_file_counts.get(station_key, {'10m': 0, '1h': 0, '6h': 0})
            
            # Get activation time from log
            station_info = activation_log.get('stations', {}).get(station_key)
            activated_at = None
            activated_at_str = None
            expected_10m = 0
            expected_1h = 0
            expected_6h = 0
            time_since_activation = None
            
            if station_info and station_info.get('activated_at'):
                try:
                    activated_at_str = station_info['activated_at']
                    if activated_at_str.endswith('Z'):
                        activated_at_str = activated_at_str[:-1] + '+00:00'
                    activated_at = datetime.fromisoformat(activated_at_str)
                    
                    # Only calculate expected if station is still active (not deactivated)
                    if station_info.get('deactivated_at') is None:
                        time_diff = now - activated_at
                        total_minutes = time_diff.total_seconds() / 60
                        station_cycles = int(total_minutes // 10)
                        
                        expected_10m = station_cycles
                        expected_1h = station_cycles // 6 if station_cycles >= 6 else 0
                        expected_6h = station_cycles // 36 if station_cycles >= 36 else 0
                        
                        # Calculate time since activation (human readable)
                        hours = int(time_diff.total_seconds() // 3600)
                        minutes = int((time_diff.total_seconds() % 3600) // 60)
                        if hours > 0:
                            time_since_activation = f"{hours}h {minutes}m"
                        else:
                            time_since_activation = f"{minutes}m"
                except (ValueError, TypeError) as e:
                    pass
            
            # Determine status
            missing_10m = expected_10m - actual_counts['10m']
            missing_1h = expected_1h - actual_counts['1h']
            missing_6h = expected_6h - actual_counts['6h']
            
            if missing_10m == 0 and missing_1h == 0 and missing_6h == 0:
                status_text = 'PERFECT'
            elif missing_10m > 0 or missing_1h > 0 or missing_6h > 0:
                status_text = 'MISSING'
            else:
                status_text = 'OK'
            
            station_breakdown.append({
                'station_key': station_key,
                'network': network,
                'station': station,
                'location': location_str,
                'channel': channel,
                'volcano': volcano,
                'activated_at': station_info.get('activated_at') if station_info else None,
                'time_since_activation': time_since_activation,
                'actual': {
                    '10m': actual_counts['10m'],
                    '1h': actual_counts['1h'],
                    '6h': actual_counts['6h']
                },
                'expected': {
                    '10m': expected_10m,
                    '1h': expected_1h,
                    '6h': expected_6h
                },
                'missing': {
                    '10m': missing_10m if missing_10m > 0 else 0,
                    '1h': missing_1h if missing_1h > 0 else 0,
                    '6h': missing_6h if missing_6h > 0 else 0
                },
                'status': status_text
            })
        
        # Sort by status (MISSING first, then PERFECT, then OK)
        status_order = {'MISSING': 0, 'OK': 1, 'PERFECT': 2}
        station_breakdown.sort(key=lambda x: (status_order.get(x['status'], 99), x['station_key']))
        
        # Calculate summary
        total_missing_10m = sum(s['missing']['10m'] for s in station_breakdown)
        total_missing_1h = sum(s['missing']['1h'] for s in station_breakdown)
        total_missing_6h = sum(s['missing']['6h'] for s in station_breakdown)
        stations_with_missing = sum(1 for s in station_breakdown if s['status'] == 'MISSING')
        
        return jsonify({
            'timestamp': now.isoformat(),
            'total_stations': len(station_breakdown),
            'summary': {
                'stations_with_missing_files': stations_with_missing,
                'stations_perfect': sum(1 for s in station_breakdown if s['status'] == 'PERFECT'),
                'total_missing': {
                    '10m': total_missing_10m,
                    '1h': total_missing_1h,
                    '6h': total_missing_6h
                }
            },
            'stations': station_breakdown
        })
    
    except Exception as e:
        import traceback
        return jsonify({
            'error': str(e),
            'traceback': traceback.format_exc() if os.getenv('DEBUG', '').lower() == 'true' else None
        }), 500

@app.route('/init-station-activations', methods=['POST'])
def init_station_activations():
    """
    Manually initialize station activation times for original stations.
    
    Expects JSON body with format:
    {
        "stations": [
            {
                "network": "HV",
                "station": "OBL",
                "location": "--",
                "channel": "HHZ",
                "activated_at": "2025-10-01T00:00:00Z"  // ISO 8601 timestamp
            },
            ...
        ]
    }
    
    This should be called once to set the start times for the original stations.
    New stations will be auto-detected and logged automatically.
    """
    from flask import request
    
    try:
        data = request.get_json()
        if not data or 'stations' not in data:
            return jsonify({'error': 'Missing "stations" array in request body'}), 400
        
        activation_log = load_station_activations()
        now = datetime.now(timezone.utc).isoformat()
        initialized = []
        
        for station_data in data['stations']:
            network = station_data.get('network')
            station = station_data.get('station')
            location = station_data.get('location', '--')
            channel = station_data.get('channel')
            activated_at = station_data.get('activated_at')
            
            if not all([network, station, channel, activated_at]):
                return jsonify({
                    'error': f'Missing required fields for station: {station_data}'
                }), 400
            
            location_str = location if location and location != '--' else '--'
            station_key = f"{network}_{station}_{location_str}_{channel}"
            
            # Validate timestamp format
            try:
                if activated_at.endswith('Z'):
                    activated_at = activated_at[:-1] + '+00:00'
                datetime.fromisoformat(activated_at)
            except ValueError:
                return jsonify({
                    'error': f'Invalid timestamp format for {station_key}: {activated_at}. Use ISO 8601 format (e.g., "2025-10-01T00:00:00Z")'
                }), 400
            
            # Update or create station entry
            station_info = {
                'network': network,
                'station': station,
                'location': location_str,
                'channel': channel,
                'activated_at': activated_at,
                'deactivated_at': None
            }
            
            # Check if this is a new initialization or update
            if station_key not in activation_log.get('stations', {}):
                activation_log['changes'].append({
                    'timestamp': now,
                    'type': 'initialized',
                    'station_key': station_key,
                    'station_info': station_info.copy()
                })
            
            activation_log['stations'][station_key] = station_info
            initialized.append(station_key)
        
        # Save updated log
        save_station_activations(activation_log)
        
        return jsonify({
            'success': True,
            'message': f'Initialized {len(initialized)} stations',
            'initialized': initialized,
            'log_location': f'R2: {STATION_ACTIVATION_LOG_KEY}'
        })
    except Exception as e:
        import traceback
        return jsonify({
            'error': f'Failed to initialize station activations: {str(e)}',
            'traceback': traceback.format_exc() if os.getenv('DEBUG', '').lower() == 'true' else None
        }), 500

@app.route('/station-activations')
def get_station_activations():
    """Return current station activation log"""
    try:
        activation_log = load_station_activations()
        return jsonify(activation_log)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/regenerate-station-activations', methods=['POST'])
def regenerate_station_activations():
    """
    Regenerate station activation log by scanning existing files in R2.
    Finds the earliest file timestamp for each active station and populates the log.
    Regenerates entries for all stations, even if they already exist.
    """
    try:
        s3 = get_s3_client()
        activation_log = load_station_activations()
        active_stations = get_active_stations_list()
        now = datetime.now(timezone.utc).isoformat()
        
        initialized = []
        skipped = []
        
        for station_config in active_stations:
            network = station_config['network']
            station = station_config['station']
            location = station_config.get('location', '')
            channel = station_config['channel']
            location_str = location if location and location != '--' else '--'
            station_key = f"{network}_{station}_{location_str}_{channel}"
            
            # Find first file timestamp for this station (regenerate for all stations)
            first_file_time = find_station_first_file_timestamp(s3, network, station, location, channel)
            
            if first_file_time:
                activated_at = first_file_time.isoformat()
                
                # Check if this is a regeneration or new entry
                is_regeneration = station_key in activation_log.get('stations', {})
                
                station_info = {
                    'network': network,
                    'station': station,
                    'location': location_str,
                    'channel': channel,
                    'volcano': station_config.get('volcano'),
                    'sample_rate': station_config.get('sample_rate'),
                    'activated_at': activated_at,
                    'deactivated_at': None
                }
                
                activation_log['stations'][station_key] = station_info
                activation_log['changes'].append({
                    'timestamp': now,
                    'type': 'regenerated' if is_regeneration else 'auto_initialized',
                    'station_key': station_key,
                    'station_info': station_info.copy()
                })
                
                initialized.append({
                    'station_key': station_key,
                    'activated_at': activated_at,
                    'regenerated': is_regeneration
                })
            else:
                # No files found - skip this station
                skipped.append(f"{station_key} (no files found)")
        
        # Save updated log (always save if there are any stations)
        if initialized:
            save_station_activations(activation_log)
        
        return jsonify({
            'success': True,
            'message': f'Initialized {len(initialized)} stations from existing files',
            'initialized': initialized,
            'skipped': skipped,
            'log_location': f'R2: {STATION_ACTIVATION_LOG_KEY}'
        })
    except Exception as e:
        import traceback
        return jsonify({
            'error': f'Failed to auto-initialize station activations: {str(e)}',
            'traceback': traceback.format_exc() if os.getenv('DEBUG', '').lower() == 'true' else None
        }), 500

@app.route('/validate/<period>/report')
def validate_report(period='24h'):
    """Generate human-readable text report from validation"""
    from flask import Response
    
    # Get JSON data from validate endpoint
    with app.test_client() as client:
        resp = client.get(f'/validate/{period}')
        data = resp.get_json()
    
    health = data.get('health', {})
    
    # Build text report
    lines = []
    lines.append("=" * 60)
    lines.append(f"  {health.get('icon', '❓')} STATUS: {health.get('status', 'UNKNOWN')}")
    lines.append("=" * 60)
    lines.append("")
    lines.append(f"Period: {data.get('period_hours', '?')} hours ({data.get('days_checked', '?')} days)")
    lines.append(f"Validation Time: {data.get('validation_time', 'N/A')[:19]}")
    lines.append("")
    lines.append(f"Message: {health.get('message', 'N/A')}")
    lines.append("")
    lines.append(f"Stations Checked: {health.get('stations_checked', 0)}")
    lines.append(f"  ✅ OK: {health.get('stations_ok', 0)}")
    lines.append(f"  ⚠️  With Issues: {health.get('stations_with_issues', 0)}")
    lines.append("")
    
    summary = data.get('summary', {})
    lines.append("Summary:")
    lines.append(f"  Missing Files: {summary.get('total_missing', 0)} files across {summary.get('missing_files', 0)} stations")
    lines.append(f"  Orphaned Files: {summary.get('total_orphaned', 0)} files across {summary.get('orphaned_files', 0)} stations")
    lines.append(f"  No Metadata: {summary.get('no_metadata', 0)} stations")
    lines.append(f"  Errors: {summary.get('error', 0)} stations")
    lines.append("")
    
    if not health.get('healthy', True):
        lines.append("Stations with Issues:")
        for station in data.get('stations', []):
            if station['status'] != 'OK':
                lines.append(f"  • {station['network']}.{station['station']} - {station['status']}")
                if station.get('orphaned_files'):
                    lines.append(f"      Orphaned: {len(station['orphaned_files'])} files")
                if station.get('missing_files'):
                    lines.append(f"      Missing: {len(station['missing_files'])} files")
                if station.get('issues'):
                    for issue in station['issues']:
                        lines.append(f"      {issue}")
        lines.append("")
    
    lines.append("=" * 60)
    lines.append("")
    
    return Response('\n'.join(lines), mimetype='text/plain')

@app.route('/validate')
@app.route('/validate/<period>')
def validate(period='24h'):
    """
    Validate R2 data integrity using metadata
    Checks: metadata vs actual files, orphaned files, missing files
    Examples: /validate/24h, /validate/2d, /validate/12h
    """
    from datetime import timedelta
    
    try:
        # Parse period using helper
        hours = parse_period(period)
    except (ValueError, AttributeError):
        return jsonify({'error': f'Invalid period format: {period}. Use format like "24h" or "2d"'}), 400
    
    try:
        # Get R2 client and active stations using helpers
        s3 = get_s3_client()
        active_stations = get_active_stations_list()
    except Exception as e:
        return jsonify({'error': f'Failed to initialize: {str(e)}'}), 500
    
    try:
        
        # Calculate time range
        now = datetime.now(timezone.utc)
        start_time = now - timedelta(hours=hours)
        dates_to_check = get_dates_in_period(start_time, now)
        
        # Results (health will be added at the end, but we initialize structure)
        results = {
            'validation_time': now.isoformat(),
            'period_hours': hours,
            'start_time': start_time.isoformat(),
            'end_time': now.isoformat(),
            'days_checked': len(dates_to_check),
            'total_stations': len(active_stations),
            'stations': []
        }
        
        # Validate each station across all dates
        for station_config in active_stations:
            network = station_config['network']
            volcano = station_config['volcano']
            station = station_config['station']
            location = station_config['location']
            channel = station_config['channel']
            sample_rate = station_config['sample_rate']
            location_str = location if location and location != '--' else '--'
            rate_str = f"{sample_rate:.2f}".rstrip('0').rstrip('.') if '.' in str(sample_rate) else str(int(sample_rate))
            
            station_result = {
                'network': network,
                'volcano': volcano,
                'station': station,
                'location': location_str,
                'channel': channel,
                'sample_rate': sample_rate,
                'metadata_chunks': {'10m': 0, '1h': 0, '6h': 0},
                'actual_files': {'10m': 0, '1h': 0, '6h': 0},
                'missing_files': [],
                'orphaned_files': [],
                'duplicates_found': {'10m': 0, '1h': 0, '6h': 0},
                'issues': []
            }
            
            try:
                # Validate across all dates in the period
                for check_date in dates_to_check:
                    year = check_date.year
                    month = f"{check_date.month:02d}"
                    day = f"{check_date.day:02d}"
                    date_str = check_date.strftime("%Y-%m-%d")
                    prefix = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/"
                    metadata_key = f"{prefix}{network}_{station}_{location_str}_{channel}_{rate_str}Hz_{date_str}.json"
                    
                    # Get metadata for this date
                    metadata = None
                    try:
                        response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
                        metadata = json.loads(response['Body'].read().decode('utf-8'))
                    except s3.exceptions.NoSuchKey:
                        # No metadata for this date - skip
                        continue
                    
                    # Check for duplicate metadata entries
                    for chunk_type in ['10m', '1h', '6h']:
                        chunks = metadata['chunks'].get(chunk_type, [])
                        start_times = [c['start'] for c in chunks]
                        duplicates = [st for st in start_times if start_times.count(st) > 1]
                        if duplicates:
                            unique_dupes = list(set(duplicates))
                            num_duplicates = len(duplicates)
                            station_result['duplicates_found'][chunk_type] = num_duplicates
                            station_result['issues'].append(f"Duplicate {chunk_type} metadata entries: {', '.join(unique_dupes)} ({num_duplicates} total duplicates)")
                    
                    # Build expected filenames from metadata for this date
                    expected_files = set()
                    for chunk_type in ['10m', '1h', '6h']:
                        station_result['metadata_chunks'][chunk_type] += len(metadata['chunks'].get(chunk_type, []))
                        for chunk in metadata['chunks'].get(chunk_type, []):
                            # Construct filename
                            start_time_str = chunk['start'].replace(':', '-')
                            end_time_str = chunk['end'].replace(':', '-')
                            filename = f"{network}_{station}_{location_str}_{channel}_{rate_str}Hz_{chunk_type}_{date_str}-{start_time_str}_to_{date_str}-{end_time_str}.bin.zst"
                            expected_files.add(filename)
                    
                    # List actual files in R2 for this date (now in subfolders by chunk type)
                    actual_files = set()
                    for chunk_type in ['10m', '1h', '6h']:
                        chunk_prefix = f"{prefix}{chunk_type}/"
                        response = s3.list_objects_v2(Bucket=R2_BUCKET_NAME, Prefix=chunk_prefix)
                        
                        if 'Contents' in response:
                            for obj in response['Contents']:
                                filename = obj['Key'].split('/')[-1]
                                if filename.endswith('.bin.zst'):
                                    actual_files.add(filename)
                                    station_result['actual_files'][chunk_type] += 1
                    
                    # Find missing files (in metadata but not in R2) for this date
                    missing = expected_files - actual_files
                    station_result['missing_files'].extend(sorted(list(missing)))
                    
                    # Find orphaned files (in R2 but not in metadata) for this date
                    orphaned = actual_files - expected_files
                    station_result['orphaned_files'].extend(sorted(list(orphaned)))
                
                # Report issues (after all dates checked)
                if len(station_result['missing_files']) > 0:
                    station_result['issues'].append(f"{len(station_result['missing_files'])} files listed in metadata but missing in R2")
                if len(station_result['orphaned_files']) > 0:
                    station_result['issues'].append(f"{len(station_result['orphaned_files'])} orphaned files in R2 (not in metadata)")
                
                # Determine status
                if len(station_result['missing_files']) == 0 and len(station_result['orphaned_files']) == 0:
                    station_result['status'] = 'OK'
                elif len(station_result['missing_files']) > 0:
                    station_result['status'] = 'MISSING_FILES'
                elif len(station_result['orphaned_files']) > 0:
                    station_result['status'] = 'ORPHANED_FILES'
            
            except Exception as e:
                station_result['issues'].append(f"Validation error: {str(e)}")
                station_result['status'] = 'ERROR'
            
            results['stations'].append(station_result)
        
        # Summary
        ok_count = sum(1 for s in results['stations'] if s.get('status') == 'OK')
        missing_count = sum(1 for s in results['stations'] if s.get('status') == 'MISSING_FILES')
        orphaned_count = sum(1 for s in results['stations'] if s.get('status') == 'ORPHANED_FILES')
        no_metadata_count = sum(1 for s in results['stations'] if s.get('status') == 'NO_METADATA')
        error_count = sum(1 for s in results['stations'] if s.get('status') == 'ERROR')
        total_missing = sum(len(s.get('missing_files', [])) for s in results['stations'])
        total_orphaned = sum(len(s.get('orphaned_files', [])) for s in results['stations'])
        total_duplicates = sum(sum(s.get('duplicates_found', {}).values()) for s in results['stations'])
        
        # Determine overall health
        all_healthy = (ok_count == len(active_stations) and 
                       missing_count == 0 and 
                       orphaned_count == 0 and 
                       no_metadata_count == 0 and 
                       error_count == 0 and
                       total_duplicates == 0)
        
        results['summary'] = {
            'ok': ok_count,
            'missing_files': missing_count,
            'orphaned_files': orphaned_count,
            'no_metadata': no_metadata_count,
            'error': error_count,
            'total_missing': total_missing,
            'total_orphaned': total_orphaned,
            'total_duplicates': total_duplicates
        }
        
        # Human-readable report
        if all_healthy:
            status_icon = '✅'
            status_text = 'HEALTHY'
            status_message = f'All {len(active_stations)} stations are healthy. Metadata matches files perfectly.'
        else:
            status_icon = '⚠️'
            status_text = 'ISSUES DETECTED'
            issues = []
            if missing_count > 0:
                issues.append(f'{missing_count} stations with missing files ({total_missing} files)')
            if orphaned_count > 0:
                issues.append(f'{orphaned_count} stations with orphaned files ({total_orphaned} files)')
            if no_metadata_count > 0:
                issues.append(f'{no_metadata_count} stations without metadata')
            if error_count > 0:
                issues.append(f'{error_count} stations with errors')
            status_message = ' | '.join(issues)
        
        # Build final response with health at the top
        response = {
            'health': {
                'status': status_text,
                'healthy': all_healthy,
                'icon': status_icon,
                'message': status_message,
                'stations_checked': len(active_stations),
                'stations_ok': ok_count,
                'stations_with_issues': len(active_stations) - ok_count
            },
            'summary': results['summary'],
            'validation_time': results['validation_time'],
            'period_hours': results['period_hours'],
            'days_checked': results['days_checked'],
            'start_time': results['start_time'],
            'end_time': results['end_time'],
            'total_stations': results['total_stations'],
            'stations': results['stations']
        }
        
        return jsonify(response)
    except Exception as e:
        import traceback
        return jsonify({
            'error': f'Validation failed: {str(e)}',
            'traceback': traceback.format_exc() if os.getenv('DEBUG', '').lower() == 'true' else None
        }), 500

@app.route('/repair/<period>/report')
def repair_report(period='24h'):
    """Generate human-readable text report from repair"""
    from flask import Response
    
    # Get JSON data from repair endpoint
    with app.test_client() as client:
        resp = client.get(f'/repair/{period}')
        data = resp.get_json()
    
    health = data.get('health', {})
    
    # Build text report
    lines = []
    lines.append("=" * 60)
    lines.append(f"  {health.get('status', 'UNKNOWN')}")
    lines.append("=" * 60)
    lines.append("")
    lines.append(f"Period: {data.get('period_hours', '?')} hours ({data.get('days_checked', '?')} days)")
    lines.append(f"Repair Time: {data.get('repair_time', 'N/A')[:19]}")
    lines.append("")
    lines.append(f"Message: {health.get('message', 'N/A')}")
    lines.append("")
    lines.append(f"Files Adopted: {data.get('files_adopted', 0)}")
    lines.append(f"Files Rejected: {data.get('files_rejected', 0)}")
    lines.append(f"Stations Repaired: {data.get('stations_repaired', 0)}")
    lines.append("")
    
    if data.get('stations_repaired', 0) > 0:
        lines.append("Repaired Stations:")
        for station in data.get('stations', []):
            if station['status'] == 'REPAIRED':
                lines.append(f"  • {station['network']}.{station['station']}")
                lines.append(f"      Adopted: {len(station['adopted'])} files")
                if station.get('rejected'):
                    lines.append(f"      Rejected: {len(station['rejected'])} files")
                if station.get('issues'):
                    for issue in station['issues']:
                        lines.append(f"      {issue}")
        lines.append("")
    
    lines.append("=" * 60)
    lines.append("")
    
    return Response('\n'.join(lines), mimetype='text/plain')

@app.route('/repair')
@app.route('/repair/<period>')
def repair(period='24h'):
    """
    Repair metadata by adopting valid orphaned files
    Validates orphans: correct samples, proper naming, then adds to metadata
    Examples: /repair/24h, /repair/2d, /repair/1h
    """
    from datetime import timedelta
    
    # Parse period using helper
    hours = parse_period(period)
    
    # Get R2 client and active stations using helpers
    s3 = get_s3_client()
    active_stations = get_active_stations_list()
    
    now = datetime.now(timezone.utc)
    start_time = now - timedelta(hours=hours)
    dates_to_check = get_dates_in_period(start_time, now)
    
    results = {
        'repair_time': now.isoformat(),
        'period_hours': hours,
        'start_time': start_time.isoformat(),
        'days_checked': len(dates_to_check),
        'stations_repaired': 0,
        'files_adopted': 0,
        'files_rejected': 0,
        'stations': []
    }
    
    # Process each station
    for station_config in active_stations:
        network = station_config['network']
        volcano = station_config['volcano']
        station = station_config['station']
        location = station_config['location']
        channel = station_config['channel']
        sample_rate = station_config['sample_rate']
        location_str = location if location and location != '--' else '--'
        rate_str = f"{sample_rate:.2f}".rstrip('0').rstrip('.') if '.' in str(sample_rate) else str(int(sample_rate))
        
        station_result = {
            'network': network,
            'station': station,
            'adopted': [],
            'rejected': [],
            'issues': []
        }
        
        try:
            # Process each date in the period
            for check_date in dates_to_check:
                year = check_date.year
                month = f"{check_date.month:02d}"
                date_str = check_date.strftime("%Y-%m-%d")
                day = f"{check_date.day:02d}"
                
                # Build paths for THIS date's folder
                prefix = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/"
                metadata_key = f"{prefix}{network}_{station}_{location_str}_{channel}_{rate_str}Hz_{date_str}.json"
                
                # Load or create metadata for this date
                metadata = None
                try:
                    response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
                    metadata = json.loads(response['Body'].read().decode('utf-8'))
                except s3.exceptions.NoSuchKey:
                    # Create new metadata structure
                    metadata = {
                        'date': date_str,
                        'network': network,
                        'volcano': volcano,
                        'station': station,
                        'location': location if location != '--' else '',
                        'channel': channel,
                        'sample_rate': sample_rate,
                        'created_at': now.isoformat().replace('+00:00', 'Z'),
                        'complete_day': False,
                        'chunks': {
                            '10m': [],
                            '1h': [],
                            '6h': []
                        }
                    }
                    station_result['issues'].append(f'Created new metadata for {date_str}')
                
                # Build set of existing files in metadata
                existing_entries = set()
                for chunk_type in ['10m', '1h', '6h']:
                    for chunk in metadata['chunks'].get(chunk_type, []):
                        start_time_str = chunk['start'].replace(':', '-')
                        end_time_str = chunk['end'].replace(':', '-')
                        filename = f"{network}_{station}_{location_str}_{channel}_{rate_str}Hz_{chunk_type}_{date_str}-{start_time_str}_to_{date_str}-{end_time_str}.bin.zst"
                        existing_entries.add(filename)
                
                # List files in this date's folder (now in subfolders by chunk type)
                orphans = []
                for chunk_type in ['10m', '1h', '6h']:
                    chunk_prefix = f"{prefix}{chunk_type}/"
                    response = s3.list_objects_v2(Bucket=R2_BUCKET_NAME, Prefix=chunk_prefix)
                    
                    if 'Contents' in response:
                        for obj in response['Contents']:
                            filename = obj['Key'].split('/')[-1]
                            if filename.endswith('.bin.zst') and filename not in existing_entries:
                                orphans.append({'filename': filename, 'size': obj['Size'], 'chunk_type': chunk_type})
                
                # Validate and adopt orphans (may belong to any date in the period)
                for orphan in orphans:
                    filename = orphan['filename']
                    
                    # Parse filename
                    try:
                        parts = filename.replace('.bin.zst', '').split('_')
                        
                        # Find chunk type
                        chunk_type = None
                        time_idx = None
                        for i, part in enumerate(parts):
                            if part in ['10m', '1h', '6h']:
                                chunk_type = part
                                time_idx = i + 1
                                break
                        
                        if not chunk_type or not time_idx:
                            station_result['rejected'].append(f"{filename} (invalid format)")
                            results['files_rejected'] += 1
                            continue
                        
                        # Extract timestamps
                        time_part = '_'.join(parts[time_idx:])
                        times = time_part.split('_to_')
                        if len(times) != 2:
                            station_result['rejected'].append(f"{filename} (invalid time format)")
                            results['files_rejected'] += 1
                            continue
                        
                        # Extract date from filename (first timestamp contains YYYY-MM-DD-HH-MM-SS)
                        # Format: YYYY-MM-DD-HH-MM-SS_to_YYYY-MM-DD-HH-MM-SS
                        start_full = times[0].split('-')
                        end_full = times[1].split('-')
                        
                        if len(start_full) < 6 or len(end_full) < 6:
                            station_result['rejected'].append(f"{filename} (invalid timestamp format)")
                            results['files_rejected'] += 1
                            continue
                        
                        # Extract date from filename (first 3 parts: YYYY-MM-DD)
                        file_date_str = '-'.join(start_full[:3])
                        
                        # Extract time parts (last 3 parts: HH-MM-SS)
                        start_parts = start_full[3:6]
                        end_parts = end_full[3:6]
                        
                        if len(start_parts) != 3 or len(end_parts) != 3:
                            station_result['rejected'].append(f"{filename} (invalid timestamp)")
                            results['files_rejected'] += 1
                            continue
                        
                        # Skip files outside our date range (they'll be processed in their own date iteration)
                        if file_date_str not in [d.strftime("%Y-%m-%d") for d in dates_to_check]:
                            continue
                        
                        # Use existing metadata if file belongs to date being checked, otherwise load/create for file's date
                        if file_date_str == date_str:
                            # File belongs to date we're checking - use existing metadata variable
                            file_metadata = metadata
                            file_metadata_key = metadata_key
                        else:
                            # File belongs to different date - load/create metadata for that date
                            file_year = int(file_date_str.split('-')[0])
                            file_month = f"{int(file_date_str.split('-')[1]):02d}"
                            file_prefix = f"data/{file_year}/{file_month}/{network}/{volcano}/{station}/{location_str}/{channel}/"
                            file_metadata_key = f"{file_prefix}{network}_{station}_{location_str}_{channel}_{rate_str}Hz_{file_date_str}.json"
                            
                            try:
                                response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=file_metadata_key)
                                file_metadata = json.loads(response['Body'].read().decode('utf-8'))
                            except s3.exceptions.NoSuchKey:
                                # Create new metadata for this file's date
                                file_metadata = {
                                    'date': file_date_str,
                                    'network': network,
                                    'volcano': volcano,
                                    'station': station,
                                    'location': location if location != '--' else '',
                                    'channel': channel,
                                    'sample_rate': sample_rate,
                                    'created_at': now.isoformat().replace('+00:00', 'Z'),
                                    'complete_day': False,
                                    'chunks': {
                                        '10m': [],
                                        '1h': [],
                                        '6h': []
                                    }
                                }
                                station_result['issues'].append(f'Created new metadata for {file_date_str} (while checking {date_str})')
                        
                        # Check if file already in metadata for its date
                        file_existing_entries = set()
                        for ct in ['10m', '1h', '6h']:
                            for chunk in file_metadata['chunks'].get(ct, []):
                                start_time_str = chunk['start'].replace(':', '-')
                                end_time_str = chunk['end'].replace(':', '-')
                                expected_filename = f"{network}_{station}_{location_str}_{channel}_{rate_str}Hz_{ct}_{file_date_str}-{start_time_str}_to_{file_date_str}-{end_time_str}.bin.zst"
                                file_existing_entries.add(expected_filename)
                        
                        if filename in file_existing_entries:
                            # Already in metadata, skip
                            continue
                        
                        start_time_hms = f"{start_parts[0]}:{start_parts[1]}:{start_parts[2]}"
                        end_time_hms = f"{end_parts[0]}:{end_parts[1]}:{end_parts[2]}"
                        
                        # Validate sample count based on chunk type and sample rate
                        expected_samples = {
                            '10m': 10 * 60 * sample_rate,
                            '1h': 60 * 60 * sample_rate,
                            '6h': 6 * 60 * 60 * sample_rate
                        }
                        
                        expected_size = expected_samples[chunk_type] * 4  # int32 = 4 bytes
                        # Allow 30-60% size due to compression (typical zstd ratio)
                        min_size = expected_size * 0.25
                        max_size = expected_size * 0.65
                        
                        if not (min_size <= orphan['size'] <= max_size):
                            station_result['rejected'].append(f"{filename} (unexpected size: {orphan['size']} bytes, expected ~{int(expected_size * 0.5)} bytes)")
                            results['files_rejected'] += 1
                            continue
                        
                        # Looks valid - adopt it to its own date's metadata!
                        chunk_meta = {
                            'start': start_time_hms,
                            'end': end_time_hms,
                            'min': 0,  # Unknown (file not decompressed)
                            'max': 0,  # Unknown
                            'samples': int(expected_samples[chunk_type]),
                            'gap_count': 0,  # Unknown
                            'gap_samples_filled': 0  # Unknown
                        }
                        
                        file_metadata['chunks'][chunk_type].append(chunk_meta)
                        
                        # Sort chunks chronologically
                        file_metadata['chunks']['10m'].sort(key=lambda c: c['start'])
                        file_metadata['chunks']['1h'].sort(key=lambda c: c['start'])
                        file_metadata['chunks']['6h'].sort(key=lambda c: c['start'])
                        
                        # Update complete_day flag
                        if len(file_metadata['chunks']['10m']) >= 144:
                            file_metadata['complete_day'] = True
                        
                        # Upload metadata for this file's date
                        s3.put_object(
                            Bucket=R2_BUCKET_NAME,
                            Key=file_metadata_key,
                            Body=json.dumps(file_metadata, indent=2).encode('utf-8'),
                            ContentType='application/json'
                        )
                        
                        station_result['adopted'].append(filename)
                        results['files_adopted'] += 1
                        
                        # Track if we modified metadata for the date being checked
                        if file_date_str == date_str:
                            date_adopted = True
                        
                    except Exception as e:
                        station_result['rejected'].append(f"{filename} (parse error: {str(e)})")
                        results['files_rejected'] += 1
                        continue
            
            # Set station status
            if len(station_result['adopted']) > 0:
                results['stations_repaired'] += 1
                station_result['status'] = 'REPAIRED'
            else:
                station_result['status'] = 'NO_ORPHANS'
        
        except Exception as e:
            station_result['issues'].append(f"Repair error: {str(e)}")
            station_result['status'] = 'ERROR'
        
        results['stations'].append(station_result)
    
    # Summary
    response = {
        'health': {
            'status': '✅ REPAIR COMPLETE' if results['files_adopted'] > 0 else 'ℹ️ NO REPAIRS NEEDED',
            'repaired': results['stations_repaired'] > 0,
            'message': f"Adopted {results['files_adopted']} files, rejected {results['files_rejected']} files across {results['stations_repaired']} stations"
        },
        'repair_time': results['repair_time'],
        'period_hours': results['period_hours'],
        'days_checked': results['days_checked'],
        'start_time': results['start_time'],
        'stations_repaired': results['stations_repaired'],
        'files_adopted': results['files_adopted'],
        'files_rejected': results['files_rejected'],
        'stations': results['stations']
    }
    
    return jsonify(response)

@app.route('/deduplicate')
@app.route('/deduplicate/<period>')
def deduplicate(period='24h'):
    """
    Deduplicate metadata entries - removes duplicate start times
    
    Examples: 
        /deduplicate          - Last 24 hours (default)
        /deduplicate/24h      - Last 24 hours
        /deduplicate/2d       - Last 2 days
        /deduplicate/1h       - Last 1 hour
        /deduplicate/all      - ALL metadata files (entire dataset)
    """
    from datetime import timedelta
    
    # Get R2 client and active stations using helpers
    s3 = get_s3_client()
    active_stations = get_active_stations_list()
    
    # Calculate time range
    now = datetime.now(timezone.utc)
    
    if period.lower() == 'all':
        # Scan ALL metadata files
        start_time = None
        dates_to_check = None
        scan_mode = 'all'
    else:
        # Parse period using helper
        hours = parse_period(period)
        start_time = now - timedelta(hours=hours)
        dates_to_check = get_dates_in_period(start_time, now)
        scan_mode = 'time_range'
    
    total_duplicates_removed = 0
    stations_cleaned = []
    files_processed = 0
    
    if scan_mode == 'all':
        # Scan ALL metadata files in R2
        print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 🧹 Deduplicating ALL metadata files...")
        
        paginator = s3.get_paginator('list_objects_v2')
        pages = paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix='data/')
        
        for page in pages:
            if 'Contents' not in page:
                continue
            
            for obj in page['Contents']:
                key = obj['Key']
                
                # Only process .json metadata files
                if not key.endswith('.json'):
                    continue
                
                try:
                    # Load metadata
                    response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=key)
                    metadata = json.loads(response['Body'].read().decode('utf-8'))
                    
                    metadata_changed = False
                    file_dupes_removed = 0
                    
                    # Deduplicate each chunk type
                    for chunk_type in ['10m', '1h', '6h']:
                        chunks = metadata['chunks'].get(chunk_type, [])
                        original_count = len(chunks)
                        
                        # Remove duplicates (keep first occurrence)
                        seen_starts = set()
                        deduplicated = []
                        for chunk in chunks:
                            if chunk['start'] not in seen_starts:
                                deduplicated.append(chunk)
                                seen_starts.add(chunk['start'])
                        
                        # Sort chronologically
                        deduplicated.sort(key=lambda c: c['start'])
                        
                        # Update metadata
                        metadata['chunks'][chunk_type] = deduplicated
                        
                        dupes_removed = original_count - len(deduplicated)
                        if dupes_removed > 0:
                            metadata_changed = True
                            file_dupes_removed += dupes_removed
                    
                    # Upload cleaned metadata if changed
                    if metadata_changed:
                        s3.put_object(
                            Bucket=R2_BUCKET_NAME,
                            Key=key,
                            Body=json.dumps(metadata, indent=2).encode('utf-8'),
                            ContentType='application/json'
                        )
                        
                        station_id = f"{metadata.get('network', '?')}.{metadata.get('station', '?')}.{metadata.get('location', '--')}.{metadata.get('channel', '?')}"
                        stations_cleaned.append({
                            'station': station_id,
                            'date': metadata.get('date', '?'),
                            'file': key,
                            'duplicates_removed': file_dupes_removed
                        })
                        total_duplicates_removed += file_dupes_removed
                    
                    files_processed += 1
                
                except Exception as e:
                    print(f"Warning: Error processing {key}: {e}")
                    continue
    else:
        # Time-based scan (existing logic)
        print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 🧹 Deduplicating metadata from last {hours} hours...")
        
        for station_info in active_stations:
            network = station_info['network']
            volcano = station_info['volcano']
            station = station_info['station']
            location = station_info['location']
            channel = station_info['channel']
            sample_rate = station_info['sample_rate']
            
            location_str = location if location and location != '--' else '--'
            rate_str = f"{sample_rate:.2f}".rstrip('0').rstrip('.') if '.' in str(sample_rate) else str(int(sample_rate))
            
            station_id = f"{network}.{station}.{location_str}.{channel}"
            station_dupes_removed = 0
            
            for check_date in dates_to_check:
                year = check_date.year
                month = f"{check_date.month:02d}"
                day = f"{check_date.day:02d}"
                date_str = check_date.strftime("%Y-%m-%d")
                prefix = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/"
                
                # Try NEW format first (without sample rate)
                metadata_filename = f"{network}_{station}_{location_str}_{channel}_{date_str}.json"
                metadata_key = f"{prefix}{metadata_filename}"
                
                metadata = None
                try:
                    # Load metadata (NEW format)
                    response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
                    metadata = json.loads(response['Body'].read().decode('utf-8'))
                except s3.exceptions.NoSuchKey:
                    # Try OLD format (with sample rate)
                    old_metadata_filename = f"{network}_{station}_{location_str}_{channel}_{rate_str}Hz_{date_str}.json"
                    old_metadata_key = f"{prefix}{old_metadata_filename}"
                    try:
                        response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=old_metadata_key)
                        metadata = json.loads(response['Body'].read().decode('utf-8'))
                        # Use OLD key for this update, but next collection cycle will migrate to NEW
                        metadata_key = old_metadata_key
                    except s3.exceptions.NoSuchKey:
                        pass  # Will skip this date
                
                if metadata:
                    
                    metadata_changed = False
                    
                    # Deduplicate each chunk type
                    for chunk_type in ['10m', '1h', '6h']:
                        chunks = metadata['chunks'].get(chunk_type, [])
                        original_count = len(chunks)
                        
                        # Remove duplicates (keep first occurrence)
                        seen_starts = set()
                        deduplicated = []
                        for chunk in chunks:
                            if chunk['start'] not in seen_starts:
                                deduplicated.append(chunk)
                                seen_starts.add(chunk['start'])
                        
                        # Sort chronologically
                        deduplicated.sort(key=lambda c: c['start'])
                        
                        # Update metadata
                        metadata['chunks'][chunk_type] = deduplicated
                        
                        dupes_removed = original_count - len(deduplicated)
                        if dupes_removed > 0:
                            metadata_changed = True
                            station_dupes_removed += dupes_removed
                    
                    # Upload cleaned metadata if changed
                    if metadata_changed:
                        s3.put_object(
                            Bucket=R2_BUCKET_NAME,
                            Key=metadata_key,
                            Body=json.dumps(metadata, indent=2).encode('utf-8'),
                            ContentType='application/json'
                        )
                        files_processed += 1
            
            if station_dupes_removed > 0:
                stations_cleaned.append({
                    'station': station_id,
                    'duplicates_removed': station_dupes_removed
                })
                total_duplicates_removed += station_dupes_removed
    
    result = {
        'scan_mode': scan_mode,
        'period': period,
        'deduplicate_time': datetime.now(timezone.utc).isoformat(),
        'total_duplicates_removed': total_duplicates_removed,
        'stations_cleaned': len(stations_cleaned),
        'files_processed': files_processed,
        'details': stations_cleaned
    }
    
    # Add period_hours for time_range mode
    if scan_mode == 'time_range':
        result['period_hours'] = hours
    
    # Add friendly message
    if total_duplicates_removed == 0:
        result['message'] = '✅ No duplicates found - metadata is clean!'
    else:
        if scan_mode == 'all':
            result['message'] = f'✅ Removed {total_duplicates_removed} duplicate entries from {len(stations_cleaned)} files (scanned {files_processed} total files)'
        else:
            result['message'] = f'✅ Removed {total_duplicates_removed} duplicate entries from {len(stations_cleaned)} stations'
    
    return jsonify(result)

@app.route('/nuke')
def nuke():
    """
    🔥 DANGER: Delete ALL data from R2 storage
    Deletes everything under data/ prefix
    Use for development/testing only!
    """
    # Initialize R2 client
    R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID', '66f906f29f28b08ae9c80d4f36e25c7a')
    R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '9e1cf6c395172f108c2150c52878859f')
    R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec')
    R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')
    
    s3 = boto3.client(
        's3',
        endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name='auto'
    )
    
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 🔥 NUKE INITIATED - Deleting all data and logs from R2...")
    
    deleted_count = 0
    deleted_files = []
    
    try:
        # Delete both data/ and collector_logs/ prefixes
        prefixes_to_delete = ['data/', 'collector_logs/']
        paginator = s3.get_paginator('list_objects_v2')
        
        for prefix in prefixes_to_delete:
            print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 🗑️  Deleting {prefix}...")
            pages = paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix=prefix)
            
            for page in pages:
                if 'Contents' not in page:
                    continue
                
                # Delete in batches of 1000 (R2 limit)
                objects_to_delete = [{'Key': obj['Key']} for obj in page['Contents']]
                
                if objects_to_delete:
                    response = s3.delete_objects(
                        Bucket=R2_BUCKET_NAME,
                        Delete={'Objects': objects_to_delete}
                    )
                    
                    deleted = response.get('Deleted', [])
                    deleted_count += len(deleted)
                    deleted_files.extend([obj['Key'] for obj in deleted])
                    
                    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 🗑️  Deleted {len(deleted)} objects from {prefix} (total: {deleted_count})")
        
        print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] ✅ NUKE COMPLETE - Deleted {deleted_count} objects")
        
        return jsonify({
            'status': 'nuked',
            'deleted_count': deleted_count,
            'message': f'Successfully deleted {deleted_count} objects from R2',
            'deleted_files': deleted_files[:100] if len(deleted_files) > 100 else deleted_files,
            'truncated': len(deleted_files) > 100
        })
        
    except Exception as e:
        print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] ❌ NUKE FAILED: {e}")
        return jsonify({
            'status': 'error',
            'message': str(e),
            'deleted_count': deleted_count
        }), 500

@app.route('/trigger')
def trigger_collection():
    """
    🚀 Manually trigger a data collection cycle immediately
    Bypasses the scheduler and runs collection right now
    """
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 🎯 Manual trigger requested")
    
    # Run collection in a background thread so we can return immediately
    import threading
    thread = threading.Thread(target=run_cron_job)
    thread.start()
    
    return jsonify({
        'status': 'triggered',
        'message': 'Collection cycle started',
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'note': 'Check /status to monitor progress'
    })

def wait_until_next_run():
    """
    Wait until the next scheduled run time.
    Production: :02, :12, :22, :32, :42, :52
    Local: :03, :13, :23, :33, :43, :53 (offset by SCHEDULE_OFFSET_MINUTES)
    """
    now = datetime.now(timezone.utc)
    current_minute = now.minute
    
    # Base run minutes (2, 12, 22, 32, 42, 52) + offset
    base_minutes = [2, 12, 22, 32, 42, 52]
    run_minutes = [(m + SCHEDULE_OFFSET_MINUTES) % 60 for m in base_minutes]
    run_minutes.sort()
    
    next_minute = None
    
    for minute in run_minutes:
        if minute > current_minute:
            next_minute = minute
            break
    
    if next_minute is None:
        # Next run is in the next hour
        next_minute = run_minutes[0]
        next_hour = now.hour + 1
        if next_hour >= 24:
            next_hour = 0
        
        # Calculate seconds until next run
        seconds_until_next_hour = 3600 - (now.minute * 60 + now.second)
        seconds_until_next_run = seconds_until_next_hour + (next_minute * 60)
        
        # Update next run time
        from datetime import timedelta
        status['next_run'] = (now + timedelta(seconds=seconds_until_next_run)).isoformat()
    else:
        # Next run is in the current hour
        minutes_until = next_minute - current_minute
        seconds_until_next_run = minutes_until * 60 - now.second
        
        # Update next run time
        from datetime import timedelta
        status['next_run'] = (now + timedelta(seconds=seconds_until_next_run)).isoformat()
    
    env_label = "PRODUCTION" if IS_PRODUCTION else "LOCAL"
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] [{env_label}] Next run in {seconds_until_next_run} seconds (at :{next_minute:02d})")
    time.sleep(seconds_until_next_run)


def auto_heal_gaps():
    """
    Automated self-healing: Detect and backfill gaps from last 6 hours.
    Runs every 6 hours (at 00:02, 06:02, 12:02, 18:02).
    Checks all active stations from stations_config.json.
    """
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 🔍 Auto-heal: Checking for gaps in last 6h...")
    
    try:
        # Get R2 client and active stations
        s3 = get_s3_client()
        active_stations = get_active_stations_list()  # Dynamically loads all active stations
        
        # Detect gaps in last 6 hours
        now = datetime.now(timezone.utc)
        from datetime import timedelta
        start_time = now - timedelta(hours=6)
        
        # Find earliest file to clamp start time
        earliest_file = find_earliest_data_timestamp(s3)
        if earliest_file and start_time < earliest_file:
            start_time = earliest_file
        
        # Run gap detection for all stations
        total_gaps = 0
        gaps_by_station = []
        
        for station_info in active_stations:
            gaps = detect_gaps_for_station(
                s3, 
                station_info['network'], 
                station_info['volcano'], 
                station_info['station'],
                station_info.get('location', ''), 
                station_info['channel'], 
                station_info['sample_rate'],
                start_time, now,
                chunk_types=['10m', '1h', '6h'],
                last_run_completed=None  # Auto-heal: check everything (runs after collection finishes)
            )
            
            station_gap_count = sum(len(gaps[ct]) for ct in ['10m', '1h', '6h'])
            if station_gap_count > 0:
                total_gaps += station_gap_count
                gaps_by_station.append({
                    'station_info': station_info,
                    'gaps': gaps
                })
        
        print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 🔍 Found {total_gaps} gaps across {len(gaps_by_station)} stations")
        
        # If gaps found, auto-backfill
        if total_gaps > 0:
            print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 🔧 Auto-heal: Backfilling {total_gaps} gaps...")
            
            healed = 0
            failed = 0
            skipped = 0
            
            for station_data in gaps_by_station:
                station_info = station_data['station_info']
                gaps = station_data['gaps']
                
                for chunk_type in ['10m', '1h', '6h']:
                    for gap in gaps[chunk_type]:
                        start_time = datetime.fromisoformat(gap['start'].replace('Z', '+00:00'))
                        end_time = datetime.fromisoformat(gap['end'].replace('Z', '+00:00'))
                        
                        status_result, error_info = process_station_window(
                            network=station_info['network'],
                            station=station_info['station'],
                            location=station_info.get('location', ''),
                            channel=station_info['channel'],
                            volcano=station_info['volcano'],
                            sample_rate=station_info['sample_rate'],
                            start_time=start_time,
                            end_time=end_time,
                            chunk_type=chunk_type
                        )
                        
                        if status_result == 'success':
                            healed += 1
                        elif status_result == 'skipped':
                            skipped += 1
                        else:
                            failed += 1
            
            print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] ✅ Auto-heal complete: {healed} healed, {failed} failed, {skipped} skipped")
        else:
            print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] ✅ Auto-heal: No gaps found - system is healthy!")
    
    except Exception as e:
        print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] ❌ Auto-heal failed: {e}")
        import traceback
        traceback.print_exc()


def determine_fetch_windows(current_time, iris_delay_minutes=2):
    """
    Determine what time windows to fetch based on current time.
    Returns list of (start_time, end_time, chunk_type) tuples.
    
    Logic:
    - Always: 10-minute chunk
    - At top of each hour: 1-hour chunk
    - At 6-hour checkpoints (00:02, 06:02, 12:02, 18:02): 6-hour chunk
    """
    from datetime import timedelta
    windows = []
    
    # Account for IRIS delay
    effective_time = current_time - timedelta(minutes=iris_delay_minutes)
    
    # 10-minute chunk (always)
    minute = effective_time.minute
    quantized_minute = (minute // 10) * 10
    ten_min_end = effective_time.replace(minute=quantized_minute, second=0, microsecond=0)
    ten_min_start = ten_min_end - timedelta(minutes=10)
    windows.append((ten_min_start, ten_min_end, '10m'))
    
    # 1-hour chunk (at top of every hour)
    if quantized_minute == 0:
        one_hour_end = effective_time.replace(minute=0, second=0, microsecond=0)
        one_hour_start = one_hour_end - timedelta(hours=1)
        windows.append((one_hour_start, one_hour_end, '1h'))
    
    # 6-hour checkpoint (at 00:02, 06:02, 12:02, 18:02)
    if effective_time.hour % 6 == 0 and quantized_minute == 0:
        six_hour_end = effective_time.replace(minute=0, second=0, microsecond=0)
        six_hour_start = six_hour_end - timedelta(hours=6)
        windows.append((six_hour_start, six_hour_end, '6h'))
    
    return windows


def run_cron_job():
    """Execute the data collection cycle directly (no subprocess)"""
    now = datetime.now(timezone.utc)
    
    status['currently_running'] = True
    status['last_run_started'] = now.isoformat()
    status['total_runs'] += 1
    
    print(f"[{now.strftime('%Y-%m-%d %H:%M:%S UTC')}] ========== Starting data collection ==========")
    
    # Check if this is a 6-hour checkpoint (will trigger auto-heal AFTER collection)
    should_auto_heal = (now.hour % 6 == 0 and now.minute in [0, 1, 2, 3, 4])
    
    try:
        # Determine what time windows to fetch
        windows = determine_fetch_windows(now)
        
        print(f"[{now.strftime('%Y-%m-%d %H:%M:%S UTC')}] Current time: {now.strftime('%Y-%m-%d %H:%M:%S UTC')}")
        print(f"[{now.strftime('%Y-%m-%d %H:%M:%S UTC')}] Windows to fetch: {len(windows)}")
        for start, end, chunk_type in windows:
            print(f"[{now.strftime('%Y-%m-%d %H:%M:%S UTC')}]   {chunk_type}: {start.strftime('%Y-%m-%d %H:%M:%S')} to {end.strftime('%H:%M:%S')}")
        
        # Load active stations
        active_stations = get_active_stations_list()
        print(f"[{now.strftime('%Y-%m-%d %H:%M:%S UTC')}] Active stations: {len(active_stations)}")
        print("")
        
        if not active_stations:
            print(f"[{now.strftime('%Y-%m-%d %H:%M:%S UTC')}] ⚠️ No active stations configured - skipping collection")
            status['successful_runs'] += 1
            return
        
        # Process each station for each window
        total_tasks = len(active_stations) * len(windows)
        current_task = 0
        successful = 0
        skipped = 0
        failed = 0
        failure_details = []
        
        for station_config in active_stations:
            network = station_config['network']
            volcano = station_config['volcano']
            station = station_config['station']
            location = station_config.get('location', '')
            channel = station_config['channel']
            sample_rate = station_config['sample_rate']
            
            for start, end, chunk_type in windows:
                current_task += 1
                print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] [{current_task}/{total_tasks}] Processing...")
                
                result_status, error_info = process_station_window(
                    network, station, location, channel, volcano, sample_rate,
                    start, end, chunk_type
                )
                
                if result_status == 'success':
                    successful += 1
                elif result_status == 'skipped':
                    skipped += 1
                elif result_status == 'failed':
                    failed += 1
                    if error_info:
                        failure_details.append(error_info)
                
                # Small delay between requests
                if current_task < total_tasks:
                    time.sleep(1)
        
        # Summary
        print("")
        print("=" * 100)
        print("COLLECTION COMPLETE")
        print("=" * 100)
        print(f"Total tasks: {total_tasks}")
        print(f"Successful: {successful}")
        print(f"Skipped: {skipped}")
        print(f"Failed: {failed}")
        print("=" * 100)
        
        # If all tasks succeeded or were skipped (no failures), mark as successful
        if failed == 0:
            print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] ✅ Data collection completed successfully")
            status['successful_runs'] += 1
            
            # Run auto-heal AFTER successful collection at 6-hour checkpoints
            if should_auto_heal:
                auto_heal_gaps()
        else:
            # Some tasks failed - record failure
            failure_time = datetime.now(timezone.utc).isoformat()
            error_msg = f"Collection completed with {failed} failures out of {total_tasks} tasks"
            
            # Add first few failure details to error message
            if failure_details:
                error_msg += "\nFirst failures:"
                for i, failure in enumerate(failure_details[:3]):
                    error_msg += f"\n  - {failure['station']} ({failure['chunk_type']}): {failure['error']}"
            
            print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] ⚠️ Collection completed with {failed} failures")
            
            # Record failure
            failure_info = {
                'timestamp': failure_time,
                'error': error_msg,
                'exit_code': None,
                'type': 'collection_partial_failure',
                'details': {
                    'total_tasks': total_tasks,
                    'successful': successful,
                    'skipped': skipped,
                    'failed': failed,
                    'failure_details': failure_details
                }
            }
            failure_summary = {
                'timestamp': failure_time,
                'summary': f"{failed}/{total_tasks} tasks failed",
                'exit_code': None,
                'type': 'collection_partial_failure',
                'log_location': f'R2: {FAILURE_LOG_KEY}'
            }
            status['last_failure'] = failure_summary
            status['recent_failures'].append(failure_summary)
            if len(status['recent_failures']) > 10:
                status['recent_failures'] = status['recent_failures'][-10:]
            save_failure(failure_info)
            status['failed_runs'] += 1
    
    except Exception as e:
        failure_time = datetime.now(timezone.utc).isoformat()
        error_msg = f"Exception during collection: {str(e)}"
        
        print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] ❌ Error running collection: {e}")
        import traceback
        traceback.print_exc()
        
        # Record failure
        failure_info = {
            'timestamp': failure_time,
            'error': error_msg,
            'exit_code': None,
            'type': 'collection_exception',
            'traceback': traceback.format_exc()
        }
        failure_summary = {
            'timestamp': failure_time,
            'summary': extract_error_summary(error_msg),
            'exit_code': None,
            'type': 'collection_exception',
            'log_location': f'R2: {FAILURE_LOG_KEY}'
        }
        status['last_failure'] = failure_summary
        status['recent_failures'].append(failure_summary)
        if len(status['recent_failures']) > 10:
            status['recent_failures'] = status['recent_failures'][-10:]
        save_failure(failure_info)
        status['failed_runs'] += 1
    
    finally:
        completion_time = datetime.now(timezone.utc)
        status['currently_running'] = False
        status['last_run_completed'] = completion_time.isoformat()
        
        # Calculate run duration
        if status['last_run_started']:
            try:
                start_time = datetime.fromisoformat(status['last_run_started'])
                duration_seconds = (completion_time - start_time).total_seconds()
                status['last_run_duration_seconds'] = round(duration_seconds, 2)
            except:
                status['last_run_duration_seconds'] = None


def run_scheduler():
    """Run the scheduler loop"""
    base_minutes = [2, 12, 22, 32, 42, 52]
    run_minutes = [(m + SCHEDULE_OFFSET_MINUTES) % 60 for m in base_minutes]
    run_minutes.sort()
    schedule_str = ", ".join([f":{m:02d}" for m in run_minutes])
    env_label = "PRODUCTION" if IS_PRODUCTION else "LOCAL"
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] [{env_label}] Schedule: Every 10 minutes at {schedule_str}")
    
    while True:
        wait_until_next_run()
        run_cron_job()

def main():
    """Main entry point - starts Flask server and scheduler"""
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 🚀 Seismic Data Collector started - {__version__}")
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] Environment: {DEPLOYMENT_ENV}")
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] Deployed: {deploy_time}")
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] v1.81 UI: Incremental download size updates and Download button moved to lower menu")
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] Git commit: v1.81 UI: Incremental download size updates and Download button moved to lower menu")
    
    # Start Flask server in background thread
    port = int(os.getenv('PORT', 5000))
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] Starting health API on port {port}")
    flask_thread = threading.Thread(target=lambda: app.run(host='0.0.0.0', port=port, debug=False, use_reloader=False))
    flask_thread.daemon = True
    flask_thread.start()
    
    # Run scheduler in main thread
    run_scheduler()


if __name__ == "__main__":
    main()

