#!/usr/bin/env python3
"""
Test min/max calculation exactly as the browser does.
Emulates the browser's progressive streaming workflow:
1. Fetch metadata
2. Get min/max from metadata (Math.min/max of chunk mins/maxs)
3. Download actual chunks
4. Calculate actual min/max from stitched data
5. Compare metadata range vs actual range
"""

import os
import sys
import json
import boto3
import numpy as np
import zstandard as zstd
from datetime import datetime, timezone

# Load environment variables from .env file
from dotenv import load_dotenv
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

s3 = boto3.client(
    's3',
    endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    region_name='auto'
)

def test_browser_workflow():
    """
    Emulate browser workflow for progressive streaming.
    Tests a few different metadata files.
    """
    
    print(f"[{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}] 🧪 Testing browser min/max workflow")
    print()
    
    # List some metadata files
    paginator = s3.get_paginator('list_objects_v2')
    pages = paginator.paginate(Bucket=R2_BUCKET_NAME, Prefix='data/')
    
    metadata_files = []
    for page in pages:
        if 'Contents' not in page:
            continue
        for obj in page['Contents']:
            key = obj['Key']
            if key.endswith('.json'):
                metadata_files.append(key)
    
    # Filter for Nov 6 files (which should have multiple chunks)
    nov6_files = [f for f in metadata_files if '/2025/11/06/' in f]
    print(f"Found {len(nov6_files)} files from Nov 6")
    print()
    
    # Test first 5 Nov 6 metadata files
    for i, metadata_key in enumerate(nov6_files[:5]):
        print("=" * 80)
        print(f"Test {i+1}: {metadata_key}")
        print("=" * 80)
        
        try:
            # STEP 1: Fetch metadata (like browser does)
            response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
            metadata = json.loads(response['Body'].read().decode('utf-8'))
            
            # STEP 2: Calculate normalization range from metadata (EXACTLY like browser)
            # Browser code: const normMin = Math.min(...chunks.map(c => c.min));
            chunks = metadata.get('chunks', {}).get('10m', [])
            
            if not chunks:
                print("  ⏭️  No 10m chunks, skipping")
                print()
                continue
            
            # Take first 3 chunks (like browser does for 30 minutes)
            chunks_to_use = chunks[:3]
            
            if len(chunks_to_use) < 3:
                print(f"  ⏭️  Only {len(chunks_to_use)} chunks available, skipping")
                print()
                continue
            
            # Calculate metadata min/max (EXACTLY like browser)
            normMin = min(c['min'] for c in chunks_to_use)
            normMax = max(c['max'] for c in chunks_to_use)
            
            print(f"  📋 Metadata (from {len(chunks_to_use)} chunks):")
            print(f"     Min: {normMin}")
            print(f"     Max: {normMax}")
            print(f"     Range: {normMax - normMin}")
            print()
            
            # STEP 3: Download actual binary chunks
            # Extract path info from metadata key
            parts = metadata_key.split('/')
            year = parts[1]
            month = parts[2]
            day = parts[3]
            network = parts[4]
            volcano = parts[5]
            station = parts[6]
            location = parts[7]
            channel = parts[8]
            date_str = metadata['date']
            sample_rate = metadata['sample_rate']
            rate_str = f"{sample_rate:.2f}".rstrip('0').rstrip('.') if '.' in str(sample_rate) else str(int(sample_rate))
            
            all_samples = []
            
            for j, chunk_meta in enumerate(chunks_to_use):
                start_time = chunk_meta['start'].replace(':', '-')
                end_time = chunk_meta['end'].replace(':', '-')
                
                filename = f"{network}_{station}_{location}_{channel}_{rate_str}Hz_10m_{date_str}-{start_time}_to_{date_str}-{end_time}.bin.zst"
                binary_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location}/{channel}/10m/{filename}"
                
                try:
                    response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=binary_key)
                    compressed = response['Body'].read()
                    
                    decompressor = zstd.ZstdDecompressor()
                    decompressed = decompressor.decompress(compressed)
                    samples = np.frombuffer(decompressed, dtype=np.int32)
                    
                    all_samples.append(samples)
                    
                    # Also check individual chunk min/max
                    chunk_min = int(np.min(samples))
                    chunk_max = int(np.max(samples))
                    
                    print(f"  📦 Chunk {j+1} ({chunk_meta['start']}-{chunk_meta['end']}):")
                    print(f"     Metadata: min={chunk_meta['min']}, max={chunk_meta['max']}")
                    print(f"     Actual:   min={chunk_min}, max={chunk_max}")
                    
                    if chunk_min != chunk_meta['min'] or chunk_max != chunk_meta['max']:
                        print(f"     ❌ MISMATCH in individual chunk!")
                        print(f"        Min diff: {chunk_min - chunk_meta['min']}")
                        print(f"        Max diff: {chunk_max - chunk_meta['max']}")
                    else:
                        print(f"     ✅ Individual chunk matches")
                    print()
                
                except Exception as e:
                    print(f"  ❌ Error loading chunk {j+1}: {e}")
                    continue
            
            if not all_samples:
                print("  ⚠️  No chunks loaded, skipping")
                print()
                continue
            
            # STEP 4: Stitch chunks and calculate actual min/max (EXACTLY like browser)
            stitched = np.concatenate(all_samples)
            actualMin = int(np.min(stitched))
            actualMax = int(np.max(stitched))
            
            print(f"  🔬 STITCHED DATA (all {len(chunks_to_use)} chunks combined):")
            print(f"     Actual min: {actualMin}")
            print(f"     Actual max: {actualMax}")
            print(f"     Actual range: {actualMax - actualMin}")
            print()
            
            # STEP 5: Compare
            print(f"  📊 COMPARISON:")
            print(f"     Metadata range: [{normMin}, {normMax}]")
            print(f"     Actual range:   [{actualMin}, {actualMax}]")
            
            if actualMin == normMin and actualMax == normMax:
                print(f"     ✅ PERFECT MATCH")
            else:
                print(f"     ❌ MISMATCH DETECTED")
                print(f"        Min diff: {actualMin - normMin} (actual - metadata)")
                print(f"        Max diff: {actualMax - normMax} (actual - metadata)")
                
                # Additional analysis
                if actualMin >= normMin and actualMax <= normMax:
                    print(f"     ℹ️  Actual range is NARROWER than metadata range")
                    print(f"        This happens when metadata has min/max from ALL chunks")
                    print(f"        but browser only fetches FIRST 3 chunks")
                elif actualMin < normMin or actualMax > normMax:
                    print(f"     ⚠️  Actual range is WIDER than metadata range")
                    print(f"        This should NOT happen! Metadata is incorrect!")
            
            print()
        
        except Exception as e:
            print(f"  ❌ Error: {e}")
            import traceback
            traceback.print_exc()
            print()
            continue

if __name__ == "__main__":
    test_browser_workflow()

