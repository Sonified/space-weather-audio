#!/usr/bin/env python3
"""
Simple R2 download test - directly fetch and decompress chunks
(This is what we'll actually use in the Flask backend)
"""
import boto3
import json
import numpy as np

# R2 Configuration
ACCOUNT_ID = '66f906f29f28b08ae9c80d4f36e25c7a'
ACCESS_KEY_ID = '9e1cf6c395172f108c2150c52878859f'
SECRET_ACCESS_KEY = '93b0ff009aeba441f8eab4f296243e8e8db4fa018ebb15d51ae1d4a4294789ec'
BUCKET_NAME = 'hearts-data-cache'

def get_r2_client():
    """Create R2 S3 client"""
    endpoint_url = f'https://{ACCOUNT_ID}.r2.cloudflarestorage.com'
    return boto3.client(
        's3',
        endpoint_url=endpoint_url,
        aws_access_key_id=ACCESS_KEY_ID,
        aws_secret_access_key=SECRET_ACCESS_KEY,
        region_name='auto'
    )

def test_fetch_and_decode_chunk():
    """Fetch a compressed chunk from R2 and decode it"""
    print("=" * 60)
    print("R2 SIMPLE CHUNK DOWNLOAD TEST")
    print("=" * 60)
    print()
    
    s3_client = get_r2_client()
    
    # Step 1: Download metadata
    print("📥 Step 1: Download metadata...")
    try:
        response = s3_client.get_object(Bucket=BUCKET_NAME, Key='test/data.zarr/zarr.json')
        metadata = json.loads(response['Body'].read())
        print(f"   ✓ Metadata:")
        print(f"     Station: {metadata['attributes']['station']}")
        print(f"     Network: {metadata['attributes']['network']}")
        print(f"     Channel: {metadata['attributes']['channel']}")
        print(f"     Sampling Rate: {metadata['attributes']['sampling_rate']} Hz")
        print()
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return False
    
    # Step 2: Download amplitude metadata
    print("📥 Step 2: Download amplitude array metadata...")
    try:
        response = s3_client.get_object(Bucket=BUCKET_NAME, Key='test/data.zarr/amplitude/zarr.json')
        amp_metadata = json.loads(response['Body'].read())
        print(f"   ✓ Array metadata:")
        print(f"     Data type: {amp_metadata['data_type']}")
        print(f"     Shape: {amp_metadata['shape']}")
        print(f"     Chunk shape: {amp_metadata['chunk_grid']['configuration']['chunk_shape']}")
        if 'compressor' in amp_metadata:
            print(f"     Compressor: {amp_metadata['compressor']}")
        print()
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return False
    
    # Step 3: Download a compressed chunk
    print("📥 Step 3: Download compressed chunk...")
    chunk_key = 'test/data.zarr/amplitude/c/0'
    try:
        import time
        start = time.time()
        response = s3_client.get_object(Bucket=BUCKET_NAME, Key=chunk_key)
        compressed_data = response['Body'].read()
        elapsed = time.time() - start
        
        print(f"   ✓ Downloaded chunk:")
        print(f"     Size: {len(compressed_data):,} bytes ({len(compressed_data)/(1024*1024):.2f} MB)")
        print(f"     Time: {elapsed:.3f}s")
        print(f"     Speed: {len(compressed_data)/(1024*1024)/elapsed:.2f} MB/s")
        print()
    except Exception as e:
        print(f"   ❌ Error: {e}")
        return False
    
    # Step 4: Decode the chunk
    print("📦 Step 4: Decode chunk data...")
    try:
        # For raw chunks (no compression), just convert to int16
        int16_data = np.frombuffer(compressed_data, dtype='<i2')  # little-endian int16
        
        print(f"   ✓ Decoded:")
        print(f"     Samples: {len(int16_data):,}")
        print(f"     Min: {int16_data.min()}")
        print(f"     Max: {int16_data.max()}")
        print(f"     Mean: {int16_data.mean():.2f}")
        print(f"     First 10 samples: {int16_data[:10]}")
        print()
        
        # Convert to float32 for audio
        float32_data = int16_data.astype(np.float32) / 32768.0
        print(f"   ✓ Converted to float32 audio:")
        print(f"     Min: {float32_data.min():.4f}")
        print(f"     Max: {float32_data.max():.4f}")
        print(f"     Mean: {float32_data.mean():.4f}")
        print()
        
        return True
        
    except Exception as e:
        print(f"   ❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return False


def list_all_chunks():
    """List all available chunks"""
    print("=" * 60)
    print("AVAILABLE CHUNKS IN R2")
    print("=" * 60)
    print()
    
    s3_client = get_r2_client()
    
    try:
        response = s3_client.list_objects_v2(
            Bucket=BUCKET_NAME, 
            Prefix='test/data.zarr/amplitude/c/'
        )
        
        if 'Contents' in response:
            print(f"Found {response['KeyCount']} amplitude chunks:")
            for obj in response.get('Contents', []):
                chunk_num = obj['Key'].split('/')[-1]
                size_mb = obj['Size'] / (1024 * 1024)
                print(f"  - Chunk {chunk_num}: {size_mb:.2f} MB")
        print()
        return True
    except Exception as e:
        print(f"❌ Error: {e}")
        return False


if __name__ == '__main__':
    print()
    
    # Test 1: Fetch and decode
    success1 = test_fetch_and_decode_chunk()
    
    # Test 2: List chunks
    success2 = list_all_chunks()
    
    print("=" * 60)
    if success1 and success2:
        print("🎉 SUCCESS! R2 chunk download works!")
        print()
        print("Next steps:")
        print("  1. ✅ Can download chunks from R2")
        print("  2. ✅ Can decode int16 data")
        print("  3. ✅ Can convert to float32 audio")
        print("  4. Ready to integrate into Flask backend!")
    else:
        print("⚠️  Some tests failed")
    print("=" * 60)

