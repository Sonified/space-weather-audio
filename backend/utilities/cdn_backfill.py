#!/usr/bin/env python3
"""
CDN Backfill - Clean implementation for backfilling missing data to R2/CDN

Focus: Get 1-hour chunks working correctly first
- Proper metadata validation (skip corrupted entries)
- Clean audit logic
- Reliable chunk creation with all fields
"""

import os
import json
import boto3
import numpy as np
import requests
import time
import copy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from obspy import UTCDateTime
from obspy.clients.fdsn import Client
import zstandard as zstd
from dotenv import load_dotenv

# Load environment variables from .env file (for local development)
# In production (Railway), variables are set via dashboard
load_dotenv()

# R2 Configuration - loaded from .env file (local) or Railway dashboard (production)
R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID')
R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID')
R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY')
R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME')

# Validate that all R2 credentials are present
if not all([R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME]):
    missing = []
    if not R2_ACCOUNT_ID: missing.append('R2_ACCOUNT_ID')
    if not R2_ACCESS_KEY_ID: missing.append('R2_ACCESS_KEY_ID')
    if not R2_SECRET_ACCESS_KEY: missing.append('R2_SECRET_ACCESS_KEY')
    if not R2_BUCKET_NAME: missing.append('R2_BUCKET_NAME')
    raise ValueError(f"Missing required R2 environment variables: {', '.join(missing)}")

USE_R2 = os.getenv('USE_R2', 'true').lower() == 'true'

RUN_HISTORY_URL = 'https://cdn.now.audio/collector_logs/run_history.json'

def get_most_recent_collector_run():
    """
    Fetch the most recent collector run from CDN that actually created files.
    Returns the timestamp of that run as a datetime object.
    The collector runs every 10 minutes at :X2 (2 mins after the chunk ends).
    We only care about runs that created files (files_created > 0).
    
    Now uses start_time and end_time fields from run history.
    """
    try:
        print("🔍 Fetching collector run history from CDN...")
        response = requests.get(RUN_HISTORY_URL, timeout=10)
        response.raise_for_status()
        runs = response.json()
        
        # Find the most recent run that created files
        for run in runs:
            files_created = run.get('files_created', {})
            total_files = files_created.get('10m', 0) + files_created.get('1h', 0) + files_created.get('6h', 0)
            
            if total_files > 0:
                # Use start_time when available (more accurate), fallback to timestamp/end_time
                start_time_str = run.get('start_time')
                end_time_str = run.get('end_time') or run.get('timestamp')
                duration = run.get('duration_seconds')
                
                # Use start_time if available, otherwise fall back to end_time/timestamp
                if start_time_str:
                    # Parse the start time (format: "2025-11-13T04:42:10.123456+00:00")
                    run_time = datetime.fromisoformat(start_time_str.replace('+00:00', '+00:00'))
                else:
                    # Fallback to end_time or timestamp
                    run_time = datetime.fromisoformat(end_time_str.replace('+00:00', '+00:00'))
                
                # The run at HH:X2 processes the chunk that ended at HH:X0
                # So we need to round down to the nearest 10 minutes
                chunk_time = run_time.replace(second=0, microsecond=0)
                chunk_time = chunk_time.replace(minute=(chunk_time.minute // 10) * 10)
                
                print(f"✓ Most recent collector run:")
                if start_time_str:
                    run_start_time = datetime.fromisoformat(start_time_str.replace('+00:00', '+00:00'))
                    print(f"  └─ Started: {run_start_time.strftime('%Y-%m-%d %H:%M:%S')} UTC")
                if end_time_str:
                    run_end_time = datetime.fromisoformat(end_time_str.replace('+00:00', '+00:00'))
                    print(f"  └─ Ended: {run_end_time.strftime('%Y-%m-%d %H:%M:%S')} UTC")
                if duration:
                    print(f"  └─ Duration: {duration:.1f}s")
                print(f"  └─ Processed chunk ending at: {chunk_time.strftime('%Y-%m-%d %H:%M:%S')} UTC")
                print(f"  └─ Created files: 10m={files_created.get('10m', 0)}, 1h={files_created.get('1h', 0)}, 6h={files_created.get('6h', 0)}")
                
                return chunk_time
        
        print("⚠️  No recent runs found that created files, defaulting to 2 hours ago")
        return datetime.now(timezone.utc) - timedelta(hours=2)
        
    except Exception as e:
        print(f"⚠️  Failed to fetch run history: {e}")
        print("   Defaulting to 2 hours ago")
        return datetime.now(timezone.utc) - timedelta(hours=2)

def get_s3_client():
    """Get S3/R2 client"""
    return boto3.client(
        's3',
        endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name='auto'
    )

def load_metadata_for_date(network, station, location, channel, volcano, date_str, sample_rate):
    """
    Load metadata for a single date.
    Returns metadata dict or None if doesn't exist.
    Filters out corrupted entries (missing 'end' or 'samples' fields).
    """
    s3 = get_s3_client()
    location_str = location if location and location != '--' else '--'
    
    year, month, day = date_str.split('-')
    metadata_filename = f"{network}_{station}_{location_str}_{channel}_{date_str}.json"
    
    if USE_R2:
        metadata_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/{metadata_filename}"
        try:
            response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
            metadata = json.loads(response['Body'].read().decode('utf-8'))
            
            # Filter out corrupted chunks
            for chunk_type in ['10m', '1h', '6h']:
                if chunk_type in metadata.get('chunks', {}):
                    original_count = len(metadata['chunks'][chunk_type])
                    metadata['chunks'][chunk_type] = [
                        c for c in metadata['chunks'][chunk_type]
                        if 'end' in c and 'samples' in c
                    ]
                    filtered_count = len(metadata['chunks'][chunk_type])
                    if original_count > filtered_count:
                        print(f"  ⚠️  Filtered {original_count - filtered_count} corrupted {chunk_type} chunks from {date_str}")
            
            return metadata
        except s3.exceptions.NoSuchKey:
            return None
    else:
        # Local mode
        metadata_dir = Path(__file__).parent.parent / 'cron_output' / 'data' / year / month / day / network / volcano / station / location_str / channel
        metadata_path = metadata_dir / metadata_filename
        
        if metadata_path.exists():
            with open(metadata_path, 'r') as f:
                return json.load(f)
        return None

def audit_1h_chunks(network, station, location, channel, volcano, sample_rate, start_time, end_time):
    """
    Audit which 1-hour chunks are needed for the given time range.
    
    Returns:
        list of dicts: [{'start_time': datetime, 'end_time': datetime, 'date': 'YYYY-MM-DD'}, ...]
    """
    needed_chunks = []
    
    # Round start_time down to hour boundary
    current_hour = start_time.replace(minute=0, second=0, microsecond=0)
    
    # Collect all dates we need to check
    dates_to_check = set()
    temp_hour = current_hour
    while temp_hour < end_time:
        dates_to_check.add(temp_hour.strftime('%Y-%m-%d'))
        temp_hour += timedelta(hours=1)
    
    # Load metadata for all dates
    metadata_by_date = {}
    for date_str in sorted(dates_to_check):
        metadata = load_metadata_for_date(network, station, location, channel, volcano, date_str, sample_rate)
        metadata_by_date[date_str] = metadata
    
    # Check each hour
    current_hour = start_time.replace(minute=0, second=0, microsecond=0)
    while current_hour < end_time:
        hour_end = current_hour + timedelta(hours=1)
        date_str = current_hour.strftime('%Y-%m-%d')
        
        # Check if this hour exists and is complete
        chunk_complete = False
        
        metadata = metadata_by_date.get(date_str)
        if metadata and '1h' in metadata.get('chunks', {}):
            hour_start_str = current_hour.strftime('%H:%M:%S')
            hour_end_str = hour_end.strftime('%H:%M:%S')
            
            # Find chunk with matching start time
            matching_chunk = None
            for chunk in metadata['chunks']['1h']:
                if chunk['start'] == hour_start_str:
                    matching_chunk = chunk
                    break
            
            if matching_chunk:
                # Verify chunk is complete
                chunk_end_str = matching_chunk.get('end', '')
                chunk_samples = matching_chunk.get('samples', 0)
                expected_samples = int(3600 * sample_rate)  # 1 hour = 3600 seconds
                
                # Chunk is complete if end time matches AND sample count is within 1%
                if chunk_end_str == hour_end_str:
                    sample_diff = abs(chunk_samples - expected_samples)
                    if sample_diff / expected_samples < 0.01:
                        chunk_complete = True
                        print(f"  ✓ {date_str} {hour_start_str}: Complete ({chunk_samples} samples)")
        
        # If chunk is not complete, we need it
        if not chunk_complete:
            needed_chunks.append({
                'start_time': current_hour,
                'end_time': hour_end,
                'date': date_str
            })
            print(f"  ✗ {date_str} {current_hour.strftime('%H:%M:%S')}: Missing or incomplete")
        
        current_hour = hour_end
    
    return needed_chunks

def fetch_waveform_from_iris(network, station, location, channel, start_time, end_time, sample_rate):
    """
    Fetch waveform data from IRIS for the given time window.
    Returns (trace, gaps) tuple or (None, None) on failure.
    """
    try:
        client = Client("IRIS")
        
        # Convert to ObsPy UTCDateTime
        start_utc = UTCDateTime(start_time)
        end_utc = UTCDateTime(end_time)
        
        print(f"    📡 Fetching from IRIS: {start_time.strftime('%Y-%m-%d %H:%M:%S')} to {end_time.strftime('%H:%M:%S')}")
        t_fetch_start = time.time()
        
        # Fetch waveform
        stream = client.get_waveforms(
            network=network,
            station=station,
            location=location if location != '--' else '',
            channel=channel,
            starttime=start_utc,
            endtime=end_utc
        )
        
        t_fetch_end = time.time()
        
        if len(stream) == 0:
            print(f"    ❌ No data returned from IRIS")
            return None, None
        
        # Detect gaps and calculate samples filled (exactly like collector_loop.py)
        gaps = []
        gap_list = stream.get_gaps()
        for gap in gap_list:
            gap_start = UTCDateTime(gap[4])
            gap_end = UTCDateTime(gap[5])
            duration = gap_end - gap_start
            # Calculate expected samples in this gap based on sample rate
            samples_filled = int(round(duration * sample_rate))
            gaps.append({
                'start': gap_start.isoformat(),
                'end': gap_end.isoformat(),
                'samples_filled': samples_filled
            })
        
        # Merge traces using linear interpolation (method=1)
        if len(gaps) > 0:
            print(f"    🔧 Merging with linear interpolation for {len(gaps)} gap(s)...")
            for gap in gaps:
                print(f"       Gap: {gap['samples_filled']} samples filled")
        stream.merge(method=1, fill_value='interpolate', interpolation_samples=0)
        
        if len(stream) != 1:
            print(f"    ⚠️  Multiple traces after merge: {len(stream)}")
        
        trace = stream[0]
        
        # Ensure exact sample count based on requested window (exactly like collector_loop.py)
        requested_duration = end_time - start_time
        sample_rate_from_trace = trace.stats.sampling_rate
        expected_samples = int(requested_duration.total_seconds() * sample_rate_from_trace)
        actual_samples = len(trace.data)
        
        if actual_samples < expected_samples:
            # Pad: Hold last sample value to fill to expected length
            missing = expected_samples - actual_samples
            last_value = trace.data[-1]
            padding = np.full(missing, last_value, dtype=trace.data.dtype)
            trace.data = np.concatenate([trace.data, padding])
            print(f"    ⚠️  Padded {missing} samples to reach expected {expected_samples}")
        elif actual_samples > expected_samples:
            # Truncate: Remove extra samples
            trace.data = trace.data[:expected_samples]
            print(f"    ⚠️  Truncated {actual_samples - expected_samples} extra samples")
        
        print(f"    ✓ Received {len(trace.data)} samples, {len(gaps)} gaps [⏱️  {t_fetch_end - t_fetch_start:.2f}s]")
        
        return trace, gaps
        
    except Exception as e:
        print(f"    ❌ IRIS fetch failed: {e}")
        return None, None

def extract_10m_subchunk(trace, parent_start_time, chunk_start_time, chunk_end_time, sample_rate):
    """
    Extract a 10-minute sub-chunk from a larger trace.
    Returns numpy array of the subchunk data.
    """
    # Calculate sample indices
    start_offset_seconds = (chunk_start_time - parent_start_time).total_seconds()
    end_offset_seconds = (chunk_end_time - parent_start_time).total_seconds()
    
    start_sample = int(start_offset_seconds * sample_rate)
    end_sample = int(end_offset_seconds * sample_rate)
    
    # Extract data
    if end_sample > len(trace.data):
        end_sample = len(trace.data)
    
    subchunk_data = trace.data[start_sample:end_sample].copy()
    
    return subchunk_data

def create_10m_chunk(network, station, location, channel, volcano, sample_rate,
                     start_time, end_time, data_array, parent_trace):
    """
    Create a 10-minute chunk from extracted waveform data.
    Saves binary file and updates metadata.
    Returns ('success', None) or ('failed', error_dict)
    """
    try:
        location_str = location if location and location != '--' else '--'
        date_str = start_time.strftime('%Y-%m-%d')
        year = start_time.year
        month = f"{start_time.month:02d}"
        day = f"{start_time.day:02d}"
        
        # Check metadata FIRST before doing any work
        metadata = load_metadata_for_date(network, station, location, channel, volcano, date_str, sample_rate)
        if metadata and '10m' in metadata.get('chunks', {}):
            chunk_start_str = start_time.strftime('%H:%M:%S')
            for existing in metadata['chunks']['10m']:
                if existing['start'] == chunk_start_str:
                    print(f"      ⏭️  10m chunk {start_time.strftime('%H:%M:%S')} already exists, skipping")
                    return 'skipped', None
        
        print(f"      📦 Creating 10m chunk: {start_time.strftime('%H:%M:%S')} to {end_time.strftime('%H:%M:%S')}")
        
        # Convert to int32 (direct cast - NO NORMALIZATION!)
        data_int32 = data_array.astype(np.int32)
        
        print(f"      📊 Converted {len(data_int32)} samples")
        
        # Calculate min/max
        min_val = int(np.min(data_int32))
        max_val = int(np.max(data_int32))
        
        # Compress data
        compressor = zstd.ZstdCompressor(level=3)
        compressed = compressor.compress(data_int32.tobytes())
        print(f"      🗜️  Compressed: {len(data_int32.tobytes())} → {len(compressed)} bytes ({len(compressed)/len(data_int32.tobytes())*100:.1f}%)")
        
        # Create filename
        start_str = start_time.strftime('%Y-%m-%d-%H-%M-%S')
        end_str = end_time.strftime('%Y-%m-%d-%H-%M-%S')
        filename = f"{network}_{station}_{location_str}_{channel}_10m_{start_str}_to_{end_str}.bin.zst"
        
        # Save binary file
        if USE_R2:
            s3 = get_s3_client()
            r2_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/10m/{filename}"
            s3.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=r2_key,
                Body=compressed,
                ContentType='application/octet-stream'
            )
            print(f"      💾 Uploaded to R2")
        else:
            # Local save
            base_dir = Path(__file__).parent.parent / 'cron_output'
            chunk_dir = base_dir / 'data' / str(year) / month / day / network / volcano / station / location_str / channel / '10m'
            chunk_dir.mkdir(parents=True, exist_ok=True)
            chunk_path = chunk_dir / filename
            with open(chunk_path, 'wb') as f:
                f.write(compressed)
            print(f"      💾 Saved locally")
        
        # Reload metadata (might have been created/updated by other chunks)
        metadata = load_metadata_for_date(network, station, location, channel, volcano, date_str, sample_rate)
        
        if not metadata:
            # Create new metadata
            metadata = {
                'date': date_str,
                'network': network,
                'volcano': volcano,
                'station': station,
                'location': location if location != '--' else '',
                'channel': channel,
                'sample_rate': float(sample_rate),
                'created_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                'complete_day': False,
                'chunks': {
                    '10m': [],
                    '1h': [],
                    '6h': []
                }
            }
        
        # Add chunk metadata
        chunk_meta = {
            'start': start_time.strftime('%H:%M:%S'),
            'end': end_time.strftime('%H:%M:%S'),
            'min': min_val,
            'max': max_val,
            'samples': len(data_int32),
            'gap_count': 0,  # Sub-chunks inherit parent's gap handling
            'gap_samples_filled': 0
        }
        
        # Append and sort
        metadata['chunks']['10m'].append(chunk_meta)
        metadata['chunks']['10m'].sort(key=lambda c: c['start'])
        
        # Save metadata
        metadata_filename = f"{network}_{station}_{location_str}_{channel}_{date_str}.json"
        
        if USE_R2:
            s3 = get_s3_client()
            metadata_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/{metadata_filename}"
            s3.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=metadata_key,
                Body=json.dumps(metadata, indent=2).encode('utf-8'),
                ContentType='application/json'
            )
            print(f"      ✅ Metadata updated")
        else:
            metadata_dir = Path(__file__).parent.parent / 'cron_output' / 'data' / str(year) / month / day / network / volcano / station / location_str / channel
            metadata_dir.mkdir(parents=True, exist_ok=True)
            metadata_path = metadata_dir / metadata_filename
            with open(metadata_path, 'w') as f:
                json.dump(metadata, f, indent=2)
            print(f"      ✅ Metadata updated")
        
        return 'success', None
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return 'failed', {'error': str(e)}

def create_1h_chunk(network, station, location, channel, volcano, sample_rate, 
                    start_time, end_time, trace, gaps):
    """
    Create a 1-hour chunk from waveform data.
    Saves binary file and updates metadata.
    Returns ('success', None) or ('failed', error_dict)
    """
    try:
        location_str = location if location and location != '--' else '--'
        date_str = start_time.strftime('%Y-%m-%d')
        year = start_time.year
        month = f"{start_time.month:02d}"
        day = f"{start_time.day:02d}"
        
        # Check metadata FIRST before doing any work
        metadata = load_metadata_for_date(network, station, location, channel, volcano, date_str, sample_rate)
        if metadata and '1h' in metadata.get('chunks', {}):
            chunk_start_str = start_time.strftime('%H:%M:%S')
            for existing in metadata['chunks']['1h']:
                if existing['start'] == chunk_start_str:
                    print(f"    ⏭️  1h chunk {start_time.strftime('%H:%M:%S')} already exists, skipping")
                    return 'skipped', None
        
        print(f"    📦 Creating 1h chunk...")
        
        # Convert to int32 (direct cast - NO NORMALIZATION!)
        print(f"    🔢 Converting {len(trace.data)} samples to int32...")
        t_convert_start = time.time()
        data_int32 = trace.data.astype(np.int32)
        t_convert_end = time.time()
        print(f"       ⏱️  Convert: {t_convert_end - t_convert_start:.3f}s")
        
        # Calculate min/max
        min_val = int(np.min(data_int32))
        max_val = int(np.max(data_int32))
        print(f"    📊 Range: min={min_val}, max={max_val}")
        
        # Compress data
        print(f"    🗜️  Compressing...")
        t_compress_start = time.time()
        compressor = zstd.ZstdCompressor(level=3)
        compressed = compressor.compress(data_int32.tobytes())
        t_compress_end = time.time()
        print(f"    ✓ Compressed: {len(data_int32.tobytes())} → {len(compressed)} bytes ({len(compressed)/len(data_int32.tobytes())*100:.1f}%) [⏱️  {t_compress_end - t_compress_start:.3f}s]")
        
        # Create filename
        start_str = start_time.strftime('%Y-%m-%d-%H-%M-%S')
        end_str = end_time.strftime('%Y-%m-%d-%H-%M-%S')
        filename = f"{network}_{station}_{location_str}_{channel}_1h_{start_str}_to_{end_str}.bin.zst"
        
        # Save binary file
        if USE_R2:
            t_upload_start = time.time()
            s3 = get_s3_client()
            r2_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/1h/{filename}"
            s3.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=r2_key,
                Body=compressed,
                ContentType='application/octet-stream'
            )
            t_upload_end = time.time()
            print(f"    💾 Uploaded to R2: {r2_key} [⏱️  {t_upload_end - t_upload_start:.3f}s]")
        else:
            # Local save
            base_dir = Path(__file__).parent.parent / 'cron_output'
            chunk_dir = base_dir / 'data' / str(year) / month / day / network / volcano / station / location_str / channel / '1h'
            chunk_dir.mkdir(parents=True, exist_ok=True)
            chunk_path = chunk_dir / filename
            with open(chunk_path, 'wb') as f:
                f.write(compressed)
            print(f"    💾 Saved locally: {chunk_path}")
        
        # Reload metadata (might have been created/updated by other chunks)
        metadata = load_metadata_for_date(network, station, location, channel, volcano, date_str, sample_rate)
        
        if not metadata:
            # Create new metadata
            metadata = {
                'date': date_str,
                'network': network,
                'volcano': volcano,
                'station': station,
                'location': location if location != '--' else '',
                'channel': channel,
                'sample_rate': float(sample_rate),
                'created_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                'complete_day': False,
                'chunks': {
                    '10m': [],
                    '1h': [],
                    '6h': []
                }
            }
        
        # Add chunk metadata
        chunk_meta = {
            'start': start_time.strftime('%H:%M:%S'),
            'end': end_time.strftime('%H:%M:%S'),
            'min': min_val,
            'max': max_val,
            'samples': len(data_int32),
            'gap_count': len(gaps),
            'gap_samples_filled': sum(g['samples_filled'] for g in gaps) if gaps else 0
        }
        
        # Append and sort
        metadata['chunks']['1h'].append(chunk_meta)
        metadata['chunks']['1h'].sort(key=lambda c: c['start'])
        
        # Save metadata
        metadata_filename = f"{network}_{station}_{location_str}_{channel}_{date_str}.json"
        
        if USE_R2:
            s3 = get_s3_client()
            metadata_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/{metadata_filename}"
            s3.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=metadata_key,
                Body=json.dumps(metadata, indent=2).encode('utf-8'),
                ContentType='application/json'
            )
            print(f"    💾 Updated metadata in R2")
        else:
            metadata_dir = Path(__file__).parent.parent / 'cron_output' / 'data' / str(year) / month / day / network / volcano / station / location_str / channel
            metadata_dir.mkdir(parents=True, exist_ok=True)
            metadata_path = metadata_dir / metadata_filename
            with open(metadata_path, 'w') as f:
                json.dump(metadata, f, indent=2)
            print(f"    💾 Updated metadata locally")
        
        return 'success', None
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return 'failed', {'error': str(e)}

def delete_chunks_for_timerange(network, station, location, channel, volcano, sample_rate, start_time, end_time):
    """
    Delete all chunks (10m, 1h, 6h) and their metadata entries for a time range.
    This allows us to test actual creation/upload times.
    Selectively removes metadata entries while preserving chunks outside the range.
    """
    print(f"🗑️  Deleting existing chunks from {start_time.strftime('%Y-%m-%d %H:%M')} to {end_time.strftime('%Y-%m-%d %H:%M')}...")
    
    location_str = location if location and location != '--' else '--'
    
    if not USE_R2:
        print("    ⚠️  Delete only works with R2 mode")
        return
    
    s3 = get_s3_client()
    
    # Get all dates in range
    current_date = start_time.replace(hour=0, minute=0, second=0, microsecond=0)
    end_date = end_time.replace(hour=0, minute=0, second=0, microsecond=0)
    
    dates_to_clean = []
    while current_date <= end_date:
        dates_to_clean.append(current_date)
        current_date += timedelta(days=1)
    
    deleted_binary_count = 0
    deleted_metadata_entries = {'10m': 0, '1h': 0, '6h': 0}
    
    for date in dates_to_clean:
        year = date.year
        month = f"{date.month:02d}"
        day = f"{date.day:02d}"
        date_str = date.strftime('%Y-%m-%d')
        
        # Load metadata for this date
        metadata = load_metadata_for_date(network, station, location, channel, volcano, date_str, sample_rate)
        
        # Store original metadata BEFORE filtering (needed for binary file deletion)
        # Use deep copy so filtering metadata doesn't affect original_metadata
        original_metadata = copy.deepcopy(metadata) if metadata else {'chunks': {}}
        
        if metadata:
            original_counts = {
                '10m': len(metadata['chunks'].get('10m', [])),
                '1h': len(metadata['chunks'].get('1h', [])),
                '6h': len(metadata['chunks'].get('6h', []))
            }
            
            # Filter out chunks within our time range
            for chunk_type in ['10m', '1h', '6h']:
                filtered_chunks = []
                for chunk in metadata['chunks'].get(chunk_type, []):
                    # Parse chunk start time
                    chunk_start_str = chunk.get('start', '')
                    try:
                        # Combine date + time
                        chunk_datetime = datetime.strptime(f"{date_str} {chunk_start_str}", '%Y-%m-%d %H:%M:%S')
                        chunk_datetime = chunk_datetime.replace(tzinfo=timezone.utc)
                        
                        # Keep chunk if it's outside our deletion range
                        if chunk_datetime < start_time or chunk_datetime >= end_time:
                            filtered_chunks.append(chunk)
                        else:
                            deleted_metadata_entries[chunk_type] += 1
                    except:
                        # Keep chunk if we can't parse (safer)
                        filtered_chunks.append(chunk)
                
                metadata['chunks'][chunk_type] = filtered_chunks
            
            # Save updated metadata
            metadata_filename = f"{network}_{station}_{location_str}_{channel}_{date_str}.json"
            metadata_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/{metadata_filename}"
            
            s3.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=metadata_key,
                Body=json.dumps(metadata, indent=2).encode('utf-8'),
                ContentType='application/json'
            )
            
            new_counts = {
                '10m': len(metadata['chunks'].get('10m', [])),
                '1h': len(metadata['chunks'].get('1h', [])),
                '6h': len(metadata['chunks'].get('6h', []))
            }
            
            print(f"    📝 {date_str} metadata: 10m({original_counts['10m']}→{new_counts['10m']}), 1h({original_counts['1h']}→{new_counts['1h']}), 6h({original_counts['6h']}→{new_counts['6h']})")
        
        # Delete binary files by checking against metadata entries we just removed
        # Build expected filenames from the metadata we deleted and remove those EXACT files
        for chunk_type in ['10m', '1h', '6h']:
            for chunk in original_metadata.get('chunks', {}).get(chunk_type, []):
                chunk_start_str = chunk.get('start', '')
                
                # Parse the chunk start time to check if it's in our deletion range
                try:
                    chunk_datetime = datetime.strptime(f"{date_str} {chunk_start_str}", '%Y-%m-%d %H:%M:%S')
                    chunk_datetime = chunk_datetime.replace(tzinfo=timezone.utc)
                    
                    # Only delete if chunk is in our time range
                    if start_time <= chunk_datetime < end_time:
                        # Calculate end time based on chunk type
                        if chunk_type == '10m':
                            chunk_end_datetime = chunk_datetime + timedelta(minutes=10)
                        elif chunk_type == '1h':
                            chunk_end_datetime = chunk_datetime + timedelta(hours=1)
                        elif chunk_type == '6h':
                            chunk_end_datetime = chunk_datetime + timedelta(hours=6)
                        
                        # Build EXACT filename
                        start_str = chunk_datetime.strftime('%Y-%m-%d-%H-%M-%S')
                        end_str = chunk_end_datetime.strftime('%Y-%m-%d-%H-%M-%S')
                        filename = f"{network}_{station}_{location_str}_{channel}_{chunk_type}_{start_str}_to_{end_str}.bin.zst"
                        
                        # Build S3 key
                        s3_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/{chunk_type}/{filename}"
                        
                        # Delete the exact file
                        print(f"    🔍 Attempting to delete: {s3_key}")
                        try:
                            # Check if file exists first
                            s3.head_object(Bucket=R2_BUCKET_NAME, Key=s3_key)
                            s3.delete_object(Bucket=R2_BUCKET_NAME, Key=s3_key)
                            deleted_binary_count += 1
                            print(f"    ✓ Deleted: {filename}")
                        except Exception as del_error:
                            # Print the actual error so we can see what's wrong
                            error_str = str(del_error)
                            if '404' in error_str or 'NoSuchKey' in error_str:
                                print(f"    ⚠️  File not found: {filename}")
                            else:
                                print(f"    ❌ Error deleting {filename}: {error_str}")
                                import traceback
                                traceback.print_exc()
                            
                except Exception as e:
                    print(f"    ⚠️  Could not parse chunk time {chunk_start_str}: {e}")
    
    print(f"    ✅ Deleted {deleted_binary_count} binary files")
    print(f"    ✅ Removed {deleted_metadata_entries['10m']} 10m + {deleted_metadata_entries['1h']} 1h + {deleted_metadata_entries['6h']} 6h metadata entries")

def backfill_1h_chunks(network, station, location, channel, volcano, sample_rate, hours_back=24, force_recreate=False):
    """
    Backfill 1-hour chunks up to the most recent collector run.
    Uses run_history.json from CDN to determine the end time (most recent run that created files).
    Backfills from hours_back before that time up to that time.
    
    force_recreate: If True, deletes existing chunks before backfilling (for testing)
    """
    print("=" * 80)
    print(f"🔄 1-Hour Backfill for {network}.{station}.{location}.{channel}")
    print(f"📊 Sample rate: {sample_rate} Hz")
    print(f"💾 Mode: {'R2' if USE_R2 else 'Local'}")
    if force_recreate:
        print(f"⚠️  FORCE RECREATE: Will delete existing chunks first")
    print("=" * 80)
    print()
    
    # Get the most recent collector run time from CDN
    end_time = get_most_recent_collector_run()
    start_time = end_time - timedelta(hours=hours_back)
    
    print()
    print(f"📅 Backfill window: {hours_back} hours before most recent run")
    print(f"⏰ Start: {start_time.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print(f"⏰ End:   {end_time.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print()
    
    # Delete existing chunks if force_recreate
    if force_recreate:
        delete_chunks_for_timerange(network, station, location, channel, volcano, sample_rate, start_time, end_time)
        print()
    
    # Audit what's needed
    print("🔍 Auditing existing chunks...")
    needed_chunks = audit_1h_chunks(network, station, location, channel, volcano, sample_rate, start_time, end_time)
    
    print()
    print(f"📊 Audit Results:")
    print(f"   Need to fetch: {len(needed_chunks)} chunks")
    print()
    
    if len(needed_chunks) == 0:
        print("✅ All chunks already exist and are complete!")
        return
    
    # Fetch and process each needed chunk
    successful_1h = 0
    successful_10m = 0
    skipped_1h = 0
    skipped_10m = 0
    failed = 0
    
    for i, chunk_info in enumerate(needed_chunks, 1):
        chunk_start = chunk_info['start_time']
        chunk_end = chunk_info['end_time']
        
        print(f"\n[{i}/{len(needed_chunks)}] Processing {chunk_start.strftime('%Y-%m-%d %H:%M:%S')} to {chunk_end.strftime('%H:%M:%S')}")
        t_chunk_start = time.time()
        
        # Fetch from IRIS
        trace, gaps = fetch_waveform_from_iris(network, station, location, channel, chunk_start, chunk_end, sample_rate)
        
        if trace is None:
            failed += 1
            print(f"    ❌ Failed to fetch from IRIS")
            print()
            continue
        
        # Create 1h chunk
        status_1h, error = create_1h_chunk(network, station, location, channel, volcano, sample_rate,
                                          chunk_start, chunk_end, trace, gaps)
        
        if status_1h == 'success':
            successful_1h += 1
            print(f"    ✅ 1h chunk created")
        elif status_1h == 'skipped':
            skipped_1h += 1
            print(f"    ⏭️  1h chunk skipped (already exists)")
        else:
            failed += 1
            print(f"    ❌ 1h chunk failed: {error}")
            print()
            continue
        
        # Now derive 10m sub-chunks from the same trace
        print(f"    🔍 Deriving 10m sub-chunks from 1h trace...")
        minute_start = chunk_start
        minute_counter = 0
        
        while minute_start < chunk_end:
            minute_end = minute_start + timedelta(minutes=10)
            if minute_end > chunk_end:
                minute_end = chunk_end
            
            minute_counter += 1
            print(f"    └─ [10m {minute_counter}/6] {minute_start.strftime('%H:%M:%S')} to {minute_end.strftime('%H:%M:%S')}")
            
            # Extract 10m data from the trace
            subchunk_data = extract_10m_subchunk(trace, chunk_start, minute_start, minute_end, sample_rate)
            print(f"      ✂️  Extracted {len(subchunk_data)} samples")
            
            # Skip if no data (partial hour at end)
            if len(subchunk_data) == 0:
                print(f"      ⏭️  Skipping (no data)")
                minute_start = minute_end
                continue
            
            # Create 10m chunk
            status_10m, error_10m = create_10m_chunk(network, station, location, channel, volcano, sample_rate,
                                                     minute_start, minute_end, subchunk_data, trace)
            
            if status_10m == 'success':
                successful_10m += 1
            elif status_10m == 'skipped':
                skipped_10m += 1
            else:
                print(f"      ❌ 10m chunk failed: {error_10m}")
            
            minute_start = minute_end
        
        t_chunk_end = time.time()
        print(f"\n    ⏱️  Total time for this 1h chunk: {t_chunk_end - t_chunk_start:.2f}s")
    
    print("=" * 80)
    print("🎉 Backfill Complete!")
    print(f"📊 1h chunks: ✅ {successful_1h} successful, ⏭️  {skipped_1h} skipped")
    print(f"📊 10m chunks: ✅ {successful_10m} successful, ⏭️  {skipped_10m} skipped")
    print(f"❌ Failed: {failed}")
    print("=" * 80)

def create_6h_chunk(network, station, location, channel, volcano, sample_rate, 
                    start_time, end_time, trace, gaps):
    """
    Create a 6-hour chunk from waveform data.
    Saves binary file and updates metadata.
    Returns ('success', None) or ('failed', error_dict)
    """
    try:
        location_str = location if location and location != '--' else '--'
        date_str = start_time.strftime('%Y-%m-%d')
        year = start_time.year
        month = f"{start_time.month:02d}"
        day = f"{start_time.day:02d}"
        
        # Check metadata FIRST before doing any work
        metadata = load_metadata_for_date(network, station, location, channel, volcano, date_str, sample_rate)
        if metadata and '6h' in metadata.get('chunks', {}):
            chunk_start_str = start_time.strftime('%H:%M:%S')
            for existing in metadata['chunks']['6h']:
                if existing['start'] == chunk_start_str:
                    print(f"    ⏭️  6h chunk {start_time.strftime('%H:%M:%S')} already exists, skipping")
                    return 'skipped', None
        
        print(f"    📦 Creating 6h chunk...")
        
        # Convert to int32 (direct cast - NO NORMALIZATION!)
        print(f"    🔢 Converting {len(trace.data)} samples to int32...")
        t_convert_start = time.time()
        data_int32 = trace.data.astype(np.int32)
        t_convert_end = time.time()
        print(f"       ⏱️  Convert: {t_convert_end - t_convert_start:.3f}s")
        
        # Calculate min/max
        min_val = int(np.min(data_int32))
        max_val = int(np.max(data_int32))
        print(f"    📊 Range: min={min_val}, max={max_val}")
        
        # Compress data
        print(f"    🗜️  Compressing...")
        t_compress_start = time.time()
        compressor = zstd.ZstdCompressor(level=3)
        compressed = compressor.compress(data_int32.tobytes())
        t_compress_end = time.time()
        print(f"    ✓ Compressed: {len(data_int32.tobytes())} → {len(compressed)} bytes ({len(compressed)/len(data_int32.tobytes())*100:.1f}%) [⏱️  {t_compress_end - t_compress_start:.3f}s]")
        
        # Create filename
        start_str = start_time.strftime('%Y-%m-%d-%H-%M-%S')
        end_str = end_time.strftime('%Y-%m-%d-%H-%M-%S')
        filename = f"{network}_{station}_{location_str}_{channel}_6h_{start_str}_to_{end_str}.bin.zst"
        
        # Save binary file
        if USE_R2:
            t_upload_start = time.time()
            s3 = get_s3_client()
            r2_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/6h/{filename}"
            s3.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=r2_key,
                Body=compressed,
                ContentType='application/octet-stream'
            )
            t_upload_end = time.time()
            print(f"    💾 Uploaded to R2: {r2_key} [⏱️  {t_upload_end - t_upload_start:.3f}s]")
        else:
            # Local save
            base_dir = Path(__file__).parent.parent / 'cron_output'
            chunk_dir = base_dir / 'data' / str(year) / month / day / network / volcano / station / location_str / channel / '6h'
            chunk_dir.mkdir(parents=True, exist_ok=True)
            chunk_path = chunk_dir / filename
            with open(chunk_path, 'wb') as f:
                f.write(compressed)
            print(f"    💾 Saved locally: {chunk_path}")
        
        # Reload metadata (might have been created/updated by other chunks)
        metadata = load_metadata_for_date(network, station, location, channel, volcano, date_str, sample_rate)
        
        if not metadata:
            # Create new metadata
            metadata = {
                'date': date_str,
                'network': network,
                'volcano': volcano,
                'station': station,
                'location': location if location != '--' else '',
                'channel': channel,
                'sample_rate': float(sample_rate),
                'created_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                'complete_day': False,
                'chunks': {
                    '10m': [],
                    '1h': [],
                    '6h': []
                }
            }
        
        # Add chunk metadata
        chunk_meta = {
            'start': start_time.strftime('%H:%M:%S'),
            'end': end_time.strftime('%H:%M:%S'),
            'min': min_val,
            'max': max_val,
            'samples': len(data_int32),
            'gap_count': len(gaps),
            'gap_samples_filled': sum(g.get('samples_filled', 0) for g in gaps) if gaps else 0
        }
        
        # Append and sort
        metadata['chunks']['6h'].append(chunk_meta)
        metadata['chunks']['6h'].sort(key=lambda c: c['start'])
        
        # Save metadata
        metadata_filename = f"{network}_{station}_{location_str}_{channel}_{date_str}.json"
        
        if USE_R2:
            s3 = get_s3_client()
            metadata_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/{metadata_filename}"
            s3.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=metadata_key,
                Body=json.dumps(metadata, indent=2).encode('utf-8'),
                ContentType='application/json'
            )
            print(f"    💾 Updated metadata in R2")
        else:
            metadata_dir = Path(__file__).parent.parent / 'cron_output' / 'data' / str(year) / month / day / network / volcano / station / location_str / channel
            metadata_dir.mkdir(parents=True, exist_ok=True)
            metadata_path = metadata_dir / metadata_filename
            with open(metadata_path, 'w') as f:
                json.dump(metadata, f, indent=2)
            print(f"    💾 Updated metadata locally")
        
        return 'success', None
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return 'failed', {'error': str(e)}

def check_if_chunk_exists(network, station, location, channel, volcano, sample_rate, start_time, chunk_type):
    """
    Check if a specific chunk already exists in metadata (well-formed with 'end' and 'samples').
    Returns True if chunk exists and is complete, False otherwise.
    """
    date_str = start_time.strftime('%Y-%m-%d')
    metadata = load_metadata_for_date(network, station, location, channel, volcano, date_str, sample_rate)
    
    if not metadata or chunk_type not in metadata.get('chunks', {}):
        return False
    
    chunk_start_str = start_time.strftime('%H:%M:%S')
    for existing in metadata['chunks'][chunk_type]:
        if existing.get('start') == chunk_start_str:
            # Chunk exists - verify it's well-formed (has 'end' and 'samples')
            return 'end' in existing and 'samples' in existing
    
    return False

def save_metadata_for_date(network, station, location, channel, volcano, sample_rate, date_str):
    """
    Save metadata for ONE date after completing a major chunk (gap or 6h block).
    
    All chunks created in a major chunk are stored by their START date.
    - Gap: From 6h boundary to collector run (max 6 hours) = ONE date
    - 6h blocks: Always start/end on boundaries = ONE date (even 18:00→00:00)
    """
    print(f"    💾 Saving metadata for date {date_str}...")
    
    metadata = load_metadata_for_date(network, station, location, channel, volcano, date_str, sample_rate)
    if metadata:
        location_str = location if location and location != '--' else '--'
        year, month, day = date_str.split('-')
        metadata_filename = f"{network}_{station}_{location_str}_{channel}_{date_str}.json"
        
        if USE_R2:
            s3 = get_s3_client()
            metadata_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/{metadata_filename}"
            s3.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=metadata_key,
                Body=json.dumps(metadata, indent=2).encode('utf-8'),
                ContentType='application/json'
            )
        else:
            metadata_dir = Path(__file__).parent.parent / 'cron_output' / 'data' / year / month / day / network / volcano / station / location_str / channel
            metadata_dir.mkdir(parents=True, exist_ok=True)
            metadata_path = metadata_dir / metadata_filename
            with open(metadata_path, 'w') as f:
                json.dump(metadata, f, indent=2)
        
        print(f"       ✓ {date_str}")

def backfill_6h_strategy(network, station, location, channel, volcano, sample_rate, force_recreate=False):
    """
    6-Hour Backfill Strategy:
    1. Find most recent 6h boundary (00:00, 06:00, 12:00, 18:00)
    2. Fill gap from that boundary to most recent collector run (1 IRIS fetch)
    3. Fill 4 complete 6h blocks going backwards (4 IRIS fetches)
    
    Total: 5 IRIS fetches for 24+ hours of data
    Creates: 4× 6h + ~29× 1h + ~176× 10m chunks
    """
    print("=" * 80)
    print(f"🔄 6-Hour Backfill Strategy for {network}.{station}.{location}.{channel}")
    print(f"📊 Sample rate: {sample_rate} Hz")
    print(f"💾 Mode: {'R2' if USE_R2 else 'Local'}")
    if force_recreate:
        print(f"⚠️  FORCE RECREATE: Will delete existing chunks first")
    print("=" * 80)
    print()
    
    # Get the most recent collector run time
    most_recent_run = get_most_recent_collector_run()
    
    # Find the most recent 6h boundary (00:00, 06:00, 12:00, 18:00)
    hour = most_recent_run.hour
    boundary_hour = (hour // 6) * 6  # Round down to nearest 6h boundary
    most_recent_6h_boundary = most_recent_run.replace(hour=boundary_hour, minute=0, second=0, microsecond=0)
    
    print(f"⏰ Most recent collector run: {most_recent_run.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print(f"🎯 Most recent 6h boundary: {most_recent_6h_boundary.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print()
    
    # Calculate total backfill window
    backfill_start = most_recent_6h_boundary - timedelta(hours=24)
    backfill_end = most_recent_run
    
    print(f"📅 Total backfill window:")
    print(f"   Start: {backfill_start.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print(f"   End:   {backfill_end.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print()
    
    # Delete existing chunks if force_recreate
    if force_recreate:
        delete_chunks_for_timerange(network, station, location, channel, volcano, sample_rate, backfill_start, backfill_end)
        print()
    
    # Statistics
    total_6h = 0
    total_1h = 0
    total_10m = 0
    total_iris_fetches = 0
    
    # STEP 1: Fill the gap
    gap_duration = (most_recent_run - most_recent_6h_boundary).total_seconds() / 3600
    print("=" * 80)
    print(f"📦 STEP 1: Fill Gap ({gap_duration:.2f} hours)")
    print(f"   From: {most_recent_6h_boundary.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print(f"   To:   {most_recent_run.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print("=" * 80)
    print()
    
    if gap_duration > 0:
        # First, check if we actually need to fetch from IRIS
        print(f"🔍 Auditing gap chunks...")
        need_fetch = False
        missing_chunks = []
        current_hour = most_recent_6h_boundary
        while current_hour < most_recent_run:
            hour_end = current_hour + timedelta(hours=1)
            if hour_end <= most_recent_run:
                # Check if this 1h chunk exists
                exists_1h = check_if_chunk_exists(network, station, location, channel, volcano, sample_rate, current_hour, '1h')
                if exists_1h:
                    print(f"  ✓ 1h chunk {current_hour.strftime('%H:%M')} exists")
                else:
                    print(f"  ✗ 1h chunk {current_hour.strftime('%H:%M')} MISSING")
                    need_fetch = True
                    missing_chunks.append(('1h', current_hour, hour_end))
                
                # ALSO check that all 10m sub-chunks exist
                minute_start = current_hour
                while minute_start < hour_end:
                    minute_end = minute_start + timedelta(minutes=10)
                    exists_10m = check_if_chunk_exists(network, station, location, channel, volcano, sample_rate, minute_start, '10m')
                    if exists_10m:
                        print(f"    ✓ 10m sub-chunk {minute_start.strftime('%H:%M')} exists")
                    else:
                        print(f"    ✗ 10m sub-chunk {minute_start.strftime('%H:%M')} MISSING")
                        need_fetch = True
                        missing_chunks.append(('10m', minute_start, minute_end))
                    minute_start = minute_end
            else:
                # Partial hour - check 10m chunks
                minute_start = current_hour
                while minute_start < most_recent_run:
                    minute_end = minute_start + timedelta(minutes=10)
                    if minute_end > most_recent_run:
                        minute_end = most_recent_run
                    exists = check_if_chunk_exists(network, station, location, channel, volcano, sample_rate, minute_start, '10m')
                    if exists:
                        print(f"  ✓ 10m chunk {minute_start.strftime('%H:%M')} exists")
                    else:
                        print(f"  ✗ 10m chunk {minute_start.strftime('%H:%M')} MISSING")
                        need_fetch = True
                        missing_chunks.append(('10m', minute_start, minute_end))
                    minute_start = minute_end
            current_hour = hour_end
        
        print()
        if not need_fetch:
            print(f"✅ All gap chunks already exist, skipping IRIS fetch!")
        else:
            print(f"❌ Missing {len(missing_chunks)} chunks in gap - FETCHING FROM IRIS")
            print(f"🌐 IRIS Fetch: Gap ({gap_duration:.2f}h)")
            trace, gaps = fetch_waveform_from_iris(network, station, location, channel, most_recent_6h_boundary, most_recent_run, sample_rate)
            total_iris_fetches += 1
            
            if trace is None:
                print("❌ Failed to fetch gap data from IRIS")
                return
            
            # Derive complete 1h chunks from gap
            print()
            print(f"📁 Creating chunks from gap trace...")
            print(f"   Gap trace has {len(trace.data)} samples from {most_recent_6h_boundary.strftime('%H:%M')} to {most_recent_run.strftime('%H:%M')}")
            current_hour = most_recent_6h_boundary
            # Gap is max 6 hours from boundary, so all chunks have same START date
            gap_date = most_recent_6h_boundary.strftime('%Y-%m-%d')
            
            while current_hour < most_recent_run:
                hour_end = current_hour + timedelta(hours=1)
                
                # Only create complete 1h chunks
                if hour_end <= most_recent_run:
                    print(f"\n  🕐 1h chunk: {current_hour.strftime('%Y-%m-%d %H:%M:%S')} to {hour_end.strftime('%H:%M:%S')}")
                    
                    # Extract 1h data from gap trace
                    hour_data = extract_10m_subchunk(trace, most_recent_6h_boundary, current_hour, hour_end, sample_rate)
                    
                    # Create a mini-trace for this hour
                    from obspy import Trace
                    hour_trace = Trace(data=hour_data)
                    hour_trace.stats.sampling_rate = sample_rate
                    
                    # Create 1h chunk
                    status, error = create_1h_chunk(network, station, location, channel, volcano, sample_rate,
                                                   current_hour, hour_end, hour_trace, gaps)
                    if status == 'success':
                        total_1h += 1
                    
                    # Derive 10m sub-chunks from this hour
                    print(f"    └─ Deriving 6× 10m sub-chunks...")
                    minute_start = current_hour
                    sub_count = 0
                    while minute_start < hour_end:
                        minute_end = minute_start + timedelta(minutes=10)
                        if minute_end > hour_end:
                            minute_end = hour_end
                        
                        sub_count += 1
                        minute_data = extract_10m_subchunk(trace, most_recent_6h_boundary, minute_start, minute_end, sample_rate)
                        
                        if len(minute_data) > 0:
                            print(f"       [{sub_count}/6] {minute_start.strftime('%H:%M')}-{minute_end.strftime('%H:%M')}: {len(minute_data)} samples", end='')
                            status_10m, _ = create_10m_chunk(network, station, location, channel, volcano, sample_rate,
                                                            minute_start, minute_end, minute_data, trace)
                            if status_10m == 'success':
                                total_10m += 1
                                print(f" ✅")
                            elif status_10m == 'skipped':
                                print(f" ⏭️")
                            else:
                                print(f" ❌")
                        
                        minute_start = minute_end
                
                current_hour = hour_end
            
            # Handle partial hour at end (only 10m chunks)
            if current_hour < most_recent_run:
                print(f"\n  ⏱️  Partial hour: {current_hour.strftime('%H:%M:%S')} to {most_recent_run.strftime('%H:%M:%S')} (10m chunks only)")
                minute_start = current_hour
                partial_count = 0
                while minute_start < most_recent_run:
                    minute_end = minute_start + timedelta(minutes=10)
                    if minute_end > most_recent_run:
                        minute_end = most_recent_run
                    
                    partial_count += 1
                    minute_data = extract_10m_subchunk(trace, most_recent_6h_boundary, minute_start, minute_end, sample_rate)
                    
                    if len(minute_data) > 0:
                        print(f"     [{partial_count}] {minute_start.strftime('%H:%M')}-{minute_end.strftime('%H:%M')}: {len(minute_data)} samples", end='')
                        status_10m, _ = create_10m_chunk(network, station, location, channel, volcano, sample_rate,
                                                        minute_start, minute_end, minute_data, trace)
                        if status_10m == 'success':
                            total_10m += 1
                            print(f" ✅")
                        elif status_10m == 'skipped':
                            print(f" ⏭️")
                        else:
                            print(f" ❌")
                    
                    minute_start = minute_end
            
            # Save metadata for gap date
            print()
            save_metadata_for_date(network, station, location, channel, volcano, sample_rate, gap_date)
            print("✅ Gap complete!")
    else:
        print("⏭️  No gap to fill")
    
    print()
    
    # STEP 2: Fill 4 complete 6h blocks going backwards
    print("=" * 80)
    print("📦 STEP 2: Fill 4 Complete 6-Hour Chunks (going backwards)")
    print("=" * 80)
    print()
    
    for i in range(4):  # 4 complete 6h blocks = 24 hours
        chunk_num = i + 1
        chunk_end = most_recent_6h_boundary - timedelta(hours=6 * i)
        chunk_start = chunk_end - timedelta(hours=6)
        
        print(f"\n[6h Chunk {chunk_num}/4]")
        
        # Check if 6h chunk already exists
        if check_if_chunk_exists(network, station, location, channel, volcano, sample_rate, chunk_start, '6h'):
            print(f"  ✅ 6h chunk already exists, skipping entire block!")
            continue
        
        print(f"  🌐 IRIS Fetch: {chunk_start.strftime('%Y-%m-%d %H:%M:%S')} → {chunk_end.strftime('%Y-%m-%d %H:%M:%S')} (6.00h)")
        
        # Fetch 6h data from IRIS
        trace_6h, gaps_6h = fetch_waveform_from_iris(network, station, location, channel, chunk_start, chunk_end, sample_rate)
        total_iris_fetches += 1
        
        if trace_6h is None:
            print(f"  ❌ Failed to fetch 6h chunk")
            continue
        
        # All chunks in this 6h block have same START date (stored by START date)
        chunk_date = chunk_start.strftime('%Y-%m-%d')
        
        # Create 6h binary chunk
        status_6h, _ = create_6h_chunk(network, station, location, channel, volcano, sample_rate,
                                       chunk_start, chunk_end, trace_6h, gaps_6h)
        if status_6h == 'success':
            total_6h += 1
        
        # Derive 6× 1h sub-chunks
        print(f"  📁 Deriving 6× 1h + 36× 10m sub-chunks...")
        current_hour = chunk_start
        
        for hour_num in range(6):
            hour_end = current_hour + timedelta(hours=1)
            
            print(f"    └─ 1h [{hour_num+1}/6]: {current_hour.strftime('%H:%M:%S')} → {hour_end.strftime('%Y-%m-%d %H:%M:%S')}")
            
            # Extract 1h data from 6h trace
            hour_data = extract_10m_subchunk(trace_6h, chunk_start, current_hour, hour_end, sample_rate)
            
            # Create mini-trace for this hour
            from obspy import Trace
            hour_trace = Trace(data=hour_data)
            hour_trace.stats.sampling_rate = sample_rate
            
            # Create 1h chunk
            status_1h, _ = create_1h_chunk(network, station, location, channel, volcano, sample_rate,
                                          current_hour, hour_end, hour_trace, gaps_6h)
            if status_1h == 'success':
                total_1h += 1
            
            # Derive 6× 10m sub-chunks from this 1h
            minute_start = current_hour
            for min_num in range(6):
                minute_end = minute_start + timedelta(minutes=10)
                
                minute_data = extract_10m_subchunk(trace_6h, chunk_start, minute_start, minute_end, sample_rate)
                
                if len(minute_data) > 0:
                    status_10m, _ = create_10m_chunk(network, station, location, channel, volcano, sample_rate,
                                                    minute_start, minute_end, minute_data, trace_6h)
                    if status_10m == 'success':
                        total_10m += 1
                
                minute_start = minute_end
            
            current_hour = hour_end
        
        # Save metadata after this 6h chunk is complete
        print()
        save_metadata_for_date(network, station, location, channel, volcano, sample_rate, chunk_date)
        print(f"  ✅ 6h chunk {chunk_num}/4 complete!")
    
    print()
    print("=" * 80)
    print("🎉 BACKFILL COMPLETE!")
    print("=" * 80)
    print(f"🌐 IRIS Fetches: {total_iris_fetches}")
    print(f"📁 Files Created:")
    print(f"   ├─ 6h chunks:  {total_6h}")
    print(f"   ├─ 1h chunks:  {total_1h}")
    print(f"   └─ 10m chunks: {total_10m}")
    print(f"   TOTAL: {total_6h + total_1h + total_10m} files")
    if total_iris_fetches > 0:
        print(f"📊 Efficiency: {(total_6h + total_1h + total_10m) / total_iris_fetches:.1f} files per IRIS fetch")
    else:
        print(f"📊 Perfect! All chunks already existed - no IRIS fetches needed!")
    print("=" * 80)

if __name__ == '__main__':
    # Use the 6h strategy - fills gap + 4 complete 6h blocks = ~24+ hours
    backfill_6h_strategy(
        network='HV',
        station='MOKD',
        location='--',
        channel='HHZ',
        volcano='maunaloa',
        sample_rate=100,
        force_recreate=False  # We already cleaned manually, don't delete again
    )

