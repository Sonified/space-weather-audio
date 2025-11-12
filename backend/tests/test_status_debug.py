#!/usr/bin/env python3
"""
Debug script to test each component of the /status endpoint
"""
import os
import sys

print("=" * 60)
print("STATUS ENDPOINT DEBUG TEST")
print("=" * 60)

# Test 1: Import boto3
print("\n[1/6] Testing boto3 import...")
try:
    import boto3
    print("✅ boto3 imported successfully")
except Exception as e:
    print(f"❌ boto3 import failed: {e}")
    sys.exit(1)

# Test 2: Create S3 client
print("\n[2/6] Testing S3 client creation...")
try:
    R2_ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID', '66f906f29f28b08ae9c80d4f36e25c7a')
    R2_ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID', '9e1cf6c395172f108c2150c52878859f')
    R2_SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY', '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec')
    R2_BUCKET_NAME = os.getenv('R2_BUCKET_NAME', 'hearts-data-cache')
    
    s3 = boto3.client(
        's3',
        endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name='auto'
    )
    print("✅ S3 client created successfully")
except Exception as e:
    print(f"❌ S3 client creation failed: {e}")
    sys.exit(1)

# Test 3: List objects (simple)
print("\n[3/6] Testing simple list_objects_v2...")
try:
    response = s3.list_objects_v2(Bucket=R2_BUCKET_NAME, Prefix='data/', MaxKeys=5)
    count = len(response.get('Contents', []))
    print(f"✅ list_objects_v2 works - found {count} objects (limited to 5)")
except Exception as e:
    print(f"❌ list_objects_v2 failed: {e}")
    sys.exit(1)

# Test 4: Paginator
print("\n[4/6] Testing paginator...")
try:
    paginator = s3.get_paginator('list_objects_v2')
    print("✅ Paginator created successfully")
except Exception as e:
    print(f"❌ Paginator creation failed: {e}")
    sys.exit(1)

# Test 5: Paginate through first page
print("\n[5/6] Testing paginator iteration (first page only)...")
try:
    pages = paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix='data/', PaginationConfig={'MaxItems': 10})
    page_count = 0
    total_items = 0
    for page in pages:
        page_count += 1
        total_items += len(page.get('Contents', []))
        if page_count >= 1:  # Only test first page
            break
    print(f"✅ Paginator works - processed {page_count} page(s), {total_items} items")
except Exception as e:
    print(f"❌ Paginator iteration failed: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

# Test 6: Load stations_config.json
print("\n[6/6] Testing stations_config.json loading...")
try:
    import json
    from pathlib import Path
    config_path = Path(__file__).parent / 'stations_config.json'
    with open(config_path) as f:
        config = json.load(f)
    station_count = sum(len(stations) for network in config['networks'].values() for stations in network.values())
    print(f"✅ stations_config.json loaded - {station_count} stations configured")
except Exception as e:
    print(f"❌ stations_config.json loading failed: {e}")
    sys.exit(1)

print("\n" + "=" * 60)
print("✅ ALL TESTS PASSED!")
print("=" * 60)
print("\nThe /status endpoint components are working.")
print("The 500 error must be from something else in the endpoint logic.")

