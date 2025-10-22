#!/usr/bin/env python3
"""
Upload zarr files to R2 storage
"""
import boto3
import os
import sys
from pathlib import Path

# R2 Configuration
ACCOUNT_ID = '66f906f29f28b08ae9c80d4f36e25c7a'
ACCESS_KEY_ID = '9e1cf6c395172f108c2150c52878859f'
SECRET_ACCESS_KEY = '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec'
BUCKET_NAME = 'hearts-data-cache'

def upload_zarr_to_r2(local_zarr_path, r2_key_prefix):
    """
    Upload a zarr directory to R2
    
    Args:
        local_zarr_path: Path to local .zarr directory
        r2_key_prefix: Prefix for keys in R2 (e.g., 'kilauea/2025-10-22/')
    """
    endpoint_url = f'https://{ACCOUNT_ID}.r2.cloudflarestorage.com'
    
    # Create S3 client
    s3_client = boto3.client(
        's3',
        endpoint_url=endpoint_url,
        aws_access_key_id=ACCESS_KEY_ID,
        aws_secret_access_key=SECRET_ACCESS_KEY,
        region_name='auto'
    )
    
    zarr_path = Path(local_zarr_path)
    if not zarr_path.exists():
        print(f"❌ Error: {local_zarr_path} does not exist")
        return False
    
    print(f"📤 Uploading {zarr_path.name} to R2...")
    print(f"   Local: {zarr_path}")
    print(f"   R2 Prefix: {r2_key_prefix}")
    print()
    
    # Walk through all files in the zarr directory
    uploaded_files = 0
    total_bytes = 0
    
    for file_path in zarr_path.rglob('*'):
        if file_path.is_file():
            # Calculate relative path within zarr
            relative_path = file_path.relative_to(zarr_path.parent)
            r2_key = f"{r2_key_prefix}{relative_path}".replace('\\', '/')
            
            # Upload file
            try:
                file_size = file_path.stat().st_size
                s3_client.upload_file(str(file_path), BUCKET_NAME, r2_key)
                uploaded_files += 1
                total_bytes += file_size
                print(f"   ✓ {r2_key} ({file_size:,} bytes)")
            except Exception as e:
                print(f"   ❌ Failed to upload {r2_key}: {e}")
                return False
    
    print()
    print(f"✅ Upload complete!")
    print(f"   Files: {uploaded_files}")
    print(f"   Total size: {total_bytes / (1024*1024):.2f} MB")
    return True


def list_r2_contents(prefix=''):
    """List contents of R2 bucket"""
    endpoint_url = f'https://{ACCOUNT_ID}.r2.cloudflarestorage.com'
    
    s3_client = boto3.client(
        's3',
        endpoint_url=endpoint_url,
        aws_access_key_id=ACCESS_KEY_ID,
        aws_secret_access_key=SECRET_ACCESS_KEY,
        region_name='auto'
    )
    
    print(f"📋 Listing R2 contents (prefix='{prefix}')...")
    print()
    
    response = s3_client.list_objects_v2(Bucket=BUCKET_NAME, Prefix=prefix)
    
    if 'Contents' in response:
        print(f"Found {response['KeyCount']} object(s):")
        for obj in response.get('Contents', []):
            size_mb = obj['Size'] / (1024 * 1024)
            print(f"  - {obj['Key']} ({size_mb:.2f} MB)")
    else:
        print("Bucket is empty")


if __name__ == '__main__':
    print()
    print("=" * 60)
    print("UPLOAD ZARR TO R2")
    print("=" * 60)
    print()
    
    # Example: Upload the test zarr file
    test_zarr = Path(__file__).parent.parent / 'tests' / 'cache_user_latency' / 'zarr' / 'data.zarr'
    
    if test_zarr.exists():
        print(f"Found test zarr: {test_zarr}")
        print()
        
        # Upload with a test prefix
        success = upload_zarr_to_r2(
            local_zarr_path=test_zarr,
            r2_key_prefix='test/'
        )
        
        if success:
            print()
            print("=" * 60)
            print()
            list_r2_contents(prefix='test/')
    else:
        print(f"❌ Test zarr not found at: {test_zarr}")
        print()
        print("Usage:")
        print("  python upload_to_r2.py")
        print()
        print("Or import and use:")
        print("  from upload_to_r2 import upload_zarr_to_r2")
        print("  upload_zarr_to_r2('/path/to/data.zarr', 'volcano/date/')")

