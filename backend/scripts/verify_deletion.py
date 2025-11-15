#!/usr/bin/env python3
"""
Verify what files actually exist after deletion attempt.
"""

import os
import boto3
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
                all_files.extend([(obj['Key'], obj['Size'], obj['LastModified']) for obj in response['Contents']])
            
            if not response.get('IsTruncated', False):
                break
            
            continuation_token = response.get('NextContinuationToken')
        except Exception as e:
            print(f"Error listing files: {e}")
            break
    
    return all_files

# Check both dates
dates_to_check = ['2025-11-12', '2025-11-13']
network = 'HV'
station = 'MOKD'
location = '--'
channel = 'HHZ'
volcano = 'maunaloa'
location_str = location if location and location != '--' else '--'

s3 = get_s3_client()

for date_str in dates_to_check:
    year, month, day = date_str.split('-')
    base_prefix = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location_str}/{channel}/"
    
    print(f"\n{'='*80}")
    print(f"📁 Checking {date_str}")
    print(f"{'='*80}")
    
    all_files = list_all_files_in_prefix(s3, base_prefix)
    
    print(f"Found {len(all_files)} files")
    
    if len(all_files) > 0:
        print("\nFiles by type:")
        by_type = {}
        for key, size, modified in all_files:
            parts = key.split('/')
            if len(parts) >= 9:
                chunk_type = parts[8]  # Should be '10m', '1h', '6h', or metadata filename
                if chunk_type not in by_type:
                    by_type[chunk_type] = []
                by_type[chunk_type].append((key, size, modified))
        
        for chunk_type, files in sorted(by_type.items()):
            print(f"\n  {chunk_type}: {len(files)} files")
            for key, size, modified in files[:5]:  # Show first 5
                filename = key.split('/')[-1]
                print(f"    - {filename} ({size/1024:.1f} KB, {modified})")
            if len(files) > 5:
                print(f"    ... and {len(files) - 5} more")
    else:
        print("✅ No files found - deletion successful!")


