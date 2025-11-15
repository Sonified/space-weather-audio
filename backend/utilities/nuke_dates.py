#!/usr/bin/env python3
"""
Nuclear option: Delete ALL files and metadata for specific dates.
Use this when metadata is corrupted and we need a clean slate.
"""

import os
import boto3
from datetime import datetime, timezone
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

def list_all_files_in_prefix(s3, prefix):
    """List ALL files with a given prefix (handles pagination)"""
    all_files = []
    continuation_token = None
    
    while True:
        try:
            if continuation_token:
                response = s3.list_objects_v2(
                    Bucket=R2_BUCKET_NAME,
                    Prefix=prefix,
                    ContinuationToken=continuation_token,
                    MaxKeys=1000
                )
            else:
                response = s3.list_objects_v2(
                    Bucket=R2_BUCKET_NAME,
                    Prefix=prefix,
                    MaxKeys=1000
                )
            
            if 'Contents' in response:
                all_files.extend([obj['Key'] for obj in response['Contents']])
            
            if not response.get('IsTruncated', False):
                break
            
            continuation_token = response.get('NextContinuationToken')
        except Exception as e:
            print(f"Error listing files: {e}")
            break
    
    return all_files

def nuke_date(network, station, location, channel, volcano, date_str):
    """Delete ALL files and metadata for a specific date"""
    location_str = location if location and location != '--' else '--'
    year, month, day = date_str.split('-')
    
    print(f"💣 NUKING {date_str}...")
    print(f"   Network: {network}.{station}.{location}.{channel}")
    print(f"   Volcano: {volcano}")
    print()
    
    s3 = get_s3_client()
    
    # Base prefix for this date
    base_prefix = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/"
    
    # List ALL files under this prefix
    print(f"🔍 Listing all files under: {base_prefix}")
    all_files = list_all_files_in_prefix(s3, base_prefix)
    
    print(f"📁 Found {len(all_files)} files")
    print()
    
    if len(all_files) == 0:
        print("✅ No files found, nothing to delete")
        return
    
    # Delete all files
    deleted_count = 0
    failed_count = 0
    
    print("🗑️  Deleting files...")
    for file_key in all_files:
        try:
            # Verify file exists first
            try:
                s3.head_object(Bucket=R2_BUCKET_NAME, Key=file_key)
            except s3.exceptions.NoSuchKey:
                print(f"   ⚠️  File already gone: {file_key.split('/')[-1]}")
                continue
            
            # Delete it
            s3.delete_object(Bucket=R2_BUCKET_NAME, Key=file_key)
            
            # Verify deletion
            try:
                s3.head_object(Bucket=R2_BUCKET_NAME, Key=file_key)
                failed_count += 1
                print(f"   ❌ File still exists after deletion: {file_key.split('/')[-1]}")
            except s3.exceptions.NoSuchKey:
                deleted_count += 1
                if deleted_count % 10 == 0:
                    print(f"   ✓ Deleted {deleted_count}/{len(all_files)}...")
        except Exception as e:
            failed_count += 1
            print(f"   ❌ Failed to delete {file_key.split('/')[-1]}: {e}")
    
    print()
    print(f"✅ Deleted {deleted_count} files")
    if failed_count > 0:
        print(f"❌ Failed to delete {failed_count} files")
    print()

if __name__ == '__main__':
    # Nuke November 12th and 13th, 2025
    dates_to_nuke = ['2025-11-12', '2025-11-13']
    
    network = 'HV'
    station = 'MOKD'
    location = '--'
    channel = 'HHZ'
    volcano = 'maunaloa'
    
    print("=" * 80)
    print("💣 NUCLEAR OPTION: Deleting ALL files and metadata")
    print("=" * 80)
    print()
    print(f"Target: {network}.{station}.{location}.{channel} ({volcano})")
    print(f"Dates: {', '.join(dates_to_nuke)}")
    print()
    
    response = input("⚠️  Are you SURE you want to delete everything? Type 'YES' to confirm: ")
    if response != 'YES':
        print("❌ Cancelled")
        exit(0)
    
    print()
    
    for date_str in dates_to_nuke:
        nuke_date(network, station, location, channel, volcano, date_str)
    
    print("=" * 80)
    print("🎉 NUKING COMPLETE!")
    print("=" * 80)

