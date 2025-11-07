#!/usr/bin/env python3
"""
Detailed min/max audit - checks if 1h and 6h chunks have correct min/max
that match the FULL range of their data (not just inherited from one 10m chunk)
"""

import os
import json
import boto3
import numpy as np
import zstandard as zstd
from datetime import datetime, timezone

# R2 Configuration
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

def audit_chunk_type(metadata_key, chunk_type='6h'):
    """Audit all chunks of a specific type from a metadata file"""
    print(f"\n{'='*80}")
    print(f"Auditing {chunk_type} chunks in: {metadata_key}")
    print(f"{'='*80}")
    
    # Load metadata
    response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
    metadata = json.loads(response['Body'].read().decode('utf-8'))
    
    # Extract path info
    parts = metadata_key.split('/')
    year = parts[1]
    month = parts[2]
    day = parts[3]
    network = parts[4]
    volcano = parts[5]
    station = parts[6]
    location = parts[7]
    channel = parts[8]
    
    chunks = metadata['chunks'].get(chunk_type, [])
    print(f"Found {len(chunks)} {chunk_type} chunks")
    
    sample_rate = metadata['sample_rate']
    rate_str = f"{sample_rate:.2f}".rstrip('0').rstrip('.') if '.' in str(sample_rate) else str(int(sample_rate))
    
    for i, chunk in enumerate(chunks):
        print(f"\nChunk {i+1}/{len(chunks)}: {chunk['start']}-{chunk['end']}")
        
        # Build binary file key
        start_time = chunk['start'].replace(':', '-')
        end_time = chunk['end'].replace(':', '-')
        date_str = metadata['date']
        
        filename = f"{network}_{station}_{location}_{channel}_{rate_str}Hz_{chunk_type}_{date_str}-{start_time}_to_{date_str}-{end_time}.bin.zst"
        binary_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location}/{channel}/{chunk_type}/{filename}"
        
        try:
            # Download and decompress
            response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=binary_key)
            compressed = response['Body'].read()
            
            decompressor = zstd.ZstdDecompressor()
            decompressed = decompressor.decompress(compressed)
            data = np.frombuffer(decompressed, dtype=np.int32)
            
            # Calculate actual min/max
            actual_min = int(np.min(data))
            actual_max = int(np.max(data))
            
            # Get metadata min/max
            metadata_min = chunk.get('min', 0)
            metadata_max = chunk.get('max', 0)
            
            # Compare
            min_match = (actual_min == metadata_min)
            max_match = (actual_max == metadata_max)
            
            status = '✅ PASS' if (min_match and max_match) else '❌ FAIL'
            
            print(f"  Samples: {len(data):,} (metadata says: {chunk.get('samples', 0):,})")
            print(f"  Metadata min/max: [{metadata_min}, {metadata_max}]")
            print(f"  Actual min/max:   [{actual_min}, {actual_max}]")
            print(f"  Min matches: {min_match}")
            print(f"  Max matches: {max_match}")
            print(f"  {status}")
            
            if not min_match or not max_match:
                print(f"  ⚠️  MISMATCH DETECTED!")
                print(f"      Min diff: {actual_min - metadata_min}")
                print(f"      Max diff: {actual_max - metadata_max}")
        
        except Exception as e:
            print(f"  ❌ ERROR: {e}")
            continue

def main():
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 🔍 Detailed min/max audit (1h and 6h chunks)")
    
    # Find a metadata file with 6h chunks
    print("\nSearching for metadata files with 6h chunks...")
    
    paginator = s3.get_paginator('list_objects_v2')
    pages = paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix='data/')
    
    files_with_6h = []
    files_with_1h = []
    
    for page in pages:
        if 'Contents' not in page:
            continue
        
        for obj in page['Contents']:
            key = obj['Key']
            if not key.endswith('.json'):
                continue
            
            # Check if it has 6h or 1h chunks
            try:
                response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=key)
                metadata = json.loads(response['Body'].read().decode('utf-8'))
                
                if metadata.get('chunks', {}).get('6h'):
                    files_with_6h.append(key)
                if metadata.get('chunks', {}).get('1h'):
                    files_with_1h.append(key)
            except:
                continue
    
    print(f"Found {len(files_with_6h)} files with 6h chunks")
    print(f"Found {len(files_with_1h)} files with 1h chunks")
    
    # Audit 6h chunks
    if files_with_6h:
        print("\n" + "="*80)
        print("AUDITING 6-HOUR CHUNKS")
        print("="*80)
        for metadata_key in files_with_6h[:3]:  # Check first 3 files
            audit_chunk_type(metadata_key, '6h')
    
    # Audit 1h chunks
    if files_with_1h:
        print("\n" + "="*80)
        print("AUDITING 1-HOUR CHUNKS")
        print("="*80)
        for metadata_key in files_with_1h[:3]:  # Check first 3 files
            audit_chunk_type(metadata_key, '1h')

if __name__ == "__main__":
    main()

