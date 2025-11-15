#!/usr/bin/env python3
"""
Fill Single Gap - Targeted script to fill a specific 10-minute gap

Fills: HV.MOKD.--.HHZ 2025-11-13 07:00:00 to 07:10:00 UTC
"""

import os
import json
import boto3
import numpy as np
from datetime import datetime, timezone
from pathlib import Path
from obspy import UTCDateTime
from obspy.clients.fdsn import Client
import zstandard as zstd
from dotenv import load_dotenv

# Load environment variables from .env file
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
    """Load metadata for a single date. Returns metadata dict or None if doesn't exist."""
    s3 = get_s3_client()
    location_str = location if location and location != '--' else '--'
    
    year, month, day = date_str.split('-')
    metadata_filename = f"{network}_{station}_{location_str}_{channel}_{date_str}.json"
    
    if USE_R2:
        metadata_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/{metadata_filename}"
        try:
            response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
            metadata = json.loads(response['Body'].read().decode('utf-8'))
            return metadata
        except s3.exceptions.NoSuchKey:
            return None
    else:
        # Local mode
        metadata_dir = Path(__file__).parent / 'cron_output' / 'data' / year / month / day / network / volcano / station / location_str / channel
        metadata_path = metadata_dir / metadata_filename
        
        if metadata_path.exists():
            with open(metadata_path, 'r') as f:
                return json.load(f)
        return None

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
        
        print(f"📡 Fetching from IRIS: {start_time.strftime('%Y-%m-%d %H:%M:%S')} to {end_time.strftime('%H:%M:%S')}")
        
        # Fetch waveform
        stream = client.get_waveforms(
            network=network,
            station=station,
            location=location if location != '--' else '',
            channel=channel,
            starttime=start_utc,
            endtime=end_utc
        )
        
        if len(stream) == 0:
            print(f"❌ No data returned from IRIS")
            return None, None
        
        # Detect gaps
        gaps = []
        gap_list = stream.get_gaps()
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
        
        # Merge traces using linear interpolation
        if len(gaps) > 0:
            print(f"🔧 Merging with linear interpolation for {len(gaps)} gap(s)...")
        stream.merge(method=1, fill_value='interpolate', interpolation_samples=0)
        
        trace = stream[0]
        
        # Ensure exact sample count
        requested_duration = end_time - start_time
        sample_rate_from_trace = trace.stats.sampling_rate
        expected_samples = int(requested_duration.total_seconds() * sample_rate_from_trace)
        actual_samples = len(trace.data)
        
        if actual_samples < expected_samples:
            missing = expected_samples - actual_samples
            last_value = trace.data[-1]
            padding = np.full(missing, last_value, dtype=trace.data.dtype)
            trace.data = np.concatenate([trace.data, padding])
            print(f"⚠️  Padded {missing} samples to reach expected {expected_samples}")
        elif actual_samples > expected_samples:
            trace.data = trace.data[:expected_samples]
            print(f"⚠️  Truncated {actual_samples - expected_samples} extra samples")
        
        print(f"✓ Received {len(trace.data)} samples, {len(gaps)} gaps")
        
        return trace, gaps
        
    except Exception as e:
        print(f"❌ IRIS fetch failed: {e}")
        import traceback
        traceback.print_exc()
        return None, None

def create_10m_chunk(network, station, location, channel, volcano, sample_rate,
                     start_time, end_time, data_array):
    """
    Create a 10-minute chunk from waveform data.
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
                    print(f"⏭️  10m chunk {start_time.strftime('%H:%M:%S')} already exists, skipping")
                    return 'skipped', None
        
        print(f"📦 Creating 10m chunk: {start_time.strftime('%H:%M:%S')} to {end_time.strftime('%H:%M:%S')}")
        
        # Convert to int32 (direct cast - NO NORMALIZATION!)
        data_int32 = data_array.astype(np.int32)
        
        print(f"📊 Converted {len(data_int32)} samples")
        
        # Calculate min/max
        min_val = int(np.min(data_int32))
        max_val = int(np.max(data_int32))
        
        # Compress data
        compressor = zstd.ZstdCompressor(level=3)
        compressed = compressor.compress(data_int32.tobytes())
        print(f"🗜️  Compressed: {len(data_int32.tobytes())} → {len(compressed)} bytes ({len(compressed)/len(data_int32.tobytes())*100:.1f}%)")
        
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
            print(f"💾 Uploaded to R2: {r2_key}")
        else:
            # Local save
            base_dir = Path(__file__).parent / 'cron_output'
            chunk_dir = base_dir / 'data' / str(year) / month / day / network / volcano / station / location_str / channel / '10m'
            chunk_dir.mkdir(parents=True, exist_ok=True)
            chunk_path = chunk_dir / filename
            with open(chunk_path, 'wb') as f:
                f.write(compressed)
            print(f"💾 Saved locally: {chunk_path}")
        
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
            'gap_count': 0,
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
            print(f"✅ Metadata updated in R2")
        else:
            metadata_dir = Path(__file__).parent / 'cron_output' / 'data' / str(year) / month / day / network / volcano / station / location_str / channel
            metadata_dir.mkdir(parents=True, exist_ok=True)
            metadata_path = metadata_dir / metadata_filename
            with open(metadata_path, 'w') as f:
                json.dump(metadata, f, indent=2)
            print(f"✅ Metadata updated locally")
        
        return 'success', None
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return 'failed', {'error': str(e)}

def fill_gap():
    """
    Fill the specific 10-minute gap: 2025-11-13 07:00:00 to 07:10:00 UTC
    """
    print("=" * 80)
    print("🔧 Fill Single Gap: HV.MOKD.--.HHZ")
    print("📅 2025-11-13 07:00:00 to 07:10:00 UTC")
    print("=" * 80)
    print()
    
    # Station configuration
    network = 'HV'
    station = 'MOKD'
    location = '--'
    channel = 'HHZ'
    volcano = 'maunaloa'
    sample_rate = 100
    
    # Time window
    start_time = datetime(2025, 11, 13, 7, 0, 0, tzinfo=timezone.utc)
    end_time = datetime(2025, 11, 13, 7, 10, 0, tzinfo=timezone.utc)
    
    print(f"📡 Fetching waveform from IRIS...")
    trace, gaps = fetch_waveform_from_iris(network, station, location, channel, start_time, end_time, sample_rate)
    
    if trace is None:
        print("❌ Failed to fetch from IRIS")
        return
    
    print()
    print(f"📦 Creating 10m chunk...")
    status, error = create_10m_chunk(network, station, location, channel, volcano, sample_rate,
                                     start_time, end_time, trace.data)
    
    if status == 'success':
        print()
        print("=" * 80)
        print("✅ Gap filled successfully!")
        print("=" * 80)
    elif status == 'skipped':
        print()
        print("=" * 80)
        print("⏭️  Chunk already exists, nothing to do")
        print("=" * 80)
    else:
        print()
        print("=" * 80)
        print(f"❌ Failed to create chunk: {error}")
        print("=" * 80)

if __name__ == '__main__':
    fill_gap()


