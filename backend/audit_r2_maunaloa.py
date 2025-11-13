#!/usr/bin/env python3
"""
Audit R2 storage for Mauna Loa stations - last 24 hours
Shows what files and metadata actually exist on R2
"""
import boto3
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import os

# Load environment
R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID')
R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID')
R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY')
R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')

if not all([R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY]):
    print("❌ Missing R2 credentials in environment")
    exit(1)

# Get S3 client
s3 = boto3.client(
    's3',
    endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    region_name='auto'
)

# Mauna Loa stations (from stations_config.json)
maunaloa_stations = [
    {'network': 'HV', 'station': 'MOKD', 'location': '--', 'channel': 'HHZ'},
    {'network': 'HV', 'station': 'MOKE', 'location': '--', 'channel': 'HHZ'},
    {'network': 'HV', 'station': 'MOKL', 'location': '--', 'channel': 'HHZ'},
    {'network': 'HV', 'station': 'MOKT', 'location': '--', 'channel': 'HHZ'},
    {'network': 'HV', 'station': 'MOKB', 'location': '--', 'channel': 'BHZ'},
]

# Get last 24 hours dates
now = datetime.now(timezone.utc)
dates = [
    (now - timedelta(days=1)).strftime('%Y-%m-%d'),
    now.strftime('%Y-%m-%d')
]

print(f"🔍 Auditing R2 for Mauna Loa stations")
print(f"📅 Dates: {dates}")
print(f"📦 Bucket: {R2_BUCKET_NAME}")
print("=" * 80)
print()

for station_config in maunaloa_stations:
    network = station_config['network']
    station = station_config['station']
    location = station_config['location']
    channel = station_config['channel']
    
    print(f"🔍 Station: {network}.{station}.{location}.{channel}")
    print("-" * 80)
    
    for date_str in dates:
        year = date_str[:4]
        month = date_str[5:7]
        day = date_str[8:10]
        
        # Check metadata
        metadata_key = f"data/{year}/{month}/{day}/{network}/maunaloa/{station}/{location}/{channel}/{network}_{station}_{location}_{channel}_{date_str}.json"
        
        try:
            response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
            metadata = json.loads(response['Body'].read().decode('utf-8'))
            
            print(f"  📋 {date_str} Metadata: ✅ EXISTS")
            print(f"     Chunks: 10m={len(metadata['chunks'].get('10m', []))}, 1h={len(metadata['chunks'].get('1h', []))}, 6h={len(metadata['chunks'].get('6h', []))}")
            
            # Check if actual binary files exist for a sample
            chunk_types = ['10m', '1h', '6h']
            for chunk_type in chunk_types:
                chunks = metadata['chunks'].get(chunk_type, [])
                if chunks:
                    # Check first chunk
                    first_chunk = chunks[0]
                    start_str = first_chunk['start'].replace(':', '-')
                    end_str = first_chunk['end'].replace(':', '-')
                    
                    # Construct expected filename
                    sample_key = f"data/{year}/{month}/{day}/{network}/maunaloa/{station}/{location}/{channel}/{chunk_type}/{network}_{station}_{location}_{channel}_{chunk_type}_{date_str}-{start_str}_to_{date_str}-{end_str}.bin.zst"
                    
                    try:
                        s3.head_object(Bucket=R2_BUCKET_NAME, Key=sample_key)
                        print(f"     Sample {chunk_type} file: ✅ EXISTS")
                    except:
                        print(f"     Sample {chunk_type} file: ❌ MISSING")
                        print(f"       Expected: {sample_key}")
                
        except s3.exceptions.NoSuchKey:
            print(f"  📋 {date_str} Metadata: ❌ MISSING")
            print(f"     Key: {metadata_key}")
    
    print()

print("=" * 80)
print("✅ Audit complete!")

