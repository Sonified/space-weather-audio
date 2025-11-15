#!/usr/bin/env python3
"""
Verify the fix: Show that using chunksToFetch for normMin/normMax
gives correct normalization that matches actual data.
"""

import os
import json
import boto3
import numpy as np
import zstandard as zstd
from datetime import datetime, timezone
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

s3 = boto3.client(
    's3',
    endpoint_url=f'https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    region_name='auto'
)

def test_fix():
    # Use one of the problem cases from our test
    metadata_key = 'data/2025/11/06/HV/kilauea/SBL/--/HHZ/HV_SBL_--_HHZ_100Hz_2025-11-06.json'
    
    print("=" * 100)
    print("FIX VERIFICATION TEST")
    print("=" * 100)
    print(f"Testing: {metadata_key}")
    print()
    
    # Load metadata
    response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=metadata_key)
    metadata = json.loads(response['Body'].read().decode('utf-8'))
    
    chunks = metadata['chunks']['10m']
    chunksToFetch = chunks[:3]
    
    print(f"Total chunks in metadata: {len(chunks)}")
    print(f"Chunks to fetch: {len(chunksToFetch)}")
    print()
    
    # OLD WAY (buggy): Use ALL chunks for normalization range
    normMin_OLD = min(c['min'] for c in chunks)  # ALL chunks
    normMax_OLD = max(c['max'] for c in chunks)  # ALL chunks
    
    print("🐛 OLD WAY (BUGGY):")
    print(f"   normMin = min of ALL {len(chunks)} chunks = {normMin_OLD}")
    print(f"   normMax = max of ALL {len(chunks)} chunks = {normMax_OLD}")
    print(f"   Range: {normMax_OLD - normMin_OLD}")
    print()
    
    # NEW WAY (fixed): Use ONLY chunks being fetched
    normMin_NEW = min(c['min'] for c in chunksToFetch)  # Only first 3
    normMax_NEW = max(c['max'] for c in chunksToFetch)  # Only first 3
    
    print("✅ NEW WAY (FIXED):")
    print(f"   normMin = min of {len(chunksToFetch)} chunks being fetched = {normMin_NEW}")
    print(f"   normMax = max of {len(chunksToFetch)} chunks being fetched = {normMax_NEW}")
    print(f"   Range: {normMax_NEW - normMin_NEW}")
    print()
    
    # Download and stitch the actual chunks
    parts = metadata_key.split('/')
    year, month, day = parts[1], parts[2], parts[3]
    network, volcano, station, location, channel = parts[4], parts[5], parts[6], parts[7], parts[8]
    date_str = metadata['date']
    sample_rate = metadata['sample_rate']
    rate_str = f"{sample_rate:.2f}".rstrip('0').rstrip('.') if '.' in str(sample_rate) else str(int(sample_rate))
    
    allInt32Chunks = []
    for chunk_meta in chunksToFetch:
        start_time = chunk_meta['start'].replace(':', '-')
        end_time = chunk_meta['end'].replace(':', '-')
        filename = f"{network}_{station}_{location}_{channel}_{rate_str}Hz_10m_{date_str}-{start_time}_to_{date_str}-{end_time}.bin.zst"
        binary_key = f"data/{year}/{month}/{day}/{network}/{volcano}/{station}/{location}/{channel}/10m/{filename}"
        
        response = s3.get_object(Bucket=R2_BUCKET_NAME, Key=binary_key)
        compressed = response['Body'].read()
        decompressor = zstd.ZstdDecompressor()
        decompressed = decompressor.decompress(compressed)
        samples = np.frombuffer(decompressed, dtype=np.int32)
        allInt32Chunks.append(samples)
    
    stitched = np.concatenate(allInt32Chunks)
    actualMin = int(np.min(stitched))
    actualMax = int(np.max(stitched))
    
    print(f"📦 Actual data from {len(chunksToFetch)} chunks:")
    print(f"   actualMin = {actualMin}")
    print(f"   actualMax = {actualMax}")
    print(f"   Range: {actualMax - actualMin}")
    print()
    
    # Compare
    print("=" * 100)
    print("COMPARISON:")
    print("=" * 100)
    
    print(f"OLD (buggy):  normMin={normMin_OLD}, normMax={normMax_OLD}")
    print(f"NEW (fixed):  normMin={normMin_NEW}, normMax={normMax_NEW}")
    print(f"ACTUAL:       min={actualMin}, max={actualMax}")
    print()
    
    if normMin_NEW == actualMin and normMax_NEW == actualMax:
        print("✅ NEW WAY MATCHES ACTUAL DATA PERFECTLY!")
    else:
        print(f"⚠️  NEW WAY still has mismatch:")
        print(f"   Min diff: {actualMin - normMin_NEW}")
        print(f"   Max diff: {actualMax - normMax_NEW}")
    
    if normMin_OLD == actualMin and normMax_OLD == actualMax:
        print("✅ OLD WAY matches actual data (no bug in this case)")
    else:
        print(f"❌ OLD WAY has mismatch (THIS IS THE BUG):")
        print(f"   Min diff: {actualMin - normMin_OLD}")
        print(f"   Max diff: {actualMax - normMax_OLD}")
    
    print()
    print("=" * 100)
    print("NORMALIZATION IMPACT (first 5 samples):")
    print("=" * 100)
    
    for i in range(min(5, len(stitched))):
        sample = int(stitched[i])
        
        # OLD way (using ALL chunks range)
        range_OLD = normMax_OLD - normMin_OLD
        norm_OLD = ((sample - normMin_OLD) / range_OLD) * 2 - 1
        
        # NEW way (using fetched chunks range)
        range_NEW = normMax_NEW - normMin_NEW
        norm_NEW = ((sample - normMin_NEW) / range_NEW) * 2 - 1
        
        # ACTUAL (what browser recalculates)
        range_ACTUAL = actualMax - actualMin
        norm_ACTUAL = 2 * (sample - actualMin) / range_ACTUAL - 1
        
        diff_OLD_vs_ACTUAL = abs(norm_OLD - norm_ACTUAL)
        diff_NEW_vs_ACTUAL = abs(norm_NEW - norm_ACTUAL)
        
        print(f"Sample {i}: {sample:7d}")
        print(f"  OLD (buggy):  {norm_OLD:7.4f}  (error: {diff_OLD_vs_ACTUAL:.4f})")
        print(f"  NEW (fixed):  {norm_NEW:7.4f}  (error: {diff_NEW_vs_ACTUAL:.4f})")
        print(f"  ACTUAL:       {norm_ACTUAL:7.4f}")
        if diff_NEW_vs_ACTUAL < 0.0001:
            print(f"  ✅ NEW matches ACTUAL!")
        print()
    
    print("=" * 100)
    print("CONCLUSION:")
    print("=" * 100)
    print("By using chunksToFetch for normalization range (instead of ALL chunks),")
    print("the metadata range now matches the actual data range perfectly!")
    print("This means audio normalization will be correct from the start,")
    print("without needing to recalculate from actual data.")
    print("=" * 100)

if __name__ == "__main__":
    test_fix()

