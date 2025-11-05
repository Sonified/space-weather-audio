#!/usr/bin/env python3
"""
Railway Cron Job - Automated Seismic Data Collection

Runs every 10 minutes at :02, :12, :22, :32, :42, :52
Fetches latest data from IRIS and stores in R2 cache.

Logic:
- Always: Fetch previous 10-minute chunk
- At 6-hour checkpoints (00:02, 06:02, 12:02, 18:02): Also fetch previous 6-hour chunk
- Only process active stations from stations_config.json
"""

import os
import sys
import json
import numpy as np
import zstandard as zstd
from datetime import datetime, timedelta, timezone
from obspy import UTCDateTime
from obspy.clients.fdsn import Client
from pathlib import Path
import time
import boto3
import logging

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S UTC'
)
logger = logging.getLogger(__name__)

# R2 Configuration
R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID', '66f906f29f28b08ae9c80d4f36e25c7a')
R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '9e1cf6c395172f108c2150c52878859f')
R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec')
R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')

# Initialize S3 client for R2
s3_client = boto3.client(
    's3',
    endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    region_name='auto'
) if R2_ACCESS_KEY_ID else None


def determine_fetch_windows(current_time, iris_delay_minutes=2):
    """
    Determine what time windows to fetch based on current time.
    Returns list of (start_time, end_time, chunk_type) tuples.
    
    Logic:
    - Always: 10-minute chunk
    - At top of each hour: 1-hour chunk
    - At 6-hour checkpoints (00:02, 06:02, 12:02, 18:02): 6-hour chunk
    """
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


def load_active_stations():
    """Load active stations from stations_config.json"""
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


def detect_gaps(stream, sample_rate):
    """
    Detect gaps in ObsPy stream before merging.
    Returns list of gap dictionaries.
    """
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
    
    return gaps


def process_station_window(network, station, location, channel, volcano, sample_rate,
                           start_time, end_time, chunk_type):
    """
    Fetch and process data for one station and one time window.
    Returns (success, metadata) tuple.
    """
    logger.info(f"[{volcano}] {network}.{station}.{location}.{channel} - {chunk_type} {start_time} to {end_time}")
    
    try:
        # Fetch from IRIS
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
            logger.warning(f"  ❌ No data returned from IRIS")
            return False, None
        
        logger.info(f"  ✅ Got {len(st)} trace(s)")
        
        # Detect gaps BEFORE merging
        gaps = detect_gaps(st, sample_rate)
        if gaps:
            logger.info(f"  ⚠️  {len(gaps)} gaps detected")
        
        # Merge and interpolate
        st.merge(method=1, fill_value='interpolate', interpolation_samples=0)
        trace = st[0]
        
        # Round to second boundaries
        original_end = trace.stats.endtime
        rounded_end = UTCDateTime(int(original_end.timestamp))
        duration_seconds = int(rounded_end.timestamp - trace.stats.starttime.timestamp)
        samples_per_second = int(trace.stats.sampling_rate)
        full_second_samples = duration_seconds * samples_per_second
        
        data = trace.data[:full_second_samples]
        trace.data = data
        
        # Convert to int32
        data_int32 = data.astype(np.int32)
        min_val = int(np.min(data_int32))
        max_val = int(np.max(data_int32))
        
        logger.info(f"  ✅ Processed {len(data_int32):,} samples, min/max={min_val}/{max_val}")
        
        # Compress with Zstd
        compressor = zstd.ZstdCompressor(level=3)
        compressed = compressor.compress(data_int32.tobytes())
        
        compression_ratio = len(compressed) / len(data_int32.tobytes()) * 100
        logger.info(f"  ✅ Compressed {compression_ratio:.1f}% (saved {100-compression_ratio:.1f}%)")
        
        # Generate filename
        start_str = trace.stats.starttime.datetime.strftime("%Y-%m-%d-%H-%M-%S")
        end_str = trace.stats.endtime.datetime.strftime("%Y-%m-%d-%H-%M-%S")
        rate_str = f"{sample_rate:.2f}".rstrip('0').rstrip('.') if '.' in str(sample_rate) else str(int(sample_rate))
        location_str = location if location and location != '--' else '--'
        
        filename = f"{network}_{station}_{location_str}_{channel}_{rate_str}Hz_{chunk_type}_{start_str}_to_{end_str}.bin.zst"
        
        # Generate paths
        year = trace.stats.starttime.datetime.year
        month = f"{trace.stats.starttime.datetime.month:02d}"
        date_str = trace.stats.starttime.datetime.strftime("%Y-%m-%d")
        
        # Metadata filename
        metadata_filename = f"{network}_{station}_{location_str}_{channel}_{rate_str}Hz_{date_str}.json"
        
        # Upload to R2 (or save locally if no credentials)
        if s3_client:
            # New structure: files organized by chunk type in subfolders
            r2_key = f"data/{year}/{month}/{network}/{volcano}/{station}/{location_str}/{channel}/{chunk_type}/{filename}"
            metadata_key = f"data/{year}/{month}/{network}/{volcano}/{station}/{location_str}/{channel}/{metadata_filename}"
            
            # Upload chunk file
            s3_client.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=r2_key,
                Body=compressed,
                ContentType='application/octet-stream'
            )
            logger.info(f"  💾 Uploaded to R2: {r2_key}")
            
            # Load or create metadata
            try:
                response = s3_client.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
                metadata = json.loads(response['Body'].read().decode('utf-8'))
                logger.info(f"  📖 Loaded existing metadata ({len(metadata['chunks']['10m'])} 10m, {len(metadata['chunks'].get('1h', []))} 1h, {len(metadata['chunks']['6h'])} 6h)")
            except s3_client.exceptions.NoSuchKey:
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
                logger.info(f"  📝 Creating new metadata")
            
            # Append chunk metadata
            chunk_meta = {
                'start': trace.stats.starttime.datetime.strftime("%H:%M:%S"),
                'end': trace.stats.endtime.datetime.strftime("%H:%M:%S"),
                'min': min_val,
                'max': max_val,
                'samples': len(data_int32),
                'gap_count': len(gaps),
                'gap_samples_filled': sum(g['samples_filled'] for g in gaps)
            }
            
            metadata['chunks'][chunk_type].append(chunk_meta)
            
            # SORT by start time (chronological)
            metadata['chunks']['10m'].sort(key=lambda c: c['start'])
            metadata['chunks']['1h'].sort(key=lambda c: c['start'])
            metadata['chunks']['6h'].sort(key=lambda c: c['start'])
            
            # Update complete_day flag
            if len(metadata['chunks']['10m']) >= 144:
                metadata['complete_day'] = True
            
            # Upload updated metadata to R2
            s3_client.put_object(
                Bucket=R2_BUCKET_NAME,
                Key=metadata_key,
                Body=json.dumps(metadata, indent=2).encode('utf-8'),
                ContentType='application/json'
            )
            logger.info(f"  💾 Updated metadata: {len(metadata['chunks']['10m'])} 10m, {len(metadata['chunks'].get('1h', []))} 1h, {len(metadata['chunks']['6h'])} 6h (sorted)")
            
        else:
            # Save locally with proper folder hierarchy (organized by chunk type)
            base_dir = Path(__file__).parent / 'cron_output'
            channel_dir = base_dir / 'data' / str(year) / month / network / volcano / station / location_str / channel
            chunk_dir = channel_dir / chunk_type
            chunk_dir.mkdir(parents=True, exist_ok=True)
            
            chunk_path = chunk_dir / filename
            with open(chunk_path, 'wb') as f:
                f.write(compressed)
            logger.info(f"  💾 Saved chunk: {chunk_path}")
            
            # Load or create metadata (at parent channel directory)
            metadata_path = channel_dir / metadata_filename
            if metadata_path.exists():
                with open(metadata_path, 'r') as f:
                    metadata = json.load(f)
                logger.info(f"  📖 Loaded existing metadata ({len(metadata['chunks']['10m'])} 10m, {len(metadata['chunks'].get('1h', []))} 1h, {len(metadata['chunks']['6h'])} 6h)")
            else:
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
                logger.info(f"  📝 Creating new metadata")
            
            # Append chunk metadata
            chunk_meta = {
                'start': trace.stats.starttime.datetime.strftime("%H:%M:%S"),
                'end': trace.stats.endtime.datetime.strftime("%H:%M:%S"),
                'min': min_val,
                'max': max_val,
                'samples': len(data_int32),
                'gap_count': len(gaps),
                'gap_samples_filled': sum(g['samples_filled'] for g in gaps)
            }
            
            metadata['chunks'][chunk_type].append(chunk_meta)
            
            # SORT by start time (chronological)
            metadata['chunks']['10m'].sort(key=lambda c: c['start'])
            metadata['chunks']['1h'].sort(key=lambda c: c['start'])
            metadata['chunks']['6h'].sort(key=lambda c: c['start'])
            
            # Update complete_day flag
            if len(metadata['chunks']['10m']) >= 144:
                metadata['complete_day'] = True
            
            # Save updated metadata
            with open(metadata_path, 'w') as f:
                json.dump(metadata, f, indent=2)
            logger.info(f"  💾 Updated metadata: {len(metadata['chunks']['10m'])} 10m, {len(metadata['chunks'].get('1h', []))} 1h, {len(metadata['chunks']['6h'])} 6h (sorted)")
        
        # Return chunk metadata for future use
        chunk_metadata = {
            'start': trace.stats.starttime.datetime.strftime("%H:%M:%S"),
            'end': trace.stats.endtime.datetime.strftime("%H:%M:%S"),
            'min': min_val,
            'max': max_val,
            'samples': len(data_int32),
            'gap_count': len(gaps),
            'gap_samples_filled': sum(g['samples_filled'] for g in gaps)
        }
        
        return True, chunk_metadata
        
    except Exception as e:
        logger.error(f"  ❌ Error: {e}")
        return False, None


def main():
    """Main cron job entry point"""
    logger.info("=" * 100)
    logger.info("CRON JOB START")
    logger.info("=" * 100)
    
    # Check for simulated time (for testing)
    if len(sys.argv) > 1:
        simulated_time_str = sys.argv[1]
        now_utc = datetime.fromisoformat(simulated_time_str.replace('Z', '+00:00'))
        logger.info(f"🧪 SIMULATION MODE - Using simulated time: {simulated_time_str}")
    else:
        now_utc = datetime.now(timezone.utc)
    
    windows = determine_fetch_windows(now_utc)
    
    logger.info(f"Current time: {now_utc.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    logger.info(f"Windows to fetch: {len(windows)}")
    for start, end, chunk_type in windows:
        logger.info(f"  {chunk_type}: {start.strftime('%Y-%m-%d %H:%M:%S')} to {end.strftime('%H:%M:%S')}")
    logger.info("")
    
    # Load active stations
    active_stations = load_active_stations()
    logger.info(f"Active stations: {len(active_stations)}")
    logger.info("")
    
    if not active_stations:
        logger.warning("No active stations configured - exiting")
        sys.exit(0)
    
    # Process each station for each window
    total_tasks = len(active_stations) * len(windows)
    current_task = 0
    successful = 0
    failed = 0
    
    for station_config in active_stations:
        network = station_config['network']
        volcano = station_config['volcano']
        station = station_config['station']
        location = station_config['location']
        channel = station_config['channel']
        sample_rate = station_config['sample_rate']
        
        for start, end, chunk_type in windows:
            current_task += 1
            logger.info(f"[{current_task}/{total_tasks}] Processing...")
            
            success, chunk_meta = process_station_window(
                network, station, location, channel, volcano, sample_rate,
                start, end, chunk_type
            )
            
            if success:
                successful += 1
                # TODO: Update metadata JSON in R2
            else:
                failed += 1
            
            # Small delay between requests
            if current_task < total_tasks:
                time.sleep(1)
    
    # Summary
    logger.info("")
    logger.info("=" * 100)
    logger.info("CRON JOB COMPLETE")
    logger.info("=" * 100)
    logger.info(f"Total tasks: {total_tasks}")
    logger.info(f"Successful: {successful}")
    logger.info(f"Failed: {failed}")
    logger.info("=" * 100)
    
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    main()

