#!/usr/bin/env python3
"""
Verify that the renamed file exists on R2 and check its exact location.
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

def check_file(s3_client, key):
    """Check if file exists and get its details"""
    try:
        response = s3_client.head_object(Bucket=R2_BUCKET_NAME, Key=key)
        print(f"✅ File exists: {key}")
        print(f"   Size: {response['ContentLength']:,} bytes")
        print(f"   Last Modified: {response['LastModified']}")
        return True
    except s3_client.exceptions.NoSuchKey:
        print(f"❌ File NOT found: {key}")
        return False
    except Exception as e:
        print(f"❌ Error checking {key}: {e}")
        return False

def list_files_in_directory(s3_client, prefix):
    """List all files in a directory"""
    print(f"\n📁 Listing files in: {prefix}")
    try:
        response = s3_client.list_objects_v2(Bucket=R2_BUCKET_NAME, Prefix=prefix)
        if 'Contents' not in response:
            print(f"   No files found")
            return []
        
        files = []
        for obj in response['Contents']:
            key = obj['Key']
            filename = key.split('/')[-1]
            files.append(key)
            print(f"   ✅ {filename} ({obj['Size']:,} bytes)")
        
        return files
    except Exception as e:
        print(f"❌ Error listing files: {e}")
        return []

def main():
    print("=" * 70)
    print("🔍 Verify Renamed File Exists")
    print("=" * 70)
    print()
    
    s3_client = get_s3_client()
    
    # Check the correct file (NEW format)
    correct_key_new = "data/2025/11/11/HV/kilauea/OBL/--/HHZ/1h/HV_OBL_--_HHZ_1h_2025-11-11-23-00-00_to_2025-11-12-00-00-00.bin.zst"
    print("1. Checking NEW format file (correct name):")
    exists_new = check_file(s3_client, correct_key_new)
    
    # Check if old file still exists (shouldn't)
    old_key = "data/2025/11/11/HV/kilauea/OBL/--/HHZ/1h/HV_OBL_--_HHZ_1h_2025-11-11-23-00-00_to_2025-11-11-23-59-59.bin.zst"
    print("\n2. Checking OLD format file (should be deleted):")
    exists_old = check_file(s3_client, old_key)
    
    # List all files in the directory
    prefix = "data/2025/11/11/HV/kilauea/OBL/--/HHZ/1h/"
    list_files_in_directory(s3_client, prefix)
    
    # Also check end date directory
    print("\n3. Checking end date directory:")
    prefix_end = "data/2025/11/12/HV/kilauea/OBL/--/HHZ/1h/"
    list_files_in_directory(s3_client, prefix_end)
    
    print("\n" + "=" * 70)
    if exists_new and not exists_old:
        print("✅ File correctly renamed!")
    elif exists_new and exists_old:
        print("⚠️  Both files exist (copy succeeded but delete failed?)")
    elif not exists_new:
        print("❌ Correct file not found!")
    print("=" * 70)

if __name__ == '__main__':
    main()

