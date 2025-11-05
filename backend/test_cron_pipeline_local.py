#!/usr/bin/env python3
"""
Local test of the cron job data pipeline.
Tests: IRIS fetch → process → compress → R2 upload → metadata

Run a single station through the complete pipeline to validate:
1. Data fetching from IRIS
2. Processing (merge, dedupe, interpolate, round to seconds)
3. Compression with Zstd
4. R2 upload (optional - can skip for initial testing)
5. Metadata generation and updates
"""

import os
import sys
import json
import numpy as np
import zstandard as zstd
from datetime import datetime, timedelta, timezone
from obspy import UTCDateTime
from obspy.clients.fdsn import Client
import boto3

# Add current directory to path
sys.path.insert(0, os.path.dirname(__file__))

# Configuration
TEST_STATION = {
    'network': 'HV',
    'station': 'UWE',
    'location': '',
    'channel': 'HHZ',
    'volcano': 'kilauea',
    'sample_rate': 100.0,
    'distance_km': 0.4
}

# Time window (test with 6 hours to see more data and potential gaps)
DURATION_HOURS = 6
IRIS_DELAY_MINUTES = 2

# R2 Configuration (optional - set SKIP_R2_UPLOAD=True to test without uploading)
SKIP_R2_UPLOAD = True  # Change to False to test R2 upload
R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID', '66f906f29f28b08ae9c80d4f36e25c7a')
R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID')
R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY')
R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')

print("=" * 80)
print("CRON PIPELINE LOCAL TEST")
print("=" * 80)
print(f"Test Station: {TEST_STATION['network']}.{TEST_STATION['station']}.{TEST_STATION['channel']}")
print(f"Duration: {DURATION_HOURS} hours")
print(f"R2 Upload: {'DISABLED (local testing only)' if SKIP_R2_UPLOAD else 'ENABLED'}")
print("=" * 80)
print()

# Calculate time window - QUANTIZE TO 6-HOUR BOUNDARIES!
now_utc = datetime.now(timezone.utc)

# Round DOWN to the nearest 6-hour mark (00:00, 06:00, 12:00, 18:00)
current_hour = now_utc.hour
quantized_hour = (current_hour // 6) * 6

# Go back ONE 6-hour window to test metadata append (18:00-00:00)
quantized_time = now_utc.replace(hour=quantized_hour, minute=0, second=0, microsecond=0)
quantized_time = quantized_time - timedelta(hours=6)  # One window back for append test

# 6-hour chunk boundaries
start_time = quantized_time
end_time = quantized_time + timedelta(hours=DURATION_HOURS)

print(f"Time Window (6-hour chunk):")
print(f"  Start: {start_time.strftime('%Y-%m-%d %H:%M:%S UTC')}")
print(f"  End:   {end_time.strftime('%Y-%m-%d %H:%M:%S UTC')}")
print(f"  Duration: {DURATION_HOURS} hours")
print()

# ============================================================================
# STEP 1: Fetch from IRIS
# ============================================================================
print("STEP 1: Fetching from IRIS...")
print("-" * 80)

client = Client("IRIS")

try:
    st = client.get_waveforms(
        network=TEST_STATION['network'],
        station=TEST_STATION['station'],
        location=TEST_STATION['location'] if TEST_STATION['location'] else "",
        channel=TEST_STATION['channel'],
        starttime=UTCDateTime(start_time),
        endtime=UTCDateTime(end_time)
    )
    
    if not st or len(st) == 0:
        print("❌ No data returned from IRIS")
        sys.exit(1)
    
    print(f"✅ Received {len(st)} trace(s) from IRIS")
    for i, trace in enumerate(st):
        print(f"   Trace {i+1}: {len(trace.data):,} samples, {trace.stats.starttime} to {trace.stats.endtime}")
    print()
    
except Exception as e:
    print(f"❌ IRIS fetch failed: {e}")
    sys.exit(1)

# ============================================================================
# STEP 2: Process data (merge, interpolate, round to seconds)
# ============================================================================
print("STEP 2: Processing data...")
print("-" * 80)

# Detect gaps BEFORE merging (matches main_v2.py approach)
gaps = []
gap_list = st.get_gaps()

if gap_list and len(gap_list) > 0:
    print(f"⚠️  Detected {len(gap_list)} gap(s)")
    for gap in gap_list:
        # Gap tuple: (network, station, location, channel, starttime, endtime, duration, samples)
        gap_start = UTCDateTime(gap[4])
        gap_end = UTCDateTime(gap[5])
        duration = gap_end - gap_start  # Duration in seconds
        # Use station sample rate for calculation
        samples_filled = int(round(duration * TEST_STATION['sample_rate']))
        
        gaps.append({
            'start': gap_start.isoformat(),
            'end': gap_end.isoformat(),
            'samples_filled': samples_filled
        })
        print(f"   Gap: {gap_start} to {gap_end} ({duration:.3f}s, {samples_filled} samples)")
else:
    print(f"✅ No gaps detected (continuous data)")

# Merge traces and interpolate gaps
print("Merging traces and filling gaps...")
st.merge(method=1, fill_value='interpolate', interpolation_samples=0)
trace = st[0]

print(f"✅ Merged into single trace: {len(trace.data):,} samples")

# Round to second boundaries
print("Rounding to second boundaries...")
original_end = trace.stats.endtime
rounded_end = UTCDateTime(int(original_end.timestamp))

duration_seconds = int(rounded_end.timestamp - trace.stats.starttime.timestamp)
samples_per_second = int(trace.stats.sampling_rate)
full_second_samples = duration_seconds * samples_per_second

# Trim to full seconds (endtime updates automatically)
data = trace.data[:full_second_samples]
trace.data = data
# Note: trace.stats.endtime is read-only and updates automatically when data changes

print(f"✅ Trimmed to {duration_seconds} full seconds ({full_second_samples:,} samples)")
print(f"   Start: {trace.stats.starttime}")
print(f"   End:   {trace.stats.endtime}")

# Convert to int32
data_int32 = data.astype(np.int32)

# Calculate min/max for metadata
min_val = int(np.min(data_int32))
max_val = int(np.max(data_int32))

print(f"✅ Converted to int32: min={min_val}, max={max_val}")
print()

# Determine chunk type based on duration
chunk_type = '6h' if DURATION_HOURS >= 6 else '10m'

# ============================================================================
# STEP 3: Compress with Zstd
# ============================================================================
print("STEP 3: Compressing with Zstd...")
print("-" * 80)

compressor = zstd.ZstdCompressor(level=3)
data_bytes = data_int32.tobytes()
compressed = compressor.compress(data_bytes)

original_size_mb = len(data_bytes) / 1024 / 1024
compressed_size_mb = len(compressed) / 1024 / 1024
compression_ratio = (len(compressed) / len(data_bytes)) * 100

print(f"✅ Compressed with Zstd level 3")
print(f"   Original:   {original_size_mb:.3f} MB")
print(f"   Compressed: {compressed_size_mb:.3f} MB")
print(f"   Ratio:      {compression_ratio:.1f}% (saved {100-compression_ratio:.1f}%)")
print()

# ============================================================================
# STEP 4: Generate self-describing filename
# ============================================================================
print("STEP 4: Generating filename...")
print("-" * 80)

# Format timestamps for filename
start_str = trace.stats.starttime.datetime.strftime("%Y-%m-%d-%H-%M-%S")
end_str = trace.stats.endtime.datetime.strftime("%Y-%m-%d-%H-%M-%S")

# Format sample rate (handle fractional rates)
rate = TEST_STATION['sample_rate']
rate_str = f"{rate:.2f}".rstrip('0').rstrip('.') if '.' in str(rate) else str(int(rate))

# Location: use "--" for empty string (SEED convention)
location_str = TEST_STATION['location'] if TEST_STATION['location'] else '--'

# Chunk size indicator for filename readability
chunk_size_str = '6h' if chunk_type == '6h' else '10m'

# Self-describing filename with chunk size
filename = f"{TEST_STATION['network']}_{TEST_STATION['station']}_{location_str}_{TEST_STATION['channel']}_{rate_str}Hz_{chunk_size_str}_{start_str}_to_{end_str}.bin.zst"

print(f"✅ Filename: {filename}")
print()

# ============================================================================
# STEP 5: Generate R2 path
# ============================================================================
print("STEP 5: Generating R2 path...")
print("-" * 80)

year = trace.stats.starttime.datetime.year
month = f"{trace.stats.starttime.datetime.month:02d}"

# Use "--" for empty location in path too (consistency)
location_path = TEST_STATION['location'] if TEST_STATION['location'] else '--'

r2_path = f"data/{year}/{month}/{TEST_STATION['network']}/{TEST_STATION['volcano']}/{TEST_STATION['station']}/{location_path}/{TEST_STATION['channel']}/{filename}"

print(f"✅ R2 Path:")
print(f"   {r2_path}")
print()

# ============================================================================
# STEP 6: Generate metadata
# ============================================================================
print("STEP 6: Generating metadata...")
print("-" * 80)

date_str = trace.stats.starttime.datetime.strftime("%Y-%m-%d")
metadata_filename = f"{TEST_STATION['network']}_{TEST_STATION['station']}_{location_str}_{TEST_STATION['channel']}_{rate_str}Hz_{date_str}.json"
metadata_path = f"data/{year}/{month}/{TEST_STATION['network']}/{TEST_STATION['volcano']}/{TEST_STATION['station']}/{location_path}/{TEST_STATION['channel']}/{metadata_filename}"

# Calculate chunk metadata
gap_count = len(gaps)
gap_samples_filled = sum(g['samples_filled'] for g in gaps)

chunk_metadata = {
    'start': trace.stats.starttime.datetime.strftime("%H:%M:%S"),
    'end': trace.stats.endtime.datetime.strftime("%H:%M:%S"),
    'min': min_val,
    'max': max_val,
    'samples': len(data_int32),
    'gap_count': gap_count,
    'gap_samples_filled': gap_samples_filled
    # Note: gap_duration_seconds can be derived: gap_samples_filled / sample_rate
}

print(f"✅ Chunk Metadata:")
print(f"   Start: {chunk_metadata['start']}")
print(f"   End: {chunk_metadata['end']}")
print(f"   Samples: {chunk_metadata['samples']:,}")
print(f"   Min/Max: {chunk_metadata['min']} / {chunk_metadata['max']}")
gap_duration = chunk_metadata['gap_samples_filled'] / TEST_STATION['sample_rate']
print(f"   Gaps: {chunk_metadata['gap_count']} ({gap_duration:.3f}s, {chunk_metadata['gap_samples_filled']} samples)")
print()
print(f"Metadata file: {metadata_filename}")
print(f"Metadata path: {metadata_path}")
print()

# ============================================================================
# STEP 7: Upload to R2 (optional)
# ============================================================================
if not SKIP_R2_UPLOAD:
    print("STEP 7: Uploading to R2...")
    print("-" * 80)
    
    if not R2_ACCESS_KEY_ID or not R2_SECRET_ACCESS_KEY:
        print("❌ R2 credentials not found in environment")
        print("   Set R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY to enable R2 upload")
        print()
    else:
        try:
            # Initialize S3 client for R2
            s3_client = boto3.client(
                's3',
                endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
                aws_access_key_id=R2_ACCESS_KEY_ID,
                aws_secret_access_key=R2_SECRET_ACCESS_KEY,
                region_name='auto'
            )
            
            # Upload compressed chunk
            print(f"Uploading chunk to R2...")
            s3_client.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=r2_path,
                Body=compressed,
                ContentType='application/octet-stream'
            )
            print(f"✅ Uploaded chunk: {r2_path}")
            
            # Check if metadata exists
            print(f"Checking for existing metadata...")
            metadata = None
            try:
                response = s3_client.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_path)
                metadata = json.loads(response['Body'].read())
                print(f"✅ Found existing metadata (will update)")
            except s3_client.exceptions.NoSuchKey:
                print(f"📝 Creating new metadata")
                metadata = {
                    'date': date_str,
                    'network': TEST_STATION['network'],
                    'volcano': TEST_STATION['volcano'],
                    'station': TEST_STATION['station'],
                    'location': TEST_STATION['location'],
                    'channel': TEST_STATION['channel'],
                    'sample_rate': TEST_STATION['sample_rate'],
                    'created_at': datetime.utcnow().isoformat() + 'Z',
                    'complete_day': False,
                    'chunks': {
                        '10min': [],
                        '6h': []
                    }
                }
            
            # Append chunk to metadata
            metadata['chunks']['10min'].append(chunk_metadata)
            
            # Update complete_day flag
            if len(metadata['chunks']['10min']) >= 144:
                metadata['complete_day'] = True
            
            # Upload metadata
            s3_client.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=metadata_path,
                Body=json.dumps(metadata, indent=2),
                ContentType='application/json'
            )
            print(f"✅ Uploaded metadata: {metadata_path}")
            print(f"   10min chunks: {len(metadata['chunks']['10min'])}")
            print(f"   Complete day: {metadata['complete_day']}")
            print()
            
        except Exception as e:
            print(f"❌ R2 upload failed: {e}")
            print()
else:
    print("STEP 7: Skipping R2 upload (local testing mode)")
    print("-" * 80)
    
    # Save to local files for inspection
    local_output_dir = os.path.join(os.path.dirname(__file__), 'test_output')
    os.makedirs(local_output_dir, exist_ok=True)
    
    chunk_path = os.path.join(local_output_dir, filename)
    with open(chunk_path, 'wb') as f:
        f.write(compressed)
    print(f"💾 Saved chunk locally: {chunk_path}")
    
    # Load existing metadata or create new
    metadata_local_path = os.path.join(local_output_dir, metadata_filename)
    
    if os.path.exists(metadata_local_path):
        print(f"📖 Loading existing metadata...")
        with open(metadata_local_path, 'r') as f:
            metadata = json.load(f)
        print(f"   Found {len(metadata['chunks']['10min'])} existing 10min chunks")
        print(f"   Found {len(metadata['chunks']['6h'])} existing 6h chunks")
    else:
        print(f"📝 Creating new metadata file...")
        metadata = {
            'date': date_str,
            'network': TEST_STATION['network'],
            'volcano': TEST_STATION['volcano'],
            'station': TEST_STATION['station'],
            'location': TEST_STATION['location'],
            'channel': TEST_STATION['channel'],
            'sample_rate': TEST_STATION['sample_rate'],
            'created_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'complete_day': False,
            'chunks': {
                '10min': [],
                '6h': []
            }
        }
    
    # Append new chunk to correct array based on chunk_type
    metadata['chunks'][chunk_type].append(chunk_metadata)
    
    # SORT chunks by start time (chronological order)
    metadata['chunks']['10min'].sort(key=lambda c: c['start'])
    metadata['chunks']['6h'].sort(key=lambda c: c['start'])
    
    # Update complete_day flag (144 chunks = complete day)
    if len(metadata['chunks']['10min']) >= 144:
        metadata['complete_day'] = True
    
    # Save updated metadata
    with open(metadata_local_path, 'w') as f:
        json.dump(metadata, f, indent=2)
    print(f"💾 Updated metadata (sorted chronologically):")
    print(f"   10min chunks: {len(metadata['chunks']['10min'])}")
    print(f"   6h chunks: {len(metadata['chunks']['6h'])}")
    print(f"   Complete day: {metadata['complete_day']}")
    print(f"   Saved to: {metadata_local_path}")
    print()

# ============================================================================
# Summary
# ============================================================================
print("=" * 80)
print("PIPELINE TEST COMPLETE")
print("=" * 80)
print(f"✅ Fetched from IRIS: {len(st)} trace(s)")
print(f"✅ Processed: {full_second_samples:,} samples ({duration_seconds}s)")
gap_duration_calc = gap_samples_filled / TEST_STATION['sample_rate']
print(f"✅ Gaps: {gap_count} ({gap_duration_calc:.3f}s, {gap_samples_filled} samples)")
print(f"✅ Compressed: {compression_ratio:.1f}% (saved {100-compression_ratio:.1f}%)")
print(f"✅ Filename: {filename}")
if not SKIP_R2_UPLOAD:
    print(f"✅ Uploaded to R2")
else:
    print(f"💾 Saved locally to: {local_output_dir}")
print()
print("Pipeline validated successfully! 🎉")
print("=" * 80)

