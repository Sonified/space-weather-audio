#!/usr/bin/env python3
"""
List all files in the Spurr SPCP directory to see what's actually there.
"""
import boto3
import os
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
    return boto3.client(
        's3',
        endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name='auto'
    )

def list_directory(s3_client, prefix):
    """List all files in a directory"""
    print(f"\n📁 Files in: {prefix}")
    print("=" * 70)
    
    try:
        response = s3_client.list_objects_v2(Bucket=R2_BUCKET_NAME, Prefix=prefix)
        if 'Contents' not in response:
            print("   ❌ No files found")
            return []
        
        files = []
        for obj in response['Contents']:
            key = obj['Key']
            filename = key.split('/')[-1]
            files.append({
                'key': key,
                'filename': filename,
                'size': obj['Size']
            })
            print(f"   ✅ {filename} ({obj['Size']:,} bytes)")
        
        print(f"\n   Total: {len(files)} files")
        return files
        
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return []

def main():
    print("=" * 70)
    print("🔍 Listing Spurr SPCP Files")
    print("=" * 70)
    
    s3_client = get_s3_client()
    
    # Check the directory that's failing
    prefix = "data/2025/11/11/AV/spurr/SPCP/--/BHZ/10m/"
    files = list_directory(s3_client, prefix)
    
    # Also check if there's a different location format
    print("\n" + "=" * 70)
    print("🔍 Checking alternative paths...")
    print("=" * 70)
    
    # Check without the double dash
    prefix2 = "data/2025/11/11/AV/spurr/SPCP/BHZ/10m/"
    list_directory(s3_client, prefix2)
    
    # Check with empty location
    prefix3 = "data/2025/11/11/AV/spurr/SPCP//BHZ/10m/"
    list_directory(s3_client, prefix3)
    
    # Check metadata
    print("\n" + "=" * 70)
    print("🔍 Checking metadata file...")
    print("=" * 70)
    metadata_prefix = "data/2025/11/11/AV/spurr/SPCP/--/BHZ/"
    list_directory(s3_client, metadata_prefix)

if __name__ == '__main__':
    main()

