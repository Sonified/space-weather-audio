#!/usr/bin/env python3
"""
Test script to debug deletion of ONE file from R2.
Loads metadata, finds one chunk, and tries to delete it.
"""

import os
import json
import boto3
from datetime import datetime, timedelta, timezone
from pathlib import Path
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
    """Load metadata for a single date."""
    s3 = get_s3_client()
    location_str = location if location and location != '--' else '--'
    
    year, month, day = date_str.split('-')
    metadata_filename = f"{network}_{station}_{location_str}_{channel}_{date_str}.json"
    
    metadata_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/{metadata_filename}"
    try:
        response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
        metadata = json.loads(response['Body'].read().decode('utf-8'))
        return metadata
    except s3.exceptions.NoSuchKey:
        return None

def list_files_in_prefix(s3, prefix):
    """List all files with a given prefix"""
    try:
        response = s3.list_objects_v2(Bucket=R2_BUCKET_NAME, Prefix=prefix, MaxKeys=100)
        if 'Contents' in response:
            return [obj['Key'] for obj in response['Contents']]
        return []
    except Exception as e:
        print(f"Error listing files: {e}")
        return []

# Test parameters
network = 'HV'
station = 'MOKD'
location = '--'
channel = 'HHZ'
volcano = 'maunaloa'
sample_rate = 100
date_str = '2025-11-13'  # One of the dates being deleted

print("=" * 80)
print("🔍 Testing Deletion Logic")
print("=" * 80)
print()

# Load metadata
print(f"📖 Loading metadata for {date_str}...")
metadata = load_metadata_for_date(network, station, location, channel, volcano, date_str, sample_rate)

if not metadata:
    print("❌ No metadata found!")
    exit(1)

print(f"✅ Found metadata")
print(f"   10m chunks: {len(metadata.get('chunks', {}).get('10m', []))}")
print(f"   1h chunks: {len(metadata.get('chunks', {}).get('1h', []))}")
print(f"   6h chunks: {len(metadata.get('chunks', {}).get('6h', []))}")
print()

# Find ONE 10m chunk to test with
chunk_type = '10m'
chunks = metadata.get('chunks', {}).get(chunk_type, [])

if len(chunks) == 0:
    print("❌ No 10m chunks found, trying 1h...")
    chunk_type = '1h'
    chunks = metadata.get('chunks', {}).get(chunk_type, [])

if len(chunks) == 0:
    print("❌ No chunks found!")
    exit(1)

# Get the first chunk
test_chunk = chunks[0]
chunk_start_str = test_chunk.get('start', '')
chunk_end_str = test_chunk.get('end', '')

print(f"🎯 Testing with {chunk_type} chunk:")
print(f"   Start: {chunk_start_str}")
print(f"   End: {chunk_end_str}")
print()

# Parse the chunk time
location_str = location if location and location != '--' else '--'
year, month, day = date_str.split('-')

try:
    chunk_datetime = datetime.strptime(f"{date_str} {chunk_start_str}", '%Y-%m-%d %H:%M:%S')
    chunk_datetime = chunk_datetime.replace(tzinfo=timezone.utc)
    
    # Calculate end time
    if chunk_type == '10m':
        chunk_end_datetime = chunk_datetime + timedelta(minutes=10)
    elif chunk_type == '1h':
        chunk_end_datetime = chunk_datetime + timedelta(hours=1)
    elif chunk_type == '6h':
        chunk_end_datetime = chunk_datetime + timedelta(hours=6)
    
    print(f"📅 Parsed times:")
    print(f"   Start: {chunk_datetime}")
    print(f"   End: {chunk_end_datetime}")
    print()
    
    # Build filename (exactly like delete function)
    start_str = chunk_datetime.strftime('%Y-%m-%d-%H-%M-%S')
    end_str = chunk_end_datetime.strftime('%Y-%m-%d-%H-%M-%S')
    filename = f"{network}_{station}_{location_str}_{channel}_{chunk_type}_{start_str}_to_{end_str}.bin.zst"
    
    # Build S3 key
    s3_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/{chunk_type}/{filename}"
    
    print(f"📝 Built filename:")
    print(f"   {filename}")
    print()
    print(f"📝 Built S3 key:")
    print(f"   {s3_key}")
    print()
    
    # List what files actually exist in that prefix
    s3 = get_s3_client()
    prefix = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/{chunk_type}/"
    print(f"🔍 Listing files in prefix:")
    print(f"   {prefix}")
    print()
    
    actual_files = list_files_in_prefix(s3, prefix)
    print(f"📁 Found {len(actual_files)} files:")
    for f in actual_files[:10]:  # Show first 10
        print(f"   {f}")
    if len(actual_files) > 10:
        print(f"   ... and {len(actual_files) - 10} more")
    print()
    
    # Check if our built key matches any actual file
    if s3_key in actual_files:
        print(f"✅ MATCH! Our built key exists in R2!")
    else:
        print(f"❌ NO MATCH! Our built key doesn't exist in R2")
        print()
        print(f"🔍 Looking for similar files...")
        # Try to find files that are close
        for actual_file in actual_files:
            if filename.split('_')[:4] == actual_file.split('/')[-1].split('_')[:4]:
                print(f"   Similar: {actual_file}")
                print(f"   Expected: {s3_key}")
                print()
                # Show the difference
                expected_parts = s3_key.split('/')
                actual_parts = actual_file.split('/')
                print(f"   Expected parts: {len(expected_parts)}")
                print(f"   Actual parts: {len(actual_parts)}")
                for i, (exp, act) in enumerate(zip(expected_parts, actual_parts)):
                    if exp != act:
                        print(f"      [{i}] DIFF: '{exp}' vs '{act}'")
    
    print()
    print("=" * 80)
    print("🧪 Testing actual deletion...")
    print("=" * 80)
    print()
    
    # Try to check if file exists
    try:
        print(f"🔍 Checking if file exists...")
        s3.head_object(Bucket=R2_BUCKET_NAME, Key=s3_key)
        print(f"✅ File exists! Attempting deletion...")
        
        s3.delete_object(Bucket=R2_BUCKET_NAME, Key=s3_key)
        print(f"✅ Successfully deleted!")
        
    except s3.exceptions.NoSuchKey:
        print(f"❌ File not found (NoSuchKey)")
    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()
        
except Exception as e:
    print(f"❌ Error parsing chunk: {e}")
    import traceback
    traceback.print_exc()

