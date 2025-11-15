#!/usr/bin/env python3
"""
Check what 1-hour chunks are available for HV.OBL to see if we have 4 consecutive hours.
"""

import os
import boto3
import json
from datetime import datetime, timezone, timedelta
from botocore.config import Config
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

R2_ENDPOINT = f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

# Initialize S3 client for R2
s3_config = Config(
    region_name='auto',
    s3={'addressing_style': 'path'}
)

s3 = boto3.client(
    's3',
    endpoint_url=R2_ENDPOINT,
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    config=s3_config
)

def get_1h_chunks_for_station(network='HV', volcano='kilauea', station='OBL', location='--', channel='HHZ', days_back=2):
    """Get all 1h chunks for a station from the last N days."""
    now = datetime.now(timezone.utc)
    chunks = []
    
    for day_offset in range(days_back):
        check_date = now - timedelta(days=day_offset)
        year = check_date.year
        month = str(check_date.month).zfill(2)
        day = str(check_date.day).zfill(2)
        date_str = f"{year}-{month}-{day}"
        
        # Try to load metadata file
        metadata_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location}/{channel}/HV_{station}_{location}_{channel}_100Hz_{date_str}.json"
        
        try:
            response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
            metadata = json.loads(response['Body'].read())
            
            if 'chunks' in metadata and '1h' in metadata['chunks']:
                for chunk in metadata['chunks']['1h']:
                    chunk_start = datetime.fromisoformat(f"{date_str}T{chunk['start']}Z")
                    chunk_end = datetime.fromisoformat(f"{date_str}T{chunk['end']}Z")
                    chunks.append({
                        'start': chunk_start,
                        'end': chunk_end,
                        'date': date_str,
                        'samples': chunk.get('samples', 0),
                        'min': chunk.get('min'),
                        'max': chunk.get('max')
                    })
        except s3.exceptions.NoSuchKey:
            print(f"  No metadata for {date_str}")
        except Exception as e:
            print(f"  Error loading {date_str}: {e}")
    
    # Sort by start time
    chunks.sort(key=lambda x: x['start'])
    return chunks

def check_4hour_coverage(chunks):
    """Check if we have 4 consecutive hours of 1h chunks."""
    if len(chunks) < 4:
        return False, None
    
    # Look for 4 consecutive hours
    for i in range(len(chunks) - 3):
        window = chunks[i:i+4]
        
        # Check if they're consecutive (each chunk should be ~1 hour after the previous)
        is_consecutive = True
        for j in range(1, len(window)):
            time_diff = (window[j]['start'] - window[j-1]['end']).total_seconds()
            # Allow up to 2 seconds gap (some chunks might end at 59:59 and next starts at 00:00)
            if time_diff > 2:
                is_consecutive = False
                break
        
        if is_consecutive:
            total_duration = (window[-1]['end'] - window[0]['start']).total_seconds() / 3600
            if total_duration >= 3.9:  # At least ~4 hours
                return True, window
    
    return False, None

if __name__ == '__main__':
    print("🔍 Checking 1-hour chunks for HV.OBL (last 2 days)...\n")
    
    chunks = get_1h_chunks_for_station()
    
    print(f"Found {len(chunks)} 1-hour chunks:\n")
    for i, chunk in enumerate(chunks, 1):
        duration = (chunk['end'] - chunk['start']).total_seconds() / 60
        print(f"  {i}. {chunk['start'].strftime('%Y-%m-%d %H:%M:%S')} → {chunk['end'].strftime('%H:%M:%S')} ({duration:.1f} min, {chunk['samples']:,} samples)")
    
    if len(chunks) == 0:
        print("\n❌ No 1-hour chunks found!")
    else:
        print(f"\n📊 Summary:")
        print(f"   Total chunks: {len(chunks)}")
        print(f"   Time span: {chunks[0]['start'].strftime('%Y-%m-%d %H:%M')} → {chunks[-1]['end'].strftime('%Y-%m-%d %H:%M')}")
        
        # Check for 4-hour coverage
        has_4h, window = check_4hour_coverage(chunks)
        
        if has_4h:
            print(f"\n✅ Found 4 consecutive hours!")
            print(f"   Window: {window[0]['start'].strftime('%Y-%m-%d %H:%M')} → {window[-1]['end'].strftime('%H:%M')}")
            print(f"   Duration: {(window[-1]['end'] - window[0]['start']).total_seconds() / 3600:.2f} hours")
        else:
            print(f"\n❌ No 4 consecutive hours found")
            if len(chunks) >= 4:
                print(f"   (Have {len(chunks)} chunks but they're not consecutive)")

