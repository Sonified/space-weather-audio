#!/usr/bin/env python3
"""
List all files in the Spurr SPCP directory to see what's actually there.
"""
import boto3
import os
from pathlib import Path

# R2 Configuration
R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID', '66f906f29f28b08ae9c80d4f36e25c7a')
R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '9e1cf6c395172f108c2150c52878859f')
R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec')
R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')

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

