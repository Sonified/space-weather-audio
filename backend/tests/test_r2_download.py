#!/usr/bin/env python3
"""
Test downloading and reading zarr data from R2
"""
import os
import boto3
import s3fs
import xarray as xr
import zarr
import numpy as np
from io import BytesIO
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# R2 Configuration - loaded from .env file (local) or Railway dashboard (production)
ACCOUNT_ID = os.getenv('R2_ACCOUNT_ID')
ACCESS_KEY_ID = os.getenv('R2_ACCESS_KEY_ID')
SECRET_ACCESS_KEY = os.getenv('R2_SECRET_ACCESS_KEY')
BUCKET_NAME = os.getenv('R2_BUCKET_NAME')

# Validate that all R2 credentials are present
if not all([ACCOUNT_ID, ACCESS_KEY_ID, SECRET_ACCESS_KEY, BUCKET_NAME]):
    missing = []
    if not ACCOUNT_ID: missing.append('R2_ACCOUNT_ID')
    if not ACCESS_KEY_ID: missing.append('R2_ACCESS_KEY_ID')
    if not SECRET_ACCESS_KEY: missing.append('R2_SECRET_ACCESS_KEY')
    if not BUCKET_NAME: missing.append('R2_BUCKET_NAME')
    raise ValueError(f"Missing required R2 environment variables: {', '.join(missing)}")

def test_direct_file_download():
    """Test 1: Download individual zarr files directly"""
    print("=" * 60)
    print("TEST 1: Direct File Download")
    print("=" * 60)
    print()
    
    endpoint_url = f'https://{ACCOUNT_ID}.r2.cloudflarestorage.com'
    
    s3_client = boto3.client(
        's3',
        endpoint_url=endpoint_url,
        aws_access_key_id=ACCESS_KEY_ID,
        aws_secret_access_key=SECRET_ACCESS_KEY,
        region_name='auto'
    )
    
    # Download a metadata file
    try:
        print("📥 Downloading test/data.zarr/zarr.json...")
        response = s3_client.get_object(Bucket=BUCKET_NAME, Key='test/data.zarr/zarr.json')
        content = response['Body'].read()
        print(f"   ✓ Downloaded {len(content)} bytes")
        print(f"   Content preview: {content[:200].decode('utf-8')}")
        print()
        return True
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return False


def test_s3fs_zarr_read():
    """Test 2: Read zarr using s3fs"""
    print("=" * 60)
    print("TEST 2: Read Zarr using s3fs")
    print("=" * 60)
    print()
    
    endpoint_url = f'https://{ACCOUNT_ID}.r2.cloudflarestorage.com'
    
    try:
        # Create s3fs filesystem
        print("🔗 Creating s3fs filesystem...")
        fs = s3fs.S3FileSystem(
            key=ACCESS_KEY_ID,
            secret=SECRET_ACCESS_KEY,
            endpoint_url=endpoint_url,
            client_kwargs={'region_name': 'auto'}
        )
        print("   ✓ Filesystem created")
        print()
        
        # Open zarr store
        zarr_path = f'{BUCKET_NAME}/test/data.zarr'
        print(f"📂 Opening zarr store: {zarr_path}...")
        store = s3fs.S3Map(root=zarr_path, s3=fs)
        root = zarr.open_group(store=store, mode='r')
        print("   ✓ Zarr store opened")
        print()
        
        # List arrays
        print("📊 Zarr contents:")
        for key in root.array_keys():
            array = root[key]
            print(f"   - {key}: shape={array.shape}, dtype={array.dtype}, chunks={array.chunks}")
        print()
        
        # Read amplitude data
        print("📖 Reading amplitude array...")
        amplitude = root['amplitude']
        print(f"   Shape: {amplitude.shape}")
        print(f"   Dtype: {amplitude.dtype}")
        print(f"   Size: {amplitude.nbytes / (1024*1024):.2f} MB")
        
        # Read a chunk
        print()
        print("📖 Reading first 1000 samples...")
        data_chunk = amplitude[:1000]
        print(f"   Min: {data_chunk.min()}")
        print(f"   Max: {data_chunk.max()}")
        print(f"   Mean: {data_chunk.mean():.2f}")
        print(f"   First 10 values: {data_chunk[:10]}")
        print()
        
        return True
        
    except Exception as e:
        print(f"   ❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_xarray_read():
    """Test 3: Read zarr using xarray"""
    print("=" * 60)
    print("TEST 3: Read Zarr using xarray")
    print("=" * 60)
    print()
    
    endpoint_url = f'https://{ACCOUNT_ID}.r2.cloudflarestorage.com'
    
    try:
        # Create s3fs filesystem
        print("🔗 Creating s3fs filesystem...")
        fs = s3fs.S3FileSystem(
            key=ACCESS_KEY_ID,
            secret=SECRET_ACCESS_KEY,
            endpoint_url=endpoint_url,
            client_kwargs={'region_name': 'auto'}
        )
        print("   ✓ Filesystem created")
        print()
        
        # Open with xarray
        zarr_path = f'{BUCKET_NAME}/test/data.zarr'
        print(f"📂 Opening with xarray: {zarr_path}...")
        store = s3fs.S3Map(root=zarr_path, s3=fs)
        ds = xr.open_zarr(store=store)
        print("   ✓ Dataset opened")
        print()
        
        # Show dataset info
        print("📊 Dataset info:")
        print(ds)
        print()
        
        # Read amplitude variable
        print("📖 Reading amplitude data...")
        amplitude = ds['amplitude'].values
        print(f"   Shape: {amplitude.shape}")
        print(f"   Min: {amplitude.min()}")
        print(f"   Max: {amplitude.max()}")
        print(f"   Mean: {amplitude.mean():.2f}")
        print()
        
        # Check attributes
        if hasattr(ds, 'attrs') and ds.attrs:
            print("📋 Dataset attributes:")
            for key, value in ds.attrs.items():
                print(f"   - {key}: {value}")
            print()
        
        return True
        
    except Exception as e:
        print(f"   ❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return False


def test_download_speed():
    """Test 4: Measure download speed for a chunk"""
    print("=" * 60)
    print("TEST 4: Download Speed Test")
    print("=" * 60)
    print()
    
    endpoint_url = f'https://{ACCOUNT_ID}.r2.cloudflarestorage.com'
    
    s3_client = boto3.client(
        's3',
        endpoint_url=endpoint_url,
        aws_access_key_id=ACCESS_KEY_ID,
        aws_secret_access_key=SECRET_ACCESS_KEY,
        region_name='auto'
    )
    
    try:
        import time
        
        # Download an amplitude chunk (should be ~1.4 MB)
        key = 'test/data.zarr/amplitude/c/0'
        print(f"⏱️  Downloading {key}...")
        
        start_time = time.time()
        response = s3_client.get_object(Bucket=BUCKET_NAME, Key=key)
        content = response['Body'].read()
        end_time = time.time()
        
        elapsed = end_time - start_time
        size_mb = len(content) / (1024 * 1024)
        speed_mbps = size_mb / elapsed
        
        print(f"   ✓ Downloaded {size_mb:.2f} MB in {elapsed:.2f}s")
        print(f"   Speed: {speed_mbps:.2f} MB/s")
        print()
        
        return True
        
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return False


if __name__ == '__main__':
    print()
    print("=" * 60)
    print("R2 DOWNLOAD TEST SUITE")
    print("=" * 60)
    print()
    
    results = []
    
    # Run all tests
    results.append(("Direct File Download", test_direct_file_download()))
    print()
    
    results.append(("s3fs Zarr Read", test_s3fs_zarr_read()))
    print()
    
    results.append(("xarray Read", test_xarray_read()))
    print()
    
    results.append(("Download Speed", test_download_speed()))
    print()
    
    # Summary
    print("=" * 60)
    print("TEST SUMMARY")
    print("=" * 60)
    for name, passed in results:
        status = "✅ PASS" if passed else "❌ FAIL"
        print(f"{status} - {name}")
    print()
    
    all_passed = all(result[1] for result in results)
    if all_passed:
        print("🎉 All tests passed! R2 integration is working!")
    else:
        print("⚠️  Some tests failed. Check errors above.")

